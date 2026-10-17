/* Ortho Practice Manager — shared money engine.
 * Runs unchanged in the browser, in Node (tests) and in Google Apps Script.
 * All money is integer piasters (1 EGP = 100). No floating-point money.
 * Dates are 'YYYY-MM-DD' strings in the clinic's local time zone (Africa/Cairo).
 */
var Ledger = (function () {
  'use strict';

  /* ---------- dates ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(s) { var p = s.split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function fmt(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addDays(s, n) {
    var p = parse(s), t = Date.UTC(p.y, p.m - 1, p.d) + n * 864e5, d = new Date(t);
    return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  /** Month arithmetic. `day` (1–31) is clamped to the month's last day: day 31 in Feb -> 28/29. */
  function addMonths(s, n, day) {
    var p = parse(s), idx = p.y * 12 + (p.m - 1) + n, y = Math.floor(idx / 12), m = idx % 12 + 1;
    var want = day == null ? p.d : day;
    return fmt(y, m, Math.min(want, daysIn(y, m)));
  }
  function monthOf(s) { return s.slice(0, 7); }
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  function monthEnd(s) { var p = parse(s); return fmt(p.y, p.m, daysIn(p.y, p.m)); }
  function todayIn(tz, now) {
    // 'en-CA' formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now || new Date());
  }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = parse(s); return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= daysIn(p.y, p.m);
  }

  /* ---------- money ---------- */
  /** Parse a typed amount ("1500", "1,500.5", Arabic digits) to piasters, or null if invalid. */
  function toPiasters(input) {
    var s = String(input == null ? '' : input).trim()
      .replace(/[٠-٩]/g, function (c) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(c); })
      .replace(/[۰-۹]/g, function (c) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(c); })
      .replace(/٫/g, '.').replace(/[,٬\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var parts = s.split('.'), whole = +parts[0], frac = parts[1] ? +((parts[1] + '0').slice(0, 2)) : 0;
    var v = whole * 100 + frac;
    return v <= 9e13 ? v : null;
  }
  /** Integer division n/d rounded half-to-even (banker's rounding) — no drift when summing many splits. */
  function roundDiv(n, d) {
    var neg = (n < 0) !== (d < 0); n = Math.abs(n); d = Math.abs(d);
    var q = Math.floor(n / d), r = n - q * d, twice = r * 2;
    if (twice > d || (twice === d && q % 2 === 1)) q++;
    return neg ? -q : q;
  }
  /** pct may have up to 2 decimals (e.g. 70 or 33.33). Returns integer piasters. */
  function pctOf(amount, pct) { return roundDiv(amount * Math.round(pct * 100), 10000); }

  /* ---------- agreements ---------- */
  function agreementAt(agreements, cid, date) {
    for (var i = 0; i < agreements.length; i++) {
      var a = agreements[i];
      if (a.cid === cid && a.from <= date && (!a.to || date <= a.to)) return a;
    }
    return null;
  }
  /** Doctor/clinic split of a cash amount (positive or negative) under an agreement. Frozen on the entry. */
  function splitCash(cash, a) {
    if (!a) return null;
    var doc = a.method === 'fixed' ? 0 : pctOf(cash, a.pct);
    return { agId: a.id, pct: a.method === 'fixed' ? 0 : a.pct, docAmt: doc, cliAmt: cash - doc };
  }
  /** Who carries a lab order's cost, frozen at order time from the agreement's lab rule. */
  function splitLab(cost, a) {
    var rule = a ? a.lab : 'separate';
    if (rule === 'deduct' && a.method !== 'fixed') { var d = pctOf(cost, a.pct); return { resp: rule, labDoc: d, labCli: cost - d }; }
    if (rule === 'doctor') return { resp: rule, labDoc: cost, labCli: 0 };
    if (rule === 'clinic') return { resp: rule, labDoc: 0, labCli: cost };
    return { resp: rule, labDoc: 0, labCli: 0 }; // separate / patient: tracked only
  }

  /* ---------- ledger effects ---------- */
  function indexById(rows) { var m = {}; for (var i = 0; i < rows.length; i++) m[rows[i].id] = rows[i]; return m; }
  /** Signed effect of one entry on cash collected, charges and discounts. Reversals negate their target. */
  function effect(e, byId) {
    var z = { cash: 0, charge: 0, discount: 0 };
    if (e.type === 'payment') z.cash = e.amt;
    else if (e.type === 'refund') z.cash = -e.amt;
    else if (e.type === 'charge') z.charge = e.amt;
    else if (e.type === 'discount') z.discount = e.amt;
    else if (e.type === 'reversal') {
      var t = byId[e.reverses]; if (t) { var x = effect(t, byId); z.cash = -x.cash; z.charge = -x.charge; z.discount = -x.discount; }
    }
    return z;
  }
  function reversedSet(entries) { var s = {}; entries.forEach(function (e) { if (e.type === 'reversal') s[e.reverses] = true; }); return s; }

  /* ---------- patient account ---------- */
  /**
   * plan: {fee, initial, monthly, payDay, start, status, pausedFrom}
   * entries: all ledger entries of this patient (any clinic — one shared plan).
   * Returns totals, installment schedule with allocation, overdue and missed months.
   */
  function account(plan, entries, today) {
    var byId = indexById(entries), rev = reversedSet(entries);
    var paid = 0, refunded = 0, charges = 0, discounts = 0;
    entries.forEach(function (e) {
      var x = effect(e, byId);
      if (x.cash > 0) paid += x.cash; else refunded -= x.cash;
      charges += x.charge; discounts += x.discount;
    });
    var cash = paid - refunded;
    var balance = plan.fee + charges - discounts - cash;

    // schedule: down payment, monthly items for (fee - discounts), then extra charges (fix T5)
    var base = Math.max(0, plan.fee - discounts), items = [];
    var first = Math.min(plan.initial, base);
    items.push({ key: 'i0', label: 'المقدم', due: plan.start, amt: first, cover: 0 });
    var rem = base - first, n = 1;
    while (rem > 0 && plan.monthly > 0 && n <= 360) {
      var a = Math.min(plan.monthly, rem);
      items.push({ key: 'm' + n, label: 'قسط ' + n, n: n, due: addMonths(monthStart(plan.start), n, plan.payDay), amt: a, cover: 0 });
      rem -= a; n++;
    }
    if (rem > 0) items.push({ key: 'rest', label: 'المتبقي', due: addMonths(monthStart(plan.start), n, plan.payDay), amt: rem, cover: 0 });
    entries.forEach(function (e) {
      if (e.type === 'charge' && !rev[e.id]) items.push({ key: 'c:' + e.id, label: 'رسوم إضافية', due: e.date, amt: e.amt, cover: 0, note: e.note || '' });
    });
    items.sort(function (x, y) { return x.due < y.due ? -1 : x.due > y.due ? 1 : 0; });
    var byKey = {}; items.forEach(function (it) { byKey[it.key] = it; });

    // allocation: payments tied to an item first, the rest oldest-first; refunds take back from newest
    var pool = 0;
    entries.forEach(function (e) {
      if (rev[e.id] || e.type === 'reversal') return;           // reversed pairs cancel out
      if (e.type === 'payment') {
        var it = e.inst ? byKey[e.inst] : null;
        if (it) { var c = Math.min(e.amt, it.amt - it.cover); it.cover += c; pool += e.amt - c; }
        else pool += e.amt;
      } else if (e.type === 'refund') pool -= e.amt;
    });
    entries.forEach(function (e) { // a reversed refund puts money back
      if (e.type === 'reversal' && byId[e.reverses] && byId[e.reverses].type === 'refund') pool += byId[e.reverses].amt;
    });
    items.forEach(function (it) { var c = Math.min(Math.max(pool, 0), it.amt - it.cover); if (c > 0) { it.cover += c; pool -= c; } });
    for (var k = items.length - 1; k >= 0 && pool < 0; k--) { var back = Math.min(items[k].cover, -pool); items[k].cover -= back; pool += back; }

    var overdue = 0, soon = addDays(today, 7);
    items.forEach(function (it) {
      var open = it.cover < it.amt, paused = plan.status === 'paused' && plan.pausedFrom && it.due >= plan.pausedFrom;
      if (!open) it.st = 'paid';
      else if (paused) it.st = 'paused';
      else if (it.due < today) it.st = it.cover > 0 ? 'partial-late' : 'overdue';
      else if (it.cover > 0) it.st = 'partial';
      else if (it.due <= soon) it.st = 'due';
      else it.st = 'upcoming';
      it.late = open && !paused && it.due < today;
      if (it.late) overdue += it.amt - it.cover;
    });
    var missed = 0, past = items.filter(function (it) { return it.due < today && it.key.charAt(0) !== 'c'; });
    for (var j = past.length - 1; j >= 0; j--) { if (past[j].late) missed++; else break; }
    var next = null; for (var q = 0; q < items.length; q++) if (items[q].cover < items[q].amt && items[q].st !== 'paused') { next = items[q]; break; }
    return {
      paid: paid, refunded: refunded, cash: cash, charges: charges, discounts: discounts,
      total: plan.fee + charges - discounts, balance: balance, credit: balance < 0 ? -balance : 0,
      items: items, overdue: overdue, missed: missed, next: next
    };
  }

  /* ---------- clinic accounts ---------- */
  /**
   * data: {agreements, ledger, appts, labs, settlements}
   * Doctor and clinic shares come from the split frozen on each entry (agreement changes never
   * rewrite history). Fixed visit fees use the agreement on the visit date.
   */
  function clinicCalc(data, cid, from, to) {
    var r = { cid: cid, from: from, to: to, payments: 0, refunds: 0, coll: 0, docFromColl: 0, visits: 0, fees: 0,
      docGross: 0, cliGross: 0, labCost: 0, labDoc: 0, labCli: 0, docNet: 0, cliNet: 0, settled: 0, byAgreement: {} };
    var byId = indexById(data.ledger);
    data.ledger.forEach(function (e) {
      if (e.cid !== cid || e.date < from || e.date > to) return;
      var x = effect(e, byId); if (!x.cash) return;
      if (x.cash > 0) r.payments += x.cash; else r.refunds -= x.cash;
      r.coll += x.cash; r.docFromColl += e.docAmt || 0;
      var g = r.byAgreement[e.agId || '?'] || (r.byAgreement[e.agId || '?'] = { agId: e.agId, pct: e.pct, coll: 0, doc: 0 });
      g.coll += x.cash; g.doc += e.docAmt || 0;
    });
    (data.appts || []).forEach(function (ap) {
      if (ap.cid !== cid || ap.status !== 'attended' || ap.date < from || ap.date > to) return;
      var a = agreementAt(data.agreements, cid, ap.date);
      if (a && a.method !== 'pct') { r.visits++; r.fees += a.fee; }
    });
    (data.labs || []).forEach(function (l) {
      if (l.cid !== cid || l.status === 'cancelled' || l.orderedAt < from || l.orderedAt > to) return;
      r.labCost += l.cost; r.labDoc += l.labDoc || 0; r.labCli += l.labCli || 0;
    });
    r.docGross = r.docFromColl + r.fees;
    r.cliGross = r.coll - r.docGross;
    r.docNet = r.docGross - r.labDoc;
    r.cliNet = r.cliGross - r.labCli;           // fix T7: lab money is not called "clinic share"
    (data.settlements || []).forEach(function (s) { if (s.cid === cid && s.date >= from && s.date <= to) r.settled += s.amt; });
    return r;
  }
  /** Doctor's net entitlement to date minus everything the clinic has paid him. Negative = clinic paid ahead. */
  function owed(data, cid, upTo) { var r = clinicCalc(data, cid, '0000-01-01', upTo); return r.docNet - r.settled; }

  /* ---------- text ---------- */
  /** Arabic search normalisation: أإآ->ا, ة->ه, ى->ي, strip diacritics/tatweel, Arabic digits -> Latin. */
  function normalize(s) {
    return String(s || '').toLowerCase()
      .replace(/[ً-ْـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .replace(/[٠-٩]/g, function (c) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(c); })
      .replace(/\s+/g, ' ').trim();
  }
  /** Neutralise spreadsheet formulas in exported text (fix T11). */
  function safeCell(v) {
    if (typeof v !== 'string') return v;
    return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  }

  return {
    pad: pad, addDays: addDays, addMonths: addMonths, monthOf: monthOf, monthStart: monthStart, monthEnd: monthEnd,
    todayIn: todayIn, isDate: isDate, daysIn: daysIn,
    toPiasters: toPiasters, roundDiv: roundDiv, pctOf: pctOf,
    agreementAt: agreementAt, splitCash: splitCash, splitLab: splitLab,
    effect: effect, indexById: indexById, reversedSet: reversedSet,
    account: account, clinicCalc: clinicCalc, owed: owed,
    normalize: normalize, safeCell: safeCell
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ledger;
