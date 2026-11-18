const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'salon.db');

const VALID_STATUSES = ['Scheduled', 'Confirmed', 'In-Chair', 'Completed', 'Cancelled', 'No-Show'];
const VALID_PAYMENT_MODES = ['UPI', 'Cash', 'Card', 'Split'];
const ACTIVE_BOOKING_STATUSES = ['Scheduled', 'Confirmed', 'In-Chair'];

function getLocalIsoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  return digits.slice(-10);
}

function daysBetweenIso(fromIso, toIso = getLocalIsoDate(0)) {
  if (!fromIso || !/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) return 0;
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);
  const diff = Math.round((to - from) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

function computeTier(visits, totalSpend, daysAgo) {
  if (daysAgo >= 30) return 'At risk';
  if (visits >= 5 || totalSpend >= 10000) return 'VIP';
  if (visits >= 2) return 'Returning';
  return 'New';
}

function computeGstBreakdown(grandTotal, gstRate = 18) {
  const total = Math.max(0, Number(grandTotal) || 0);
  const rate = Math.max(0, Number(gstRate) || 0);
  if (rate === 0) {
    return { taxableValue: total, cgst: 0, sgst: 0, totalTax: 0 };
  }
  const taxableValue = +(total / (1 + rate / 100)).toFixed(2);
  const totalTax = +(total - taxableValue).toFixed(2);
  const cgst = +(totalTax / 2).toFixed(2);
  const sgst = +(totalTax - cgst).toFixed(2);
  return { taxableValue, cgst, sgst, totalTax };
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.code = 'BOOKING_CONFLICT';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_ERROR';
  }
}

