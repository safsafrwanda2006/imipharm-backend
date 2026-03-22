import express from "express";
import cors from "cors";
import session from "express-session";
import mysql2 from "mysql2";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import multer from "multer";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import nodemailer from "nodemailer";


dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://imipharm.vercel.app";
const RESET_TOKEN_TTL_MIN = Number(process.env.RESET_TOKEN_TTL_MIN || 60);
const REMEMBER_DAYS = Number(process.env.REMEMBER_DAYS || 30);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { Error: "Too many login attempts. Try again later." },
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(
  cors({
    origin: ["https://imipharm.vercel.app"],
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.use(
  session({
    name: "sessionId",
    secret: "secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  }),
);

// const db = mysql2.createConnection({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
// });
const db = mysql2.createConnection(process.env.DB_URL);
// const db = mysql2.createConnection({
//   host: "localhost",
//   user: "root",
//   password: "12345",
//   database: "pharmacy",
// });

// -------------------------
// Helpers / Middlewares
// -------------------------
const verifyUser = (req, res, next) => {
  if (!req.session.user) {
    return res.status(403).json({ Error: "Login first" });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.session.user?.role === "admin") return next();
  return res.status(403).json({ Error: "Admin only" });
};

const requireStandardOrPremium = (req, res, next) => {
  const pharmacyId = req.session.user?.id;
  if (!pharmacyId) return res.status(403).json({ Error: "Login first" });

  db.query(
    "SELECT plan_months FROM pharmacies WHERE id = ? LIMIT 1",
    [pharmacyId],
    (err, rows) => {
      if (err) return res.status(500).json({ Error: "Database error" });
      if (!rows.length) return res.status(404).json({ Error: "Not found" });

      const pm = Number(rows[0].plan_months);
      if (pm === 3 || pm === 6) return next();

      return res
        .status(403)
        .json({ Error: "This feature is for Standard/Premium only" });
    },
  );
};

// -------------------------
// Multer upload
// -------------------------
const storage = multer.diskStorage({
  destination: "uploads",
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// -------------------------
// Upload medicines file (with file record)
// -------------------------
app.post("/upload", verifyUser, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ Error: "No file uploaded" });
  }

  const allowedTypes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/csv",
  ];

  if (!allowedTypes.includes(req.file.mimetype)) {
    return res.status(400).json({ Error: "Invalid file type" });
  }

  const pharmacyId = req.session.user.id;
  const filePath = path.join(__dirname, "uploads", req.file.filename);

  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  const medicines = data
    .map((row) => row[0])
    .filter((name) => name && typeof name === "string");

  if (medicines.length === 0) {
    return res.status(400).json({ Error: "No medicines found in file" });
  }

  const values = medicines.map((name) => [name, pharmacyId]);

  const sql = `
    INSERT INTO medicines (medicine_name, pharmacy_id)
    VALUES ?
  `;

  db.query(sql, [values], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ Error: "Database error" });
    }

    const insertFileSql = `
      INSERT INTO files (pharmacy_id, fileName, originalName, type, size)
      VALUES (?, ?, ?, ?, ?)
    `;

    db.query(
      insertFileSql,
      [
        pharmacyId,
        req.file.filename,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
      ],
      (err2, result2) => {
        if (err2) {
          console.error("FILES INSERT ERROR:", err2);
          return res.json({
            message:
              "Medicines uploaded successfully, but file record not saved",
          });
        }

        return res.json({
          message: "Medicines uploaded successfully",
          file: {
            id: result2.insertId,
            fileName: req.file.filename,
            originalName: req.file.originalname,
            type: req.file.mimetype,
            size: req.file.size,
          },
        });
      },
    );
  });
});

// legacy endpoint (kept as-is)
app.post("/upload-medicines", upload.single("file"), (req, res) => {
  const pharmacyId = req.session.pharmacyId;
  if (!pharmacyId) return res.status(401).json("Not authenticated");

  const workbook = XLSX.readFile(req.file.path);
  const sheetName = workbook.SheetNames[0];
  const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

  const q = "INSERT INTO medicines (medicine_name, pharmacy_id) VALUES ?";
  const values = sheetData.map((row) => [row.medicine_name, pharmacyId]);

  db.query(q, [values], (err) => {
    fs.unlinkSync(req.file.path);
    if (err) return res.status(500).json(err);
    res.json("Medicines uploaded successfully");
  });
});

