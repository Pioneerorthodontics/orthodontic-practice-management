// End-to-end test in a real Chromium against dev/server.js (real backend code on fake Google services).
//   node tests/e2e.js            (starts its own server on port 8799)
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/npm-tools/node_modules/playwright'); }
const PORT = 8799, BASE = 'http://localhost:' + PORT, OUT = process.env.SHOTS || path.join(__dirname, '..', 'dist', 'screens');
fs.mkdirSync(OUT, { recursive: true });
const results = []; const ok = (name, cond, info) => { results.push({ name, pass: !!cond, info }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !info ? '' : ' — ' + info)); };
const api = async (body) => (await fetch(BASE + '/api', { method: 'POST', body: JSON.stringify(body) })).json();

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'dev', 'server.js'), String(PORT), '--seed'], { stdio: 'pipe' });
  await new Promise(r => srv.stdout.on('data', d => /server on/.test(d) && r()));
  const browser = await pw.chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
  const errors = [];
  try {
    /* ---------- doctor on a phone ---------- */
    const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|gsi/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE);
    await page.fill('#devEmail', 'doctor@gmail.com'); await page.click('[data-a=devLogin]');
    await page.waitForSelector('text=الأرقام المالية');
    await page.waitForSelector('.sync.synced', { timeout: 10000 });
    ok('doctor signs in and the dashboard loads, synced with the server', true);
    await page.screenshot({ path: path.join(OUT, 'phone-dashboard.png'), fullPage: true });

    // appointments: open a day from the month grid, add two appointments with "save and add another"
    await page.click('nav [data-v=appts]');
    await page.click('[data-a=cal][data-v=month]');
    const target = await page.evaluate(() => { const d = new Date(Date.now() + 3 * 864e5); return d.toISOString().slice(0, 10); });
    await page.click(`.cal [data-v="${target}"]`);
    await page.click('[data-a=newAppt][data-d]');
    await page.fill('#fP_q', 'سارة'); await page.click('[data-a=pickP] >> nth=0');
    await page.fill('#fTm', '11:00');
    await page.click('button[name=again]');
    await page.waitForFunction(() => { const h = document.getElementById('fP'), t = document.getElementById('fTm'); return h && h.value === '' && t && t.value !== '11:00'; });
    const t2 = await page.inputValue('#fTm');
    await page.fill('#fP_q', 'مريم'); await page.click('[data-a=pickP] >> nth=0');
    await page.click('#shOk');
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    const count = await page.locator('.ap').count();
    ok('two appointments added to the same chosen day via patient search', count === 2, 'found ' + count);
    ok('"add another" pre-fills the next free time', t2 === '11:20', t2);
    await page.waitForSelector('.sync.synced', { timeout: 10000 });

    // overlap warning
    await page.click('[data-a=newAppt][data-d]');
    await page.fill('#fP_q', 'يوسف'); await page.click('[data-a=pickP] >> nth=0');
    await page.fill('#fTm', '11:10'); await page.click('#shOk');
    await page.waitForSelector('#shErr:not([hidden])');
    ok('overlapping time is caught and the override box appears', await page.isVisible('#forceRow'));
    await page.click('.sh-f [data-a=close]');

    // today: mark attended -> payment + next visit in one form
    await page.click('[data-a=day][data-v]:has-text("اليوم")');
    await page.click('.ap:has-text("سارة") [data-a=att]');
    await page.waitForSelector('#shT:has-text("إنهاء زيارة")');
    await page.fill('#fA', '1000'); await page.click('#shOk');
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    await page.waitForSelector('.sync.synced', { timeout: 10000 });
    let srvData = await api({ idToken: 'dev:doctor@gmail.com', sinceRev: 0 });
    const visitPay = srvData.rows.ledger.filter(e => e.note === 'دفعة في الزيارة');
    ok('visit payment reached the server once, split 700 / 300', visitPay.length === 1 && visitPay[0].docAmt === 70000 && visitPay[0].cliAmt === 30000, JSON.stringify(visitPay));
    ok('next appointment booked from the same form', srvData.rows.appts.filter(a => a.pid === 'p1' && a.date > visitPay[0].date).length >= 1);

    // double tap on save does not create two payments
    await page.click('nav [data-v=inst]'); await page.click('[data-a=pay]:not([data-v]) >> nth=0');
    await page.fill('#fP_q', 'نور'); await page.click('[data-a=pickP] >> nth=0');
    await page.fill('#fA', '50');
    await page.evaluate(() => { const b = document.getElementById('shOk'); b.click(); b.click(); b.click(); });
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    await page.waitForSelector('.sync.synced', { timeout: 10000 });
    srvData = await api({ idToken: 'dev:doctor@gmail.com', sinceRev: 0 });
    ok('triple tap on save records one payment', srvData.rows.ledger.filter(e => e.pid === 'p5' && e.amt === 5000).length === 1);

    // overpayment blocked
    await page.click('[data-a=pay]:not([data-v]) >> nth=0');
    await page.fill('#fP_q', 'نور'); await page.click('[data-a=pickP] >> nth=0');
    await page.fill('#fA', '999999'); await page.click('#shOk');
    await page.waitForSelector('#shErr:not([hidden])');
    ok('overpayment is refused with the remaining balance shown', /أكبر من المتبقي/.test(await page.textContent('#shErr')));
    await page.click('.sh-f [data-a=close]');

    /* ---------- offline: changes survive a reload and are sent exactly once ---------- */
    await page.route('**/api', r => r.abort('internetdisconnected'));
    await ctx.setOffline(true);
    await page.click('nav [data-v=patients]');
    await page.click('.row:has-text("مريم")');
    await page.click('#sheet [data-a=pay]');
    await page.fill('#fA', '250'); await page.click('#shOk');
    await page.waitForFunction(() => window.orthoSync.outbox.length === 1 && /في الانتظار/.test(document.querySelector('.sync').textContent));
    ok('offline: status shows "بدون إنترنت" with the pending count', /في الانتظار/.test(await page.textContent('.sync')));
    await page.screenshot({ path: path.join(OUT, 'phone-offline.png') });
    await ctx.setOffline(false);
    await page.reload();                         // app restarts while the API is still unreachable
    await page.waitForSelector('.sync');
    const pend = await page.evaluate(() => window.orthoSync.outbox.length);
    ok('offline change is still queued after the app restarts', pend === 1, 'outbox ' + pend);
    let before = (await api({ idToken: 'dev:doctor@gmail.com', sinceRev: 0 })).rows.ledger.filter(e => e.pid === 'p3' && e.amt === 25000).length;
    ok('server does not have it yet ("synced" is never claimed early)', before === 0 && !(await page.isVisible('.sync.synced')));
    await page.unroute('**/api');
    await page.evaluate(() => window.orthoSync.sync({ force: true }));
    await page.waitForSelector('.sync.synced', { timeout: 15000 });
    let after = (await api({ idToken: 'dev:doctor@gmail.com', sinceRev: 0 })).rows.ledger.filter(e => e.pid === 'p3' && e.amt === 25000).length;
    ok('after reconnecting the queued payment is on the server exactly once', after === 1, 'count ' + after);

    // a lost answer: server applied the op, phone resends -> still one
    const opBody = { idToken: 'dev:doctor@gmail.com', sinceRev: 0, ops: [{ opId: 'lost-1', type: 'tx.add', data: { id: 'tx-lost', pid: 'p4', cid: 'c3', type: 'payment', amt: 1000, method: 'cash', date: srvData.today } }] };
    await api(opBody); const again = await api(opBody);
    ok('a resent request returns the stored result and creates no duplicate', again.results['lost-1'].replay === true && again.rows.ledger.filter(e => e.id === 'tx-lost').length === 1);

    // lab screen grouping
    await page.click('nav [data-v=lab]');
    ok('lab orders are grouped "ordered" / "delivered"', await page.isVisible('text=تم الطلب — لم يُسلَّم بعد') && await page.isVisible('h3:has-text("تم التسليم")'));
    await page.click('[data-a=labDeliver] >> nth=0'); await page.click('#shOk');
    await page.waitForSelector('#sheet[hidden]', { state: 'attached' });
    ok('marking delivered moves the order to the delivered group', /\((1|١)\)/.test(await page.textContent('h3:has-text("تم التسليم")')));

    // accounts: 70/30 breakdown visible
    await page.click('nav [data-v=accounts]');
    ok('clinic accounts show the 70/30 agreement', await page.isVisible('text=70٪ للطبيب') || await page.isVisible('text=٧٠٪ للطبيب'));
    await page.screenshot({ path: path.join(OUT, 'phone-accounts.png'), fullPage: true });

    /* ---------- assistant: limited view ---------- */
    const ctx2 = await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'ar-EG' });
    const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push('assistant: ' + e.message));
    await p2.goto(BASE); await p2.fill('#devEmail', 'mona@gmail.com'); await p2.click('[data-a=devLogin]');
    await p2.waitForSelector('nav'); await p2.waitForSelector('.sync.synced', { timeout: 10000 });
    const tabsTxt = await p2.textContent('nav');
    ok('assistant has no Lab / Accounts tabs and no money figures', !/المعمل|الحسابات/.test(tabsTxt) && !(await p2.isVisible('text=الأرقام المالية')));
    await p2.click('nav [data-v=patients]'); await p2.click('[data-a=pst][data-v=all]');
    const names = await p2.locator('#plist .row b').allTextContents();
    ok('assistant sees only patients of her clinics', names.length === 3 && !names.some(n => /عمر|نور/.test(n)), names.join(' | '));
    const leaked = await p2.evaluate(() => window.orthoSync.server.tables.ledger.some(e => e.docAmt) || window.orthoSync.server.tables.agreements.length);
    ok('assistant device holds no doctor shares or agreements', !leaked);

    /* ---------- desktop + dark ---------- */
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', locale: 'ar-EG' });
    const p3 = await ctx3.newPage(); p3.on('pageerror', e => errors.push('desktop: ' + e.message));
    await p3.goto(BASE); await p3.fill('#devEmail', 'doctor@gmail.com'); await p3.click('[data-a=devLogin]');
    await p3.waitForSelector('text=الأرقام المالية'); await p3.click('nav [data-v=appts]'); await p3.click('[data-a=cal][data-v=week]');
    await p3.screenshot({ path: path.join(OUT, 'desktop-dark-week.png') });
    const overflow = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const overflowPhone = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok('no sideways page scroll on phone or desktop', !overflow && !overflowPhone);

    ok('no JavaScript errors in any session', errors.length === 0, errors.slice(0, 5).join(' || '));
  } catch (e) {
    ok('test run finished without crashing', false, e.stack);
  } finally {
    await browser.close(); srv.kill();
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
    process.exit(failed ? 1 : 0);
  }
})();
