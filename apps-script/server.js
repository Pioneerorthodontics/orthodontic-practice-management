/* Ortho Practice Manager — Google Apps Script backend.
 * Built into one file (Code.gs) together with shared/ledger.js and shared/core.js by tools/build.js.
 *
 * Script Properties (Project Settings → Script properties):
 *   CLIENT_ID   Google OAuth web client ID used by the app's sign-in button (required)
 *   APP_ORIGIN  e.g. https://yourname.github.io (informational)
 * Set automatically by setup(): DB_ID, BACKUP_FOLDER_ID, EXCEL_FOLDER_ID
 */
var TZ = 'Africa/Cairo';
var APP_VERSION = '1.0.0';
var KEEP_HOURLY = 48, KEEP_DAILY_DAYS = 30, KEEP_EXCEL = 30;

function props_() { return PropertiesService.getScriptProperties(); }
function db_() { return SpreadsheetApp.openById(props_().getProperty('DB_ID')); }

/* =========================================================
 * One-time setup — run from the editor: select "setup" and press Run.
 * ========================================================= */
function setup() {
  var p = props_(), me = Session.getEffectiveUser().getEmail();
  if (!p.getProperty('CLIENT_ID')) throw new Error('Add the CLIENT_ID script property first (see DEPLOY.md, step 4).');
  var ss;
  if (p.getProperty('DB_ID')) ss = SpreadsheetApp.openById(p.getProperty('DB_ID'));
  else { ss = SpreadsheetApp.create('Ortho DB'); p.setProperty('DB_ID', ss.getId()); }

  Core.TABLES.forEach(function (t) { ensureTab_(ss, t, header_(t)); });
  ensureTab_(ss, 'meta', ['key', 'value']);
  ensureTab_(ss, 'backupLog', ['at', 'kind', 'status', 'fileId', 'name', 'details']);
  var first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  var meta = readMeta_(ss);
  if (!meta.epoch) writeMeta_(ss, { rev: 0, patientSeq: 0, epoch: String(Date.now()) });

  // the deploying Google account becomes the doctor (owner)
  var users = ss.getSheetByName('users').getDataRange().getValues();
  var exists = users.some(function (r) { return String(r[1]).toLowerCase() === me.toLowerCase(); });
  if (!exists) {
    var store = loadStore_(ss), ctx = { user: { id: 'u-owner', email: me, role: 'doctor' }, now: new Date().toISOString() };
    store.insert('users', { id: 'u-owner', email: me.toLowerCase(), name: 'الطبيب', role: 'doctor', clinics: [], canPay: true, active: true }, ctx);
    persist_(ss, store);
  }
  ss.getSheets().forEach(function (sh) {             // warn anyone who tries to type in the database
    if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) sh.protect().setDescription('Written by the app only').setWarningOnly(true);
  });

  if (!p.getProperty('BACKUP_FOLDER_ID')) p.setProperty('BACKUP_FOLDER_ID', DriveApp.createFolder('Ortho Backups').getId());
  if (!p.getProperty('EXCEL_FOLDER_ID')) p.setProperty('EXCEL_FOLDER_ID', DriveApp.createFolder('Ortho Excel').getId());

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('hourlyBackup').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyExport').timeBased().atHour(2).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('nightlyCheck').timeBased().atHour(3).everyDays(1).inTimezone(TZ).create();

  hourlyBackup();
  Logger.log('Setup done. Database: ' + ss.getUrl() + '  Owner: ' + me);
}