// -------------------------
// Suggestions
// -------------------------
app.get("/medicine-suggestions", (req, res) => {
  const q = req.query.q;

  if (!q || q.length < 2) return res.json([]);

  const sql = `
    SELECT DISTINCT medicine_name
    FROM medicines
    WHERE medicine_name LIKE ?
    LIMIT 10
  `;

  db.query(sql, [`%${q}%`], (err, data) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ Error: "Database error" });
    }
    res.json(data);
  });
});

// -------------------------
// Search medicine (IMPORTANT: keep your snippet unchanged)
// -------------------------
app.get("/search-medicine", (req, res) => {
  const keyword = req.query.q?.trim();

  if (!keyword) {
    return res.status(400).json({ Error: "Search keyword required" });
  }

  // ✅ NEW: include plan_months + sort (6 then 3 then 1)
  const searchSql = `
    SELECT DISTINCT 
      p.id,
      p.pharmacylocation,
      p.pharmacyname,
      p.city,
      p.plan_months
    FROM medicines m
    JOIN pharmacies p ON m.pharmacy_id = p.id
    WHERE 
      m.status = 'available'
      AND p.status = 'active'
      AND m.medicine_name LIKE ?
    ORDER BY
      CASE p.plan_months
        WHEN 6 THEN 1
        WHEN 3 THEN 2
        ELSE 3
      END,
      p.pharmacyname ASC
  `;

  db.query(searchSql, [`%${keyword}%`], (err, data) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ Error: "Database error" });
    }

    // ✅ DO NOT change this snippet (kept as-is):
    if (data.length > 0) {
      const insertSearch = `
        INSERT IGNORE INTO searched_medicines (medicine_name)
        VALUES (?)
      `;
      db.query(insertSearch, [keyword]);

      const incSql = `
        UPDATE searched_medicines
        SET search_count = search_count + 1,
            last_searched_at = NOW()
        WHERE medicine_name = ?
      `;
      db.query(incSql, [keyword]);
    }

    res.json(data);
  });
});

app.get("/search-medicine-city", (req, res) => {
  const { q, city } = req.query;

  if (!q || !city) {
    return res
      .status(400)
      .json({ Error: "medicine name and city are required" });
  }

  const sql = `
    SELECT DISTINCT
      p.id,
      p.pharmacyname,
      p.pharmacylocation,
      p.city,
      p.plan_months
    FROM medicines m
    JOIN pharmacies p ON m.pharmacy_id = p.id
    WHERE
      m.status = 'available'
      AND p.status = 'active'
      AND m.medicine_name LIKE ?
      AND p.city = ?
    ORDER BY
      CASE p.plan_months
        WHEN 6 THEN 1
        WHEN 3 THEN 2
        ELSE 3
      END,
      p.pharmacyname ASC
  `;

  db.query(sql, [`%${q}%`, city], (err, data) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ Error: "Database error" });
    }
    res.json(data);
  });
});
// -------------------------
// Cities
// -------------------------
app.get("/cities", (req, res) => {
  const sql = "SELECT DISTINCT city FROM pharmacies ORDER BY city ASC";
  db.query(sql, (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

// -------------------------
// Missing medicines (kept - but you will hide for Basic on frontend)
// -------------------------
app.get("/missing-medicines", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;

  const sql = `
    SELECT DISTINCT sm.medicine_name
    FROM searched_medicines sm
    WHERE sm.medicine_name NOT IN (
      SELECT m.medicine_name
      FROM medicines m
      WHERE m.pharmacy_id = ?
    )
    ORDER BY sm.medicine_name ASC
  `;

  db.query(sql, [pharmacyId], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ Error: "Database error" });
    }
    res.json(result);
  });
});

// -------------------------
// NEW: Market demand feature (Standard/Premium only)
// threshold default = 15 within last 30 days
// -------------------------
app.get(
  "/me/market-demand",
  verifyUser,
  requireStandardOrPremium,
  (req, res) => {
    const pharmacyId = req.session.user.id;

    const min = Number(req.query.min || 15);
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const sql = `
      SELECT sm.medicine_name, sm.search_count, sm.last_searched_at
      FROM searched_medicines sm
      WHERE sm.search_count >= ?
        AND sm.last_searched_at >= (NOW() - INTERVAL 30 DAY)
        AND sm.medicine_name NOT IN (
          SELECT m.medicine_name
          FROM medicines m
          WHERE m.pharmacy_id = ?
        )
      ORDER BY sm.search_count DESC, sm.last_searched_at DESC
      LIMIT ?
    `;

    db.query(sql, [min, pharmacyId, limit], (err, rows) => {
      if (err) return res.status(500).json({ Error: "Database error" });
      res.json(rows);
    });
  },
);

