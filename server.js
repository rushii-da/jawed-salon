const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SalonDatabase, DB_PATH, ConflictError, ValidationError } = require('./db/database');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function getSecurityHeaders(extra = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra
  };
  if (ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Owner-Pin';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, getSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }));
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, code = 'ERROR') {
  sendJson(res, statusCode, { error: message, code });
}

function parseBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new ValidationError('Request payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new ValidationError('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeSettingsForClient(settings) {
  const { owner_pin, ...safe } = settings;
  return {
    ...safe,
    has_owner_pin: Boolean(owner_pin && owner_pin.length > 0)
  };
}

function checkOwnerPin(req, db) {
  const settings = db.getSettings();
  if (!settings.owner_pin) return true;
  const provided = String(req.headers['x-owner-pin'] || '').trim();
  return provided === settings.owner_pin;
}

function createAppServer(dbPath = DB_PATH) {
  const db = new SalonDatabase(dbPath);

  const server = http.createServer(async (req, res) => {
    try {
      // Handle CORS preflight cleanly
      if (req.method === 'OPTIONS') {
        res.writeHead(204, getSecurityHeaders());
        res.end();
        return;
      }

      let parsedUrl;
      let reqPath;
      try {
        parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        reqPath = decodeURIComponent(parsedUrl.pathname);
      } catch (_) {
        return sendError(res, 400, 'Malformed request URL', 'BAD_URL');
      }

      const query = Object.fromEntries(parsedUrl.searchParams.entries());

      // ===================== REST API =====================
      if (reqPath.startsWith('/api/')) {
        // Health check
        if (req.method === 'GET' && reqPath === '/api/health') {
          return sendJson(res, 200, { status: 'ok', engine: 'node:sqlite', timestamp: new Date().toISOString() });
        }

        // Dashboard aggregate
        if (req.method === 'GET' && reqPath === '/api/dashboard') {
          const data = db.getDashboard();
          data.settings = sanitizeSettingsForClient(data.settings);
          return sendJson(res, 200, data);
        }

        // Legacy/summary metrics
        if (req.method === 'GET' && reqPath === '/api/metrics') {
          return sendJson(res, 200, db.getMetrics());
        }

        // Services CRUD
        if (req.method === 'GET' && reqPath === '/api/services') {
          return sendJson(res, 200, db.getServices(query.all === '1'));
        }
        if (req.method === 'POST' && reqPath === '/api/services') {
          const body = await parseBody(req);
          return sendJson(res, 201, db.createService(body));
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/services/')) {
          const id = reqPath.slice('/api/services/'.length);
          const body = await parseBody(req);
          const updated = db.updateService(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Service not found', 'NOT_FOUND');
        }
        if (req.method === 'DELETE' && reqPath.startsWith('/api/services/')) {
          if (!checkOwnerPin(req, db)) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          const id = reqPath.slice('/api/services/'.length);
          const ok = db.deleteService(id);
          return ok ? sendJson(res, 200, { success: true, id }) : sendError(res, 404, 'Service not found', 'NOT_FOUND');
        }

        // Stylists CRUD + Period Performance
        if (req.method === 'GET' && reqPath === '/api/stylists') {
          const period = ['today', 'week', 'month'].includes(query.period) ? query.period : 'month';
          return sendJson(res, 200, db.getStylists(period));
        }
        if (req.method === 'POST' && reqPath === '/api/stylists') {
          const body = await parseBody(req);
          return sendJson(res, 201, db.createStylist(body));
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/stylists/')) {
          const id = reqPath.slice('/api/stylists/'.length);
          const body = await parseBody(req);
          const updated = db.updateStylist(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Stylist not found', 'NOT_FOUND');
        }

        // Clients
        if (req.method === 'GET' && reqPath === '/api/clients/lookup') {
          const client = db.getClientByPhone(query.phone || '');
          return sendJson(res, 200, { client });
        }
        if (req.method === 'GET' && reqPath === '/api/clients') {
          return sendJson(res, 200, db.getClients({ search: query.search, tier: query.tier }));
        }
        if (req.method === 'GET' && reqPath.startsWith('/api/clients/')) {
          const id = reqPath.slice('/api/clients/'.length);
          const client = db.getClientById(id);
          return client ? sendJson(res, 200, client) : sendError(res, 404, 'Client not found', 'NOT_FOUND');
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/clients/')) {
          const id = reqPath.slice('/api/clients/'.length);
          const body = await parseBody(req);
          const updated = db.updateClient(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Client not found', 'NOT_FOUND');
        }

        // Appointments CRUD + Lifecycle
        if (req.method === 'GET' && reqPath === '/api/appointments') {
          return sendJson(res, 200, db.getAppointments({
            date: query.date,
            status: query.status,
            search: query.search
          }));
        }
        if (req.method === 'POST' && reqPath === '/api/appointments') {
          const body = await parseBody(req);
          const created = db.createAppointment(body);
          return sendJson(res, 201, created);
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/appointments/')) {
          const id = reqPath.slice('/api/appointments/'.length);
          const body = await parseBody(req);
          const updated = db.updateAppointment(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Appointment not found', 'NOT_FOUND');
        }
        if (req.method === 'DELETE' && reqPath.startsWith('/api/appointments/')) {
          if (!checkOwnerPin(req, db)) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          const id = reqPath.slice('/api/appointments/'.length);
          const ok = db.deleteAppointment(id);
          return ok ? sendJson(res, 200, { success: true, deletedId: id }) : sendError(res, 404, 'Appointment not found', 'NOT_FOUND');
        }

        // Campaigns
        if (req.method === 'GET' && reqPath === '/api/campaigns') {
          return sendJson(res, 200, db.getCampaigns());
        }
        if (req.method === 'POST' && reqPath === '/api/campaigns') {
          const body = await parseBody(req);
          return sendJson(res, 201, db.createCampaign(body));
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/campaigns/')) {
          const id = reqPath.slice('/api/campaigns/'.length);
          const body = await parseBody(req);
          const updated = db.markCampaignSent(id, body.sent_count);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Campaign not found', 'NOT_FOUND');
        }

        // Reports & GST CSV Export
        if (req.method === 'GET' && reqPath === '/api/reports') {
          const period = ['day', 'week', 'month'].includes(query.period) ? query.period : 'month';
          return sendJson(res, 200, db.getReports(period));
        }
        if (req.method === 'GET' && reqPath === '/api/reports/gst-csv') {
          const period = ['day', 'week', 'month'].includes(query.period) ? query.period : 'month';
          const csv = db.exportGstCsv(period);
          const filename = `jawed-salon-gst-audit-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
          res.writeHead(200, getSecurityHeaders({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store'
          }));
          res.end(csv);
          return;
        }

        // Settings
        if (req.method === 'GET' && reqPath === '/api/settings') {
          return sendJson(res, 200, sanitizeSettingsForClient(db.getSettings()));
        }
        if (req.method === 'PATCH' && reqPath === '/api/settings') {
          if (!checkOwnerPin(req, db)) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          const body = await parseBody(req);
          const updated = db.updateSettings(body);
          return sendJson(res, 200, sanitizeSettingsForClient(updated));
        }

        // Dev-only Reset
        if (req.method === 'POST' && reqPath === '/api/reset') {
          if (process.env.NODE_ENV === 'production') {
            return sendError(res, 403, 'Database reset is disabled in production', 'FORBIDDEN');
          }
          if (!checkOwnerPin(req, db)) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          return sendJson(res, 200, db.reset());
        }

        return sendError(res, 404, `API route not found: ${req.method} ${reqPath}`, 'NOT_FOUND');
      }

      // ===================== STRICT PUBLIC STATIC SERVING =====================
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
      }

      // Block dotfiles & any sensitive backend paths explicitly
      const normalizedRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
      if (
        normalizedRel.split('/').some(seg => seg.startsWith('.') || seg === '..') ||
        /\.(db|db-wal|db-shm|sqlite|env|bat|sh)$/i.test(normalizedRel)
      ) {
        res.writeHead(404, getSecurityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end('404 Not Found');
        return;
      }

      const resolvedPath = path.resolve(PUBLIC_DIR, normalizedRel);
      if (resolvedPath !== PUBLIC_DIR && !resolvedPath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403, getSecurityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end('403 Forbidden');
        return;
      }

      fs.stat(resolvedPath, (err, stats) => {
        // Only serve SPA index.html for extensionless navigation routes; return 404 for missing files (.js, .css, .db, etc.)
        if (err || !stats.isFile()) {
          if (path.extname(normalizedRel)) {
            res.writeHead(404, getSecurityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('404 Not Found');
            return;
          }
          const indexPath = path.join(PUBLIC_DIR, 'index.html');
          fs.readFile(indexPath, (readErr, content) => {
            if (readErr) {
              res.writeHead(500, getSecurityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
              res.end('500 Internal Server Error');
              return;
            }
            res.writeHead(200, getSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
            res.end(req.method === 'HEAD' ? undefined : content);
          });
          return;
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        fs.readFile(resolvedPath, (readErr, content) => {
          if (readErr) {
            res.writeHead(500, getSecurityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('500 Internal Server Error');
            return;
          }
          res.writeHead(200, getSecurityHeaders({
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
          }));
          res.end(req.method === 'HEAD' ? undefined : content);
        });
      });
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ConflictError) {
        return sendError(res, err.statusCode, err.message, err.code);
      }
      console.error('[Server Error]:', err);
      return sendError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  server.db = db;
  return server;
}

if (require.main === module) {
  const server = createAppServer(DB_PATH);
  server.listen(PORT, () => {
    console.log(`Jawed Salon OS running at: http://localhost:${PORT}`);
    console.log(`Public root: ${PUBLIC_DIR}`);
    console.log(`Database file: ${DB_PATH}`);
  });

  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}, shutting down cleanly...`);
    server.close(() => {
      try { server.db.close(); } catch (_) {}
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createAppServer };
