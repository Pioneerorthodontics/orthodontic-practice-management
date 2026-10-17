#!/usr/bin/env node
/* Local test server: serves the app and runs the REAL Apps Script backend code on fake Google services.
 * Sign in by typing any email (dev mode). Data lives in memory and resets on restart.
 *   node dev/server.js [port] [--seed]
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { makeEnv } = require('../tests/gas-mock.js');
const root = path.join(__dirname, '..'), port = +process.argv[2] || 8787, seed = process.argv.includes('--seed');

// any "dev:<email>" token is accepted as that Google account
const tokens = new Proxy({}, { get: (_, t) => typeof t === 'string' && t.startsWith('dev:') ? { aud: 'client-123', iss: 'accounts.google.com', email: t.slice(4), email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) } : undefined });
const env = makeEnv({ tokens, owner: 'doctor@gmail.com' });
env.setup();
if (seed) seedDemo();

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      if (process.env.OFFLINE_API === '1') { res.writeHead(503); return res.end(); }
      const out = env.doPost({ postData: { contents: body } }).text;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out);
    }); return;
  }
  if (url.pathname === '/config.js') { res.writeHead(200, { 'Content-Type': types['.js'] }); return res.end("window.ORTHO_CONFIG={API_URL:'/api',CLIENT_ID:'client-123',DEV:true};"); }
  let f = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = ['ledger.js', 'core.js'].includes(f.slice(1)) ? path.join(root, 'shared', f.slice(1)) : path.join(root, 'web', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    if (f === '/sw.js') data = Buffer.from(String(data).replace('__BUILD__', 'dev'));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  });
}).listen(port, () => console.log('Ortho dev server on http://localhost:' + port + (seed ? ' (with fictional sample data)' : '')));

/* Fictional sample data — clearly labelled, for testing only. */
function seedDemo() {
  let n = 0; const op = (type, data) => ({ opId: 'seed' + (++n), type, data });
  const today = env.Ledger.todayIn('Africa/Cairo'), L = env.Ledger;
  const ops = [
    op('clinic.save', { id: 'c1', name: 'عيادة المعادي (تجريبية)', days: 'السبت والثلاثاء', slot: 20, agreementFrom: '2025-01-01', lab: 'deduct' }),
    op('clinic.save', { id: 'c2', name: 'عيادة مدينة نصر (تجريبية)', days: 'الأحد والأربعاء', slot: 20, agreementFrom: '2025-01-01', lab: 'deduct' }),
    op('clinic.save', { id: 'c3', name: 'عيادة الدقي (تجريبية)', days: 'الإثنين', slot: 30, agreementFrom: '2025-01-01', lab: 'clinic' }),
    op('user.save', { id: 'u2', email: 'mona@gmail.com', name: 'منى (تجريبي)', role: 'assistant', clinics: ['c1', 'c2'], canPay: true }),
    op('user.save', { id: 'u3', email: 'salma@gmail.com', name: 'سلمى (تجريبي)', role: 'assistant', clinics: ['c3'], canPay: false })
  ];
  const pts = [['سارة محمود (تجريبي)', '01012345678', ['c1'], 5, 18000, 4000, 1000, 5], ['يوسف أحمد (تجريبي)', '01123456789', ['c1', 'c2'], 4, 45000, 15000, 3000, 10], ['مريم خالد (تجريبي)', '01234567890', ['c2'], 6, 16000, 3000, 1000, 1], ['عمر طارق (تجريبي)', '01098765432', ['c3'], 3, 6000, 2000, 800, 15], ['نور الهدى (تجريبي)', '01556677889', ['c3'], 2, 20000, 5000, 1250, 20]];
  pts.forEach((p, i) => {
    const id = 'p' + (i + 1), start = L.addMonths(L.monthStart(today), -p[3], Math.min(p[7], 28));
    ops.push(op('patient.save', { id, name: p[0], phone: p[1], clinics: p[2], type: i === 1 ? 'aligners' : 'fixed', fee: p[4] * 100, initial: p[5] * 100, monthly: p[6] * 100, payDay: p[7], start }));
    ops.push(op('tx.add', { id: 't' + id + '0', pid: id, cid: p[2][0], type: 'payment', amt: p[5] * 100, method: 'cash', date: start, inst: 'i0' }));
    for (let k = 1; k < p[3] - (i === 2 ? 2 : 0); k++) { const d = L.addMonths(L.monthStart(start), k, p[7]); if (d < today) ops.push(op('tx.add', { id: 't' + id + k, pid: id, cid: p[2][k % p[2].length], type: 'payment', amt: p[6] * 100, method: k % 2 ? 'cash' : 'instapay', date: d })); }
  });
  [['p1', 'c1', '10:00', 'confirmed'], ['p2', 'c1', '10:20', 'scheduled'], ['p3', 'c2', '12:00', 'scheduled'], ['p4', 'c3', '15:00', 'scheduled'], ['p5', 'c3', '15:30', 'scheduled']]
    .forEach((a, i) => ops.push(op('appt.create', { id: 'a' + i, pid: a[0], cid: a[1], date: today, time: a[2], duration: 20, status: a[3] })));
  ops.push(op('lab.create', { id: 'l1', pid: 'p2', cid: 'c1', lab: 'معمل النيل (تجريبي)', desc: 'أليجنرز — المرحلة الأولى', orderedAt: L.addDays(today, -10), expectedAt: L.addDays(today, 5), cost: 900000, paidNow: 300000 }));
  ops.push(op('item.save', { id: 'i1', name: 'أسلاك نيكل تيتانيوم 014', category: 'أسلاك', unit: 'علبة', min: 2 }));
  ops.push(op('stock.move', { id: 'm1', itemId: 'i1', kind: 'in', qty: 3, cost: 45000, date: today }));
  const r = env.post({ idToken: 'dev:doctor@gmail.com', ops });
  const bad = Object.entries(r.results).filter(([, x]) => x.status !== 'ok');
  if (bad.length) console.warn('seed problems:', JSON.stringify(bad).slice(0, 800));
}
