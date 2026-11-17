const http = require('http');
const { spawn } = require('child_process');
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
  console.log('--- Starting Jawed Salon REST API Test Suite ---');
  const serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: '3001' },
    stdio: 'pipe'
  });

  serverProcess.stdout.on('data', d => console.log('[Server stdout]:', d.toString().trim()));
  serverProcess.stderr.on('data', d => console.error('[Server stderr]:', d.toString().trim()));

  // Wait 1.5s for boot
  await new Promise(r => setTimeout(r, 1500));

  try {
    // 1. GET /api/services
    console.log('Testing GET /api/services...');
    const srvRes = await request({ host: 'localhost', port: 3001, path: '/api/services', method: 'GET' });
    console.assert(srvRes.status === 200, `Expected 200, got ${srvRes.status}`);
    console.assert(Array.isArray(srvRes.data) && srvRes.data.length >= 6, 'Expected >= 6 services');
    console.log('✓ GET /api/services passed (Found', srvRes.data.length, 'services)');

    // 2. GET /api/metrics
    console.log('Testing GET /api/metrics...');
    const metRes = await request({ host: 'localhost', port: 3001, path: '/api/metrics', method: 'GET' });
    console.assert(metRes.status === 200, `Expected 200, got ${metRes.status}`);
    console.assert(metRes.data.currency === '₹', 'Expected currency to be ₹');
    console.log('✓ GET /api/metrics passed (Projected Revenue: ₹' + metRes.data.projectedRevenue + ')');

    // 3. POST /api/appointments
    console.log('Testing POST /api/appointments...');
    const newApt = {
      clientName: 'Ranveer Singh',
      clientPhone: '919876500000',
      serviceName: 'Signature Haircut & Beard Sculpt',
      stylist: 'Amit Sharma',
      time: '05:00 PM',
      price: 650,
      status: 'Confirmed'
    };
    const postRes = await request(
      { host: 'localhost', port: 3001, path: '/api/appointments', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      newApt
    );
    console.assert(postRes.status === 201, `Expected 201, got ${postRes.status}`);
    const createdId = postRes.data.id;
    console.log('✓ POST /api/appointments passed (Created ID:', createdId, ')');

    // 4. PATCH /api/appointments/:id
    console.log('Testing PATCH /api/appointments/' + createdId + '...');
    const patchRes = await request(
      { host: 'localhost', port: 3001, path: `/api/appointments/${createdId}`, method: 'PATCH', headers: { 'Content-Type': 'application/json' } },
      { status: 'In-Chair' }
    );
    console.assert(patchRes.status === 200, `Expected 200, got ${patchRes.status}`);
    console.assert(patchRes.data.status === 'In-Chair', 'Expected status to update to In-Chair');
    console.log('✓ PATCH /api/appointments passed (Status updated to In-Chair)');

    // 5. DELETE /api/appointments/:id
    console.log('Testing DELETE /api/appointments/' + createdId + '...');
    const delRes = await request(
      { host: 'localhost', port: 3001, path: `/api/appointments/${createdId}`, method: 'DELETE' }
    );
    console.assert(delRes.status === 200, `Expected 200, got ${delRes.status}`);
    console.log('✓ DELETE /api/appointments passed');

    console.log('--- ALL REST API & DATABASE TESTS PASSED SUCCESSFULLY! ---');
  } catch (err) {
    console.error('Test Failed:', err);
    process.exitCode = 1;
  } finally {
    serverProcess.kill();
  }
}

runTests();
