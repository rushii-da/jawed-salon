let ownerPinCache = '';
let salonTokenCache = '';
let currentSalonId = 'genzee';

try {
  ownerPinCache = sessionStorage.getItem('jawed-owner-pin') || '';
  salonTokenCache = localStorage.getItem('salon-auth-token') || '';
  currentSalonId = localStorage.getItem('salon-id') || 'genzee';
} catch (_) {}

export function setSessionOwnerPin(pin) {
  ownerPinCache = String(pin || '').trim();
  try {
    if (ownerPinCache) sessionStorage.setItem('jawed-owner-pin', ownerPinCache);
    else sessionStorage.removeItem('jawed-owner-pin');
  } catch (_) {}
}

export function getSessionOwnerPin() {
  return ownerPinCache;
}

export function setSalonSession(salon, token) {
  currentSalonId = salon?.id || 'genzee';
  salonTokenCache = token || '';
  try {
    localStorage.setItem('salon-id', currentSalonId);
    if (salonTokenCache) localStorage.setItem('salon-auth-token', salonTokenCache);
    else localStorage.removeItem('salon-auth-token');
    if (salon) localStorage.setItem('salon-profile', JSON.stringify(salon));
  } catch (_) {}
}

export function getSalonSession() {
  let profile = null;
  try {
    const raw = localStorage.getItem('salon-profile');
    if (raw) profile = JSON.parse(raw);
  } catch (_) {}
  return {
    salonId: currentSalonId,
    token: salonTokenCache,
    profile
  };
}

export function clearSalonSession() {
  salonTokenCache = '';
  currentSalonId = 'genzee';
  try {
    localStorage.removeItem('salon-auth-token');
    localStorage.removeItem('salon-profile');
    localStorage.removeItem('salon-id');
  } catch (_) {}
}

export function isSalonLoggedIn() {
  return Boolean(salonTokenCache);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (ownerPinCache) {
    headers['X-Owner-Pin'] = ownerPinCache;
  }
  if (currentSalonId) {
    headers['X-Salon-Id'] = currentSalonId;
  }
  if (salonTokenCache) {
    headers['Authorization'] = `Bearer ${salonTokenCache}`;
  }

  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!res.ok) {
    if (res.status === 401 && data?.code === 'AUTH_REQUIRED') {
      clearSalonSession();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('salondesk:auth-required', { detail: data }));
      }
    }
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code || 'ERROR';
    throw err;
  }
  return data;
}

async function requestText(path) {
  const headers = {};
  if (currentSalonId) headers['X-Salon-Id'] = currentSalonId;
  if (salonTokenCache) headers['Authorization'] = `Bearer ${salonTokenCache}`;
  const res = await fetch(path, { headers });
  const text = await res.text();
  if (!res.ok) {
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    if (res.status === 401 && data?.code === 'AUTH_REQUIRED') {
      clearSalonSession();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('salondesk:auth-required', { detail: data }));
      }
    }
    const err = new Error(data?.error || `Download failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code || 'ERROR';
    throw err;
  }
  return text;
}

export const api = {
  // Auth
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  getMe: () => request('/api/auth/me'),
  logout: () => clearSalonSession(),

  getDashboard: () => request('/api/dashboard'),
  getServices: (all = false) => request(`/api/services${all ? '?all=1' : ''}`),
  createService: (body) => request('/api/services', { method: 'POST', body }),
  updateService: (id, body) => request(`/api/services/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteService: (id) => request(`/api/services/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getStylists: (period = 'month') => request(`/api/stylists?period=${encodeURIComponent(period)}`),
  createStylist: (body) => request('/api/stylists', { method: 'POST', body }),
  updateStylist: (id, body) => request(`/api/stylists/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteStylist: (id) => request(`/api/stylists/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getClients: (params = {}) => {
    const sp = new URLSearchParams();
    if (params.search) sp.set('search', params.search);
    if (params.tier && params.tier !== 'All') sp.set('tier', params.tier);
    const qs = sp.toString();
    return request(`/api/clients${qs ? '?' + qs : ''}`);
  },
  lookupClientByPhone: (phone) => request(`/api/clients/lookup?phone=${encodeURIComponent(phone)}`),
  getClientById: (id) => request(`/api/clients/${encodeURIComponent(id)}`),
  updateClient: (id, body) => request(`/api/clients/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  getAppointments: (params = {}) => {
    const sp = new URLSearchParams();
    if (params.date) sp.set('date', params.date);
    if (params.status) sp.set('status', params.status);
    const qs = sp.toString();
    return request(`/api/appointments${qs ? '?' + qs : ''}`);
  },
  createAppointment: (body) => request('/api/appointments', { method: 'POST', body }),
  updateAppointment: (id, body) => request(`/api/appointments/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteAppointment: (id) => request(`/api/appointments/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getCampaigns: () => request('/api/campaigns'),
  createCampaign: (body) => request('/api/campaigns', { method: 'POST', body }),
  markCampaignSent: (id, sentCount) => request(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'PATCH', body: { sent_count: sentCount } }),

  getReports: (period = 'month') => request(`/api/reports?period=${encodeURIComponent(period)}`),
  exportGstCsv: (period = 'month') => requestText(`/api/reports/gst-csv?period=${encodeURIComponent(period)}`),
  getSettings: () => request('/api/settings'),
  updateSettings: (body) => request('/api/settings', { method: 'PATCH', body }),
  resetDatabase: () => request('/api/reset', { method: 'POST' })
};
