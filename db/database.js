const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'salon.db');

class SalonDatabase {
  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.runMigrations();
    this.seedDefaults();
  }

  initPragmas() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
  }

  runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        price REAL NOT NULL,
        duration INTEGER DEFAULT 60,
        popular INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS stylists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        avatar TEXT,
        rating REAL DEFAULT 4.9,
        completed_today INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        visits INTEGER DEFAULT 1,
        total_spend REAL DEFAULT 0,
        preferred_stylist TEXT,
        rating REAL DEFAULT 5.0,
        tier TEXT DEFAULT 'New',
        last_service TEXT,
        days_ago INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        client_phone TEXT NOT NULL,
        service_name TEXT NOT NULL,
        stylist_name TEXT NOT NULL,
        time TEXT NOT NULL,
        date TEXT NOT NULL,
        price REAL NOT NULL,
        payment_mode TEXT DEFAULT 'UPI',
        status TEXT DEFAULT 'Confirmed',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
      CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(client_phone);
      CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
    `);
  }

  seedDefaults() {
    const srvCount = this.db.prepare('SELECT COUNT(*) as count FROM services').get().count;
    if (srvCount === 0) {
      const insertSrv = this.db.prepare('INSERT INTO services (id, name, category, price, duration, popular) VALUES (?, ?, ?, ?, ?, ?)');
      const defaultServices = [
        ['srv-1', 'Signature Haircut & Beard Sculpt', 'Hair & Grooming', 650, 45, 1],
        ['srv-2', 'Keratin Silk Smooth Treatment', 'Hair Treatment', 3800, 120, 1],
        ['srv-3', 'Moroccan Hair Spa & Scalp Detox', 'Hair Treatment', 1450, 60, 1],
        ['srv-4', 'Balayage & Global Color', 'Hair Color', 4200, 150, 0],
        ['srv-5', 'Radiance Gold Facial & De-Tan', 'Skin & Spa', 1800, 60, 1],
        ['srv-6', 'Luxury Groom / Bridal Makeover', 'Special Occasion', 7500, 180, 0]
      ];
      for (const s of defaultServices) {
        insertSrv.run(...s);
      }
    }

    const styCount = this.db.prepare('SELECT COUNT(*) as count FROM stylists').get().count;
    if (styCount === 0) {
      const insertSty = this.db.prepare('INSERT INTO stylists (id, name, role, avatar, rating, completed_today) VALUES (?, ?, ?, ?, ?, ?)');
      const defaultStylists = [
        ['sty-1', 'Amit Sharma', 'Creative Hair Director', 'AS', 4.9, 6],
        ['sty-2', 'Priya Verma', 'Master Colorist & Stylist', 'PV', 4.95, 5],
        ['sty-3', 'Rahul Mehta', 'Beard & Fade Specialist', 'RM', 4.85, 7],
        ['sty-4', 'Sneha Kulkarni', 'Aesthetician & Spa Lead', 'SK', 4.9, 4]
      ];
      for (const st of defaultStylists) {
        insertSty.run(...st);
      }
    }

    const aptCount = this.db.prepare('SELECT COUNT(*) as count FROM appointments').get().count;
    if (aptCount === 0) {
      const insertApt = this.db.prepare(`
        INSERT INTO appointments (id, client_name, client_phone, service_name, stylist_name, time, date, price, payment_mode, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const defaultAppointments = [
        ['apt-101', 'Arjun Malhotra', '9820123456', 'Signature Haircut & Beard Sculpt', 'Amit Sharma', '11:30 AM', 'Today', 650, 'UPI', 'In-Chair', 'Prefers textured matte finish'],
        ['apt-102', 'Rhea Sen', '9876543210', 'Balayage & Global Color', 'Priya Verma', '12:15 PM', 'Today', 4200, 'Card', 'Confirmed', 'Ash blonde consultation done'],
        ['apt-103', 'Vikram Singhania', '9811223344', 'Moroccan Hair Spa & Scalp Detox', 'Sneha Kulkarni', '01:00 PM', 'Today', 1450, 'UPI', 'Confirmed', 'VIP Client, quiet chair requested'],
        ['apt-104', 'Karan Johar', '9930445566', 'Signature Haircut & Beard Sculpt', 'Rahul Mehta', '02:30 PM', 'Today', 650, 'Cash', 'Confirmed', 'Skin fade with straight razor line'],
        ['apt-105', 'Ananya Roy', '9840556677', 'Keratin Silk Smooth Treatment', 'Amit Sharma', '03:45 PM', 'Today', 3800, 'UPI', 'Confirmed', 'Shoulder-length hair'],
        ['apt-106', 'Devansh Roy', '9871122334', 'Radiance Gold Facial & De-Tan', 'Sneha Kulkarni', '10:00 AM', 'Today', 1800, 'UPI', 'Completed', 'Paid via UPI']
      ];
      for (const a of defaultAppointments) {
        insertApt.run(...a);
      }
    }

    const cliCount = this.db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
    if (cliCount === 0) {
      const insertCli = this.db.prepare(`
        INSERT INTO clients (id, name, phone, visits, total_spend, preferred_stylist, rating, tier, last_service, days_ago)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const defaultClients = [
        ['cli-1', 'Arjun Malhotra', '98201 23456', 8, 6200, 'Amit Sharma', 4.9, 'VIP', 'Haircut & Beard', 0],
        ['cli-2', 'Rhea Sen', '98765 43210', 5, 16800, 'Priya Verma', 5.0, 'VIP', 'Balayage & Color', 0],
        ['cli-3', 'Vikram Singhania', '98112 23344', 11, 14500, 'Sneha Kulkarni', 4.9, 'VIP', 'Moroccan Hair Spa', 0],
        ['cli-4', 'Karan Johar', '99304 45566', 2, 1300, 'Rahul Mehta', 4.5, 'Returning', 'Haircut & Beard', 0],
        ['cli-5', 'Ananya Roy', '98405 56677', 4, 15200, 'Amit Sharma', 4.8, 'VIP', 'Keratin Silk Smooth', 0],
        ['cli-6', 'Devansh Roy', '98711 22334', 6, 10800, 'Sneha Kulkarni', 4.9, 'Returning', 'Radiance Gold Facial', 0],
        ['cli-7', 'Kavita Rao', '98100 44400', 5, 18500, 'Priya Verma', 4.9, 'At risk', 'Balayage & Color', 33],
        ['cli-8', 'Nikhil Jain', '99000 55500', 2, 1300, 'Rahul Mehta', 3.8, 'At risk', 'Haircut & Beard', 61],
        ['cli-9', 'Farah Khan', '98700 66600', 3, 5400, 'Sneha Kulkarni', 5.0, 'At risk', 'Radiance Gold Facial', 40]
      ];
      for (const c of defaultClients) {
        insertCli.run(...c);
      }
    }
  }

  // Repository Methods
  getAppointments() {
    return this.db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all();
  }

  getAppointmentById(id) {
    return this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  }

  createAppointment(apt) {
    const id = apt.id || 'apt-' + Date.now().toString().slice(-6);
    const stmt = this.db.prepare(`
      INSERT INTO appointments (id, client_name, client_phone, service_name, stylist_name, time, date, price, payment_mode, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      apt.client_name,
      apt.client_phone,
      apt.service_name,
      apt.stylist_name,
      apt.time || '03:00 PM',
      apt.date || 'Today',
      Number(apt.price) || 650,
      apt.payment_mode || 'UPI',
      apt.status || 'Confirmed',
      apt.notes || ''
    );

    // Upsert client record
    const client = this.db.prepare('SELECT * FROM clients WHERE phone = ?').get(apt.client_phone);
    if (client) {
      this.db.prepare(`
        UPDATE clients 
        SET visits = visits + 1, total_spend = total_spend + ?, last_service = ?, preferred_stylist = ?, days_ago = 0, updated_at = CURRENT_TIMESTAMP
        WHERE phone = ?
      `).run(Number(apt.price) || 650, apt.service_name, apt.stylist_name, apt.client_phone);
    } else {
      this.db.prepare(`
        INSERT INTO clients (id, name, phone, visits, total_spend, preferred_stylist, rating, tier, last_service, days_ago)
        VALUES (?, ?, ?, 1, ?, ?, 5.0, 'New', ?, 0)
      `).run('cli-' + Date.now().toString().slice(-6), apt.client_name, apt.client_phone, Number(apt.price) || 650, apt.stylist_name, apt.service_name);
    }

    return this.getAppointmentById(id);
  }

  updateAppointment(id, updates) {
    const allowed = ['status', 'payment_mode', 'notes', 'price', 'stylist_name', 'time'];
    const fields = Object.keys(updates).filter(k => allowed.includes(k));
    if (fields.length === 0) return this.getAppointmentById(id);

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    values.push(id);

    this.db.prepare(`UPDATE appointments SET ${setClause} WHERE id = ?`).run(...values);
    return this.getAppointmentById(id);
  }

  deleteAppointment(id) {
    const res = this.db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
    return res.changes > 0;
  }

  getServices() {
    return this.db.prepare('SELECT * FROM services ORDER BY popular DESC, price ASC').all();
  }

  getStylists() {
    return this.db.prepare('SELECT * FROM stylists ORDER BY rating DESC').all();
  }

  getClients() {
    return this.db.prepare('SELECT * FROM clients ORDER BY visits DESC').all();
  }

  getMetrics() {
    const today = this.db.prepare("SELECT * FROM appointments WHERE date = 'Today'").all();
    const totalRevenue = today
      .filter(a => a.status === 'Completed' || a.status === 'In-Chair')
      .reduce((sum, a) => sum + (Number(a.price) || 0), 0);
    const projectedRevenue = today
      .filter(a => a.status !== 'Cancelled')
      .reduce((sum, a) => sum + (Number(a.price) || 0), 0);

    return {
      totalRevenue,
      projectedRevenue,
      totalCount: today.length,
      inChair: today.filter(a => a.status === 'In-Chair').length,
      completed: today.filter(a => a.status === 'Completed').length,
      confirmed: today.filter(a => a.status === 'Confirmed').length,
      currency: '₹',
      dbEngine: 'SQLite (node:sqlite Native WAL)'
    };
  }

  reset() {
    this.db.exec(`
      DELETE FROM appointments;
      DELETE FROM clients;
      DELETE FROM services;
      DELETE FROM stylists;
    `);
    this.seedDefaults();
    return { success: true, message: 'Database reset and re-seeded' };
  }
}

module.exports = { SalonDatabase, DB_PATH };
