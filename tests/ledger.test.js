const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../shared/ledger.js');

const ag70 = { id: 'a1', cid: 'c1', from: '2026-01-01', to: null, method: 'pct', pct: 70, fee: 0, lab: 'deduct' };
const pay = (id, amt, date, extra = {}) => Object.assign({ id, type: 'payment', amt, date, pid: 'p1', cid: 'c1' }, L.splitCash(amt, ag70), extra);

test('EGP 1,000 under 70/30 -> 700 doctor, 300 clinic', () => {
  const s = L.splitCash(100000, ag70);
  assert.equal(s.docAmt, 70000); assert.equal(s.cliAmt, 30000);
});

test('EGP 800 under 70/30 -> 560 doctor, 240 clinic', () => {
  const s = L.splitCash(80000, ag70);
  assert.equal(s.docAmt, 56000); assert.equal(s.cliAmt, 24000);
});

test('splits always add up exactly; banker rounding has no upward drift', () => {
  let doc = 0, total = 0;
  for (let i = 1; i <= 1000; i++) { const s = L.splitCash(i, { method: 'pct', pct: 50, id: 'x' }); assert.equal(s.docAmt + s.cliAmt, i); doc += s.docAmt; total += i; }
  assert.equal(doc, total / 2);
  assert.equal(L.pctOf(1, 50), 0); assert.equal(L.pctOf(3, 50), 2); // half-to-even
  assert.equal(L.pctOf(33333, 33.33), 11110);
});

test('amount parsing accepts Arabic digits and rejects junk', () => {
  assert.equal(L.toPiasters('١٥٠٠'), 150000);
  assert.equal(L.toPiasters('1,250.5'), 125050);
  assert.equal(L.toPiasters('12٫75'), 1275);
  assert.equal(L.toPiasters('-5'), null);
  assert.equal(L.toPiasters('1.234'), null);
  assert.equal(L.toPiasters('abc'), null);
});

test('installment day 31 is clamped in short months, across years', () => {
  assert.equal(L.addMonths('2027-01-01', 1, 31), '2027-02-28');
  assert.equal(L.addMonths('2028-01-01', 1, 31), '2028-02-29');
  assert.equal(L.addMonths('2026-11-01', 2, 30), '2027-01-30');
  assert.equal(L.addMonths('2026-03-01', 1, 31), '2026-04-30');
});

const plan = { fee: 1200000, initial: 300000, monthly: 100000, payDay: 10, start: '2026-01-05', status: 'active' };

test('uncollected fees are not collected revenue; doctor share uses collections only', () => {
  const data = { agreements: [ag70], ledger: [pay('t1', 300000, '2026-01-05')], appts: [], labs: [], settlements: [] };
  const r = L.clinicCalc(data, 'c1', '2026-01-01', '2026-12-31');
  assert.equal(r.coll, 300000); assert.equal(r.docNet, 210000); assert.equal(r.cliNet, 90000);
});

test('partial payment fills the oldest installment; balance from ledger', () => {
  const a = L.account(plan, [pay('t1', 300000, '2026-01-05'), pay('t2', 50000, '2026-02-10')], '2026-03-15');
  assert.equal(a.balance, 850000);
  const m1 = a.items.find(i => i.key === 'm1'), m2 = a.items.find(i => i.key === 'm2');
  assert.equal(m1.cover, 50000); assert.equal(m1.st, 'partial-late');
  assert.equal(m2.st, 'overdue'); assert.equal(a.overdue, 150000); assert.equal(a.missed, 2);
});

test('payment tied to a specific installment goes there first', () => {
  const a = L.account(plan, [pay('t1', 300000, '2026-01-05'), pay('t2', 100000, '2026-02-01', { inst: 'm3' })], '2026-02-01');
  assert.equal(a.items.find(i => i.key === 'm3').st, 'paid');
  assert.equal(a.items.find(i => i.key === 'm1').cover, 0);
});

test('extra charges enter the schedule and can become overdue (fix T5)', () => {
  const charge = { id: 'c1x', type: 'charge', amt: 200000, date: '2026-02-01', pid: 'p1', cid: 'c1' };
  const a = L.account(plan, [pay('t1', 300000, '2026-01-05'), charge], '2026-03-01');
  const unpaid = a.items.reduce((s, i) => s + i.amt - i.cover, 0);
  assert.equal(a.balance, 1100000); assert.equal(unpaid, a.balance);
  assert.equal(a.items.find(i => i.key === 'c:c1x').st, 'overdue');
});

test('a reversal cancels its payment exactly once in balance, schedule and clinic totals', () => {
  const t2 = pay('t2', 100000, '2026-02-10');
  const revd = { id: 'r1', type: 'reversal', reverses: 't2', amt: 100000, date: '2026-03-01', pid: 'p1', cid: 'c1', docAmt: -t2.docAmt, cliAmt: -t2.cliAmt };
  const entries = [pay('t1', 300000, '2026-01-05'), t2, revd];
  const a = L.account(plan, entries, '2026-03-05');
  assert.equal(a.balance, 900000); assert.equal(a.items.find(i => i.key === 'm1').cover, 0);
  const data = { agreements: [ag70], ledger: entries, appts: [], labs: [], settlements: [] };
  assert.equal(L.clinicCalc(data, 'c1', '2026-01-01', '2026-12-31').coll, 300000);
  // the correction lands in March (open month); February keeps its original figure
  assert.equal(L.clinicCalc(data, 'c1', '2026-02-01', '2026-02-28').docNet, 70000);
  assert.equal(L.clinicCalc(data, 'c1', '2026-03-01', '2026-03-31').docNet, -70000);
});

