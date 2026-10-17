const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../shared/core.js');

const TODAY = '2026-10-17', NOW = '2026-10-17T10:00:00Z';
const doctor = { id: 'u1', email: 'doc@example.com', name: 'Doctor', role: 'doctor', clinics: [], canPay: true, active: true };
const asstA = { id: 'u2', email: 'a@example.com', name: 'Mona', role: 'assistant', clinics: ['c1'], canPay: true, active: true };
const asstB = { id: 'u3', email: 'b@example.com', name: 'Salma', role: 'assistant', clinics: ['c2'], canPay: false, active: true };
let n = 0;
const op = (type, data) => ({ opId: 'op' + (++n), type, data });
const run = (s, user, type, data) => Core.apply(s, op(type, data), { user, today: TODAY, now: NOW });

function setup() {
  const s = new Core.Store({ users: [doctor, asstA, asstB] });
  assert.equal(run(s, doctor, 'clinic.save', { id: 'c1', name: 'المعادي', agreementFrom: '2026-01-01' }).status, 'ok');
  assert.equal(run(s, doctor, 'clinic.save', { id: 'c2', name: 'مدينة نصر', agreementFrom: '2026-01-01' }).status, 'ok');
  const r = run(s, doctor, 'patient.save', { id: 'p1', name: 'سارة محمود', phone: '01012345678', clinics: ['c1', 'c2'], type: 'fixed', fee: 1200000, initial: 300000, monthly: 100000, payDay: 10, start: '2026-06-05' });
  assert.equal(r.status, 'ok', r.error);
  run(s, doctor, 'patient.save', { id: 'p2', name: 'عمر طارق', phone: '01123456789', clinics: ['c2'], type: 'removable', fee: 600000, initial: 600000, monthly: 0, payDay: 1, start: '2026-06-01' });
  return s;
}

test('new clinic defaults to 70/30', () => {
  const s = setup();
  const ag = s.list('agreements').find(a => a.cid === 'c1');
  assert.equal(ag.pct, 70); assert.equal(ag.method, 'pct');
});