function header_(t) { return Core.SCHEMA[t].map(function (c) { return c.split(':')[0]; }).concat(Core.META); }
function types_(t) {
  var m = {}; Core.SCHEMA[t].forEach(function (c) { var p = c.split(':'); m[p[0]] = p[1] || 's'; });
  m.version = 'n'; m.rev = 'n'; return m;
}
function ensureTab_(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(header);
  else {
    var cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    header.forEach(function (h) { if (cur.indexOf(h) < 0) { sh.getRange(1, sh.getLastColumn() + 1).setValue(h); } }); // additive schema change
  }
  // plain-text format stops Sheets turning "2026-10-17" or "=x" into dates or formulas
  var types = Core.SCHEMA[name] ? types_(name) : {};
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  hdr.forEach(function (h, i) { if (types[h] !== 'n' && types[h] !== 'b') sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@'); });
  sh.setFrozenRows(1);
  return sh;
}

/* =========================================================
 * Sheet <-> store
 * ========================================================= */
function readMeta_(ss) {
  var sh = ss.getSheetByName('meta'), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) { out[r[0]] = r[1]; });
  return out;
}
function writeMeta_(ss, m) {
  var sh = ss.getSheetByName('meta'), keys = Object.keys(m);
  sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1 || 1), 2).clearContent();
  sh.getRange(2, 1, keys.length, 2).setValues(keys.map(function (k) { return [k, String(m[k])]; }));
}
function cellIn_(v, type, name) {
  if (v === '' || v == null) return type === 'n' ? 0 : type === 'b' ? false : type === 'j' ? null : '';
  if (type === 'n') return Number(v);
  if (type === 'b') return v === true || v === 'TRUE' || v === 'true';
  if (type === 'j') { try { return JSON.parse(v); } catch (e) { return null; } }
  if (v instanceof Date) return /At$|^at$/.test(name) ? v.toISOString() : Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v);
}
function cellOut_(v, type) {
  if (v == null) return '';
  if (type === 'n') return Number(v) || 0;
  if (type === 'b') return !!v;
  if (type === 'j') return JSON.stringify(v);
  return Ledger.safeCell(String(v)); // text never becomes a formula (fix T11)
}
function loadStore_(ss) {
  var tables = {}, rowIndex = {};
  Core.TABLES.forEach(function (t) {
    var sh = ss.getSheetByName(t), types = types_(t), rows = [];
    rowIndex[t] = {};
    if (sh.getLastRow() >= 2) {
      var vals = sh.getDataRange().getValues(), hdr = vals[0];
      for (var i = 1; i < vals.length; i++) {
        var o = {}; hdr.forEach(function (h, j) { if (h) o[h] = cellIn_(vals[i][j], types[h] || 's', h); });
        if (!o.id) continue;
        rows.push(o); rowIndex[t][o.id] = i + 1;
      }
    }
    tables[t] = rows;
  });
  var meta = readMeta_(ss);
  var store = new Core.Store(tables, meta);
  store.rowIndex = rowIndex; store.epoch = meta.epoch || '';
  return store;
}
function persist_(ss, store) {
  Object.keys(store.dirty).forEach(function (t) {
    var sh = ss.getSheetByName(t), hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], types = types_(t);
    var toRow = function (o) { return hdr.map(function (h) { return cellOut_(o[h], types[h] || 's'); }); };
    var appends = [];
    Object.keys(store.dirty[t]).forEach(function (id) {
      var o = store.get(t, id); if (!o) return;
      var at = store.rowIndex && store.rowIndex[t][id];
      if (at) sh.getRange(at, 1, 1, hdr.length).setValues([toRow(o)]);
      else appends.push(toRow(o));
    });
    if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, hdr.length).setValues(appends);
  });
  var m = readMeta_(ss); m.rev = store.rev; m.patientSeq = store.patientSeq; writeMeta_(ss, m);
  SpreadsheetApp.flush();
}

