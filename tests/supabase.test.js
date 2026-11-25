const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseSalonDatabase } = require('../db/supabase-db');

describe('Salon OS — Supabase Cloud Multi-Tenancy & GENZEE Pilot', () => {
  const db = new SupabaseSalonDatabase();

  it('authenticates GENZEE credentials and rejects wrong passwords', async () => {
    // Correct credentials
    const auth = await db.authSalon('8446451506', 'genzee123');
    assert.ok(auth.token, 'Must return session token');
    assert.equal(auth.salon.id, 'genzee');
    assert.equal(auth.salon.name, 'GENZEE UNISEX Hair & Beauty Lounge');

    // Wrong password
    await assert.rejects(
      () => db.authSalon('8446451506', 'wrongpass'),
      (err) => err.statusCode === 400 && err.code === 'VALIDATION_ERROR'
    );
  });

  it('fetches GENZEE dashboard with live metrics and custom branding', async () => {
    const dash = await db.getDashboard('genzee');
    assert.ok(dash.todayRevenue >= 0, 'Must compute today revenue');
    assert.equal(dash.settings.salon_name, 'GENZEE UNISEX Hair & Beauty Lounge');
    assert.ok(dash.settings.branch_name.includes('Mahalunge, Pune'));
    assert.ok(Array.isArray(dash.weekSeries) && dash.weekSeries.length === 7, 'Must have 7 days series');
    assert.ok(Array.isArray(dash.stylistPerf) && dash.stylistPerf.length >= 4, 'Must load GENZEE stylists');
    assert.ok(dash.stylistPerf.every(s => Array.isArray(s.weekly_counts) && s.weekly_counts.length === 7), 'Stylists must include 7-day sparklines');
  });

  it('returns complete reports contract (serviceMix, cash drawer, dailySeries labels)', async () => {
    const rep = await db.getReports('genzee', 'week');
    assert.ok(rep.startDate && rep.endDate, 'Must include startDate and endDate');
    assert.ok(Array.isArray(rep.serviceMix), 'Must include serviceMix array for Revenue Reports view');
    assert.ok(rep.serviceMix.length > 0, 'serviceMix must aggregate completed services');
    assert.ok(typeof rep.openingCash === 'number', 'Must include numeric openingCash');
    assert.ok(typeof rep.expectedDrawerCash === 'number', 'Must include numeric expectedDrawerCash');
    assert.ok(rep.dailySeries.every(d => d.label && d.shortLabel), 'dailySeries entries must include label and shortLabel');
  });

  it('loads GENZEE service catalog and verifies isolation', async () => {
    const services = await db.getServices('genzee');
    assert.ok(services.length >= 6, 'Must have GENZEE pre-seeded services');
    assert.ok(services.some(s => s.name === 'Skin Fade & Beard Sculpt'));
    assert.ok(services.every(s => s.salon_id === 'genzee'), 'All services must belong to genzee');
  });

  it('prevents double booking conflicts for the same stylist on the same slot', async () => {
    const conflict = await db.checkStylistConflict('genzee', 'Rahul (Creative Director)', '2099-01-01', '10:00 AM');
    assert.equal(conflict, null, 'Must be free slot');
  });
});
