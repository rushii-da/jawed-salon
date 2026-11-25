import {
  api, setSessionOwnerPin, getSessionOwnerPin,
  setSalonSession, getSalonSession, clearSalonSession, isSalonLoggedIn
} from './api.js';
import {
  COL, ICO, WA_SVG, STAR_SVG,
  escapeHtml, inr, normalizePhone, formatPhone, todayIso, formatDisplayDate,
  av, chip, buildWaUrl, buildReceiptWaText, buildBookingWaText, parseServicesJson
} from './utils.js';

const $ = (s) => document.querySelector(s);

const NAV = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['walkin', 'Walk-in Billing', 'walkin'],
  ['appointment', 'New Appointment', 'appointment'],
  ['customers', 'Clients & Log', 'customers'],
  ['stylists', 'Stylists & Team', 'stylists'],
  ['campaigns', 'WhatsApp Campaigns', 'campaigns'],
  ['reports', 'Revenue Reports', 'reports'],
  ['settings', 'Settings & Catalog', 'settings']
];

const MOB_NAV = [
  ['dashboard', 'Home', 'dashboard'],
  ['walkin', 'Bill', 'walkin'],
  ['appointment', 'Book', 'appointment'],
  ['customers', 'Clients', 'customers'],
  ['reports', 'Reports', 'reports']
];

const TIME_SLOTS = ['10:30 AM', '11:30 AM', '01:00 PM', '02:30 PM', '03:30 PM', '05:00 PM', '06:30 PM', '08:00 PM'];

const state = {
  page: 'dashboard',
  settings: { salon_name: 'SalonDesk', branch_name: 'Green Cove, Pune', gstin: '27AAEFG1234A1Z5', gst_rate: '18', sac_code: '999722', opening_cash: '5000', has_owner_pin: false },
  services: [],
  stylists: [],
  clients: [],
  dashboard: null,
  reports: null,
  campaigns: [],

  // UI filter/view states
  clientFilter: 'All',
  stylistPeriod: 'month',
  reportPeriod: 'month',
  campSegment: 'At risk',
  campName: 'Win-Back VIP Offer',
  campMessage: 'Hi {name}, we miss you at SalonDesk! Enjoy 20% off your next Hair Spa or Color treatment this week. Reply to reserve your chair.',
  activeCampQueue: null, // { campaign, recipients, sentPhones: Set }

  // Walk-in billing form state
  walkin: {
    settlingId: null,
    name: '',
    phone: '',
    selectedServiceIds: new Set(),
    stylistName: '',
    paymentMode: 'UPI',
    splitUpi: 0,
    splitCash: 0,
    discount: 0,
    rating: 5,
    notes: '',
    lookupClient: null
  },

  // Advance booking form state
  booking: {
    name: '',
    phone: '',
    date: todayIso(),
    time: '03:30 PM',
    selectedServiceIds: new Set(),
    stylistName: '',
    notes: '',
    sendWa: true,
    conflictError: ''
  },

  lastReceipt: null,
  lastFocusedEl: null,
  indicatorTop: 0
};

// ===================== TOAST & THEME =====================
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.classList.add('tt');
  root.dataset.theme = next;
  try { localStorage.setItem('glow-theme', next); } catch (_) {}
  setTimeout(() => root.classList.remove('tt'), 450);
}