test('payment stores a frozen 70/30 split; the same opId twice records once', () => {
  const s = setup();
  const o = op('tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 100000, method: 'cash', date: '2026-10-01' });
  const ctx = { user: asstA, today: TODAY, now: NOW };
  assert.equal(Core.apply(s, o, ctx).status, 'ok');
  const again = Core.apply(s, o, ctx);
  assert.equal(again.status, 'ok'); assert.equal(again.replay, true);
  const rows = s.list('ledger').filter(e => e.type === 'payment');
  assert.equal(rows.length, 1); assert.equal(rows[0].docAmt, 70000); assert.equal(rows[0].cliAmt, 30000);
});

test('overpayment is refused; only the doctor can accept it as credit', () => {
  const s = setup();
  assert.equal(run(s, asstA, 'tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 1300000, method: 'cash', date: TODAY }).code, 'overpay');
  assert.equal(run(s, asstA, 'tx.add', { id: 't2', pid: 'p1', cid: 'c1', type: 'payment', amt: 1300000, method: 'cash', date: TODAY, allowCredit: true }).code, 'overpay');
  assert.equal(run(s, doctor, 'tx.add', { id: 't3', pid: 'p1', cid: 'c1', type: 'payment', amt: 1300000, method: 'cash', date: TODAY, allowCredit: true }).status, 'ok');
  assert.equal(Core.accountOf(s, 'p1', TODAY).credit, 100000);
});

test('discount larger than the balance is refused', () => {
  const s = setup();
  assert.equal(run(s, doctor, 'tx.add', { id: 'd1', pid: 'p1', cid: 'c1', type: 'discount', amt: 1300000, date: TODAY }).code, 'over-discount');
});

test('a failed op leaves no trace in the data', () => {
  const s = setup(); const before = s.list('ledger').length, rev = s.rev;
  run(s, asstA, 'tx.add', { id: 'bad', pid: 'p1', cid: 'c1', type: 'payment', amt: 99999999, method: 'cash', date: TODAY });
  assert.equal(s.list('ledger').length, before); assert.equal(s.get('ledger', 'bad'), null);
  assert.equal(s.rev, rev + 1); // only the op record itself
});

test('payment dated before any agreement is refused (fix T6)', () => {
  const s = setup();
  assert.equal(run(s, doctor, 'tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 1000, method: 'cash', date: '2025-12-15' }).code, 'no-agreement');
});

test('closed month: back-dated payments and lab orders are refused; corrections go in an open month (fix T1)', () => {
  const s = setup();
  assert.equal(run(s, doctor, 'tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 100000, method: 'cash', date: '2026-09-10' }).status, 'ok');
  assert.equal(run(s, doctor, 'month.close', { cid: 'c1', month: '2026-09' }).status, 'ok');
  assert.equal(run(s, doctor, 'month.close', { cid: 'c1', month: '2026-10' }).status, 'error');
  assert.equal(run(s, doctor, 'tx.add', { id: 't2', pid: 'p1', cid: 'c1', type: 'payment', amt: 1000, method: 'cash', date: '2026-09-20' }).code, 'closed');
  assert.equal(run(s, doctor, 'lab.create', { id: 'l1', pid: 'p1', cid: 'c1', desc: 'x', orderedAt: '2026-09-20', cost: 1000 }).code, 'closed');
  // the other clinic is not closed
  assert.equal(run(s, doctor, 'tx.add', { id: 't3', pid: 'p1', cid: 'c2', type: 'payment', amt: 1000, method: 'cash', date: '2026-09-20' }).status, 'ok');
  // reversal of the September payment is posted today, September stays as it was
  assert.equal(run(s, doctor, 'tx.reverse', { id: 'r1', target: 't1', note: 'دفعة مكررة' }).status, 'ok');
  assert.equal(s.get('ledger', 'r1').date, TODAY);
  assert.equal(run(s, doctor, 'tx.reverse', { id: 'r2', target: 't1', note: 'مرة أخرى' }).status, 'error');
});

test('assistant sees only own clinics, no agreements and no money splits', () => {
  const s = setup();
  run(s, doctor, 'tx.add', { id: 't1', pid: 'p1', cid: 'c2', type: 'payment', amt: 100000, method: 'cash', date: TODAY });
  const ch = Core.changesSince(s, asstA, 0).rows;
  assert.deepEqual(ch.patients.map(p => p.id), ['p1']);          // p2 is only in c2
  assert.equal(ch.agreements, undefined); assert.equal(ch.audit, undefined);
  assert.deepEqual(ch.clinics.map(c => c.id), ['c1']);
  assert.ok(ch.ledger.every(e => e.docAmt === 0 && e.agId === ''));   // shared plan: sees the c2 payment for the balance, not the split
  assert.equal(ch.users.length, 1);
  assert.equal(run(s, asstA, 'tx.add', { id: 'x', pid: 'p2', cid: 'c2', type: 'payment', amt: 1, method: 'cash', date: TODAY }).code, 'forbidden');
});

test('assistant without payment permission cannot record payments; discounts are doctor-only', () => {
  const s = setup();
  assert.equal(run(s, asstB, 'tx.add', { id: 't1', pid: 'p2', cid: 'c2', type: 'payment', amt: 100, method: 'cash', date: TODAY }).code, 'forbidden');
  assert.equal(run(s, asstA, 'tx.add', { id: 't2', pid: 'p1', cid: 'c1', type: 'discount', amt: 100, date: TODAY }).code, 'forbidden');
});

test('several appointments on one day; overlap needs an explicit override', () => {
  const s = setup();
  const mk = (id, time, extra = {}) => run(s, asstA, 'appt.create', Object.assign({ id, pid: 'p1', cid: 'c1', date: '2026-10-20', time, duration: 20 }, extra));
  assert.equal(mk('a1', '10:00').status, 'ok');
  assert.equal(mk('a2', '10:20').status, 'ok');
  assert.equal(mk('a3', '10:30').code, 'overlap');
  assert.equal(mk('a4', '10:30', { force: true }).status, 'ok');
  assert.equal(s.list('appts').filter(a => a.date === '2026-10-20').length, 3);
});

test('attendance cannot be recorded for a future date', () => {
  const s = setup();
  run(s, asstA, 'appt.create', { id: 'a1', pid: 'p1', cid: 'c1', date: '2026-10-25', time: '10:00' });
  const a = s.get('appts', 'a1');
  assert.equal(run(s, asstA, 'appt.update', { id: 'a1', changes: { status: 'attended' }, base: { status: a.status }, baseVersion: a.version }).status, 'error');
});

test('reschedule creates the new appointment and marks the old one in one step', () => {
  const s = setup();
  run(s, asstA, 'appt.create', { id: 'a1', pid: 'p1', cid: 'c1', date: '2026-10-20', time: '10:00' });
  assert.equal(run(s, asstA, 'appt.reschedule', { id: 'a1', newId: 'a1b', date: '2026-10-27', time: '11:00' }).status, 'ok');
  assert.equal(s.get('appts', 'a1').status, 'rescheduled'); assert.equal(s.get('appts', 'a1').movedTo, 'a1b');
  assert.equal(s.get('appts', 'a1b').status, 'scheduled');
});

test('two devices edit different fields -> merged; same field -> conflict, server value kept', () => {
  const s = setup();
  const p = s.get('patients', 'p1'), v = p.version;
  assert.equal(run(s, doctor, 'patient.save', { id: 'p1', changes: { notes: 'حساسية' }, base: { notes: '' }, baseVersion: v }).status, 'ok');
  assert.equal(run(s, asstA, 'patient.save', { id: 'p1', changes: { phone2: '01099998888' }, base: { phone2: '' }, baseVersion: v }).status, 'ok');
  assert.equal(s.get('patients', 'p1').notes, 'حساسية'); assert.equal(s.get('patients', 'p1').phone2, '01099998888');
  const r = run(s, asstA, 'patient.save', { id: 'p1', changes: { notes: 'لا شيء' }, base: { notes: '' }, baseVersion: v });
  assert.equal(r.status, 'conflict'); assert.equal(r.conflicts[0].theirs, 'حساسية');
  assert.equal(s.get('patients', 'p1').notes, 'حساسية');
});

test('treatment fee changes are never merged: stale version -> conflict', () => {
  const s = setup(); const v = s.get('plans', 'p1').version;
  assert.equal(run(s, doctor, 'plan.update', { pid: 'p1', changes: { fee: 1300000 }, baseVersion: v }).status, 'ok');
  assert.equal(run(s, doctor, 'plan.update', { pid: 'p1', changes: { monthly: 120000 }, baseVersion: v }).status, 'conflict');
  assert.equal(s.list('planHistory').length, 1);
});

test('assistant editing clinics cannot remove a clinic they cannot see', () => {
  const s = setup(); const p = s.get('patients', 'p1');
  run(s, asstA, 'patient.save', { id: 'p1', changes: { clinics: ['c1'] }, base: { clinics: p.clinics }, baseVersion: p.version });
  assert.deepEqual(s.get('patients', 'p1').clinics.sort(), ['c1', 'c2']);
});

test('duplicate phone (including second phone) is refused', () => {
  const s = setup();
  const r = run(s, doctor, 'patient.save', { id: 'p9', name: 'شخص آخر', phone: '01555555555', phone2: '01012345678', clinics: ['c1'], type: 'fixed', fee: 100, initial: 100, monthly: 0, payDay: 1, start: TODAY });
  assert.equal(r.code, 'duplicate-patient');
});

test('settlement cannot exceed what is owed; partial settlements work', () => {
  const s = setup();
  run(s, doctor, 'tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 100000, method: 'cash', date: '2026-10-01' });
  assert.equal(run(s, doctor, 'settle.add', { id: 's1', cid: 'c1', amt: 80000, date: TODAY }).status, 'error');
  assert.equal(run(s, doctor, 'settle.add', { id: 's2', cid: 'c1', amt: 50000, date: TODAY }).status, 'ok');
  assert.equal(run(s, doctor, 'settle.add', { id: 's3', cid: 'c1', amt: 20000, date: TODAY }).status, 'ok');
  assert.equal(run(s, doctor, 'settle.add', { id: 's4', cid: 'c1', amt: 1, date: TODAY }).status, 'error');
});

test('lab: frozen rule at order, payments capped, cancel blocked once paid', () => {
  const s = setup();
  assert.equal(run(s, doctor, 'lab.create', { id: 'l1', pid: 'p1', cid: 'c1', lab: 'النيل', desc: 'مثبّت', orderedAt: '2026-10-10', cost: 100000, paidNow: 40000 }).status, 'ok');
  const l = s.get('labs', 'l1'); assert.equal(l.resp, 'deduct'); assert.equal(l.labDoc, 70000);
  assert.equal(run(s, doctor, 'lab.pay', { id: 'lp2', labId: 'l1', amt: 70000, date: TODAY }).status, 'error');
  assert.equal(run(s, doctor, 'lab.update', { id: 'l1', changes: { status: 'cancelled' }, base: { status: 'ordered' }, baseVersion: l.version }).status, 'error');
  assert.equal(run(s, doctor, 'lab.update', { id: 'l1', changes: { deliveredAt: TODAY }, base: { deliveredAt: '' }, baseVersion: s.get('labs', 'l1').version }).status, 'ok');
  assert.equal(s.get('labs', 'l1').status, 'delivered');
});

test('stock cannot go negative without an authorised adjustment', () => {
  const s = setup();
  run(s, doctor, 'item.save', { id: 'i1', name: 'أسلاك 016', unit: 'علبة', min: 2 });
  assert.equal(run(s, doctor, 'stock.move', { id: 'm1', itemId: 'i1', kind: 'in', qty: 3, cost: 30000, date: TODAY }).status, 'ok');
  assert.equal(run(s, doctor, 'stock.move', { id: 'm2', itemId: 'i1', kind: 'use', qty: 4, date: TODAY }).status, 'error');
  assert.equal(run(s, doctor, 'stock.move', { id: 'm3', itemId: 'i1', kind: 'use', qty: 3, date: TODAY }).status, 'ok');
  assert.equal(Core.stockOf(s, 'i1'), 0);
});

test('agreement change: new version from a date, old entries keep their split', () => {
  const s = setup();
  run(s, doctor, 'tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 100000, method: 'cash', date: '2026-10-01' });
  assert.equal(run(s, doctor, 'agreement.add', { id: 'ag2', cid: 'c1', from: '2026-10-15', method: 'pct', pct: 60, lab: 'deduct' }).status, 'ok');
  run(s, doctor, 'tx.add', { id: 't2', pid: 'p1', cid: 'c1', type: 'payment', amt: 100000, method: 'cash', date: TODAY });
  assert.equal(s.get('ledger', 't1').docAmt, 70000); assert.equal(s.get('ledger', 't2').docAmt, 60000);
  assert.equal(s.get('agreements', 'ag-c1').to, '2026-10-14');
  assert.equal(run(s, doctor, 'agreement.add', { id: 'ag3', cid: 'c1', from: '2026-10-01', pct: 50 }).status, 'error');
});

test('incremental sync returns only newer rows', () => {
  const s = setup(); const r0 = s.rev;
  run(s, asstA, 'appt.create', { id: 'a1', pid: 'p1', cid: 'c1', date: '2026-10-20', time: '10:00' });
  const ch = Core.changesSince(s, asstA, r0).rows;
  assert.deepEqual(Object.keys(ch).sort(), ['appts']);
});
