import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

dotenv.config();

console.log("========== ENV CHECK ==========");
console.log("MYSQLHOST:", process.env.MYSQLHOST);
console.log("MYSQLUSER:", process.env.MYSQLUSER);
console.log("MYSQLDATABASE:", process.env.MYSQLDATABASE);
console.log("MYSQLPORT:", process.env.MYSQLPORT);
console.log("EMAIL_USER:", process.env.EMAIL_USER);
console.log("ADMIN_EMAIL:", process.env.ADMIN_EMAIL);
console.log("================================");

const app = express();

app.use(express.json());

// DATABASE CONNECTION
const db = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: Number(process.env.MYSQLPORT) || 4000,

  ssl: {
    rejectUnauthorized: false,
  },

  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

// INITIALIZE DATABASE
const initDb = async () => {
  try {
    const connection = await db.getConnection();

    console.log("✅ Database Connected Successfully");

    await connection.query(`
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

    console.log("✅ Messages Table Ready");

    connection.release();
  } catch (err) {
    console.error("❌ DATABASE ERROR:");
    console.error(err);
  }
};

initDb();

// TEST ROUTE
app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "Backend Running Successfully",
  });
});

// SAVE MESSAGE
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

    if (!senderName || !senderEmail || !message) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing",
      });
    }

    const id = `msg-${Date.now()}`;
    const formattedDate = new Date().toLocaleString();

    // SAVE TO DATABASE
    await db.query(
      `
      INSERT INTO messages (
        id,
        senderName,
        senderEmail,
        subject,
        message,
        timestamp,
        isBooking,
        bookingAmountPaid
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        senderName,
        senderEmail,
        subject || "No Subject",
        message,
        formattedDate,
        !!isBooking,
        Number(bookingAmountPaid) || 0,
      ]
    );

    console.log("✅ Message Saved To Database");

    // EMAIL SECTION
    if (
      process.env.EMAIL_USER &&
      process.env.EMAIL_PASS &&
      process.env.ADMIN_EMAIL
    ) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      // VERIFY SMTP
      await transporter.verify();

      console.log("✅ Gmail Connected");

      // EMAIL TO USER
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: senderEmail,
        subject: "Message Received Successfully",
        html: `
          <h2>Hello ${senderName}</h2>

          <p>Thank you for contacting us.</p>

          <p>We have successfully received your message.</p>

          <p>We will get back to you soon.</p>

          <hr>

          <h3>Your Message</h3>

          <p><strong>Subject:</strong> ${
            subject || "No Subject"
          }</p>

          <p>${message}</p>

          <br>

          <p>Best Regards,<br>Portfolio Team</p>
        `,
      });

      console.log("✅ User Email Sent");

      // EMAIL TO ADMIN
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.ADMIN_EMAIL,
        subject: `📩 New Message From ${senderName}`,
        html: `
          <h2>New Contact Form Submission</h2>

          <p><strong>Name:</strong> ${senderName}</p>

          <p><strong>Email:</strong> ${senderEmail}</p>

          <p><strong>Subject:</strong> ${
            subject || "No Subject"
          }</p>

          <p><strong>Message:</strong></p>

          <p>${message}</p>

          <hr>

          <p><strong>Message ID:</strong> ${id}</p>

          <p><strong>Time:</strong> ${formattedDate}</p>
        `,
      });

      console.log("✅ Admin Email Sent");
    } else {
      console.log("⚠️ Email credentials not configured");
    }

    res.json({
      success: true,
      message: "Message Saved Successfully",
    });
  } catch (error) {
    console.error("❌ API ERROR:");
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET ALL MESSAGES
app.get("/api/messages", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM messages ORDER BY createdAt DESC"
    );

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET SINGLE MESSAGE
app.get("/api/messages/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM messages WHERE id = ?",
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server Running On Port ${PORT}`);
});

export default app;