// ===================== MODALS & DRAWER =====================
function openOverlay(id) {
  const el = $(`#${id}`);
  if (!el) return;
  state.lastFocusedEl = document.activeElement;
  el.hidden = false;
  const firstFocusable = el.querySelector('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
  if (firstFocusable) firstFocusable.focus();
}

function closeOverlay(id) {
  const el = $(`#${id}`);
  if (!el || el.hidden) return false;
  el.hidden = true;
  if (state.lastFocusedEl && typeof state.lastFocusedEl.focus === 'function') {
    state.lastFocusedEl.focus();
    state.lastFocusedEl = null;
  }
  if (id === 'receiptModal' && state.page === 'dashboard') {
    render(false);
  }
  return true;
}

function closeAnyOpenOverlay() {
  for (const id of ['confirmModal', 'receiptModal', 'formModal', 'clientDrawer']) {
    if (closeOverlay(id)) return true;
  }
  return false;
}

function openReceiptModal(apt) {
  state.lastReceipt = apt;
  const s = state.settings;
  const gstRate = Number(s.gst_rate || 18);
  const halfRate = +(gstRate / 2).toFixed(1);

  $('#rcpSalon').textContent = (s.salon_name || 'SALONDESK').toUpperCase();
  $('#rcpFooterSalon').textContent = s.salon_name || 'SalonDesk';
  $('#rcpMeta').textContent = `${s.branch_name || ''} · GSTIN: ${s.gstin || 'N/A'}`;
  $('#rcpId').textContent = apt.invoice_no || apt.id;
  $('#rcpDate').textContent = `${formatDisplayDate(apt.date)} ${apt.time || ''}`.trim();
  $('#rcpName').textContent = apt.client_name;
  $('#rcpPhone').textContent = formatPhone(apt.client_phone);
  $('#rcpStylist').textContent = apt.stylist_name;
  $('#rcpMode').textContent = apt.payment_mode;
  $('#rcpSac').textContent = s.sac_code || '999722';
  document.querySelectorAll('.rcpHalfRate').forEach(el => { el.textContent = String(halfRate); });

  let items = parseServicesJson(apt.services_json);
  if (!items.length) {
    items = [{ name: apt.service_name, price: apt.subtotal || apt.price }];
  }
  $('#rcpItems').innerHTML = items.map(it => `
    <div class="rcp-row">
      <span>${escapeHtml(it.name)}</span>
      <b>${inr(it.price)}</b>
    </div>
  `).join('');

  const subtotal = Number(apt.subtotal ?? apt.price);
  const discount = Number(apt.discount || 0);
  const total = Number(apt.price || 0);
  const cgst = Number(apt.cgst || 0);
  const sgst = Number(apt.sgst || 0);
  const taxable = +(total - cgst - sgst).toFixed(2);

  $('#rcpGross').textContent = inr(subtotal);
  if (discount > 0) {
    $('#rcpDiscRow').style.display = 'flex';
    $('#rcpDisc').textContent = '-' + inr(discount);
  } else {
    $('#rcpDiscRow').style.display = 'none';
  }
  $('#rcpSub').textContent = '₹' + taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('#rcpCgst').textContent = '₹' + cgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('#rcpSgst').textContent = '₹' + sgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('#rcpTot').textContent = inr(total);

  openOverlay('receiptModal');
}

// ===================== HEADER & SIDEBAR =====================
function renderSidebar() {
  const s = state.settings;
  const topService = state.reports?.serviceMix?.[0]?.name || 'Balayage & Hair Spa';

  $('#side').innerHTML = `
    <div class="logo">
      <div class="mk" aria-hidden="true">${escapeHtml((s.salon_name || 'S')[0].toUpperCase())}</div>
      <span>${escapeHtml(s.salon_name || 'SalonDesk')}</span>
    </div>
    <div class="lbl">SALONDESK</div>
    <nav id="nav" aria-label="Main Navigation">
      <div class="ind" style="transform:translateY(${state.indicatorTop}px)"></div>
      ${NAV.map(([k, label, ico]) => `
        <button type="button" class="nb ${state.page === k ? 'on' : ''}" data-nav="${k}" aria-current="${state.page === k ? 'page' : 'false'}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${ICO[ico] || ICO.dashboard}</svg>
          ${escapeHtml(label)}
        </button>
      `).join('')}
    </nav>
    <div class="sp"></div>
    <div class="tip">
      <small>Live Cloud Persistence</small>
      Top revenue driver: <b>${escapeHtml(topService)}</b>. All records sync to Supabase.
    </div>
    <div class="me" style="display:flex;align-items:center;gap:10px">
      <i class="av" aria-hidden="true" style="width:36px;height:36px;background:var(--amber);color:#fff">${escapeHtml((s.salon_name || 'G')[0].toUpperCase())}</i>
      <div style="min-width:0;flex:1">
        <b>${escapeHtml(s.salon_name || 'GENZEE Lounge')}</b>
        <small style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.branch_name || 'Godrej Green Cove · Pune')}</small>
      </div>
      <button type="button" class="icon-btn" id="btnLogout" title="Switch Salon / Sign Out" aria-label="Sign out">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </div>
  `;

  $('#mobNav').innerHTML = MOB_NAV.map(([k, label, ico]) => `
    <button type="button" class="mob-btn ${state.page === k ? 'on' : ''}" data-nav="${k}" aria-current="${state.page === k ? 'page' : 'false'}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICO[ico]}</svg>
      <span>${escapeHtml(label)}</span>
    </button>
  `).join('');

  requestAnimationFrame(updateIndicator);
}

function updateIndicator() {
  const active = document.querySelector('#nav .on');
  const ind = document.querySelector('.ind');
  if (active && ind) {
    ind.style.transform = `translateY(${active.offsetTop}px)`;
    ind.style.height = active.offsetHeight + 'px';
    state.indicatorTop = active.offsetTop;
  }
}

function headerBar(title, subtitle, extraActionsHtml = null) {
  const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const defaultCta = `<button type="button" class="btn l" data-nav="walkin"><svg viewBox="0 0 24 24" aria-hidden="true">${ICO.walkin}</svg> Walk-in Billing</button>`;
  const actionsHtml = extraActionsHtml === null ? defaultCta : extraActionsHtml;

  return `
    <div class="hd">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <small>${escapeHtml(subtitle || dateStr)}</small>
      </div>
      <div class="acts">
        <div class="srch-box" role="search">
          <svg class="srch-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="srch-in" id="globalSearch" placeholder="Quick find client (name/phone)..." autocomplete="off" aria-label="Search client records" aria-expanded="false" aria-controls="srchDrop">
          <div class="srch-drop" id="srchDrop" role="listbox"></div>
        </div>
        <button type="button" class="tgl" data-action="toggle-theme" aria-label="Switch between light and dark theme">
          <i class="knob"></i>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        </button>
        ${actionsHtml}
      </div>
    </div>
  `;
}

function statCard(label, value, subChip, chipCls = '', countOpts = null) {
  const attrs = countOpts
    ? ` data-count="${Number(countOpts.value) || 0}" data-format="${escapeHtml(countOpts.format || 'int')}"`
    : '';
  return `
    <div class="card">
      <div class="mut" style="font-size:13.5px;font-weight:600">${escapeHtml(label)}</div>
      <div class="big md tab-num" style="margin:8px 0 12px"${attrs}>${escapeHtml(value)}</div>
      ${chip(subChip, chipCls)}
    </div>
  `;
}

// ===================== VIEWS =====================
function renderDashboardView() {
  const d = state.dashboard;
  if (!d) return `<div class="card">Loading live salon dashboard...</div>`;

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const salonTitle = `${greet}, ${d.settings?.salon_name || 'SalonDesk'}`;

  const pm = [
    { k: 'Card', c: 'var(--chart-card)', v: d.paymentSplit.Card || 0 },
    { k: 'UPI', c: 'var(--chart-upi)', v: d.paymentSplit.UPI || 0 },
    { k: 'Cash', c: 'var(--chart-cash)', v: d.paymentSplit.Cash || 0 }
  ];
  const pmTotal = pm.reduce((s, x) => s + x.v, 0);
  let off = 0;
  const arcs = pm.map(p => {
    const len = pmTotal ? (p.v / pmTotal) * 289 : 0;
    const o = off;
    off += len;
    return `<circle cx="60" cy="60" r="46" style="stroke:${p.c};stroke-dasharray:${len} 289;stroke-dashoffset:${-o}"/>`;
  }).join('');

  const wm = Math.max(...d.weekSeries.map(x => x.revenue), 1);
  const styMax = Math.max(...d.stylistPerf.map(x => x.revenue), 1);
  const topSty = d.stylistPerf[0];

  const deltaLabel = d.deltaPct !== null
    ? `${d.deltaPct >= 0 ? '+' : ''}${d.deltaPct}% vs last week`
    : 'Live today';

  const queueItems = [...d.activeQueue, ...d.upcomingFuture];
  const statusChipCls = { 'In-Chair': 'lime', Confirmed: 'vio', Scheduled: 'amb' };

  return headerBar(salonTitle, `${d.settings?.branch_name || 'Main Branch'} · Live Counter`) + `
  <div class="g r1">
    <!-- Today's Collection -->
    <div class="card elevated fx" style="gap:12px;min-height:320px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        ${chip('Today’s Collection', 'dk')}
        ${chip(deltaLabel, d.deltaPct != null && d.deltaPct < 0 ? 'coral' : 'lime')}
      </div>
      <div class="big lg tab-num" data-count="${d.todayRevenue}" data-format="inr">${inr(d.todayRevenue)}</div>
      <div class="dim" style="font-size:13.5px">${d.completedCount} bills settled · avg ticket ${inr(d.avgTicket)}</div>
      <div class="bars" aria-label="Last 7 days revenue">
        ${d.weekSeries.map((day, idx) => `
          <div class="bar-col ${idx === 6 ? 't' : ''}" tabindex="0" aria-label="${escapeHtml(day.label)}: ${inr(day.revenue)} (${day.count} bills)">
            <span class="bar-tip">${escapeHtml(day.label)}: ${inr(day.revenue)}</span>
            <u style="--i:${idx};height:${Math.max((day.revenue / wm) * 100, day.revenue > 0 ? 10 : 4)}%"></u>
            <span>${escapeHtml(day.label)}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Payment Split -->
    <div class="card">
      <h2>Payment Split</h2>
      <div class="donut">
        <svg viewBox="0 0 120 120" role="img" aria-label="Payment mode split chart">${arcs}</svg>
        <div><b class="big tab-num" data-count="${d.completedCount}" data-format="int">${d.completedCount}</b><small>bills</small></div>
      </div>
      ${pm.map(p => `
        <div class="leg">
          <i style="background:${p.c}"></i>${p.k}
          <b class="tab-num">${inr(p.v)}</b>
          <span>${pmTotal ? Math.round((p.v / pmTotal) * 100) : 0}%</span>
        </div>
      `).join('')}
    </div>

    <!-- Right Stack -->
    <div class="k2">
      ${statCard(
        'Clients Settled Today',
        String(d.completedCount),
        `${d.returningToday} returning · ${d.completedCount ? Math.round((d.returningToday / d.completedCount) * 100) : 0}%`,
        '',
        { value: d.completedCount, format: 'int' }
      )}
      <div class="card">
        <div class="mut" style="font-size:13.5px;font-weight:600">Today’s Rating</div>
        <div class="big md" style="margin:8px 0 12px">${d.avgRating ?? '–'} ${STAR_SVG}</div>
        ${(() => { const activeChairs = d.activeQueue.filter(a => a.status === 'In-Chair').length; return chip(`${activeChairs} ${activeChairs === 1 ? 'chair' : 'chairs'} active right now`, 'lime'); })()}
      </div>
    </div>
  </div>

  <!-- Live Chair Queue & Upcoming Schedule -->
  <div class="card">
    <h2>
      <span style="display:inline-flex;align-items:center;gap:8px">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICO.appointment}</svg>
        Live Chair Queue &amp; Upcoming Schedule
        ${chip(`${queueItems.length} active`, queueItems.length ? 'lime' : '')}
      </span>
      <button type="button" class="link-btn" data-nav="appointment">+ Schedule New</button>
    </h2>
    ${queueItems.length === 0
      ? '<div class="mut" style="padding:18px 0;text-align:center;font-size:13.5px">No pending or in-chair appointments. Ready for walk-ins.</div>'
      : `<div class="g c3">${queueItems.map((a, idx) => `
          <div class="queue-card">
            <div class="ln">
              ${av(a.client_name, idx, 40)}
              <div class="gr">
                <b>${escapeHtml(a.client_name)}</b>
                <small>${escapeHtml(formatDisplayDate(a.date))} · ${escapeHtml(a.time)} · ${escapeHtml(a.stylist_name)}</small>
              </div>
              ${chip(a.status, statusChipCls[a.status] || '')}
            </div>
            <div style="font-size:13px;color:var(--tx-sub)">
              ${escapeHtml(a.service_name)} · <b class="tab-num" style="color:var(--tx)">${inr(a.price)}</b>
            </div>
            <div class="queue-acts">
              ${a.status !== 'In-Chair' ? `<button type="button" class="btn sec sm" data-action="set-status" data-id="${escapeHtml(a.id)}" data-status="In-Chair">Start Chair</button>` : ''}
              <button type="button" class="btn l sm" data-action="settle-apt" data-id="${escapeHtml(a.id)}">Settle Bill</button>
              <button type="button" class="btn sec sm" data-action="open-reschedule" data-id="${escapeHtml(a.id)}">Reschedule</button>
              <button type="button" class="btn sec sm" data-action="set-status" data-id="${escapeHtml(a.id)}" data-status="Cancelled" style="color:var(--coral)">Cancel</button>
            </div>
          </div>
        `).join('')}</div>`
    }
  </div>

  <div class="g r2">
    <!-- Stylist Performance -->
    <div class="card">
      <h2>Stylist Performance ${chip('Today')}</h2>
      ${d.stylistPerf.map((x, idx) => `
        <div style="margin-bottom:16px">
          <div class="ln">
            ${av(x.name, idx, 38)}
            <div class="gr">
              <b>${escapeHtml(x.name)}</b>
              <small>${x.clients_served} ${x.clients_served === 1 ? 'bill' : 'bills'} · ${x.live_rating} ${STAR_SVG}</small>
            </div>
            <b class="tab-num" style="font-size:15px">${inr(x.revenue)}</b>
          </div>
          <div class="trk">
            <i style="--i:${idx};width:${x.revenue ? Math.max((x.revenue / styMax) * 100, 4) : 0}%;background:${COL[idx % COL.length]}"></i>
          </div>
        </div>
      `).join('')}
      ${topSty && topSty.revenue > 0 ? `
        <div class="insight-box">
          <small class="mut" style="font-weight:700;display:block">Top Producer Today</small>
          <b>${escapeHtml(topSty.name)}</b> drives ${d.todayRevenue ? Math.round((topSty.revenue / d.todayRevenue) * 100) : 0}% of today’s revenue.
        </div>
      ` : ''}
    </div>

    <!-- Today's Billed Log -->
    <div class="card">
      <h2>Today’s Billed Log <button type="button" class="link-btn" data-nav="customers">View clients</button></h2>
      ${d.completedToday.length === 0
        ? '<div class="mut" style="padding:18px 0;text-align:center;font-size:13.5px">No bills settled yet today.</div>'
        : d.completedToday.slice(0, 6).map((c, idx) => `
          <div class="row clickable" data-action="view-receipt" data-id="${escapeHtml(c.id)}" title="Click to view / reprint invoice">
            ${av(c.client_name, idx, 36)}
            <div class="gr">
              <b>${escapeHtml(c.client_name)}</b>
              <small>${escapeHtml(c.service_name)} · ${escapeHtml(c.stylist_name)}</small>
            </div>
            <div style="text-align:right">
              <b class="tab-num">${inr(c.price)}</b><br>
              ${chip(c.payment_mode, c.payment_mode === 'UPI' ? 'vio' : c.payment_mode === 'Cash' ? 'amb' : c.payment_mode === 'Split' ? 'lime' : '')}
            </div>
          </div>
        `).join('')
      }
    </div>

    <!-- Client Retention -->
    <div class="card fx" style="gap:12px;border-top:4px solid var(--lime)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        ${chip('Client Retention', 'lime')}
        <span class="mut" style="font-size:12px;font-weight:700">Win-back Engine</span>
      </div>
      <div class="big lg tab-num" data-count="${d.lapsedClients.length}" data-format="int">${d.lapsedClients.length}</div>
      <div style="font-weight:600">Clients inactive for 30+ days</div>
      <div class="bub">Hi ${escapeHtml(d.lapsedClients[0] ? d.lapsedClients[0].name.split(' ')[0] : 'there')}, we miss you at ${escapeHtml(d.settings?.salon_name || 'SalonDesk')}! Enjoy 20% off your Hair Spa this week.</div>
      <div class="sp"></div>
      <button type="button" class="btn f l" data-nav="campaigns">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICO.campaigns}</svg>
        Open WhatsApp Queue (${d.lapsedClients.length})
      </button>
    </div>
  </div>`;
}

function getWalkinTotals() {
  const selected = state.services.filter(s => state.walkin.selectedServiceIds.has(s.id));
  const subtotal = selected.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const discount = Math.min(subtotal, Math.max(0, Number(state.walkin.discount) || 0));
  const total = Math.max(0, subtotal - discount);
  const gstRate = Number(state.settings.gst_rate || 18);
  const taxable = +(total / (1 + gstRate / 100)).toFixed(2);
  const totalTax = +(total - taxable).toFixed(2);
  const cgst = +(totalTax / 2).toFixed(2);
  const sgst = +(totalTax - cgst).toFixed(2);
  return { selected, subtotal, discount, total, taxable, cgst, sgst, gstRate };
}

function renderWalkinView() {
  const w = state.walkin;
  if (w.selectedServiceIds.size === 0 && state.services.length > 0) {
    w.selectedServiceIds.add(state.services[0].id);
  }
  if (!w.stylistName && state.stylists.length > 0) {
    w.stylistName = state.stylists[0].name;
  }
  const calc = getWalkinTotals();
  const backBtn = `<button type="button" class="btn w" data-nav="dashboard"><svg viewBox="0 0 24 24" aria-hidden="true">${ICO.back}</svg> Back to Dashboard</button>`;

  return headerBar(
    w.settlingId ? 'Settle Scheduled Appointment' : 'Walk-in Counter Billing',
    'Instant GST invoice, SQLite persistence & WhatsApp e-bill',
    backBtn
  ) + `
  <div class="g c2">
    <div class="card">
      <h2>Customer &amp; Service Details ${w.settlingId ? chip('Settling Scheduled Slot', 'lime') : ''}</h2>

      <label class="fl" for="fp">10-Digit Mobile Number (auto-fills returning clients) <span class="req">*</span></label>
      <input class="in" id="fp" inputmode="numeric" maxlength="10" placeholder="e.g. 9820123456" value="${escapeHtml(w.phone)}" autocomplete="off" required>
      <div class="f-err" id="fp-err">Please enter a valid 10-digit mobile number</div>
      <div id="lookupBanner">${w.lookupClient ? `
        <div class="info-banner">
          Returning ${escapeHtml(w.lookupClient.tier)} Client · ${w.lookupClient.visits} visits · Total spend ${inr(w.lookupClient.total_spend)}
          ${w.lookupClient.formula_notes ? `<br>Notes: ${escapeHtml(w.lookupClient.formula_notes)}` : ''}
        </div>
      ` : ''}</div>

      <label class="fl" for="fn">Customer Full Name <span class="req">*</span></label>
      <input class="in" id="fn" placeholder="e.g. Arjun Malhotra" value="${escapeHtml(w.name)}" autocomplete="off" required>
      <div class="f-err" id="fn-err">Please enter customer full name</div>

      <fieldset class="fg">
        <legend>Services Completed <span class="req">*</span></legend>
        <div class="chips" id="cs" role="group" aria-label="Services Completed">
          ${state.services.map(s => `
            <button type="button" class="sv ${w.selectedServiceIds.has(s.id) ? 'on' : ''}" data-action="toggle-walkin-srv" data-id="${escapeHtml(s.id)}" aria-pressed="${w.selectedServiceIds.has(s.id) ? 'true' : 'false'}">
              ${escapeHtml(s.name)} · ${inr(s.price)}
            </button>
          `).join('')}
        </div>
        <div class="f-err" id="cs-err">Please select at least one service</div>
      </fieldset>

      <fieldset class="fg">
        <legend>Stylist Who Provided Service</legend>
        <div class="chips" id="cb" role="radiogroup" aria-label="Stylist selection">
          ${state.stylists.map(st => `
            <button type="button" class="sv ${w.stylistName === st.name ? 'on' : ''}" data-action="pick-walkin-stylist" data-val="${escapeHtml(st.name)}" role="radio" aria-checked="${w.stylistName === st.name ? 'true' : 'false'}">
              ${escapeHtml(st.name)}
            </button>
          `).join('')}
        </div>
      </fieldset>

      <div class="g c2-eq" style="margin-top:4px">
        <div>
          <label class="fl" for="fdisc">Discount (₹)</label>
          <input class="in" id="fdisc" type="number" min="0" max="${calc.subtotal}" step="10" value="${w.discount || 0}">
        </div>
        <div>
          <label class="fl" for="frating">Client Rating (1–5)</label>
          <select class="in" id="frating">
            ${[5, 4, 3, 2, 1].map(r => `<option value="${r}" ${w.rating === r ? 'selected' : ''}>${r} Stars</option>`).join('')}
          </select>
        </div>
      </div>

      <fieldset class="fg">
        <legend>Payment Collected Via</legend>
        <div class="chips" id="cp" role="radiogroup" aria-label="Payment Mode">
          ${['UPI', 'Cash', 'Card', 'Split'].map(m => `
            <button type="button" class="sv ${w.paymentMode === m ? 'on' : ''}" data-action="pick-paymode" data-val="${m}" role="radio" aria-checked="${w.paymentMode === m ? 'true' : 'false'}">
              ${m}
            </button>
          `).join('')}
        </div>
      </fieldset>

      ${w.paymentMode === 'Split' ? `
        <div class="g c2-eq" style="margin-top:8px;background:var(--soft);padding:12px;border-radius:16px">
          <div>
            <label class="fl" for="fsplitUpi" style="margin-top:0">UPI Amount (₹)</label>
            <input class="in" id="fsplitUpi" type="number" min="0" max="${calc.total}" value="${w.splitUpi}">
          </div>
          <div>
            <label class="fl" for="fsplitCash" style="margin-top:0">Cash Amount (₹)</label>
            <input class="in" id="fsplitCash" type="number" min="0" max="${calc.total}" value="${w.splitCash}">
          </div>
        </div>
      ` : ''}

      <label class="fl" for="fnotes">Bill / Formula Notes (optional)</label>
      <input class="in" id="fnotes" placeholder="e.g. Used 8.1 ash blonde toner, VIP discount" value="${escapeHtml(w.notes)}" autocomplete="off">
    </div>

    <!-- Live Itemized Summary -->
    <div class="card elevated fx" style="gap:12px">
      <div class="dim" style="font-weight:600">Live Counter Bill Summary</div>
      <div class="big lg tab-num" id="tt">${inr(calc.total)}</div>
      <div style="background:var(--soft);border-radius:18px;padding:14px">
        ${calc.selected.length === 0
          ? '<div class="mut" style="font-size:13px">Select at least one service to compute invoice.</div>'
          : calc.selected.map(s => `
              <div class="sepl">
                <span>${escapeHtml(s.name)} <small>(${s.duration}m)</small></span>
                <b class="tab-num">${inr(s.price)}</b>
              </div>
            `).join('')
        }
        ${calc.discount > 0 ? `<div class="sepl"><span>Discount</span><b class="tab-num" style="color:var(--wa)">-${inr(calc.discount)}</b></div>` : ''}
        <div class="sepl"><span>Taxable Value</span><span class="tab-num">₹${calc.taxable.toFixed(2)}</span></div>
        <div class="sepl"><span>CGST (${calc.gstRate / 2}%) + SGST (${calc.gstRate / 2}%)</span><span class="tab-num">₹${(calc.cgst + calc.sgst).toFixed(2)}</span></div>
      </div>
      <div class="sp"></div>
      <button type="button" class="btn l f" id="sv2" style="font-size:15px;font-weight:700">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICO.check}</svg>
        Complete &amp; Settle Bill (${escapeHtml(w.paymentMode)})
      </button>
    </div>
  </div>`;
}

function renderBookingView() {
  const b = state.booking;
  if (b.selectedServiceIds.size === 0 && state.services.length > 0) {
    b.selectedServiceIds.add(state.services[0].id);
  }
  if (!b.stylistName && state.stylists.length > 0) {
    b.stylistName = state.stylists[0].name;
  }
  const selected = state.services.filter(s => b.selectedServiceIds.has(s.id));
  const estPrice = selected.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const estDuration = selected.reduce((sum, s) => sum + Number(s.duration || 45), 0);
  const backBtn = `<button type="button" class="btn w" data-nav="dashboard"><svg viewBox="0 0 24 24" aria-hidden="true">${ICO.back}</svg> Back to Dashboard</button>`;

  return headerBar('New Appointment Booking', 'Double-booking protected chair reservation', backBtn) + `
  <div class="g c2">
    <div class="card">
      <h2>Client &amp; Slot Details</h2>
      ${b.conflictError ? `
        <div class="alert-box">
          ${escapeHtml(b.conflictError)}
          <div style="margin-top:8px">
            <button type="button" class="btn dan sm" data-action="force-book">Override &amp; Double-Book Anyway</button>
          </div>
        </div>
      ` : ''}

      <label class="fl" for="ap">10-Digit Mobile Number <span class="req">*</span></label>
      <input class="in" id="ap" inputmode="numeric" maxlength="10" placeholder="e.g. 9820123456" value="${escapeHtml(b.phone)}" autocomplete="off" required>
      <div class="f-err" id="ap-err">Please enter a valid 10-digit mobile number</div>

      <label class="fl" for="an">Client Full Name <span class="req">*</span></label>
      <input class="in" id="an" placeholder="e.g. Vikram Malhotra" value="${escapeHtml(b.name)}" autocomplete="off" required>
      <div class="f-err" id="an-err">Please enter client full name</div>

      <div class="g c2-eq" style="margin-top:6px">
        <div>
          <label class="fl" for="ad">Appointment Date</label>
          <input class="in" id="ad" type="date" min="${todayIso()}" value="${escapeHtml(b.date)}">
        </div>
        <div>
          <fieldset class="fg" style="margin-top:14px">
            <legend>Preferred Time Slot</legend>
            <div class="chips" id="at" role="radiogroup" aria-label="Preferred Time Slot">
              ${TIME_SLOTS.map(t => `
                <button type="button" class="sv ${b.time === t ? 'on' : ''}" data-action="pick-book-time" data-val="${t}" role="radio" aria-checked="${b.time === t ? 'true' : 'false'}">
                  ${t}
                </button>
              `).join('')}
            </div>
          </fieldset>
        </div>
      </div>

      <fieldset class="fg">
        <legend>Select Salon Services <span class="req">*</span></legend>
        <div class="chips" id="as" role="group" aria-label="Salon Services">
          ${state.services.map(s => `
            <button type="button" class="sv ${b.selectedServiceIds.has(s.id) ? 'on' : ''}" data-action="toggle-book-srv" data-id="${escapeHtml(s.id)}" aria-pressed="${b.selectedServiceIds.has(s.id) ? 'true' : 'false'}">
              ${escapeHtml(s.name)} · ${inr(s.price)}
            </button>
          `).join('')}
        </div>
        <div class="f-err" id="as-err">Please select at least 1 service</div>
      </fieldset>

      <fieldset class="fg">
        <legend>Assign Stylist / Specialist</legend>
        <div class="chips" id="ab" role="radiogroup" aria-label="Stylist Assignment">
          ${state.stylists.map(st => `
            <button type="button" class="sv ${b.stylistName === st.name ? 'on' : ''}" data-action="pick-book-stylist" data-val="${escapeHtml(st.name)}" role="radio" aria-checked="${b.stylistName === st.name ? 'true' : 'false'}">
              ${escapeHtml(st.name)}
            </button>
          `).join('')}
        </div>
      </fieldset>

      <label class="fl" for="anotes">Special Preferences / Notes</label>
      <input class="in" id="anotes" placeholder="e.g. Wedding styling consultation" value="${escapeHtml(b.notes)}" autocomplete="off">
    </div>

    <div class="card elevated fx" style="gap:12px">
      <div class="dim" style="font-weight:600">Estimated Service Value</div>
      <div class="big lg tab-num">${inr(estPrice)}</div>
      <div class="dim" style="font-size:13.5px">Estimated duration: <b>${estDuration} mins</b> · ${escapeHtml(formatDisplayDate(b.date))} at ${escapeHtml(b.time)}</div>
      <div style="background:var(--soft);border-radius:16px;padding:14px;font-size:13px;line-height:1.5">
        <b>Double-Booking Guard Active</b><br>
        The server verifies that <b>${escapeHtml(b.stylistName)}</b> is free on this slot before confirming. Payment is settled at checkout.
      </div>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;font-weight:500">
        <input type="checkbox" id="sendWaCheck" ${b.sendWa ? 'checked' : ''} style="accent-color:var(--lime);width:18px;height:18px">
        Open WhatsApp booking confirmation after saving
      </label>
      <div class="sp"></div>
      <button type="button" class="btn l f" id="btnBookAppt" style="font-size:15px;font-weight:700">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICO.appointment}</svg>
        Confirm &amp; Schedule Slot
      </button>
    </div>
  </div>`;
}

function renderClientsView() {
  const all = state.clients;
  const counts = {
    All: all.length,
    VIP: all.filter(c => c.tier === 'VIP').length,
    Returning: all.filter(c => c.tier === 'Returning').length,
    New: all.filter(c => c.tier === 'New').length,
    'At risk': all.filter(c => c.tier === 'At risk').length
  };
  const filtered = state.clientFilter === 'All' ? all : all.filter(c => c.tier === state.clientFilter);
  const repeatCount = all.filter(c => c.visits > 1).length;
  const repeatPct = all.length ? Math.round((repeatCount / all.length) * 100) : 0;
  const totalVisits = all.reduce((s, c) => s + Number(c.visits || 0), 0);
  const totalSpend = all.reduce((s, c) => s + Number(c.total_spend || 0), 0);
  const avgTicket = totalVisits ? Math.round(totalSpend / totalVisits) : 0;
  const tierCls = { VIP: 'lime', Returning: 'vio', New: 'amb', 'At risk': 'coral' };

  return headerBar('Clients & Visit History', `${all.length} SQLite client records · ${repeatPct}% repeat rate`) + `
  <div class="g c4">
    ${statCard('Total Clients', String(all.length), 'Synced with SQLite', '', { value: all.length, format: 'int' })}
    ${statCard('Repeat Rate', `${repeatPct}%`, `${repeatCount} returning clients`, 'vio', { value: repeatPct, format: 'pct' })}
    ${statCard('Avg. Ticket', inr(avgTicket), 'Across all visits', 'amb', { value: avgTicket, format: 'inr' })}
    ${statCard('Due for Visit', String(counts['At risk']), '30+ days inactive', 'lime', { value: counts['At risk'], format: 'int' })}
  </div>

  <div class="pills" role="tablist" aria-label="Filter clients by tier">
    ${['All', 'VIP', 'Returning', 'New', 'At risk'].map(k => `
      <button type="button" class="pill ${state.clientFilter === k ? 'on' : ''}" data-action="filter-clients" data-val="${k}" role="tab" aria-selected="${state.clientFilter === k ? 'true' : 'false'}">
        ${k} ${counts[k]}
      </button>
    `).join('')}
    <span class="mut" style="margin-left:auto;font-size:12.5px;font-weight:600">Click any client for 360° profile &amp; formula notes</span>
  </div>

  <div class="card tw">
    <table>
      <thead>
        <tr>
          <th scope="col">Client</th>
          <th scope="col">Mobile</th>
          <th scope="col">Last Visit</th>
          <th scope="col">Visits</th>
          <th scope="col">Total Spend</th>
          <th scope="col">Preferred Stylist</th>
          <th scope="col">Rating</th>
          <th scope="col">Tier</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.length === 0
          ? '<tr><td colspan="9" style="text-align:center;padding:24px" class="mut">No clients match this filter.</td></tr>'
          : filtered.map((c, idx) => `
            <tr class="clickable" data-action="open-client" data-id="${escapeHtml(c.id)}">
              <td>
                <div class="ln">
                  ${av(c.name, idx, 36)}
                  <div class="gr">
                    <b>${escapeHtml(c.name)}</b>
                    <small>${escapeHtml(c.last_service || 'New client')}</small>
                  </div>
                </div>
              </td>
              <td class="tab-num">${escapeHtml(formatPhone(c.phone))}</td>
              <td ${c.days_ago >= 30 ? 'style="color:var(--coral);font-weight:600"' : ''}>${!c.last_visit_at ? 'No visit yet' : c.days_ago === 0 ? 'Today' : c.days_ago === 1 ? 'Yesterday' : `${c.days_ago} days ago`}</td>
              <td><b>${c.visits}</b></td>
              <td><b class="tab-num">${inr(c.total_spend)}</b></td>
              <td>${escapeHtml(c.preferred_stylist || '–')}</td>
              <td><b>${c.rating} ${STAR_SVG}</b></td>
              <td>${chip(c.tier, tierCls[c.tier] || '')}</td>
              <td>
                <button type="button" class="btn-wa" data-action="wa-offer" data-id="${escapeHtml(c.id)}">
                  ${WA_SVG} Send Offer
                </button>
              </td>
            </tr>
          `).join('')
        }
      </tbody>
    </table>
    <div class="mut" style="font-size:13px;padding-top:12px">Showing ${filtered.length} of ${all.length} verified client records</div>
  </div>`;
}

function renderStylistsView() {
  const periodSeg = `
    <div class="seg" role="tablist" aria-label="Performance period">
      ${[['today', 'Today'], ['week', 'Week'], ['month', 'Month']].map(([k, lbl]) => `
        <button type="button" class="${state.stylistPeriod === k ? 'on' : ''}" data-action="stylist-period" data-val="${k}" role="tab" aria-selected="${state.stylistPeriod === k ? 'true' : 'false'}">${lbl}</button>
      `).join('')}
    </div>
    <button type="button" class="btn l" data-action="open-add-stylist">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICO.plus}</svg> Add Stylist
    </button>
  `;

  return headerBar('Stylists & Specialists', `${state.stylists.length} active team members · Real SQL commissions`, periodSeg) + `
  <div class="g c4">
    ${state.stylists.map((st, idx) => {
      const maxWk = Math.max(...(st.weekly_counts || [1]), 1);
      return `
        <div class="card fx" style="gap:14px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              ${av(st.name, idx, 42)}
              <div class="gr">
                <b style="font-size:15.5px">${escapeHtml(st.name)}</b>
                <small>${escapeHtml(st.role)}</small>
              </div>
            </div>
            ${idx === 0 && st.revenue > 0 ? chip('Top Producer', 'lime') : chip(`${st.live_rating} ★`)}
          </div>

          <div style="background:var(--soft);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <div>
                <small class="mut" style="font-size:11px;font-weight:700;display:block">${escapeHtml(state.stylistPeriod.toUpperCase())} REVENUE</small>
                <b class="tab-num" style="font-size:17px">${inr(st.revenue)}</b>
              </div>
              <div style="text-align:right">
                <small class="mut" style="font-size:11px;font-weight:700;display:block">AVG. TICKET</small>
                <b class="tab-num" style="font-size:15px">${inr(st.avg_ticket)}</b>
              </div>
            </div>
            <div class="sepl" style="border-top:1px solid var(--line);border-bottom:0;padding:8px 0 0">
              <span style="font-size:12px">Bills Completed</span>
              <b class="tab-num">${st.clients_served}</b>
            </div>
          </div>

          <div>
            <small class="mut" style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Last 7 Days Activity</small>
            <div class="bars" style="height:56px;padding-top:14px">
              ${(st.weekly_counts || [0,0,0,0,0,0,0]).map((cnt, j) => `
                <div class="bar-col ${j === 6 ? 't' : ''}">
                  <span class="bar-tip">${cnt} bills</span>
                  <u style="--i:${j};height:${cnt ? Math.max((cnt / maxWk) * 100, 18) : 6}%"></u>
                </div>
              `).join('')}
            </div>
          </div>

          <div style="background:var(--soft);border-radius:16px;padding:10px 14px;margin-top:auto">
            <div class="sepl"><span>Repeat Retention</span><b>${st.retention_pct}%</b></div>
            <div class="sepl"><span>Commission (${st.commission_pct}%)</span><b class="tab-num">${inr(st.commission_earned)}</b></div>
          </div>

          <button type="button" class="btn sec sm" style="justify-content:center" data-action="open-edit-stylist" data-id="${escapeHtml(st.id)}">
            Edit Role &amp; Commission
          </button>
        </div>
      `;
    }).join('')}
  </div>`;
}

function renderCampaignsView() {
  const optedIn = state.clients.filter(c => c.opted_in);
  const segList = [
    { key: 'At risk', label: 'Lapsed 30+ days', count: optedIn.filter(c => c.tier === 'At risk').length },
    { key: 'VIP', label: 'VIP Lounge', count: optedIn.filter(c => c.tier === 'VIP').length },
    { key: 'Returning', label: 'Returning Clients', count: optedIn.filter(c => c.tier === 'Returning').length },
    { key: 'All', label: 'All Opted-In', count: optedIn.length }
  ];
  const curSeg = segList.find(s => s.key === state.campSegment) || segList[0];
  const sampleClient = (curSeg.key === 'All' ? optedIn : optedIn.filter(c => c.tier === curSeg.key))[0];
  const previewText = state.campMessage.replaceAll('{name}', sampleClient ? sampleClient.name.split(' ')[0] : 'Valued Guest');

  const totalSent = state.campaigns.reduce((s, c) => s + Number(c.sent_count || 0), 0);
  const totalAud = state.campaigns.reduce((s, c) => s + Number(c.audience_count || 0), 0);

  return headerBar('WhatsApp Marketing & Opt-In Queue', 'Honest 1-click WhatsApp dispatch logged in SQLite', '') + `
  <div class="g c4">
    ${statCard('Campaigns Logged', String(state.campaigns.length), 'Stored in SQLite')}
    ${statCard('Messages Dispatched', String(totalSent), `of ${totalAud} targeted`, 'vio')}
    ${statCard('Opted-In Audience', String(optedIn.length), `${state.clients.length - optedIn.length} opted out`, 'amb')}
    ${statCard('At-Risk Win-Back', String(segList[0].count), 'Ready for 20% offer', 'lime')}
  </div>

  <div class="g c2">
    <div class="fx" style="gap:18px">
      ${state.activeCampQueue ? `
        <div class="card" style="border-top:4px solid var(--wa)">
          <h2>
            Active Dispatch Queue: ${escapeHtml(state.activeCampQueue.campaign.name)}
            ${chip(`${state.activeCampQueue.sentPhones.size}/${state.activeCampQueue.recipients.length} sent`, 'lime')}
          </h2>
          <p class="mut" style="font-size:13px;margin:0 0 12px">Click each opted-in client below to open their personalized WhatsApp message and mark them sent in SQLite.</p>
          ${state.activeCampQueue.recipients.length === 0
            ? '<div class="mut">No opted-in clients in this segment.</div>'
            : state.activeCampQueue.recipients.map(r => {
                const done = state.activeCampQueue.sentPhones.has(r.phone);
                return `
                  <div class="row">
                    ${av(r.name, 0, 34)}
                    <div class="gr">
                      <b>${escapeHtml(r.name)}</b>
                      <small>${escapeHtml(formatPhone(r.phone))} · ${escapeHtml(r.tier)}</small>
                    </div>
                    ${done
                      ? chip('Sent ✓', 'lime')
                      : `<button type="button" class="btn-wa" data-action="send-queue-item" data-phone="${escapeHtml(r.phone)}" data-name="${escapeHtml(r.name)}">${WA_SVG} Send</button>`
                    }
                  </div>
                `;
              }).join('')
          }
        </div>
      ` : ''}

      <div class="card tw">
        <h2>Campaign History (SQLite Log)</h2>
        <table style="min-width:520px">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Segment</th>
              <th scope="col">Audience</th>
              <th scope="col">Sent</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            ${state.campaigns.map(c => `
              <tr>
                <td><b>${escapeHtml(c.name)}</b></td>
                <td class="mut">${escapeHtml(c.segment)}</td>
                <td class="tab-num">${c.audience_count}</td>
                <td class="tab-num"><b>${c.sent_count}</b></td>
                <td>${chip(c.status, c.status === 'Completed' ? 'lime' : 'amb')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Compose WhatsApp Offer ${chip(`${curSeg.count} opted-in`, 'lime')}</h2>
      <label class="fl" for="campName">Campaign Name</label>
      <input class="in" id="campName" value="${escapeHtml(state.campName)}">

      <fieldset class="fg">
        <legend>Audience Segment (Opted-in Only)</legend>
        <div class="pills">
          ${segList.map(s => `
            <button type="button" class="pill ${state.campSegment === s.key ? 'on' : ''}" data-action="pick-camp-seg" data-val="${s.key}">
              ${escapeHtml(s.label)} · ${s.count}
            </button>
          `).join('')}
        </div>
      </fieldset>

      <label class="fl" for="campMsg">Message Template (use <code>{name}</code>)</label>
      <textarea class="in" id="campMsg">${escapeHtml(state.campMessage)}</textarea>

      <label class="fl">Live WhatsApp Bubble Preview</label>
      <div style="background:var(--soft);border-radius:20px;padding:14px;margin-bottom:14px">
        <div class="bub" id="campPreview">${escapeHtml(previewText)}</div>
      </div>

      <button type="button" class="btn f l" id="btnLaunchCamp" ${curSeg.count === 0 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICO.campaigns}</svg>
        Create Campaign &amp; Open 1-Click Queue (${curSeg.count})
      </button>
    </div>
  </div>`;
}

function renderReportsView() {
  const r = state.reports;
  if (!r) return `<div class="card">Loading financial reports...</div>`;

  const periodCtrl = `
    <div class="seg" role="tablist" aria-label="Report period">
      ${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, lbl]) => `
        <button type="button" class="${state.reportPeriod === k ? 'on' : ''}" data-action="report-period" data-val="${k}" role="tab" aria-selected="${state.reportPeriod === k ? 'true' : 'false'}">${lbl}</button>
      `).join('')}
    </div>
    <button type="button" class="btn l" data-action="export-gst-csv">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICO.download}</svg> Export GST CSV
    </button>
  `;

  const dailySeries = r.dailySeries || [];
  const serviceMix = r.serviceMix || [];
  const maxRev = Math.max(...dailySeries.map(d => d.revenue), 1);
  const bestDay = dailySeries.reduce((best, cur) => cur.revenue > best.revenue ? cur : best, dailySeries[0] || { revenue: 0 });
  const pmTotal = (r.paymentSplit?.UPI || 0) + (r.paymentSplit?.Card || 0) + (r.paymentSplit?.Cash || 0);
  const pct = (v) => pmTotal ? Math.round((v / pmTotal) * 100) : 0;

  return headerBar('Revenue & GST Audit Ledger', `${r.startDate || ''} to ${r.endDate || ''} · Real-time Salon Ledger`, periodCtrl) + `
  <div class="g c4">
    ${statCard('Gross Revenue', inr(r.totalRevenue), r.revenueDeltaPct != null ? `${r.revenueDeltaPct >= 0 ? '↑' : '↓'} ${Math.abs(r.revenueDeltaPct)}% vs prev period` : 'Live period total', 'vio', { value: r.totalRevenue, format: 'inr' })}
    ${statCard('Completed Bills', String(r.footfall), `Avg ticket ${inr(r.avgTicket)}`, '', { value: r.footfall, format: 'int' })}
    ${statCard('GST Collected (Incl.)', inr(r.totalGst), `Discounts given: ${inr(r.totalDiscount)}`, 'amb', { value: r.totalGst, format: 'inr' })}
    ${statCard('Client Retention', `${r.retentionPct}%`, 'Repeat visitors across DB', 'lime', { value: r.retentionPct, format: 'pct' })}
  </div>

  <div class="g c2">
    <div class="card fx">
      <h2>Daily Gross Revenue ${chip(`Last ${dailySeries.length} Days`)}</h2>
      <div class="wk" aria-label="Daily revenue chart">
        ${dailySeries.map((d, idx) => {
          const isBest = d.revenue > 0 && d.revenue === bestDay.revenue;
          const isToday = idx === dailySeries.length - 1;
          const lbl = d.label || d.date;
          const shortLbl = d.shortLabel || (d.date ? d.date.slice(-2) : '');
          return `
            <div class="bar-col ${isBest ? 'bst' : isToday ? 'td' : ''}" tabindex="0" aria-label="${escapeHtml(lbl)}: ${inr(d.revenue)}">
              <span class="bar-tip">${escapeHtml(lbl)}: ${inr(d.revenue)} (${d.count})</span>
              <u style="--i:${idx};height:${d.revenue ? Math.max((d.revenue / maxRev) * 100, 10) : 4}%"></u>
              <span>${escapeHtml(shortLbl)}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="card fx" style="gap:12px">
      <h2>Payment Settlement &amp; Cash Drawer ${chip('Reconciled', 'lime')}</h2>
      <div class="seg-bar">
        <i style="width:${pct(r.paymentSplit.UPI)}%;background:var(--chart-upi)"></i>
        <i style="width:${pct(r.paymentSplit.Card)}%;background:var(--chart-card)"></i>
        <i style="width:${pct(r.paymentSplit.Cash)}%;background:var(--chart-cash)"></i>
      </div>
      <div class="leg"><i style="background:var(--chart-upi)"></i>UPI / QR Direct<b class="tab-num">${inr(r.paymentSplit.UPI)}</b><span>${pct(r.paymentSplit.UPI)}%</span></div>
      <div class="leg"><i style="background:var(--chart-card)"></i>Card POS<b class="tab-num">${inr(r.paymentSplit.Card)}</b><span>${pct(r.paymentSplit.Card)}%</span></div>
      <div class="leg"><i style="background:var(--chart-cash)"></i>Cash Collected<b class="tab-num">${inr(r.paymentSplit.Cash)}</b><span>${pct(r.paymentSplit.Cash)}%</span></div>

      <div style="background:var(--soft);border-radius:16px;padding:14px;margin-top:auto">
        <small class="mut" style="font-weight:700;display:block;margin-bottom:6px">END-OF-DAY CASH DRAWER</small>
        <div class="sepl"><span>Opening Float</span><b class="tab-num">${inr(r.openingCash || 0)}</b></div>
        <div class="sepl"><span>Cash Sales (${escapeHtml(state.reportPeriod)})</span><b class="tab-num">+${inr(r.paymentSplit.Cash)}</b></div>
        <div class="sepl"><span><b>Expected Cash in Drawer</b></span><b class="tab-num" style="font-size:15px">${inr(r.expectedDrawerCash ?? r.paymentSplit.Cash)}</b></div>
      </div>
    </div>
  </div>

  <div class="card tw">
    <h2>Service Revenue Mix</h2>
    <table style="min-width:520px">
      <thead>
        <tr>
          <th scope="col">Service</th>
          <th scope="col">Times Performed</th>
          <th scope="col">Gross Revenue</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        ${serviceMix.length === 0
          ? '<tr><td colspan="4" class="mut" style="text-align:center;padding:18px">No completed bills in this period.</td></tr>'
          : serviceMix.map(s => `
            <tr>
              <td><b>${escapeHtml(s.name)}</b></td>
              <td class="tab-num">${s.count}</td>
              <td class="tab-num"><b>${inr(s.revenue)}</b></td>
              <td class="tab-num">${r.totalRevenue ? Math.round((s.revenue / r.totalRevenue) * 100) : 0}%</td>
            </tr>
          `).join('')
        }
      </tbody>
    </table>
  </div>`;
}

function renderSettingsView() {
  const s = state.settings;
  return headerBar('Settings, GST & Service Catalog', 'Configure salon profile, pricing, owner PIN, and dev tools', '') + `
  <div class="g c2">
    <div class="card">
      <h2>Salon Profile &amp; Indian GST Invoice</h2>
      <form id="settingsForm">
        <label class="fl" for="setSalon">Salon Name</label>
        <input class="in" id="setSalon" name="salon_name" value="${escapeHtml(s.salon_name || '')}" required>

        <label class="fl" for="setBranch">Branch Address / Lounge</label>
        <input class="in" id="setBranch" name="branch_name" value="${escapeHtml(s.branch_name || '')}">

        <div class="g c2-eq">
          <div>
            <label class="fl" for="setGstin">GSTIN</label>
            <input class="in" id="setGstin" name="gstin" value="${escapeHtml(s.gstin || '')}">
          </div>
          <div>
            <label class="fl" for="setSac">SAC Code</label>
            <input class="in" id="setSac" name="sac_code" value="${escapeHtml(s.sac_code || '999722')}">
          </div>
        </div>

        <div class="g c2-eq">
          <div>
            <label class="fl" for="setGstRate">Inclusive GST Rate (%)</label>
            <input class="in" id="setGstRate" name="gst_rate" type="number" min="0" max="28" value="${escapeHtml(s.gst_rate || '18')}">
          </div>
          <div>
            <label class="fl" for="setCash">Opening Cash Float (₹)</label>
            <input class="in" id="setCash" name="opening_cash" type="number" min="0" value="${escapeHtml(s.opening_cash || '5000')}">
          </div>
        </div>

        <label class="fl" for="setPin">Owner Security PIN ${s.has_owner_pin ? chip('PIN Active', 'lime') : chip('Unset')}</label>
        <input class="in" id="setPin" name="owner_pin" type="password" placeholder="Leave blank to keep unchanged (or enter 4-digit PIN)">

        <div class="modal-actions">
          <button type="submit" class="btn l">Save Salon Settings</button>
        </div>
      </form>
    </div>

    <div class="fx" style="gap:18px">
      <div class="card">
        <h2>
          Services &amp; Pricing Catalog
          <button type="button" class="btn l sm" data-action="open-add-service">
            <svg viewBox="0 0 24 24" aria-hidden="true">${ICO.plus}</svg> Add Service
          </button>
        </h2>
        ${state.services.map(srv => `
          <div class="row">
            <div class="gr">
              <b>${escapeHtml(srv.name)}</b>
              <small>${escapeHtml(srv.category)} · ${srv.duration} mins</small>
            </div>
            <b class="tab-num">${inr(srv.price)}</b>
            <button type="button" class="btn sec sm" data-action="open-edit-service" data-id="${escapeHtml(srv.id)}">Edit</button>
            <button type="button" class="btn sec sm" style="color:var(--coral)" data-action="delete-service" data-id="${escapeHtml(srv.id)}">Archive</button>
          </div>
        `).join('')}
      </div>

      <div class="card" style="border-color:rgba(220,38,38,0.3)">
        <h2>Danger Zone &amp; Owner Access</h2>
        ${s.has_owner_pin ? `
          <div style="margin-bottom:14px">
            <label class="fl" for="unlockPin" style="margin-top:0">Session Owner PIN (for protected admin actions)</label>
            <div style="display:flex;gap:8px">
              <input class="in" id="unlockPin" type="password" placeholder="Enter PIN" value="${escapeHtml(getSessionOwnerPin())}">
              <button type="button" class="btn sec" data-action="save-session-pin">Apply PIN</button>
            </div>
          </div>
        ` : ''}
        <p class="mut" style="font-size:13px;margin:0 0 12px">Resetting clears all transactions and restores demo seed data. Automatically disabled when <code>NODE_ENV=production</code>.</p>
        <button type="button" class="btn dan sm" data-action="open-reset-modal">Reset Demo Database</button>
      </div>
    </div>
  </div>`;
}

// ===================== CLIENT 360 DRAWER & DYNAMIC MODALS =====================
async function openClientDrawer(clientId) {
  try {
    const client = await api.getClientById(clientId);
    $('#cdTitle').textContent = client.name;
    $('#cdBody').innerHTML = `
      <div class="ln" style="margin-bottom:16px">
        ${av(client.name, 1, 48)}
        <div class="gr">
          <b style="font-size:16px">${escapeHtml(client.name)}</b>
          <small>${escapeHtml(formatPhone(client.phone))} · ${chip(client.tier, client.tier === 'VIP' ? 'lime' : client.tier === 'At risk' ? 'coral' : 'vio')}</small>
        </div>
      </div>

      <div class="g c2-eq" style="margin-bottom:14px">
        <div style="background:var(--soft);padding:12px;border-radius:14px">
          <small class="mut">Total Visits</small><br><b class="tab-num" style="font-size:20px">${client.visits}</b>
        </div>
        <div style="background:var(--soft);padding:12px;border-radius:14px">
          <small class="mut">Lifetime Spend</small><br><b class="tab-num" style="font-size:20px">${inr(client.total_spend)}</b>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
        <button type="button" class="btn l sm" data-action="quick-bill-client" data-id="${escapeHtml(client.id)}">Quick Walk-in Bill</button>
        <button type="button" class="btn-wa" data-action="wa-offer" data-id="${escapeHtml(client.id)}">${WA_SVG} Send WhatsApp Offer</button>
      </div>

      <form id="clientNotesForm" data-id="${escapeHtml(client.id)}">
        <label class="fl" for="cdFormula">Hair Color Formula / Service Preferences</label>
        <textarea class="in" id="cdFormula" placeholder="e.g. Ash blonde 8.1 + Olaplex, prefers quiet chair">${escapeHtml(client.formula_notes || '')}</textarea>
        <label style="display:flex;align-items:center;gap:8px;margin:10px 0;font-size:13px;cursor:pointer">
          <input type="checkbox" id="cdOptIn" ${client.opted_in ? 'checked' : ''} style="width:17px;height:17px;accent-color:var(--lime)">
          Opted in for WhatsApp promotional offers
        </label>
        <button type="submit" class="btn sec sm">Save Profile Notes</button>
      </form>

      <h3 style="margin:22px 0 10px;font-size:14.5px">Visit &amp; Invoice History (${client.history.length})</h3>
      ${client.history.length === 0
        ? '<div class="mut" style="font-size:13px">No appointments recorded yet.</div>'
        : client.history.map(h => `
          <div class="row clickable" data-action="view-receipt" data-id="${escapeHtml(h.id)}">
            <div class="gr">
              <b>${escapeHtml(h.service_name)}</b>
              <small>${escapeHtml(formatDisplayDate(h.date))} · ${escapeHtml(h.stylist_name)} · ${escapeHtml(h.status)}</small>
            </div>
            <b class="tab-num">${inr(h.price)}</b>
          </div>
        `).join('')
      }
    `;
    openOverlay('clientDrawer');
  } catch (err) {
    toast(err.message);
  }
}

function openStylistModal(stylist = null) {
  $('#fmTitle').textContent = stylist ? `Edit ${stylist.name}` : 'Add New Stylist';
  $('#fmBody').innerHTML = `
    <form id="stylistForm" data-id="${escapeHtml(stylist?.id || '')}">
      <label class="fl" for="stName">Full Name <span class="req">*</span></label>
      <input class="in" id="stName" name="name" value="${escapeHtml(stylist?.name || '')}" required>
      <label class="fl" for="stRole">Role / Specialty <span class="req">*</span></label>
      <input class="in" id="stRole" name="role" value="${escapeHtml(stylist?.role || '')}" placeholder="e.g. Senior Hair Stylist" required>
      <div class="g c2-eq">
        <div>
          <label class="fl" for="stPhone">Mobile Number</label>
          <input class="in" id="stPhone" name="phone" maxlength="10" value="${escapeHtml(stylist?.phone || '')}">
        </div>
        <div>
          <label class="fl" for="stComm">Commission (%)</label>
          <input class="in" id="stComm" name="commission_pct" type="number" min="0" max="100" value="${escapeHtml(stylist?.commission_pct ?? 35)}" required>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn sec" data-close-modal="formModal">Cancel</button>
        <button type="submit" class="btn l">${stylist ? 'Update Stylist' : 'Add Stylist'}</button>
      </div>
    </form>
  `;
  openOverlay('formModal');
}

function openServiceModal(srv = null) {
  $('#fmTitle').textContent = srv ? `Edit ${srv.name}` : 'Add Salon Service';
  $('#fmBody').innerHTML = `
    <form id="serviceForm" data-id="${escapeHtml(srv?.id || '')}">
      <label class="fl" for="svName">Service Name <span class="req">*</span></label>
      <input class="in" id="svName" name="name" value="${escapeHtml(srv?.name || '')}" required>
      <label class="fl" for="svCat">Category</label>
      <input class="in" id="svCat" name="category" value="${escapeHtml(srv?.category || 'Hair & Grooming')}">
      <div class="g c2-eq">
        <div>
          <label class="fl" for="svPrice">Price (₹) <span class="req">*</span></label>
          <input class="in" id="svPrice" name="price" type="number" min="0" value="${escapeHtml(srv?.price ?? 650)}" required>
        </div>
        <div>
          <label class="fl" for="svDur">Duration (mins) <span class="req">*</span></label>
          <input class="in" id="svDur" name="duration" type="number" min="5" value="${escapeHtml(srv?.duration ?? 45)}" required>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn sec" data-close-modal="formModal">Cancel</button>
        <button type="submit" class="btn l">${srv ? 'Save Changes' : 'Add Service'}</button>
      </div>
    </form>
  `;
  openOverlay('formModal');
}

function openRescheduleModal(apt) {
  $('#fmTitle').textContent = `Reschedule: ${apt.client_name}`;
  $('#fmBody').innerHTML = `
    <form id="rescheduleForm" data-id="${escapeHtml(apt.id)}">
      <label class="fl" for="rsDate">New Date</label>
      <input class="in" id="rsDate" name="date" type="date" value="${escapeHtml(apt.date)}" required>
      <label class="fl" for="rsTime">New Time Slot</label>
      <select class="in" id="rsTime" name="time">
        ${TIME_SLOTS.map(t => `<option value="${t}" ${apt.time === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <label class="fl" for="rsStylist">Assigned Stylist</label>
      <select class="in" id="rsStylist" name="stylist_name">
        ${state.stylists.map(st => `<option value="${escapeHtml(st.name)}" ${apt.stylist_name === st.name ? 'selected' : ''}>${escapeHtml(st.name)}</option>`).join('')}
      </select>
      <div class="modal-actions">
        <button type="button" class="btn sec" data-close-modal="formModal">Cancel</button>
        <button type="submit" class="btn l">Save New Slot</button>
      </div>
    </form>
  `;
  openOverlay('formModal');
}

function openVoidBillModal(apt) {
  if (!apt) return;
  const needPin = Boolean(state.settings?.has_owner_pin && !getSessionOwnerPin());
  $('#fmTitle').textContent = `Void Invoice ${apt.invoice_no || apt.id}`;
  $('#fmBody').innerHTML = `
    <form id="voidBillForm" data-id="${escapeHtml(apt.id)}">
      <p class="mut" style="margin:0 0 12px;font-size:13.5px;line-height:1.5">
        Voiding <b>${escapeHtml(apt.client_name)}</b>'s bill (<b>${inr(apt.price)}</b>) removes it from GST audit totals and reverses the client's visit &amp; spend count.
      </p>
      ${needPin ? `
        <label class="fl" for="voidPin">Owner Security PIN <span class="req">*</span></label>
        <input class="in" id="voidPin" name="owner_pin" type="password" placeholder="Enter Owner PIN" required autocomplete="off">
      ` : ''}
      <div class="modal-actions">
        <button type="button" class="btn sec" data-close-modal="formModal">Keep Bill</button>
        <button type="submit" class="btn dan">Confirm Void Bill</button>
      </div>
    </form>
  `;
  openOverlay('formModal');
}

// ===================== DATA LOADING & RENDERING (SWR + NON-BLOCKING) =====================
let _navSeq = 0;
let _prewarmed = false;
const _syncState = {
  coreAt: 0,
  dashboardAt: 0,
  clientsAt: 0,
  campaignsAt: 0,
  reportsCache: {},
  stylistsCache: {},
  campaignsLoaded: false
};

function hasPageData(page) {
  switch (page) {
    case 'dashboard': return Boolean(state.dashboard);
    case 'walkin':
    case 'appointment':
    case 'settings': return state.services.length > 0 && state.stylists.length > 0;
    case 'customers': return state.clients.length > 0;
    case 'stylists': return Boolean(_syncState.stylistsCache[state.stylistPeriod]) || state.stylists.length > 0;
    case 'reports': return Boolean(_syncState.reportsCache[state.reportPeriod]);
    case 'campaigns': return _syncState.campaignsLoaded;
    default: return Boolean(state.dashboard);
  }
}

function invalidateClientCaches() {
  _syncState.coreAt = 0;
  _syncState.dashboardAt = 0;
  _syncState.clientsAt = 0;
  _syncState.campaignsAt = 0;
  _syncState.reportsCache = {};
  _syncState.stylistsCache = {};
}

async function ensureCoreData(force = false) {
  const fresh = !force && state.services.length > 0 && state.stylists.length > 0 && (Date.now() - _syncState.coreAt < 60_000);
  if (fresh) return;
  const [services, stylists, settings] = await Promise.all([
    api.getServices(),
    state.stylists.length ? Promise.resolve(state.stylists) : api.getStylists(state.stylistPeriod),
    api.getSettings()
  ]);
  state.services = services;
  state.stylists = stylists;
  state.settings = settings;
  _syncState.coreAt = Date.now();
}

async function refreshDataForPage(page = state.page, { force = false } = {}) {
  if (page === 'dashboard') {
    const tasks = [api.getDashboard()];
    if (force || state.services.length === 0) tasks.push(api.getServices());
    const [dash, services] = await Promise.all(tasks);
    state.dashboard = dash;
    if (dash?.settings) state.settings = dash.settings;
    if (dash?.stylistPerf && state.stylists.length === 0) state.stylists = dash.stylistPerf;
    if (services) state.services = services;
    _syncState.dashboardAt = Date.now();
    _syncState.coreAt = Date.now();
  } else if (page === 'walkin' || page === 'appointment' || page === 'settings') {
    await ensureCoreData(force);
  } else if (page === 'customers') {
    const [clients] = await Promise.all([
      api.getClients(),
      ensureCoreData(false)
    ]);
    state.clients = clients;
    _syncState.clientsAt = Date.now();
  } else if (page === 'stylists') {
    const stylists = await api.getStylists(state.stylistPeriod);
    state.stylists = stylists;
    _syncState.stylistsCache[state.stylistPeriod] = stylists;
  } else if (page === 'reports') {
    const reports = await api.getReports(state.reportPeriod);
    state.reports = reports;
    _syncState.reportsCache[state.reportPeriod] = reports;
  } else if (page === 'campaigns') {
    const tasks = [api.getCampaigns()];
    if (force || state.clients.length === 0) tasks.push(api.getClients());
    const [campaigns, clients] = await Promise.all(tasks);
    state.campaigns = campaigns;
    if (clients) {
      state.clients = clients;
      _syncState.clientsAt = Date.now();
    }
    _syncState.campaignsLoaded = true;
    _syncState.campaignsAt = Date.now();
  }
}

function prewarmBackgroundTabs() {
  if (_prewarmed || !isSalonLoggedIn()) return;
  _prewarmed = true;
  setTimeout(async () => {
    try {
      const [clients, reports] = await Promise.all([
        state.clients.length ? Promise.resolve(state.clients) : api.getClients(),
        _syncState.reportsCache[state.reportPeriod] ? Promise.resolve(_syncState.reportsCache[state.reportPeriod]) : api.getReports(state.reportPeriod)
      ]);
      if (clients && !state.clients.length) {
        state.clients = clients;
        _syncState.clientsAt = Date.now();
      }
      if (reports) {
        _syncState.reportsCache[state.reportPeriod] = reports;
        if (!state.reports) state.reports = reports;
      }
    } catch (_) {}
  }, 300);
}

function animateDigits(container) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const els = container.querySelectorAll('[data-count]');
  const duration = 640;

  els.forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const fmt = el.dataset.format || 'int';
    const formatVal = (v) => fmt === 'inr' ? inr(v) : fmt === 'pct' ? `${Math.round(v)}%` : String(Math.round(v));

    if (reduced || target === 0) {
      el.textContent = formatVal(target);
      return;
    }

    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = formatVal(target * eased);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = formatVal(target);
    };
    requestAnimationFrame(tick);
  });
}

