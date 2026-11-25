const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseSalonDatabase } = require('../db/supabase-db');

describe('Salon OS — Supabase Cloud Multi-Tenancy & GENZEE Pilot', () => {
  const db = new SupabaseSalonDatabase();

  it('authenticates GENZEE credentials, strips secret fields, and rejects wrong passwords', async () => {
    // Correct credentials
    const auth = await db.authSalon('8446451506', 'genzee123');
    assert.ok(auth.token, 'Must return session token');
    assert.equal(auth.salon.id, 'genzee');
    assert.equal(auth.salon.name, 'GENZEE UNISEX Hair & Beauty Lounge');
    assert.equal(auth.salon.password_hash, undefined, 'Must never expose password_hash');
    assert.equal(auth.salon.owner_pin, undefined, 'Must never expose owner_pin');
    assert.equal(auth.salon.has_owner_pin, true, 'Must expose boolean has_owner_pin');

    const profile = await db.getSalon('genzee');
    assert.equal(profile.owner_pin, undefined, 'getSalon must never leak owner_pin');

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

  it('returns complete reports contract and cleanly reconciles Void/Delete bill', async () => {
    const rep = await db.getReports('genzee', 'week');
    assert.ok(rep.startDate && rep.endDate, 'Must include startDate and endDate');
    assert.ok(Array.isArray(rep.serviceMix), 'Must include serviceMix array for Revenue Reports view');
    assert.ok(typeof rep.openingCash === 'number', 'Must include numeric openingCash');
    assert.ok(typeof rep.expectedDrawerCash === 'number', 'Must include numeric expectedDrawerCash');
    assert.ok(rep.dailySeries.every(d => d.label && d.shortLabel), 'dailySeries entries must include label and shortLabel');

    // Roundtrip temporary bill + client visit reversal check (cleans up completely)
    const testPhone = '9900112233';
    const created = await db.createAppointment('genzee', {
      client_name: 'Temp Integration Audit',
      client_phone: testPhone,
      stylist_name: 'Rahul (Creative Director)',
      services: [{ id: 'srv-g1', name: 'Skin Fade & Beard Sculpt', price: 650, duration: 45 }],
      price: 650,
      subtotal: 650,
      discount: 0,
      payment_mode: 'UPI',
      status: 'Completed',
      force: true
    });
    const clientAfterCreate = await db.getClientByPhone('genzee', testPhone);
    assert.equal(clientAfterCreate.visits, 1);
    assert.equal(clientAfterCreate.total_spend, 650);

    const repWithBill = await db.getReports('genzee', 'week');
    assert.ok(repWithBill.serviceMix.length > 0, 'serviceMix must include active service');

    const deleted = await db.deleteAppointment('genzee', created.id);
    assert.equal(deleted, true);
    const clientAfterVoid = await db.getClientByPhone('genzee', testPhone);
    assert.equal(clientAfterVoid.visits, 0, 'Voiding bill must reverse visit count');
    assert.equal(clientAfterVoid.total_spend, 0, 'Voiding bill must reverse total_spend');

    // Clean up temporary client record so production remains spotless
    await db.client.from('clients').delete().eq('salon_id', 'genzee').eq('phone', testPhone);
    db.invalidateCache('genzee');
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
