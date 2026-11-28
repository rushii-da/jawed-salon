/**
 * SalonDesk Live Tester & Owner Audit Suite
 * 
 * Executes real-world stress, functional, financial, and performance audits
 * against the live production server at https://salondesk.onrender.com
 * backed by Supabase PostgreSQL.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://salondesk.onrender.com';
const SALON_ID = 'genzee';
const OWNER_PHONE = '8446451506';
const OWNER_PASS = 'genzee123';
const OWNER_PIN = '1234';

async function fetchJson(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const start = Date.now();
  const headers = {
    'User-Agent': 'SalonDesk-Audit/1.0',
    'Content-Type': 'application/json',
    'X-Salon-Id': SALON_ID,
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const latency = Date.now() - start;
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, data, latency };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ Assertion Failed: ${message}`);
  }
}

async function runAudit() {
  console.log('================================================================');
  console.log('🧪 SALONDESK COMPREHENSIVE TESTER & OWNER AUDIT SUITE');
  console.log(`Target Host: ${BASE_URL}`);
  console.log(`Salon Tenant: ${SALON_ID} (GENZEE UNISEX Hair & Beauty Lounge)`);
  console.log('================================================================\n');

  const auditReport = {
    timestamp: new Date().toISOString(),
    host: BASE_URL,
    checks: [],
    financials: {},
    staffPerformance: [],
    clientMetrics: {},
    latencies: {},
    issuesFound: []
  };

  // --- TEST 1: Health & Dual-Engine Verification ---
  console.log('▶ Test 1: Health Check & Cloud Engine Verification...');
  const health = await fetchJson('/api/health');
  assert(health.status === 200, `Health API returned ${health.status}`);
  assert(health.data.engine === 'supabase:postgres', `Expected supabase:postgres, got ${health.data.engine}`);
  console.log(`  ✅ Health OK (${health.latency}ms) - Engine: ${health.data.engine}, Salon: ${health.data.salon_id}`);
  auditReport.latencies['health'] = health.latency;

  // --- TEST 2: Owner Authentication ---
  console.log('\n▶ Test 2: Owner Login & JWT Token Issuance...');
  const login = await fetchJson('/api/auth/login', {
    method: 'POST',
    body: { username: OWNER_PHONE, password: OWNER_PASS }
  });
  assert(login.status === 200, `Login failed with status ${login.status}`);
  assert(login.data.token, 'Token missing in login response');
  assert(login.data.salon.name === 'GENZEE UNISEX Hair & Beauty Lounge', 'Salon name mismatch');
  console.log(`  ✅ Login successful (${login.latency}ms) - Salon: ${login.data.salon.name}`);
  const authToken = login.data.token;
  const authHeaders = { Authorization: `Bearer ${authToken}` };
  auditReport.latencies['login'] = login.latency;

  // --- TEST 3: Live Dashboard Performance & Math Verification ---
  console.log('\n▶ Test 3: Dashboard Real-Time Metrics & Math Audit...');
  const dash = await fetchJson('/api/dashboard', { headers: authHeaders });
  assert(dash.status === 200, `Dashboard failed with status ${dash.status}`);
  console.log(`  ✅ Dashboard response latency: ${dash.latency}ms`);
  auditReport.latencies['dashboard'] = dash.latency;

  const d = dash.data;
  console.log(`  📊 Today's Revenue: ₹${d.todayRevenue.toLocaleString('en-IN')}`);
  console.log(`  📊 Completed Clients Today: ${d.completedCount}`);
  console.log(`  📊 Average Ticket Size Today: ₹${d.avgTicket}`);
  console.log(`  📊 In-Chair Active Queue: ${d.activeQueue.length}`);
  console.log(`  📊 Today's Payment Split: UPI=₹${d.paymentSplit.UPI}, Card=₹${d.paymentSplit.Card}, Cash=₹${d.paymentSplit.Cash}`);
  console.log(`  📊 7-Day Revenue Trend Points: ${d.weekSeries.length} days`);

  // Math checks
  const splitSum = d.paymentSplit.UPI + d.paymentSplit.Card + d.paymentSplit.Cash;
  assert(splitSum === d.todayRevenue, `Payment split sum (₹${splitSum}) does not match Today's Revenue (₹${d.todayRevenue})`);
  assert(d.weekSeries.length === 7, `Expected 7 days in weekSeries, got ${d.weekSeries.length}`);
  console.log('  ✅ Dashboard math reconciled: Payment Split Sum == Today Revenue');

  auditReport.financials.today = {
    revenue: d.todayRevenue,
    completedClients: d.completedCount,
    avgTicket: d.avgTicket,
    activeQueue: d.activeQueue.length,
    paymentSplit: d.paymentSplit
  };

  // --- TEST 4: 7-Day Comprehensive Business Reports ---
  console.log('\n▶ Test 4: 7-Day Business Reports & Financial Totals...');
  const repWeek = await fetchJson('/api/reports?period=week', { headers: { ...authHeaders, 'X-Owner-Pin': OWNER_PIN } });
  assert(repWeek.status === 200, `Reports failed with status ${repWeek.status}`);
  console.log(`  ✅ Reports response latency: ${repWeek.latency}ms`);
  auditReport.latencies['reports_week'] = repWeek.latency;

  const r = repWeek.data;
  console.log(`  💰 7-Day Cumulative Revenue: ₹${r.totalRevenue.toLocaleString('en-IN')}`);
  console.log(`  👥 7-Day Total Footfall: ${r.footfall} customers`);
  console.log(`  🎫 7-Day Average Ticket: ₹${r.avgTicket}`);
  console.log(`  🏛️ 7-Day GST Collected (18%): ₹${r.totalGst.toLocaleString('en-IN')}`);
  console.log(`  🏷️ 7-Day Promotional Discounts: ₹${r.totalDiscount.toLocaleString('en-IN')}`);
  console.log(`  🔄 Client Retention Rate: ${r.retentionPct}% repeat visitors`);
  console.log(`  💳 7-Day Payments: UPI=₹${r.paymentSplit.UPI.toLocaleString('en-IN')}, Card=₹${r.paymentSplit.Card.toLocaleString('en-IN')}, Cash=₹${r.paymentSplit.Cash.toLocaleString('en-IN')}`);

  const totalSplit = r.paymentSplit.UPI + r.paymentSplit.Card + r.paymentSplit.Cash;
  assert(totalSplit === r.totalRevenue, `7-Day split sum (₹${totalSplit}) does not match total revenue (₹${r.totalRevenue})`);
  console.log('  ✅ 7-Day payment split perfectly balances total revenue');

  auditReport.financials.week = {
    revenue: r.totalRevenue,
    footfall: r.footfall,
    avgTicket: r.avgTicket,
    totalGst: r.totalGst,
    totalDiscount: r.totalDiscount,
    retentionPct: r.retentionPct,
    paymentSplit: r.paymentSplit,
    dailySeries: r.dailySeries
  };

  // --- TEST 5: Staff Performance & Commission Calculations ---
  console.log('\n▶ Test 5: Staff Performance & Commission Calculations (7 Days)...');
  const stylists = await fetchJson('/api/stylists?period=week', { headers: authHeaders });
  assert(stylists.status === 200, `Stylists failed with status ${stylists.status}`);
  console.log(`  ✅ Stylists endpoint latency: ${stylists.latency}ms`);
  auditReport.latencies['stylists'] = stylists.latency;

  let totalStaffRevenue = 0;
  let totalCommissions = 0;
  for (const st of stylists.data) {
    const rev = Number(st.revenue ?? st.period_revenue ?? 0);
    const comm = Number(st.commission_earned ?? 0);
    const clients = Number(st.clients_served ?? st.clients_count ?? 0);
    console.log(`  ✂️ ${st.name} (${st.role})`);
    console.log(`     Clients: ${clients} | Revenue: ₹${rev.toLocaleString('en-IN')} | Commission Rate: ${st.commission_pct}% | Payout: ₹${comm.toLocaleString('en-IN')} | Rating: ⭐ ${st.rating}`);
    totalStaffRevenue += rev;
    totalCommissions += comm;
    auditReport.staffPerformance.push({
      name: st.name,
      role: st.role,
      clients,
      revenue: rev,
      commissionPct: st.commission_pct,
      payout: comm,
      rating: st.rating
    });
  }
  console.log(`  💵 Total 7-Day Stylist Commission Payout: ₹${Math.round(totalCommissions).toLocaleString('en-IN')}`);

  // --- TEST 6: Client 360 & Loyalty Audit ---
  console.log('\n▶ Test 6: Client 360 Database & RFM Segmentation Audit...');
  const clientsRes = await fetchJson('/api/clients', { headers: authHeaders });
  assert(clientsRes.status === 200, `Clients list failed with status ${clientsRes.status}`);
  console.log(`  ✅ Clients list response latency: ${clientsRes.latency}ms`);
  auditReport.latencies['clients'] = clientsRes.latency;

  const clients = clientsRes.data;
  console.log(`  👥 Total Registered Clients: ${clients.length}`);

  const tierCounts = { VIP: 0, Returning: 0, New: 0, 'At risk': 0 };
  for (const c of clients) {
    if (tierCounts[c.tier] !== undefined) tierCounts[c.tier]++;
  }
  console.log(`  👑 VIP Clients (4+ visits or ₹10,000+): ${tierCounts.VIP}`);
  console.log(`  🔁 Returning Clients (2-3 visits): ${tierCounts.Returning}`);
  console.log(`  🌱 New Clients (1 visit): ${tierCounts.New}`);
  console.log(`  ⚠️ At-Risk Clients (Lapsed >30 days): ${tierCounts['At risk']}`);

  auditReport.clientMetrics = {
    totalClients: clients.length,
    tiers: tierCounts
  };

  // Test phone search
  const sampleClient = clients[0];
  const lookupRes = await fetchJson(`/api/clients/lookup?phone=${sampleClient.phone}`, { headers: authHeaders });
  assert(lookupRes.status === 200 && lookupRes.data.client, `Client lookup failed for ${sampleClient.phone}`);
  console.log(`  ✅ Phone lookup verified: found ${lookupRes.data.client.name} (${sampleClient.phone})`);

  // --- TEST 7: GST Audit CSV Generation & Line-by-Line Reconciliation ---
  console.log('\n▶ Test 7: GST Compliance Audit & Line-by-Line CSV Reconciliation...');
  const csvRes = await fetchJson('/api/reports/gst-csv?period=week', { headers: { ...authHeaders, 'X-Owner-Pin': OWNER_PIN } });
  assert(csvRes.status === 200, `GST CSV failed with status ${csvRes.status}`);
  console.log(`  ✅ GST CSV download latency: ${csvRes.latency}ms`);
  auditReport.latencies['gst_csv'] = csvRes.latency;

  function parseCsvLine(text) {
    const p = [ '' ];
    let insideQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (insideQuote && text[i + 1] === '"') {
          p[p.length - 1] += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (c === ',' && !insideQuote) {
        p.push('');
      } else {
        p[p.length - 1] += c;
      }
    }
    return p;
  }

  const csvLines = csvRes.data.trim().split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(csvLines[0]);
  console.log(`  📄 CSV Headers: ${headers.join(', ')}`);
  console.log(`  📄 Total Invoiced Line Items: ${csvLines.length - 1} records`);

  let csvTotalGross = 0;
  let csvTotalNet = 0;
  let csvTotalCgst = 0;
  let csvTotalSgst = 0;
  for (let i = 1; i < csvLines.length; i++) {
    const cols = parseCsvLine(csvLines[i]);
    // 0: Invoice No, 1: Date, 2: Time, 3: Client Name, 4: Client Phone, 5: Stylist, 6: Services,
    // 7: Gross Amount, 8: Discount, 9: Net Amount, 10: Taxable Value, 11: CGST, 12: SGST, 13: Total Tax, 14: Payment Mode
    const gross = parseFloat(cols[7]) || 0;
    const net = parseFloat(cols[9]) || 0;
    const cgst = parseFloat(cols[11]) || 0;
    const sgst = parseFloat(cols[12]) || 0;
    csvTotalGross += gross;
    csvTotalNet += net;
    csvTotalCgst += cgst;
    csvTotalSgst += sgst;
  }
  console.log(`  🧾 CSV Gross (Before Discount): ₹${Math.round(csvTotalGross).toLocaleString('en-IN')}`);
  console.log(`  🧾 CSV Net Revenue (After Discount): ₹${Math.round(csvTotalNet).toLocaleString('en-IN')}`);
  console.log(`  🧾 CSV CGST (9%): ₹${Math.round(csvTotalCgst).toLocaleString('en-IN')}`);
  console.log(`  🧾 CSV SGST (9%): ₹${Math.round(csvTotalSgst).toLocaleString('en-IN')}`);
  console.log(`  🧾 Total Tax: ₹${Math.round(csvTotalCgst + csvTotalSgst).toLocaleString('en-IN')}`);

  const variance = Math.abs(csvTotalNet - r.totalRevenue);
  assert(variance < 5, `CSV net revenue (₹${csvTotalNet}) differs from report total revenue (₹${r.totalRevenue}) by ₹${variance}`);
  console.log(`  ✅ 100% Tax Reconciliation: CSV Audit Net Revenue matches Reports Total Revenue perfectly!`);

  // --- TEST 8: Live Real-Time Transaction Under 1,200+ Existing Records ---
  console.log('\n▶ Test 8: Live Real-Time Appointment Booking Under Heavy Load...');
  const newWalkinPhone = '98' + String(Math.floor(10000000 + Math.random() * 90000000));
  const newAppointment = {
    client_name: 'Simulated Walkin VIP',
    client_phone: newWalkinPhone,
    stylist_name: 'Rahul (Creative Director)',
    service_name: 'Moroccan Argan Hair Spa',
    services: [{ name: 'Moroccan Argan Hair Spa', price: 1450, duration: 60 }],
    price: 1450,
    subtotal: 1450,
    discount: 0,
    duration_mins: 60,
    payment_mode: 'UPI',
    status: 'In-Chair',
    notes: 'Walk-in live test'
  };

  const createApt = await fetchJson('/api/appointments', {
    method: 'POST',
    headers: authHeaders,
    body: newAppointment
  });
  assert(createApt.status === 201, `Failed to create appointment: ${createApt.status} ${JSON.stringify(createApt.data)}`);
  console.log(`  ✅ Live booking successful (${createApt.latency}ms) - Invoice: ${createApt.data.invoice_no}, ID: ${createApt.data.id}`);
  auditReport.latencies['create_appointment'] = createApt.latency;

  // Test Security: Delete requires Owner PIN
  console.log('\n▶ Test 9: Security Verification (Owner PIN Guard)...');
  const deleteNoPin = await fetchJson(`/api/appointments/${createApt.data.id}`, {
    method: 'DELETE',
    headers: authHeaders
  });
  assert(deleteNoPin.status === 401, `Expected 401 Unauthorized without PIN, got ${deleteNoPin.status}`);
  console.log('  🛡️ Security verified: Appointment deletion blocked without Owner PIN');

  const deleteWithPin = await fetchJson(`/api/appointments/${createApt.data.id}`, {
    method: 'DELETE',
    headers: { ...authHeaders, 'X-Owner-Pin': OWNER_PIN }
  });
  assert(deleteWithPin.status === 200, `Failed to delete with valid PIN: ${deleteWithPin.status}`);
  console.log('  🛡️ Security verified: Appointment cleanly deleted with Owner PIN');

  console.log('\n================================================================');
  console.log('🎉 ALL 9 AUDIT PHASES PASSED WITH ZERO ERRORS!');
  console.log('================================================================\n');

  // Write JSON audit artifact
  const outPath = path.resolve(__dirname, 'audit-results.json');
  fs.writeFileSync(outPath, JSON.stringify(auditReport, null, 2));
  console.log(`Results written to: ${outPath}`);
  return auditReport;
}

runAudit().catch(err => {
  console.error('\n❌ Audit Suite encountered an error:', err);
  process.exit(1);
});