function render(animate = false) {
  renderSidebar();
  const main = $('#main');
  let html = '';
  switch (state.page) {
    case 'walkin': html = renderWalkinView(); break;
    case 'appointment': html = renderBookingView(); break;
    case 'customers': html = renderClientsView(); break;
    case 'stylists': html = renderStylistsView(); break;
    case 'campaigns': html = renderCampaignsView(); break;
    case 'reports': html = renderReportsView(); break;
    case 'settings': html = renderSettingsView(); break;
    default: html = renderDashboardView(); break;
  }
  main.innerHTML = `<div class="view ${animate ? 'animate-in' : ''}">${html}</div>`;
  if (animate) {
    main.querySelectorAll('.card').forEach((card, idx) => {
      card.style.setProperty('--stagger', String(Math.min(idx, 6)));
    });
    animateDigits(main);
  }
}

function applyOptimisticSettlement(savedApt, usedPaymentMode, paymentSplit, settlingId) {
  const d = state.dashboard;
  if (!d || !savedApt) return;
  const price = Number(savedApt.price || 0);
  d.todayRevenue = Number(d.todayRevenue || 0) + price;
  d.completedCount = Number(d.completedCount || 0) + 1;
  d.avgTicket = d.completedCount ? Math.round(d.todayRevenue / d.completedCount) : 0;
  d.completedToday = [savedApt, ...(d.completedToday || [])];
  if (settlingId) {
    d.activeQueue = (d.activeQueue || []).filter(x => x.id !== settlingId);
    d.upcomingFuture = (d.upcomingFuture || []).filter(x => x.id !== settlingId);
  }
  d.paymentSplit = d.paymentSplit || { UPI: 0, Card: 0, Cash: 0 };
  if (usedPaymentMode === 'Split') {
    d.paymentSplit.UPI = Number(d.paymentSplit.UPI || 0) + Number(paymentSplit.UPI || 0);
    d.paymentSplit.Cash = Number(d.paymentSplit.Cash || 0) + Number(paymentSplit.Cash || 0);
  } else if (d.paymentSplit[usedPaymentMode] !== undefined) {
    d.paymentSplit[usedPaymentMode] = Number(d.paymentSplit[usedPaymentMode] || 0) + price;
  }
}