// -------------------------
// Medicines CRUD (pharmacy)
// -------------------------
app.get("/medicines", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;
  const q =
    "SELECT * FROM medicines WHERE pharmacy_id = ? ORDER BY medicine_name ASC";
  db.query(q, [pharmacyId], (err, data) => {
    if (err) return res.status(500).json(err);
    res.json(data);
  });
});

app.post("/medicines", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;
  const { medicine_name } = req.body;

  if (!medicine_name || medicine_name.trim() === "") {
    return res.status(400).json({ message: "Medicine name is required" });
  }

  const q = `
    INSERT INTO medicines (medicine_name, pharmacy_id, status)
    VALUES (?, ?, 'available')
  `;

  db.query(q, [medicine_name.trim(), pharmacyId], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ message: "Database error" });
    }

    res.status(201).json({
      id: result.insertId,
      medicine_name: medicine_name.trim(),
      status: "available",
    });
  });
});

app.put("/medicines/:id", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;
  const medicineId = req.params.id;
  const { status } = req.body;

  const q = `
    UPDATE medicines 
    SET status = ? 
    WHERE id = ? AND pharmacy_id = ?
  `;

  db.query(q, [status, medicineId, pharmacyId], (err) => {
    if (err) return res.status(500).json(err);
    res.json("Status updated");
  });
});

app.delete("/medicines", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;

  db.query(
    "DELETE FROM medicines WHERE pharmacy_id = ?",
    [pharmacyId],
    (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Database error" });
      }
      res.json({ ok: true, deleted: result.affectedRows });
    },
  );
});

// -------------------------
// Files
// -------------------------
app.get("/files", verifyUser, (req, res) => {
  const pharmacyId = req.session.user?.id;
  const sql = "SELECT * FROM files WHERE pharmacy_id = ?";
  db.query(sql, [pharmacyId], (err, result) => {
    if (err) return res.status(500).json({ Error: "Database error" });
    res.json(result);
  });
});

app.delete("/files/:id", verifyUser, (req, res) => {
  const fileId = req.params.id;

  const q = "SELECT fileName FROM files WHERE id = ?";
  db.query(q, [fileId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error" });
    if (result.length === 0)
      return res.status(404).json({ message: "File not found" });

    const filePath = path.join(__dirname, "uploads", result[0].fileName);

    fs.unlink(filePath, (err2) => {
      if (err2) {
        console.error("FS unlink error:", err2);
        return res.status(500).json({ message: "File delete failed" });
      }

      const delQ = "DELETE FROM files WHERE id = ?";
      db.query(delQ, [fileId], (err3) => {
        if (err3) {
          console.error("DB delete error:", err3);
          return res.status(500).json({ message: "DB delete failed" });
        }

        res.json({ message: "File deleted successfully" });
      });
    });
  });
});

// -------------------------
// Auth helpers
// -------------------------
app.get("/check-auth", (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// -------------------------
// Register (Basic free => receipt = "00000")
// -------------------------
app.post("/register", (req, res) => {
  const planMonths = Number(req.body.plan_months);
  const receiptId = (req.body.receipt_id || "").trim();

  if (![1, 3, 6].includes(planMonths)) {
    return res.status(400).json({ Error: "Invalid plan" });
  }

  let finalReceipt = receiptId;

  if (planMonths === 1) {
    finalReceipt = "00000"; // Basic free
  } else {
    if (!finalReceipt) {
      return res.status(400).json({ Error: "Receipt ID is required" });
    }
  }

  const q = `
    INSERT INTO pharmacies
      (email, pharmacyname, pharmacylocation, city, password, subscription_date, plan_months, receipt_id, status)
    VALUES
      (?, ?, ?, ?, ?, NOW(), ?, ?, 'pending')
  `;

  bcrypt.hash(req.body.password?.toString() || "", 10, (err, hash) => {
    if (err) return res.status(500).json({ Error: "Error hashing password" });

    const values = [
      req.body.email,
      req.body.pharmacyname,
      req.body.pharmacylocation,
      req.body.city,
      hash,
      planMonths,
      finalReceipt,
    ];

    db.query(q, values, (err2) => {
      if (err2) {
        console.log(err2);
        return res.status(500).json({ Error: "inserting data error" });
      }
      return res.status(200).json({ Status: "Success" });
    });
  });
});

// -------------------------
// Admin: status update
// -------------------------
app.put("/pharmacies/:id", verifyUser, requireAdmin, (req, res) => {
  const pharmacyId = req.params.id;
  const { status } = req.body;

  const q = `
    UPDATE pharmacies 
    SET status = ? 
    WHERE id = ? 
  `;

  db.query(q, [status, pharmacyId], (err) => {
    if (err) return res.status(500).json(err);
    res.json("Status updated");
  });
});

app.get("/pharmacies", verifyUser, requireAdmin, (req, res) => {
  const sql =
    "SELECT id, pharmacyname, city, subscription_date, plan_months, status, receipt_id FROM pharmacies";
  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json(result);
  });
});

