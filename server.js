const http = require('http');
const fs = require('fs');
const path = require('path');
const { SalonDatabase, DB_PATH } = require('./db/database');

const PORT = process.env.PORT || 3000;
const db = new SalonDatabase(DB_PATH);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const [rawUrl] = req.url.split('?');
  const reqPath = decodeURI(rawUrl);

  // ===================== SQLITE REST API =====================

  // GET /api/services
  if (req.method === 'GET' && reqPath === '/api/services') {
    return sendJson(res, 200, db.getServices());
  }

  // GET /api/stylists
  if (req.method === 'GET' && reqPath === '/api/stylists') {
    return sendJson(res, 200, db.getStylists());
  }

  // GET /api/clients
  if (req.method === 'GET' && reqPath === '/api/clients') {
    return sendJson(res, 200, db.getClients());
  }

  // GET /api/metrics
  if (req.method === 'GET' && reqPath === '/api/metrics') {
    return sendJson(res, 200, db.getMetrics());
  }

  // GET /api/appointments
  if (req.method === 'GET' && reqPath === '/api/appointments') {
    return sendJson(res, 200, db.getAppointments());
  }

  // POST /api/appointments
  if (req.method === 'POST' && reqPath === '/api/appointments') {
    try {
      const payload = await parseBody(req);
      if (!payload.client_name && !payload.clientName) {
        return sendJson(res, 400, { error: 'Client name is required' });
      }

      const created = db.createAppointment({
        client_name: payload.client_name || payload.clientName,
        client_phone: payload.client_phone || payload.clientPhone || '9876543210',
        service_name: payload.service_name || payload.serviceName || 'Signature Haircut',
        stylist_name: payload.stylist_name || payload.stylist || 'Amit Sharma',
        time: payload.time || '03:00 PM',
        date: payload.date || 'Today',
        price: Number(payload.price) || 650,
        payment_mode: payload.payment_mode || payload.paymentMode || 'UPI',
        status: payload.status || 'Confirmed',
        notes: payload.notes || ''
      });

      return sendJson(res, 201, created);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // PATCH /api/appointments/:id
  if (req.method === 'PATCH' && reqPath.startsWith('/api/appointments/')) {
    const id = reqPath.replace('/api/appointments/', '');
    try {
      const updates = await parseBody(req);
      const updated = db.updateAppointment(id, updates);
      if (!updated) {
        return sendJson(res, 404, { error: 'Appointment not found' });
      }
      return sendJson(res, 200, updated);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // DELETE /api/appointments/:id
  if (req.method === 'DELETE' && reqPath.startsWith('/api/appointments/')) {
    const id = reqPath.replace('/api/appointments/', '');
    const success = db.deleteAppointment(id);
    if (!success) {
      return sendJson(res, 404, { error: 'Appointment not found' });
    }
    return sendJson(res, 200, { success: true, deletedId: id });
  }

  // POST /api/reset
  if (req.method === 'POST' && reqPath === '/api/reset') {
    const result = db.reset();
    return sendJson(res, 200, result);
  }

  // ===================== STATIC FILE SERVING =====================
  let targetPath = reqPath === '/' || reqPath === '' ? '/index.html' : reqPath;
  const filePath = path.join(__dirname, targetPath);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(__dirname, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Jawed Salon SQLite SQL database & REST API running at: http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
