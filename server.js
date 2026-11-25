const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { SalonDatabase, DB_PATH, ConflictError, ValidationError } = require('./db/database');
const { SupabaseSalonDatabase } = require('./db/supabase-db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update(process.env.SUPABASE_KEY || 'salondesk-local-dev-secret-2026').digest('hex');

function signAuthToken({ salonId, username }, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = {
    salonId: String(salonId),
    username: String(username || ''),
    iat: Date.now(),
    exp: Date.now() + ttlMs
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.salonId || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

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
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Owner-Pin, X-Salon-Id, Authorization';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function sendCompressed(res, statusCode, headers, payload, headOnly = false) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  if (!headOnly && res._acceptsGzip && buf.length >= 1024) {
    zlib.gzip(buf, { level: 6 }, (err, gz) => {
      if (err) {
        res.writeHead(statusCode, getSecurityHeaders(headers));
        res.end(buf);
        return;
      }
      res.writeHead(statusCode, getSecurityHeaders({
        ...headers,
        'Content-Encoding': 'gzip',
        'Vary': headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding'
      }));
      res.end(gz);
    });
    return;
  }
  res.writeHead(statusCode, getSecurityHeaders(headers));
  res.end(headOnly ? undefined : buf);
}

function sendJson(res, statusCode, data) {
  sendCompressed(res, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, JSON.stringify(data));
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

function sanitizeSettingsForClient(settings = {}) {
  const { owner_pin, ...safe } = settings;
  return {
    ...safe,
    has_owner_pin: Boolean(owner_pin && owner_pin.length > 0)
  };
}

async function checkOwnerPin(req, db, salonId) {
  const isSupabase = db instanceof SupabaseSalonDatabase;
  const settings = isSupabase ? await db.getSettings(salonId) : db.getSettings();
  if (!settings || !settings.owner_pin) return true;
  const provided = String(req.headers['x-owner-pin'] || '').trim();
  return provided === settings.owner_pin;
}

function createAppServer(dbOption = null) {
  const opts = (dbOption && typeof dbOption === 'object' && !Array.isArray(dbOption))
    ? dbOption
    : { dbPath: dbOption };
  const dbPathOpt = opts.dbPath || null;
  // If explicitly passed an SQLite path or in test mode without Supabase, use SQLite
  const useSqlite = dbPathOpt && typeof dbPathOpt === 'string' && !dbPathOpt.startsWith('http');
  const db = useSqlite ? new SalonDatabase(dbPathOpt) : new SupabaseSalonDatabase();
  const isSupabase = db instanceof SupabaseSalonDatabase;
  const requireAuth = Boolean(opts.requireAuth || isSupabase);

  const server = http.createServer(async (req, res) => {
    res._acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    try {
      // Handle CORS preflight cleanly
      if (req.method === 'OPTIONS') {
        res.writeHead(204, getSecurityHeaders({
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN || '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Pin, X-Salon-Id, Authorization'
        }));
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
      let salonId = String(req.headers['x-salon-id'] || query.salon_id || 'genzee').trim();

      // ===================== REST API =====================
      if (reqPath.startsWith('/api/')) {
        // Health check (public)
        if (req.method === 'GET' && reqPath === '/api/health') {
          return sendJson(res, 200, {
            status: 'ok',
            engine: isSupabase ? 'supabase:postgres' : 'node:sqlite',
            timestamp: new Date().toISOString()
          });
        }

        // Auth: Login (public)
        if (req.method === 'POST' && reqPath === '/api/auth/login') {
          const body = await parseBody(req);
          if (isSupabase) {
            const auth = await db.authSalon(body.username || body.phone, body.password);
            const signedToken = signAuthToken({ salonId: auth.salon.id, username: auth.salon.username });
            return sendJson(res, 200, { token: signedToken, salon: auth.salon });
          }
          const devSalonId = String(body.username || body.salon_id || 'genzee').trim() || 'genzee';
          const signedToken = signAuthToken({ salonId: devSalonId, username: devSalonId });
          return sendJson(res, 200, {
            token: signedToken,
            salon: { id: devSalonId, name: 'SalonDesk Studio', branch: 'Local Counter', phone: devSalonId }
          });
        }

        // Enforce cryptographically signed Bearer token in production / auth-enabled mode
        if (requireAuth) {
          const authHeader = String(req.headers.authorization || '');
          const match = authHeader.match(/^Bearer\s+(.+)$/i);
          const tokenPayload = match ? verifyAuthToken(match[1].trim()) : null;
          if (!tokenPayload) {
            return sendError(res, 401, 'Authentication required. Please sign in.', 'AUTH_REQUIRED');
          }
          // Bind tenant cryptographically from verified token (prevents X-Salon-Id spoofing)
          salonId = tokenPayload.salonId;
        }

        // Auth: Me
        if (req.method === 'GET' && reqPath === '/api/auth/me') {
          if (isSupabase) {
            const salon = await db.getSalon(salonId);
            return salon ? sendJson(res, 200, { salon }) : sendError(res, 404, 'Salon not found', 'NOT_FOUND');
          }
          return sendJson(res, 200, { salon: { id: 'genzee', name: 'GENZEE UNISEX Hair & Beauty Lounge' } });
        }

        // Dashboard aggregate
        if (req.method === 'GET' && reqPath === '/api/dashboard') {
          const data = isSupabase ? await db.getDashboard(salonId) : db.getDashboard();
          data.settings = sanitizeSettingsForClient(data.settings);
          return sendJson(res, 200, data);
        }

        // Legacy/summary metrics
        if (req.method === 'GET' && reqPath === '/api/metrics') {
          if (isSupabase) {
            const dash = await db.getDashboard(salonId);
            return sendJson(res, 200, {
              date: dash.date,
              totalRevenue: dash.todayRevenue,
              completed: dash.completedCount,
              currency: '₹',
              dbEngine: 'Supabase PostgreSQL (Mumbai ap-south-1)'
            });
          }
          return sendJson(res, 200, db.getMetrics());
        }

        // Services CRUD
        if (req.method === 'GET' && reqPath === '/api/services') {
          const data = isSupabase ? await db.getServices(salonId, query.all === '1') : db.getServices(query.all === '1');
          return sendJson(res, 200, data);
        }
        if (req.method === 'POST' && reqPath === '/api/services') {
          const body = await parseBody(req);
          const created = isSupabase ? await db.createService(salonId, body) : db.createService(body);
          return sendJson(res, 201, created);
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/services/')) {
          const id = reqPath.slice('/api/services/'.length);
          const body = await parseBody(req);
          const updated = isSupabase ? await db.updateService(salonId, id, body) : db.updateService(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Service not found', 'NOT_FOUND');
        }
        if (req.method === 'DELETE' && reqPath.startsWith('/api/services/')) {
          const pinOk = await checkOwnerPin(req, db, salonId);
          if (!pinOk) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          const id = reqPath.slice('/api/services/'.length);
          const ok = isSupabase ? await db.deleteService(salonId, id) : db.deleteService(id);
          return ok ? sendJson(res, 200, { success: true, id }) : sendError(res, 404, 'Service not found', 'NOT_FOUND');
        }

        // Stylists CRUD + Period Performance
        if (req.method === 'GET' && reqPath === '/api/stylists') {
          const period = ['today', 'week', 'month'].includes(query.period) ? query.period : 'month';
          const data = isSupabase ? await db.getStylists(salonId, period) : db.getStylists(period);
          return sendJson(res, 200, data);
        }
        if (req.method === 'POST' && reqPath === '/api/stylists') {
          const body = await parseBody(req);
          const created = isSupabase ? await db.createStylist(salonId, body) : db.createStylist(body);
          return sendJson(res, 201, created);
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/stylists/')) {
          const id = reqPath.slice('/api/stylists/'.length);
          const body = await parseBody(req);
          const updated = isSupabase ? await db.updateStylist(salonId, id, body) : db.updateStylist(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Stylist not found', 'NOT_FOUND');
        }

        // Clients
        if (req.method === 'GET' && reqPath === '/api/clients/lookup') {
          const client = isSupabase ? await db.getClientByPhone(salonId, query.phone || '') : db.getClientByPhone(query.phone || '');
          return sendJson(res, 200, { client });
        }
        if (req.method === 'GET' && reqPath === '/api/clients') {
          const data = isSupabase ? await db.getClients(salonId, { search: query.search, tier: query.tier }) : db.getClients({ search: query.search, tier: query.tier });
          return sendJson(res, 200, data);
        }
        if (req.method === 'GET' && reqPath.startsWith('/api/clients/')) {
          const id = reqPath.slice('/api/clients/'.length);
          const client = isSupabase ? await db.getClientById(salonId, id) : db.getClientById(id);
          return client ? sendJson(res, 200, client) : sendError(res, 404, 'Client not found', 'NOT_FOUND');
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/clients/')) {
          const id = reqPath.slice('/api/clients/'.length);
          const body = await parseBody(req);
          const updated = isSupabase ? await db.updateClient(salonId, id, body) : db.updateClient(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Client not found', 'NOT_FOUND');
        }

        // Appointments CRUD + Lifecycle
        if (req.method === 'GET' && reqPath === '/api/appointments') {
          const data = isSupabase ? await db.getAppointments(salonId, {
            date: query.date,
            status: query.status,
            search: query.search
          }) : db.getAppointments({
            date: query.date,
            status: query.status,
            search: query.search
          });
          return sendJson(res, 200, data);
        }
        if (req.method === 'POST' && reqPath === '/api/appointments') {
          const body = await parseBody(req);
          const created = isSupabase ? await db.createAppointment(salonId, body) : db.createAppointment(body);
          return sendJson(res, 201, created);
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/appointments/')) {
          const id = reqPath.slice('/api/appointments/'.length);
          const body = await parseBody(req);
          const updated = isSupabase ? await db.updateAppointment(salonId, id, body) : db.updateAppointment(id, body);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Appointment not found', 'NOT_FOUND');
        }
        if (req.method === 'DELETE' && reqPath.startsWith('/api/appointments/')) {
          const pinOk = await checkOwnerPin(req, db, salonId);
          if (!pinOk) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          const id = reqPath.slice('/api/appointments/'.length);
          const ok = isSupabase ? await db.deleteAppointment(salonId, id) : db.deleteAppointment(id);
          return ok ? sendJson(res, 200, { success: true, deletedId: id }) : sendError(res, 404, 'Appointment not found', 'NOT_FOUND');
        }

        // Campaigns
        if (req.method === 'GET' && reqPath === '/api/campaigns') {
          const data = isSupabase ? await db.getCampaigns(salonId) : db.getCampaigns();
          return sendJson(res, 200, data);
        }
        if (req.method === 'POST' && reqPath === '/api/campaigns') {
          const body = await parseBody(req);
          const created = isSupabase ? await db.createCampaign(salonId, body) : db.createCampaign(body);
          return sendJson(res, 201, created);
        }
        if (req.method === 'PATCH' && reqPath.startsWith('/api/campaigns/')) {
          const id = reqPath.slice('/api/campaigns/'.length);
          const body = await parseBody(req);
          const updated = isSupabase ? await db.markCampaignSent(salonId, id, body.sent_count) : db.markCampaignSent(id, body.sent_count);
          return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'Campaign not found', 'NOT_FOUND');
        }

        // Reports & GST CSV Export
        if (req.method === 'GET' && reqPath === '/api/reports') {
          const period = ['day', 'week', 'month'].includes(query.period) ? query.period : 'month';
          const data = isSupabase ? await db.getReports(salonId, period) : db.getReports(period);
          return sendJson(res, 200, data);
        }
        if (req.method === 'GET' && reqPath === '/api/reports/gst-csv') {
          const period = ['day', 'week', 'month'].includes(query.period) ? query.period : 'month';
          const csv = isSupabase ? await db.exportGstCsv(salonId, period) : db.exportGstCsv(period);
          const filename = `salon-${salonId}-gst-audit-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
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
          const data = isSupabase ? await db.getSettings(salonId) : db.getSettings();
          return sendJson(res, 200, sanitizeSettingsForClient(data));
        }
        if (req.method === 'PATCH' && reqPath === '/api/settings') {
          const pinOk = await checkOwnerPin(req, db, salonId);
          if (!pinOk) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
          const body = await parseBody(req);
          const updated = isSupabase ? await db.updateSettings(salonId, body) : db.updateSettings(body);
          return sendJson(res, 200, sanitizeSettingsForClient(updated));
        }

        // Dev-only Reset
        if (req.method === 'POST' && reqPath === '/api/reset') {
          if (process.env.NODE_ENV === 'production' || isSupabase) {
            return sendError(res, 403, 'Database reset is disabled in production / cloud mode', 'FORBIDDEN');
          }
          const pinOk = await checkOwnerPin(req, db, salonId);
          if (!pinOk) return sendError(res, 401, 'Owner PIN required', 'PIN_REQUIRED');
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
            sendCompressed(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, content, req.method === 'HEAD');
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
          sendCompressed(res, 200, {
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
          }, content, req.method === 'HEAD');
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
  const server = createAppServer();
  server.listen(PORT, () => {
    const isSupabase = server.db instanceof SupabaseSalonDatabase;
    console.log(`Salon OS running at: http://localhost:${PORT}`);
    console.log(`Database engine: ${isSupabase ? 'Supabase PostgreSQL (Mumbai)' : 'Native SQLite'}`);
    console.log(`Public root: ${PUBLIC_DIR}`);
  });

  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}, shutting down cleanly...`);
    server.close(() => {
      try { if (server.db.close) server.db.close(); } catch (_) {}
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createAppServer };