async function navigate(page, { forceRefresh = true } = {}) {
  const valid = NAV.some(([k]) => k === page) ? page : 'dashboard';
  const seq = ++_navSeq;
  state.page = valid;
  history.replaceState(null, '', '#' + valid);

  if (valid === 'reports' && _syncState.reportsCache[state.reportPeriod]) {
    state.reports = _syncState.reportsCache[state.reportPeriod];
  } else if (valid === 'stylists' && _syncState.stylistsCache[state.stylistPeriod]) {
    state.stylists = _syncState.stylistsCache[state.stylistPeriod];
  }

  const hadData = hasPageData(valid);
  // Instant 0ms panel transition before any network round-trips
  render(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (!forceRefresh) return;

  // Walk-in / New Appointment / Settings only need lightweight core data (no heavy analytics wait)
  const isFormTab = valid === 'walkin' || valid === 'appointment' || valid === 'settings';
  if (isFormTab && hadData && (Date.now() - _syncState.coreAt < 60_000)) {
    return;
  }

  try {
    await refreshDataForPage(valid);
    if (seq !== _navSeq || state.page !== valid) return;
    if (document.querySelector('.modal-overlay:not([hidden]), .drawer-overlay:not([hidden])')) return;
    if (isFormTab && document.activeElement?.closest('input, textarea, select')) return;
    render(!hadData);
    if (valid === 'dashboard') prewarmBackgroundTabs();
  } catch (err) {
    if (seq === _navSeq) toast(err.message);
  }
}

// ===================== EVENT HANDLERS (100% DELEGATED, ZERO INLINE JS) =====================
async function handleWalkinSubmit() {
  const w = state.walkin;
  const phoneInput = $('#fp');
  const nameInput = $('#fn');
  w.phone = normalizePhone(phoneInput.value);
  w.name = nameInput.value.trim();

  let hasErr = false;
  if (w.phone.length !== 10) {
    phoneInput.setAttribute('aria-invalid', 'true');
    $('#fp-err').classList.add('show');
    phoneInput.focus();
    hasErr = true;
  } else {
    phoneInput.removeAttribute('aria-invalid');
    $('#fp-err').classList.remove('show');
  }

  if (!w.name) {
    nameInput.setAttribute('aria-invalid', 'true');
    $('#fn-err').classList.add('show');
    if (!hasErr) nameInput.focus();
    hasErr = true;
  } else {
    nameInput.removeAttribute('aria-invalid');
    $('#fn-err').classList.remove('show');
  }

  if (w.selectedServiceIds.size === 0) {
    $('#cs-err').classList.add('show');
    hasErr = true;
  } else {
    $('#cs-err').classList.remove('show');
  }

  if (hasErr) return;

  const calc = getWalkinTotals();
  const usedPaymentMode = w.paymentMode;
  const paymentSplit = usedPaymentMode === 'Split'
    ? { UPI: Number(w.splitUpi || 0), Cash: Number(w.splitCash || 0) }
    : {};
  const settlingId = w.settlingId;

  const submitBtn = $('#sv2');
  const prevBtnHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Settling Bill...';
  }

  try {
    let savedApt;
    if (settlingId) {
      savedApt = await api.updateAppointment(settlingId, {
        status: 'Completed',
        stylist_name: w.stylistName,
        subtotal: calc.subtotal,
        discount: calc.discount,
        price: calc.total,
        payment_mode: usedPaymentMode,
        payment_split: paymentSplit,
        rating: w.rating,
        notes: w.notes
      });
    } else {
      savedApt = await api.createAppointment({
        client_name: w.name,
        client_phone: w.phone,
        stylist_name: w.stylistName,
        services: calc.selected.map(s => ({ id: s.id, name: s.name, price: s.price, duration: s.duration })),
        date: todayIso(),
        subtotal: calc.subtotal,
        discount: calc.discount,
        price: calc.total,
        payment_mode: usedPaymentMode,
        payment_split: paymentSplit,
        status: 'Completed',
        rating: w.rating,
        notes: w.notes,
        force: true
      });
    }

    // Reset walk-in form cleanly
    state.walkin = {
      settlingId: null,
      name: '',
      phone: '',
      selectedServiceIds: new Set(state.services[0] ? [state.services[0].id] : []),
      stylistName: state.stylists[0]?.name || '',
      paymentMode: 'UPI',
      splitUpi: 0,
      splitCash: 0,
      discount: 0,
      rating: 5,
      notes: '',
      lookupClient: null
    };

    invalidateClientCaches();
    applyOptimisticSettlement(savedApt, usedPaymentMode, paymentSplit, settlingId);

    // Switch dashboard optimistically & show Done/Receipt modal IMMEDIATELY without waiting on heavy refresh
    toast(`Bill settled: ${inr(savedApt.price)} collected via ${usedPaymentMode}`);
    await navigate('dashboard', { forceRefresh: false });
    openReceiptModal(savedApt);

    // Reconcile full dashboard + clients silently in background
    refreshDataForPage('dashboard', { force: true }).then(() => {
      if (state.page === 'dashboard' && !document.querySelector('.modal-overlay:not([hidden]), .drawer-overlay:not([hidden])')) {
        render(false);
      }
    }).catch(() => {});
  } catch (err) {
    toast(err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = prevBtnHtml;
    }
  }
}

