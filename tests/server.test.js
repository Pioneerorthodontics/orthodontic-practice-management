const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./gas-mock.js');

const future = Math.floor(Date.now() / 1000) + 3600;
const tok = (email, aud = 'client-123') => ({ aud, iss: 'accounts.google.com', email, email_verified: 'true', exp: String(future) });
const tokens = { DOC: tok('doctor@gmail.com'), MONA: tok('mona@gmail.com'), BAD: tok('doctor@gmail.com', 'other-app'), STRANGER: tok('x@gmail.com') };
let k = 0; const op = (type, data) => ({ opId: 'srv' + (++k), type, data });

function boot() {
  const env = makeEnv({ tokens });
  env.setup();
  return env;
}

test('setup creates the database, owner account, folders, 3 triggers and a first backup', () => {
  const env = boot();
  const ss = env.db_();
  assert.ok(ss.getSheetByName('ledger') && ss.getSheetByName('meta') && ss.getSheetByName('backupLog'));
  assert.equal(ss.getSheetByName('Sheet1'), null);
  const r = env.post({ idToken: 'DOC', action: 'sync', sinceRev: 0 });
  assert.equal(r.ok, true); assert.equal(r.me.role, 'doctor');
  assert.equal(env.ScriptApp.getProjectTriggers().length, 3);
  assert.equal(env.listBackups_().length, 1);
});

test('sign-in is checked on the server: wrong app, unknown user and missing token are refused', () => {
  const env = boot();
  assert.equal(env.post({ idToken: 'BAD' }).code, 'auth');
  assert.equal(env.post({}).code, 'auth');
  assert.equal(env.post({ idToken: 'STRANGER' }).code, 'forbidden');
});

test('ops are saved to the Sheet, survive a reload, and a retried request does not duplicate money', () => {
  const env = boot();
  const ops = [
    op('clinic.save', { id: 'c1', name: 'عيادة المعادي', agreementFrom: '2026-01-01' }),
    op('user.save', { id: 'u2', email: 'mona@gmail.com', name: 'منى', role: 'assistant', clinics: ['c1'], canPay: true }),
    op('patient.save', { id: 'p1', name: '=HYPERLINK("http://evil")', phone: '01012345678', clinics: ['c1'], type: 'fixed', fee: 1200000, initial: 300000, monthly: 100000, payDay: 31, start: '2026-01-05' }),
  ];
  let r = env.post({ idToken: 'DOC', ops, sinceRev: 0 });
  assert.ok(Object.values(r.results).every(x => x.status === 'ok'), JSON.stringify(r.results));
  const pay = op('tx.add', { id: 't1', pid: 'p1', cid: 'c1', type: 'payment', amt: 100000, method: 'cash', date: r.today });
  r = env.post({ idToken: 'MONA', ops: [pay], sinceRev: 0 });
  assert.equal(r.results[pay.opId].status, 'ok');
  // the phone lost the answer and sends the same op again
  r = env.post({ idToken: 'MONA', ops: [pay], sinceRev: 0 });
  assert.equal(r.results[pay.opId].replay, true);
  const ledgerRows = env.db_().getSheetByName('ledger').getDataRange().getValues().slice(1);
  assert.equal(ledgerRows.filter(x => x[0] === 't1').length, 1);
  // a fresh load reads exactly what was written, with types intact
  const store = env.loadStore_(env.db_());
  const t1 = store.get('ledger', 't1');
  assert.equal(t1.amt, 100000); assert.equal(t1.docAmt, 70000); assert.equal(typeof t1.amt, 'number');
  assert.deepEqual(store.get('patients', 'p1').clinics, ['c1']);
  assert.equal(store.get('plans', 'p1').payDay, 31);
  assert.equal(store.get('users', 'u2').canPay, true);
  // the formula-looking name is stored as text, not as a formula
  assert.equal(store.get('patients', 'p1').name, '=HYPERLINK("http://evil")');
  assert.ok(!JSON.stringify(env.db_().getSheetByName('patients').data).includes('#FORMULA'));
});

test('assistant receives only allowed rows and no doctor/clinic split', () => {
  const env = boot();
  env.post({ idToken: 'DOC', ops: [
    op('clinic.save', { id: 'c1', name: 'المعادي', agreementFrom: '2026-01-01' }),
    op('clinic.save', { id: 'c2', name: 'الدقي', agreementFrom: '2026-01-01' }),
    op('user.save', { id: 'u2', email: 'mona@gmail.com', name: 'منى', role: 'assistant', clinics: ['c1'], canPay: true }),
    op('patient.save', { id: 'p1', name: 'مريض أول', phone: '01011111111', clinics: ['c1'], type: 'fixed', fee: 100000, initial: 0, monthly: 10000, payDay: 1, start: '2026-01-01' }),
    op('patient.save', { id: 'p2', name: 'مريض ثاني', phone: '01022222222', clinics: ['c2'], type: 'fixed', fee: 100000, initial: 0, monthly: 10000, payDay: 1, start: '2026-01-01' })
  ] });
  const r = env.post({ idToken: 'MONA', sinceRev: 0 });
  assert.deepEqual(r.rows.patients.map(p => p.id), ['p1']);
  assert.equal(r.rows.agreements, undefined);
  assert.equal(r.rows.audit, undefined);
  assert.equal(env.post({ idToken: 'MONA', action: 'backups' }).code, 'forbidden');
});

test('incremental sync, then epoch change after restore forces a full reload', () => {
  const env = boot();
  let r = env.post({ idToken: 'DOC', ops: [op('clinic.save', { id: 'c1', name: 'المعادي', agreementFrom: '2026-01-01' })], sinceRev: 0 });
  const rev = r.rev, epoch = r.epoch;
  r = env.post({ idToken: 'DOC', sinceRev: rev, epoch });
  assert.deepEqual(r.rows, {});
  const b = env.hourlyBackup();
  env.post({ idToken: 'DOC', ops: [op('clinic.save', { id: 'c2', name: 'الدقي', agreementFrom: '2026-01-01' })], sinceRev: rev, epoch });
  assert.equal(env.post({ idToken: 'DOC', action: 'restore', fileId: b.fileId }).code, 'invalid'); // needs typed confirmation
  const res = env.post({ idToken: 'DOC', action: 'restore', fileId: b.fileId, confirm: 'RESTORE' });
  assert.equal(res.ok, true, res.error);
  r = env.post({ idToken: 'DOC', sinceRev: rev, epoch });
  assert.equal(r.full, true);
  assert.deepEqual(r.rows.clinics.map(c => c.id), ['c1']);          // c2 was added after the backup
  assert.ok(env.listBackups_().some(x => /pre-restore/.test(x.name)));
});

test('hourly backups are pruned to the retention policy; nightly check passes; Excel export is verified', () => {
  const env = boot();
  for (let i = 0; i < 60; i++) env.hourlyBackup();
  assert.equal(env.listBackups_().length <= 48 + 30, true);
  assert.ok(env.listBackups_().length >= 48);
  env.nightlyCheck();
  const log = env.readLog_(env.db_(), 5);
  assert.equal(log.find(l => l.kind === 'check').status, 'ok');
  const x = env.dailyExport();
  assert.ok(x.fileId);
  assert.equal(env.readLog_(env.db_(), 1)[0].kind, 'excel');
});

test('a failed Excel export is logged as failed and emailed, never shown as success', () => {
  const env = makeEnv({ tokens, exportCode: 403 }); env.setup();
  assert.throws(() => env.dailyExport());
  assert.equal(env.readLog_(env.db_(), 1)[0].status, 'failed');
  assert.equal(env.__mail.length, 1);
});
