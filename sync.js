/* Offline storage (IndexedDB) and synchronisation with the Apps Script server.
 * - Every change is first written to the outbox on the device (survives reloads and restarts).
 * - The outbox is sent every 60 s while the app is open, right after each save, and when the
 *   connection returns. Each op has a unique opId, so a resend never creates a duplicate.
 * - An op leaves the outbox only after the server answers for it. "Synced" means server-confirmed.
 */
(function () {
  'use strict';
  var DB_NAME = 'ortho', DB_VER = 1, INTERVAL = 60000, MAX_BACKOFF = 300000;

  /* ---------- tiny IndexedDB helper ---------- */
  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () { var db = r.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function tx(db, store, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), s = t.objectStore(store), out;
      out = fn(s);
      t.oncomplete = function () { res(out && 'result' in out ? out.result : out); };
      t.onerror = t.onabort = function () { rej(t.error || new Error('IndexedDB write failed')); };
    });
  }
  var idb = {
    get: function (db, k) { return tx(db, 'kv', 'readonly', function (s) { return s.get(k); }); },
    put: function (db, k, v) { return tx(db, 'kv', 'readwrite', function (s) { s.put(v, k); }); },
    del: function (db, k) { return tx(db, 'kv', 'readwrite', function (s) { s.delete(k); }); },
    all: function (db) { return tx(db, 'outbox', 'readonly', function (s) { return s.getAll(); }); },
    add: function (db, v) { return tx(db, 'outbox', 'readwrite', function (s) { s.add(v); }); },
    remove: function (db, seqs) { return tx(db, 'outbox', 'readwrite', function (s) { seqs.forEach(function (q) { s.delete(q); }); }); },
    clear: function (db) { return Promise.all([tx(db, 'kv', 'readwrite', function (s) { s.clear(); }), tx(db, 'outbox', 'readwrite', function (s) { s.clear(); })]); }
  };

  function emptyTables() { var t = {}; Core.TABLES.forEach(function (n) { t[n] = []; }); return t; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function Sync(cfg) {
    this.cfg = cfg; this.db = null; this.listeners = [];
    this.server = { tables: emptyTables(), rev: 0, epoch: '', me: null, today: '' };
    this.outbox = []; this.failed = []; this.conflicts = [];
    this.status = 'idle'; this.lastOk = null; this.lastError = ''; this.busy = false; this.backoff = 0;
    this.token = null; this.viewCache = null; this.timer = null; this.soonTimer = null;
  }
  Sync.prototype.on = function (fn) { this.listeners.push(fn); };
  Sync.prototype.emit = function () { this.viewCache = null; var s = this; this.listeners.forEach(function (f) { try { f(s); } catch (e) { console.error(e); } }); };

  Sync.prototype.init = async function () {
    this.db = await openDb();
    var srv = await idb.get(this.db, 'server'); if (srv) { this.server = srv; Core.TABLES.forEach(function (n) { if (!srv.tables[n]) srv.tables[n] = []; }); }
    this.outbox = await idb.all(this.db);
    this.failed = (await idb.get(this.db, 'failed')) || [];
    this.conflicts = (await idb.get(this.db, 'conflicts')) || [];
    this.lastOk = (await idb.get(this.db, 'lastOk')) || null;
    var tok = await idb.get(this.db, 'token'); if (tok && tok.exp > Date.now() + 60000) this.token = tok;
    var self = this;
    window.addEventListener('online', function () { self.backoff = 0; self.syncSoon(0); });
    window.addEventListener('offline', function () { self.setStatus(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') self.syncSoon(0); });
    this.timer = setInterval(function () { if (document.visibilityState === 'visible') self.sync(); }, INTERVAL);
    this.setStatus();
  };

  Sync.prototype.setToken = async function (idToken) {
    var exp = Date.now() + 50 * 60000;
    try { var p = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (p.exp) exp = p.exp * 1000; } catch (e) { /* dev token */ }
    this.token = { value: idToken, exp: exp };
    await idb.put(this.db, 'token', this.token);
    this.syncSoon(0);
  };
  Sync.prototype.hasToken = function () { return !!(this.token && this.token.exp > Date.now() + 30000); };

  /** Add an operation. It is written to IndexedDB before this resolves, so it is never lost. */
  Sync.prototype.enqueue = async function (type, data) {
    var op = { opId: uid(), type: type, data: data, at: new Date().toISOString() };
    await idb.add(this.db, op);
    this.outbox = await idb.all(this.db);
    this.setStatus(); this.emit(); this.syncSoon(300);
    return op;
  };

  Sync.prototype.syncSoon = function (ms) { var self = this; clearTimeout(this.soonTimer); this.soonTimer = setTimeout(function () { self.sync(); }, ms == null ? 300 : ms); };

  Sync.prototype.sync = async function (opts) {
    opts = opts || {};
    if (this.busy) return;
    if (!navigator.onLine) { this.setStatus(); return; }
    if (!this.hasToken()) { this.status = 'signin'; this.emit(); return; }
    if (this.backoff && !opts.force && Date.now() < this.nextTry) return;
    this.busy = true; this.status = 'syncing'; this.emit();
    var batch = this.outbox.slice(0, 50), self = this;
    try {
      var res = await this.post({ action: 'sync', sinceRev: this.server.rev, epoch: this.server.epoch, ops: batch.map(function (o) { return { opId: o.opId, type: o.type, data: o.data }; }) });
      if (!res.ok) {
        if (res.code === 'auth') { this.token = null; await idb.del(this.db, 'token'); this.status = 'signin'; this.lastError = res.error; return; }
        if (res.code === 'forbidden') { this.status = 'forbidden'; this.lastError = res.error; return; }
        throw new Error(res.error || 'server error');
      }
      // results: remove answered ops; keep errors and conflicts visible to the user, never silently dropped
      var done = [];
      batch.forEach(function (o) {
        var r = res.results && res.results[o.opId]; if (!r) return;
        done.push(o.seq);
        if (r.status === 'error') self.failed.push({ op: o, error: r.error, code: r.code, at: res.serverTime });
        else if (r.status === 'conflict') self.conflicts.push({ op: o, result: r, at: res.serverTime });
      });
      // rows
      if (res.full || res.epoch !== this.server.epoch) this.server.tables = emptyTables();
      Object.keys(res.rows || {}).forEach(function (t) {
        var list = self.server.tables[t] || (self.server.tables[t] = []), idx = {};
        list.forEach(function (r, i) { idx[r.id] = i; });
        res.rows[t].forEach(function (r) { if (idx[r.id] != null) list[idx[r.id]] = r; else { idx[r.id] = list.length; list.push(r); } });
      });
      this.server.rev = res.rev; this.server.epoch = res.epoch; this.server.me = res.me; this.server.today = res.today;
      await idb.put(this.db, 'server', this.server);
      await idb.put(this.db, 'failed', this.failed); await idb.put(this.db, 'conflicts', this.conflicts);
      await idb.remove(this.db, done);
      this.outbox = await idb.all(this.db);
      this.lastOk = res.serverTime; await idb.put(this.db, 'lastOk', this.lastOk);
      this.backoff = 0; this.lastError = '';
      if (this.outbox.length) this.syncSoon(200);                 // more than one batch waiting
    } catch (e) {
      this.backoff = Math.min(MAX_BACKOFF, this.backoff ? this.backoff * 2 : 5000);
      this.nextTry = Date.now() + this.backoff;
      this.lastError = navigator.onLine ? 'تعذّر الاتصال بالخادم. إعادة المحاولة بعد ' + Math.round(this.backoff / 1000) + ' ثانية.' : '';
      setTimeout(function () { self.sync(); }, this.backoff + 50);
    } finally {
      this.busy = false; if (this.status === 'syncing') this.status = ''; this.setStatus();
    }
  };

  Sync.prototype.post = async function (body) {
    body.idToken = this.token && this.token.value;
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 45000);
    try {
      var r = await fetch(this.cfg.API_URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl.signal, redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  /** Doctor-only server actions (backups, Excel export, restore). Needs a connection. */
  Sync.prototype.action = async function (name, extra) {
    if (!navigator.onLine) throw new Error('لا يوجد اتصال بالإنترنت.');
    if (!this.hasToken()) throw new Error('سجّل الدخول مرة أخرى.');
    var res = await this.post(Object.assign({ action: name }, extra || {}));
    if (!res.ok) throw new Error(res.error || 'فشل الطلب');
    return res;
  };

  Sync.prototype.setStatus = function () {
    var prev = this.status;
    if (this.busy) this.status = 'syncing';
    else if (['signin', 'forbidden'].indexOf(prev) >= 0 && !this.hasToken()) this.status = prev;
    else if (!navigator.onLine) this.status = 'offline';
    else if (this.lastError) this.status = 'error';
    else if (this.conflicts.length) this.status = 'conflict';
    else if (this.outbox.length) this.status = 'pending';
    else if (!this.lastOk) this.status = 'idle';
    else this.status = 'synced';
    this.emit();
  };

  /** Today's view = server rows + pending ops applied on a copy. Pending ops that fail locally are skipped here but stay queued. */
  Sync.prototype.view = function () {
    if (this.viewCache) return this.viewCache;
    var s = new Core.Store(clone(this.server.tables), { rev: this.server.rev });
    var me = this.me(), today = this.today(), now = new Date().toISOString(), pend = {};
    if (me) this.outbox.forEach(function (o) {
      var r = Core.apply(s, o, { user: me, today: today, now: now, local: true }, { record: false });
      pend[o.opId] = r.status;
    });
    s.pending = pend;
    return (this.viewCache = s);
  };
  /** Check an op against the current view before queueing it, so obvious mistakes show at once. */
  Sync.prototype.check = function (type, data) {
    var me = this.me(); if (!me) return { status: 'error', error: 'سجّل الدخول أولاً.' };
    var v = this.view(), s = new Core.Store(clone(v.snapshot()), v.meta());
    return Core.apply(s, { opId: 'check-' + uid(), type: type, data: data }, { user: me, today: this.today(), now: new Date().toISOString(), local: true }, { record: false });
  };
  Sync.prototype.me = function () { return this.server.me; };
  Sync.prototype.today = function () { return Ledger.todayIn('Africa/Cairo'); };

  Sync.prototype.dropFailed = async function (i) { this.failed.splice(i, 1); await idb.put(this.db, 'failed', this.failed); this.setStatus(); };
  Sync.prototype.dropConflict = async function (i) { this.conflicts.splice(i, 1); await idb.put(this.db, 'conflicts', this.conflicts); this.setStatus(); };
  Sync.prototype.wipe = async function () {
    await idb.clear(this.db);
    this.server = { tables: emptyTables(), rev: 0, epoch: '', me: null, today: '' };
    this.outbox = []; this.failed = []; this.conflicts = []; this.token = null; this.lastOk = null;
    this.setStatus();
  };
  Sync.prototype.kv = { get: function (k) { return idb.get(window.orthoSync.db, k); }, put: function (k, v) { return idb.put(window.orthoSync.db, k, v); } };

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  window.OrthoSync = Sync; window.orthoUid = uid;
})();
