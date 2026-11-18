let ownerPinCache = '';
try {
  ownerPinCache = sessionStorage.getItem('jawed-owner-pin') || '';
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

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (ownerPinCache) {
    headers['X-Owner-Pin'] = ownerPinCache;
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
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code || 'ERROR';
    throw err;
  }
  return data;
}

export const api = {
  getDashboard: () => request('/api/dashboard'),
  getServices: (all = false) => request(`/api/services${all ? '?all=1' : ''}`),
  createService: (body) => request('/api/services', { method: 'POST', body }),
  updateService: (id, body) => request(`/api/services/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteService: (id) => request(`/api/services/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getStylists: (period = 'month') => request(`/api/stylists?period=${encodeURIComponent(period)}`),
  createStylist: (body) => request('/api/stylists', { method: 'POST', body }),
  updateStylist: (id, body) => request(`/api/stylists/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

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
  getSettings: () => request('/api/settings'),
  updateSettings: (body) => request('/api/settings', { method: 'PATCH', body }),
  resetDatabase: () => request('/api/reset', { method: 'POST' })
};