test('refund reduces collections and takes money back from the newest installment', () => {
  const refund = Object.assign({ id: 'f1', type: 'refund', amt: 50000, date: '2026-02-20', pid: 'p1', cid: 'c1' }, L.splitCash(-50000, ag70));
  const a = L.account(plan, [pay('t1', 300000, '2026-01-05'), pay('t2', 100000, '2026-02-10'), refund], '2026-02-21');
  assert.equal(a.balance, 850000); assert.equal(a.items.find(i => i.key === 'm1').cover, 50000);
  const data = { agreements: [ag70], ledger: [pay('t1', 300000, '2026-01-05'), pay('t2', 100000, '2026-02-10'), refund], appts: [], labs: [], settlements: [] };
  const r = L.clinicCalc(data, 'c1', '2026-01-01', '2026-12-31');
  assert.equal(r.coll, 350000); assert.equal(r.docNet, 245000);
});

test('discount lowers the schedule base and the balance', () => {
  const disc = { id: 'd1', type: 'discount', amt: 200000, date: '2026-01-06', pid: 'p1', cid: 'c1' };
  const a = L.account(plan, [pay('t1', 300000, '2026-01-05'), disc], '2026-01-07');
  assert.equal(a.balance, 700000); assert.equal(a.items.reduce((s, i) => s + i.amt, 0), 1000000);
});

test('lab rule "deduct": doctor carries 70%, clinic 30%, never double-counted (fix T7)', () => {
  const lab = Object.assign({ id: 'l1', cid: 'c1', orderedAt: '2026-01-10', cost: 100000, status: 'ordered' }, L.splitLab(100000, ag70));
  const data = { agreements: [ag70], ledger: [pay('t1', 300000, '2026-01-05')], appts: [], labs: [lab], settlements: [] };
  const r = L.clinicCalc(data, 'c1', '2026-01-01', '2026-01-31');
  assert.equal(r.labDoc, 70000); assert.equal(r.labCli, 30000);
  assert.equal(r.docNet, 140000); assert.equal(r.cliNet, 60000);
  assert.equal(r.docNet + r.cliNet + r.labCost, r.coll);
});

test('lab cost counts on the order date', () => {
  const lab = Object.assign({ id: 'l1', cid: 'c1', orderedAt: '2026-01-31', deliveredAt: '2026-02-15', cost: 100000, status: 'delivered' }, L.splitLab(100000, ag70));
  const data = { agreements: [ag70], ledger: [], appts: [], labs: [lab], settlements: [] };
  assert.equal(L.clinicCalc(data, 'c1', '2026-01-01', '2026-01-31').labCost, 100000);
  assert.equal(L.clinicCalc(data, 'c1', '2026-02-01', '2026-02-28').labCost, 0);
});

test('agreement change does not rewrite history: split is frozen on each entry', () => {
  const old = pay('t1', 100000, '2026-01-05');
  const ag50 = { id: 'a2', cid: 'c1', from: '2026-02-01', to: null, method: 'pct', pct: 50, fee: 0, lab: 'deduct' };
  const later = Object.assign({ id: 't2', type: 'payment', amt: 100000, date: '2026-02-05', pid: 'p1', cid: 'c1' }, L.splitCash(100000, ag50));
  const data = { agreements: [Object.assign({}, ag70, { to: '2026-01-31' }), ag50], ledger: [old, later], appts: [], labs: [], settlements: [] };
  assert.equal(L.clinicCalc(data, 'c1', '2026-01-01', '2026-01-31').docNet, 70000);
  assert.equal(L.clinicCalc(data, 'c1', '2026-02-01', '2026-02-28').docNet, 50000);
});

test('partial settlements reduce what is owed exactly once', () => {
  const data = { agreements: [ag70], ledger: [pay('t1', 100000, '2026-01-05')], appts: [], labs: [], settlements: [{ id: 's1', cid: 'c1', date: '2026-01-20', amt: 30000 }] };
  assert.equal(L.owed(data, 'c1', '2026-01-31'), 40000);
  data.settlements.push({ id: 's2', cid: 'c1', date: '2026-01-25', amt: 40000 });
  assert.equal(L.owed(data, 'c1', '2026-01-31'), 0);
});

test('clinics stay separate', () => {
  const p2 = Object.assign({ id: 't9', type: 'payment', amt: 100000, date: '2026-01-05', pid: 'p1', cid: 'c2' }, L.splitCash(100000, Object.assign({}, ag70, { cid: 'c2', id: 'a9' })));
  const data = { agreements: [ag70], ledger: [pay('t1', 100000, '2026-01-05'), p2], appts: [], labs: [], settlements: [] };
  assert.equal(L.clinicCalc(data, 'c1', '2026-01-01', '2026-01-31').coll, 100000);
  assert.equal(L.clinicCalc(data, 'c2', '2026-01-01', '2026-01-31').coll, 100000);
});

test('paused plan: future installments are not overdue', () => {
  const p = Object.assign({}, plan, { status: 'paused', pausedFrom: '2026-03-01' });
  const a = L.account(p, [pay('t1', 300000, '2026-01-05'), pay('t2', 100000, '2026-02-10')], '2026-05-01');
  assert.equal(a.overdue, 0);
  assert.ok(a.items.filter(i => i.due >= '2026-03-01' && i.cover < i.amt).every(i => i.st === 'paused'));
});

test('Arabic search normalisation and spreadsheet-safe cells', () => {
  assert.equal(L.normalize('أحمد'), L.normalize('احمد'));
  assert.equal(L.normalize('فاطمة'), L.normalize('فاطمه'));
  assert.equal(L.normalize('هدى'), L.normalize('هدي'));
  assert.equal(L.safeCell('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")");
  assert.equal(L.safeCell('سارة'), 'سارة');
});
