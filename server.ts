import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import path from "path";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { createServer as createViteServer } from "vite";
import { initialPortfolioData } from "./src/initialData";

// Load environment variables
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// --- MYSQL CONNECTION SETUP ---
let db: mysql.Pool;

async function initDb() {
  try {
    // 1. First, connect without a database to ensure the database exists
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD,
    });

    const dbName = process.env.DB_NAME || "portfolio_db";
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
    await connection.end();

    // 2. Now connect to the actual database pool
    db = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    // 3. Create Portfolio Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_key VARCHAR(50) UNIQUE DEFAULT 'primary',
        data JSON NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 4. Create Messages Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(100) PRIMARY KEY,
        senderName VARCHAR(255) NOT NULL,
        senderEmail VARCHAR(255) NOT NULL,
        subject VARCHAR(255),
        message TEXT NOT NULL,
        timestamp VARCHAR(100),
        isRead BOOLEAN DEFAULT FALSE,
        isBooking BOOLEAN DEFAULT FALSE,
        bookingAmountPaid DECIMAL(10, 2) DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log(`🐬 MySQL Database "${dbName}" is ready and connected!`);
  } catch (err: any) {
    console.error("❌ MySQL Connection/Init Error:", err.message);
    process.exit(1);
  }
}

// --- API ENDPOINTS ---

/**
 * Fetch Portfolio Settings
 */
app.get("/api/portfolio", async (req, res) => {
  try {
    const [rows]: any = await db.query("SELECT data FROM portfolio WHERE portfolio_key = 'primary'");
    
    if (rows.length === 0) {
      const stringifiedData = JSON.stringify(initialPortfolioData);
      await db.query("INSERT INTO portfolio (portfolio_key, data) VALUES ('primary', ?)", [stringifiedData]);
      return res.json({ success: true, data: initialPortfolioData });
    }
    
    return res.json({ success: true, data: rows[0].data });
  } catch (error: any) {
    console.error("Error retrieving portfolio:", error);
    return res.status(500).json({ success: false, error: "Database lookup failed" });
  }
});

/**
 * Update Portfolio Settings
 */
app.post("/api/portfolio", async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: "Missing data" });

  try {
    const stringifiedData = JSON.stringify(data);
    await db.query(
      "INSERT INTO portfolio (portfolio_key, data) VALUES ('primary', ?) ON DUPLICATE KEY UPDATE data = ?",
      [stringifiedData, stringifiedData]
    );
    return res.json({ success: true, message: "Portfolio saved successfully", data });
  } catch (error: any) {
    console.error("Error saving portfolio:", error);
    return res.status(500).json({ success: false, error: "Database operation failed" });
  }
});

/**
 * Fetch all Messages
 */
app.get("/api/messages", async (req, res) => {
  try {
    const [rows]: any = await db.query("SELECT * FROM messages ORDER BY createdAt DESC");
    return res.json({ success: true, data: rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Could not load messages." });
  }
});

/**
 * Submit New Message & Send Emails (To Admin and User)
 */
app.post("/api/messages", async (req, res) => {
  const { senderName, senderEmail, subject, message, isBooking, bookingAmountPaid } = req.body;

  if (!senderName || !senderEmail || !message) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const cleanSubject = subject || "New Portfolio Interaction";
  const newId = "msg-" + Date.now();
  const timestampString = new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();

  try {
    // 1. Save to MySQL
    await db.query(
      "INSERT INTO messages (id, senderName, senderEmail, subject, message, timestamp, isBooking, bookingAmountPaid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [newId, senderName, senderEmail, cleanSubject, message, timestampString, !!isBooking, Number(bookingAmountPaid) || 0]
    );

    // 2. Email Notification
    const adminEmail = process.env.EMAIL_USER || "dharsanadevi09@gmail.com";
    const smtpUser = process.env.EMAIL_USER;
    const smtpPass = process.env.EMAIL_PASS;

    if (smtpUser && smtpPass) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: smtpUser, pass: smtpPass }
      });

      // Admin Mail
      const adminMailOptions = {
        from: `"${senderName}" <${smtpUser}>`,
        to: adminEmail,
        subject: `🔔 New Website Message: ${cleanSubject}`,
        text: `Hello Admin,\n\nYou have a new message.\n\nFrom: ${senderName}\nEmail: ${senderEmail}\nMessage: ${message}\n\nIs Booking: ${isBooking ? 'Yes' : 'No'}\nAmount: ${bookingAmountPaid || 0}`
      };

      // User Mail
      const userMailOptions = {
        from: `"Dharsana Devi" <${smtpUser}>`,
        to: senderEmail,
        subject: `Received: ${cleanSubject}`,
        text: `Hi ${senderName},\n\nThank you for contacting me. I have received your message and will get back to you soon!\n\nBest Regards,\nDharsana Devi`
      };

      await Promise.all([
        transporter.sendMail(adminMailOptions),
        transporter.sendMail(userMailOptions)
      ]);
    }

    return res.json({ success: true, message: "Message processed successfully", id: newId });

  } catch (error: any) {
    console.error("Error in message submission:", error);
    return res.status(500).json({ success: false, error: "Failed to process request" });
  }
});

/**
 * Delete Message
 */
app.delete("/api/messages/:id", async (req, res) => {
  const { id } = req.params;
  try {
    if (id === "all") {
      await db.query("DELETE FROM messages");
    } else {
      await db.query("DELETE FROM messages WHERE id = ?", [id]);
    }
    return res.json({ success: true, message: "Deleted successfully" });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update Message Read Status
 */
app.patch("/api/messages/:id/read", async (req, res) => {
  const { id } = req.params;
  const { read } = req.body;
  try {
    await db.query("UPDATE messages SET isRead = ? WHERE id = ?", [!!read, id]);
    return res.json({ success: true, message: "Read status updated" });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Server Initialization
async function startServer() {
  await initDb();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server is active on port ${PORT}`);
  });
}

startServer();