// -------------------------
// Messages (admin -> pharmacy)
// -------------------------
app.post(
  "/pharmacies/:pharmacyId/messages",
  verifyUser,
  requireAdmin,
  (req, res) => {
    const { pharmacyId } = req.params;
    const { messageText } = req.body;

    if (!pharmacyId || Number.isNaN(Number(pharmacyId))) {
      return res.status(400).json({ error: "Invalid pharmacyId" });
    }

    const text = (messageText || "").trim();
    if (!text) {
      return res.status(400).json({ error: "messageText is required" });
    }

    db.query(
      "SELECT id, email, pharmacyname FROM pharmacies WHERE id = ? LIMIT 1",
      [pharmacyId],
      (err, phRows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (phRows.length === 0)
          return res.status(404).json({ error: "Pharmacy not found" });

        db.query(
          `INSERT INTO pharmacy_messages (pharmacy_id, message_text, message_type, sent_by)
           VALUES (?, ?, 'renewal', 'admin')`,
          [pharmacyId, text],
          (err2, result) => {
            if (err2) return res.status(500).json({ error: "Database error" });

            return res.status(201).json({
              ok: true,
              messageId: result.insertId,
              pharmacy: phRows[0],
            });
          },
        );
      },
    );
  },
);

app.get("/me/messages", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;

  db.query(
    `SELECT id, message_text, message_type, sent_by, sent_at, read_at, status
     FROM pharmacy_messages
     WHERE pharmacy_id = ?
     ORDER BY sent_at DESC`,
    [pharmacyId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json(rows);
    },
  );
});

app.patch("/me/messages/:id/read", verifyUser, (req, res) => {
  const pharmacyId = req.session.user.id;
  const { id } = req.params;

  db.query(
    `UPDATE pharmacy_messages
     SET status='read', read_at=NOW()
     WHERE id=? AND pharmacy_id=?`,
    [id, pharmacyId],
    (err, result) => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json({ ok: true, affectedRows: result.affectedRows });
    },
  );
});

// -------------------------
// Feedback
// -------------------------
app.post("/feedback", verifyUser, (req, res) => {
  const feedback = (req.body.feedback || "").trim();
  if (!feedback) return res.status(400).json({ error: "Feedback is required" });
  if (feedback.length > 800) return res.status(400).json({ error: "Too long" });

  const u = req.session.user;

  db.query(
    "INSERT INTO feedbacks (user_id, email, role, feedback) VALUES (?, ?, ?, ?)",
    [u.id, u.email, u.role, feedback],
    (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database error" });
      }
      return res.json({ ok: true, id: result.insertId });
    },
  );
});

app.get("/feedbacks", verifyUser, requireAdmin, (req, res) => {
  db.query(
    "SELECT id, user_id, email, role, feedback, created_at FROM feedbacks ORDER BY created_at DESC",
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database error" });
      }
      res.json(rows);
    },
  );
});

// -------------------------
// Subscription info
// -------------------------
app.get("/me/subscription", verifyUser, (req, res) => {
  const id = req.session.user.id;

  db.query(
    "SELECT subscription_date, plan_months, status FROM pharmacies WHERE id = ? LIMIT 1",
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      res.json(rows[0]);
    },
  );
});