async function handleBookingSubmit(force = false) {
  const b = state.booking;
  const phoneInput = $('#ap');
  const nameInput = $('#an');
  b.phone = normalizePhone(phoneInput.value);
  b.name = nameInput.value.trim();

  let hasErr = false;
  if (b.phone.length !== 10) {
    phoneInput.setAttribute('aria-invalid', 'true');
    $('#ap-err').classList.add('show');
    phoneInput.focus();
    hasErr = true;
  } else {
    phoneInput.removeAttribute('aria-invalid');
    $('#ap-err').classList.remove('show');
  }

  if (!b.name) {
    nameInput.setAttribute('aria-invalid', 'true');
    $('#an-err').classList.add('show');
    if (!hasErr) nameInput.focus();
    hasErr = true;
  } else {
    nameInput.removeAttribute('aria-invalid');
    $('#an-err').classList.remove('show');
  }

  if (b.selectedServiceIds.size === 0) {
    $('#as-err').classList.add('show');
    hasErr = true;
  } else {
    $('#as-err').classList.remove('show');
  }
  if (hasErr) return;

  const selected = state.services.filter(s => b.selectedServiceIds.has(s.id));
  try {
    const created = await api.createAppointment({
      client_name: b.name,
      client_phone: b.phone,
      stylist_name: b.stylistName,
      services: selected.map(s => ({ id: s.id, name: s.name, price: s.price, duration: s.duration })),
      date: b.date,
      time: b.time,
      status: 'Scheduled',
      notes: b.notes,
      force
    });

    if (b.sendWa) {
      window.open(buildWaUrl(created.client_phone, buildBookingWaText(created, state.settings)), '_blank', 'noopener');
    }

    state.booking = {
      name: '',
      phone: '',
      date: todayIso(),
      time: '03:30 PM',
      selectedServiceIds: new Set(state.services[0] ? [state.services[0].id] : []),
      stylistName: state.stylists[0]?.name || '',
      notes: '',
      sendWa: true,
      conflictError: ''
    };
    invalidateClientCaches();
    toast(`Appointment confirmed for ${created.client_name} (${created.time})`);
    await navigate('dashboard');
  } catch (err) {
    if (err.status === 409) {
      b.conflictError = err.message;
      render(false);
    } else {
      toast(err.message);
    }
  }
}

