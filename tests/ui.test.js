const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

describe('Jawed Salon OS — UI Integrity, Accessibility & XSS Safety', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8');
  const utilsJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'utils.js'), 'utf8');
  const apiJs = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');

  it('has clean modular JS syntax across all frontend modules', () => {
    for (const file of ['utils.js', 'api.js', 'app.js']) {
      const fullPath = path.join(PUBLIC_DIR, 'js', file);
      execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
    }
  });

  it('eliminates inline onclick handlers and escapes rendered HTML (XSS safety)', () => {
    assert.ok(!/\sonclick\s*=/i.test(html), 'Found unsafe inline onclick handler in public/index.html');
    assert.ok(!/\sonclick\s*=/i.test(appJs), 'Found unsafe inline onclick handler in public/js/app.js');
    assert.ok(utilsJs.includes('export function escapeHtml'), 'Missing escapeHtml utility');
    assert.ok(appJs.includes('escapeHtml('), 'app.js must sanitize dynamic values with escapeHtml');
  });

  it('verifies accessibility, semantics, responsive nav, and clean thermal print rules', () => {
    assert.ok(html.includes('role="status"'), 'Missing role="status" on toast');
    assert.ok(html.includes('aria-live="polite"'), 'Missing aria-live="polite" on toast');
    assert.ok(html.includes('id="mobNav"'), 'Missing mobile bottom navigation');
    assert.ok(html.includes('id="clientDrawer"'), 'Missing Client 360 drawer');
    assert.ok(html.includes('id="rcpCgst"') && html.includes('id="rcpSgst"'), 'Missing Indian CGST/SGST receipt rows');

    assert.ok(css.includes('font-variant-numeric: tabular-nums'), 'Missing tabular-nums');
    assert.ok(css.includes('outline: 2px solid var(--ring)'), 'Missing WCAG focus outline');
    assert.ok(css.includes('.rating-pill') && css.includes('.stylist-meta'), 'Missing aligned stylist card & rating pill CSS');
    assert.ok(css.includes(':not(#receiptSlip)'), 'Thermal print CSS must hide all non-receipt UI chrome');
    assert.ok(appJs.includes('<fieldset class="fg">'), 'Chip groups must use accessible fieldsets');
    assert.ok(appJs.includes("e.key === 'ArrowRight'"), 'Radiogroups must support arrow-key keyboard navigation');
    assert.ok(appJs.includes('ratingBadge(st.live_rating)'), 'All stylist cards must render consistent ratingBadge instead of hiding rating behind Top Producer');
    assert.ok(appJs.includes('settingsStylistsCard') && appJs.includes('open-edit-stylist') && appJs.includes('delete-stylist'), 'Settings must allow adding, editing, and archiving stylists');
    assert.ok(!html.includes('class="inp"') && !html.includes('var(--danger)') && html.includes('class="in"') && html.includes('id="btnTogglePass"'), 'Sign-in modal must use valid .in/.alert-box styles and password visibility toggle');
  });

  it('uses SQLite REST API exclusively without localStorage business state split-brain', () => {
    assert.ok(!appJs.includes("localStorage.getItem('jawed-v1')"), 'Legacy localStorage business state must be removed');
    assert.ok(apiJs.includes('/api/dashboard'), 'Must hydrate dashboard from SQLite API');
    assert.ok(apiJs.includes('/api/stylists'), 'Must load stylists from SQLite API');
    assert.ok(apiJs.includes('/api/reports'), 'Must load reports from SQLite API');
    assert.ok(apiJs.includes('/api/auth/verify-pin') && apiJs.includes("headers['X-Owner-Pin'] = ownerPinCache"), 'API client must support verifyOwnerPin and pass X-Owner-Pin for CSV exports');
    assert.ok(appJs.includes('reportsUnlockForm') && appJs.includes('reportsSetupPinForm') && appJs.includes('function lockReports(') && appJs.includes('lock-reports'), 'Reports view must require 6-digit PIN and auto-lock when leaving tab');
  });

  it('implements frosted glassmorphism tokens and reduced-motion-safe purposeful animations', () => {
    assert.ok(css.includes('backdrop-filter: blur(var(--blur-amount))'), 'Missing frosted glass backdrop-filter');
    assert.ok(css.includes('@supports not (backdrop-filter: blur(1px))'), 'Missing opaque fallback for non-backdrop browsers');
    assert.ok(css.includes('@keyframes panelRise') && css.includes('@keyframes barGrowY') && css.includes('@keyframes donutDraw'), 'Missing panel/chart entrance keyframes');
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'Missing reduced-motion CSS guard');
    assert.ok(appJs.includes('function animateDigits(') && appJs.includes('prefers-reduced-motion: reduce'), 'Missing reduced-motion-aware KPI digit animation');
  });
});
