const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Auto-load .env if available
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath) && process.loadEnvFile) {
  try { process.loadEnvFile(envPath); } catch (_) {}
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thkcugmgzrlwdriyltpn.supabase.co';
const DEFAULT_KEY_B64 = 'c2Jfc2VjcmV0X1J3bG5BX28zSWpwMFJqZXFseUVmVXdfTW5sd1RVQ3g=';
const SUPABASE_KEY = process.env.SUPABASE_KEY || Buffer.from(DEFAULT_KEY_B64, 'base64').toString('utf-8');

const VALID_STATUSES = ['Scheduled', 'Confirmed', 'In-Chair', 'Completed', 'Cancelled', 'No-Show'];
const VALID_PAYMENT_MODES = ['UPI', 'Cash', 'Card', 'Split'];
const ACTIVE_BOOKING_STATUSES = ['Scheduled', 'Confirmed', 'In-Chair'];

function getLocalIsoDate(offsetDays = 0) {
  // Always compute date in India Standard Time (UTC+05:30) so cloud UTC servers don't drift around midnight IST
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  nowIst.setUTCDate(nowIst.getUTCDate() + offsetDays);
  return nowIst.toISOString().slice(0, 10);
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  return digits.slice(-10);
}

function daysBetweenIso(fromIso, toIso = getLocalIsoDate(0)) {
  if (!fromIso || !/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) return 0;
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);
  const diff = Math.round((to - from) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

function computeTier(visits, totalSpend, daysAgo) {
  if (daysAgo >= 30) return 'At risk';
  if (visits >= 5 || totalSpend >= 10000) return 'VIP';
  if (visits >= 2) return 'Returning';
  return 'New';
}

function computeGstBreakdown(grandTotal, gstRate = 18) {
  const total = Math.max(0, Number(grandTotal) || 0);
  const rate = Math.max(0, Number(gstRate) || 0);
  if (rate === 0) {
    return { taxableValue: total, cgst: 0, sgst: 0, totalTax: 0 };
  }
  const taxableValue = +(total / (1 + rate / 100)).toFixed(2);
  const totalTax = +(total - taxableValue).toFixed(2);
  const cgst = +(totalTax / 2).toFixed(2);
  const sgst = +(totalTax - cgst).toFixed(2);
  return { taxableValue, cgst, sgst, totalTax };
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
    this.code = 'BOOKING_CONFLICT';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_ERROR';
  }
}

class SupabaseSalonDatabase {
  constructor(url = SUPABASE_URL, key = SUPABASE_KEY) {
    this.url = url;
    this.key = key;
    this.client = createClient(url, key, {
      auth: { persistSession: false }
    });
    this._cache = new Map();
    this._inflight = new Map();
    this._cacheTtlMs = 30_000;
  }

  /**
   * Read-through cache + in-flight request deduplication scoped by salonId.
   */
  async cached(key, fn) {
    const hit = this._cache.get(key);
    if (hit && Date.now() < hit.expiresAt) {
      return hit.value;
    }
    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }
    const promise = (async () => {
      try {
        const value = await fn();
        this._cache.set(key, { value, expiresAt: Date.now() + this._cacheTtlMs });
        return value;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, promise);
    return promise;
  }

  invalidateCache(salonId) {
    const marker = `:${salonId}:`;
    for (const k of this._cache.keys()) {
      if (k.includes(marker) || k.endsWith(`:${salonId}`)) {
        this._cache.delete(k);
      }
    }
  }

  /**
   * Automatically paginates Supabase queries to bypass the PostgREST 1,000-row limit.
   */
  async fetchAll(buildQuery, pageSize = 1000) {
    const all = [];
    let from = 0;
    while (true) {
      const q = buildQuery(this.client).range(from, from + pageSize - 1);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  // ===================== AUTH & SALON PROFILE =====================
  sanitizeSalonRecord(salon) {
    if (!salon) return null;
    const { password_hash, owner_pin, ...safe } = salon;
    return {
      ...safe,
      has_owner_pin: Boolean(owner_pin && String(owner_pin).length > 0)
    };
  }

  async authSalon(username, password) {
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();
    if (!cleanUser || !cleanPass) {
      throw new ValidationError('Username and password are required');
    }

    const { data: salon, error } = await this.client
      .from('salons')
      .select('*')
      .eq('username', cleanUser)
      .maybeSingle();

    if (error || !salon) {
      throw new ValidationError('Invalid username or password');
    }

    const hash = crypto.createHash('sha256').update(cleanPass).digest('hex');
    if (salon.password_hash !== hash) {
      throw new ValidationError('Invalid username or password');
    }

    const token = crypto.randomBytes(24).toString('hex');
    return { token, salon: this.sanitizeSalonRecord(salon) };
  }

  async getSalonRaw(salonId) {
    return this.cached(`salonRaw:${salonId}`, async () => {
      const { data, error } = await this.client
        .from('salons')
        .select('*')
        .eq('id', salonId)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    });
  }

  async getSalon(salonId) {
    const raw = await this.getSalonRaw(salonId);
    return this.sanitizeSalonRecord(raw);
  }

  async getSettings(salonId) {
    const salon = await this.getSalonRaw(salonId);
    if (!salon) return {};
    return {
      salon_name: salon.name,
      branch_name: salon.branch,
      phone: salon.phone,
      gstin: salon.gstin || '',
      gst_rate: String(salon.gst_rate || 18),
      sac_code: salon.sac_code || '999722',
      opening_cash: String(salon.opening_cash || 5000),
      owner_pin: salon.owner_pin || ''
    };
  }

  async updateSettings(salonId, updates) {
    const patch = {};
    if (updates.salon_name !== undefined) patch.name = String(updates.salon_name).trim();
    if (updates.branch_name !== undefined) patch.branch = String(updates.branch_name).trim();
    if (updates.phone !== undefined) patch.phone = String(updates.phone).trim();
    if (updates.gstin !== undefined) patch.gstin = String(updates.gstin).trim();
    if (updates.gst_rate !== undefined) patch.gst_rate = Number(updates.gst_rate) || 18;
    if (updates.sac_code !== undefined) patch.sac_code = String(updates.sac_code).trim();
    if (updates.opening_cash !== undefined) patch.opening_cash = Number(updates.opening_cash) || 5000;
    if (updates.owner_pin !== undefined) patch.owner_pin = String(updates.owner_pin).trim();
    patch.updated_at = new Date().toISOString();

    const { error } = await this.client
      .from('salons')
      .update(patch)
      .eq('id', salonId);
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return this.getSettings(salonId);
  }

  // ===================== SERVICES =====================
  async getServices(salonId, includeInactive = false) {
    return this.cached(`services:${salonId}:${includeInactive ? 1 : 0}`, async () => {
      let q = this.client
        .from('services')
        .select('*')
        .eq('salon_id', salonId);
      if (!includeInactive) {
        q = q.eq('active', 1);
      }
      const { data, error } = await q.order('popular', { ascending: false }).order('price', { ascending: true });
      if (error) throw new Error(error.message);
      return data || [];
    });
  }

  async createService(salonId, payload) {
    const name = String(payload.name || '').trim();
    const price = Number(payload.price);
    const duration = Number(payload.duration || 45);
    if (!name) throw new ValidationError('Service name is required');
    if (!Number.isFinite(price) || price < 0) throw new ValidationError('Valid non-negative price is required');
    if (!Number.isFinite(duration) || duration <= 0) throw new ValidationError('Valid duration in minutes is required');

    const id = 'srv-' + crypto.randomUUID().slice(0, 8);
    const row = {
      id,
      salon_id: salonId,
      name,
      category: String(payload.category || 'Hair & Grooming').trim(),
      price,
      duration: Math.round(duration),
      popular: payload.popular ? 1 : 0,
      active: 1
    };

    const { data, error } = await this.client
      .from('services')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return data;
  }

  async updateService(salonId, id, updates) {
    const patch = {};
    if (updates.name !== undefined) patch.name = String(updates.name).trim();
    if (updates.category !== undefined) patch.category = String(updates.category).trim();
    if (updates.price !== undefined) {
      const p = Number(updates.price);
      if (!Number.isFinite(p) || p < 0) throw new ValidationError('Price must be non-negative');
      patch.price = p;
    }
    if (updates.duration !== undefined) {
      const d = Number(updates.duration);
      if (!Number.isFinite(d) || d <= 0) throw new ValidationError('Duration must be positive');
      patch.duration = Math.round(d);
    }
    if (updates.popular !== undefined) patch.popular = updates.popular ? 1 : 0;
    if (updates.active !== undefined) patch.active = updates.active ? 1 : 0;

    const { data, error } = await this.client
      .from('services')
      .update(patch)
      .eq('salon_id', salonId)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return data;
  }

  async deleteService(salonId, id) {
    const { error } = await this.client
      .from('services')
      .update({ active: 0 })
      .eq('salon_id', salonId)
      .eq('id', id);
    if (!error) this.invalidateCache(salonId);
    return !error;
  }

  // ===================== STYLISTS =====================
  computeStylistsMetrics(stylists, allApts, clients, period, startDate, today) {
    const last7Dates = [];
    for (let i = -6; i <= 0; i++) last7Dates.push(getLocalIsoDate(i));

    const clientVisitsMap = new Map((clients || []).map(c => [c.phone, Number(c.visits || 0)]));
    const periodApts = (allApts || []).filter(a => a.date >= startDate && a.date <= today);

    return (stylists || []).map(st => {
      const mine = periodApts.filter(a => a.stylist_id === st.id || a.stylist_name === st.name);
      const revenue = mine.reduce((s, a) => s + Number(a.price || 0), 0);
      const clientsServed = mine.length;
      const avgTicket = clientsServed ? Math.round(revenue / clientsServed) : 0;
      const rated = mine.filter(a => a.rating != null);
      const liveRating = rated.length
        ? +(rated.reduce((s, a) => s + Number(a.rating), 0) / rated.length).toFixed(2)
        : st.rating;
      const commissionEarned = Math.round(revenue * (Number(st.commission_pct || 35) / 100));

      const uniquePhones = [...new Set(mine.map(a => a.client_phone))];
      const repeatCount = uniquePhones.filter(ph => (clientVisitsMap.get(ph) || 0) > 1).length;
      const retentionPct = uniquePhones.length ? Math.round((repeatCount / uniquePhones.length) * 100) : 0;

      const weeklyCounts = last7Dates.map(d =>
        (allApts || []).filter(a => (a.stylist_id === st.id || a.stylist_name === st.name) && a.date === d).length
      );

      return {
        ...st,
        period,
        clients_served: clientsServed,
        revenue,
        avg_ticket: avgTicket,
        commission_earned: commissionEarned,
        retention_pct: retentionPct,
        live_rating: liveRating,
        weekly_counts: weeklyCounts
      };
    }).sort((a, b) => b.revenue - a.revenue);
  }

  async getStylists(salonId, period = 'month') {
    return this.cached(`stylists:${salonId}:${period}`, async () => {
      const today = getLocalIsoDate(0);
      const startDate = period === 'today' ? today : period === 'week' ? getLocalIsoDate(-6) : getLocalIsoDate(-29);
      const weekStart = getLocalIsoDate(-6);
      const fetchStart = startDate < weekStart ? startDate : weekStart;

      const [stylistsRes, apts, clients] = await Promise.all([
        this.client
          .from('stylists')
          .select('*')
          .eq('salon_id', salonId)
          .eq('active', 1)
          .order('rating', { ascending: false }),
        this.fetchAll(c =>
          c.from('appointments')
            .select('stylist_id, stylist_name, price, rating, client_phone, date')
            .eq('salon_id', salonId)
            .eq('status', 'Completed')
            .gte('date', fetchStart)
            .lte('date', today)
        ),
        this.getClients(salonId)
      ]);

      if (stylistsRes.error) throw new Error(stylistsRes.error.message);
      return this.computeStylistsMetrics(stylistsRes.data, apts, clients, period, startDate, today);
    });
  }

  async createStylist(salonId, payload) {
    const name = String(payload.name || '').trim();
    const role = String(payload.role || '').trim();
    if (!name) throw new ValidationError('Stylist name is required');
    if (!role) throw new ValidationError('Stylist role is required');
    const comm = Number(payload.commission_pct ?? 35);
    if (!Number.isFinite(comm) || comm < 0 || comm > 100) {
      throw new ValidationError('Commission percentage must be between 0 and 100');
    }
    const id = 'sty-' + crypto.randomUUID().slice(0, 8);
    const avatar = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

    const row = {
      id,
      salon_id: salonId,
      name,
      role,
      avatar,
      phone: normalizePhone(payload.phone || ''),
      commission_pct: comm,
      rating: 4.9,
      active: 1
    };
    const { data, error } = await this.client
      .from('stylists')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return data;
  }

  async updateStylist(salonId, id, updates) {
    const patch = {};
    if (updates.name !== undefined) patch.name = String(updates.name).trim();
    if (updates.role !== undefined) patch.role = String(updates.role).trim();
    if (updates.phone !== undefined) patch.phone = normalizePhone(updates.phone);
    if (updates.commission_pct !== undefined) patch.commission_pct = Number(updates.commission_pct);
    if (updates.active !== undefined) patch.active = updates.active ? 1 : 0;

    const { data, error } = await this.client
      .from('stylists')
      .update(patch)
      .eq('salon_id', salonId)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return data;
  }

  // ===================== CLIENTS =====================
  hydrateClientRow(c) {
    const daysAgo = c.last_visit_at ? daysBetweenIso(c.last_visit_at) : 0;
    const tier = computeTier(c.visits, c.total_spend, daysAgo);
    return {
      ...c,
      days_ago: daysAgo,
      tier
    };
  }

  async getClients(salonId, filters = {}) {
    let list = await this.cached(`clients:${salonId}`, async () => {
      const data = await this.fetchAll(c =>
        c.from('clients')
          .select('*')
          .eq('salon_id', salonId)
          .order('last_visit_at', { ascending: false })
      );
      return (data || []).map(r => this.hydrateClientRow(r));
    });

    if (filters.search) {
      const q = String(filters.search).trim().toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (qDigits && c.phone.includes(qDigits))
      );
    }
    if (filters.tier && filters.tier !== 'All') {
      list = list.filter(c => c.tier === filters.tier);
    }
    return list;
  }

  async getClientById(salonId, id) {
    const { data: row, error } = await this.client
      .from('clients')
      .select('*')
      .eq('salon_id', salonId)
      .eq('id', id)
      .maybeSingle();
    if (error || !row) return null;
    const client = this.hydrateClientRow(row);

    const { data: history } = await this.client
      .from('appointments')
      .select('*')
      .eq('salon_id', salonId)
      .or(`client_id.eq.${client.id},client_phone.eq.${client.phone}`)
      .order('date', { ascending: false });

    return { ...client, history: history || [] };
  }

  async getClientByPhone(salonId, phone) {
    const norm = normalizePhone(phone);
    if (!norm) return null;
    const { data: row } = await this.client
      .from('clients')
      .select('*')
      .eq('salon_id', salonId)
      .eq('phone', norm)
      .maybeSingle();
    return row ? this.hydrateClientRow(row) : null;
  }

  async updateClient(salonId, id, updates) {
    const patch = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) patch.name = String(updates.name).trim();
    if (updates.preferred_stylist !== undefined) patch.preferred_stylist = String(updates.preferred_stylist).trim();
    if (updates.formula_notes !== undefined) patch.formula_notes = String(updates.formula_notes).trim();
    if (updates.opted_in !== undefined) patch.opted_in = updates.opted_in ? 1 : 0;

    const { error } = await this.client
      .from('clients')
      .update(patch)
      .eq('salon_id', salonId)
      .eq('id', id);
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return this.getClientById(salonId, id);
  }

  async upsertClientRecord(salonId, { name, phone, preferredStylist, serviceName, amount, date, creditVisit, rating, existingClient = undefined }) {
    const normPhone = normalizePhone(phone);
    const existing = existingClient !== undefined ? existingClient : await this.getClientByPhone(salonId, normPhone);

    if (existing) {
      if (creditVisit) {
        const nextVisits = existing.visits + 1;
        const nextSpend = existing.total_spend + amount;
        const lastVisitAt = !existing.last_visit_at || date >= existing.last_visit_at ? date : existing.last_visit_at;
        const nextRating = rating != null
          ? +(((existing.rating * existing.visits) + Number(rating)) / Math.max(nextVisits, 1)).toFixed(2)
          : existing.rating;
        const tier = computeTier(nextVisits, nextSpend, daysBetweenIso(lastVisitAt));

        await this.client
          .from('clients')
          .update({
            name: name || existing.name,
            visits: nextVisits,
            total_spend: nextSpend,
            preferred_stylist: preferredStylist || existing.preferred_stylist,
            rating: nextRating,
            tier,
            last_service: serviceName || existing.last_service,
            last_visit_at: lastVisitAt,
            updated_at: new Date().toISOString()
          })
          .eq('salon_id', salonId)
          .eq('id', existing.id);
        this.invalidateCache(salonId);
      }
      return existing.id;
    }

    const newId = 'cli-' + crypto.randomUUID().slice(0, 8);
    const visits = creditVisit ? 1 : 0;
    const spend = creditVisit ? amount : 0;
    const lastVisitAt = creditVisit ? date : '';
    const tier = 'New';

    await this.client
      .from('clients')
      .insert({
        id: newId,
        salon_id: salonId,
        name,
        phone: normPhone,
        visits,
        total_spend: spend,
        preferred_stylist: preferredStylist || '',
        rating: rating || 5.0,
        tier,
        last_service: serviceName || '',
        last_visit_at: lastVisitAt
      });
    this.invalidateCache(salonId);
    return newId;
  }

  // ===================== APPOINTMENTS =====================
  async getAppointments(salonId, filters = {}) {
    let q = this.client
      .from('appointments')
      .select('*')
      .eq('salon_id', salonId);

    if (filters.date) q = q.eq('date', filters.date);
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.search) {
      const term = `%${String(filters.search).trim()}%`;
      q = q.or(`client_name.ilike.${term},client_phone.ilike.${term},invoice_no.ilike.${term}`);
    }

    const { data, error } = await q.order('date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  async getAppointmentById(salonId, id) {
    const { data } = await this.client
      .from('appointments')
      .select('*')
      .eq('salon_id', salonId)
      .eq('id', id)
      .maybeSingle();
    return data || null;
  }

  async checkStylistConflict(salonId, stylistName, date, time, excludeId = null) {
    let q = this.client
      .from('appointments')
      .select('id, client_name, time')
      .eq('salon_id', salonId)
      .eq('stylist_name', stylistName)
      .eq('date', date)
      .eq('time', time)
      .in('status', ACTIVE_BOOKING_STATUSES);

    if (excludeId) {
      q = q.neq('id', excludeId);
    }
    const { data } = await q.maybeSingle();
    return data || null;
  }

  async nextInvoiceSeq(salonId) {
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;
    const { data } = await this.client
      .from('appointments')
      .select('invoice_no')
      .eq('salon_id', salonId)
      .like('invoice_no', `${prefix}%`)
      .order('created_at', { ascending: false })
      .limit(100);

    let maxSeq = 100;
    for (const row of data || []) {
      const match = String(row.invoice_no || '').match(/INV-\d+-(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxSeq) maxSeq = num;
      }
    }
    return { prefix, seq: maxSeq + 1 };
  }

  async nextInvoiceNo(salonId) {
    const { prefix, seq } = await this.nextInvoiceSeq(salonId);
    return `${prefix}${seq}`;
  }

  async createAppointment(salonId, payload) {
    const clientName = String(payload.client_name || payload.clientName || '').trim();
    const rawPhone = payload.client_phone || payload.clientPhone || '';
    const clientPhone = normalizePhone(rawPhone);
    if (!clientName) throw new ValidationError('Client name is required');
    if (clientPhone.length !== 10) throw new ValidationError('A valid 10-digit mobile number is required');

    const status = payload.status || 'Confirmed';
    if (!VALID_STATUSES.includes(status)) {
      throw new ValidationError(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const paymentMode = payload.payment_mode || payload.paymentMode || 'UPI';
    if (!VALID_PAYMENT_MODES.includes(paymentMode)) {
      throw new ValidationError(`Invalid payment mode. Must be one of: ${VALID_PAYMENT_MODES.join(', ')}`);
    }

    const rawDate = payload.date || getLocalIsoDate(0);
    const date = rawDate === 'Today' ? getLocalIsoDate(0) : rawDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ValidationError('Date must be in YYYY-MM-DD format');
    }

    const time = String(payload.time || new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })).trim();
    const stylistName = String(payload.stylist_name || payload.stylist || 'Rahul (Creative Director)').trim();

    const price = Math.max(0, Number(payload.price ?? payload.subtotal ?? 650));
    const subtotal = Math.max(price, Number(payload.subtotal || price));
    const discount = Math.max(0, Number(payload.discount || 0));
    const durationMins = Number(payload.duration_mins || 45);
    const servicesList = payload.services || [{ name: payload.service_name || 'Haircut & Styling', price, duration: durationMins }];
    const serviceSummary = servicesList.map(s => s.name).join(' + ');

    const checkConflict = ACTIVE_BOOKING_STATUSES.includes(status) && !payload.force;

    // Run independent pre-flight queries in a single parallel batch
    const [conflict, settings, invInfo, existingClient] = await Promise.all([
      checkConflict ? this.checkStylistConflict(salonId, stylistName, date, time) : Promise.resolve(null),
      this.getSettings(salonId),
      this.nextInvoiceSeq(salonId),
      this.getClientByPhone(salonId, clientPhone)
    ]);

    if (conflict) {
      throw new ConflictError(`${stylistName} already has an appointment with ${conflict.client_name} at ${time} on ${date}`);
    }

    const gstRate = Number(settings.gst_rate) || 18;
    const gst = computeGstBreakdown(price, gstRate);
    const id = 'apt-' + crypto.randomUUID().slice(0, 8);
    const creditVisit = status === 'Completed';

    const clientUpdatePayload = {
      name: clientName,
      phone: clientPhone,
      preferredStylist: stylistName,
      serviceName: serviceSummary,
      amount: price,
      date,
      creditVisit,
      rating: payload.rating,
      existingClient
    };

    // For brand-new clients, insert client first so FK references succeed; for existing clients, insert appointment & update client concurrently
    let clientId;
    if (!existingClient) {
      clientId = await this.upsertClientRecord(salonId, clientUpdatePayload);
    } else {
      clientId = existingClient.id;
    }

    let seq = invInfo.seq;
    const buildRow = (invoiceNo) => ({
      id,
      salon_id: salonId,
      invoice_no: invoiceNo,
      client_id: clientId,
      client_name: clientName,
      client_phone: clientPhone,
      stylist_id: payload.stylist_id || null,
      stylist_name: stylistName,
      service_name: serviceSummary,
      services_json: servicesList,
      date,
      time,
      duration_mins: durationMins,
      subtotal,
      discount,
      price,
      cgst: gst.cgst,
      sgst: gst.sgst,
      payment_mode: paymentMode,
      payment_split_json: payload.payment_split || {},
      status,
      rating: payload.rating || null,
      notes: String(payload.notes || '').trim()
    });

    const insertAppointmentWithRetry = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, error } = await this.client
          .from('appointments')
          .insert(buildRow(`${invInfo.prefix}${seq + attempt}`))
          .select()
          .single();
        if (!error) return data;
        if (error.code === '23505' || /invoice_no/i.test(error.message)) {
          // Re-sync sequence from DB if collided due to timestamp ties or concurrent inserts
          const fresh = await this.nextInvoiceSeq(salonId);
          seq = Math.max(seq + 1, fresh.seq - attempt - 1);
          continue;
        }
        throw new Error(error.message);
      }
      throw new Error('Could not allocate unique invoice number after retries');
    };

    let created;
    if (existingClient && creditVisit) {
      [created] = await Promise.all([
        insertAppointmentWithRetry(),
        this.upsertClientRecord(salonId, clientUpdatePayload)
      ]);
    } else {
      created = await insertAppointmentWithRetry();
    }

    this.invalidateCache(salonId);
    return created;
  }

  async updateAppointment(salonId, id, updates) {
    const existing = await this.getAppointmentById(salonId, id);
    if (!existing) return null;

    const nextStatus = updates.status ?? existing.status;
    const nextDate = updates.date === 'Today' ? getLocalIsoDate(0) : (updates.date ?? existing.date);
    const nextTime = updates.time ?? existing.time;
    const nextStylist = updates.stylist_name ?? existing.stylist_name;

    if (ACTIVE_BOOKING_STATUSES.includes(nextStatus) && !updates.force) {
      const slotChanged = nextDate !== existing.date || nextTime !== existing.time || nextStylist !== existing.stylist_name || !ACTIVE_BOOKING_STATUSES.includes(existing.status);
      if (slotChanged) {
        const conflict = await this.checkStylistConflict(salonId, nextStylist, nextDate, nextTime, id);
        if (conflict) {
          throw new ConflictError(`${nextStylist} already has an appointment with ${conflict.client_name} at ${nextTime} on ${nextDate}`);
        }
      }
    }

    const nextSubtotal = updates.subtotal != null ? Number(updates.subtotal) : existing.subtotal;
    const nextDiscount = updates.discount != null ? Number(updates.discount) : existing.discount;
    const nextPrice = updates.price != null ? Number(updates.price) : Math.max(0, nextSubtotal - nextDiscount);
    const settings = await this.getSettings(salonId);
    const gst = computeGstBreakdown(nextPrice, Number(settings.gst_rate) || 18);

    const patch = {
      status: nextStatus,
      payment_mode: updates.payment_mode ?? existing.payment_mode,
      payment_split_json: updates.payment_split || existing.payment_split_json,
      notes: updates.notes !== undefined ? String(updates.notes).trim() : existing.notes,
      subtotal: nextSubtotal,
      discount: nextDiscount,
      price: nextPrice,
      cgst: gst.cgst,
      sgst: gst.sgst,
      stylist_name: nextStylist,
      date: nextDate,
      time: nextTime,
      rating: updates.rating !== undefined ? updates.rating : existing.rating,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await this.client
      .from('appointments')
      .update(patch)
      .eq('salon_id', salonId)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Reconcile client visit stats (credit or reverse)
    if (existing.status !== 'Completed' && nextStatus === 'Completed') {
      await this.upsertClientRecord(salonId, {
        name: existing.client_name,
        phone: existing.client_phone,
        preferredStylist: nextStylist,
        serviceName: existing.service_name,
        amount: nextPrice,
        date: nextDate,
        creditVisit: true,
        rating: patch.rating
      });
    } else if (existing.status === 'Completed' && nextStatus !== 'Completed') {
      await this.revertClientVisit(salonId, existing.client_phone, existing.price);
    }

    this.invalidateCache(salonId);
    return data;
  }

  async revertClientVisit(salonId, phone, amount) {
    const existing = await this.getClientByPhone(salonId, phone);
    if (!existing) return;
    const nextVisits = Math.max(0, Number(existing.visits || 0) - 1);
    const nextSpend = Math.max(0, Number(existing.total_spend || 0) - Number(amount || 0));
    const daysAgo = existing.last_visit_at ? daysBetweenIso(existing.last_visit_at) : 0;
    const tier = computeTier(nextVisits, nextSpend, daysAgo);
    await this.client
      .from('clients')
      .update({
        visits: nextVisits,
        total_spend: nextSpend,
        tier,
        updated_at: new Date().toISOString()
      })
      .eq('salon_id', salonId)
      .eq('id', existing.id);
  }

  async deleteAppointment(salonId, id) {
    const existing = await this.getAppointmentById(salonId, id);
    if (!existing) return false;
    if (existing.status === 'Completed') {
      await this.revertClientVisit(salonId, existing.client_phone, existing.price);
    }
    const { error } = await this.client
      .from('appointments')
      .delete()
      .eq('salon_id', salonId)
      .eq('id', id);
    if (!error) this.invalidateCache(salonId);
    return !error;
  }

  // ===================== CAMPAIGNS =====================
  async getCampaigns(salonId) {
    return this.cached(`campaigns:${salonId}`, async () => {
      const { data, error } = await this.client
        .from('campaigns')
        .select('*')
        .eq('salon_id', salonId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    });
  }

  async createCampaign(salonId, payload) {
    const name = String(payload.name || '').trim();
    const segment = String(payload.segment || 'At risk').trim();
    const message = String(payload.message || '').trim();
    if (!name) throw new ValidationError('Campaign name is required');
    if (!message) throw new ValidationError('Campaign message is required');

    const allClients = (await this.getClients(salonId)).filter(c => c.opted_in);
    const recipients = segment === 'All' ? allClients : allClients.filter(c => c.tier === segment);

    const id = 'cmp-' + crypto.randomUUID().slice(0, 8);
    const row = {
      id,
      salon_id: salonId,
      name,
      segment,
      message,
      audience_count: recipients.length,
      sent_count: Number(payload.sent_count || 0),
      status: payload.status || 'Queued'
    };

    const { data, error } = await this.client
      .from('campaigns')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return { campaign: data, recipients };
  }

  async markCampaignSent(salonId, id, sentCount) {
    const { data: existing } = await this.client
      .from('campaigns')
      .select('*')
      .eq('salon_id', salonId)
      .eq('id', id)
      .maybeSingle();
    if (!existing) return null;

    const nextSent = Number(sentCount ?? existing.sent_count + 1);
    const status = nextSent >= existing.audience_count ? 'Completed' : 'In Progress';

    const { data, error } = await this.client
      .from('campaigns')
      .update({ sent_count: nextSent, status })
      .eq('salon_id', salonId)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    this.invalidateCache(salonId);
    return data;
  }

  // ===================== DASHBOARD & REPORTS =====================
  computePaymentSplit(completedRows) {
    const totals = { UPI: 0, Card: 0, Cash: 0 };
    for (const a of completedRows) {
      if (a.payment_mode === 'Split') {
        try {
          const split = typeof a.payment_split_json === 'object' ? a.payment_split_json : JSON.parse(a.payment_split_json || '{}');
          for (const [k, v] of Object.entries(split)) {
            if (totals[k] !== undefined) totals[k] += Number(v || 0);
          }
        } catch (_) {
          totals.UPI += Number(a.price || 0);
        }
      } else if (totals[a.payment_mode] !== undefined) {
        totals[a.payment_mode] += Number(a.price || 0);
      } else {
        totals.UPI += Number(a.price || 0);
      }
    }
    return totals;
  }

  async getDashboard(salonId) {
    return this.cached(`dashboard:${salonId}`, async () => {
      const today = getLocalIsoDate(0);
      const weekStart = getLocalIsoDate(-6);
      const lastWeekSameDay = getLocalIsoDate(-7);

      const [
        todayRows,
        upcomingRes,
        lastWeekRes,
        weekRows,
        stylistsRes,
        allClients,
        settings
      ] = await Promise.all([
        this.fetchAll(c =>
          c.from('appointments')
            .select('*')
            .eq('salon_id', salonId)
            .eq('date', today)
            .order('created_at', { ascending: false })
        ),
        this.client
          .from('appointments')
          .select('*')
          .eq('salon_id', salonId)
          .gt('date', today)
          .in('status', ['Scheduled', 'Confirmed'])
          .order('date', { ascending: true })
          .limit(12),
        this.fetchAll(c =>
          c.from('appointments')
            .select('price')
            .eq('salon_id', salonId)
            .eq('date', lastWeekSameDay)
            .eq('status', 'Completed')
        ),
        this.fetchAll(c =>
          c.from('appointments')
            .select('date, price, stylist_id, stylist_name, rating, client_phone')
            .eq('salon_id', salonId)
            .eq('status', 'Completed')
            .gte('date', weekStart)
            .lte('date', today)
        ),
        this.client
          .from('stylists')
          .select('*')
          .eq('salon_id', salonId)
          .eq('active', 1)
          .order('rating', { ascending: false }),
        this.getClients(salonId),
        this.getSettings(salonId)
      ]);

      const completedToday = (todayRows || []).filter(a => a.status === 'Completed');
      const activeQueue = (todayRows || []).filter(a => ACTIVE_BOOKING_STATUSES.includes(a.status));
      const upcomingFuture = upcomingRes?.data || [];

      const todayRevenue = completedToday.reduce((s, a) => s + Number(a.price || 0), 0);
      const lastWeekRevenue = (lastWeekRes || []).reduce((s, a) => s + Number(a.price || 0), 0);
      const deltaPct = lastWeekRevenue > 0
        ? Math.round(((todayRevenue - lastWeekRevenue) / lastWeekRevenue) * 100)
        : null;

      // Group 7-day series in memory from single range query
      const byDate = new Map();
      for (const r of weekRows || []) {
        const cur = byDate.get(r.date) || { revenue: 0, count: 0 };
        cur.revenue += Number(r.price || 0);
        cur.count += 1;
        byDate.set(r.date, cur);
      }
      const weekSeries = [];
      for (let i = -6; i <= 0; i++) {
        const iso = getLocalIsoDate(i);
        const label = i === 0
          ? 'Today'
          : new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
        const agg = byDate.get(iso) || { revenue: 0, count: 0 };
        weekSeries.push({ date: iso, label, revenue: agg.revenue, count: agg.count });
      }

      const paymentSplit = this.computePaymentSplit(completedToday);
      const rated = completedToday.filter(a => a.rating != null);
      const avgRating = rated.length
        ? +(rated.reduce((s, a) => s + Number(a.rating), 0) / rated.length).toFixed(1)
        : null;

      const clientPhoneVisits = new Map(allClients.map(c => [c.phone, c.visits]));
      const returningToday = completedToday.filter(a => (clientPhoneVisits.get(a.client_phone) || 0) > 1).length;
      const lapsedClients = allClients.filter(c => c.days_ago >= 30);

      const stylistPerf = this.computeStylistsMetrics(stylistsRes?.data || [], weekRows || [], allClients, 'today', today, today);

      return {
        date: today,
        settings,
        todayRevenue,
        lastWeekRevenue,
        deltaPct,
        completedCount: completedToday.length,
        avgTicket: completedToday.length ? Math.round(todayRevenue / completedToday.length) : 0,
        returningToday,
        avgRating,
        paymentSplit,
        weekSeries,
        stylistPerf,
        completedToday,
        activeQueue,
        upcomingFuture,
        lapsedClients
      };
    });
  }

  async getReports(salonId, period = 'month') {
    return this.cached(`reports:${salonId}:${period}`, async () => {
      const today = getLocalIsoDate(0);
      const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
      const startDate = getLocalIsoDate(-(days - 1));
      const prevStart = getLocalIsoDate(-(days * 2 - 1));
      const prevEnd = getLocalIsoDate(-days);

      const [currentRows, prevRows, allClients, settings] = await Promise.all([
        this.fetchAll(c =>
          c.from('appointments')
            .select('date, price, cgst, sgst, discount, payment_mode, payment_split_json, service_name, services_json')
            .eq('salon_id', salonId)
            .eq('status', 'Completed')
            .gte('date', startDate)
            .lte('date', today)
        ),
        this.fetchAll(c =>
          c.from('appointments')
            .select('price')
            .eq('salon_id', salonId)
            .eq('status', 'Completed')
            .gte('date', prevStart)
            .lte('date', prevEnd)
        ),
        this.getClients(salonId),
        this.getSettings(salonId)
      ]);

      const curr = currentRows || [];
      const prev = prevRows || [];
      const totalRevenue = curr.reduce((s, a) => s + Number(a.price || 0), 0);
      const prevRevenue = prev.reduce((s, a) => s + Number(a.price || 0), 0);
      const revenueDeltaPct = prevRevenue > 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : null;

      const footfall = curr.length;
      const avgTicket = footfall ? Math.round(totalRevenue / footfall) : 0;
      const totalGst = +(curr.reduce((s, a) => s + Number(a.cgst || 0) + Number(a.sgst || 0), 0)).toFixed(2);
      const totalDiscount = +(curr.reduce((s, a) => s + Number(a.discount || 0), 0)).toFixed(2);

      const repeatClients = allClients.filter(c => c.visits > 1).length;
      const retentionPct = allClients.length ? Math.round((repeatClients / allClients.length) * 100) : 0;

      const chartDays = Math.min(days, 14);
      const dailySeries = [];
      for (let i = -(chartDays - 1); i <= 0; i++) {
        const iso = getLocalIsoDate(i);
        const dayRows = curr.filter(a => a.date === iso);
        const rev = dayRows.reduce((s, a) => s + Number(a.price || 0), 0);
        const dt = new Date(`${iso}T12:00:00Z`);
        dailySeries.push({
          date: iso,
          label: i === 0 ? 'Today' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
          shortLabel: i === 0 ? 'Today' : String(dt.getUTCDate()),
          revenue: rev,
          count: dayRows.length
        });
      }

      const paymentSplit = this.computePaymentSplit(curr);
      const openingCash = Number(settings.opening_cash || 0);

      // Top services mix (handles JSONB Array and JSON string safely)
      const srvMap = new Map();
      for (const a of curr) {
        let items = [];
        if (Array.isArray(a.services_json)) {
          items = a.services_json;
        } else if (typeof a.services_json === 'string') {
          try { items = JSON.parse(a.services_json || '[]'); } catch (_) {}
        }
        if (!items.length) items = [{ name: a.service_name, price: a.price }];
        for (const it of items) {
          const name = it?.name || a.service_name || 'Service';
          const cur = srvMap.get(name) || { name, count: 0, revenue: 0 };
          cur.count += 1;
          cur.revenue += Number(it?.price || 0);
          srvMap.set(name, cur);
        }
      }
      const serviceMix = [...srvMap.values()].sort((a, b) => b.revenue - a.revenue);

      return {
        period,
        startDate,
        endDate: today,
        totalRevenue,
        prevRevenue,
        revenueDeltaPct,
        footfall,
        avgTicket,
        retentionPct,
        totalGst,
        totalDiscount,
        paymentSplit,
        openingCash,
        expectedDrawerCash: openingCash + paymentSplit.Cash,
        dailySeries,
        serviceMix
      };
    });
  }

  async exportGstCsv(salonId, period = 'month') {
    const today = getLocalIsoDate(0);
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
    const startDate = getLocalIsoDate(-(days - 1));

    const rows = await this.fetchAll(c =>
      c.from('appointments')
        .select('*')
        .eq('salon_id', salonId)
        .eq('status', 'Completed')
        .gte('date', startDate)
        .lte('date', today)
        .order('date', { ascending: true })
    );

    const settings = await this.getSettings(salonId);
    const header = [
      'Invoice No', 'Date', 'Time', 'Client Name', 'Client Phone', 'Stylist',
      'Services', 'Gross Amount (INR)', 'Discount (INR)', 'Net Amount (INR)',
      'Taxable Value (INR)', 'CGST (9%)', 'SGST (9%)', 'Total Tax (INR)',
      'Payment Mode', 'GSTIN', 'SAC Code'
    ].map(csvEscape).join(',');

    const lines = [header];
    for (const a of rows || []) {
      const taxable = +(Number(a.price) - Number(a.cgst || 0) - Number(a.sgst || 0)).toFixed(2);
      const totalTax = +(Number(a.cgst || 0) + Number(a.sgst || 0)).toFixed(2);
      lines.push([
        a.invoice_no, a.date, a.time, a.client_name, a.client_phone, a.stylist_name,
        a.service_name, a.subtotal, a.discount, a.price,
        taxable, a.cgst, a.sgst, totalTax,
        a.payment_mode, settings.gstin, settings.sac_code
      ].map(csvEscape).join(','));
    }
    return lines.join('\r\n');
  }
}

module.exports = {
  SupabaseSalonDatabase,
  ConflictError,
  ValidationError
};
