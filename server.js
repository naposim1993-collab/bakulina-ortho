require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let DOCTOR_CHAT_ID = process.env.DOCTOR_TELEGRAM_ID || null;

// ──────────────────────────────────────────────
// DATABASE
// ──────────────────────────────────────────────
const dbPath = path.join(__dirname, "data", "app.db");
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    telegram_chat_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time_from TEXT NOT NULL,
    time_to TEXT NOT NULL,
    visit_type TEXT,
    price TEXT,
    comment TEXT,
    status TEXT DEFAULT 'pending',
    reminder_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ──────────────────────────────────────────────
// TELEGRAM BOT
// ──────────────────────────────────────────────
let bot = null;

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log("Telegram bot started");

  // /start command — link patient
  bot.onText(/\/start(.*)/, (msg, match) => {
    const chatId = msg.chat.id;
    const param = (match[1] || "").trim();

    // If doctor starts the bot, save their chat ID
    if (param === "doctor") {
      DOCTOR_CHAT_ID = String(chatId);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        "doctor_chat_id",
        DOCTOR_CHAT_ID
      );
      bot.sendMessage(chatId, "✅ Вас підключено як лікаря. Ви будете отримувати сповіщення про підтвердження/скасування записів.");
      return;
    }

    // Patient start — try to link by patient ID
    if (param) {
      const patientId = parseInt(param, 10);
      if (patientId) {
        const patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(patientId);
        if (patient) {
          db.prepare("UPDATE patients SET telegram_chat_id = ? WHERE id = ?").run(
            String(chatId),
            patientId
          );
          bot.sendMessage(
            chatId,
            `Вітаємо, ${patient.name}! 👋\n\nВас підключено до системи нагадувань. Ви отримуватимете повідомлення за добу до запису.`
          );
          return;
        }
      }
    }

    // Generic start — try to find patient by Telegram username or save chat ID for later
    bot.sendMessage(
      chatId,
      `Вітаємо! 👋\n\nЦей бот надсилає нагадування про ваші записи до лікаря-ортодонта.\n\nВаш Telegram підключено. Коли лікар створить для вас запис, ви отримаєте нагадування автоматично.`
    );

    // Save chat ID with username for potential matching later
    const username = msg.from.username;
    if (username) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        `tg_user_${username.toLowerCase()}`,
        String(chatId)
      );
    }
    // Also save by chat ID for phone-based linking
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      `tg_chat_${chatId}`,
      JSON.stringify({
        chatId: String(chatId),
        firstName: msg.from.first_name || "",
        lastName: msg.from.last_name || "",
        username: username || "",
      })
    );
  });

  // Handle callback queries (confirm / cancel buttons)
  bot.on("callback_query", (query) => {
    const chatId = query.message.chat.id;
    const data = query.data; // "confirm_123" or "cancel_123"

    const [action, appointmentId] = data.split("_");
    const appt = db
      .prepare(
        `SELECT a.*, p.name as patient_name 
         FROM appointments a 
         JOIN patients p ON a.patient_id = p.id 
         WHERE a.id = ?`
      )
      .get(parseInt(appointmentId, 10));

    if (!appt) {
      bot.answerCallbackQuery(query.id, { text: "Запис не знайдено" });
      return;
    }

    if (action === "confirm") {
      db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(appt.id);
      bot.answerCallbackQuery(query.id, { text: "✅ Підтверджено!" });
      bot.editMessageText(
        `✅ Ви підтвердили запис на ${appt.date} о ${appt.time_from}.\n\nДякуємо! Чекаємо на вас.`,
        { chat_id: chatId, message_id: query.message.message_id }
      );

      // Notify doctor
      if (DOCTOR_CHAT_ID) {
        bot.sendMessage(
          DOCTOR_CHAT_ID,
          `✅ ${appt.patient_name} підтвердив(ла) запис на ${appt.date} о ${appt.time_from}`
        );
      }
    } else if (action === "cancel") {
      db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appt.id);
      bot.answerCallbackQuery(query.id, { text: "❌ Скасовано" });
      bot.editMessageText(
        `❌ Ви скасували запис на ${appt.date} о ${appt.time_from}.\n\nЯкщо хочете перезаписатися — зверніться до лікаря.`,
        { chat_id: chatId, message_id: query.message.message_id }
      );

      // Notify doctor
      if (DOCTOR_CHAT_ID) {
        bot.sendMessage(
          DOCTOR_CHAT_ID,
          `❌ ${appt.patient_name} скасував(ла) запис на ${appt.date} о ${appt.time_from}`
        );
      }
    }
  });

  // Load saved doctor chat ID
  const savedDoctorId = db.prepare("SELECT value FROM settings WHERE key = ?").get("doctor_chat_id");
  if (savedDoctorId) {
    DOCTOR_CHAT_ID = savedDoctorId.value;
  }
} else {
  console.log("No TELEGRAM_BOT_TOKEN set — bot disabled");
}

// ──────────────────────────────────────────────
// CRON: Send reminders at 10:00 every day
// ──────────────────────────────────────────────
cron.schedule("0 10 * * *", () => {
  sendReminders();
}, { timezone: "Europe/Kyiv" });