/* =========================================================
 * Web API
 * ========================================================= */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'ortho', version: APP_VERSION })).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  var out;
  try { out = handle_(JSON.parse(e.postData.contents || '{}')); }
  catch (err) { console.error(err && err.stack || err); out = { ok: false, error: 'خطأ في الخادم. حاول مرة أخرى.', code: 'server' }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  var email = verifyIdToken_(req.idToken);
  if (!email) return { ok: false, error: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.', code: 'auth' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'الخادم مشغول. ستتم المحاولة تلقائياً.', code: 'busy' };
  try {
    var ss = db_(), store = loadStore_(ss);
    var user = store.list('users').filter(function (u) { return u.email === email && u.active !== false; })[0];
    if (!user) return { ok: false, error: 'هذا الحساب (' + email + ') غير مسموح له. اطلب من الطبيب إضافته.', code: 'forbidden' };
    var ctx = { user: user, today: Ledger.todayIn(TZ), now: new Date().toISOString() };
    var res = { ok: true, today: ctx.today, serverTime: ctx.now, epoch: store.epoch, me: user, results: {} };

    if (req.action === 'sync' || !req.action) {
      (req.ops || []).slice(0, 50).forEach(function (op) { res.results[op.opId] = Core.apply(store, op, ctx); });
      if (Object.keys(store.dirty).length) persist_(ss, store);
      var since = req.epoch === store.epoch ? (+req.sinceRev || 0) : 0;
      var ch = Core.changesSince(store, user, since);
      res.rows = ch.rows; res.rev = ch.rev; res.full = since === 0;
      return res;
    }
    if (!Core.isDoc(user)) return { ok: false, error: 'هذه العملية للطبيب فقط.', code: 'forbidden' };
    if (req.action === 'backups') { res.backups = listBackups_(); res.log = readLog_(ss, 40); return res; }
    if (req.action === 'backupNow') { lock.releaseLock(); lock = null; res.backup = hourlyBackup(); return res; }
    if (req.action === 'exportNow') { lock.releaseLock(); lock = null; res.export = dailyExport(); return res; }
    if (req.action === 'restore') {
      if (req.confirm !== 'RESTORE') return { ok: false, error: 'اكتب RESTORE للتأكيد.', code: 'invalid' };
      res.restore = restore_(ss, req.fileId, email); return res;
    }
    return { ok: false, error: 'طلب غير معروف.', code: 'unknown' };
  } finally { if (lock) lock.releaseLock(); }
}

/** Checks a Google sign-in ID token with Google and returns the verified email, or null. */
function verifyIdToken_(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  var cache = CacheService.getScriptCache();
  var key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var hit = cache.get(key); if (hit) return hit;
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  var t = JSON.parse(r.getContentText()), now = Date.now() / 1000;
  if (t.aud !== props_().getProperty('CLIENT_ID')) return null;
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') return null;
  if (String(t.email_verified) !== 'true' || +t.exp <= now) return null;
  var email = String(t.email).toLowerCase();
  cache.put(key, email, Math.max(1, Math.min(300, Math.floor(+t.exp - now))));
  return email;
}

/* =========================================================
 * Backups, Excel snapshots, checks, restore
 * ========================================================= */
function stamp_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH-mm'); }
function log_(ss, kind, status, fileId, name, details) {
  ss.getSheetByName('backupLog').appendRow([new Date().toISOString(), kind, status, fileId || '', name || '', Ledger.safeCell(details || '')]);
}
function readLog_(ss, n) {
  var sh = ss.getSheetByName('backupLog'), last = sh.getLastRow(); if (last < 2) return [];
  var from = Math.max(2, last - n + 1);
  return sh.getRange(from, 1, last - from + 1, 6).getValues().reverse().map(function (r) { return { at: String(r[0]), kind: r[1], status: r[2], fileId: r[3], name: r[4], details: r[5] }; });
}
function counts_(ss) {
  var c = {}; Core.TABLES.forEach(function (t) { var sh = ss.getSheetByName(t); c[t] = sh ? Math.max(0, sh.getLastRow() - 1) : -1; }); return c;
}

/** Hourly trigger: copy the whole database to the Backups folder, then prune old copies. */
function hourlyBackup() {
  var ss = db_(), lock = LockService.getScriptLock(); lock.waitLock(30000);
  var file, name = 'Ortho DB backup ' + stamp_();
  try { SpreadsheetApp.flush(); file = DriveApp.getFileById(ss.getId()).makeCopy(name, DriveApp.getFolderById(props_().getProperty('BACKUP_FOLDER_ID'))); }
  finally { lock.releaseLock(); }
  log_(ss, 'backup', 'ok', file.getId(), name, JSON.stringify(counts_(ss)));
  pruneBackups_();
  return { fileId: file.getId(), name: name };
}
function listBackups_() {
  var it = DriveApp.getFolderById(props_().getProperty('BACKUP_FOLDER_ID')).getFiles(), out = [];
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) out.push({ id: f.getId(), name: f.getName(), created: f.getDateCreated().toISOString() }); }
  return out.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
}
/** Keep the newest 48 copies, plus the first copy of each day for 30 days. */
function pruneBackups_() {
  var all = listBackups_(), keepDay = {}, cutoff = new Date(Date.now() - KEEP_DAILY_DAYS * 864e5).toISOString();
  all.slice().reverse().forEach(function (b) { var d = b.created.slice(0, 10); if (!keepDay[d]) keepDay[d] = b.id; });
  all.forEach(function (b, i) {
    if (i < KEEP_HOURLY || /pre-restore/.test(b.name)) return;
    if (b.created >= cutoff && keepDay[b.created.slice(0, 10)] === b.id) return;
    DriveApp.getFileById(b.id).setTrashed(true);
  });
}