document.addEventListener('click', async (e) => {
  // Backdrop click closes dismissible modal/drawer (never dismiss mandatory login)
  if ((e.target.classList.contains('modal-overlay') || e.target.classList.contains('drawer-overlay')) && e.target.id !== 'loginModal') {
    closeOverlay(e.target.id);
    return;
  }

  // Close search dropdown on outside click
  if (!e.target.closest('.srch-box')) {
    const drop = $('#srchDrop');
    if (drop) drop.classList.remove('show');
  }

  // Close modal buttons
  const closeBtn = e.target.closest('[data-close-modal]');
  if (closeBtn) {
    closeOverlay(closeBtn.dataset.closeModal);
    return;
  }

  // Navigation buttons
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) {
    await navigate(navBtn.dataset.nav);
    return;
  }

  const target = e.target.closest('[data-action], #sv2, #btnBookAppt, #btnConfirmReset, #btnPrintReceipt, #btnWaReceipt, #btnVoidReceipt, #btnLaunchCamp');
  if (!target) return;

  if (target.id === 'sv2') return handleWalkinSubmit();
  if (target.id === 'btnBookAppt') return handleBookingSubmit(false);
  if (target.id === 'btnPrintReceipt') { window.print(); return; }
  if (target.id === 'btnWaReceipt' && state.lastReceipt) {
    window.open(buildWaUrl(state.lastReceipt.client_phone, buildReceiptWaText(state.lastReceipt, state.settings)), '_blank', 'noopener');
    return;
  }
  if (target.id === 'btnVoidReceipt' && state.lastReceipt) {
    openVoidBillModal(state.lastReceipt);
    return;
  }
  if (target.id === 'btnConfirmReset') {
    try {
      await api.resetDatabase();
      closeOverlay('confirmModal');
      toast('SQLite database reset to clean seed state');
      await navigate('dashboard');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (target.id === 'btnLaunchCamp') {
    try {
      const res = await api.createCampaign({
        name: state.campName,
        segment: state.campSegment,
        message: state.campMessage
      });
      state.activeCampQueue = {
        campaign: res.campaign,
        recipients: res.recipients,
        sentPhones: new Set()
      };
      state.campaigns = await api.getCampaigns();
      render(false);
      toast(`Campaign created with ${res.recipients.length} opted-in recipients`);
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  const action = target.dataset.action;
  const id = target.dataset.id;
  const val = target.dataset.val;

  if (action === 'toggle-theme') { toggleTheme(); return; }
  if (action === 'force-book') { return handleBookingSubmit(true); }

  // Walk-in chips
  if (action === 'toggle-walkin-srv') {
    const s = state.walkin.selectedServiceIds;
    s.has(id) ? s.delete(id) : s.add(id);
    if (state.walkin.paymentMode === 'Split') {
      const t = getWalkinTotals().total;
      state.walkin.splitUpi = Math.round(t / 2);
      state.walkin.splitCash = t - state.walkin.splitUpi;
    }
    render(false);
    return;
  }
  if (action === 'pick-walkin-stylist') {
    state.walkin.stylistName = val;
    render(false);
    return;
  }
  if (action === 'pick-paymode') {
    state.walkin.paymentMode = val;
    if (val === 'Split') {
      const t = getWalkinTotals().total;
      state.walkin.splitUpi = Math.round(t / 2);
      state.walkin.splitCash = t - state.walkin.splitUpi;
    }
    render(false);
    return;
  }

  // Booking chips
  if (action === 'toggle-book-srv') {
    const s = state.booking.selectedServiceIds;
    s.has(id) ? s.delete(id) : s.add(id);
    render(false);
    return;
  }
  if (action === 'pick-book-stylist') {
    state.booking.stylistName = val;
    state.booking.conflictError = '';
    render(false);
    return;
  }
  if (action === 'pick-book-time') {
    state.booking.time = val;
    state.booking.conflictError = '';
    render(false);
    return;
  }

  // Dashboard queue actions
  if (action === 'set-status') {
    const newStatus = target.dataset.status;
    try {
      await api.updateAppointment(id, { status: newStatus });
      invalidateClientCaches();
      if (state.dashboard?.activeQueue) {
        if (newStatus === 'Cancelled' || newStatus === 'Completed') {
          state.dashboard.activeQueue = state.dashboard.activeQueue.filter(x => x.id !== id);
        } else {
          const item = state.dashboard.activeQueue.find(x => x.id === id);
          if (item) item.status = newStatus;
        }
        render(false);
      }
      toast(`Appointment marked ${newStatus}`);
      refreshDataForPage('dashboard', { force: true }).then(() => {
        if (state.page === 'dashboard' && !document.querySelector('.modal-overlay:not([hidden]), .drawer-overlay:not([hidden])')) {
          render(false);
        }
      }).catch(() => {});
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (action === 'settle-apt') {
    const allQ = [...(state.dashboard?.activeQueue || []), ...(state.dashboard?.upcomingFuture || [])];
    const apt = allQ.find(x => x.id === id);
    if (!apt) return;
    const items = parseServicesJson(apt.services_json);
    const ids = new Set(items.map(i => i.id).filter(Boolean));
    if (ids.size === 0) {
      const byName = state.services.find(s => apt.service_name.includes(s.name));
      if (byName) ids.add(byName.id);
    }
    state.walkin = {
      settlingId: apt.id,
      name: apt.client_name,
      phone: normalizePhone(apt.client_phone),
      selectedServiceIds: ids,
      stylistName: apt.stylist_name,
      paymentMode: 'UPI',
      splitUpi: 0,
      splitCash: 0,
      discount: apt.discount || 0,
      rating: 5,
      notes: apt.notes || '',
      lookupClient: null
    };
    await navigate('walkin', { forceRefresh: false });
    toast(`Loaded ${apt.client_name}'s booking for settlement`);
    return;
  }
  if (action === 'open-reschedule') {
    const allQ = [...(state.dashboard?.activeQueue || []), ...(state.dashboard?.upcomingFuture || [])];
    const apt = allQ.find(x => x.id === id);
    if (apt) openRescheduleModal(apt);
    return;
  }
  if (action === 'view-receipt') {
    const found = (state.dashboard?.completedToday || []).find(x => x.id === id);
    if (found) {
      openReceiptModal(found);
      return;
    }
    try {
      const list = await api.getAppointments();
      const match = list.find(x => x.id === id);
      if (match) openReceiptModal(match);
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  // Client filter, drawer, quick bill, WA offer
  if (action === 'filter-clients') {
    state.clientFilter = val;
    render(false);
    return;
  }
  if (action === 'wa-offer') {
    e.stopPropagation();
    const client = state.clients.find(c => c.id === id);
    if (!client) return;
    const msg = `Hi ${client.name}! Special offer from ${state.settings.salon_name || 'SalonDesk'}: Enjoy 20% off your next ${client.last_service || 'Salon Service'}. Reply to reserve your chair!`;
    window.open(buildWaUrl(client.phone, msg), '_blank', 'noopener');
    toast(`WhatsApp offer opened for ${client.name}`);
    return;
  }
  if (action === 'open-client') {
    await openClientDrawer(id);
    return;
  }
  if (action === 'quick-bill-client') {
    closeOverlay('clientDrawer');
    const client = state.clients.find(c => c.id === id);
    if (!client) return;
    state.walkin.settlingId = null;
    state.walkin.name = client.name;
    state.walkin.phone = normalizePhone(client.phone);
    state.walkin.stylistName = client.preferred_stylist || state.stylists[0]?.name || '';
    state.walkin.lookupClient = client;
    await navigate('walkin', { forceRefresh: false });
    toast(`Loaded ${client.name} into Walk-in Billing`);
    return;
  }

  // Stylists & Reports period toggles (instant cache switch + silent background sync)
  if (action === 'stylist-period') {
    state.stylistPeriod = val;
    const cached = _syncState.stylistsCache[val];
    if (cached) {
      state.stylists = cached;
      render(true);
    } else {
      render(false);
    }
    try {
      const fresh = await api.getStylists(val);
      _syncState.stylistsCache[val] = fresh;
      if (state.page === 'stylists' && state.stylistPeriod === val) {
        state.stylists = fresh;
        render(!cached);
      }
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (action === 'report-period') {
    state.reportPeriod = val;
    const cached = _syncState.reportsCache[val];
    if (cached) {
      state.reports = cached;
      render(true);
    } else {
      render(false);
    }
    try {
      const fresh = await api.getReports(val);
      _syncState.reportsCache[val] = fresh;
      if (state.page === 'reports' && state.reportPeriod === val) {
        state.reports = fresh;
        render(!cached);
      }
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (action === 'export-gst-csv') {
    try {
      const csv = await api.exportGstCsv(state.reportPeriod);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `salondesk-gst-audit-${state.reportPeriod}-${todayIso()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('GST Audit CSV exported');
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  // Stylist & Service CRUD modals
  if (action === 'open-add-stylist') { openStylistModal(null); return; }
  if (action === 'open-edit-stylist') {
    const st = state.stylists.find(x => x.id === id);
    if (st) openStylistModal(st);
    return;
  }
  if (action === 'open-add-service') { openServiceModal(null); return; }
  if (action === 'open-edit-service') {
    const srv = state.services.find(x => x.id === id);
    if (srv) openServiceModal(srv);
    return;
  }
  if (action === 'delete-service') {
    try {
      await api.deleteService(id);
      invalidateClientCaches();
      state.services = await api.getServices();
      render(false);
      toast('Service archived');
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  // Campaigns
  if (action === 'pick-camp-seg') {
    state.campSegment = val;
    render(false);
    return;
  }
  if (action === 'send-queue-item' && state.activeCampQueue) {
    const phone = target.dataset.phone;
    const name = target.dataset.name;
    const msg = state.activeCampQueue.campaign.message.replaceAll('{name}', name.split(' ')[0]);
    window.open(buildWaUrl(phone, msg), '_blank', 'noopener');
    state.activeCampQueue.sentPhones.add(phone);
    try {
      await api.markCampaignSent(state.activeCampQueue.campaign.id, state.activeCampQueue.sentPhones.size);
      state.campaigns = await api.getCampaigns();
    } catch (_) {}
    render(false);
    return;
  }

  // Settings PIN & Reset
  if (action === 'save-session-pin') {
    const pinVal = $('#unlockPin')?.value || '';
    setSessionOwnerPin(pinVal);
    toast(pinVal ? 'Session Owner PIN applied' : 'Session PIN cleared');
    return;
  }
  if (action === 'open-reset-modal') {
    openOverlay('confirmModal');
  }
});

// Input & Change Delegation
document.addEventListener('input', async (e) => {
  const el = e.target;

  // Global search dropdown
  if (el.id === 'globalSearch') {
    const drop = $('#srchDrop');
    const q = el.value.trim().toLowerCase();
    if (!q) {
      drop.classList.remove('show');
      el.setAttribute('aria-expanded', 'false');
      return;
    }
    const qDigits = q.replace(/\D/g, '');
    const matches = state.clients.filter(c => c.name.toLowerCase().includes(q) || (qDigits && c.phone.includes(qDigits)));
    if (!matches.length) {
      drop.innerHTML = `<div style="padding:12px;text-align:center;color:var(--muted);font-size:13px">No matching clients for "${escapeHtml(el.value)}".</div>`;
    } else {
      drop.innerHTML = matches.slice(0, 6).map((c, idx) => `
        <button type="button" class="srch-item" data-action="quick-bill-client" data-id="${escapeHtml(c.id)}" role="option">
          ${av(c.name, idx, 32)}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px">
              <b style="font-size:13px">${escapeHtml(c.name)}</b>
              ${chip(c.tier, c.tier === 'VIP' ? 'lime' : '')}
            </div>
            <small class="mut" style="font-size:11px">${escapeHtml(formatPhone(c.phone))} · ${escapeHtml(c.last_service || 'New')}</small>
          </div>
          <span class="chip lime">Bill</span>
        </button>
      `).join('');
    }
    drop.classList.add('show');
    el.setAttribute('aria-expanded', 'true');
    return;
  }

  // Phone auto-lookup on Walk-in Billing
  if (el.id === 'fp') {
    el.value = el.value.replace(/\D/g, '').slice(0, 10);
    state.walkin.phone = el.value;
    if (el.value.length === 10) {
      try {
        const res = await api.lookupClientByPhone(el.value);
        if (res.client) {
          state.walkin.lookupClient = res.client;
          if (!state.walkin.name) {
            state.walkin.name = res.client.name;
            const fn = $('#fn');
            if (fn) fn.value = res.client.name;
          }
          if (res.client.preferred_stylist) {
            state.walkin.stylistName = res.client.preferred_stylist;
          }
          render(false);
          const fpAfter = $('#fp');
          if (fpAfter) fpAfter.focus();
        }
      } catch (_) {}
    } else if (state.walkin.lookupClient) {
      state.walkin.lookupClient = null;
      const b = $('#lookupBanner');
      if (b) b.innerHTML = '';
    }
    return;
  }

  if (el.id === 'fn') { state.walkin.name = el.value; return; }
  if (el.id === 'fnotes') { state.walkin.notes = el.value; return; }
  if (el.id === 'fdisc') {
    state.walkin.discount = Math.max(0, Number(el.value) || 0);
    render(false);
    return;
  }
  if (el.id === 'fsplitUpi') {
    const t = getWalkinTotals().total;
    const upi = Math.min(t, Math.max(0, Number(el.value) || 0));
    state.walkin.splitUpi = upi;
    state.walkin.splitCash = t - upi;
    const cashEl = $('#fsplitCash');
    if (cashEl) cashEl.value = String(state.walkin.splitCash);
    return;
  }
  if (el.id === 'fsplitCash') {
    const t = getWalkinTotals().total;
    const cash = Math.min(t, Math.max(0, Number(el.value) || 0));
    state.walkin.splitCash = cash;
    state.walkin.splitUpi = t - cash;
    const upiEl = $('#fsplitUpi');
    if (upiEl) upiEl.value = String(state.walkin.splitUpi);
    return;
  }

  // Booking inputs
  if (el.id === 'ap') {
    el.value = el.value.replace(/\D/g, '').slice(0, 10);
    state.booking.phone = el.value;
    if (el.value.length === 10 && !state.booking.name) {
      try {
        const res = await api.lookupClientByPhone(el.value);
        if (res.client) {
          state.booking.name = res.client.name;
          const an = $('#an');
          if (an) an.value = res.client.name;
        }
      } catch (_) {}
    }
    return;
  }
  if (el.id === 'an') { state.booking.name = el.value; return; }
  if (el.id === 'ad') { state.booking.date = el.value; state.booking.conflictError = ''; return; }
  if (el.id === 'anotes') { state.booking.notes = el.value; return; }

  // Campaign composer live preview
  if (el.id === 'campName') { state.campName = el.value; return; }
  if (el.id === 'campMsg') {
    state.campMessage = el.value;
    const prev = $('#campPreview');
    if (prev) prev.textContent = el.value.replaceAll('{name}', 'Rhea');
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'frating') state.walkin.rating = Number(e.target.value) || 5;
  if (e.target.id === 'sendWaCheck') state.booking.sendWa = e.target.checked;
});

// Form Submissions (Settings, Stylist CRUD, Service CRUD, Reschedule, Client Notes)
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'settingsForm') {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      salon_name: fd.get('salon_name'),
      branch_name: fd.get('branch_name'),
      gstin: fd.get('gstin'),
      sac_code: fd.get('sac_code'),
      gst_rate: fd.get('gst_rate'),
      opening_cash: fd.get('opening_cash')
    };
    const newPin = String(fd.get('owner_pin') || '').trim();
    if (newPin) payload.owner_pin = newPin;
    try {
      state.settings = await api.updateSettings(payload);
      if (newPin) setSessionOwnerPin(newPin);
      invalidateClientCaches();
      render(false);
      toast('Salon settings saved cleanly');
    } catch (err) {
      toast(err.message);
    }
  }

  if (form.id === 'stylistForm') {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: fd.get('name'),
      role: fd.get('role'),
      phone: fd.get('phone'),
      commission_pct: Number(fd.get('commission_pct'))
    };
    try {
      if (form.dataset.id) await api.updateStylist(form.dataset.id, body);
      else await api.createStylist(body);
      invalidateClientCaches();
      closeOverlay('formModal');
      state.stylists = await api.getStylists(state.stylistPeriod);
      _syncState.stylistsCache[state.stylistPeriod] = state.stylists;
      render(false);
      toast(form.dataset.id ? 'Stylist updated' : 'Stylist added');
    } catch (err) {
      toast(err.message);
    }
  }

  if (form.id === 'serviceForm') {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: fd.get('name'),
      category: fd.get('category'),
      price: Number(fd.get('price')),
      duration: Number(fd.get('duration'))
    };
    try {
      if (form.dataset.id) await api.updateService(form.dataset.id, body);
      else await api.createService(body);
      invalidateClientCaches();
      closeOverlay('formModal');
      state.services = await api.getServices();
      render(false);
      toast(form.dataset.id ? 'Service updated' : 'Service added to catalog');
    } catch (err) {
      toast(err.message);
    }
  }

  if (form.id === 'rescheduleForm') {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api.updateAppointment(form.dataset.id, {
        date: fd.get('date'),
        time: fd.get('time'),
        stylist_name: fd.get('stylist_name')
      });
      invalidateClientCaches();
      closeOverlay('formModal');
      await refreshDataForPage('dashboard', { force: true });
      render(false);
      toast('Appointment rescheduled cleanly');
    } catch (err) {
      toast(err.message);
    }
  }

  if (form.id === 'clientNotesForm') {
    e.preventDefault();
    try {
      await api.updateClient(form.dataset.id, {
        formula_notes: $('#cdFormula').value,
        opted_in: $('#cdOptIn').checked
      });
      invalidateClientCaches();
      state.clients = await api.getClients();
      render(false);
      toast('Client formula notes & opt-in saved');
    } catch (err) {
      toast(err.message);
    }
  }

  if (form.id === 'voidBillForm') {
    e.preventDefault();
    const aptId = form.dataset.id;
    const pinInp = $('#voidPin');
    if (pinInp && pinInp.value.trim()) {
      setSessionOwnerPin(pinInp.value.trim());
    }
    try {
      await api.deleteAppointment(aptId);
      invalidateClientCaches();
      closeOverlay('formModal');
      closeOverlay('receiptModal');
      if (state.dashboard?.completedToday) {
        const voided = state.dashboard.completedToday.find(x => x.id === aptId);
        state.dashboard.completedToday = state.dashboard.completedToday.filter(x => x.id !== aptId);
        if (voided) {
          state.dashboard.todayRevenue = Math.max(0, Number(state.dashboard.todayRevenue || 0) - Number(voided.price || 0));
          state.dashboard.completedCount = Math.max(0, Number(state.dashboard.completedCount || 0) - 1);
        }
      }
      render(false);
      toast('Bill voided & client ledger reconciled');
      refreshDataForPage('dashboard', { force: true }).then(() => {
        if (state.page === 'dashboard' && !document.querySelector('.modal-overlay:not([hidden]), .drawer-overlay:not([hidden])')) {
          render(false);
        }
      }).catch(() => {});
    } catch (err) {
      if (err.code === 'PIN_REQUIRED') {
        setSessionOwnerPin('');
        toast('Invalid Owner PIN');
      } else {
        toast(err.message);
      }
    }
  }
});

// Keyboard Accessibility: Safe Escape & Radiogroup Arrow Keys
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (closeAnyOpenOverlay()) return;
    const drop = $('#srchDrop');
    if (drop && drop.classList.contains('show')) {
      drop.classList.remove('show');
    }
    return;
  }

  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const group = e.target.closest('[role="radiogroup"]');
    if (!group) return;
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const idx = radios.indexOf(e.target);
    if (idx === -1) return;
    e.preventDefault();
    const next = radios[(idx + (e.key === 'ArrowRight' ? 1 : -1) + radios.length) % radios.length];
    next.focus();
    next.click();
  }
});

window.addEventListener('resize', updateIndicator);
window.addEventListener('hashchange', () => {
  const next = (location.hash || '#dashboard').slice(1);
  if (next !== state.page) navigate(next);
});

// Salon Login & Auth Management
function openLoginModal() {
  const loginModal = $('#loginModal');
  if (loginModal) {
    loginModal.hidden = false;
    loginModal.classList.add('open');
  }
}

function checkAuthAndPrompt() {
  const session = getSalonSession();
  if (!session.token) {
    openLoginModal();
    return false;
  }
  return true;
}

window.addEventListener('salondesk:auth-required', () => {
  invalidateClientCaches();
  _prewarmed = false;
  openLoginModal();
});

const loginForm = $('#loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnLoginSubmit');
    const errBox = $('#loginError');
    if (errBox) errBox.style.display = 'none';
    if (btn) btn.disabled = true;

    try {
      const username = $('#loginUser').value.trim();
      const password = $('#loginPass').value.trim();
      const res = await api.login(username, password);
      setSalonSession(res.salon, res.token);
      toast(`Signed in as ${res.salon?.name || 'SalonDesk'}`);

      const loginModal = $('#loginModal');
      if (loginModal) {
        loginModal.hidden = true;
        loginModal.classList.remove('open');
      }

      invalidateClientCaches();
      _prewarmed = false;
      state.dashboard = null;
      state.clients = [];
      state.services = [];
      state.stylists = [];
      state.reports = null;
      state.campaigns = [];
      _syncState.campaignsLoaded = false;

      await refreshDataForPage(state.page, { force: true });
      render(true);
      prewarmBackgroundTabs();
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'Login failed. Please check your credentials.';
        errBox.style.display = 'block';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#btnLogout')) {
    clearSalonSession();
    invalidateClientCaches();
    _prewarmed = false;
    state.dashboard = null;
    state.clients = [];
    state.services = [];
    state.stylists = [];
    state.reports = null;
    state.campaigns = [];
    _syncState.campaignsLoaded = false;
    toast('Logged out from salon');
    openLoginModal();
  }
});

// Boot Application
const initialHash = (location.hash || '#dashboard').slice(1);
const targetPage = NAV.some(([k]) => k === initialHash) ? initialHash : 'dashboard';
if (checkAuthAndPrompt()) {
  navigate(targetPage);
} else {
  state.page = targetPage;
  render(false);
}
