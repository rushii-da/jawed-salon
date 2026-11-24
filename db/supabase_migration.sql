-- ====================================================================
-- SALON OS: Multi-Tenant Schema & Pre-Seed for GENZEE UNISEX Lounge
-- Execute this script once in Supabase SQL Editor
-- ====================================================================

-- 1. SALONS TABLE
CREATE TABLE IF NOT EXISTS salons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  phone TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  gstin TEXT DEFAULT '',
  gst_rate NUMERIC DEFAULT 18,
  sac_code TEXT DEFAULT '999722',
  opening_cash NUMERIC DEFAULT 5000,
  owner_pin TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. SERVICES TABLE
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Hair & Grooming',
  price NUMERIC NOT NULL CHECK(price >= 0),
  duration INTEGER DEFAULT 45 CHECK(duration > 0),
  popular INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_services_salon ON services(salon_id);

-- 3. STYLISTS TABLE
CREATE TABLE IF NOT EXISTS stylists (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar TEXT,
  phone TEXT DEFAULT '',
  commission_pct NUMERIC DEFAULT 35 CHECK(commission_pct >= 0 AND commission_pct <= 100),
  rating NUMERIC DEFAULT 4.9,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stylists_salon ON stylists(salon_id);

-- 4. CLIENTS TABLE
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  visits INTEGER DEFAULT 0,
  total_spend NUMERIC DEFAULT 0,
  preferred_stylist TEXT DEFAULT '',
  rating NUMERIC DEFAULT 5.0,
  tier TEXT DEFAULT 'New',
  last_service TEXT DEFAULT '',
  last_visit_at TEXT DEFAULT '',
  formula_notes TEXT DEFAULT '',
  opted_in INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(salon_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_clients_salon_phone ON clients(salon_id, phone);

-- 5. APPOINTMENTS & INVOICES TABLE
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  invoice_no TEXT,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  stylist_id TEXT REFERENCES stylists(id) ON DELETE SET NULL,
  stylist_name TEXT NOT NULL,
  service_name TEXT NOT NULL,
  services_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  duration_mins INTEGER DEFAULT 45,
  subtotal NUMERIC NOT NULL DEFAULT 0,
  discount NUMERIC NOT NULL DEFAULT 0,
  price NUMERIC NOT NULL CHECK(price >= 0),
  cgst NUMERIC NOT NULL DEFAULT 0,
  sgst NUMERIC NOT NULL DEFAULT 0,
  payment_mode TEXT DEFAULT 'UPI',
  payment_split_json JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'Confirmed',
  rating INTEGER DEFAULT NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(salon_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS idx_appointments_salon_date ON appointments(salon_id, date);
CREATE INDEX IF NOT EXISTS idx_appointments_salon_status ON appointments(salon_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_salon_phone ON appointments(salon_id, client_phone);

-- 6. CAMPAIGNS TABLE
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  message TEXT NOT NULL,
  audience_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Completed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_salon ON campaigns(salon_id);

-- ====================================================================
-- SEED DATA: GENZEE UNISEX HAIR & BEAUTY LOUNGE
-- ====================================================================

-- 1. Insert Salon Info (Password: genzee123)
INSERT INTO salons (id, name, branch, phone, username, password_hash, gstin, gst_rate, sac_code, opening_cash, owner_pin)
VALUES (
  'genzee',
  'GENZEE UNISEX Hair & Beauty Lounge',
  'Green Cove, Godrej Properties, Mahalunge, Pune',
  '8446451506',
  '8446451506',
  '61661d90f6df17f49f59277b2da6af4a79df204f831950baaa24769deafaf855',
  '27AAEFG1234A1Z5',
  18,
  '999722',
  5000,
  '1234'
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  branch = EXCLUDED.branch,
  phone = EXCLUDED.phone;

-- 2. Services for GENZEE
INSERT INTO services (id, salon_id, name, category, price, duration, popular, active)
VALUES
  ('srv-g1', 'genzee', 'Skin Fade & Beard Sculpt', 'Hair & Grooming', 650, 45, 1, 1),
  ('srv-g2', 'genzee', 'Keratin Silk / Hair Botox', 'Hair Treatment', 3800, 120, 1, 1),
  ('srv-g3', 'genzee', 'Moroccan Argan Hair Spa', 'Hair Treatment', 1450, 60, 1, 1),
  ('srv-g4', 'genzee', 'Balayage & Global Color', 'Hair Color', 4200, 150, 1, 1),
  ('srv-g5', 'genzee', 'Radiance Gold Facial', 'Skin & Spa', 1800, 60, 1, 1),
  ('srv-g6', 'genzee', 'Charcoal Detox Cleanup', 'Skin & Spa', 950, 45, 1, 1)
ON CONFLICT (id) DO NOTHING;

-- 3. Stylists for GENZEE (Editable staff roster)
INSERT INTO stylists (id, salon_id, name, role, avatar, phone, commission_pct, rating, active)
VALUES
  ('sty-g1', 'genzee', 'Rahul (Creative Director)', 'Master Hair Stylist', 'RD', '8446451501', 35, 4.95, 1),
  ('sty-g2', 'genzee', 'Pooja (Color Specialist)', 'Senior Colorist', 'PS', '8446451502', 35, 4.90, 1),
  ('sty-g3', 'genzee', 'Vikram (Fade Specialist)', 'Beard & Grooming Lead', 'VF', '8446451503', 30, 4.85, 1),
  ('sty-g4', 'genzee', 'Aarti (Aesthetician)', 'Skin & Spa Lead', 'AA', '8446451504', 35, 4.90, 1)
ON CONFLICT (id) DO NOTHING;

-- 4. Initial Clients for GENZEE
INSERT INTO clients (id, salon_id, name, phone, visits, total_spend, preferred_stylist, rating, tier, last_service, last_visit_at, formula_notes, opted_in)
VALUES
  ('cli-g1', 'genzee', 'Aditya Kulkarni', '9820123456', 4, 3800, 'Rahul (Creative Director)', 4.9, 'VIP', 'Skin Fade & Beard Sculpt', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), 'Fade #1.5, matte paste finish', 1),
  ('cli-g2', 'genzee', 'Neha Joshi', '9876543210', 3, 9400, 'Pooja (Color Specialist)', 5.0, 'VIP', 'Balayage & Global Color', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), 'Ash blonde highlights, Olaplex 1', 1),
  ('cli-g3', 'genzee', 'Tanmay Deshmukh', '9811223344', 2, 1450, 'Vikram (Fade Specialist)', 4.8, 'Returning', 'Skin Fade & Beard Sculpt', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), 'Straight razor sharp edge', 1),
  ('cli-g4', 'genzee', 'Pooja Shinde', '9930445566', 1, 1800, 'Aarti (Aesthetician)', 4.9, 'New', 'Radiance Gold Facial', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), 'Sensitive skin, gentle scrub', 1)
ON CONFLICT (salon_id, phone) DO NOTHING;

-- 5. Today's Appointments & Invoices for GENZEE
INSERT INTO appointments (
  id, salon_id, invoice_no, client_id, client_name, client_phone, stylist_id, stylist_name,
  service_name, services_json, date, time, duration_mins, subtotal, discount, price,
  cgst, sgst, payment_mode, payment_split_json, status, rating, notes
) VALUES
  ('apt-g1', 'genzee', 'INV-2026-101', 'cli-g1', 'Aditya Kulkarni', '9820123456', 'sty-g1', 'Rahul (Creative Director)',
   'Skin Fade & Beard Sculpt', '[{"id":"srv-g1","name":"Skin Fade & Beard Sculpt","price":650,"duration":45}]'::jsonb,
   TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), '11:00 AM', 45, 650, 0, 650, 49.58, 49.58, 'UPI', '{}'::jsonb, 'Completed', 5, 'Godrej Green Cove resident'),
  ('apt-g2', 'genzee', 'INV-2026-102', 'cli-g2', 'Neha Joshi', '9876543210', 'sty-g2', 'Pooja (Color Specialist)',
   'Balayage & Global Color', '[{"id":"srv-g4","name":"Balayage & Global Color","price":4200,"duration":150}]'::jsonb,
   TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), '12:30 PM', 150, 4200, 200, 4000, 305.08, 305.08, 'UPI', '{}'::jsonb, 'Completed', 5, 'VIP regular'),
  ('apt-g3', 'genzee', 'INV-2026-103', 'cli-g3', 'Tanmay Deshmukh', '9811223344', 'sty-g3', 'Vikram (Fade Specialist)',
   'Skin Fade & Beard Sculpt', '[{"id":"srv-g1","name":"Skin Fade & Beard Sculpt","price":650,"duration":45}]'::jsonb,
   TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), '03:00 PM', 45, 650, 0, 650, 49.58, 49.58, 'Cash', '{}'::jsonb, 'In-Chair', NULL, 'In-chair walk-in')
ON CONFLICT (salon_id, invoice_no) DO NOTHING;

-- 6. Win-back & Loyalty Campaigns
INSERT INTO campaigns (id, salon_id, name, segment, message, audience_count, sent_count, status)
VALUES
  ('cmp-g1', 'genzee', 'Weekend Glow VIP Perk', 'VIP', 'Hi {name}, exclusive perk at GENZEE Lounge: complimentary Moroccan scalp massage with your hair treatment this weekend!', 4, 4, 'Completed'),
  ('cmp-g2', 'genzee', 'Mahalunge Resident Discount', 'All', 'Hi {name}, enjoy 15% off on Hair Botox & Keratin this week at GENZEE Lounge, Godrej Green Cove!', 8, 8, 'Completed')
ON CONFLICT (id) DO NOTHING;
