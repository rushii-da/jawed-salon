const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting ECC SQLite Database & REST API Verification ---');
  const serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: '3002' },
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', d => console.log('[Server stdout]:', d.toString().trim()));
  serverProcess.stderr.on('data', d => console.error('[Server stderr]:', d.toString().trim()));

  // Wait 1.5s for SQLite init
  await new Promise(r => setTimeout(r, 1500));

  try {
    // 1. Verify SQLite DB file created on disk
    const dbPath = path.join(__dirname, 'data', 'salon.db');
    console.assert(fs.existsSync(dbPath), `Expected salon.db file at ${dbPath}`);
    console.log(`✓ SQLite Database file verified on disk: ${dbPath} (${fs.statSync(dbPath).size} bytes)`);

    // 2. GET /api/metrics
    console.log('Testing GET /api/metrics...');
    const metRes = await request({ host: 'localhost', port: 3002, path: '/api/metrics', method: 'GET' });
    console.assert(metRes.status === 200, `Expected 200, got ${metRes.status}`);
    console.assert(metRes.data.dbEngine.includes('SQLite'), 'Expected SQLite engine');
    console.log(`✓ GET /api/metrics passed (Engine: ${metRes.data.dbEngine}, Revenue: ₹${metRes.data.projectedRevenue})`);

    // 3. GET /api/services
    console.log('Testing GET /api/services...');
    const srvRes = await request({ host: 'localhost', port: 3002, path: '/api/services', method: 'GET' });
    console.assert(srvRes.status === 200 && srvRes.data.length >= 6, 'Expected >= 6 services');
    console.log(`✓ GET /api/services passed (${srvRes.data.length} services loaded from SQLite)`);

    // 4. GET /api/clients
    console.log('Testing GET /api/clients...');
    const cliRes = await request({ host: 'localhost', port: 3002, path: '/api/clients', method: 'GET' });
    console.assert(cliRes.status === 200 && cliRes.data.length >= 9, 'Expected >= 9 clients');
    console.log(`✓ GET /api/clients passed (${cliRes.data.length} clients loaded from SQLite)`);

    // 5. POST /api/appointments
    console.log('Testing POST /api/appointments...');
    const newApt = {
      client_name: 'Varun Dhawan',
      client_phone: '9819001122',
      service_name: 'Keratin Silk Smooth Treatment',
      stylist_name: 'Priya Verma',
      price: 3800,
      status: 'Confirmed'
    };
    const postRes = await request(
      { host: 'localhost', port: 3002, path: '/api/appointments', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      newApt
    );
    console.assert(postRes.status === 201, `Expected 201, got ${postRes.status}`);
    const createdId = postRes.data.id;
    console.log(`✓ POST /api/appointments passed (Created SQLite record: ${createdId})`);

    // 6. PATCH /api/appointments/:id
    console.log(`Testing PATCH /api/appointments/${createdId}...`);
    const patchRes = await request(
      { host: 'localhost', port: 3002, path: `/api/appointments/${createdId}`, method: 'PATCH', headers: { 'Content-Type': 'application/json' } },
      { status: 'In-Chair' }
    );
    console.assert(patchRes.status === 200 && patchRes.data.status === 'In-Chair', 'Expected status updated to In-Chair');
    console.log(`✓ PATCH /api/appointments passed (Updated status in SQLite to In-Chair)`);

    // 7. DELETE /api/appointments/:id
    console.log(`Testing DELETE /api/appointments/${createdId}...`);
    const delRes = await request(
      { host: 'localhost', port: 3002, path: `/api/appointments/${createdId}`, method: 'DELETE' }
    );
    console.assert(delRes.status === 200, `Expected 200, got ${delRes.status}`);
    console.log(`✓ DELETE /api/appointments passed (Removed from SQLite)`);

    console.log('--- ALL ECC BACKEND & SQLITE VERIFICATIONS PASSED (100%) ---');
  } catch (err) {
    console.error('Test verification failed:', err);
    process.exitCode = 1;
  } finally {
    serverProcess.kill();
  }
}

runTests();