function sendReminders() {
  if (!bot) return;

  // Get tomorrow's date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0]; // YYYY-MM-DD

  const appointments = db
    .prepare(
      `SELECT a.*, p.name as patient_name, p.telegram_chat_id, p.phone
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       WHERE a.date = ? AND a.reminder_sent = 0 AND a.status != 'cancelled'`
    )
    .all(tomorrowStr);

  for (const appt of appointments) {
    if (appt.telegram_chat_id) {
      const visitInfo = appt.visit_type ? ` на ${appt.visit_type}` : "";
      bot.sendMessage(appt.telegram_chat_id, `Вітаємо, ${appt.patient_name}! 👋\n\nНагадуємо, що завтра о ${appt.time_from} у вас запис${visitInfo}.\n\nПідтвердіть, будь ласка:`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Так, буду", callback_data: `confirm_${appt.id}` },
              { text: "❌ Скасувати", callback_data: `cancel_${appt.id}` },
            ],
          ],
        },
      });

      db.prepare("UPDATE appointments SET reminder_sent = 1 WHERE id = ?").run(appt.id);
      console.log(`Reminder sent to ${appt.patient_name} for ${appt.date} ${appt.time_from}`);
    }
  }

  console.log(`Reminders check done. ${appointments.length} appointments for ${tomorrowStr}`);
}

// ──────────────────────────────────────────────
// EXPRESS API
// ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Patients ---

// Get all patients
app.get("/api/patients", (req, res) => {
  const patients = db.prepare("SELECT * FROM patients ORDER BY name").all();
  res.json(patients);
});

// Search patients by name
app.get("/api/patients/search", (req, res) => {
  const q = req.query.q || "";
  const patients = db
    .prepare("SELECT * FROM patients WHERE name LIKE ? ORDER BY name LIMIT 10")
    .all(`%${q}%`);
  res.json(patients);
});

// Create patient
app.post("/api/patients", (req, res) => {
  const { name, phone } = req.body;
  const result = db
    .prepare("INSERT INTO patients (name, phone) VALUES (?, ?)")
    .run(name, phone || null);
  const patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(result.lastInsertRowid);
  res.json(patient);
});

// Update patient
app.put("/api/patients/:id", (req, res) => {
  const { name, phone } = req.body;
  db.prepare("UPDATE patients SET name = ?, phone = ? WHERE id = ?").run(
    name,
    phone || null,
    req.params.id
  );
  const patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(req.params.id);
  res.json(patient);
});

// --- Appointments ---

// Get appointments for a date
app.get("/api/appointments", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });

  const appts = db
    .prepare(
      `SELECT a.*, p.name as patient_name, p.phone as patient_phone, 
              p.telegram_chat_id as patient_telegram
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       WHERE a.date = ?
       ORDER BY a.time_from`
    )
    .all(date);
  res.json(appts);
});

// Get appointments for a month (for calendar dots)
app.get("/api/appointments/month", (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year and month required" });

  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const days = db
    .prepare(
      `SELECT date, COUNT(*) as count 
       FROM appointments 
       WHERE date LIKE ? 
       GROUP BY date`
    )
    .all(`${prefix}%`);
  res.json(days);
});

// Create appointment
app.post("/api/appointments", (req, res) => {
  const { patient_id, date, time_from, time_to, visit_type, price, comment } = req.body;

  const result = db
    .prepare(
      `INSERT INTO appointments (patient_id, date, time_from, time_to, visit_type, price, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(patient_id, date, time_from, time_to, visit_type || null, price || null, comment || null);

  const appt = db
    .prepare(
      `SELECT a.*, p.name as patient_name, p.phone as patient_phone,
              p.telegram_chat_id as patient_telegram
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       WHERE a.id = ?`
    )
    .get(result.lastInsertRowid);

  res.json(appt);
});

// Update appointment
app.put("/api/appointments/:id", (req, res) => {
  const { date, time_from, time_to, visit_type, price, comment, status } = req.body;

  db.prepare(
    `UPDATE appointments 
     SET date = ?, time_from = ?, time_to = ?, visit_type = ?, price = ?, comment = ?, status = ?,
         reminder_sent = CASE WHEN date != ? THEN 0 ELSE reminder_sent END
     WHERE id = ?`
  ).run(date, time_from, time_to, visit_type || null, price || null, comment || null, status, date, req.params.id);

  const appt = db
    .prepare(
      `SELECT a.*, p.name as patient_name, p.phone as patient_phone,
              p.telegram_chat_id as patient_telegram
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       WHERE a.id = ?`
    )
    .get(req.params.id);

  res.json(appt);
});

// Update appointment status
app.patch("/api/appointments/:id/status", (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

// Delete appointment
app.delete("/api/appointments/:id", (req, res) => {
  db.prepare("DELETE FROM appointments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Patient history ---
app.get("/api/patients/:id/history", (req, res) => {
  const appts = db
    .prepare(
      `SELECT * FROM appointments WHERE patient_id = ? ORDER BY date DESC, time_from DESC`
    )
    .all(req.params.id);
  res.json(appts);
});

// --- Telegram link ---
// Generate QR code for bot link
app.get("/api/telegram/qr", async (req, res) => {
  if (!BOT_TOKEN) return res.status(400).json({ error: "Bot not configured" });

  try {
    const botInfo = await bot.getMe();
    const botLink = `https://t.me/${botInfo.username}`;
    const qrDataUrl = await QRCode.toDataURL(botLink, { width: 400, margin: 2 });
    res.json({ qr: qrDataUrl, link: botLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate patient-specific bot link
app.get("/api/telegram/link/:patientId", async (req, res) => {
  if (!BOT_TOKEN) return res.status(400).json({ error: "Bot not configured" });

  try {
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=${req.params.patientId}`;
    const qrDataUrl = await QRCode.toDataURL(link, { width: 300, margin: 2 });
    res.json({ qr: qrDataUrl, link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Doctor link
app.get("/api/telegram/doctor-link", async (req, res) => {
  if (!BOT_TOKEN) return res.status(400).json({ error: "Bot not configured" });

  try {
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=doctor`;
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual reminder trigger (for testing)
app.post("/api/telegram/send-reminders", (req, res) => {
  sendReminders();
  res.json({ ok: true, message: "Reminders check triggered" });
});

// --- Catch-all: serve frontend ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