/** Daily trigger: export the database as an .xlsx snapshot into the Excel folder and verify it. */
function dailyExport() {
  var ss = db_(), id = ss.getId(), name = 'Ortho snapshot ' + stamp_() + '.xlsx';
  try {
    var resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('export HTTP ' + resp.getResponseCode());
    var blob = resp.getBlob().setName(name);
    if (blob.getBytes().length < 1000) throw new Error('export too small');
    var folder = DriveApp.getFolderById(props_().getProperty('EXCEL_FOLDER_ID'));
    var f = folder.createFile(blob);
    var back = DriveApp.getFileById(f.getId());                     // read back = upload verified
    if (back.getSize() !== blob.getBytes().length) throw new Error('size mismatch after upload');
    var manifest = { snapshot: f.getId(), at: new Date().toISOString(), app: APP_VERSION, schema: 1, counts: counts_(ss), rev: readMeta_(ss).rev };
    log_(ss, 'excel', 'ok', f.getId(), name, JSON.stringify(manifest));
    var files = [], it = folder.getFiles(); while (it.hasNext()) files.push(it.next());
    files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); }).slice(KEEP_EXCEL).forEach(function (x) { x.setTrashed(true); });
    return { fileId: f.getId(), name: name, url: f.getUrl() };
  } catch (err) {
    log_(ss, 'excel', 'failed', '', name, String(err));
    notify_('Excel snapshot failed: ' + err);
    throw err;
  }
}

/** Nightly trigger: open the newest backup and check that it is complete and readable. */
function nightlyCheck() {
  var ss = db_(), b = listBackups_()[0];
  if (!b) { log_(ss, 'check', 'failed', '', '', 'no backup found'); notify_('No backup found.'); return; }
  try {
    var copy = SpreadsheetApp.openById(b.id), problems = [], live = counts_(ss), got = counts_(copy);
    Core.TABLES.forEach(function (t) {
      if (got[t] < 0) problems.push(t + ' missing');
      else if (got[t] > live[t]) problems.push(t + ' has more rows than live');
    });
    var store = loadStore_(copy);                                   // parse every row: proves it can be restored
    var sum = store.list('ledger').reduce(function (a, e) { return a + (e.amt || 0); }, 0);
    if (!isFinite(sum)) problems.push('ledger amounts unreadable');
    log_(ss, 'check', problems.length ? 'failed' : 'ok', b.id, b.name, problems.join('; ') || JSON.stringify(got));
    if (problems.length) notify_('Backup check failed: ' + problems.join('; '));
  } catch (err) { log_(ss, 'check', 'failed', b.id, b.name, String(err)); notify_('Backup check failed: ' + err); }
}

/** Replace live data with a backup. A pre-restore copy is made first. Devices then reload everything. */
function restore_(ss, fileId, by) {
  var src = SpreadsheetApp.openById(fileId);
  if (DriveApp.getFileById(fileId).getParents().next().getId() !== props_().getProperty('BACKUP_FOLDER_ID')) throw new Error('not a backup');
  var pre = DriveApp.getFileById(ss.getId()).makeCopy('Ortho DB pre-restore ' + stamp_(), DriveApp.getFolderById(props_().getProperty('BACKUP_FOLDER_ID')));
  var test = loadStore_(src); // validate before touching live data
  Core.TABLES.forEach(function (t) {
    var from = src.getSheetByName(t), to = ss.getSheetByName(t), vals = from.getDataRange().getValues();
    to.clearContents(); to.getRange(1, 1, vals.length, vals[0].length).setValues(vals);
  });
  var meta = readMeta_(ss), newRev = Math.max(+meta.rev || 0, test.rev) + 1;
  writeMeta_(ss, { rev: newRev, patientSeq: Math.max(+meta.patientSeq || 0, test.patientSeq), epoch: String(Date.now()) });
  log_(ss, 'restore', 'ok', fileId, src.getName(), 'by ' + by + '; pre-restore copy ' + pre.getId());
  return { restoredFrom: src.getName(), preRestoreCopy: pre.getId() };
}

function notify_(msg) {
  try { MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Ortho app: ' + msg.slice(0, 80), msg); } catch (e) { console.error(e); }
}