class SalonDatabase {
  constructor(dbPath = DB_PATH) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.runMigrations();
    this.seedDefaults();
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  initPragmas() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  withTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {}
      throw err;
    }
  }

  runMigrations() {
    const { user_version: currentVersion } = this.db.prepare('PRAGMA user_version').get();

    // If upgrading from legacy v0 schema (no user_version), rebuild clean normalized v2 tables
    if (currentVersion === 0) {
      const legacyTable = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='appointments'")
        .get();
      if (legacyTable) {
        const cols = this.db.prepare('PRAGMA table_info(appointments)').all().map(c => c.name);
        if (!cols.includes('invoice_no')) {
          this.db.exec(`
            DROP TABLE IF EXISTS appointments;
            DROP TABLE IF EXISTS clients;
            DROP TABLE IF EXISTS services;
            DROP TABLE IF EXISTS stylists;
          `);
        }
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS salon_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'Hair & Grooming',
        price REAL NOT NULL CHECK(price >= 0),
        duration INTEGER DEFAULT 45 CHECK(duration > 0),
        popular INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS stylists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar TEXT,
        phone TEXT DEFAULT '',
        commission_pct REAL DEFAULT 35 CHECK(commission_pct >= 0 AND commission_pct <= 100),
        rating REAL DEFAULT 4.9,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        visits INTEGER DEFAULT 0,
        total_spend REAL DEFAULT 0,
        preferred_stylist TEXT DEFAULT '',
        rating REAL DEFAULT 5.0,
        tier TEXT DEFAULT 'New',
        last_service TEXT DEFAULT '',
        last_visit_at TEXT DEFAULT '',
        formula_notes TEXT DEFAULT '',
        opted_in INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        invoice_no TEXT UNIQUE,
        client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
        client_name TEXT NOT NULL,
        client_phone TEXT NOT NULL,
        stylist_id TEXT REFERENCES stylists(id) ON DELETE SET NULL,
        stylist_name TEXT NOT NULL,
        service_name TEXT NOT NULL,
        services_json TEXT NOT NULL DEFAULT '[]',
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        duration_mins INTEGER DEFAULT 45,
        subtotal REAL NOT NULL DEFAULT 0,
        discount REAL NOT NULL DEFAULT 0,
        price REAL NOT NULL CHECK(price >= 0),
        cgst REAL NOT NULL DEFAULT 0,
        sgst REAL NOT NULL DEFAULT 0,
        payment_mode TEXT DEFAULT 'UPI',
        payment_split_json TEXT DEFAULT '{}',
        status TEXT DEFAULT 'Confirmed',
        rating INTEGER DEFAULT NULL,
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        segment TEXT NOT NULL,
        message TEXT NOT NULL,
        audience_count INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Completed',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(client_phone);
      CREATE INDEX IF NOT EXISTS idx_appointments_stylist_slot ON appointments(stylist_name, date, time);
      CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
      PRAGMA user_version = 2;
    `);
  }

  nextInvoiceNo() {
    const year = new Date().getFullYear();
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM appointments').get();
    let seq = (row?.cnt || 0) + 1001;
    let candidate = `INV-${year}-${seq}`;
    while (this.db.prepare('SELECT 1 FROM appointments WHERE invoice_no = ?').get(candidate)) {
      seq += 1;
      candidate = `INV-${year}-${seq}`;
    }
    return candidate;
  }

  seedDefaults() {
    // 1. Settings
    const settingsCount = this.db.prepare('SELECT COUNT(*) AS c FROM salon_settings').get().c;
    if (settingsCount === 0) {
      const insertSet = this.db.prepare('INSERT INTO salon_settings (key, value) VALUES (?, ?)');
      const defaults = [
        ['salon_name', 'Jawed Salon'],
        ['branch_name', 'MG Road Lounge, Pune'],
        ['gstin', '27AABCS1429B1Z0'],
        ['gst_rate', '18'],
        ['sac_code', '999722'],
        ['opening_cash', '5000'],
        ['owner_pin', '']
      ];
      for (const [k, v] of defaults) insertSet.run(k, v);
    }

    // 2. Services (Single canonical naming across backend & UI)
    const srvCount = this.db.prepare('SELECT COUNT(*) AS c FROM services').get().c;
    if (srvCount === 0) {
      const insertSrv = this.db.prepare(
        'INSERT INTO services (id, name, category, price, duration, popular, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
      );
      const defaultServices = [
        ['srv-1', 'Haircut & Beard Sculpt', 'Hair & Grooming', 650, 45, 1],
        ['srv-2', 'Keratin Silk Smooth', 'Hair Treatment', 3800, 120, 1],
        ['srv-3', 'Moroccan Hair Spa', 'Hair Treatment', 1450, 60, 1],
        ['srv-4', 'Balayage & Global Color', 'Hair Color', 4200, 150, 1],
        ['srv-5', 'Radiance Gold Facial', 'Skin & Spa', 1800, 60, 1],
        ['srv-6', 'Bridal / Groom Makeover', 'Special Occasion', 7500, 180, 0]
      ];
      for (const s of defaultServices) insertSrv.run(...s);
    }

    // 3. Stylists
    const styCount = this.db.prepare('SELECT COUNT(*) AS c FROM stylists').get().c;
    if (styCount === 0) {
      const insertSty = this.db.prepare(
        'INSERT INTO stylists (id, name, role, avatar, phone, commission_pct, rating, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
      );
      const defaultStylists = [
        ['sty-1', 'Amit Sharma', 'Creative Hair Director', 'AS', '9820011101', 35, 4.9],
        ['sty-2', 'Priya Verma', 'Master Colorist & Stylist', 'PV', '9820011102', 35, 4.95],
        ['sty-3', 'Rahul Mehta', 'Beard & Fade Specialist', 'RM', '9820011103', 30, 4.85],
        ['sty-4', 'Sneha Kulkarni', 'Aesthetician & Spa Lead', 'SK', '9820011104', 35, 4.9]
      ];
      for (const st of defaultStylists) insertSty.run(...st);
    }

    // 4. Clients (Canonical 10-digit phones + ISO last_visit_at + formula notes)
    const cliCount = this.db.prepare('SELECT COUNT(*) AS c FROM clients').get().c;
    if (cliCount === 0) {
      const insertCli = this.db.prepare(`
        INSERT INTO clients (id, name, phone, visits, total_spend, preferred_stylist, rating, tier, last_service, last_visit_at, formula_notes, opted_in)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const today = getLocalIsoDate(0);
      const defaultClients = [
        ['cli-1', 'Arjun Malhotra', '9820123456', 8, 6200, 'Amit Sharma', 4.9, 'VIP', 'Haircut & Beard Sculpt', today, 'Mid skin fade #1.5, matte clay finish'],
        ['cli-2', 'Rhea Sen', '9876543210', 5, 16800, 'Priya Verma', 5.0, 'VIP', 'Balayage & Global Color', today, 'Ash blonde 8.1 + Olaplex No.1, sensitive scalp'],
        ['cli-3', 'Vikram Singhania', '9811223344', 11, 14500, 'Sneha Kulkarni', 4.9, 'VIP', 'Moroccan Hair Spa', today, 'Prefers quiet corner chair, warm argan oil'],
        ['cli-4', 'Karan Johar', '9930445566', 2, 1300, 'Rahul Mehta', 4.5, 'Returning', 'Haircut & Beard Sculpt', today, 'Sharp straight-razor beard line'],
        ['cli-5', 'Ananya Roy', '9840556677', 4, 15200, 'Amit Sharma', 4.8, 'VIP', 'Keratin Silk Smooth', today, 'Formaldehyde-free keratin, shoulder length'],
        ['cli-6', 'Devansh Roy', '9871122334', 6, 10800, 'Sneha Kulkarni', 4.9, 'VIP', 'Radiance Gold Facial', today, 'Combination skin, gentle exfoliation'],
        ['cli-7', 'Kavita Rao', '9810044400', 5, 18500, 'Priya Verma', 4.9, 'At risk', 'Balayage & Global Color', getLocalIsoDate(-33), 'Caramel balayage 7.3, likes weekend mornings'],
        ['cli-8', 'Nikhil Jain', '9900055500', 2, 1300, 'Rahul Mehta', 3.8, 'At risk', 'Haircut & Beard Sculpt', getLocalIsoDate(-61), 'Short crop with light scissor trim'],
        ['cli-9', 'Farah Khan', '9870066600', 3, 5400, 'Sneha Kulkarni', 5.0, 'At risk', 'Radiance Gold Facial', getLocalIsoDate(-40), 'Sensitive to heavy fragrance'],
        ['cli-10', 'Kabir Bedi', '9822144556', 3, 2600, 'Rahul Mehta', 4.8, 'Returning', 'Haircut & Beard Sculpt', getLocalIsoDate(-12), 'Classic scissor cut']
      ];
      for (const c of defaultClients) insertCli.run(...c);
    }

    // 5. Appointments (Today + past 13 days for REAL SQL analytics, plus active In-Chair & Scheduled)
    const aptCount = this.db.prepare('SELECT COUNT(*) AS c FROM appointments').get().c;
    if (aptCount === 0) {
      const gstRate = Number(this.getSettings().gst_rate) || 18;
      const insertApt = this.db.prepare(`
        INSERT INTO appointments (
          id, invoice_no, client_id, client_name, client_phone, stylist_id, stylist_name,
          service_name, services_json, date, time, duration_mins, subtotal, discount, price,
          cgst, sgst, payment_mode, payment_split_json, status, rating, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const seedRows = [
        // Today Completed bills
        ['apt-101', 'INV-2026-1001', 'cli-1', 'Arjun Malhotra', '9820123456', 'sty-1', 'Amit Sharma', 'Haircut & Beard Sculpt', [{ id: 'srv-1', name: 'Haircut & Beard Sculpt', price: 650, duration: 45 }], 0, '10:30 AM', 45, 650, 0, 'UPI', {}, 'Completed', 5, 'Textured matte finish'],
        ['apt-102', 'INV-2026-1002', 'cli-2', 'Rhea Sen', '9876543210', 'sty-2', 'Priya Verma', 'Balayage & Global Color', [{ id: 'srv-4', name: 'Balayage & Global Color', price: 4200, duration: 150 }], 0, '11:00 AM', 150, 4200, 200, 'Card', {}, 'Completed', 5, 'VIP 200 loyalty discount'],
        ['apt-103', 'INV-2026-1003', 'cli-3', 'Vikram Singhania', '9811223344', 'sty-4', 'Sneha Kulkarni', 'Moroccan Hair Spa', [{ id: 'srv-3', name: 'Moroccan Hair Spa', price: 1450, duration: 60 }], 0, '12:00 PM', 60, 1450, 0, 'UPI', {}, 'Completed', 5, 'Quiet chair'],
        ['apt-104', 'INV-2026-1004', 'cli-4', 'Karan Johar', '9930445566', 'sty-3', 'Rahul Mehta', 'Haircut & Beard Sculpt', [{ id: 'srv-1', name: 'Haircut & Beard Sculpt', price: 650, duration: 45 }], 0, '01:00 PM', 45, 650, 0, 'Cash', {}, 'Completed', 4, 'Straight razor line'],
        ['apt-105', 'INV-2026-1005', 'cli-5', 'Ananya Roy', '9840556677', 'sty-1', 'Amit Sharma', 'Keratin Silk Smooth', [{ id: 'srv-2', name: 'Keratin Silk Smooth', price: 3800, duration: 120 }], 0, '01:30 PM', 120, 3800, 0, 'Split', { UPI: 2500, Cash: 1300 }, 'Completed', 5, 'Split payment UPI + Cash'],
        ['apt-106', 'INV-2026-1006', 'cli-6', 'Devansh Roy', '9871122334', 'sty-4', 'Sneha Kulkarni', 'Radiance Gold Facial', [{ id: 'srv-5', name: 'Radiance Gold Facial', price: 1800, duration: 60 }], 0, '02:00 PM', 60, 1800, 0, 'UPI', {}, 'Completed', 5, 'Paid via UPI'],

        // Today Live Queue: In-Chair & Scheduled
        ['apt-107', 'INV-2026-1007', 'cli-10', 'Kabir Bedi', '9822144556', 'sty-3', 'Rahul Mehta', 'Haircut & Beard Sculpt', [{ id: 'srv-1', name: 'Haircut & Beard Sculpt', price: 650, duration: 45 }], 0, '03:30 PM', 45, 650, 0, 'UPI', {}, 'In-Chair', null, 'Walk-in regular'],
        ['apt-108', 'INV-2026-1008', 'cli-2', 'Rhea Sen', '9876543210', 'sty-4', 'Sneha Kulkarni', 'Radiance Gold Facial', [{ id: 'srv-5', name: 'Radiance Gold Facial', price: 1800, duration: 60 }], 0, '05:00 PM', 60, 1800, 0, 'UPI', {}, 'Scheduled', null, 'Advance evening booking'],
        ['apt-109', 'INV-2026-1009', 'cli-1', 'Arjun Malhotra', '9820123456', 'sty-1', 'Amit Sharma', 'Moroccan Hair Spa', [{ id: 'srv-3', name: 'Moroccan Hair Spa', price: 1450, duration: 60 }], 0, '06:30 PM', 60, 1450, 0, 'UPI', {}, 'Confirmed', null, 'Confirmed via WhatsApp'],

        // Past 13 days historical completed bills so charts & period toggles are 100% live SQL!
        ['apt-201', 'INV-2026-0988', 'cli-1', 'Arjun Malhotra', '9820123456', 'sty-1', 'Amit Sharma', 'Keratin Silk Smooth', [{ id: 'srv-2', name: 'Keratin Silk Smooth', price: 3800, duration: 120 }], -1, '04:00 PM', 120, 3800, 0, 'UPI', {}, 'Completed', 5, ''],
        ['apt-202', 'INV-2026-0989', 'cli-2', 'Rhea Sen', '9876543210', 'sty-2', 'Priya Verma', 'Balayage & Global Color', [{ id: 'srv-4', name: 'Balayage & Global Color', price: 4200, duration: 150 }], -1, '01:00 PM', 150, 4200, 0, 'Card', {}, 'Completed', 5, ''],
        ['apt-203', 'INV-2026-0990', 'cli-3', 'Vikram Singhania', '9811223344', 'sty-4', 'Sneha Kulkarni', 'Radiance Gold Facial', [{ id: 'srv-5', name: 'Radiance Gold Facial', price: 1800, duration: 60 }], -2, '05:00 PM', 60, 1800, 0, 'UPI', {}, 'Completed', 5, ''],
        ['apt-204', 'INV-2026-0991', 'cli-5', 'Ananya Roy', '9840556677', 'sty-2', 'Priya Verma', 'Bridal / Groom Makeover', [{ id: 'srv-6', name: 'Bridal / Groom Makeover', price: 7500, duration: 180 }], -2, '11:00 AM', 180, 7500, 500, 'Card', {}, 'Completed', 5, 'Engagement trial'],
        ['apt-205', 'INV-2026-0992', 'cli-4', 'Karan Johar', '9930445566', 'sty-3', 'Rahul Mehta', 'Haircut & Beard Sculpt', [{ id: 'srv-1', name: 'Haircut & Beard Sculpt', price: 650, duration: 45 }], -3, '03:00 PM', 45, 650, 0, 'Cash', {}, 'Completed', 4, ''],
        ['apt-206', 'INV-2026-0993', 'cli-6', 'Devansh Roy', '9871122334', 'sty-1', 'Amit Sharma', 'Moroccan Hair Spa', [{ id: 'srv-3', name: 'Moroccan Hair Spa', price: 1450, duration: 60 }], -3, '06:00 PM', 60, 1450, 0, 'UPI', {}, 'Completed', 5, ''],
        ['apt-207', 'INV-2026-0994', 'cli-2', 'Rhea Sen', '9876543210', 'sty-2', 'Priya Verma', 'Keratin Silk Smooth + Moroccan Hair Spa', [{ id: 'srv-2', name: 'Keratin Silk Smooth', price: 3800, duration: 120 }, { id: 'srv-3', name: 'Moroccan Hair Spa', price: 1450, duration: 60 }], -4, '12:00 PM', 180, 5250, 250, 'UPI', {}, 'Completed', 5, ''],
        ['apt-208', 'INV-2026-0995', 'cli-3', 'Vikram Singhania', '9811223344', 'sty-4', 'Sneha Kulkarni', 'Radiance Gold Facial', [{ id: 'srv-5', name: 'Radiance Gold Facial', price: 1800, duration: 60 }], -5, '02:00 PM', 60, 1800, 0, 'Cash', {}, 'Completed', 5, ''],
        ['apt-209', 'INV-2026-0996', 'cli-1', 'Arjun Malhotra', '9820123456', 'sty-3', 'Rahul Mehta', 'Haircut & Beard Sculpt', [{ id: 'srv-1', name: 'Haircut & Beard Sculpt', price: 650, duration: 45 }], -6, '05:30 PM', 45, 650, 0, 'UPI', {}, 'Completed', 5, ''],
        ['apt-210', 'INV-2026-0997', 'cli-5', 'Ananya Roy', '9840556677', 'sty-1', 'Amit Sharma', 'Balayage & Global Color', [{ id: 'srv-4', name: 'Balayage & Global Color', price: 4200, duration: 150 }], -7, '01:00 PM', 150, 4200, 0, 'Card', {}, 'Completed', 5, ''],
        ['apt-211', 'INV-2026-0998', 'cli-6', 'Devansh Roy', '9871122334', 'sty-4', 'Sneha Kulkarni', 'Moroccan Hair Spa', [{ id: 'srv-3', name: 'Moroccan Hair Spa', price: 1450, duration: 60 }], -9, '04:00 PM', 60, 1450, 0, 'UPI', {}, 'Completed', 5, ''],
        ['apt-212', 'INV-2026-0999', 'cli-10', 'Kabir Bedi', '9822144556', 'sty-3', 'Rahul Mehta', 'Haircut & Beard Sculpt', [{ id: 'srv-1', name: 'Haircut & Beard Sculpt', price: 650, duration: 45 }], -11, '11:30 AM', 45, 650, 0, 'Cash', {}, 'Completed', 5, ''],
        ['apt-213', 'INV-2026-1000', 'cli-2', 'Rhea Sen', '9876543210', 'sty-2', 'Priya Verma', 'Bridal / Groom Makeover', [{ id: 'srv-6', name: 'Bridal / Groom Makeover', price: 7500, duration: 180 }], -12, '10:00 AM', 180, 7500, 0, 'UPI', {}, 'Completed', 5, '']
      ];

      for (const r of seedRows) {
        const [
          id, inv, cliId, cliName, cliPhone, styId, styName,
          srvName, srvList, dayOffset, time, dur, sub, disc, payMode, split, status, rating, notes
        ] = r;
        const price = Math.max(0, sub - disc);
        const gst = computeGstBreakdown(price, gstRate);
        insertApt.run(
          id, inv, cliId, cliName, cliPhone, styId, styName,
          srvName, JSON.stringify(srvList), getLocalIsoDate(dayOffset), time, dur,
          sub, disc, price, gst.cgst, gst.sgst, payMode, JSON.stringify(split), status, rating, notes
        );
      }
    }

    // 6. Seed Campaigns Log
    const campCount = this.db.prepare('SELECT COUNT(*) AS c FROM campaigns').get().c;
    if (campCount === 0) {
      const insertCamp = this.db.prepare(
        'INSERT INTO campaigns (id, name, segment, message, audience_count, sent_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      insertCamp.run(
        'cmp-1',
        'Win-Back VIP 20% Offer',
        'At risk',
        'Hi {name}, we miss you at Jawed Salon! Enjoy 20% off your Hair Spa or Color treatment this week.',
        3,
        3,
        'Completed'
      );
      insertCamp.run(
        'cmp-2',
        'Weekend Glow Combo',
        'VIP',
        'Hi {name}, exclusive VIP perk: complimentary Moroccan scalp massage with any service this weekend.',
        5,
        5,
        'Completed'
      );
    }
  }

  // ===================== SETTINGS =====================
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM salon_settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  updateSettings(updates) {
    const allowed = ['salon_name', 'branch_name', 'gstin', 'gst_rate', 'sac_code', 'opening_cash', 'owner_pin'];
    const stmt = this.db.prepare('INSERT INTO salon_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.withTransaction(() => {
      for (const k of allowed) {
        if (updates[k] !== undefined) {
          stmt.run(k, String(updates[k]).trim());
        }
      }
    });
    return this.getSettings();
  }

  // ===================== SERVICES CRUD =====================
  getServices(includeInactive = false) {
    if (includeInactive) {
      return this.db.prepare('SELECT * FROM services ORDER BY active DESC, popular DESC, price ASC').all();
    }
    return this.db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY popular DESC, price ASC').all();
  }

  createService(payload) {
    const name = String(payload.name || '').trim();
    const price = Number(payload.price);
    const duration = Number(payload.duration || 45);
    if (!name) throw new ValidationError('Service name is required');
    if (!Number.isFinite(price) || price < 0) throw new ValidationError('Valid non-negative price is required');
    if (!Number.isFinite(duration) || duration <= 0) throw new ValidationError('Valid duration in minutes is required');

    const id = 'srv-' + crypto.randomUUID().slice(0, 8);
    this.db.prepare(
      'INSERT INTO services (id, name, category, price, duration, popular, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).run(id, name, String(payload.category || 'Hair & Grooming').trim(), price, Math.round(duration), payload.popular ? 1 : 0);

    return this.db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  }

  updateService(id, updates) {
    const existing = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    if (!existing) return null;
    const allowed = ['name', 'category', 'price', 'duration', 'popular', 'active'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        if (k === 'price' && (!Number.isFinite(Number(updates[k])) || Number(updates[k]) < 0)) {
          throw new ValidationError('Price must be non-negative');
        }
        if (k === 'duration' && (!Number.isFinite(Number(updates[k])) || Number(updates[k]) <= 0)) {
          throw new ValidationError('Duration must be positive');
        }
        sets.push(`${k} = ?`);
        vals.push(k === 'popular' || k === 'active' ? (updates[k] ? 1 : 0) : updates[k]);
      }
    }
    if (sets.length > 0) {
      vals.push(id);
      this.db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return this.db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  }

  deleteService(id) {
    const res = this.db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
    return res.changes > 0;
  }

  // ===================== STYLISTS CRUD & PERFORMANCE =====================
  getStylists(period = 'month') {
    const stylists = this.db.prepare('SELECT * FROM stylists WHERE active = 1 ORDER BY rating DESC, name ASC').all();
    const today = getLocalIsoDate(0);
    const startDate = period === 'today' ? today : period === 'week' ? getLocalIsoDate(-6) : getLocalIsoDate(-29);

    const apts = this.db.prepare(
      "SELECT * FROM appointments WHERE status = 'Completed' AND date >= ? AND date <= ?"
    ).all(startDate, today);

    const last7Dates = [];
    for (let i = -6; i <= 0; i++) last7Dates.push(getLocalIsoDate(i));

    return stylists.map(st => {
      const mine = apts.filter(a => a.stylist_id === st.id || a.stylist_name === st.name);
      const revenue = mine.reduce((s, a) => s + Number(a.price || 0), 0);
      const clientsServed = mine.length;
      const avgTicket = clientsServed ? Math.round(revenue / clientsServed) : 0;
      const rated = mine.filter(a => a.rating != null);
      const liveRating = rated.length
        ? +(rated.reduce((s, a) => s + Number(a.rating), 0) / rated.length).toFixed(2)
        : st.rating;
      const commissionEarned = Math.round(revenue * (Number(st.commission_pct || 35) / 100));

      // Repeat client ratio for this stylist
      const uniquePhones = [...new Set(mine.map(a => a.client_phone))];
      let repeatCount = 0;
      if (uniquePhones.length > 0) {
        const placeholders = uniquePhones.map(() => '?').join(',');
        const repeatRows = this.db.prepare(
          `SELECT COUNT(*) AS c FROM clients WHERE phone IN (${placeholders}) AND visits > 1`
        ).get(...uniquePhones);
        repeatCount = repeatRows?.c || 0;
      }
      const retentionPct = uniquePhones.length ? Math.round((repeatCount / uniquePhones.length) * 100) : 0;

      const weeklyCounts = last7Dates.map(d =>
        apts.filter(a => (a.stylist_id === st.id || a.stylist_name === st.name) && a.date === d).length
      );

      return {
        ...st,
        period,
        clients_served: clientsServed,
        revenue,
        avg_ticket: avgTicket,
        commission_earned: commissionEarned,
        retention_pct: retentionPct,
        live_rating: liveRating,
        weekly_counts: weeklyCounts
      };
    }).sort((a, b) => b.revenue - a.revenue);
  }

  createStylist(payload) {
    const name = String(payload.name || '').trim();
    const role = String(payload.role || '').trim();
    if (!name) throw new ValidationError('Stylist name is required');
    if (!role) throw new ValidationError('Stylist role is required');
    const comm = Number(payload.commission_pct ?? 35);
    if (!Number.isFinite(comm) || comm < 0 || comm > 100) {
      throw new ValidationError('Commission percentage must be between 0 and 100');
    }
    const id = 'sty-' + crypto.randomUUID().slice(0, 8);
    const avatar = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    this.db.prepare(
      'INSERT INTO stylists (id, name, role, avatar, phone, commission_pct, rating, active) VALUES (?, ?, ?, ?, ?, ?, 4.9, 1)'
    ).run(id, name, role, avatar, normalizePhone(payload.phone || ''), comm);
    return this.db.prepare('SELECT * FROM stylists WHERE id = ?').get(id);
  }

  updateStylist(id, updates) {
    const existing = this.db.prepare('SELECT * FROM stylists WHERE id = ?').get(id);
    if (!existing) return null;
    const allowed = ['name', 'role', 'phone', 'commission_pct', 'active'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(k === 'phone' ? normalizePhone(updates[k]) : k === 'active' ? (updates[k] ? 1 : 0) : updates[k]);
      }
    }
    if (sets.length > 0) {
      vals.push(id);
      this.db.prepare(`UPDATE stylists SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return this.db.prepare('SELECT * FROM stylists WHERE id = ?').get(id);
  }

  // ===================== CLIENTS =====================
  hydrateClientRow(c) {
    const daysAgo = c.last_visit_at ? daysBetweenIso(c.last_visit_at) : 0;
    const tier = computeTier(c.visits, c.total_spend, daysAgo);
    return {
      ...c,
      days_ago: daysAgo,
      tier
    };
  }

  getClients(filters = {}) {
    const rows = this.db.prepare('SELECT * FROM clients ORDER BY last_visit_at DESC, visits DESC').all();
    let list = rows.map(r => this.hydrateClientRow(r));
    if (filters.search) {
      const q = String(filters.search).trim().toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (qDigits && c.phone.includes(qDigits))
      );
    }
    if (filters.tier && filters.tier !== 'All') {
      list = list.filter(c => c.tier === filters.tier);
    }
    return list;
  }

  getClientById(id) {
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!row) return null;
    const client = this.hydrateClientRow(row);
    const history = this.db.prepare(
      'SELECT * FROM appointments WHERE client_id = ? OR client_phone = ? ORDER BY date DESC, created_at DESC'
    ).all(client.id, client.phone);
    return { ...client, history };
  }

  getClientByPhone(phone) {
    const norm = normalizePhone(phone);
    if (!norm) return null;
    const row = this.db.prepare('SELECT * FROM clients WHERE phone = ?').get(norm);
    return row ? this.hydrateClientRow(row) : null;
  }

  updateClient(id, updates) {
    const existing = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!existing) return null;
    const allowed = ['name', 'preferred_stylist', 'formula_notes', 'opted_in'];
    const sets = ['updated_at = CURRENT_TIMESTAMP'];
    const vals = [];
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(k === 'opted_in' ? (updates[k] ? 1 : 0) : String(updates[k]).trim());
      }
    }
    vals.push(id);
    this.db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getClientById(id);
  }

  upsertClientRecord({ name, phone, preferredStylist, serviceName, amount, date, creditVisit, rating }) {
    const normPhone = normalizePhone(phone);
    const existing = this.db.prepare('SELECT * FROM clients WHERE phone = ?').get(normPhone);
    if (existing) {
      if (creditVisit) {
        const nextVisits = existing.visits + 1;
        const nextSpend = existing.total_spend + amount;
        const lastVisitAt = !existing.last_visit_at || date >= existing.last_visit_at ? date : existing.last_visit_at;
        const nextRating = rating != null
          ? +(((existing.rating * existing.visits) + Number(rating)) / Math.max(nextVisits, 1)).toFixed(2)
          : existing.rating;
        const tier = computeTier(nextVisits, nextSpend, daysBetweenIso(lastVisitAt));
        this.db.prepare(`
          UPDATE clients
          SET name = ?, visits = ?, total_spend = ?, preferred_stylist = ?, rating = ?,
              tier = ?, last_service = ?, last_visit_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(name || existing.name, nextVisits, nextSpend, preferredStylist || existing.preferred_stylist, nextRating, tier, serviceName || existing.last_service, lastVisitAt, existing.id);
      }
      return existing.id;
    }

    const newId = 'cli-' + crypto.randomUUID().slice(0, 8);
    const visits = creditVisit ? 1 : 0;
    const spend = creditVisit ? amount : 0;
    const lastVisitAt = creditVisit ? date : '';
    const tier = creditVisit ? 'New' : 'New';
    this.db.prepare(`
      INSERT INTO clients (id, name, phone, visits, total_spend, preferred_stylist, rating, tier, last_service, last_visit_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId, name, normPhone, visits, spend, preferredStylist || '', rating || 5.0, tier, serviceName || '', lastVisitAt);
    return newId;
  }

  // ===================== APPOINTMENTS =====================
  getAppointments(filters = {}) {
    let sql = 'SELECT * FROM appointments WHERE 1=1';
    const params = [];
    if (filters.date) {
      sql += ' AND date = ?';
      params.push(filters.date);
    }
    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.search) {
      const q = `%${String(filters.search).trim()}%`;
      sql += ' AND (client_name LIKE ? OR client_phone LIKE ? OR invoice_no LIKE ?)';
      params.push(q, q, q);
    }
    sql += ' ORDER BY date DESC, created_at DESC';
    return this.db.prepare(sql).all(...params);
  }

  getAppointmentById(id) {
    return this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  }

  checkStylistConflict(stylistName, date, time, excludeId = null) {
    let sql = `
      SELECT id, client_name, time FROM appointments
      WHERE stylist_name = ? AND date = ? AND time = ?
      AND status IN ('Scheduled', 'Confirmed', 'In-Chair')
    `;
    const params = [stylistName, date, time];
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    return this.db.prepare(sql).get(...params);
  }

  resolveServicesList(payload) {
    const allServices = this.db.prepare('SELECT * FROM services').all();
    const byName = new Map(allServices.map(s => [s.name.toLowerCase(), s]));
    const byId = new Map(allServices.map(s => [s.id, s]));

    if (Array.isArray(payload.services) && payload.services.length > 0) {
      return payload.services.map(item => {
        const found = (item.id && byId.get(item.id)) || byName.get(String(item.name || item).toLowerCase());
        if (found) {
          return { id: found.id, name: found.name, price: Number(item.price ?? found.price), duration: found.duration };
        }
        return {
          id: null,
          name: String(item.name || item).trim(),
          price: Number(item.price ?? 650),
          duration: Number(item.duration ?? 45)
        };
      });
    }

    const rawName = String(payload.service_name || payload.serviceName || 'Haircut & Beard Sculpt').trim();
    const parts = rawName.split(' + ').map(p => p.trim()).filter(Boolean);
    return parts.map(part => {
      const found = byName.get(part.toLowerCase());
      if (found) return { id: found.id, name: found.name, price: found.price, duration: found.duration };
      return { id: null, name: part, price: parts.length === 1 && payload.price != null ? Number(payload.price) : 650, duration: 45 };
    });
  }

  createAppointment(payload) {
    const clientName = String(payload.client_name || payload.clientName || '').trim();
    const rawPhone = payload.client_phone || payload.clientPhone || '';
    const clientPhone = normalizePhone(rawPhone);
    if (!clientName) throw new ValidationError('Client name is required');
    if (clientPhone.length !== 10) throw new ValidationError('A valid 10-digit mobile number is required');

    const status = payload.status || 'Confirmed';
    if (!VALID_STATUSES.includes(status)) {
      throw new ValidationError(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const paymentMode = payload.payment_mode || payload.paymentMode || 'UPI';
    if (!VALID_PAYMENT_MODES.includes(paymentMode)) {
      throw new ValidationError(`Invalid payment mode. Must be one of: ${VALID_PAYMENT_MODES.join(', ')}`);
    }

    const rawDate = payload.date || getLocalIsoDate(0);
    const date = rawDate === 'Today' ? getLocalIsoDate(0) : rawDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError('Date must be in YYYY-MM-DD format');
    }

    const time = String(payload.time || new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })).trim();
    const stylistName = String(payload.stylist_name || payload.stylist || 'Amit Sharma').trim();
    const stylistRow = this.db.prepare('SELECT id, name FROM stylists WHERE name = ?').get(stylistName);

    // Double-booking prevention for active scheduled/confirmed slots
    if (ACTIVE_BOOKING_STATUSES.includes(status) && !payload.force) {
      const conflict = this.checkStylistConflict(stylistName, date, time);
      if (conflict) {
        throw new ConflictError(`${stylistName} already has an appointment with ${conflict.client_name} at ${time} on ${date}`);
      }
    }

    const servicesList = this.resolveServicesList(payload);
    const computedSubtotal = servicesList.reduce((sum, s) => sum + Number(s.price || 0), 0);
    const subtotal = payload.subtotal != null ? Number(payload.subtotal) : (payload.price != null && !payload.discount ? Number(payload.price) : computedSubtotal);
    const discount = Math.max(0, Number(payload.discount || 0));
    if (!Number.isFinite(subtotal) || subtotal < 0) throw new ValidationError('Subtotal must be a non-negative number');
    if (discount > subtotal) throw new ValidationError('Discount cannot exceed subtotal');

    const price = +(subtotal - discount).toFixed(2);
    const durationMins = servicesList.reduce((sum, s) => sum + Number(s.duration || 45), 0);
    const serviceSummary = servicesList.map(s => s.name).join(' + ');

    let paymentSplit = {};
    if (paymentMode === 'Split' && payload.payment_split && typeof payload.payment_split === 'object') {
      paymentSplit = payload.payment_split;
      const splitSum = Object.values(paymentSplit).reduce((s, v) => s + Number(v || 0), 0);
      if (Math.abs(splitSum - price) > 1) {
        throw new ValidationError(`Split payment amounts (₹${splitSum}) must equal grand total (₹${price})`);
      }
    }

    const rating = payload.rating != null ? Math.min(5, Math.max(1, Number(payload.rating))) : null;
    const gstRate = Number(this.getSettings().gst_rate) || 18;
    const gst = computeGstBreakdown(price, gstRate);

    const id = 'apt-' + crypto.randomUUID().slice(0, 8);
    const invoiceNo = this.nextInvoiceNo();

    return this.withTransaction(() => {
      const clientId = this.upsertClientRecord({
        name: clientName,
        phone: clientPhone,
        preferredStylist: stylistName,
        serviceName: serviceSummary,
        amount: price,
        date,
        creditVisit: status === 'Completed',
        rating
      });

      this.db.prepare(`
        INSERT INTO appointments (
          id, invoice_no, client_id, client_name, client_phone, stylist_id, stylist_name,
          service_name, services_json, date, time, duration_mins, subtotal, discount, price,
          cgst, sgst, payment_mode, payment_split_json, status, rating, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, invoiceNo, clientId, clientName, clientPhone, stylistRow?.id || null, stylistName,
        serviceSummary, JSON.stringify(servicesList), date, time, durationMins,
        subtotal, discount, price, gst.cgst, gst.sgst, paymentMode, JSON.stringify(paymentSplit),
        status, rating, String(payload.notes || '').trim()
      );

      return this.getAppointmentById(id);
    });
  }

  updateAppointment(id, updates) {
    const existing = this.getAppointmentById(id);
    if (!existing) return null;

    const nextStatus = updates.status ?? existing.status;
    if (!VALID_STATUSES.includes(nextStatus)) {
      throw new ValidationError(`Invalid status: ${nextStatus}`);
    }
    const nextPaymentMode = updates.payment_mode ?? existing.payment_mode;
    if (!VALID_PAYMENT_MODES.includes(nextPaymentMode)) {
      throw new ValidationError(`Invalid payment mode: ${nextPaymentMode}`);
    }

    const nextDate = updates.date === 'Today' ? getLocalIsoDate(0) : (updates.date ?? existing.date);
    const nextTime = updates.time ?? existing.time;
    const nextStylist = updates.stylist_name ?? existing.stylist_name;

    if (ACTIVE_BOOKING_STATUSES.includes(nextStatus) && !updates.force) {
      const slotChanged = nextDate !== existing.date || nextTime !== existing.time || nextStylist !== existing.stylist_name || !ACTIVE_BOOKING_STATUSES.includes(existing.status);
      if (slotChanged) {
        const conflict = this.checkStylistConflict(nextStylist, nextDate, nextTime, id);
        if (conflict) {
          throw new ConflictError(`${nextStylist} already has an appointment with ${conflict.client_name} at ${nextTime} on ${nextDate}`);
        }
      }
    }

    const nextSubtotal = updates.subtotal != null ? Number(updates.subtotal) : existing.subtotal;
    const nextDiscount = updates.discount != null ? Number(updates.discount) : existing.discount;
    const nextPrice = updates.price != null ? Number(updates.price) : Math.max(0, nextSubtotal - nextDiscount);
    if (!Number.isFinite(nextPrice) || nextPrice < 0) throw new ValidationError('Price must be non-negative');

    const gstRate = Number(this.getSettings().gst_rate) || 18;
    const gst = computeGstBreakdown(nextPrice, gstRate);
    const nextSplit = updates.payment_split ? JSON.stringify(updates.payment_split) : existing.payment_split_json;
    const nextNotes = updates.notes !== undefined ? String(updates.notes).trim() : existing.notes;
    const nextRating = updates.rating !== undefined ? (updates.rating == null ? null : Math.min(5, Math.max(1, Number(updates.rating)))) : existing.rating;
    const stylistRow = this.db.prepare('SELECT id FROM stylists WHERE name = ?').get(nextStylist);

    return this.withTransaction(() => {
      this.db.prepare(`
        UPDATE appointments
        SET status = ?, payment_mode = ?, payment_split_json = ?, notes = ?,
            subtotal = ?, discount = ?, price = ?, cgst = ?, sgst = ?,
            stylist_id = ?, stylist_name = ?, date = ?, time = ?, rating = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        nextStatus, nextPaymentMode, nextSplit, nextNotes,
        nextSubtotal, nextDiscount, nextPrice, gst.cgst, gst.sgst,
        stylistRow?.id || existing.stylist_id, nextStylist, nextDate, nextTime, nextRating, id
      );

      // Reconcile client visit/spend if transitioning into or out of Completed
      if (existing.status !== 'Completed' && nextStatus === 'Completed') {
        this.upsertClientRecord({
          name: existing.client_name,
          phone: existing.client_phone,
          preferredStylist: nextStylist,
          serviceName: existing.service_name,
          amount: nextPrice,
          date: nextDate,
          creditVisit: true,
          rating: nextRating
        });
      } else if (existing.status === 'Completed' && nextStatus !== 'Completed') {
        this.db.prepare(`
          UPDATE clients
          SET visits = MAX(0, visits - 1), total_spend = MAX(0, total_spend - ?), updated_at = CURRENT_TIMESTAMP
          WHERE phone = ?
        `).run(existing.price, existing.client_phone);
      }

      return this.getAppointmentById(id);
    });
  }

  deleteAppointment(id) {
    const existing = this.getAppointmentById(id);
    if (!existing) return false;
    return this.withTransaction(() => {
      if (existing.status === 'Completed') {
        this.db.prepare(`
          UPDATE clients
          SET visits = MAX(0, visits - 1), total_spend = MAX(0, total_spend - ?), updated_at = CURRENT_TIMESTAMP
          WHERE phone = ?
        `).run(existing.price, existing.client_phone);
      }
      const res = this.db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
      return res.changes > 0;
    });
  }

  // ===================== CAMPAIGNS =====================
  getCampaigns() {
    return this.db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  }

  createCampaign(payload) {
    const name = String(payload.name || '').trim();
    const segment = String(payload.segment || 'At risk').trim();
    const message = String(payload.message || '').trim();
    if (!name) throw new ValidationError('Campaign name is required');
    if (!message) throw new ValidationError('Campaign message is required');

    const allClients = this.getClients().filter(c => c.opted_in);
    const recipients = segment === 'All' ? allClients : allClients.filter(c => c.tier === segment);

    const id = 'cmp-' + crypto.randomUUID().slice(0, 8);
    this.db.prepare(
      'INSERT INTO campaigns (id, name, segment, message, audience_count, sent_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, segment, message, recipients.length, Number(payload.sent_count || 0), payload.status || 'Queued');

    const created = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    return { campaign: created, recipients };
  }

  markCampaignSent(id, sentCount) {
    const existing = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    if (!existing) return null;
    const nextSent = Number(sentCount ?? existing.sent_count + 1);
    const status = nextSent >= existing.audience_count ? 'Completed' : 'In Progress';
    this.db.prepare('UPDATE campaigns SET sent_count = ?, status = ? WHERE id = ?').run(nextSent, status, id);
    return this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  }

  // ===================== LIVE ANALYTICS & REPORTS =====================
  computePaymentSplit(completedRows) {
    const totals = { UPI: 0, Card: 0, Cash: 0 };
    for (const a of completedRows) {
      if (a.payment_mode === 'Split') {
        try {
          const split = JSON.parse(a.payment_split_json || '{}');
          for (const [k, v] of Object.entries(split)) {
            if (totals[k] !== undefined) totals[k] += Number(v || 0);
          }
        } catch (_) {
          totals.UPI += Number(a.price || 0);
        }
      } else if (totals[a.payment_mode] !== undefined) {
        totals[a.payment_mode] += Number(a.price || 0);
      } else {
        totals.UPI += Number(a.price || 0);
      }
    }
    return totals;
  }

  getMetrics() {
    const today = getLocalIsoDate(0);
    const rows = this.db.prepare('SELECT * FROM appointments WHERE date = ?').all(today);
    const completed = rows.filter(a => a.status === 'Completed');
    const totalRevenue = completed.reduce((s, a) => s + Number(a.price || 0), 0);
    const projectedRevenue = rows
      .filter(a => a.status !== 'Cancelled' && a.status !== 'No-Show')
      .reduce((s, a) => s + Number(a.price || 0), 0);

    return {
      date: today,
      totalRevenue,
      projectedRevenue,
      totalCount: rows.length,
      inChair: rows.filter(a => a.status === 'In-Chair').length,
      completed: completed.length,
      confirmed: rows.filter(a => a.status === 'Confirmed' || a.status === 'Scheduled').length,
      currency: '₹',
      dbEngine: 'SQLite (node:sqlite Native WAL)'
    };
  }

  getDashboard() {
    const today = getLocalIsoDate(0);
    const lastWeekSameDay = getLocalIsoDate(-7);

    const todayRows = this.db.prepare('SELECT * FROM appointments WHERE date = ? ORDER BY created_at DESC').all(today);
    const completedToday = todayRows.filter(a => a.status === 'Completed');
    const activeQueue = todayRows.filter(a => ACTIVE_BOOKING_STATUSES.includes(a.status));
    const upcomingFuture = this.db.prepare(
      "SELECT * FROM appointments WHERE date > ? AND status IN ('Scheduled', 'Confirmed') ORDER BY date ASC, time ASC LIMIT 12"
    ).all(today);

    const todayRevenue = completedToday.reduce((s, a) => s + Number(a.price || 0), 0);
    const lastWeekRow = this.db.prepare(
      "SELECT COALESCE(SUM(price), 0) AS rev FROM appointments WHERE date = ? AND status = 'Completed'"
    ).get(lastWeekSameDay);
    const lastWeekRevenue = Number(lastWeekRow?.rev || 0);
    const deltaPct = lastWeekRevenue > 0
      ? Math.round(((todayRevenue - lastWeekRevenue) / lastWeekRevenue) * 100)
      : null;

    // Last 7 days bar series
    const weekSeries = [];
    for (let i = -6; i <= 0; i++) {
      const iso = getLocalIsoDate(i);
      const label = i === 0 ? 'Today' : new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' });
      const r = this.db.prepare(
        "SELECT COALESCE(SUM(price), 0) AS rev, COUNT(*) AS cnt FROM appointments WHERE date = ? AND status = 'Completed'"
      ).get(iso);
      weekSeries.push({ date: iso, label, revenue: Number(r.rev || 0), count: r.cnt || 0 });
    }

    const paymentSplit = this.computePaymentSplit(completedToday);
    const rated = completedToday.filter(a => a.rating != null);
    const avgRating = rated.length
      ? +(rated.reduce((s, a) => s + Number(a.rating), 0) / rated.length).toFixed(1)
      : null;

    const allClients = this.getClients();
    const clientPhoneVisits = new Map(allClients.map(c => [c.phone, c.visits]));
    const returningToday = completedToday.filter(a => (clientPhoneVisits.get(a.client_phone) || 0) > 1).length;
    const lapsedClients = allClients.filter(c => c.days_ago >= 30);

    const stylistPerf = this.getStylists('today');
    const settings = this.getSettings();

    return {
      date: today,
      settings,
      todayRevenue,
      lastWeekRevenue,
      deltaPct,
      completedCount: completedToday.length,
      avgTicket: completedToday.length ? Math.round(todayRevenue / completedToday.length) : 0,
      returningToday,
      avgRating,
      paymentSplit,
      weekSeries,
      stylistPerf,
      completedToday,
      activeQueue,
      upcomingFuture,
      lapsedClients
    };
  }

  getReports(period = 'month') {
    const today = getLocalIsoDate(0);
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const startDate = getLocalIsoDate(-(days - 1));
    const prevStart = getLocalIsoDate(-(days * 2 - 1));
    const prevEnd = getLocalIsoDate(-days);

    const currentRows = this.db.prepare(
      "SELECT * FROM appointments WHERE status = 'Completed' AND date >= ? AND date <= ? ORDER BY date ASC"
    ).all(startDate, today);
    const prevRows = this.db.prepare(
      "SELECT * FROM appointments WHERE status = 'Completed' AND date >= ? AND date <= ?"
    ).all(prevStart, prevEnd);

    const totalRevenue = currentRows.reduce((s, a) => s + Number(a.price || 0), 0);
    const prevRevenue = prevRows.reduce((s, a) => s + Number(a.price || 0), 0);
    const revenueDeltaPct = prevRevenue > 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : null;

    const footfall = currentRows.length;
    const avgTicket = footfall ? Math.round(totalRevenue / footfall) : 0;
    const totalGst = +(currentRows.reduce((s, a) => s + Number(a.cgst || 0) + Number(a.sgst || 0), 0)).toFixed(2);
    const totalDiscount = +(currentRows.reduce((s, a) => s + Number(a.discount || 0), 0)).toFixed(2);

    const allClients = this.getClients();
    const repeatClients = allClients.filter(c => c.visits > 1).length;
    const retentionPct = allClients.length ? Math.round((repeatClients / allClients.length) * 100) : 0;

    // Daily series (up to 14 days for clean visual chart)
    const chartDays = Math.min(days, 14);
    const dailySeries = [];
    for (let i = -(chartDays - 1); i <= 0; i++) {
      const iso = getLocalIsoDate(i);
      const dayRows = currentRows.filter(a => a.date === iso);
      const rev = dayRows.reduce((s, a) => s + Number(a.price || 0), 0);
      const dt = new Date(`${iso}T00:00:00`);
      dailySeries.push({
        date: iso,
        label: i === 0 ? 'Today' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        shortLabel: i === 0 ? 'Today' : String(dt.getDate()),
        revenue: rev,
        count: dayRows.length
      });
    }

    const paymentSplit = this.computePaymentSplit(currentRows);
    const settings = this.getSettings();
    const openingCash = Number(settings.opening_cash || 0);

    // Top services mix
    const srvMap = new Map();
    for (const a of currentRows) {
      let items = [];
      try { items = JSON.parse(a.services_json || '[]'); } catch (_) {}
      if (!items.length) items = [{ name: a.service_name, price: a.price }];
      for (const it of items) {
        const cur = srvMap.get(it.name) || { name: it.name, count: 0, revenue: 0 };
        cur.count += 1;
        cur.revenue += Number(it.price || 0);
        srvMap.set(it.name, cur);
      }
    }
    const serviceMix = [...srvMap.values()].sort((a, b) => b.revenue - a.revenue);

    return {
      period,
      startDate,
      endDate: today,
      totalRevenue,
      prevRevenue,
      revenueDeltaPct,
      footfall,
      avgTicket,
      retentionPct,
      totalGst,
      totalDiscount,
      paymentSplit,
      openingCash,
      expectedDrawerCash: openingCash + paymentSplit.Cash,
      dailySeries,
      serviceMix
    };
  }

  exportGstCsv(period = 'month') {
    const today = getLocalIsoDate(0);
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const startDate = getLocalIsoDate(-(days - 1));
    const settings = this.getSettings();
    const sacCode = settings.sac_code || '999722';

    const rows = this.db.prepare(
      "SELECT * FROM appointments WHERE status = 'Completed' AND date >= ? AND date <= ? ORDER BY date ASC, invoice_no ASC"
    ).all(startDate, today);

    const header = [
      'Invoice No', 'Date', 'Client Name', 'Client Phone', 'Services',
      'SAC Code', 'Stylist', 'Subtotal (INR)', 'Discount (INR)',
      'Taxable Value (INR)', 'CGST (INR)', 'SGST (INR)', 'Grand Total (INR)',
      'Payment Mode', 'Status'
    ];
    const lines = [header.map(csvEscape).join(',')];

    for (const r of rows) {
      const taxable = +(Number(r.price) - Number(r.cgst) - Number(r.sgst)).toFixed(2);
      lines.push([
        r.invoice_no, r.date, r.client_name, r.client_phone, r.service_name,
        sacCode, r.stylist_name, r.subtotal, r.discount,
        taxable, r.cgst, r.sgst, r.price, r.payment_mode, r.status
      ].map(csvEscape).join(','));
    }
    return lines.join('\r\n');
  }

  reset() {
    this.withTransaction(() => {
      this.db.exec(`
        DELETE FROM appointments;
        DELETE FROM campaigns;
        DELETE FROM clients;
        DELETE FROM services;
        DELETE FROM stylists;
        DELETE FROM salon_settings;
      `);
    });
    this.seedDefaults();
    return { success: true, message: 'Database reset and re-seeded cleanly' };
  }
}

module.exports = {
  SalonDatabase,
  DB_PATH,
  ConflictError,
  ValidationError,
  normalizePhone,
  getLocalIsoDate,
  computeGstBreakdown
};
