console.log("STEP 1 - Server file loaded");

import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import path from "path";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import mysql, { Pool } from "mysql2/promise";
import { createServer as createViteServer } from "vite";
import { initialPortfolioData } from "./src/initialData";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

let db: Pool;

// --- DATABASE INITIALIZATION ---
async function initDb() {
  try {
    db = mysql.createPool({
      host: process.env.MYSQLHOST,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      port: Number(process.env.MYSQLPORT),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 60000,
    });

    await db.query("SELECT 1");

    // Portfolio Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_key VARCHAR(50) UNIQUE DEFAULT 'primary',
        data JSON NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Messages & Transactions Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(100) PRIMARY KEY,
        senderName VARCHAR(255),
        senderEmail VARCHAR(255),
        subject VARCHAR(255),
        message TEXT,
        timestamp VARCHAR(100),
        isRead BOOLEAN DEFAULT FALSE,
        isBooking BOOLEAN DEFAULT FALSE,
        bookingAmountPaid DECIMAL(10,2) DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("🐬 MySQL Connected Successfully");
  } catch (error: any) {
    console.error("❌ MySQL Connection Error:", error.message);
    process.exit(1);
  }
}

// --- API ROUTES ---

// 1. Get Portfolio Data
app.get("/api/portfolio", async (req, res) => {
  try {
    const [rows]: any = await db.query("SELECT data FROM portfolio WHERE portfolio_key='primary'");
    if (rows.length === 0) {
      await db.query("INSERT INTO portfolio (portfolio_key, data) VALUES ('primary', ?)", [JSON.stringify(initialPortfolioData)]);
      return res.json({ success: true, data: initialPortfolioData });
    }
    res.json({ success: true, data: rows[0].data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Update Portfolio Data
app.post("/api/portfolio", async (req, res) => {
  try {
    const data = JSON.stringify(req.body.data);
    await db.query(
      `INSERT INTO portfolio (portfolio_key, data) VALUES ('primary', ?) ON DUPLICATE KEY UPDATE data=?`,
      [data, data]
    );
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Get All Messages (Admin Panel)
app.get("/api/messages", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM messages ORDER BY createdAt DESC");
    res.json({ success: true, data: rows });
  } catch {
    res.status(500).json({ success: false });
  }
});

// 4. MAIN ROUTE: Handle Message & Email (User + Admin)
app.post("/api/messages", async (req, res) => {
  try {
    const {
      senderName,
      senderEmail,
      subject,
      message,
      isBooking,
      bookingAmountPaid,
    } = req.body;

    const id = `msg-${Date.now()}`;
    const formattedDate = new Date().toLocaleString();

    // A. Store in Database
    await db.query(
      `INSERT INTO messages 
      (id, senderName, senderEmail, subject, message, timestamp, isBooking, bookingAmountPaid) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, senderName, senderEmail, subject || "No Subject", message, formattedDate, !!isBooking, Number(bookingAmountPaid) || 0]
    );

    // B. Send Emails
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.ADMIN_EMAIL) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      // 1. Email to USER (The sender)
      const userMailOptions = {
        from: `"Support" <${process.env.EMAIL_USER}>`,
        to: senderEmail,
        subject: isBooking ? "Booking Confirmation - Payment Received" : "We Received Your Message",
        html: `
          <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
            <h2>Hello ${senderName},</h2>
            ${isBooking 
              ? `<p>Thank you for your booking. We have successfully received your payment of <b>₹${bookingAmountPaid}</b>.</p>`
              : `<p>Thank you for reaching out! We have received your message and will get back to you soon.</p>`
            }
            <hr />
            <p><b>Your Message Details:</b></p>
            <p><i>"${message}"</i></p>
            <br />
            <p>Regards,<br>Your Team</p>
          </div>
        `,
      };

      // 2. Email to ADMIN (You)
      const adminMailOptions = {
        from: `"System Alert" <${process.env.EMAIL_USER}>`,
        to: process.env.ADMIN_EMAIL,
        subject: isBooking ? "🚨 NEW BOOKING RECEIVED" : "📩 NEW CONTACT MESSAGE",
        html: `
          <div style="font-family: sans-serif; background: #f4f4f4; padding: 20px;">
            <div style="background: white; padding: 20px; border-radius: 10px;">
              <h2>New Submission Details</h2>
              <p><strong>Type:</strong> ${isBooking ? "Booking/Transaction" : "General Inquiry"}</p>
              <p><strong>Name:</strong> ${senderName}</p>
              <p><strong>Email:</strong> ${senderEmail}</p>
              <p><strong>Subject:</strong> ${subject || "N/A"}</p>
              <p><strong>Message:</strong> ${message}</p>
              ${isBooking ? `<p style="color: green; font-size: 18px;"><strong>Amount Paid: ₹${bookingAmountPaid}</strong></p>` : ""}
              <p><strong>Time:</strong> ${formattedDate}</p>
            </div>
          </div>
        `,
      };

      // Execute sending emails
      await transporter.sendMail(userMailOptions);
      await transporter.sendMail(adminMailOptions);

      console.log(`✅ Emails sent to User (${senderEmail}) and Admin`);
    } else {
      console.warn("⚠️ Email ENV variables missing. Database record created but emails not sent.");
    }

    res.json({ success: true, id });

  } catch (error: any) {
    console.error("❌ Message/Email Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Mark as Read
app.patch("/api/messages/:id/read", async (req, res) => {
  try {
    await db.query("UPDATE messages SET isRead=? WHERE id=?", [!!req.body.read, req.params.id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

// 6. Delete Message
app.delete("/api/messages/:id", async (req, res) => {
  try {
    if (req.params.id === "all") {
      await db.query("DELETE FROM messages");
    } else {
      await db.query("DELETE FROM messages WHERE id=?", [req.params.id]);
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

// --- SERVER STARTUP ---
async function startServer() {
  try {
    await initDb();

    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("SERVER START ERROR:", error);
  }
}

startServer();