// -------------------------
// Login / Logout
// -------------------------
app.post("/login", (req, res) => {
  const ADMIN_EMAILS = ["mustafa@gmail.com", "safsaf@gmail.com"];

  const { email, password, remember } = req.body;

  if (!email || !password) {
    return res.status(400).json({ Error: "Email and password are required" });
  }

  const q = "SELECT * FROM pharmacies WHERE email = ? LIMIT 1";
  db.query(q, [email], (err, data) => {
    if (err) return res.status(500).json({ Error: "Server error" });
    if (!data.length) return res.status(404).json({ Error: "No email found" });

    const user = data[0];
    const role = ADMIN_EMAILS.includes(user.email) ? "admin" : "pharmacy";

    bcrypt.compare(password, user.password, (err2, isMatch) => {
      if (err2) return res.status(500).json({ Error: "Error checking password" });
      if (!isMatch) return res.status(401).json({ Error: "Wrong password" });

      req.session.user = {
        id: user.id,
        pharmacyname: user.pharmacyname,
        email: user.email,
        role,
      };

      // ✅ Remember Me: لو true نخلي السيشن تقعد 30 يوم بدل يوم
      if (remember) {
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * REMEMBER_DAYS;
      } else {
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24; // يوم واحد زي كودك
      }

      // ✅ Block Pending Login = NO => ما بنمنع pending
      return res.status(200).json({
        Status: "Success",
        user: req.session.user,
        subscription_status: user.status, // optional useful in UI
      });
    });
  });
});


app.post("/forgot-password", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email is required" });

  db.query("SELECT id, email FROM pharmacies WHERE email = ? LIMIT 1", [email], async (err, rows) => {
    if (err) return res.status(500).json({ error: "Database error" });

    // ✅ دائما رجّع نفس الرد عشان ما تكشف اذا الايميل موجود
    const genericOk = { ok: true, message: "If the email exists, a reset link was sent." };

    if (!rows.length) return res.json(genericOk);

    const pharmacyId = rows[0].id;

    // token raw + hash
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000);

    db.query(
      "INSERT INTO password_resets (pharmacy_id, token_hash, expires_at) VALUES (?, ?, ?)",
      [pharmacyId, tokenHash, expiresAt],
      async (err2) => {
        if (err2) return res.status(500).json({ error: "Database error" });

        const link = `${FRONTEND_URL}/reset-password?token=${rawToken}`;

        try {
          await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: "Reset your password",
            html: `
              <div style="font-family:Arial;line-height:1.6">
                <h2>Password Reset</h2>
                <p>Click the button below to reset your password (valid for ${RESET_TOKEN_TTL_MIN} minutes):</p>
                <p>
                  <a href="${link}" style="display:inline-block;padding:12px 16px;border-radius:10px;text-decoration:none;background:#0ea5e9;color:#fff;font-weight:700">
                    Reset Password
                  </a>
                </p>
                <p>If you did not request this, ignore this email.</p>
              </div>
            `,
          });
        } catch (mailErr) {
          console.error("MAIL ERROR:", mailErr);
          // ما نرجّع error للمستخدم (عشان الأمان) لكن انت شوف اللوج
        }

        return res.json(genericOk);
      }
    );
  });
});


app.post("/reset-password", (req, res) => {
  const token = (req.body.token || "").trim();
  const newPassword = (req.body.password || "").toString();

  if (!token) return res.status(400).json({ error: "Token is required" });
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  db.query(
    `SELECT id, pharmacy_id, expires_at, used_at
     FROM password_resets
     WHERE token_hash = ? LIMIT 1`,
    [tokenHash],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!rows.length) return res.status(400).json({ error: "Invalid or expired token" });

      const row = rows[0];
      if (row.used_at) return res.status(400).json({ error: "Token already used" });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: "Token expired" });
      }

      bcrypt.hash(newPassword, 10, (err2, hash) => {
        if (err2) return res.status(500).json({ error: "Hashing error" });

        db.query("UPDATE pharmacies SET password = ? WHERE id = ?", [hash, row.pharmacy_id], (err3) => {
          if (err3) return res.status(500).json({ error: "Database error" });

          db.query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [row.id], (err4) => {
            if (err4) return res.status(500).json({ error: "Database error" });

            return res.json({ ok: true, message: "Password updated successfully" });
          });
        });
      });
    }
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sessionId");
    res.json({ Status: "Success" });
  });
});

app.get("/dashboard", verifyUser, (req, res) => {
  return res.json({ Status: "Success", name: req.session.user.pharmacyname });
});

app.listen(8081, () => {
  console.log("server is running on 8081");
});
