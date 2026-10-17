/* Ortho Practice Manager — shared business rules.
 * Every change is an "operation" (op) applied through Core.apply(). The same code runs:
 *   - on the device, to show a change at once while it waits in the outbox, and
 *   - in Google Apps Script, where the result is final and saved to the Sheet.
 * The server is always the judge: the device view is rebuilt from server rows + pending ops.
 * Requires Ledger (shared/ledger.js).
 */
var Core = (function (L) {
  'use strict';

  var META = ['version', 'rev', 'updatedAt', 'updatedBy'];
  /** Column order for each Sheet tab. n = number, b = boolean, j = JSON. */
  var SCHEMA = {
    clinics: ['id', 'name', 'nameEn', 'phone', 'address', 'days', 'hours', 'slot:n', 'active:b', 'notes'],
    agreements: ['id', 'cid', 'from', 'to', 'method', 'pct:n', 'fee:n', 'lab', 'notes'],
    users: ['id', 'email', 'name', 'role', 'clinics:j', 'canPay:b', 'active:b'],
    patients: ['id', 'code', 'name', 'phone', 'phone2', 'reg', 'clinics:j', 'type', 'notes'],
    plans: ['id', 'pid', 'fee:n', 'initial:n', 'monthly:n', 'payDay:n', 'start', 'status', 'pausedFrom'],
    planHistory: ['id', 'pid', 'at', 'by', 'before:j', 'after:j'],
    appts: ['id', 'pid', 'cid', 'date', 'time', 'duration:n', 'kind', 'status', 'note', 'createdAt', 'createdBy', 'movedTo'],
    ledger: ['id', 'date', 'pid', 'cid', 'type', 'amt:n', 'method', 'inst', 'reverses', 'ref', 'note', 'agId', 'pct:n', 'docAmt:n', 'cliAmt:n', 'by', 'at'],
    labs: ['id', 'pid', 'cid', 'lab', 'desc', 'orderedAt', 'expectedAt', 'deliveredAt', 'cost:n', 'resp', 'labDoc:n', 'labCli:n', 'status', 'notes'],
    labPays: ['id', 'labId', 'cid', 'date', 'amt:n', 'note', 'by', 'at'],
    settlements: ['id', 'cid', 'date', 'amt:n', 'ref', 'note', 'by', 'at'],
    closes: ['id', 'cid', 'month', 'by', 'at'],
    items: ['id', 'name', 'category', 'unit', 'min:n', 'cid', 'supplier', 'notes', 'active:b'],
    moves: ['id', 'itemId', 'cid', 'date', 'kind', 'qty:n', 'cost:n', 'supplier', 'note', 'by', 'at'],
    audit: ['id', 'at', 'user', 'action', 'summary', 'data:j'],
    ops: ['id', 'type', 'user', 'at', 'status', 'result:j']
  };
  var TABLES = Object.keys(SCHEMA);
  var METHODS = { cash: 'نقدي', card: 'بطاقة بنكية', wallet: 'محفظة إلكترونية', instapay: 'إنستاباي', other: 'أخرى' };
  var TYPES = { fixed: 'تقويم ثابت', aligners: 'تقويم شفاف', removable: 'جهاز متحرك', retainer: 'مثبّت', other: 'أخرى' };
  var APPT_STATUS = ['scheduled', 'confirmed', 'attended', 'absent', 'cancelled', 'rescheduled'];
  var LAB_STATUS = ['ordered', 'in_progress', 'delivered', 'cancelled'];
  var LAB_RULES = ['separate', 'deduct', 'doctor', 'clinic', 'patient'];

  function CoreError(msg, code) { this.message = msg; this.code = code || 'invalid'; }
  function fail(msg, code) { throw new CoreError(msg, code); }

  /* ---------- in-memory store with change tracking ---------- */
  function Store(tables, meta) {
    var self = this; meta = meta || {};
    this.t = {}; this.byId = {}; this.dirty = {};
    TABLES.forEach(function (n) {
      self.t[n] = (tables && tables[n] ? tables[n] : []).slice();
      self.byId[n] = {}; self.t[n].forEach(function (r) { self.byId[n][r.id] = r; });
    });
    this.rev = +meta.rev || 0; this.patientSeq = +meta.patientSeq || 0;
  }
  Store.prototype.get = function (t, id) { return this.byId[t][id] || null; };
  Store.prototype.list = function (t) { return this.t[t]; };
  Store.prototype.insert = function (t, row, ctx) {
    if (!row.id) fail('missing id');
    if (this.byId[t][row.id]) fail('duplicate id ' + row.id, 'duplicate');
    row.version = 1; row.rev = ++this.rev; row.updatedAt = ctx.now; row.updatedBy = ctx.user.email;
    this.t[t].push(row); this.byId[t][row.id] = row; this.mark(t, row.id); return row;
  };
  Store.prototype.patch = function (t, id, changes, ctx) {
    var row = this.byId[t][id]; if (!row) fail('not found');
    for (var k in changes) row[k] = changes[k];
    row.version = (+row.version || 0) + 1; row.rev = ++this.rev; row.updatedAt = ctx.now; row.updatedBy = ctx.user.email;
    this.mark(t, id); return row;
  };
  Store.prototype.touch = function (t, id) { var r = this.byId[t][id]; if (r) { r.rev = ++this.rev; this.mark(t, id); } };
  Store.prototype.mark = function (t, id) { (this.dirty[t] || (this.dirty[t] = {}))[id] = true; };
  Store.prototype.meta = function () { return { rev: this.rev, patientSeq: this.patientSeq }; };
  Store.prototype.snapshot = function () { var o = {}, s = this; TABLES.forEach(function (n) { o[n] = s.t[n]; }); return o; };

  /* ---------- helpers ---------- */
  var isDoc = function (u) { return u && u.role === 'doctor'; };
  function userClinics(store, u) {
    if (isDoc(u)) return store.list('clinics').map(function (c) { return c.id; });
    return (u.clinics || []).filter(function (id) { return store.get('clinics', id); });
  }
  function needDoc(ctx) { if (!isDoc(ctx.user)) fail('هذه العملية للطبيب فقط.', 'forbidden'); }
  function needClinic(store, ctx, cid) {
    var c = store.get('clinics', cid); if (!c) fail('العيادة غير موجودة.');
    if (userClinics(store, ctx.user).indexOf(cid) < 0) fail('ليس لديك صلاحية على هذه العيادة.', 'forbidden');
    return c;
  }
  function patientVisible(store, u, p) { var cs = userClinics(store, u); return (p.clinics || []).some(function (c) { return cs.indexOf(c) >= 0; }); }
  function needPatient(store, ctx, pid) {
    var p = store.get('patients', pid); if (!p) fail('المريض غير موجود.');
    if (!patientVisible(store, ctx.user, p)) fail('ليس لديك صلاحية على هذا المريض.', 'forbidden');
    return p;
  }
  function isClosed(store, cid, date) { return !!store.get('closes', cid + ':' + L.monthOf(date)); }
  function needOpen(store, cid, date) { if (isClosed(store, cid, date)) fail('شهر ' + L.monthOf(date) + ' مُغلق لهذه العيادة. سجّل التصحيح بتاريخ في شهر مفتوح.', 'closed'); }
  function needDate(d, label) { if (!L.isDate(d)) fail((label || 'التاريخ') + ' غير صحيح.'); }
  function needPastOrToday(d, ctx, label) { needDate(d, label); if (d > ctx.today) fail((label || 'التاريخ') + ' لا يمكن أن يكون في المستقبل.'); }
  function needAmount(v, label) { if (typeof v !== 'number' || !isFinite(v) || v !== Math.floor(v) || v <= 0) fail((label || 'المبلغ') + ' يجب أن يكون رقماً موجباً.'); }
  function str(v, max) { v = v == null ? '' : String(v).trim(); return v.length > (max || 500) ? v.slice(0, max || 500) : v; }
  function money(p) { var s = (p / 100).toFixed(2).replace(/\.00$/, ''); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' ج.م'; }
  function dataOf(store) { return { agreements: store.list('agreements'), ledger: store.list('ledger'), appts: store.list('appts'), labs: store.list('labs'), settlements: store.list('settlements') }; }
  function patientEntries(store, pid) { return store.list('ledger').filter(function (e) { return e.pid === pid; }); }
  function accountOf(store, pid, today) {
    var plan = store.get('plans', pid); if (!plan) fail('لا توجد خطة علاج لهذا المريض.');
    return L.account(plan, patientEntries(store, pid), today);
  }
  function audit(store, ctx, action, summary, data) {
    ctx.auditN = (ctx.auditN || 0) + 1;
    store.insert('audit', { id: 'au-' + ctx.opId + (ctx.auditN > 1 ? '-' + ctx.auditN : ''), at: ctx.now, user: ctx.user.email, action: action, summary: summary, data: data || null }, ctx);
  }
  function minutes(t) { var m = /^(\d{2}):(\d{2})$/.exec(t || ''); if (!m || +m[1] > 23 || +m[2] > 59) return null; return +m[1] * 60 + +m[2]; }
  function overlapping(store, a) {
    var s = minutes(a.time), e = s + (a.duration || 20);
    return store.list('appts').filter(function (b) {
      if (b.id === a.id || b.cid !== a.cid || b.date !== a.date || ['cancelled', 'rescheduled', 'absent'].indexOf(b.status) >= 0) return false;
      var bs = minutes(b.time), be = bs + (b.duration || 20);
      return s < be && bs < e;
    });
  }
  function fixedModel(store, cid, date) { var a = L.agreementAt(store.list('agreements'), cid, date); return a && a.method !== 'pct'; }
  function sameVal(a, b) { return JSON.stringify(a == null ? '' : a) === JSON.stringify(b == null ? '' : b); }

  /**
   * Field-level merge. changes = fields the device changed; base = their values when the device read the row.
   * A field changed on both sides to different values is a conflict and is NOT applied.
   */
  function merge(row, changes, base, baseVersion) {
    var apply = {}, conflicts = [];
    Object.keys(changes).forEach(function (f) {
      if (+row.version === +baseVersion || sameVal(row[f], base[f])) apply[f] = changes[f];
      else if (!sameVal(row[f], changes[f])) conflicts.push({ field: f, mine: changes[f], theirs: row[f], base: base[f] });
    });
    return { apply: apply, conflicts: conflicts };
  }
  function pick(o, keys) { var r = {}; keys.forEach(function (k) { if (o && Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; }); return r; }

  /* ---------- operation handlers ---------- */
  var H = {};

  H['clinic.save'] = function (s, d, ctx) {
    needDoc(ctx);
    var f = { name: str(d.name, 80), nameEn: str(d.nameEn, 80), phone: str(d.phone, 30), address: str(d.address, 200), days: str(d.days, 100),
      hours: str(d.hours, 100), slot: Math.max(5, Math.min(240, +d.slot || 20)), active: d.active !== false, notes: str(d.notes, 1000) };
    if (f.name.length < 2) fail('اكتب اسم العيادة.');
    var old = d.id && s.get('clinics', d.id);
    if (old) {
      var m = merge(old, pick(f, Object.keys(d.changes || f)), d.base || {}, d.baseVersion);
      if (Object.keys(m.apply).length) s.patch('clinics', old.id, m.apply, ctx);
      audit(s, ctx, 'clinic.save', 'تعديل عيادة ' + old.name);
      return m.conflicts.length ? { conflicts: m.conflicts, table: 'clinics', id: old.id } : { id: old.id };
    }
    f.id = d.id; s.insert('clinics', f, ctx);
    var from = d.agreementFrom || L.monthStart(ctx.today); needDate(from, 'تاريخ بداية الاتفاق');
    s.insert('agreements', { id: 'ag-' + d.id, cid: d.id, from: from, to: '', method: 'pct', pct: d.pct == null ? 70 : +d.pct, fee: 0, lab: LAB_RULES.indexOf(d.lab) >= 0 ? d.lab : 'deduct', notes: '' }, ctx);
    audit(s, ctx, 'clinic.save', 'إضافة عيادة ' + f.name + ' (اتفاق ' + (d.pct == null ? 70 : d.pct) + '٪ للطبيب)');
    return { id: d.id };
  };

  H['agreement.add'] = function (s, d, ctx) {
    needDoc(ctx); needClinic(s, ctx, d.cid);
    var method = d.method || 'pct', pct = +d.pct || 0, fee = +d.fee || 0, lab = d.lab || 'separate';
    if (['pct', 'fixed', 'fixed_pct'].indexOf(method) < 0) fail('طريقة حساب غير معروفة.');
    if (method !== 'fixed' && !(pct > 0 && pct <= 100 && Math.round(pct * 100) === pct * 100)) fail('نسبة الطبيب يجب أن تكون بين ١ و ١٠٠ (حتى رقمين عشريين).');
    if (method !== 'pct' && !(fee > 0 && fee === Math.floor(fee))) fail('اكتب المبلغ الثابت لكل زيارة.');
    if (LAB_RULES.indexOf(lab) < 0) fail('قاعدة المعمل غير معروفة.');
    if (method === 'fixed' && lab === 'deduct') fail('مع المبلغ الثابت لا يمكن "خصم المعمل قبل التقسيم". اختر من يتحمل المعمل.');
    needDate(d.from, 'تاريخ البداية'); needOpen(s, d.cid, d.from);
    var mine = s.list('agreements').filter(function (a) { return a.cid === d.cid; });
    if (mine.some(function (a) { return a.from >= d.from; })) fail('يوجد اتفاق يبدأ في نفس التاريخ أو بعده. اختر تاريخاً أحدث.');
    var cur = mine.filter(function (a) { return !a.to || a.to >= d.from; });
    cur.forEach(function (a) { s.patch('agreements', a.id, { to: L.addDays(d.from, -1) }, ctx); });
    s.insert('agreements', { id: d.id, cid: d.cid, from: d.from, to: '', method: method, pct: method === 'fixed' ? 0 : pct, fee: method === 'pct' ? 0 : fee, lab: lab, notes: str(d.notes) }, ctx);
    audit(s, ctx, 'agreement.add', 'اتفاق جديد لـ ' + s.get('clinics', d.cid).name + ' من ' + d.from + ': ' + pct + '٪ · معمل: ' + lab);
    return { id: d.id };
  };

  H['user.save'] = function (s, d, ctx) {
    needDoc(ctx);
    var email = str(d.email, 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('البريد الإلكتروني غير صحيح.');
    var role = d.role === 'doctor' ? 'doctor' : 'assistant';
    var clinics = (d.clinics || []).filter(function (c) { return s.get('clinics', c); });
    if (role === 'assistant' && !clinics.length) fail('اختر عيادة واحدة على الأقل للمساعد.');
    var dup = s.list('users').filter(function (u) { return u.email === email && u.id !== d.id; })[0];
    if (dup) fail('هذا البريد مسجّل بالفعل لـ ' + dup.name + '.');
    var f = { email: email, name: str(d.name, 80) || email, role: role, clinics: clinics, canPay: !!d.canPay || role === 'doctor', active: d.active !== false };
    var old = d.id && s.get('users', d.id);
    if (old) {
      if (old.id === ctx.user.id && (role !== 'doctor' || !f.active)) fail('لا يمكنك إلغاء صلاحية حسابك أنت.');
      s.patch('users', old.id, f, ctx); audit(s, ctx, 'user.save', 'تعديل صلاحيات ' + f.name, f);
    } else { f.id = d.id; s.insert('users', f, ctx); audit(s, ctx, 'user.save', 'إضافة مستخدم ' + f.name + ' (' + email + ')', f); }
    return { id: d.id };
  };

  function readPhones(d) {
    var norm = function (x) { return L.normalize(str(x, 20)).replace(/[\s-]/g, ''); };
    var phone = norm(d.phone), phone2 = norm(d.phone2);
    if (!/^0\d{9,10}$/.test(phone)) fail('رقم الهاتف غير صحيح. مثال: 01012345678');
    if (phone2 && !/^0\d{9,10}$/.test(phone2)) fail('رقم الهاتف الثاني غير صحيح.');
    return { phone: phone, phone2: phone2 };
  }
  function dupPhone(s, id, ph) {
    var mine = [ph.phone, ph.phone2].filter(Boolean);
    return s.list('patients').filter(function (p) { return p.id !== id && [p.phone, p.phone2].some(function (x) { return x && mine.indexOf(x) >= 0; }); })[0];
  }
  function readPlan(d, ctx) {
    var p = { fee: d.fee, initial: d.initial || 0, monthly: d.monthly || 0, payDay: +d.payDay, start: d.start };
    needAmount(p.fee, 'قيمة العلاج');
    if (!(p.initial >= 0 && p.initial === Math.floor(p.initial))) fail('المقدم غير صحيح.');
    if (p.initial > p.fee) fail('المقدم أكبر من قيمة العلاج.');
    if (p.fee > p.initial && !(p.monthly > 0)) fail('اكتب القسط الشهري، أو اجعل المقدم يساوي قيمة العلاج.');
    if (!(p.payDay >= 1 && p.payDay <= 31)) fail('يوم السداد يجب أن يكون بين ١ و ٣١.');
    needDate(p.start, 'بداية العلاج');
    return p;
  }

  H['patient.save'] = function (s, d, ctx) {
    var vis = userClinics(s, ctx.user);
    if (d.id && s.get('patients', d.id)) {
      var p = needPatient(s, ctx, d.id), ch = pick(d.changes || {}, ['name', 'phone', 'phone2', 'clinics', 'type', 'notes']);
      if (ch.name != null) { ch.name = str(ch.name, 100); if (ch.name.length < 3) fail('اكتب اسم المريض كاملاً.'); }
      if (ch.phone != null || ch.phone2 != null) {
        var ph = readPhones({ phone: ch.phone != null ? ch.phone : p.phone, phone2: ch.phone2 != null ? ch.phone2 : p.phone2 });
        var du = dupPhone(s, p.id, ph); if (du) fail('هذا الرقم مسجّل للمريض ' + du.name + ' (' + du.code + ').');
        if (ch.phone != null) ch.phone = ph.phone; if (ch.phone2 != null) ch.phone2 = ph.phone2;
      }
      if (ch.clinics) {
        var hidden = (p.clinics || []).filter(function (c) { return vis.indexOf(c) < 0; });
        ch.clinics = ch.clinics.filter(function (c) { return vis.indexOf(c) >= 0; }).concat(hidden);
        if (!ch.clinics.length) fail('اختر عيادة واحدة على الأقل.');
      }
      if (ch.type && !TYPES[ch.type]) fail('نوع العلاج غير معروف.');
      if (ch.notes != null) ch.notes = str(ch.notes, 2000);
      var m = merge(p, ch, d.base || {}, d.baseVersion);
      var before = JSON.stringify(p.clinics);
      if (Object.keys(m.apply).length) s.patch('patients', p.id, m.apply, ctx);
      if (JSON.stringify(p.clinics) !== before) touchPatient(s, p.id); // newly allowed users must receive the history
      audit(s, ctx, 'patient.save', 'تعديل بيانات ' + p.name, m.apply);
      return m.conflicts.length ? { conflicts: m.conflicts, table: 'patients', id: p.id } : { id: p.id };
    }
    var name = str(d.name, 100); if (name.length < 3) fail('اكتب اسم المريض كاملاً.');
    var phones = readPhones(d), dup = dupPhone(s, d.id, phones);
    if (dup) fail('هذا الرقم مسجّل للمريض ' + dup.name + ' (' + dup.code + '). افتح ملفه بدلاً من إنشاء ملف مكرر.', 'duplicate-patient');
    var clinics = (d.clinics || []).filter(function (c) { return vis.indexOf(c) >= 0; });
    if (!clinics.length) fail('اختر عيادة واحدة على الأقل.');
    if (!TYPES[d.type]) fail('نوع العلاج غير معروف.');
    var plan = readPlan(d, ctx);
    s.patientSeq++;
    var code = 'P-' + ('000' + s.patientSeq).slice(-4);
    s.insert('patients', { id: d.id, code: code, name: name, phone: phones.phone, phone2: phones.phone2, reg: ctx.today, clinics: clinics, type: d.type, notes: str(d.notes, 2000) }, ctx);
    s.insert('plans', { id: d.id, pid: d.id, fee: plan.fee, initial: plan.initial, monthly: plan.monthly, payDay: plan.payDay, start: plan.start, status: 'active', pausedFrom: '' }, ctx);
    audit(s, ctx, 'patient.save', 'تسجيل مريض جديد ' + name + ' (' + code + ')');
    return { id: d.id, code: code };
  };
  function touchPatient(s, pid) {
    s.touch('plans', pid);
    ['ledger', 'appts', 'planHistory'].forEach(function (t) { s.list(t).forEach(function (r) { if (r.pid === pid) s.touch(t, r.id); }); });
  }

  H['plan.update'] = function (s, d, ctx) {
    needDoc(ctx); needPatient(s, ctx, d.pid);
    var plan = s.get('plans', d.pid);
    if (+plan.version !== +d.baseVersion) // money fields are never merged automatically
      return { conflicts: Object.keys(d.changes || {}).map(function (f) { return { field: f, mine: d.changes[f], theirs: plan[f] }; }), table: 'plans', id: plan.id };
    var next = Object.assign({}, plan, d.changes || {});
    readPlan(next, ctx);
    if (['active', 'paused', 'done'].indexOf(next.status) < 0) fail('حالة العلاج غير معروفة.');
    if (next.status === 'paused') { next.pausedFrom = next.pausedFrom || ctx.today; needDate(next.pausedFrom, 'تاريخ الإيقاف'); } else next.pausedFrom = '';
    var keys = ['fee', 'initial', 'monthly', 'payDay', 'start', 'status', 'pausedFrom'];
    s.insert('planHistory', { id: 'ph-' + ctx.opId, pid: d.pid, at: ctx.now, by: ctx.user.email, before: pick(plan, keys), after: pick(next, keys) }, ctx);
    s.patch('plans', plan.id, pick(next, keys), ctx);
    audit(s, ctx, 'plan.update', 'تعديل خطة ' + s.get('patients', d.pid).name + ': ' + money(plan.fee) + ' → ' + money(next.fee), { before: pick(plan, keys), after: pick(next, keys) });
    return { id: plan.id };
  };

  function checkAppt(s, a, ctx, force) {
    needClinic(s, ctx, a.cid); needDate(a.date, 'تاريخ الموعد');
    if (minutes(a.time) == null) fail('اختر وقتاً صحيحاً.');
    if (!(a.duration >= 5 && a.duration <= 480)) fail('مدة الموعد غير صحيحة.');
    if (APPT_STATUS.indexOf(a.status) < 0) fail('حالة الموعد غير معروفة.');
    if (a.status === 'attended' && a.date > ctx.today) fail('لا يمكن تسجيل حضور لموعد في المستقبل.');
    var clash = overlapping(s, a);
    if (clash.length && !force && ['scheduled', 'confirmed', 'attended'].indexOf(a.status) >= 0) {
      var o = clash[0]; fail('يوجد موعد آخر في نفس الوقت: ' + (s.get('patients', o.pid) || {}).name + ' الساعة ' + o.time + '. اختر وقتاً آخر أو احجز رغم التعارض.', 'overlap');
    }
  }
  H['appt.create'] = function (s, d, ctx) {
    var p = needPatient(s, ctx, d.pid);
    var a = { id: d.id, pid: d.pid, cid: d.cid, date: d.date, time: d.time, duration: +d.duration || ((s.get('clinics', d.cid) || {}).slot || 20),
      kind: str(d.kind, 60) || 'متابعة شهرية', status: d.status || 'scheduled', note: str(d.note, 500), createdAt: ctx.now, createdBy: ctx.user.email, movedTo: '' };
    checkAppt(s, a, ctx, d.force);
    if (a.status === 'attended' && fixedModel(s, a.cid, a.date)) needOpen(s, a.cid, a.date);
    if ((p.clinics || []).indexOf(a.cid) < 0) { s.patch('patients', p.id, { clinics: p.clinics.concat([a.cid]) }, ctx); touchPatient(s, p.id); }
    s.insert('appts', a, ctx);
    audit(s, ctx, 'appt.create', 'موعد ' + p.name + ' — ' + s.get('clinics', a.cid).name + ' — ' + a.date + ' ' + a.time + (a.status === 'attended' ? ' (حالة بدون موعد)' : ''));
    return { id: a.id };
  };
  H['appt.update'] = function (s, d, ctx) {
    var a = s.get('appts', d.id); if (!a) fail('الموعد غير موجود.');
    needClinic(s, ctx, a.cid);
    var ch = pick(d.changes || {}, ['status', 'note', 'time', 'date', 'kind', 'duration']);
    var m = merge(a, ch, d.base || {}, d.baseVersion);
    var next = Object.assign({}, a, m.apply);
    if (fixedModel(s, a.cid, a.date) && (m.apply.status || m.apply.date)) { needOpen(s, a.cid, a.date); needOpen(s, a.cid, next.date); }
    checkAppt(s, next, ctx, d.force || !(m.apply.time || m.apply.date || m.apply.duration));
    if (Object.keys(m.apply).length) s.patch('appts', a.id, m.apply, ctx);
    audit(s, ctx, 'appt.update', 'تعديل موعد ' + (s.get('patients', a.pid) || {}).name + (m.apply.status ? ' → ' + m.apply.status : ''), m.apply);
    return m.conflicts.length ? { conflicts: m.conflicts, table: 'appts', id: a.id } : { id: a.id };
  };
  H['appt.reschedule'] = function (s, d, ctx) {
    var a = s.get('appts', d.id); if (!a) fail('الموعد غير موجود.');
    needClinic(s, ctx, a.cid);
    if (['scheduled', 'confirmed'].indexOf(a.status) < 0) fail('يمكن تأجيل المواعيد المحجوزة أو المؤكدة فقط.');
    var n = { id: d.newId, pid: a.pid, cid: d.cid || a.cid, date: d.date, time: d.time, duration: a.duration, kind: a.kind, status: 'scheduled', note: a.note, createdAt: ctx.now, createdBy: ctx.user.email, movedTo: '' };
    checkAppt(s, n, ctx, d.force);
    s.insert('appts', n, ctx);
    s.patch('appts', a.id, { status: 'rescheduled', movedTo: n.id }, ctx);   // both in one op: never left without an appointment
    audit(s, ctx, 'appt.reschedule', 'تأجيل موعد ' + (s.get('patients', a.pid) || {}).name + ' من ' + a.date + ' إلى ' + n.date + ' ' + n.time);
    return { id: n.id };
  };

  H['tx.add'] = function (s, d, ctx) {
    var type = d.type;
    if (['payment', 'charge', 'discount', 'refund'].indexOf(type) < 0) fail('نوع الحركة غير معروف.');
    if (type === 'payment') { if (!isDoc(ctx.user) && !ctx.user.canPay) fail('ليس لديك صلاحية تسجيل الدفعات.', 'forbidden'); }
    else needDoc(ctx);
    var p = needPatient(s, ctx, d.pid); needClinic(s, ctx, d.cid);
    needAmount(d.amt); needPastOrToday(d.date, ctx); needOpen(s, d.cid, d.date);
    var cashy = type === 'payment' || type === 'refund';
    if (cashy && !METHODS[d.method]) fail('اختر طريقة الدفع.');
    var ag = L.agreementAt(s.list('agreements'), d.cid, d.date);
    // fix T6. On an assistant's device agreements are not available; the server makes the final check.
    if (cashy && !ag && !(ctx.local && !isDoc(ctx.user))) fail('لا يوجد اتفاق ساري لهذه العيادة في ' + d.date + '. أضف الاتفاق أولاً.', 'no-agreement');
    var acc = accountOf(s, p.id, ctx.today);
    if (type === 'payment' && d.amt > acc.balance && !(isDoc(ctx.user) && d.allowCredit))                        // fix T3
      fail('المبلغ أكبر من المتبقي على المريض (' + money(Math.max(0, acc.balance)) + '). الطبيب فقط يمكنه قبول الزيادة كرصيد للمريض.', 'overpay');
    if (type === 'discount' && d.amt > acc.balance) fail('الخصم أكبر من المتبقي (' + money(Math.max(0, acc.balance)) + ').', 'over-discount'); // fix T4
    if (type === 'refund' && d.amt > acc.cash) fail('مبلغ الاسترداد أكبر من المدفوع فعلاً (' + money(acc.cash) + ').');
    var inst = str(d.inst, 60);
    if (inst && type === 'payment' && !acc.items.some(function (i) { return i.key === inst; })) fail('القسط المختار غير موجود.');
    var e = { id: d.id, date: d.date, pid: p.id, cid: d.cid, type: type, amt: d.amt, method: cashy ? d.method : '', inst: type === 'payment' ? inst : '',
      reverses: '', ref: str(d.ref, 60), note: str(d.note, 300), agId: '', pct: 0, docAmt: 0, cliAmt: 0, by: ctx.user.email, at: ctx.now };
    if (cashy && ag) { var sp = L.splitCash(type === 'payment' ? d.amt : -d.amt, ag); e.agId = sp.agId; e.pct = sp.pct; e.docAmt = sp.docAmt; e.cliAmt = sp.cliAmt; }
    if ((p.clinics || []).indexOf(d.cid) < 0) { s.patch('patients', p.id, { clinics: p.clinics.concat([d.cid]) }, ctx); touchPatient(s, p.id); }
    s.insert('ledger', e, ctx);
    var label = { payment: 'دفعة', charge: 'رسوم إضافية', discount: 'خصم', refund: 'استرداد' }[type];
    audit(s, ctx, 'tx.add', label + ' ' + money(d.amt) + ' — ' + p.name + ' — ' + s.get('clinics', d.cid).name + (e.note ? ' — ' + e.note : ''));
    return { id: e.id };
  };

  H['tx.reverse'] = function (s, d, ctx) {
    needDoc(ctx);
    var t = s.get('ledger', d.target); if (!t) fail('الحركة غير موجودة.');
    if (t.type === 'reversal') fail('لا يمكن عكس قيد عكسي. سجّل حركة جديدة بدلاً منه.');
    if (s.list('ledger').some(function (e) { return e.type === 'reversal' && e.reverses === t.id; })) fail('تم عكس هذه الحركة من قبل.');
    var reason = str(d.note, 300); if (reason.length < 3) fail('اكتب سبب التصحيح.');
    needOpen(s, t.cid, ctx.today);
    var e = { id: d.id, date: ctx.today, pid: t.pid, cid: t.cid, type: 'reversal', amt: t.amt, method: t.method, inst: '', reverses: t.id, ref: '', note: reason,
      agId: t.agId, pct: t.pct, docAmt: -(t.docAmt || 0), cliAmt: -(t.cliAmt || 0), by: ctx.user.email, at: ctx.now };
    s.insert('ledger', e, ctx);
    audit(s, ctx, 'tx.reverse', 'عكس حركة ' + money(t.amt) + ' بتاريخ ' + t.date + ' — ' + (s.get('patients', t.pid) || {}).name + ' — السبب: ' + reason, { target: t });
    return { id: e.id };
  };

  H['lab.create'] = function (s, d, ctx) {
    needDoc(ctx); var p = needPatient(s, ctx, d.pid); needClinic(s, ctx, d.cid);
    needAmount(d.cost, 'التكلفة'); needPastOrToday(d.orderedAt, ctx, 'تاريخ الطلب'); needOpen(s, d.cid, d.orderedAt);
    if (d.expectedAt) needDate(d.expectedAt, 'موعد التسليم المتوقع');
    var desc = str(d.desc, 200); if (desc.length < 2) fail('اكتب وصف العمل.');
    var sp = L.splitLab(d.cost, L.agreementAt(s.list('agreements'), d.cid, d.orderedAt));
    var l = { id: d.id, pid: p.id, cid: d.cid, lab: str(d.lab, 80) || 'معمل', desc: desc, orderedAt: d.orderedAt, expectedAt: d.expectedAt || '', deliveredAt: '',
      cost: d.cost, resp: sp.resp, labDoc: sp.labDoc, labCli: sp.labCli, status: 'ordered', notes: str(d.notes, 500) };
    s.insert('labs', l, ctx);
    if (d.paidNow) H['lab.pay'](s, { id: d.id + '-p1', labId: d.id, amt: d.paidNow, date: d.orderedAt }, ctx);
    audit(s, ctx, 'lab.create', 'طلب معمل ' + desc + ' — ' + money(d.cost) + ' — ' + p.name);
    return { id: l.id };
  };
  function labPaid(s, id) { return s.list('labPays').filter(function (x) { return x.labId === id; }).reduce(function (a, x) { return a + x.amt; }, 0); }
  H['lab.update'] = function (s, d, ctx) {
    needDoc(ctx); var l = s.get('labs', d.id); if (!l) fail('طلب المعمل غير موجود.');
    var ch = pick(d.changes || {}, ['deliveredAt', 'expectedAt', 'notes', 'status', 'lab', 'desc']);
    if (ch.status && LAB_STATUS.indexOf(ch.status) < 0) fail('حالة الطلب غير معروفة.');
    if (ch.deliveredAt) { needPastOrToday(ch.deliveredAt, ctx, 'تاريخ التسليم'); if (ch.deliveredAt < l.orderedAt) fail('تاريخ التسليم قبل تاريخ الطلب.'); if (!ch.status) ch.status = 'delivered'; }
    if (ch.status === 'cancelled') { needOpen(s, l.cid, l.orderedAt); if (labPaid(s, l.id) > 0) fail('تم دفع جزء للمعمل. سجّل الاسترداد من المعمل أولاً أو اترك الطلب.'); }
    var m = merge(l, ch, d.base || {}, d.baseVersion);
    if (Object.keys(m.apply).length) s.patch('labs', l.id, m.apply, ctx);
    audit(s, ctx, 'lab.update', 'تعديل طلب معمل ' + l.desc, m.apply);
    return m.conflicts.length ? { conflicts: m.conflicts, table: 'labs', id: l.id } : { id: l.id };
  };
  H['lab.pay'] = function (s, d, ctx) {
    needDoc(ctx); var l = s.get('labs', d.labId); if (!l) fail('طلب المعمل غير موجود.');
    if (l.status === 'cancelled') fail('الطلب ملغي.');
    needAmount(d.amt); needPastOrToday(d.date, ctx, 'تاريخ الدفع');
    if (d.date < l.orderedAt) fail('تاريخ الدفع قبل تاريخ الطلب.');
    var rest = l.cost - labPaid(s, l.id); if (d.amt > rest) fail('المبلغ أكبر من المتبقي للمعمل (' + money(rest) + ').');
    s.insert('labPays', { id: d.id, labId: l.id, cid: l.cid, date: d.date, amt: d.amt, note: str(d.note, 200), by: ctx.user.email, at: ctx.now }, ctx);
    audit(s, ctx, 'lab.pay', 'دفع للمعمل ' + money(d.amt) + ' — ' + l.desc);
    return { id: d.id };
  };

  H['settle.add'] = function (s, d, ctx) {
    needDoc(ctx); var c = needClinic(s, ctx, d.cid);
    needAmount(d.amt); needPastOrToday(d.date, ctx); needOpen(s, d.cid, d.date);
    var o = L.owed(dataOf(s), d.cid, ctx.today);
    if (d.amt > o) fail('المبلغ أكبر من المستحق للطبيب حالياً (' + money(Math.max(0, o)) + ').');
    s.insert('settlements', { id: d.id, cid: d.cid, date: d.date, amt: d.amt, ref: str(d.ref, 60), note: str(d.note, 200), by: ctx.user.email, at: ctx.now }, ctx);
    audit(s, ctx, 'settle.add', 'استلام الطبيب ' + money(d.amt) + ' من ' + c.name);
    return { id: d.id };
  };

  H['month.close'] = function (s, d, ctx) {
    needDoc(ctx); var c = needClinic(s, ctx, d.cid);
    if (!/^\d{4}-\d{2}$/.test(d.month)) fail('الشهر غير صحيح.');
    if (d.month >= L.monthOf(ctx.today)) fail('يمكن إغلاق الشهور السابقة فقط.');
    var id = d.cid + ':' + d.month; if (s.get('closes', id)) fail('هذا الشهر مُغلق بالفعل.');
    s.insert('closes', { id: id, cid: d.cid, month: d.month, by: ctx.user.email, at: ctx.now }, ctx);
    audit(s, ctx, 'month.close', 'إغلاق شهر ' + d.month + ' — ' + c.name);
    return { id: id };
  };

  H['item.save'] = function (s, d, ctx) {
    needDoc(ctx);
    var f = { name: str(d.name, 100), category: str(d.category, 60), unit: str(d.unit, 20) || 'قطعة', min: Math.max(0, Math.floor(+d.min || 0)),
      cid: d.cid && s.get('clinics', d.cid) ? d.cid : '', supplier: str(d.supplier, 80), notes: str(d.notes, 300), active: d.active !== false };
    if (f.name.length < 2) fail('اكتب اسم الصنف.');
    if (d.id && s.get('items', d.id)) s.patch('items', d.id, f, ctx); else { f.id = d.id; s.insert('items', f, ctx); }
    audit(s, ctx, 'item.save', 'صنف مخزون: ' + f.name);
    return { id: d.id };
  };
  function stockOf(s, itemId) { return s.list('moves').filter(function (m) { return m.itemId === itemId; }).reduce(function (a, m) { return a + (m.kind === 'use' ? -m.qty : m.qty); }, 0); }
  H['stock.move'] = function (s, d, ctx) {
    needDoc(ctx); var it = s.get('items', d.itemId); if (!it) fail('الصنف غير موجود.');
    if (['in', 'use', 'adjust'].indexOf(d.kind) < 0) fail('نوع الحركة غير معروف.');
    var qty = +d.qty; if (!(qty === Math.floor(qty) && qty !== 0) || (d.kind !== 'adjust' && qty < 0)) fail('الكمية غير صحيحة.');
    needPastOrToday(d.date, ctx);
    var after = stockOf(s, it.id) + (d.kind === 'use' ? -qty : qty);
    if (after < 0 && !(d.kind === 'adjust' && d.allowNegative)) fail('الكمية المتاحة لا تكفي (المتاح ' + stockOf(s, it.id) + ').');
    var cost = d.kind === 'in' ? Math.max(0, Math.floor(+d.cost || 0)) : 0;
    s.insert('moves', { id: d.id, itemId: it.id, cid: d.cid || it.cid || '', date: d.date, kind: d.kind, qty: qty, cost: cost, supplier: str(d.supplier, 80), note: str(d.note, 200), by: ctx.user.email, at: ctx.now }, ctx);
    audit(s, ctx, 'stock.move', { in: 'إضافة', use: 'استهلاك', adjust: 'تسوية' }[d.kind] + ' ' + qty + ' ' + it.unit + ' — ' + it.name);
    return { id: d.id, stock: after };
  };

  /* ---------- apply ---------- */
  /**
   * op: {opId, type, data}. ctx: {user, today, now}.
   * Returns {status:'ok'|'conflict'|'error', ...}. Same opId twice -> the stored first result (idempotent).
   * Atomic: on error nothing is kept (caller works on a copy or discards the store).
   */
  function apply(store, op, ctx, opts) {
    opts = opts || {};
    if (!op || !op.opId || !H[op.type]) return { status: 'error', error: 'عملية غير معروفة.', code: 'unknown' };
    var seen = store.get('ops', op.opId);
    if (seen) return Object.assign({ replay: true }, seen.result);
    if (!ctx.user || ctx.user.active === false) return { status: 'error', error: 'حسابك غير مفعّل.', code: 'forbidden' };
    var c = { user: ctx.user, today: ctx.today, now: ctx.now, opId: op.opId, local: !!ctx.local }, res;
    var snap = opts.noRollback ? null : backup(store);
    try {
      var r = H[op.type](store, op.data || {}, c) || {};
      res = r.conflicts ? { status: 'conflict', conflicts: r.conflicts, table: r.table, id: r.id } : { status: 'ok', id: r.id, code: r.code, stock: r.stock };
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      if (snap) restore(store, snap);
      res = { status: 'error', error: e.message, code: e.code };
    }
    if (opts.record !== false) store.insert('ops', { id: op.opId, type: op.type, user: ctx.user.email, at: ctx.now, status: res.status, result: res }, c);
    return res;
  }
  // cheap rollback: remember table lengths and the rows we may change
  function backup(store) {
    var b = { len: {}, rows: {}, rev: store.rev, seq: store.patientSeq, dirty: JSON.stringify(store.dirty) };
    TABLES.forEach(function (n) { b.len[n] = store.t[n].length; b.rows[n] = store.t[n].map(function (r) { return Object.assign({}, r); }); });
    return b;
  }
  function restore(store, b) {
    TABLES.forEach(function (n) {
      store.t[n] = b.rows[n]; store.byId[n] = {}; store.t[n].forEach(function (r) { store.byId[n][r.id] = r; });
    });
    store.rev = b.rev; store.patientSeq = b.seq; store.dirty = JSON.parse(b.dirty);
  }

  /* ---------- sync ---------- */
  var DOC_ONLY = ['agreements', 'labs', 'labPays', 'settlements', 'items', 'moves', 'audit'];
  /** Rows changed after sinceRev that this user may see. Assistants never receive money splits. */
  function changesSince(store, user, sinceRev) {
    var out = {}, vis = userClinics(store, user), doc = isDoc(user);
    var pids = {}; store.list('patients').forEach(function (p) { if (doc || (p.clinics || []).some(function (c) { return vis.indexOf(c) >= 0; })) pids[p.id] = true; });
    TABLES.forEach(function (n) {
      if (n === 'ops' || (!doc && DOC_ONLY.indexOf(n) >= 0)) return;
      var rows = store.list(n).filter(function (r) {
        if ((+r.rev || 0) <= sinceRev && sinceRev > 0) return false;
        if (doc) return true;
        switch (n) {
          case 'clinics': return vis.indexOf(r.id) >= 0;
          case 'users': return r.id === user.id;
          case 'patients': return !!pids[r.id];
          case 'plans': case 'planHistory': case 'ledger': return !!pids[r.pid];
          case 'appts': return !!pids[r.pid] && vis.indexOf(r.cid) >= 0;
          case 'closes': return vis.indexOf(r.cid) >= 0;
          default: return false;
        }
      });
      if (!doc && n === 'ledger') rows = rows.map(function (r) { var c = Object.assign({}, r); c.docAmt = 0; c.cliAmt = 0; c.agId = ''; c.pct = 0; return c; });
      if (rows.length) out[n] = rows;
    });
    return { rows: out, rev: store.rev };
  }

  return {
    TABLES: TABLES, SCHEMA: SCHEMA, META: META, METHODS: METHODS, TYPES: TYPES, LAB_RULES: LAB_RULES,
    Store: Store, apply: apply, changesSince: changesSince, merge: merge, overlapping: overlapping,
    isDoc: isDoc, userClinics: userClinics, isClosed: isClosed, dataOf: dataOf, labPaid: labPaid, stockOf: stockOf,
    accountOf: accountOf, money: money, handlers: H
  };
})(typeof Ledger !== 'undefined' ? Ledger : require('./ledger.js'));
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
