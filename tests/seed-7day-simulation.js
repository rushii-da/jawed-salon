/**
 * SalonDesk High-Volume 7-Day Operational Simulation Runner
 * 
 * Target Volume: 150-200 customers / day for 7 consecutive days (~1,225 appointments)
 * Target Tenant: GENZEE UNISEX Hair & Beauty Lounge (salon_id: 'genzee')
 * Dates: 2026-11-18 through 2026-11-24
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Read environment
const envPath = path.resolve(__dirname, '../.env');
let supabaseUrl = process.env.SUPABASE_URL;
let supabaseKey = process.env.SUPABASE_KEY;

if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, ...rest] = trimmed.split('=');
    const v = rest.join('=').trim();
    if (k === 'SUPABASE_URL' && !supabaseUrl) supabaseUrl = v;
    if (k === 'SUPABASE_KEY' && !supabaseKey) supabaseKey = v;
  }
}

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be provided');
  process.exit(1);
}

const client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
const SALON_ID = 'genzee';

const FIRST_NAMES = [
  'Aarav', 'Aditya', 'Rohan', 'Tanmay', 'Siddharth', 'Varun', 'Karan', 'Kunal', 'Nikhil', 'Gaurav',
  'Ananya', 'Pooja', 'Neha', 'Sneha', 'Shruti', 'Priya', 'Riya', 'Isha', 'Tanvi', 'Deepika',
  'Amit', 'Rahul', 'Vivek', 'Sachin', 'Pranav', 'Mayur', 'Abhishek', 'Akash', 'Suraj', 'Vikram',
  'Shweta', 'Meera', 'Roshni', 'Kavita', 'Manasi', 'Aarti', 'Kiran', 'Vidya', 'Geeta', 'Swati',
  'Rajesh', 'Suresh', 'Manish', 'Sanjay', 'Chetan', 'Harish', 'Nilesh', 'Mahesh', 'Ashwin', 'Sameer',
  'Preeti', 'Sunita', 'Rekha', 'Archana', 'Pallavi', 'Namrata', 'Smita', 'Sheetal', 'Sayali', 'Tejas'
];

const LAST_NAMES = [
  'Sharma', 'Kulkarni', 'Patil', 'Deshmukh', 'Joshi', 'Nair', 'Mehta', 'Iyer', 'Gupta', 'Rao',
  'Kapoor', 'Bhat', 'Verma', 'Chavan', 'Shinde', 'Gaikwad', 'Pawar', 'More', 'Jadhav', 'Kale',
  'Chopra', 'Malhotra', 'Agarwal', 'Shah', 'Pandey', 'Mishra', 'Bansal', 'Saxena', 'Dutta', 'Menon'
];

const SERVICES_MENU = [
  { id: 'srv-g1', name: 'Skin Fade & Beard Sculpt', price: 650, duration: 45, category: 'Hair & Grooming', stylist: 'Vikram (Fade Specialist)', stylistId: 'sty-g3' },
  { id: 'srv-g2', name: 'Keratin Silk / Hair Botox', price: 3800, duration: 120, category: 'Hair Treatment', stylist: 'Rahul (Creative Director)', stylistId: 'sty-g1' },
  { id: 'srv-g3', name: 'Moroccan Argan Hair Spa', price: 1450, duration: 60, category: 'Hair Treatment', stylist: 'Rahul (Creative Director)', stylistId: 'sty-g1' },
  { id: 'srv-g4', name: 'Balayage & Global Color', price: 4200, duration: 150, category: 'Hair Color', stylist: 'Pooja (Color Specialist)', stylistId: 'sty-g2' },
  { id: 'srv-g5', name: 'Radiance Gold Facial', price: 1800, duration: 60, category: 'Skin & Spa', stylist: 'Aarti (Aesthetician)', stylistId: 'sty-g4' },
  { id: 'srv-g6', name: 'Charcoal Detox Cleanup', price: 950, duration: 45, category: 'Skin & Spa', stylist: 'Aarti (Aesthetician)', stylistId: 'sty-g4' }
];

const STYLISTS = [
  { id: 'sty-g1', name: 'Rahul (Creative Director)', role: 'Master Hair Stylist', comm: 35 },
  { id: 'sty-g2', name: 'Pooja (Color Specialist)', role: 'Senior Colorist', comm: 35 },
  { id: 'sty-g3', name: 'Vikram (Fade Specialist)', role: 'Beard & Grooming Lead', comm: 30 },
  { id: 'sty-g4', name: 'Aarti (Aesthetician)', role: 'Skin & Spa Lead', comm: 35 }
];

const TIME_SLOTS = [
  '09:00 AM', '09:30 AM', '10:00 AM', '10:30 AM', '11:00 AM', '11:30 AM',
  '12:00 PM', '12:30 PM', '01:00 PM', '01:30 PM', '02:00 PM', '02:30 PM',
  '03:00 PM', '03:30 PM', '04:00 PM', '04:30 PM', '05:00 PM', '05:30 PM',
  '06:00 PM', '06:30 PM', '07:00 PM', '07:30 PM', '08:00 PM', '08:30 PM', '09:00 PM'
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function computeGst(totalPrice) {
  const taxable = +(totalPrice / 1.18).toFixed(2);
  const tax = +(totalPrice - taxable).toFixed(2);
  const half = +(tax / 2).toFixed(2);
  return { cgst: half, sgst: +(tax - half).toFixed(2) };
}

async function runSimulation() {
  console.log('🚀 Starting SalonDesk 7-Day High-Volume Stress Simulation...');
  console.log(`Salon: ${SALON_ID} (GENZEE UNISEX Lounge)`);

  // 1. Generate Client Pool of 600 realistic people
  console.log('\n--- 1. Generating Client Cohort (600 profiles) ---');
  const clientPool = [];
  const usedPhones = new Set();

  for (let i = 1; i <= 600; i++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    let phone;
    do {
      phone = '98' + String(randInt(10000000, 99999999));
    } while (usedPhones.has(phone));
    usedPhones.add(phone);

    const id = `cli-sim-${String(i).padStart(4, '0')}`;
    clientPool.push({
      id,
      name: `${first} ${last}`,
      phone,
      visits: 0,
      total_spend: 0,
      preferred_stylist: pick(STYLISTS).name,
      rating: +(4.5 + Math.random() * 0.5).toFixed(1),
      tier: 'New',
      last_service: '',
      last_visit_at: '2026-11-18',
      formula_notes: Math.random() > 0.6 ? `Customer likes low fade, no ammonia colors` : '',
      opted_in: 1
    });
  }

  // 2. Setup 7 days traffic distribution
  const DAY_SCHEDULE = [
    { date: '2026-11-18', day: 'Wed', target: 160 },
    { date: '2026-11-19', day: 'Thu', target: 155 },
    { date: '2026-11-20', day: 'Fri', target: 180 },
    { date: '2026-11-21', day: 'Sat', target: 210 }, // Weekend rush
    { date: '2026-11-22', day: 'Sun', target: 205 }, // Weekend rush
    { date: '2026-11-23', day: 'Mon', target: 150 },
    { date: '2026-11-24', day: 'Tue', target: 165 }  // Today
  ];

  const totalTarget = DAY_SCHEDULE.reduce((s, d) => s + d.target, 0);
  console.log(`7-Day Volume Target: ${totalTarget} appointments (Average: ${(totalTarget / 7).toFixed(1)}/day)`);

  const allAppointments = [];
  let invoiceSeq = 200;

  for (const day of DAY_SCHEDULE) {
    const isToday = day.date === '2026-11-24';

    for (let c = 0; c < day.target; c++) {
      invoiceSeq++;
      const invoiceNo = `INV-2026-${invoiceSeq}`;
      const client = pick(clientPool);

      // Choose service (single or combo)
      const isCombo = Math.random() < 0.25;
      const srv1 = pick(SERVICES_MENU);
      let servicesList = [srv1];
      if (isCombo) {
        const srv2 = pick(SERVICES_MENU.filter(s => s.id !== srv1.id));
        servicesList.push(srv2);
      }

      const serviceName = servicesList.map(s => s.name).join(' + ');
      const subtotal = servicesList.reduce((sum, s) => sum + s.price, 0);
      const discount = Math.random() < 0.15 ? pick([100, 150, 200, 300]) : 0;
      const price = Math.max(0, subtotal - discount);
      const durationMins = servicesList.reduce((sum, s) => sum + s.duration, 0);

      // Stylist selection
      const matchedStylist = STYLISTS.find(st => st.name === srv1.stylist) || pick(STYLISTS);

      // Status determination
      let status = 'Completed';
      const slot = pick(TIME_SLOTS);
      if (isToday) {
        // Break today into Completed, In-Chair, and Confirmed
        if (slot >= '05:30 PM') {
          status = 'Confirmed';
        } else if (slot >= '03:30 PM' && slot <= '05:00 PM') {
          status = 'In-Chair';
        } else {
          status = 'Completed';
        }
      } else {
        // Past days: 97% completed, 3% cancelled
        status = Math.random() < 0.03 ? 'Cancelled' : 'Completed';
      }

      // Payment mode distribution (65% UPI, 20% Card, 10% Cash, 5% Split)
      const pRand = Math.random();
      let paymentMode = 'UPI';
      let splitJson = {};
      if (pRand < 0.65) {
        paymentMode = 'UPI';
      } else if (pRand < 0.85) {
        paymentMode = 'Card';
      } else if (pRand < 0.95) {
        paymentMode = 'Cash';
      } else {
        paymentMode = 'Split';
        const upiPart = Math.round(price * 0.6);
        splitJson = { UPI: upiPart, Cash: price - upiPart };
      }

      const gst = computeGst(price);
      const rating = status === 'Completed' && Math.random() < 0.8 ? pick([5, 5, 5, 4, 4, 3]) : null;

      const aptId = `apt-sim-${day.date.replace(/-/g, '')}-${String(c + 1).padStart(3, '0')}`;

      allAppointments.push({
        id: aptId,
        salon_id: SALON_ID,
        invoice_no: invoiceNo,
        client_id: client.id,
        client_name: client.name,
        client_phone: client.phone,
        stylist_id: matchedStylist.id,
        stylist_name: matchedStylist.name,
        service_name: serviceName,
        services_json: servicesList,
        date: day.date,
        time: slot,
        duration_mins: durationMins,
        subtotal,
        discount,
        price,
        cgst: gst.cgst,
        sgst: gst.sgst,
        payment_mode: paymentMode,
        payment_split_json: splitJson,
        status,
        rating,
        notes: isCombo ? 'VIP multi-service combo' : 'Standard appointment'
      });

      // Update client running stats if completed
      if (status === 'Completed') {
        client.visits += 1;
        client.total_spend += price;
        client.last_service = serviceName;
        client.last_visit_at = day.date;
        client.preferred_stylist = matchedStylist.name;
      }
    }
  }

  // Update Client tiers based on final visits
  for (const cl of clientPool) {
    if (cl.visits >= 4 || cl.total_spend >= 10000) {
      cl.tier = 'VIP';
    } else if (cl.visits >= 2) {
      cl.tier = 'Returning';
    } else if (cl.visits === 1) {
      cl.tier = 'New';
    } else {
      // 0 visits in last 7 days -> mark at risk
      cl.tier = 'At risk';
      cl.last_visit_at = '2026-10-15'; // 40 days ago
    }
  }

  console.log(`\n--- 2. Upserting ${clientPool.length} Clients in Batches of 100 ---`);
  const BATCH_SIZE = 100;
  for (let i = 0; i < clientPool.length; i += BATCH_SIZE) {
    const batch = clientPool.slice(i, i + BATCH_SIZE).map(c => ({
      id: c.id,
      salon_id: SALON_ID,
      name: c.name,
      phone: c.phone,
      visits: c.visits,
      total_spend: c.total_spend,
      preferred_stylist: c.preferred_stylist,
      rating: c.rating,
      tier: c.tier,
      last_service: c.last_service,
      last_visit_at: c.last_visit_at,
      formula_notes: c.formula_notes,
      opted_in: c.opted_in
    }));

    const { error } = await client.from('clients').upsert(batch, { onConflict: 'salon_id, phone' });
    if (error) {
      console.error(`Error inserting client batch ${i}:`, error.message);
    } else {
      process.stdout.write(`✅ Clients: ${Math.min(i + BATCH_SIZE, clientPool.length)} / ${clientPool.length}\r`);
    }
  }
  console.log('\nClients upsert complete!');

  console.log(`\n--- 3. Inserting ${allAppointments.length} Appointments in Batches of 100 ---`);
  for (let i = 0; i < allAppointments.length; i += BATCH_SIZE) {
    const batch = allAppointments.slice(i, i + BATCH_SIZE);
    const { error } = await client.from('appointments').upsert(batch, { onConflict: 'salon_id, invoice_no' });
    if (error) {
      console.error(`Error inserting appointments batch ${i}:`, error.message);
    } else {
      process.stdout.write(`✅ Appointments: ${Math.min(i + BATCH_SIZE, allAppointments.length)} / ${allAppointments.length}\r`);
    }
  }
  console.log('\nAppointments insertion complete!');

  console.log('\n✨ Simulation dataset loaded into Supabase successfully!');
}

runSimulation().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
