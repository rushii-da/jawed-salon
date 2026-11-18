const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../server');
const { getLocalIsoDate } = require('../db/database');

function reqJson(port, method, urlPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? JSON.stringify(body) : null;
    const headers = { ...extraHeaders };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, data, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Jawed Salon OS — Security, Data Integrity & REST API', () => {
  let server;
  let port;
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jawed-salon-test-'));
    const dbFile = path.join(tmpDir, 'test-salon.db');
    server = createAppServer(dbFile);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { server.db.close(); } catch (_) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks access to SQLite database, backend source files, and path traversal', async () => {
    const blocked = ['/data/salon.db', '/server.js', '/db/database.js', '/package.json', '/../package.json', '/.env'];
    for (const p of blocked) {
      const res = await reqJson(port, 'GET', p);
      assert.ok(res.status === 403 || res.status === 404, `Expected 403/404 for ${p}, got ${res.status}`);
    }
  });

  it('serves frontend HTML and sets security headers', async () => {
    const res = await reqJson(port, 'GET', '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.raw.includes('Jawed Salon'));
  });

  it('handles malformed percent-encoded URLs safely with 400', async () => {
    const res = await reqJson(port, 'GET', '/%E0%A4%A');
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'BAD_URL');
  });

  it('computes live dashboard, metrics, stylists, and reports from SQLite', async () => {
    const dash = await reqJson(port, 'GET', '/api/dashboard');
    assert.equal(dash.status, 200);
    assert.ok(dash.data.todayRevenue > 0);
    assert.equal(dash.data.weekSeries.length, 7);
    assert.ok(Array.isArray(dash.data.activeQueue));

    const styToday = await reqJson(port, 'GET', '/api/stylists?period=today');
    const styMonth = await reqJson(port, 'GET', '/api/stylists?period=month');
    assert.equal(styToday.status, 200);
    assert.equal(styMonth.status, 200);
    const totalToday = styToday.data.reduce((s, x) => s + x.revenue, 0);
    const totalMonth = styMonth.data.reduce((s, x) => s + x.revenue, 0);
    assert.ok(totalMonth >= totalToday, 'Month stylist revenue should be >= today revenue');

    const rep = await reqJson(port, 'GET', '/api/reports?period=month');
    assert.equal(rep.status, 200);
    assert.ok(rep.data.totalRevenue > 0);
    assert.ok(rep.data.totalGst > 0);
    assert.ok(rep.data.expectedDrawerCash >= rep.data.openingCash);
  });

  it('prevents stylist double-booking with 409 Conflict and avoids premature visit inflation', async () => {
    const futureDate = getLocalIsoDate(2);
    const phone = '9819001122';

    const first = await reqJson(port, 'POST', '/api/appointments', {
      client_name: 'Varun Dhawan',
      client_phone: '+91 98190 01122',
      service_name: 'Keratin Silk Smooth',
      stylist_name: 'Priya Verma',
      date: futureDate,
      time: '04:00 PM',
      status: 'Scheduled'
    });
    assert.equal(first.status, 201);
    assert.equal(first.data.client_phone, phone);

    // Scheduled booking must NOT credit visits or spend yet
    const lookup = await reqJson(port, 'GET', `/api/clients/lookup?phone=${phone}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.client.visits, 0);
    assert.equal(lookup.data.client.total_spend, 0);

    // Second booking on exact same stylist + date + time -> 409 Conflict
    const clash = await reqJson(port, 'POST', '/api/appointments', {
      client_name: 'Another Client',
      client_phone: '9819009999',
      service_name: 'Haircut & Beard Sculpt',
      stylist_name: 'Priya Verma',
      date: futureDate,
      time: '04:00 PM',
      status: 'Scheduled'
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.code, 'BOOKING_CONFLICT');

    // Settling the first booking credits client visits, spend, and GST split
    const settled = await reqJson(port, 'PATCH', `/api/appointments/${first.data.id}`, {
      status: 'Completed',
      subtotal: 3800,
      discount: 300,
      price: 3500,
      payment_mode: 'Split',
      payment_split: { UPI: 2000, Cash: 1500 },
      rating: 5
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.data.status, 'Completed');
    assert.equal(settled.data.price, 3500);
    assert.ok(settled.data.cgst > 0 && settled.data.sgst > 0);

    const lookupAfter = await reqJson(port, 'GET', `/api/clients/lookup?phone=${phone}`);
    assert.equal(lookupAfter.data.client.visits, 1);
    assert.equal(lookupAfter.data.client.total_spend, 3500);

    // Deleting a Completed booking reverses visits and spend
    const del = await reqJson(port, 'DELETE', `/api/appointments/${first.data.id}`);
    assert.equal(del.status, 200);
    const lookupDeleted = await reqJson(port, 'GET', `/api/clients/lookup?phone=${phone}`);
    assert.equal(lookupDeleted.data.client.visits, 0);
    assert.equal(lookupDeleted.data.client.total_spend, 0);
  });

  it('supports Services CRUD, Stylists CRUD, Campaigns queue, and GST CSV export', async () => {
    const newSrv = await reqJson(port, 'POST', '/api/services', {
      name: 'Express Blowdry',
      category: 'Styling',
      price: 550,
      duration: 30
    });
    assert.equal(newSrv.status, 201);

    const updSrv = await reqJson(port, 'PATCH', `/api/services/${newSrv.data.id}`, { price: 600 });
    assert.equal(updSrv.status, 200);
    assert.equal(updSrv.data.price, 600);

    const newSty = await reqJson(port, 'POST', '/api/stylists', {
      name: 'Meera Nair',
      role: 'Color Specialist',
      commission_pct: 40
    });
    assert.equal(newSty.status, 201);

    const camp = await reqJson(port, 'POST', '/api/campaigns', {
      name: 'VIP Hair Spa Week',
      segment: 'At risk',
      message: 'Hi {name}, 20% off!'
    });
    assert.equal(camp.status, 201);
    assert.ok(camp.data.recipients.length >= 3);

    const csv = await reqJson(port, 'GET', '/api/reports/gst-csv?period=month');
    assert.equal(csv.status, 200);
    assert.ok(csv.headers['content-type'].includes('text/csv'));
    assert.ok(csv.raw.includes('Invoice No,Date,Client Name'));
    assert.ok(csv.raw.includes('CGST (INR),SGST (INR)'));
  });

  it('enforces Owner PIN on protected routes and disables /api/reset in production', async () => {
    const setPin = await reqJson(port, 'PATCH', '/api/settings', { owner_pin: '4321' });
    assert.equal(setPin.status, 200);
    assert.equal(setPin.data.has_owner_pin, true);
    assert.equal(setPin.data.owner_pin, undefined, 'Must never leak raw PIN in GET/PATCH response');

    // Without PIN -> 401
    const unauth = await reqJson(port, 'PATCH', '/api/settings', { salon_name: 'Hacked' });
    assert.equal(unauth.status, 401);

    // With valid PIN -> 200
    const auth = await reqJson(port, 'PATCH', '/api/settings', { salon_name: 'Jawed Salon Studio' }, { 'X-Owner-Pin': '4321' });
    assert.equal(auth.status, 200);
    assert.equal(auth.data.salon_name, 'Jawed Salon Studio');

    // Reset disabled in production
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodReset = await reqJson(port, 'POST', '/api/reset', null, { 'X-Owner-Pin': '4321' });
      assert.equal(prodReset.status, 403);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });
});
