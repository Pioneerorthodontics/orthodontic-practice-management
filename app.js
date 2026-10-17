/* Ortho Practice Manager — app screens (Arabic, RTL, mobile first).
 * Reads the device view (server rows + pending ops) from sync.js and sends every change as an op.
 */
(function () {
  'use strict';
  var CFG = window.ORTHO_CONFIG || {}, L = Ledger;
  var sync = new OrthoSync(CFG); window.orthoSync = sync;
  var $ = function (s) { return document.querySelector(s); };

  /* ---------- formatting ---------- */
  var nf = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 });
  var money = function (p) { return nf.format((p || 0) / 100) + ' ج.م'; };
  var N = function (n) { return nf.format(n || 0); };
  var parseD = function (s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
  var dfmt = function (s) { return s ? new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }).format(parseD(s)) : '—'; };
  var dshort = function (s) { return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }).format(parseD(s)); };
  var mname = function (s) { return new Intl.DateTimeFormat('ar-EG', { month: 'long', year: 'numeric' }).format(parseD(s.length === 7 ? s + '-01' : s)); };
  var tfmt = function (iso) { try { return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)); } catch (e) { return iso; } };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var v = function (id) { var e = document.getElementById(id); return e ? String(e.value).trim() : ''; };
  var ck = function (id) { var e = document.getElementById(id); return !!(e && e.checked); };
  var amt = function (id, allowZero) {
    var s = v(id); if (allowZero && s === '') return 0;
    var p = L.toPiasters(s); if (p == null) throw new Error('اكتب المبلغ بالأرقام فقط، مثال: 1500');
    if (!allowZero && p <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر.'); return p;
  };

  var TYPES = Core.TYPES, METHODS = Core.METHODS;
  var AST = { scheduled: 'محجوز', confirmed: 'مؤكد', attended: 'حضر', absent: 'غاب', cancelled: 'ملغي', rescheduled: 'تم التأجيل' };
  var KINDS = ['متابعة شهرية', 'كشف أول', 'تركيب جهاز', 'تسليم أليجنرز', 'طوارئ', 'فك التقويم', 'تسليم مثبّت'];
  var TXT = { payment: 'دفعة', charge: 'رسوم إضافية', discount: 'خصم', refund: 'استرداد للمريض', reversal: 'قيد تصحيح (عكس)' };
  var IST = { paid: 'مدفوع', partial: 'مدفوع جزئياً', 'partial-late': 'جزئي · متأخر', overdue: 'متأخر', due: 'مستحق قريباً', upcoming: 'قادم', paused: 'متوقف' };
  var PST = { active: 'جاري', paused: 'متوقف مؤقتاً', done: 'انتهى العلاج' };
  var LABP = { separate: 'تُسجّل فقط ولا تُخصم', deduct: 'تُخصم قبل التقسيم (٧٠/٣٠)', doctor: 'يتحملها الطبيب', clinic: 'تتحملها العيادة', patient: 'تُحصّل من المريض' };
  var LST = { ordered: 'تم الطلب', in_progress: 'جارٍ التنفيذ', delivered: 'تم التسليم', cancelled: 'ملغي' };
  var OPN = { 'patient.save': 'بيانات مريض', 'plan.update': 'خطة علاج', 'appt.create': 'موعد جديد', 'appt.update': 'تعديل موعد', 'appt.reschedule': 'تأجيل موعد', 'tx.add': 'حركة مالية', 'tx.reverse': 'تصحيح حركة', 'lab.create': 'طلب معمل', 'lab.update': 'تعديل طلب معمل', 'lab.pay': 'دفع للمعمل', 'settle.add': 'دفعة للطبيب', 'month.close': 'إغلاق شهر', 'clinic.save': 'عيادة', 'agreement.add': 'اتفاق', 'user.save': 'مستخدم', 'item.save': 'صنف مخزون', 'stock.move': 'حركة مخزون' };

  /* ---------- state ---------- */
  var ui = { view: 'home', clinic: 'all', period: 'month', from: '', to: '', day: '', cal: 'day', q: '', pst: 'active', instF: 'overdue', labF: 'open', labCancelled: false, locked: false };
  try { var saved = JSON.parse(localStorage.getItem('ortho-ui') || '{}'); ['view', 'clinic', 'period', 'cal', 'pst', 'instF'].forEach(function (k) { if (saved[k]) ui[k] = saved[k]; }); } catch (e) { }
  var saveUi = function () { try { localStorage.setItem('ortho-ui', JSON.stringify({ view: ui.view, clinic: ui.clinic, period: ui.period, cal: ui.cal, pst: ui.pst, instF: ui.instF })); } catch (e) { } };

  var V = function () { return sync.view(); };
  var me = function () { return sync.me(); };
  var isDoc = function () { return Core.isDoc(me()); };
  var today = function () { return sync.today(); };
  var canPay = function () { return isDoc() || !!(me() && me().canPay); };
  var allClinics = function () { return V().list('clinics'); };
  var visC = function () { var ids = Core.userClinics(V(), me() || {}); return allClinics().filter(function (c) { return ids.indexOf(c.id) >= 0 && c.active !== false; }); };
  var cids = function () { var vc = visC(); if (ui.clinic !== 'all' && vc.some(function (c) { return c.id === ui.clinic; })) return [ui.clinic]; return vc.map(function (c) { return c.id; }); };
  var cName = function (id) { var c = V().get('clinics', id); return c ? c.name : '—'; };
  var pat = function (id) { return V().get('patients', id); };
  var plan = function (id) { return V().get('plans', id); };
  var entriesOf = function (pid) { return V().list('ledger').filter(function (e) { return e.pid === pid; }); };
  var acc = function (pid) { var pl = plan(pid); return pl ? L.account(pl, entriesOf(pid), today()) : null; };
  var calc = function (cid, f, t) { return L.clinicCalc(Core.dataOf(V()), cid, f, t); };
  var owed = function (cid) { return L.owed(Core.dataOf(V()), cid, today()); };
  var pending = function (row) { return row && +row.rev > +sync.server.rev; };
  var pendTag = function (row) { return pending(row) ? ' <span class="pend">● في انتظار المزامنة</span>' : ''; };
  var visPts = function () { var ids = cids(); return V().list('patients').filter(function (p) { return (p.clinics || []).some(function (c) { return ids.indexOf(c) >= 0; }); }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ar'); }); };

  /* ---------- sending changes ---------- */
  function OpError(r) { this.message = r.error; this.code = r.code; }
  /** Check locally, then queue. Resolves once the op is safely stored on the device. */
  async function send(type, data) {
    var r = sync.check(type, data);
    if (r.status === 'error') throw new OpError(r);
    await sync.enqueue(type, data);
    return r;
  }
  var savedMsg = function (m) { return (m || 'تم الحفظ') + (navigator.onLine ? '' : ' على الجهاز — سيُرسل عند عودة الإنترنت'); };

  /* ---------- period ---------- */
  function range() {
    var t = today();
    if (ui.period === 'today') return [t, t];
    if (ui.period === 'week') { var w = (parseD(t).getDay() + 1) % 7, f = L.addDays(t, -w); return [f, L.addDays(f, 6)]; }
    if (ui.period === 'month') return [L.monthStart(t), L.monthEnd(t)];
    if (ui.period === 'prev') { var p = L.addMonths(L.monthStart(t), -1, 1); return [p, L.monthEnd(p)]; }
    var a = ui.from || t, b = ui.to || t; return a <= b ? [a, b] : [b, a];
  }
  function periodBar() {
    var P = [['today', 'اليوم'], ['week', 'هذا الأسبوع'], ['month', 'هذا الشهر'], ['prev', 'الشهر السابق'], ['custom', 'فترة مخصصة']], r = range();
    return '<div class="chips" role="group" aria-label="الفترة">' + P.map(function (x) { return '<button class="chip" data-a="period" data-v="' + x[0] + '" aria-pressed="' + (ui.period === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      (ui.period === 'custom' ? '<div class="g2"><label class="f"><span>من</span><input type="date" id="pFrom" data-c="pfrom" value="' + (ui.from || today()) + '"></label><label class="f"><span>إلى</span><input type="date" id="pTo" data-c="pto" value="' + (ui.to || today()) + '"></label></div>' : '') +
      '<small class="muted">الفترة: ' + dfmt(r[0]) + ' — ' + dfmt(r[1]) + ' · ' + (ui.clinic === 'all' ? 'كل العيادات' : cName(ui.clinic)) + '</small>';
  }
  function closedTag(cid, f, t) {
    var m = L.monthOf(f), last = L.monthOf(t), all = true;
    while (m <= last) { if (!Core.isClosed(V(), cid, m + '-01')) { all = false; break; } m = L.monthOf(L.addMonths(m + '-01', 1, 1)); }
    return all ? '<span class="tag t-fin">نهائي — الشهر مُغلق</span>' : '<span class="tag t-est">مفتوح — قد يتغير</span>';
  }
  var pill = function (cls, t) { return '<span class="pill s-' + cls + '">' + t + '</span>'; };

  /* ---------- views ---------- */
  function vHome() {
    var ids = cids(), r = range(), t = today();
    var tAp = V().list('appts').filter(function (a) { return a.date === t && ids.indexOf(a.cid) >= 0; });
    var c = function (s) { return tAp.filter(function (a) { return a.status === s; }).length; };
    var pts = visPts(), od = 0, odN = 0, bal = 0;
    pts.forEach(function (p) { var A = acc(p.id); if (!A) return; if (A.overdue > 0) { od += A.overdue; odN++; } bal += Math.max(0, A.balance); });
    var byId = L.indexById(V().list('ledger'));
    var coll = function (f, to) { var s = 0; V().list('ledger').forEach(function (e) { if (ids.indexOf(e.cid) >= 0 && e.date >= f && e.date <= to) s += L.effect(e, byId).cash; }); return s; };
    var h = '<section class="panel"><div class="ph"><div><div class="eyebrow">اليوم</div><h2>' + dshort(t) + '</h2></div><button class="btn sm" data-a="nav" data-v="appts">فتح مواعيد اليوم</button></div>' +
      '<div class="stats"><div class="stat"><b>' + N(tAp.length) + '</b><span>كل المواعيد</span></div><div class="stat"><b>' + N(c('attended')) + '</b><span>حضر</span></div><div class="stat"><b>' + N(c('absent')) + '</b><span>غاب</span></div><div class="stat"><b>' + N(c('scheduled') + c('confirmed')) + '</b><span>في الانتظار</span></div></div>' +
      '<div class="kgrid"><div class="kpi"><span class="k-l">المحصّل فعلياً اليوم</span><b>' + money(coll(t, t)) + '</b><span class="tag t-cash">نقدية مستلمة</span></div>';
    if (isDoc()) { var e = 0; ids.forEach(function (i) { e += calc(i, t, t).docNet; }); h += '<div class="kpi"><span class="k-l">صافي الطبيب عن اليوم</span><b>' + money(e) + '</b><span class="tag t-est">تقديري</span></div>'; }
    h += '<div class="kpi"><span class="k-l">أقساط متأخرة</span><b>' + money(od) + '</b><button class="tag t-bad" style="border:0;cursor:pointer" data-a="nav" data-v="inst">' + N(odN) + ' مريض — عرض</button></div></div></section>';
    if (!isDoc()) return h;
    var tot = { coll: 0, net: 0, rec: 0, ow: 0 }, per = [], labOut = 0;
    ids.forEach(function (i) { var x = calc(i, r[0], r[1]), o = owed(i); tot.coll += x.coll; tot.net += x.docNet; tot.rec += x.settled; tot.ow += o; per.push({ id: i, r: x, o: o }); });
    V().list('labs').forEach(function (l) { if (ids.indexOf(l.cid) >= 0 && l.status !== 'cancelled') labOut += l.cost - Core.labPaid(V(), l.id); });
    var newP = pts.filter(function (p) { return p.reg >= r[0] && p.reg <= r[1]; }).length;
    var st = { active: 0, done: 0 }; pts.forEach(function (p) { var pl = plan(p.id); if (pl && pl.status === 'done') st.done++; else st.active++; });
    var low = V().list('items').filter(function (it) { return it.active !== false && Core.stockOf(V(), it.id) <= (it.min || 0); }).length;
    h += '<section class="panel"><div class="ph"><h2>الأرقام المالية</h2></div>' + periodBar() + '<div class="kgrid">' +
      '<div class="kpi"><span class="k-l">تحصيل المرضى في الفترة</span><b>' + money(tot.coll) + '</b><span class="tag t-cash">فعلي بعد الاسترداد</span></div>' +
      '<div class="kpi"><span class="k-l">صافي الطبيب في الفترة</span><b>' + money(tot.net) + '</b><span class="tag t-est">محسوب — ليس نقدية</span></div>' +
      '<div class="kpi"><span class="k-l">استلمه الطبيب من العيادات</span><b>' + money(tot.rec) + '</b><span class="tag t-cash">نقدية مستلمة</span></div>' +
      '<div class="kpi"><span class="k-l">باقي للطبيب عند العيادات (حتى اليوم)</span><b>' + money(tot.ow) + '</b><span class="tag t-est">مستحق غير مدفوع</span></div>' +
      '<div class="kpi"><span class="k-l">أرصدة المرضى المتبقية</span><b>' + money(bal) + '</b><span class="tag t-est">لم تُحصّل بعد</span></div>' +
      '<div class="kpi"><span class="k-l">التزامات المعمل غير المدفوعة</span><b>' + money(labOut) + '</b><span class="tag t-bad">مستحق للمعامل</span></div>' +
      '<div class="kpi"><span class="k-l">مرضى جدد في الفترة</span><b>' + N(newP) + '</b><span class="muted"><small>حالات جارية ' + N(st.active) + ' · منتهية ' + N(st.done) + '</small></span></div>' +
      (low ? '<div class="kpi"><span class="k-l">أصناف مخزون منخفضة</span><b>' + N(low) + '</b><button class="tag t-bad" style="border:0;cursor:pointer" data-a="nav" data-v="lab">عرض المخزون</button></div>' : '') +
      '</div></section>';
    var mx = Math.max.apply(null, [1].concat(per.map(function (x) { return x.r.coll; })));
    h += '<section class="panel"><div class="ph"><h2>مقارنة العيادات</h2><div class="legend"><span class="l1">التحصيل</span><span class="l2">صافي الطبيب</span></div></div><div class="bars">' + per.map(function (x) {
      return '<div class="bar-r"><div class="bar-h"><b>' + esc(cName(x.id)) + '</b><span class="num">' + money(x.r.coll) + ' / ' + money(x.r.docNet) + '</span></div><div class="bar b1"><i style="width:' + Math.max(0, x.r.coll / mx * 100) + '%"></i></div><div class="bar b2"><i style="width:' + Math.max(0, x.r.docNet / mx * 100) + '%"></i></div><small class="muted">' + owedText(x.o) + '</small></div>';
    }).join('') + '</div></section>';
    return h;
  }
  var owedText = function (o) { return o >= 0 ? 'باقي للطبيب عند العيادة: <b class="num">' + money(o) + '</b>' : 'العيادة دفعت زيادة: <b class="num">' + money(-o) + '</b> (تُخصم من القادم)'; };

  function vAppts() {
    var ids = cids(), d = ui.day || today();
    var h = '<section class="panel"><div class="ph"><div><div class="eyebrow">المواعيد</div><h2>' + (ui.cal === 'month' ? mname(d) : ui.cal === 'week' ? 'أسبوع ' + dfmt(weekStart(d)) : dshort(d)) + '</h2></div>' +
      '<div class="chips"><button class="chip" data-a="step" data-v="-1" aria-label="السابق">→</button><button class="chip" data-a="day" data-v="' + today() + '" aria-pressed="' + (d === today()) + '">اليوم</button><button class="chip" data-a="step" data-v="1" aria-label="التالي">←</button></div></div>' +
      '<div class="chips" role="group" aria-label="العرض">' + [['day', 'يوم'], ['week', 'أسبوع'], ['month', 'شهر']].map(function (x) { return '<button class="chip" data-a="cal" data-v="' + x[0] + '" aria-pressed="' + (ui.cal === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>';
    if (ui.cal === 'month') return h + monthGrid(ids, d) + '</section>';
    if (ui.cal === 'week') return h + weekList(ids, d) + '</section>';
    var list = V().list('appts').filter(function (a) { return a.date === d && ids.indexOf(a.cid) >= 0; }).sort(function (a, b) { return a.time.localeCompare(b.time); });
    var c = function (s) { return list.filter(function (a) { return a.status === s; }).length; };
    var coll = 0, byId = L.indexById(V().list('ledger')); V().list('ledger').forEach(function (e) { if (e.date === d && ids.indexOf(e.cid) >= 0) coll += L.effect(e, byId).cash; });
    var due = 0, seen = {}; list.forEach(function (a) { if (seen[a.pid]) return; seen[a.pid] = 1; var A = acc(a.pid); if (A) due += A.overdue; });
    h += '<div class="stats"><div class="stat"><b>' + N(c('attended')) + '</b><span>حضر</span></div><div class="stat"><b>' + N(c('scheduled') + c('confirmed')) + '</b><span>في الانتظار</span></div><div class="stat"><b>' + N(c('absent')) + '</b><span>غاب</span></div><div class="stat"><b>' + N(c('cancelled') + c('rescheduled')) + '</b><span>ملغي / مؤجل</span></div></div>' +
      '<div class="kgrid"><div class="kpi"><span class="k-l">المحصّل فعلياً في هذا اليوم</span><b>' + money(coll) + '</b><span class="tag t-cash">فعلي</span></div><div class="kpi"><span class="k-l">متأخرات مرضى هذا اليوم</span><b>' + money(due) + '</b><span class="tag t-est">متوقع — لم يُحصّل</span></div></div>' +
      '<div class="chips"><button class="btn sm" data-a="newAppt" data-d="' + d + '">+ موعد في هذا اليوم</button>' + (d === today() ? '<button class="btn sm ghost" data-a="walkin">+ حالة بدون موعد</button>' : '') + '</div></section><section class="panel"><div class="list">';
    if (!list.length) h += '<p class="muted">لا توجد مواعيد في هذا اليوم. اضغط "+ موعد في هذا اليوم" لإضافة أول موعد.</p>';
    list.forEach(function (a) {
      var p = pat(a.pid) || { name: '؟' }, A = acc(a.pid), open = a.status === 'scheduled' || a.status === 'confirmed';
      var paid = 0; V().list('ledger').forEach(function (e) { if (e.pid === a.pid && e.cid === a.cid && e.date === a.date && e.type === 'payment') paid += e.amt; });
      h += '<div class="ap st-' + a.status + '"><div class="ap-top"><div style="display:flex;gap:10px;min-width:0"><span class="ap-time">' + a.time + '</span><div class="row-m"><button class="ap-name" data-a="openP" data-v="' + a.pid + '">' + esc(p.name) + '</button><small class="muted">' + esc(a.kind) + ' · ' + esc(cName(a.cid)) + ' · ' + N(a.duration) + ' دقيقة' + (a.note ? ' · ' + esc(a.note) : '') + '</small>' +
        (A && A.overdue > 0 ? '<small style="color:var(--bad)">متأخر عليه ' + money(A.overdue) + (A.missed > 1 ? ' (' + N(A.missed) + ' شهور متتالية)' : '') + '</small>' : '') +
        (paid ? '<small style="color:var(--ok)">دفع في الزيارة ' + money(paid) + '</small>' : '') + pendTag(a) + '</div></div>' + pill(a.status, AST[a.status]) + '</div><div class="ap-act">' +
        (open && a.date <= today() ? '<button class="btn sm okb" data-a="att" data-v="' + a.id + '">✓ حضر</button><button class="btn sm badb" data-a="abs" data-v="' + a.id + '">✗ غاب</button>' : '') +
        (open ? '<button class="btn sm ghost" data-a="resch" data-v="' + a.id + '">تأجيل</button>' : '') +
        (a.status === 'attended' && canPay() ? '<button class="btn sm ghost" data-a="pay" data-v="' + a.pid + '" data-c2="' + a.cid + '">تسجيل دفعة</button>' : '') +
        (a.status !== 'cancelled' ? '<button class="btn sm ghost" data-a="next" data-v="' + a.id + '">الموعد القادم</button>' : '') +
        '<select aria-label="تغيير الحالة" data-c="apst" data-id="' + a.id + '" id="st_' + a.id + '"><option value="">تغيير الحالة…</option>' + Object.keys(AST).filter(function (k) { return k !== a.status && k !== 'rescheduled'; }).map(function (k) { return '<option value="' + k + '">' + AST[k] + '</option>'; }).join('') + '</select></div></div>';
    });
    return h + '</div></section>';
  }
  function weekStart(d) { return L.addDays(d, -((parseD(d).getDay() + 1) % 7)); }
  function weekList(ids, d) {
    var s = weekStart(d), h = '<div class="week">';
    for (var i = 0; i < 7; i++) {
      var day = L.addDays(s, i), list = V().list('appts').filter(function (a) { return a.date === day && ids.indexOf(a.cid) >= 0 && a.status !== 'rescheduled'; }).sort(function (a, b) { return a.time.localeCompare(b.time); });
      h += '<div class="wday"><h3><button class="ap-name" data-a="day" data-v="' + day + '" data-cal="day">' + dshort(day) + '</button><span class="chips"><small class="muted">' + N(list.length) + ' موعد</small><button class="btn sm ghost" data-a="newAppt" data-d="' + day + '">+</button></span></h3>' +
        list.map(function (a) { return '<div class="mini"><b class="ap-time" style="min-width:44px">' + a.time + '</b><button class="ap-name" data-a="openP" data-v="' + a.pid + '">' + esc((pat(a.pid) || {}).name) + '</button><small class="muted">' + esc(cName(a.cid)) + '</small>' + pill(a.status, AST[a.status]) + '</div>'; }).join('') + '</div>';
    }
    return h + '</div>';
  }
  function monthGrid(ids, d) {
    var f = L.monthStart(d), last = L.daysIn(+f.slice(0, 4), +f.slice(5, 7)), off = (parseD(f).getDay() + 1) % 7, cnt = {};
    V().list('appts').forEach(function (a) { if (ids.indexOf(a.cid) >= 0 && a.date.slice(0, 7) === f.slice(0, 7) && ['cancelled', 'rescheduled'].indexOf(a.status) < 0) cnt[a.date] = (cnt[a.date] || 0) + 1; });
    var h = '<div class="cal">';
    ['سبت', 'أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة'].forEach(function (w) { h += '<span class="wd">' + w + '</span>'; });
    for (var i = 0; i < off; i++) h += '<span></span>';
    for (var k = 1; k <= last; k++) { var ds = f.slice(0, 8) + L.pad(k); h += '<button data-a="day" data-v="' + ds + '" data-cal="day" aria-pressed="' + (ds === d) + '" class="' + (ds === today() ? 'tod' : '') + '" aria-label="' + dshort(ds) + '">' + N(k) + (cnt[ds] ? '<small>' + N(cnt[ds]) + ' موعد</small>' : '') + '</button>'; }
    return h + '</div><small class="muted">اضغط على أي يوم لفتحه وإضافة المواعيد.</small>';
  }

  function vPatients() {
    return '<section class="panel"><div class="ph"><h2>المرضى</h2><button class="btn sm" data-a="newP">+ مريض جديد</button></div>' +
      '<input type="search" id="pq" data-c="q" placeholder="ابحث بالاسم أو رقم الهاتف أو الكود (مثال: P-0002)" value="' + esc(ui.q) + '" aria-label="بحث عن مريض" style="width:100%">' +
      '<div class="chips" role="group" aria-label="حالة العلاج">' + [['active', 'جاري'], ['paused', 'متوقف'], ['done', 'منتهي'], ['all', 'الكل']].map(function (x) { return '<button class="chip" data-a="pst" data-v="' + x[0] + '" aria-pressed="' + (ui.pst === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="list" id="plist">' + pList() + '</div></section>';
  }
  function pList() {
    var q = L.normalize(ui.q), L2 = visPts().filter(function (p) {
      var pl = plan(p.id) || {}; if (ui.pst !== 'all' && (pl.status || 'active') !== ui.pst) return false;
      return !q || L.normalize(p.name).indexOf(q) >= 0 || (p.phone || '').indexOf(q) >= 0 || (p.phone2 || '').indexOf(q) >= 0 || L.normalize(p.code).indexOf(q) >= 0;
    });
    if (!L2.length) return '<p class="muted">لا يوجد مريض بهذا البحث.</p>';
    return L2.slice(0, 200).map(function (p) {
      var A = acc(p.id) || { balance: 0, overdue: 0 };
      return '<button class="row" data-a="openP" data-v="' + p.id + '"><div class="row-m"><b>' + esc(p.name) + pendTag(p) + '</b><small>' + esc(p.code) + ' · <span dir="ltr">' + esc(p.phone) + '</span> · ' + (p.clinics || []).map(cName).map(esc).join('، ') + '</small><small>' + TYPES[p.type] + ' · ' + PST[(plan(p.id) || {}).status || 'active'] + '</small></div><div class="row-e"><span class="num">' + money(A.balance) + '</span><small class="muted">' + (A.balance < 0 ? 'رصيد للمريض' : 'متبقي') + '</small>' + (A.overdue > 0 ? pill('overdue', 'متأخر ' + money(A.overdue)) : '') + '</div></button>';
    }).join('');
  }

  function vInst() {
    var r = range(), rows = [], ids = cids();
    visPts().forEach(function (p) { var A = acc(p.id); if (A) A.items.forEach(function (it) { rows.push({ p: p, A: A, it: it }); }); });
    var R = rows;
    if (ui.instF === 'overdue') R = rows.filter(function (x) { return x.it.late; });
    else if (ui.instF === 'week') R = rows.filter(function (x) { return x.it.cover < x.it.amt && x.it.due >= today() && x.it.due <= L.addDays(today(), 7); });
    else if (ui.instF === 'month') R = rows.filter(function (x) { return x.it.due.slice(0, 7) === today().slice(0, 7); });
    R.sort(function (a, b) { return a.it.due.localeCompare(b.it.due); });
    var byId = L.indexById(V().list('ledger'));
    var txs = V().list('ledger').filter(function (x) { return ids.indexOf(x.cid) >= 0 && x.date >= r[0] && x.date <= r[1]; }).sort(function (a, b) { return b.date.localeCompare(a.date) || String(b.at).localeCompare(String(a.at)); });
    return '<section class="panel"><div class="ph"><h2>الأقساط</h2>' + (canPay() ? '<button class="btn sm" data-a="pay">+ تسجيل دفعة</button>' : '') + '</div>' +
      '<div class="chips">' + [['overdue', 'المتأخرة'], ['week', 'مستحقة خلال ٧ أيام'], ['month', 'أقساط هذا الشهر'], ['all', 'الكل']].map(function (x) { return '<button class="chip" data-a="instF" data-v="' + x[0] + '" aria-pressed="' + (ui.instF === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<p class="note">القسط يصبح "مدفوع" فقط عندما تغطيه دفعات حقيقية بالكامل. الأقساط المتوقعة لا تُحسب إيراداً.</p>' +
      '<div class="tw"><table><thead><tr><th>المريض</th><th>القسط</th><th>الاستحقاق</th><th>المبلغ</th><th>المدفوع</th><th>الحالة</th><th></th></tr></thead><tbody>' +
      (R.length ? R.slice(0, 400).map(function (x) {
        return '<tr><td><button class="ap-name" data-a="openP" data-v="' + x.p.id + '">' + esc(x.p.name) + '</button>' + (x.it.late && x.A.missed > 1 ? '<br><small style="color:var(--bad)">' + N(x.A.missed) + ' شهور متتالية</small>' : '') + '</td><td>' + esc(x.it.label) + '</td><td>' + dfmt(x.it.due) + '</td><td>' + money(x.it.amt) + '</td><td>' + money(x.it.cover) + '</td><td>' + pill(x.it.st.replace('partial-late', 'overdue'), IST[x.it.st]) + '</td><td>' + (canPay() && x.it.cover < x.it.amt ? '<button class="btn sm ghost" data-a="pay" data-v="' + x.p.id + '" data-i="' + x.it.key + '">دفع</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="muted">لا توجد أقساط في هذا الاختيار.</td></tr>') + '</tbody></table></div></section>' +
      '<section class="panel"><div class="ph"><h2>سجل الحركات المالية</h2></div>' + periodBar() +
      '<div class="tw"><table><thead><tr><th>التاريخ</th><th>المريض</th><th>العيادة</th><th>النوع</th><th>الطريقة</th><th>المبلغ</th><th>سجّلها</th></tr></thead><tbody>' +
      (txs.length ? txs.map(function (x) { var e = L.effect(x, byId), neg = e.cash < 0 || e.charge < 0 || e.discount < 0; return '<tr><td>' + dfmt(x.date) + '</td><td>' + esc((pat(x.pid) || {}).name) + '</td><td>' + esc(cName(x.cid)) + '</td><td>' + TXT[x.type] + pendTag(x) + '</td><td>' + (METHODS[x.method] || '—') + '</td><td style="color:' + (neg ? 'var(--bad)' : 'inherit') + '">' + (neg ? '−' : '') + money(x.amt) + '</td><td>' + esc(x.by) + '</td></tr>'; }).join('') : '<tr><td colspan="7" class="muted">لا توجد حركات في هذه الفترة.</td></tr>') +
      '</tbody></table></div></section>';
  }

  function vLab() {
    var ids = cids(), all = V().list('labs').filter(function (l) { return ids.indexOf(l.cid) >= 0; }), cost = 0, paid = 0;
    all.forEach(function (l) { if (l.status !== 'cancelled') { cost += l.cost; paid += Core.labPaid(V(), l.id); } });
    var shown = all.filter(function (l) { return (ui.labCancelled || l.status !== 'cancelled') && (ui.labF !== 'open' || Core.labPaid(V(), l.id) < l.cost); }).sort(function (a, b) { return b.orderedAt.localeCompare(a.orderedAt); });
    var card = function (l) {
      var pd = Core.labPaid(V(), l.id), late = l.status !== 'delivered' && l.expectedAt && l.expectedAt < today();
      return '<div class="ap"><div class="ap-top"><div class="row-m"><b>' + esc(l.desc) + pendTag(l) + '</b><small class="muted">' + esc((pat(l.pid) || {}).name) + ' · ' + esc(cName(l.cid)) + ' · ' + esc(l.lab) + '</small><small>طُلب ' + dfmt(l.orderedAt) + (l.expectedAt ? ' · متوقع ' + dfmt(l.expectedAt) : '') + (l.deliveredAt ? ' · سُلِّم ' + dfmt(l.deliveredAt) : '') + (late ? ' <b style="color:var(--bad)">· متأخر</b>' : '') + '</small><small>التكلفة: ' + LABP[l.resp] + '</small></div>' +
        (l.status === 'cancelled' ? pill('cancelled', 'ملغي') : pd >= l.cost ? pill('paid', 'مسدد') : pill('overdue', 'متبقي ' + money(l.cost - pd))) + '</div><div class="ap-act"><span class="num">التكلفة ' + money(l.cost) + ' · المدفوع ' + money(pd) + '</span>' +
        (l.status !== 'cancelled' && pd < l.cost ? '<button class="btn sm ghost" data-a="labPay" data-v="' + l.id + '">دفع للمعمل</button>' : '') +
        (l.status !== 'delivered' && l.status !== 'cancelled' ? '<button class="btn sm okb" data-a="labDeliver" data-v="' + l.id + '">تم التسليم</button>' : '') +
        (l.status !== 'cancelled' && pd === 0 ? '<button class="btn sm badb" data-a="labCancel" data-v="' + l.id + '">إلغاء</button>' : '') + '</div></div>';
    };
    var ord = shown.filter(function (l) { return l.status === 'ordered' || l.status === 'in_progress'; }), del = shown.filter(function (l) { return l.status === 'delivered'; }), can = shown.filter(function (l) { return l.status === 'cancelled'; });
    var h = '<section class="panel"><div class="ph"><h2>المعمل</h2><button class="btn sm" data-a="newLab">+ طلب معمل</button></div>' +
      '<div class="kgrid"><div class="kpi"><span class="k-l">تكلفة الطلبات</span><b>' + money(cost) + '</b></div><div class="kpi"><span class="k-l">المدفوع للمعامل</span><b>' + money(paid) + '</b><span class="tag t-cash">فعلي</span></div><div class="kpi"><span class="k-l">المتبقي للمعامل</span><b>' + money(cost - paid) + '</b><span class="tag t-bad">التزام</span></div></div>' +
      '<div class="chips"><button class="chip" data-a="labF" data-v="open" aria-pressed="' + (ui.labF === 'open') + '">غير مسددة</button><button class="chip" data-a="labF" data-v="all" aria-pressed="' + (ui.labF === 'all') + '">كل الطلبات</button><button class="chip" data-a="labCan" aria-pressed="' + ui.labCancelled + '">عرض الملغي</button></div>' +
      '<p class="note">تُحسب تكلفة المعمل في تاريخ الطلب، حسب اتفاق العيادة في ذلك التاريخ، ولا تُخصم مرتين.</p>' +
      '<h3 class="grp">تم الطلب — لم يُسلَّم بعد (' + N(ord.length) + ')</h3><div class="list">' + (ord.map(card).join('') || '<p class="muted">لا توجد طلبات منتظرة.</p>') + '</div>' +
      '<h3 class="grp">تم التسليم (' + N(del.length) + ')</h3><div class="list">' + (del.map(card).join('') || '<p class="muted">لا توجد طلبات مُسلَّمة.</p>') + '</div>' +
      (ui.labCancelled ? '<h3 class="grp">ملغي (' + N(can.length) + ')</h3><div class="list">' + can.map(card).join('') + '</div>' : '') + '</section>';
    var items = V().list('items').filter(function (i) { return i.active !== false; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ar'); });
    h += '<section class="panel"><div class="ph"><h2>المواد والمخزون</h2><button class="btn sm ghost" data-a="newItem">+ صنف</button></div>' +
      (items.length ? '<div class="tw"><table><thead><tr><th>الصنف</th><th>الفئة</th><th>المتاح</th><th>الحد الأدنى</th><th></th></tr></thead><tbody>' + items.map(function (i) {
        var q = Core.stockOf(V(), i.id); return '<tr><td>' + esc(i.name) + '</td><td>' + esc(i.category) + '</td><td>' + N(q) + ' ' + esc(i.unit) + (q <= i.min ? ' ' + pill('overdue', 'منخفض') : '') + '</td><td>' + N(i.min) + '</td><td><button class="btn sm ghost" data-a="move" data-v="' + i.id + '">حركة</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted">لا توجد أصناف بعد. أضف أول صنف لمتابعة المخزون.</p>') +
      '<p class="note">الكمية = مجموع الحركات (إضافة، استهلاك، تسوية). شراء المواد يُسجّل هنا فقط ولا يُخصم من حساب الطبيب أو العيادة.</p></section>';
    return h;
  }

  function vAccounts() {
    var ids = cids(), r = range();
    var h = '<section class="panel"><div class="ph"><h2>حسابات العيادات</h2><button class="btn sm ghost" data-a="newClinic">+ إضافة عيادة</button></div>' + periodBar() + '</section>';
    ids.forEach(function (id) {
      var c = V().get('clinics', id), x = calc(id, r[0], r[1]), o = owed(id), cur = L.agreementAt(V().list('agreements'), id, today());
      var hist = V().list('agreements').filter(function (a) { return a.cid === id; }).sort(function (a, b) { return b.from.localeCompare(a.from); });
      var sets = V().list('settlements').filter(function (s) { return s.cid === id; }).sort(function (a, b) { return b.date.localeCompare(a.date); });
      var closes = V().list('closes').filter(function (s) { return s.cid === id; }).sort(function (a, b) { return b.month.localeCompare(a.month); });
      h += '<section class="panel"><div class="ph"><div><h3>' + esc(c.name) + '</h3><small class="muted">' + esc(c.days || '') + (c.phone ? ' · <span dir="ltr">' + esc(c.phone) + '</span>' : '') + '</small></div>' + closedTag(id, r[0], r[1]) + '</div>' +
        '<p class="note">الاتفاق الحالي: ' + agText(cur) + '</p><div class="tw"><table class="calc"><tbody>' +
        '<tr><td>دفعات المرضى</td><td>' + money(x.payments) + '</td></tr><tr class="sub"><td>− استرداد وتصحيحات</td><td>' + money(x.refunds) + '</td></tr>' +
        '<tr class="sum"><td>= التحصيل الفعلي</td><td>' + money(x.coll) + '</td></tr>' +
        Object.keys(x.byAgreement).map(function (k) { var g = x.byAgreement[k]; return '<tr class="sub"><td>منها بنسبة ' + N(g.pct) + '٪ للطبيب: تحصيل ' + money(g.coll) + '</td><td>' + money(g.doc) + '</td></tr>'; }).join('') +
        '<tr><td>نصيب الطبيب من التحصيل</td><td>' + money(x.docFromColl) + '</td></tr>' + (x.fees ? '<tr><td>+ رسوم الزيارات الثابتة (' + N(x.visits) + ')</td><td>' + money(x.fees) + '</td></tr>' : '') +
        '<tr class="sum"><td>= إجمالي الطبيب</td><td>' + money(x.docGross) + '</td></tr><tr><td>− نصيب الطبيب من المعمل</td><td>' + money(x.labDoc) + '</td></tr>' +
        '<tr class="sum"><td>= صافي الطبيب</td><td>' + money(x.docNet) + '</td></tr>' +
        '<tr><td>نصيب العيادة قبل المعمل</td><td>' + money(x.cliGross) + '</td></tr><tr><td>− نصيب العيادة من المعمل</td><td>' + money(x.labCli) + '</td></tr>' +
        '<tr class="sum"><td>= صافي العيادة</td><td>' + money(x.cliNet) + '</td></tr>' +
        '<tr class="sub"><td>تكلفة طلبات المعمل في الفترة (بتاريخ الطلب)</td><td>' + money(x.labCost) + '</td></tr><tr><td>دفعته العيادة للطبيب في الفترة</td><td>' + money(x.settled) + '</td></tr>' +
        '</tbody></table></div><div class="ph"><div><div class="eyebrow">حتى اليوم</div><b style="font-family:var(--f-display);font-size:1.15rem;color:' + (o > 0 ? 'var(--warn)' : 'var(--ok)') + '">' + owedText(o) + '</b></div>' +
        '<div class="chips"><button class="btn sm" data-a="settle" data-v="' + id + '">تسجيل دفعة للطبيب</button><button class="btn sm ghost" data-a="closeMonth" data-v="' + id + '">إغلاق شهر</button><button class="btn sm ghost" data-a="agree" data-v="' + id + '">تعديل الاتفاق</button><button class="btn sm ghost" data-a="editClinic" data-v="' + id + '">بيانات العيادة</button></div></div>' +
        '<details><summary>سجل الاتفاقات (' + N(hist.length) + ')</summary><div class="list" style="margin-top:8px">' + hist.map(function (a) { return '<div class="row" style="cursor:default"><div class="row-m"><b>' + agText(a) + '</b><small class="muted">من ' + dfmt(a.from) + (a.to ? ' إلى ' + dfmt(a.to) : ' — ساري حتى الآن') + '</small></div></div>'; }).join('') + '</div></details>' +
        '<details><summary>دفعات العيادة للطبيب (' + N(sets.length) + ')</summary><div class="tw" style="margin-top:8px"><table><thead><tr><th>التاريخ</th><th>المبلغ</th><th>مرجع</th><th>ملاحظة</th></tr></thead><tbody>' + (sets.map(function (s) { return '<tr><td>' + dfmt(s.date) + '</td><td>' + money(s.amt) + pendTag(s) + '</td><td>' + esc(s.ref) + '</td><td>' + esc(s.note) + '</td></tr>'; }).join('') || '<tr><td colspan="4" class="muted">لا توجد دفعات.</td></tr>') + '</tbody></table></div></details>' +
        '<details><summary>الشهور المغلقة (' + N(closes.length) + ')</summary><p class="muted">' + (closes.map(function (x) { return mname(x.month); }).join('، ') || 'لا يوجد') + '</p></details></section>';
    });
    h += '<section class="panel"><h2>التقارير</h2><p class="muted" style="margin:0">كل تقرير يستخدم العيادة والفترة المختارة. يمكن تنزيله كملف CSV يفتح في Excel، أو طباعته.</p><div class="chips">' +
      [['appts', 'المواعيد والحضور'], ['payments', 'التحصيلات'], ['balances', 'أرصدة المرضى'], ['overdue', 'الأقساط المتأخرة'], ['labs', 'المعمل'], ['clinics', 'حسابات العيادات'], ['settlements', 'دفعات الطبيب'], ['monthly', 'مقارنة شهرية'], ['inventory', 'المخزون']].map(function (x) { return '<button class="btn sm ghost" data-a="report" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div></section>';
    return h;
  }
  function agText(a) {
    if (!a) return 'لا يوجد اتفاق';
    var t = a.method === 'pct' ? N(a.pct) + '٪ للطبيب و ' + N(100 - a.pct) + '٪ للعيادة' : a.method === 'fixed' ? money(a.fee) + ' للطبيب لكل زيارة' : money(a.fee) + ' لكل زيارة + ' + N(a.pct) + '٪';
    return t + ' · المعمل: ' + LABP[a.lab];
  }

  function vSettings() {
    var users = V().list('users');
    var syncPart = '<section class="panel"><div class="ph"><h2>المزامنة</h2><button class="btn sm" data-a="syncNow">مزامنة الآن</button></div>' + syncDetails() + '</section>';
    var devicePart = '<section class="panel"><h2>هذا الجهاز</h2><div class="chips"><button class="btn sm ghost" data-a="theme">المظهر: ' + ({ '': 'تلقائي', light: 'فاتح', dark: 'داكن' }[themeNow()]) + '</button><button class="btn sm ghost" data-a="pin">' + (pinSet ? 'تغيير / إلغاء رمز القفل' : 'تعيين رمز قفل') + '</button>' + (pinSet ? '<button class="btn sm ghost" data-a="lock">قفل الآن</button>' : '') + '<button class="btn sm badb" data-a="signout">تسجيل الخروج ومسح البيانات من هذا الجهاز</button></div></section>';
    if (!isDoc()) return syncPart + devicePart;
    return syncPart +
      '<section class="panel"><div class="ph"><h2>المستخدمون والصلاحيات</h2><button class="btn sm" data-a="editUser">+ مستخدم</button></div><div class="tw"><table><thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>العيادات</th><th>الدفعات</th><th>نشط</th><th></th></tr></thead><tbody>' +
      users.map(function (u) { return '<tr><td>' + esc(u.name) + '</td><td dir="ltr">' + esc(u.email) + '</td><td>' + (u.role === 'doctor' ? 'طبيب' : 'مساعد') + '</td><td style="white-space:normal">' + (u.role === 'doctor' ? 'كل العيادات' : (u.clinics || []).map(cName).map(esc).join('، ')) + '</td><td>' + (u.canPay ? '✓' : '—') + '</td><td>' + (u.active !== false ? '✓' : '—') + '</td><td><button class="btn sm ghost" data-a="editUser" data-v="' + u.id + '">تعديل</button></td></tr>'; }).join('') +
      '</tbody></table></div><p class="note">كل مساعد يدخل بحساب Gmail الخاص به، ويرى عياداته فقط. لا يرى النسب ولا المعمل ولا حسابات العيادات.</p></section>' +
      '<section class="panel"><div class="ph"><h2>العيادات</h2><button class="btn sm ghost" data-a="newClinic">+ عيادة</button></div><div class="list">' + allClinics().map(function (c) { return '<div class="row" style="cursor:default"><div class="row-m"><b>' + esc(c.name) + (c.active === false ? ' (غير نشطة)' : '') + '</b><small class="muted">' + esc([c.address, c.days, c.hours].filter(Boolean).join(' · ')) + ' · مدة الموعد ' + N(c.slot || 20) + ' دقيقة</small></div><button class="btn sm ghost" data-a="editClinic" data-v="' + c.id + '">تعديل</button></div>'; }).join('') + '</div></section>' +
      '<section class="panel"><div class="ph"><h2>النسخ الاحتياطي</h2></div><p class="muted" style="margin:0">نسخة من قاعدة البيانات كل ساعة في Google Drive، ونسخة Excel كل يوم، وفحص تلقائي كل ليلة.</p><div class="chips"><button class="btn sm ghost" data-a="backups">عرض النسخ</button><button class="btn sm ghost" data-a="backupNow">نسخة الآن</button><button class="btn sm ghost" data-a="exportNow">ملف Excel الآن</button></div><div id="bkList"></div></section>' +
      devicePart +
      '<section class="panel"><h2>سجل العمليات</h2><div class="tw"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th></tr></thead><tbody>' +
      V().list('audit').slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 80).map(function (a) { return '<tr><td>' + tfmt(a.at) + '</td><td dir="ltr">' + esc(a.user) + '</td><td style="white-space:normal">' + esc(a.summary) + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
  }
  function syncDetails() {
    var h = '<dl class="info"><div><dt>الحالة</dt><dd>' + statusText() + '</dd></div><div><dt>آخر مزامنة أكّدها الخادم</dt><dd>' + (sync.lastOk ? tfmt(sync.lastOk) : 'لم تتم بعد') + '</dd></div><div><dt>في انتظار الإرسال</dt><dd>' + N(sync.outbox.length) + '</dd></div><div><dt>الحساب</dt><dd dir="ltr">' + esc((me() || {}).email || '') + '</dd></div></dl>';
    if (sync.lastError) h += '<p class="err">' + esc(sync.lastError) + '</p>';
    if (sync.conflicts.length) h += '<h3>تعارضات تحتاج قرارك (' + N(sync.conflicts.length) + ')</h3><p class="note">عدّل شخصان نفس البيانات من جهازين. لم يُحفظ تعديلك لهذه الحقول بعد. اختر القيمة الصحيحة.</p>' + sync.conflicts.map(function (c, i) {
      var r = c.result; return '<div class="ap"><b>' + (OPN[c.op.type] || c.op.type) + '</b><div class="cflt">' + (r.conflicts || []).map(function (f) { return '<span class="muted">' + esc(f.field) + '</span><span>قيمتك: <b>' + esc(show(f.mine)) + '</b> · على الخادم: <b>' + esc(show(f.theirs)) + '</b></span>'; }).join('') + '</div><div class="chips"><button class="btn sm" data-a="cfMine" data-v="' + i + '">استخدم قيمتي</button><button class="btn sm ghost" data-a="cfTheirs" data-v="' + i + '">احتفظ بقيمة الخادم</button></div></div>';
    }).join('');
    if (sync.failed.length) h += '<h3>عمليات رفضها الخادم (' + N(sync.failed.length) + ')</h3><p class="note">هذه العمليات لم تُحفظ. اقرأ السبب ثم سجّلها مرة أخرى بشكل صحيح إذا لزم.</p>' + sync.failed.map(function (f, i) {
      return '<div class="ap"><b>' + (OPN[f.op.type] || f.op.type) + '</b><small class="muted">' + tfmt(f.op.at) + '</small><p class="err">' + esc(f.error) + '</p><div class="chips"><button class="btn sm ghost" data-a="dropFail" data-v="' + i + '">حذف من القائمة</button></div></div>';
    }).join('');
    if (sync.outbox.length) h += '<details><summary>العمليات المنتظرة</summary><div class="list">' + sync.outbox.map(function (o) { return '<div class="row" style="cursor:default"><span>' + (OPN[o.type] || o.type) + '</span><small class="muted">' + tfmt(o.at) + '</small></div>'; }).join('') + '</div></details>';
    return h;
  }
  var show = function (x) { return Array.isArray(x) ? x.map(cName).join('، ') : typeof x === 'number' ? N(x) : String(x == null ? '' : x); };

  /* ---------- shell ---------- */
  var ICONS = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    appts: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    patients: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
    inst: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M15 15h3"/>',
    lab: '<path d="M9 3h6M10 3v6L5 19a1 1 0 0 0 .9 1.5h12.2A1 1 0 0 0 19 19l-5-10V3"/><path d="M7.5 14h9"/>',
    accounts: '<path d="M4 20V11M10 20V5M16 20v-6M2 20h20"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'
  };
  function statusText() {
    return { synced: 'تمت المزامنة', syncing: 'جارٍ المزامنة…', pending: N(sync.outbox.length) + ' في انتظار الإرسال', offline: 'بدون إنترنت' + (sync.outbox.length ? ' · ' + N(sync.outbox.length) + ' في الانتظار' : ''), conflict: 'يوجد تعارض', error: 'فشلت المزامنة', signin: 'سجّل الدخول للمزامنة', forbidden: 'الحساب غير مسموح', idle: 'لم تتم المزامنة بعد' }[sync.status] || sync.status;
  }
  function tabs() {
    var T = [['home', 'الرئيسية'], ['appts', 'المواعيد'], ['patients', 'المرضى'], ['inst', 'الأقساط']];
    if (isDoc()) T.push(['lab', 'المعمل'], ['accounts', 'الحسابات'], ['settings', 'الإعدادات']); else T.push(['settings', 'الإعدادات']);
    return '<nav class="tabs" aria-label="الأقسام"><div class="in">' + T.map(function (x) { return '<button data-a="nav" data-v="' + x[0] + '"' + (ui.view === x[0] ? ' aria-current="page"' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[x[0]] + '</svg>' + x[1] + '</button>'; }).join('') + '</div></nav>';
  }
  function banners() {
    var b = '';
    if (!navigator.onLine) b += '<div class="banner bad">لا يوجد إنترنت. التعديلات تُحفظ على الجهاز وتُرسل تلقائياً عند عودة الاتصال.' + (sync.outbox.length ? ' (' + N(sync.outbox.length) + ' في الانتظار)' : '') + '</div>';
    if (sync.status === 'signin') b += '<div class="banner warn"><span>انتهت جلسة الدخول. سجّل الدخول لإرسال التعديلات.</span><span id="gsiBanner"></span>' + (CFG.DEV ? '<button class="btn sm" data-a="devLogin">دخول</button>' : '') + '</div>';
    if (sync.conflicts.length) b += '<div class="banner warn"><span>يوجد ' + N(sync.conflicts.length) + ' تعارض يحتاج قرارك.</span><button class="btn sm" data-a="nav" data-v="settings">عرض</button></div>';
    if (sync.failed.length) b += '<div class="banner bad"><span>رفض الخادم ' + N(sync.failed.length) + ' عملية. لم تُحفظ.</span><button class="btn sm" data-a="nav" data-v="settings">التفاصيل</button></div>';
    if (sync.lastError && navigator.onLine) b += '<div class="banner bad">' + esc(sync.lastError) + '</div>';
    return b;
  }
  function render() {
    var root = $('#root');
    if (ui.locked) { root.innerHTML = lockScreen(); return; }
    if (!me()) { root.innerHTML = loginScreen(); renderGsi('gsiBtn'); return; }
    if (!isDoc() && ['lab', 'accounts'].indexOf(ui.view) >= 0) ui.view = 'home';
    if (ui.clinic !== 'all' && !visC().some(function (c) { return c.id === ui.clinic; })) ui.clinic = 'all';
    var Vw = { home: vHome, appts: vAppts, patients: vPatients, inst: vInst, lab: vLab, accounts: vAccounts, settings: vSettings };
    var act = document.activeElement, keep = act && act.id && root.contains(act) ? { id: act.id, s: act.selectionStart, e: act.selectionEnd } : null;
    var y = window.scrollY;
    root.innerHTML = '<header class="top"><div class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M7 3C4.5 3 3 5 3 8c0 3 1.5 4 2 7s1 6 2.5 6S9 17 10 15c.5-1 1.5-1 2 0 1 2 1 6 2.5 6S16.5 18 17 15s2-4 2-7c0-3-1.5-5-4-5-2 0-3 1-4 1S9 3 7 3z"/><path d="M6 9h12" stroke-dasharray="2 2"/></svg><div><b>مدير عيادات التقويم</b><small>' + esc(me().name) + ' · ' + (isDoc() ? 'طبيب' : 'مساعد') + '</small></div></div>' +
      '<div class="hsel"><select id="hClinic" data-c="clinic" aria-label="العيادة">' + (visC().length > 1 ? '<option value="all">كل العيادات</option>' : '') + visC().map(function (c) { return '<option value="' + c.id + '"' + (ui.clinic === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select>' +
      '<button class="sync ' + sync.status + '" data-a="syncNow" title="اضغط للمزامنة الآن"><i></i><span>' + statusText() + '</span></button></div></header>' +
      banners() + '<main>' + (visC().length || isDoc() ? Vw[ui.view]() : '<section class="panel"><p>لا توجد عيادات مسموح لك بها بعد. اطلب من الطبيب إضافتك إلى عيادة.</p></section>') + '</main>' + tabs();
    if (keep) { var el = document.getElementById(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) { } } }
    window.scrollTo(0, y);
    renderGsi('gsiBanner');
  }
  function loginScreen() {
    var waiting = sync.hasToken();
    return '<div class="login"><section class="panel"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="var(--accent)" stroke-width="1.4" aria-hidden="true"><path d="M7 3C4.5 3 3 5 3 8c0 3 1.5 4 2 7s1 6 2.5 6S9 17 10 15c.5-1 1.5-1 2 0 1 2 1 6 2.5 6S16.5 18 17 15s2-4 2-7c0-3-1.5-5-4-5-2 0-3 1-4 1S9 3 7 3z"/></svg><h1>مدير عيادات التقويم</h1>' +
      (waiting ? '<p>' + (navigator.onLine ? 'جارٍ تحميل البيانات من الخادم…' : 'لا يوجد إنترنت. أول دخول يحتاج اتصالاً.') + '</p>' + (sync.lastError ? '<p class="err">' + esc(sync.lastError) + '</p>' : '') + (sync.status === 'forbidden' || sync.status === 'error' ? '<button class="btn ghost" data-a="signout">دخول بحساب آخر</button>' : '')
        : '<p class="muted">سجّل الدخول بحساب Google المسموح له من الطبيب.</p>' + (CFG.DEV ? '<label class="f"><span>البريد (وضع التجربة)</span><input id="devEmail" dir="ltr" value="doctor@gmail.com"></label><button class="btn" data-a="devLogin">دخول</button>' : '<div id="gsiBtn"></div>') +
        (sync.lastError ? '<p class="err">' + esc(sync.lastError) + '</p>' : '')) + '</section></div>';
  }
  function lockScreen() {
    return '<div class="login"><section class="panel"><h1>التطبيق مقفل</h1><form id="unlockF" style="display:grid;gap:10px;width:100%"><label class="f"><span>رمز القفل</span><input id="pinIn" type="password" inputmode="numeric" autocomplete="off" dir="ltr"></label><button class="btn" type="submit">فتح</button><p class="err" id="pinErr" hidden></p></form><button class="btn sm ghost" data-a="signout">نسيت الرمز؟ خروج ومسح البيانات من هذا الجهاز</button></section></div>';
  }
  function renderGsi(id) {
    var el = document.getElementById(id);
    if (!el || CFG.DEV || !window.google || !google.accounts || el.childElementCount) return;
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ar' });
  }
  window.orthoGsiReady = function () {
    if (CFG.DEV || !window.google) return;
    google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: function (r) { sync.setToken(r.credential); }, auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
    if (me() && !sync.hasToken()) google.accounts.id.prompt();
    render();
  };
  function toast(m, k) { var t = $('#toast'); t.innerHTML = '<div class="' + (k || '') + '">' + esc(m) + '</div>'; clearTimeout(toast.h); toast.h = setTimeout(function () { t.innerHTML = ''; }, 3200); }

  /* ---------- sheets (forms) ---------- */
  var SUB = null, BUSY = false, SUBL = 'حفظ';
  function sheet(title, body, onSubmit, label, again) {
    SUB = onSubmit; BUSY = false; SUBL = label || 'حفظ';
    $('#sheet').innerHTML = '<div class="sh-back" data-a="close"></div><div class="sh" role="dialog" aria-modal="true" aria-labelledby="shT"><div class="sh-h"><h2 id="shT">' + title + '</h2><button type="button" class="icon" data-a="close" aria-label="إغلاق">✕</button></div>' +
      '<form id="shF" novalidate><div class="sh-b">' + body + '<p class="err" id="shErr" hidden></p></div>' + (onSubmit ? '<div class="sh-f"><button type="button" class="btn ghost" data-a="close">إلغاء</button>' + (again ? '<button type="submit" class="btn ghost" name="again" value="1">' + again + '</button>' : '') + '<button type="submit" class="btn" id="shOk">' + SUBL + '</button></div>' : '') + '</form></div>';
    $('#sheet').hidden = false; document.body.style.overflow = 'hidden';
    var first = $('#sheet').querySelector('input:not([type=hidden]),select,textarea'); if (first && window.innerWidth > 700) first.focus();
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; document.body.style.overflow = ''; SUB = null; }
  var fld = function (l, inner, hint) { return '<label class="f"><span>' + l + '</span>' + inner + (hint ? '<small>' + hint + '</small>' : '') + '</label>'; };
  var opts = function (o, sel) { return Object.keys(o).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(o[k]) + '</option>'; }).join(''); };
  var clinicOpts = function (sel) { return visC().map(function (c) { return '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join(''); };
  var defClinic = function () { return ui.clinic !== 'all' ? ui.clinic : (visC()[0] || {}).id; };

  /* patient picker: search by name, phone or code, then tap */
  function picker(id, sel) {
    return '<div class="f"><span>المريض</span><input type="search" id="' + id + '_q" data-c="pick" data-for="' + id + '" placeholder="اكتب الاسم أو الهاتف أو الكود" autocomplete="off"><input type="hidden" id="' + id + '" value="' + (sel || '') + '"><div class="picker" id="' + id + '_list" role="listbox">' + pickList(id, '', sel) + '</div><small>مريض جديد؟ أضفه أولاً من صفحة المرضى.</small></div>';
  }
  function pickList(id, q, sel) {
    q = L.normalize(q);
    var list = visPts().filter(function (p) { return !q || L.normalize(p.name).indexOf(q) >= 0 || (p.phone || '').indexOf(q) >= 0 || L.normalize(p.code).indexOf(q) >= 0; });
    if (sel) { var s = pat(sel); if (s && list.indexOf(s) < 0) list.unshift(s); }
    return list.slice(0, 30).map(function (p) { return '<button type="button" role="option" data-a="pickP" data-for="' + id + '" data-v="' + p.id + '" aria-pressed="' + (p.id === sel) + '">' + esc(p.name) + ' <small class="muted">' + esc(p.code) + ' · <span dir="ltr">' + esc(p.phone) + '</span></small></button>'; }).join('') || '<p class="muted">لا يوجد مريض بهذا البحث.</p>';
  }

  function apptSheet(o) {
    o = o || {}; var now = new Date(), walk = !!o.walk, cid = o.cid || defClinic(), c = V().get('clinics', cid) || {};
    sheet(walk ? 'حالة بدون موعد' : 'موعد جديد', picker('fP', o.pid) +
      '<div class="g2">' + fld('العيادة', '<select id="fC">' + clinicOpts(cid) + '</select>') + fld('نوع الزيارة', '<select id="fK">' + KINDS.map(function (k) { return '<option>' + k + '</option>'; }).join('') + '</select>') + '</div>' +
      '<div class="g2">' + fld('التاريخ', '<input type="date" id="fD" value="' + (walk ? today() : o.date || ui.day || today()) + '"' + (walk ? ' disabled' : '') + '>') + fld('الوقت', '<input type="time" id="fTm" value="' + (o.time || (walk ? L.pad(now.getHours()) + ':' + L.pad(now.getMinutes()) : '12:00')) + '">') + '</div>' +
      '<div class="g2">' + fld('المدة (دقيقة)', '<input id="fDur" inputmode="numeric" value="' + (c.slot || 20) + '">') + fld('ملاحظة', '<input id="fN">') + '</div>' +
      '<label class="checks" id="forceRow" hidden><label><input type="checkbox" id="fForce"> احجز رغم وجود موعد آخر في نفس الوقت</label></label>',
      async function (again) {
        var d = { id: orthoUid(), pid: v('fP'), cid: v('fC'), date: walk ? today() : v('fD'), time: v('fTm'), duration: +L.normalize(v('fDur')) || 20, kind: v('fK'), status: walk ? 'attended' : 'scheduled', note: v('fN'), force: ck('fForce') };
        if (!d.pid) throw new Error('اختر المريض من القائمة.');
        try { await send('appt.create', d); }
        catch (e) { if (e.code === 'overlap') $('#forceRow').hidden = false; throw e; }
        if (walk) return { msg: savedMsg('تم تسجيل الحضور'), then: function () { visitSheet(V().get('appts', d.id)); } };
        if (again) return { msg: savedMsg('تم حجز الموعد'), then: function () { apptSheet({ date: d.date, cid: d.cid, time: addMin(d.time, d.duration) }); } };
        return savedMsg('تم حجز الموعد');
      }, 'حفظ', walk ? null : 'حفظ وإضافة آخر لنفس اليوم');
  }
  function addMin(t, m) { var x = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5)) + (+m || 0); x = Math.min(x, 23 * 60 + 59); return L.pad(Math.floor(x / 60)) + ':' + L.pad(x % 60); }

  function visitSheet(a) {
    if (!a) return; var p = pat(a.pid), A = acc(a.pid);
    sheet('إنهاء زيارة: ' + esc(p.name), '<p class="note">تم تسجيل الحضور. ' + (A && A.overdue > 0 ? 'عليه متأخرات ' + money(A.overdue) + '. ' : '') + (A && A.next ? 'القسط القادم ' + money(A.next.amt - A.next.cover) + '.' : '') + '</p>' +
      (canPay() ? '<div class="g2">' + fld('المبلغ المدفوع الآن', '<input id="fA" inputmode="decimal" autocomplete="off">', 'اتركه فارغاً إذا لم يدفع') + fld('طريقة الدفع', '<select id="fM">' + opts(METHODS, 'cash') + '</select>') + '</div>' : '<p class="muted">ليس لديك صلاحية تسجيل الدفعات.</p>') +
      '<div class="g2">' + fld('الموعد القادم', '<input type="date" id="fD" value="' + L.addDays(a.date, 28) + '" min="' + L.addDays(a.date, 1) + '">') + fld('الوقت', '<input type="time" id="fTm" value="' + a.time + '">') + '</div>' + fld('ملاحظات الزيارة', '<textarea id="fN">' + esc(a.note) + '</textarea>'),
      async function () {
        var x = canPay() ? amt('fA', true) : 0, msgs = [];
        if (x > 0) { await send('tx.add', { id: orthoUid(), pid: p.id, cid: a.cid, type: 'payment', amt: x, method: v('fM'), date: a.date, note: 'دفعة في الزيارة' }); msgs.push('الدفعة'); }
        if (v('fN') !== (a.note || '')) await send('appt.update', { id: a.id, changes: { note: v('fN') }, base: { note: a.note }, baseVersion: a.version });
        if (v('fD')) { await send('appt.create', { id: orthoUid(), pid: p.id, cid: a.cid, date: v('fD'), time: v('fTm'), duration: a.duration, kind: 'متابعة شهرية', status: 'scheduled', force: false }); msgs.push('الموعد القادم'); }
        return savedMsg(msgs.length ? 'تم حفظ ' + msgs.join(' و') : 'تم حفظ الزيارة');
      });
  }

  function paySheet(pid, cid, inst) {
    var pts = visPts(), p = pid ? pat(pid) : null, A = p ? acc(p.id) : null;
    var types = isDoc() ? { payment: TXT.payment, charge: TXT.charge, discount: TXT.discount, refund: TXT.refund } : { payment: TXT.payment };
    var open = A ? A.items.filter(function (x) { return x.cover < x.amt; }) : [];
    var defAmt = A && A.next ? (inst ? (A.items.filter(function (i) { return i.key === inst; })[0] || A.next) : A.next) : null;
    sheet('تسجيل حركة مالية', (p ? '<p class="note"><b>' + esc(p.name) + '</b> · المتبقي ' + money(A.balance) + ' · المتأخر ' + money(A.overdue) + (A.next ? ' · القسط القادم ' + money(A.next.amt - A.next.cover) + ' (' + dfmt(A.next.due) + ')' : '') + '</p><input type="hidden" id="fP" value="' + p.id + '">' : picker('fP', '')) +
      '<div class="g2">' + fld('العيادة التي استلمت المبلغ', '<select id="fC">' + clinicOpts(cid || (p && (p.clinics || []).filter(function (c) { return visC().some(function (k) { return k.id === c; }); })[0]) || defClinic()) + '</select>') + fld('نوع الحركة', '<select id="fT">' + opts(types, 'payment') + '</select>', isDoc() ? '' : 'الخصم والاسترداد للطبيب فقط') + '</div>' +
      '<div class="g2">' + fld('المبلغ (ج.م)', '<input id="fA" inputmode="decimal" autocomplete="off" value="' + (defAmt ? (defAmt.amt - defAmt.cover) / 100 : '') + '">') + fld('طريقة الدفع', '<select id="fM">' + opts(METHODS, 'cash') + '</select>') + '</div>' +
      '<div class="g2">' + fld('التاريخ', '<input type="date" id="fD" value="' + today() + '" max="' + today() + '">') + (p ? fld('تخصيص الدفعة', '<select id="fI"><option value="">تلقائي — الأقدم أولاً</option>' + open.map(function (x) { return '<option value="' + x.key + '"' + (x.key === inst ? ' selected' : '') + '>' + esc(x.label) + ' · ' + dfmt(x.due) + ' · باقي ' + money(x.amt - x.cover) + '</option>'; }).join('') + '</select>') : '') + '</div>' +
      '<div class="g2">' + fld('رقم الإيصال / المرجع', '<input id="fR" autocomplete="off">') + fld('ملاحظة', '<input id="fN" autocomplete="off">') + '</div>' +
      (isDoc() ? '<label class="checks" id="creditRow" hidden><label><input type="checkbox" id="fCredit"> اقبل الزيادة كرصيد للمريض</label></label>' : ''),
      async function () {
        var d = { id: orthoUid(), pid: v('fP'), cid: v('fC'), type: v('fT'), amt: amt('fA'), method: v('fM'), date: v('fD'), inst: v('fI'), ref: v('fR'), note: v('fN'), allowCredit: ck('fCredit') };
        if (!d.pid) throw new Error('اختر المريض من القائمة.');
        try { await send('tx.add', d); } catch (e) { if (e.code === 'overpay' && $('#creditRow')) $('#creditRow').hidden = false; throw e; }
        return savedMsg('تم حفظ ' + TXT[d.type] + ' ' + money(d.amt));
      }, 'حفظ الحركة');
  }

  function patientSheet(pid) {
    var p = pat(pid); if (!p) return; var pl = plan(pid) || {}, A = acc(pid) || { items: [], balance: 0, overdue: 0, cash: 0 };
    var T = entriesOf(pid).sort(function (a, b) { return b.date.localeCompare(a.date) || String(b.at).localeCompare(String(a.at)); });
    var rev = L.reversedSet(T), ap = V().list('appts').filter(function (a) { return a.pid === pid; }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    var labs = V().list('labs').filter(function (l) { return l.pid === pid; }), hist = V().list('planHistory').filter(function (h) { return h.pid === pid; });
    var byC = {}, byId = L.indexById(T); T.forEach(function (t) { byC[t.cid] = (byC[t.cid] || 0) + L.effect(t, byId).cash; });
    sheet(esc(p.name), '<dl class="info"><div><dt>الكود</dt><dd>' + esc(p.code) + '</dd></div><div><dt>الهاتف</dt><dd dir="ltr" style="text-align:right">' + esc(p.phone) + (p.phone2 ? ' / ' + esc(p.phone2) : '') + '</dd></div><div><dt>العيادات</dt><dd>' + (p.clinics || []).map(cName).map(esc).join('، ') + '</dd></div><div><dt>نوع العلاج</dt><dd>' + TYPES[p.type] + '</dd></div><div><dt>بداية العلاج</dt><dd>' + dfmt(pl.start) + '</dd></div><div><dt>يوم السداد</dt><dd>' + N(pl.payDay) + ' من كل شهر</dd></div><div><dt>الحالة</dt><dd>' + PST[pl.status || 'active'] + '</dd></div><div><dt>التسجيل</dt><dd>' + dfmt(p.reg) + '</dd></div></dl>' +
      '<div class="kgrid"><div class="kpi"><span class="k-l">قيمة العلاج</span><b>' + money(A.total) + '</b><small class="muted">' + (A.charges ? 'تشمل رسوم إضافية ' + money(A.charges) : '') + (A.discounts ? ' بعد خصم ' + money(A.discounts) : '') + '</small></div><div class="kpi"><span class="k-l">المدفوع فعلياً</span><b>' + money(A.cash) + '</b><span class="tag t-cash">فعلي</span></div><div class="kpi"><span class="k-l">' + (A.balance < 0 ? 'رصيد للمريض' : 'المتبقي') + '</span><b>' + money(Math.abs(A.balance)) + '</b></div><div class="kpi"><span class="k-l">المتأخر</span><b style="color:' + (A.overdue ? 'var(--bad)' : 'inherit') + '">' + money(A.overdue) + '</b>' + (A.missed ? '<span class="tag t-bad">' + N(A.missed) + ' شهر متتالي</span>' : '') + '</div></div>' +
      '<small class="muted">المدفوع حسب العيادة: ' + (Object.keys(byC).map(function (c) { return esc(cName(c)) + ' ' + money(byC[c]); }).join(' · ') || '—') + '</small>' +
      '<div class="chips">' + (canPay() ? '<button type="button" class="btn sm" data-a="pay" data-v="' + pid + '">تسجيل دفعة</button>' : '') + '<button type="button" class="btn sm ghost" data-a="newAppt" data-v="' + pid + '">حجز موعد</button><button type="button" class="btn sm ghost" data-a="editP" data-v="' + pid + '">تعديل البيانات</button>' + (isDoc() ? '<button type="button" class="btn sm ghost" data-a="editPlan" data-v="' + pid + '">تعديل الخطة</button>' : '') + '<button type="button" class="btn sm ghost" data-a="print">طباعة كشف الحساب</button></div>' +
      (p.notes ? '<p class="note">' + esc(p.notes) + '</p>' : '') +
      '<h3>جدول الأقساط</h3><div class="tw"><table><thead><tr><th>القسط</th><th>الاستحقاق</th><th>المبلغ</th><th>المدفوع</th><th>الحالة</th></tr></thead><tbody>' + A.items.map(function (it) { return '<tr><td>' + esc(it.label) + '</td><td>' + dfmt(it.due) + '</td><td>' + money(it.amt) + '</td><td>' + money(it.cover) + '</td><td>' + pill(it.st.replace('partial-late', 'overdue'), IST[it.st]) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<h3>الحركات المالية</h3><div class="tw"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>العيادة</th><th>المبلغ</th><th>الطريقة</th><th>ملاحظة</th>' + (isDoc() ? '<th></th>' : '') + '</tr></thead><tbody>' +
      (T.map(function (t) { return '<tr><td>' + dfmt(t.date) + '</td><td>' + TXT[t.type] + (rev[t.id] ? ' <small class="muted">(تم عكسها)</small>' : '') + pendTag(t) + '</td><td>' + esc(cName(t.cid)) + '</td><td>' + money(t.amt) + '</td><td>' + (METHODS[t.method] || '—') + '</td><td>' + esc(t.note) + '</td>' + (isDoc() ? '<td>' + (t.type !== 'reversal' && !rev[t.id] ? '<button type="button" class="btn sm ghost" data-a="reverse" data-v="' + t.id + '">تصحيح</button>' : '') + '</td>' : '') + '</tr>'; }).join('') || '<tr><td colspan="7" class="muted">لا توجد حركات</td></tr>') + '</tbody></table></div>' +
      '<h3>المواعيد</h3><div class="tw"><table><thead><tr><th>التاريخ</th><th>الوقت</th><th>العيادة</th><th>النوع</th><th>الحالة</th></tr></thead><tbody>' + (ap.map(function (a) { return '<tr><td>' + dfmt(a.date) + '</td><td>' + a.time + '</td><td>' + esc(cName(a.cid)) + '</td><td>' + esc(a.kind) + '</td><td>' + pill(a.status, AST[a.status]) + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="muted">لا توجد مواعيد</td></tr>') + '</tbody></table></div>' +
      (isDoc() && labs.length ? '<h3>طلبات المعمل</h3><div class="tw"><table><thead><tr><th>التاريخ</th><th>العمل</th><th>المعمل</th><th>التكلفة</th><th>الحالة</th></tr></thead><tbody>' + labs.map(function (l) { return '<tr><td>' + dfmt(l.orderedAt) + '</td><td>' + esc(l.desc) + '</td><td>' + esc(l.lab) + '</td><td>' + money(l.cost) + '</td><td>' + LST[l.status] + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
      (hist.length ? '<details><summary>تعديلات الخطة (' + N(hist.length) + ')</summary><div class="list" style="margin-top:8px">' + hist.map(function (h) { return '<div class="row" style="cursor:default"><small>' + tfmt(h.at) + ' — ' + esc(h.by) + ': القيمة ' + money((h.before || {}).fee) + ' → ' + money((h.after || {}).fee) + '، القسط ' + money((h.before || {}).monthly) + ' → ' + money((h.after || {}).monthly) + '</small></div>'; }).join('') + '</div></details>' : ''));
  }

  function patientForm(p) {
    var x = p || { name: '', phone: '', phone2: '', clinics: [defClinic()], type: 'fixed', notes: '' };
    var pl = { fee: 0, initial: 0, monthly: 0, payDay: +today().slice(8), start: today() };
    return fld('الاسم الكامل', '<input id="fName" value="' + esc(x.name) + '" autocomplete="off">') +
      '<div class="g2">' + fld('الهاتف الأساسي', '<input id="fPh" inputmode="tel" dir="ltr" value="' + esc(x.phone) + '">') + fld('هاتف آخر', '<input id="fPh2" inputmode="tel" dir="ltr" value="' + esc(x.phone2) + '">') + '</div>' +
      fld('العيادات', '<div class="checks">' + visC().map(function (c) { return '<label><input type="checkbox" id="fc_' + c.id + '"' + ((x.clinics || []).indexOf(c.id) >= 0 ? ' checked' : '') + '> ' + esc(c.name) + '</label>'; }).join('') + '</div>', 'خطة علاج واحدة يمكن الدفع لها في أي عيادة') +
      fld('نوع العلاج', '<select id="fTy">' + opts(TYPES, x.type) + '</select>') +
      (p ? '' : '<div class="g2">' + fld('قيمة العلاج (ج.م)', '<input id="fFee" inputmode="decimal">') + fld('المقدم (ج.م)', '<input id="fIn" inputmode="decimal">') + '</div><div class="g2">' + fld('القسط الشهري (ج.م)', '<input id="fMo" inputmode="decimal">') + fld('يوم السداد في الشهر', '<input id="fDay" inputmode="numeric" value="' + pl.payDay + '">', 'إذا كان الشهر أقصر يكون آخر يوم فيه') + '</div>' + fld('بداية العلاج', '<input type="date" id="fSt" value="' + pl.start + '">') +
        (canPay() ? '<label class="checks"><label><input type="checkbox" id="fRec" checked> تم استلام المقدم الآن (يُسجّل كدفعة)</label></label>' : '')) +
      fld('ملاحظات', '<textarea id="fNo">' + esc(x.notes) + '</textarea>');
  }
  function newPatient() {
    sheet('مريض جديد', patientForm(null), async function () {
      var cl = visC().filter(function (c) { return ck('fc_' + c.id); }).map(function (c) { return c.id; });
      var d = { id: orthoUid(), name: v('fName'), phone: v('fPh'), phone2: v('fPh2'), clinics: cl, type: v('fTy'), notes: v('fNo'), fee: amt('fFee'), initial: amt('fIn', true), monthly: amt('fMo', true), payDay: +L.normalize(v('fDay')), start: v('fSt') };
      await send('patient.save', d);
      if (ck('fRec') && d.initial > 0) await send('tx.add', { id: orthoUid(), pid: d.id, cid: cl[0], type: 'payment', amt: d.initial, method: 'cash', date: d.start <= today() ? d.start : today(), inst: 'i0', note: 'المقدم' });
      return { msg: savedMsg('تم تسجيل المريض'), then: function () { patientSheet(d.id); } };
    });
  }
  function editPatient(pid) {
    var p = pat(pid);
    sheet('تعديل: ' + esc(p.name), patientForm(p), async function () {
      var cl = visC().filter(function (c) { return ck('fc_' + c.id); }).map(function (c) { return c.id; });
      var next = { name: v('fName'), phone: v('fPh'), phone2: v('fPh2'), clinics: cl, type: v('fTy'), notes: v('fNo') }, ch = {}, base = {};
      Object.keys(next).forEach(function (k) { var old = k === 'clinics' ? (p.clinics || []).filter(function (c) { return cl.indexOf(c) >= 0 || visC().some(function (x) { return x.id === c; }); }) : p[k] || ''; if (JSON.stringify(old) !== JSON.stringify(next[k])) { ch[k] = next[k]; base[k] = p[k]; } });
      if (!Object.keys(ch).length) return 'لا توجد تغييرات';
      await send('patient.save', { id: pid, changes: ch, base: base, baseVersion: p.version });
      return savedMsg('تم حفظ التعديل');
    });
  }
  function editPlan(pid) {
    var pl = plan(pid), p = pat(pid);
    sheet('خطة علاج: ' + esc(p.name), '<p class="note">التعديل يُحفظ في السجل مع القيم القديمة. الأقساط تُعاد حسابها من الخطة الجديدة، والدفعات تبقى كما هي.</p>' +
      '<div class="g2">' + fld('قيمة العلاج (ج.م)', '<input id="fFee" inputmode="decimal" value="' + pl.fee / 100 + '">') + fld('المقدم (ج.م)', '<input id="fIn" inputmode="decimal" value="' + pl.initial / 100 + '">') + '</div>' +
      '<div class="g2">' + fld('القسط الشهري (ج.م)', '<input id="fMo" inputmode="decimal" value="' + pl.monthly / 100 + '">') + fld('يوم السداد', '<input id="fDay" inputmode="numeric" value="' + pl.payDay + '">') + '</div>' +
      '<div class="g2">' + fld('بداية العلاج', '<input type="date" id="fSt" value="' + pl.start + '">') + fld('الحالة', '<select id="fPs">' + opts(PST, pl.status) + '</select>', '"متوقف مؤقتاً" يوقف الأقساط من تاريخ الإيقاف') + '</div>' +
      fld('تاريخ الإيقاف', '<input type="date" id="fPf" value="' + (pl.pausedFrom || today()) + '">', 'يُستخدم فقط مع "متوقف مؤقتاً"'),
      async function () {
        var next = { fee: amt('fFee'), initial: amt('fIn', true), monthly: amt('fMo', true), payDay: +L.normalize(v('fDay')), start: v('fSt'), status: v('fPs'), pausedFrom: v('fPs') === 'paused' ? v('fPf') : '' }, ch = {};
        Object.keys(next).forEach(function (k) { if (String(next[k]) !== String(pl[k] == null ? '' : pl[k])) ch[k] = next[k]; });
        if (!Object.keys(ch).length) return 'لا توجد تغييرات';
        await send('plan.update', { pid: pid, changes: ch, baseVersion: pl.version });
        return savedMsg('تم حفظ الخطة');
      });
  }

  function reportCsv(k) {
    var ids = cids(), r = range(), H = [], R = [], title = '', byId = L.indexById(V().list('ledger'));
    if (k === 'appts') { title = 'المواعيد والحضور'; H = ['التاريخ', 'الوقت', 'المريض', 'الكود', 'العيادة', 'النوع', 'الحالة']; R = V().list('appts').filter(function (a) { return ids.indexOf(a.cid) >= 0 && a.date >= r[0] && a.date <= r[1]; }).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); }).map(function (a) { var p = pat(a.pid) || {}; return [a.date, a.time, p.name, p.code, cName(a.cid), a.kind, AST[a.status]]; }); }
    if (k === 'payments') { title = 'التحصيلات والحركات'; H = ['التاريخ', 'المريض', 'الكود', 'العيادة', 'النوع', 'الطريقة', 'المبلغ', 'أثر على التحصيل', 'مرجع']; R = V().list('ledger').filter(function (x) { return ids.indexOf(x.cid) >= 0 && x.date >= r[0] && x.date <= r[1]; }).sort(function (a, b) { return a.date.localeCompare(b.date); }).map(function (x) { var p = pat(x.pid) || {}; return [x.date, p.name, p.code, cName(x.cid), TXT[x.type], METHODS[x.method] || '', x.amt / 100, L.effect(x, byId).cash / 100, x.ref]; }); }
    if (k === 'balances') { title = 'أرصدة المرضى (حتى اليوم)'; H = ['الكود', 'المريض', 'الهاتف', 'العيادات', 'قيمة العلاج', 'المدفوع', 'المتبقي', 'المتأخر', 'شهور متأخرة']; R = visPts().map(function (p) { var A = acc(p.id) || {}; return [p.code, p.name, p.phone, (p.clinics || []).map(cName).join(' / '), A.total / 100, A.cash / 100, A.balance / 100, A.overdue / 100, A.missed]; }); }
    if (k === 'overdue') { title = 'الأقساط المتأخرة'; H = ['المريض', 'الهاتف', 'القسط', 'الاستحقاق', 'الباقي منه', 'شهور متتالية']; visPts().forEach(function (p) { var A = acc(p.id); if (A) A.items.filter(function (x) { return x.late; }).forEach(function (x) { R.push([p.name, p.phone, x.label, x.due, (x.amt - x.cover) / 100, A.missed]); }); }); }
    if (k === 'labs') { title = 'طلبات المعمل'; H = ['تاريخ الطلب', 'تاريخ التسليم', 'الحالة', 'المريض', 'العيادة', 'المعمل', 'العمل', 'التكلفة', 'المدفوع', 'المتبقي', 'على الطبيب', 'على العيادة', 'القاعدة']; R = V().list('labs').filter(function (l) { return ids.indexOf(l.cid) >= 0 && l.orderedAt >= r[0] && l.orderedAt <= r[1]; }).map(function (l) { var pd = Core.labPaid(V(), l.id); return [l.orderedAt, l.deliveredAt, LST[l.status], (pat(l.pid) || {}).name, cName(l.cid), l.lab, l.desc, l.cost / 100, pd / 100, (l.cost - pd) / 100, l.labDoc / 100, l.labCli / 100, LABP[l.resp]]; }); }
    if (k === 'clinics') { title = 'حسابات العيادات'; H = ['العيادة', 'التحصيل', 'نصيب الطبيب من التحصيل', 'رسوم ثابتة', 'المعمل على الطبيب', 'صافي الطبيب', 'نصيب العيادة قبل المعمل', 'المعمل على العيادة', 'صافي العيادة', 'دفعته العيادة', 'الباقي حتى اليوم']; R = ids.map(function (i) { var x = calc(i, r[0], r[1]); return [cName(i), x.coll / 100, x.docFromColl / 100, x.fees / 100, x.labDoc / 100, x.docNet / 100, x.cliGross / 100, x.labCli / 100, x.cliNet / 100, x.settled / 100, owed(i) / 100]; }); }
    if (k === 'settlements') { title = 'دفعات العيادات للطبيب'; H = ['التاريخ', 'العيادة', 'المبلغ', 'مرجع', 'ملاحظة']; R = V().list('settlements').filter(function (s) { return ids.indexOf(s.cid) >= 0 && s.date >= r[0] && s.date <= r[1]; }).map(function (s) { return [s.date, cName(s.cid), s.amt / 100, s.ref, s.note]; }); }
    if (k === 'monthly') { title = 'مقارنة شهرية (آخر ١٢ شهراً)'; H = ['الشهر'].concat(ids.map(function (i) { return cName(i) + ' تحصيل'; }), ids.map(function (i) { return cName(i) + ' صافي الطبيب'; })); for (var m = -11; m <= 0; m++) { var a = L.addMonths(L.monthStart(today()), m, 1), b = L.monthEnd(a), rs = ids.map(function (i) { return calc(i, a, b); }); R.push([a.slice(0, 7)].concat(rs.map(function (x) { return x.coll / 100; }), rs.map(function (x) { return x.docNet / 100; }))); } }
    if (k === 'inventory') { title = 'المخزون'; H = ['الصنف', 'الفئة', 'الوحدة', 'المتاح', 'الحد الأدنى', 'المورد']; R = V().list('items').map(function (i) { return [i.name, i.category, i.unit, Core.stockOf(V(), i.id), i.min, i.supplier]; }); }
    return { title: title, H: H, R: R };
  }
  function report(k) {
    var x = reportCsv(k), r = range();
    sheet(x.title, '<small class="muted">' + (ui.clinic === 'all' ? 'كل العيادات' : esc(cName(ui.clinic))) + ' · ' + dfmt(r[0]) + ' — ' + dfmt(r[1]) + ' · ' + N(x.R.length) + ' صف</small><div class="chips"><button type="button" class="btn sm" data-a="csv" data-v="' + k + '">تنزيل CSV (Excel)</button><button type="button" class="btn sm ghost" data-a="print">طباعة</button></div>' +
      '<div class="tw"><table><thead><tr>' + x.H.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + (x.R.map(function (row) { return '<tr>' + row.map(function (c) { return '<td>' + (typeof c === 'number' ? nf.format(c) : esc(c)) + '</td>'; }).join('') + '</tr>'; }).join('') || '<tr><td colspan="' + x.H.length + '" class="muted">لا توجد بيانات</td></tr>') + '</tbody></table></div>');
  }
  function downloadCsv(k) {
    var x = reportCsv(k), q = function (c) { var s = String(L.safeCell(c == null ? '' : c)); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var csv = '﻿' + [x.H].concat(x.R).map(function (r) { return r.map(q).join(','); }).join('\r\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = x.title.replace(/[\\/:*?"<>|()]/g, '') + ' ' + today() + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- theme & PIN ---------- */
  function themeNow() { return document.documentElement.getAttribute('data-theme') || ''; }
  var pinSet = false;
  async function hash(s) { var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ortho:' + s)); return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }

  /* ---------- actions ---------- */
  var A = {
    nav: function (x) { ui.view = x; saveUi(); render(); scrollTo(0, 0); },
    period: function (x) { ui.period = x; saveUi(); render(); },
    day: function (x, b) { ui.day = x; if (b.dataset.cal) ui.cal = b.dataset.cal; saveUi(); render(); },
    cal: function (x) { ui.cal = x; saveUi(); render(); },
    step: function (x) { var d = ui.day || today(), n = +x; ui.day = ui.cal === 'month' ? L.addMonths(L.monthStart(d), n, 1) : L.addDays(d, ui.cal === 'week' ? 7 * n : n); render(); },
    instF: function (x) { ui.instF = x; saveUi(); render(); },
    pst: function (x) { ui.pst = x; saveUi(); render(); },
    labF: function (x) { ui.labF = x; render(); }, labCan: function () { ui.labCancelled = !ui.labCancelled; render(); },
    close: closeSheet,
    openP: function (x) { patientSheet(x); },
    pickP: function (x, b) {
      var id = b.dataset.for; document.getElementById(id).value = x; b.parentNode.querySelectorAll('button').forEach(function (y) { y.setAttribute('aria-pressed', String(y === b)); });
      var sel = document.getElementById('fC'), p = pat(x);   // default the clinic to one the patient attends
      if (sel && p && (p.clinics || []).indexOf(sel.value) < 0) { var c = (p.clinics || []).filter(function (c) { return visC().some(function (k) { return k.id === c; }); })[0]; if (c) sel.value = c; }
    },
    att: async function (x) { var a = V().get('appts', x); try { await send('appt.update', { id: a.id, changes: { status: 'attended' }, base: { status: a.status }, baseVersion: a.version }); render(); visitSheet(V().get('appts', x)); } catch (e) { toast(e.message, 'bad'); } },
    abs: async function (x) { var a = V().get('appts', x); try { await send('appt.update', { id: a.id, changes: { status: 'absent' }, base: { status: a.status }, baseVersion: a.version }); render(); toast(savedMsg('تم تسجيل الغياب')); } catch (e) { toast(e.message, 'bad'); } },
    resch: function (x) {
      var a = V().get('appts', x), p = pat(a.pid);
      sheet('تأجيل موعد: ' + esc(p.name), '<p class="note">الموعد الحالي ' + dfmt(a.date) + ' ' + a.time + '. سيُحجز الموعد الجديد ويُعلَّم القديم "تم التأجيل" معاً.</p><div class="g2">' + fld('التاريخ الجديد', '<input type="date" id="fD" value="' + L.addDays(a.date, 7) + '" min="' + today() + '">') + fld('الوقت', '<input type="time" id="fTm" value="' + a.time + '">') + '</div><label class="checks" id="forceRow" hidden><label><input type="checkbox" id="fForce"> احجز رغم التعارض</label></label>',
        async function () { try { await send('appt.reschedule', { id: a.id, newId: orthoUid(), date: v('fD'), time: v('fTm'), force: ck('fForce') }); } catch (e) { if (e.code === 'overlap') $('#forceRow').hidden = false; throw e; } return savedMsg('تم التأجيل'); });
    },
    next: function (x) { var a = V().get('appts', x); apptSheet({ pid: a.pid, cid: a.cid, date: L.addDays(a.date, 28), time: a.time }); },
    pay: function (x, b) { if (!canPay()) return toast('ليس لديك صلاحية تسجيل الدفعات.', 'bad'); paySheet(x, b.dataset.c2, b.dataset.i); },
    newAppt: function (x, b) { apptSheet({ pid: x, date: b.dataset.d }); },
    walkin: function () { apptSheet({ walk: true }); },
    newP: newPatient, editP: editPatient, editPlan: editPlan,
    print: function () { window.print(); },
    reverse: function (x) {
      var t = V().get('ledger', x);
      sheet('تصحيح حركة', '<p class="note">' + TXT[t.type] + ' ' + money(t.amt) + ' بتاريخ ' + dfmt(t.date) + '. لن تُحذف الحركة. سيُسجَّل قيد عكسي بتاريخ اليوم يلغي أثرها، ويبقى الأصل في السجل.</p>' + fld('سبب التصحيح', '<input id="fN" placeholder="مثال: دفعة مكررة بالخطأ">'),
        async function () { await send('tx.reverse', { id: orthoUid(), target: t.id, note: v('fN') }); return { msg: savedMsg('تم تسجيل التصحيح'), then: function () { patientSheet(t.pid); } }; }, 'تسجيل التصحيح');
    },
    newLab: function () {
      sheet('طلب معمل جديد', picker('fP', '') + '<div class="g2">' + fld('العيادة', '<select id="fC">' + clinicOpts(defClinic()) + '</select>') + fld('اسم المعمل', '<input id="fL" value="' + esc((V().list('labs').slice(-1)[0] || {}).lab || '') + '">') + '</div>' + fld('وصف العمل', '<input id="fW" placeholder="مثال: مثبّت شفاف علوي">') +
        '<div class="g2">' + fld('التكلفة (ج.م)', '<input id="fA" inputmode="decimal">') + fld('مدفوع الآن (ج.م)', '<input id="fPd" inputmode="decimal">') + '</div><div class="g2">' + fld('تاريخ الطلب', '<input type="date" id="fD" value="' + today() + '" max="' + today() + '">') + fld('موعد التسليم المتوقع', '<input type="date" id="fE">') + '</div><p class="note">من يتحمل التكلفة يُؤخذ من اتفاق العيادة في تاريخ الطلب.</p>',
        async function () { var d = { id: orthoUid(), pid: v('fP'), cid: v('fC'), lab: v('fL'), desc: v('fW'), cost: amt('fA'), paidNow: amt('fPd', true), orderedAt: v('fD'), expectedAt: v('fE') }; if (!d.pid) throw new Error('اختر المريض من القائمة.'); await send('lab.create', d); return savedMsg('تم حفظ طلب المعمل'); });
    },
    labPay: function (x) {
      var l = V().get('labs', x), rest = l.cost - Core.labPaid(V(), l.id);
      sheet('دفع للمعمل', '<p class="note">' + esc(l.desc) + ' · المتبقي ' + money(rest) + '</p><div class="g2">' + fld('المبلغ (ج.م)', '<input id="fA" inputmode="decimal" value="' + rest / 100 + '">') + fld('التاريخ', '<input type="date" id="fD" value="' + today() + '" max="' + today() + '">') + '</div>' + fld('ملاحظة', '<input id="fN">'),
        async function () { await send('lab.pay', { id: orthoUid(), labId: l.id, amt: amt('fA'), date: v('fD'), note: v('fN') }); return savedMsg('تم حفظ الدفع للمعمل'); });
    },
    labDeliver: function (x) {
      var l = V().get('labs', x);
      sheet('تسليم طلب المعمل', fld('تاريخ التسليم', '<input type="date" id="fD" value="' + today() + '" max="' + today() + '">'), async function () { await send('lab.update', { id: l.id, changes: { deliveredAt: v('fD'), status: 'delivered' }, base: { deliveredAt: l.deliveredAt, status: l.status }, baseVersion: l.version }); return savedMsg('تم تسجيل التسليم'); });
    },
    labCancel: function (x) {
      var l = V().get('labs', x);
      sheet('إلغاء طلب المعمل', '<p class="err">سيُلغى الطلب "' + esc(l.desc) + '" ولن تُحسب تكلفته.</p>', async function () { await send('lab.update', { id: l.id, changes: { status: 'cancelled' }, base: { status: l.status }, baseVersion: l.version }); return savedMsg('تم الإلغاء'); }, 'نعم، ألغِ الطلب');
    },
    newItem: function () {
      sheet('صنف جديد', fld('اسم الصنف', '<input id="fNm">') + '<div class="g2">' + fld('الفئة', '<input id="fCat" placeholder="أسلاك، براكيت، مواد لصق…">') + fld('الوحدة', '<input id="fU" value="قطعة">') + '</div><div class="g2">' + fld('الحد الأدنى للتنبيه', '<input id="fMin" inputmode="numeric" value="0">') + fld('المورد', '<input id="fS">') + '</div>',
        async function () { await send('item.save', { id: orthoUid(), name: v('fNm'), category: v('fCat'), unit: v('fU'), min: +L.normalize(v('fMin')) || 0, supplier: v('fS') }); return savedMsg('تمت إضافة الصنف'); });
    },
    move: function (x) {
      var it = V().get('items', x);
      sheet('حركة مخزون: ' + esc(it.name), '<p class="note">المتاح الآن: ' + N(Core.stockOf(V(), it.id)) + ' ' + esc(it.unit) + '</p><div class="g2">' + fld('النوع', '<select id="fK"><option value="in">إضافة (شراء)</option><option value="use">استهلاك</option><option value="adjust">تسوية (جرد)</option></select>') + fld('الكمية', '<input id="fQ" inputmode="numeric">', 'في التسوية: رقم موجب يزيد وسالب ينقص') + '</div><div class="g2">' + fld('تكلفة الشراء (ج.م)', '<input id="fA" inputmode="decimal">', 'للإضافة فقط') + fld('التاريخ', '<input type="date" id="fD" value="' + today() + '" max="' + today() + '">') + '</div>' + fld('ملاحظة', '<input id="fN">') + '<label class="checks"><label><input type="checkbox" id="fNeg"> اسمح بكمية سالبة (تسوية فقط)</label></label>',
        async function () { var q = +L.normalize(v('fQ')); await send('stock.move', { id: orthoUid(), itemId: it.id, kind: v('fK'), qty: q, cost: v('fA') ? amt('fA') : 0, date: v('fD'), note: v('fN'), allowNegative: ck('fNeg') }); return savedMsg('تم حفظ الحركة'); });
    },
    settle: function (x) {
      var o = owed(x);
      sheet('دفعة من ' + esc(cName(x)) + ' للطبيب', '<p class="note">الباقي للطبيب حتى اليوم: ' + money(o) + '. يمكن تسجيل دفعة جزئية.</p><div class="g2">' + fld('المبلغ (ج.م)', '<input id="fA" inputmode="decimal">') + fld('التاريخ', '<input type="date" id="fD" value="' + today() + '" max="' + today() + '">') + '</div><div class="g2">' + fld('رقم الإيصال / التحويل', '<input id="fR">') + fld('ملاحظة', '<input id="fN" placeholder="مثال: تسوية شهر سبتمبر">') + '</div>',
        async function () { var a = amt('fA'); await send('settle.add', { id: orthoUid(), cid: x, amt: a, date: v('fD'), ref: v('fR'), note: v('fN') }); return savedMsg('تم تسجيل الدفعة. الباقي الآن ' + money(o - a)); });
    },
    closeMonth: function (x) {
      var months = []; for (var i = 1; i <= 12; i++) { var m = L.monthOf(L.addMonths(L.monthStart(today()), -i, 1)); if (!Core.isClosed(V(), x, m + '-01')) months.push(m); }
      if (!months.length) return toast('كل الشهور السابقة مُغلقة.');
      sheet('إغلاق شهر: ' + esc(cName(x)), '<p class="note">بعد الإغلاق لا يمكن تسجيل أو تعديل حركات بتاريخ هذا الشهر. أي تصحيح لاحق يُسجّل في شهر مفتوح.</p>' + fld('الشهر', '<select id="fM">' + months.map(function (m) { return '<option value="' + m + '">' + mname(m) + '</option>'; }).join('') + '</select>'),
        async function () { await send('month.close', { cid: x, month: v('fM') }); return savedMsg('تم إغلاق الشهر'); }, 'إغلاق الشهر');
    },
    agree: function (x) {
      var cur = L.agreementAt(V().list('agreements'), x, today()) || { method: 'pct', pct: 70, fee: 0, lab: 'deduct' };
      sheet('اتفاق جديد: ' + esc(cName(x)), '<p class="note">الاتفاق الجديد يبدأ من التاريخ المختار. الحركات القديمة تبقى بنسبتها الأصلية ولا يُعاد حسابها.</p>' + fld('طريقة الحساب', '<select id="fMe">' + opts({ pct: 'نسبة من التحصيل', fixed: 'مبلغ ثابت لكل زيارة', fixed_pct: 'مبلغ ثابت + نسبة' }, cur.method) + '</select>') +
        '<div class="g2">' + fld('نسبة الطبيب ٪', '<input id="fPc" inputmode="decimal" value="' + cur.pct + '">') + fld('مبلغ ثابت لكل زيارة (ج.م)', '<input id="fFe" inputmode="decimal" value="' + cur.fee / 100 + '">') + '</div>' + fld('تكلفة المعمل', '<select id="fLb">' + opts(LABP, cur.lab) + '</select>') + fld('يبدأ من', '<input type="date" id="fFr" value="' + today() + '">'),
        async function () { await send('agreement.add', { id: orthoUid(), cid: x, method: v('fMe'), pct: +L.normalize(v('fPc')).replace('٫', '.'), fee: amt('fFe', true), lab: v('fLb'), from: v('fFr') }); return savedMsg('تم حفظ الاتفاق'); });
    },
    newClinic: function () { clinicSheet(null); }, editClinic: function (x) { clinicSheet(x); },
    editUser: function (x) {
      var u = x ? V().get('users', x) : { email: '', name: '', role: 'assistant', clinics: [], canPay: true, active: true };
      sheet(x ? 'تعديل مستخدم' : 'مستخدم جديد', fld('الاسم', '<input id="fNm" value="' + esc(u.name) + '">') + fld('بريد Gmail', '<input id="fE" dir="ltr" inputmode="email" value="' + esc(u.email) + '">', 'يدخل المستخدم بهذا الحساب') + fld('الدور', '<select id="fRo">' + opts({ assistant: 'مساعد / سكرتارية', doctor: 'طبيب (كل الصلاحيات)' }, u.role) + '</select>') +
        fld('العيادات المسموحة', '<div class="checks">' + allClinics().map(function (c) { return '<label><input type="checkbox" id="fc_' + c.id + '"' + ((u.clinics || []).indexOf(c.id) >= 0 ? ' checked' : '') + '> ' + esc(c.name) + '</label>'; }).join('') + '</div>') +
        '<label class="checks"><label><input type="checkbox" id="fCp"' + (u.canPay ? ' checked' : '') + '> يمكنه تسجيل الدفعات</label><label><input type="checkbox" id="fAc"' + (u.active !== false ? ' checked' : '') + '> نشط</label></label>',
        async function () { await send('user.save', { id: x || orthoUid(), name: v('fNm'), email: v('fE'), role: v('fRo'), clinics: allClinics().filter(function (c) { return ck('fc_' + c.id); }).map(function (c) { return c.id; }), canPay: ck('fCp'), active: ck('fAc') }); return savedMsg('تم حفظ المستخدم'); });
    },
    report: function (x) { report(x); }, csv: function (x) { downloadCsv(x); },
    syncNow: function () { sync.backoff = 0; sync.sync({ force: true }); toast(navigator.onLine ? 'جارٍ المزامنة…' : 'لا يوجد إنترنت الآن.'); },
    cfTheirs: async function (i) { await sync.dropConflict(+i); render(); toast('تم الاحتفاظ بقيمة الخادم'); },
    cfMine: async function (i) {
      var c = sync.conflicts[+i], r = c.result, row = V().get(r.table, r.id);
      if (!row) { await sync.dropConflict(+i); return; }
      if (r.table === 'plans') { await sync.dropConflict(+i); editPlan(row.pid); return; }
      var ch = {}, base = {}; r.conflicts.forEach(function (f) { ch[f.field] = f.mine; base[f.field] = row[f.field]; });
      var type = c.op.type, d = { id: r.id, changes: ch, base: base, baseVersion: row.version };
      try { await send(type, d); await sync.dropConflict(+i); render(); toast(savedMsg('تم اعتماد قيمتك')); } catch (e) { toast(e.message, 'bad'); }
    },
    dropFail: async function (i) { await sync.dropFailed(+i); render(); },
    backups: async function () {
      var el = $('#bkList'); el.innerHTML = '<p class="muted">جارٍ التحميل…</p>';
      try {
        var r = await sync.action('backups');
        el.innerHTML = '<h3>آخر الفحوص والنسخ</h3><div class="tw"><table><thead><tr><th>الوقت</th><th>النوع</th><th>النتيجة</th><th>الملف</th></tr></thead><tbody>' + r.log.map(function (l) { return '<tr><td>' + tfmt(l.at) + '</td><td>' + esc({ backup: 'نسخة', excel: 'Excel', check: 'فحص', restore: 'استعادة' }[l.kind] || l.kind) + '</td><td>' + (l.status === 'ok' ? pill('paid', 'ناجح') : pill('overdue', 'فشل')) + '</td><td>' + esc(l.name) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
          '<h3>النسخ المتاحة (' + N(r.backups.length) + ')</h3><div class="list">' + r.backups.slice(0, 60).map(function (b) { return '<div class="row" style="cursor:default"><div class="row-m"><b>' + esc(b.name) + '</b><small class="muted">' + tfmt(b.created) + '</small></div><button class="btn sm badb" data-a="restore" data-v="' + b.id + '" data-n="' + esc(b.name) + '">استعادة</button></div>'; }).join('') + '</div>';
      } catch (e) { el.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
    },
    backupNow: async function () { try { var r = await sync.action('backupNow'); toast('تم إنشاء النسخة: ' + r.backup.name); } catch (e) { toast(e.message, 'bad'); } },
    exportNow: async function () { try { var r = await sync.action('exportNow'); toast('تم حفظ ملف Excel في Google Drive: ' + r.export.name); } catch (e) { toast(e.message, 'bad'); } },
    restore: function (x, b) {
      sheet('استعادة نسخة احتياطية', '<p class="err">ستُستبدل كل البيانات الحالية بالنسخة: ' + esc(b.dataset.n) + '. ستُحفظ نسخة من الوضع الحالي قبل الاستعادة. التعديلات المنتظرة على هذا الجهاز ستُرسل بعدها.</p>' + fld('اكتب RESTORE للتأكيد', '<input id="fCf" dir="ltr" autocomplete="off">'),
        async function () { var r = await sync.action('restore', { fileId: x, confirm: v('fCf') }); sync.syncSoon(0); return 'تمت الاستعادة من ' + r.restore.restoredFrom; }, 'استعادة');
    },
    theme: function () { var n = { '': 'light', light: 'dark', dark: '' }[themeNow()]; if (n) document.documentElement.setAttribute('data-theme', n); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('ortho-theme', n); } catch (e) { } render(); },
    pin: function () {
      sheet('رمز القفل', '<p class="note">الرمز يحمي البيانات المحفوظة على هذا الجهاز. يُطلب عند فتح التطبيق وبعد ١٠ دقائق في الخلفية. اتركه فارغاً لإلغاء القفل.</p>' + fld('رمز جديد (٤–٨ أرقام)', '<input id="fPin" type="password" inputmode="numeric" dir="ltr" autocomplete="new-password">'),
        async function () { var p = L.normalize(v('fPin')); if (p && !/^\d{4,8}$/.test(p)) throw new Error('الرمز من ٤ إلى ٨ أرقام.'); await sync.kv.put('pin', p ? await hash(p) : ''); pinSet = !!p; return p ? 'تم تعيين الرمز' : 'تم إلغاء القفل'; });
    },
    lock: function () { ui.locked = true; render(); },
    signout: function () {
      sheet('تسجيل الخروج', '<p class="err">سيتم مسح كل البيانات المحفوظة على هذا الجهاز.' + (sync.outbox.length ? ' تحذير: يوجد ' + N(sync.outbox.length) + ' تعديل لم يُرسل بعد وسيضيع.' : '') + '</p>',
        async function () { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); await sync.wipe(); await sync.kv.put('pin', ''); pinSet = false; ui.locked = false; return 'تم تسجيل الخروج'; }, 'خروج ومسح');
    },
    devLogin: function () { var e = v('devEmail') || ((me() || {}).email) || 'doctor@gmail.com'; sync.setToken('dev:' + e); }
  };
  function clinicSheet(id) {
    var c = id ? V().get('clinics', id) : { name: '', phone: '', address: '', days: '', hours: '', slot: 20, active: true, notes: '' };
    sheet(id ? 'بيانات العيادة' : 'إضافة عيادة', fld('اسم العيادة', '<input id="fNm" value="' + esc(c.name) + '">') + '<div class="g2">' + fld('الهاتف', '<input id="fPh" dir="ltr" inputmode="tel" value="' + esc(c.phone) + '">') + fld('العنوان', '<input id="fAd" value="' + esc(c.address) + '">') + '</div>' +
      '<div class="g2">' + fld('أيام العمل', '<input id="fDy" value="' + esc(c.days) + '" placeholder="السبت والثلاثاء">') + fld('ساعات العمل', '<input id="fHr" value="' + esc(c.hours) + '" placeholder="٤ م – ١٠ م">') + '</div>' +
      '<div class="g2">' + fld('مدة الموعد (دقيقة)', '<input id="fSl" inputmode="numeric" value="' + (c.slot || 20) + '">') + (id ? '<label class="checks"><label><input type="checkbox" id="fAc"' + (c.active !== false ? ' checked' : '') + '> العيادة نشطة</label></label>' : '') + '</div>' +
      (id ? '' : '<div class="g2">' + fld('نسبة الطبيب ٪', '<input id="fPc" inputmode="decimal" value="70">', 'والعيادة الباقي') + fld('تكلفة المعمل', '<select id="fLb">' + opts(LABP, 'deduct') + '</select>') + '</div>' + fld('يبدأ الاتفاق من', '<input type="date" id="fFr" value="' + L.monthStart(today()) + '">')) +
      fld('ملاحظات', '<textarea id="fNo">' + esc(c.notes) + '</textarea>'),
      async function () {
        var f = { name: v('fNm'), phone: v('fPh'), address: v('fAd'), days: v('fDy'), hours: v('fHr'), slot: +L.normalize(v('fSl')) || 20, notes: v('fNo') };
        if (id) { f.active = ck('fAc'); var ch = {}, base = {}; Object.keys(f).forEach(function (k) { if (String(f[k]) !== String(c[k] == null ? '' : c[k])) { ch[k] = f[k]; base[k] = c[k]; } }); await send('clinic.save', Object.assign({ id: id, changes: ch, base: base, baseVersion: c.version }, f)); }
        else await send('clinic.save', Object.assign({ id: orthoUid(), pct: +L.normalize(v('fPc')), lab: v('fLb'), agreementFrom: v('fFr') }, f));
        return savedMsg('تم حفظ العيادة');
      });
  }

  /* ---------- event wiring ---------- */
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-a]'); if (!b) return; var f = A[b.dataset.a]; if (f) { e.preventDefault(); f(b.dataset.v, b, e); } });
  document.addEventListener('submit', async function (e) {
    if (e.target.id === 'unlockF') {
      e.preventDefault(); var ok = (await hash(L.normalize(v('pinIn')))) === (await sync.kv.get('pin'));
      if (ok) { ui.locked = false; render(); } else { var er = $('#pinErr'); er.hidden = false; er.textContent = 'الرمز غير صحيح.'; } return;
    }
    if (e.target.id !== 'shF') return; e.preventDefault(); if (!SUB || BUSY) return;
    var again = !!(e.submitter && e.submitter.name === 'again');
    BUSY = true; var btn = $('#shOk'), er2 = $('#shErr'); btn.disabled = true; btn.textContent = 'جارٍ الحفظ…';
    try {
      var r = await SUB(again); closeSheet(); render();
      toast(typeof r === 'object' && r ? r.msg : (r || 'تم الحفظ'));
      if (r && r.then) r.then();
    } catch (err) { console.warn(err); er2.hidden = false; er2.textContent = err.message || String(err); BUSY = false; btn.disabled = false; btn.textContent = SUBL; }
  });
  document.addEventListener('change', async function (e) {
    var c = e.target.dataset.c; if (!c) return; var t = e.target;
    if (c === 'clinic') { ui.clinic = t.value; saveUi(); render(); }
    if (c === 'pfrom') { ui.from = t.value; render(); } if (c === 'pto') { ui.to = t.value; render(); }
    if (c === 'apst' && t.value) {
      var a = V().get('appts', t.dataset.id), nv = t.value;
      try { await send('appt.update', { id: a.id, changes: { status: nv }, base: { status: a.status }, baseVersion: a.version }); render(); if (nv === 'attended') visitSheet(V().get('appts', a.id)); else toast(savedMsg('تم التغيير إلى: ' + AST[nv])); }
      catch (err) { toast(err.message, 'bad'); render(); }
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.dataset.c === 'q') { ui.q = e.target.value; $('#plist').innerHTML = pList(); }
    if (e.target.dataset.c === 'pick') { var id = e.target.dataset.for; document.getElementById(id + '_list').innerHTML = pickList(id, e.target.value, v(id)); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else if (pinSet && hiddenAt && Date.now() - hiddenAt > 600000) { ui.locked = true; render(); } });
  // the date changes at midnight even if the app stays open (fix R5)
  var lastDay = ''; setInterval(function () { var t = today(); if (lastDay && t !== lastDay && $('#sheet').hidden) render(); lastDay = t; }, 60000);

  var lastSig = '';
  sync.on(function () {
    var sig = [sync.server.rev, sync.server.epoch, sync.outbox.length, sync.failed.length, sync.conflicts.length, !!sync.server.me].join('|');
    if (sig !== lastSig || !me()) { lastSig = sig; if (!(document.activeElement && document.activeElement.id === 'pq')) render(); else { var pl = $('#plist'); if (pl) pl.innerHTML = pList(); } }
    var chip = document.querySelector('.sync'); if (chip) { chip.className = 'sync ' + sync.status; chip.querySelector('span').textContent = statusText(); }
  });

  (async function start() {
    try { await sync.init(); } catch (e) { $('#root').innerHTML = '<p class="err" style="margin:24px">تعذّر فتح التخزين على هذا الجهاز (قد يكون التصفح الخاص مفعّلاً). ' + esc(e.message) + '</p>'; return; }
    pinSet = !!(await sync.kv.get('pin')); if (pinSet && me()) ui.locked = true;
    ui.day = today(); render(); sync.sync();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW', e); });
  })();
})();
