// Minimal in-memory stand-ins for the Google Apps Script services the backend uses.
// Good enough to run the real server code in Node; NOT a substitute for one real test on Google.
const vm = require('vm'), fs = require('fs'), path = require('path'), crypto = require('crypto');

function makeEnv(opts = {}) {
  const files = {}; let idN = 0; const nid = p => p + (++idN);
  const props = Object.assign({ CLIENT_ID: 'client-123' }, opts.props || {});
  const tokens = opts.tokens || {};
  const mail = [];

  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(((this.sh.data[this.r - 1 + i] || [])[this.c - 1 + j]) ?? ''); out.push(row); } return out; }
    setValues(v) {
      if (v.length !== this.nr || v.some(r => r.length !== this.nc)) throw new Error('setValues size mismatch');
      v.forEach((row, i) => row.forEach((x, j) => {
        const rr = this.r - 1 + i; this.sh.data[rr] = this.sh.data[rr] || [];
        // Sheets: a leading apostrophe forces text and is not stored; an unescaped "=" would become a formula
        if (typeof x === 'string' && x.startsWith("'")) x = x.slice(1);
        else if (typeof x === 'string' && x.startsWith('=')) x = '#FORMULA:' + x;
        this.sh.data[rr][this.c - 1 + j] = x;
      })); return this;
    }
    setValue(x) { return this.setValues([[x]]); }
    clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.sh.data[this.r - 1 + i]) this.sh.data[this.r - 1 + i][this.c - 1 + j] = ''; return this; }
    setNumberFormat() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.prot = []; }
    getName() { return this.name; }
    getLastRow() { let n = 0; this.data.forEach((r, i) => { if (r && r.some(x => x !== '' && x != null)) n = i + 1; }); return n; }
    getLastColumn() { return Math.max(0, ...this.data.map(r => (r || []).length)); }
    getMaxRows() { return 1000; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    appendRow(row) { this.data[this.getLastRow()] = row.slice(); }
    clearContents() { this.data = []; }
    setFrozenRows() {}
    protect() { const p = { setDescription: () => p, setWarningOnly: () => p }; this.prot.push(p); return p; }
    getProtections() { return this.prot; }
  }
  class Spreadsheet {
    constructor(name) { this.id = nid('ss'); this.name = name; this.sheets = [new Sheet('Sheet1')]; files[this.id] = { kind: 'ss', obj: this, name, parents: [], created: new Date(Date.now() + idN) }; }
    getId() { return this.id; } getName() { return files[this.id].name; } getUrl() { return 'https://sheet/' + this.id; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getSheets() { return this.sheets; } deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  }
  const fileApi = id => {
    const f = files[id]; if (!f) throw new Error('no file ' + id);
    return {
      getId: () => id, getName: () => f.name, isTrashed: () => !!f.trashed, setTrashed: v => { f.trashed = v; },
      getDateCreated: () => f.created, getSize: () => f.size || 0, getUrl: () => 'https://drive/' + id,
      getParents: () => { let i = 0; return { hasNext: () => i < f.parents.length, next: () => ({ getId: () => f.parents[i++] }) }; },
      makeCopy: (name, folder) => {
        const src = f.obj, c = new Spreadsheet(name); c.sheets = src.sheets.map(s => { const n = new Sheet(s.name); n.data = JSON.parse(JSON.stringify(s.data)); return n; });
        files[c.id].parents = [folder.getId()]; return fileApi(c.id);
      }
    };
  };
  const folderApi = id => ({
    getId: () => id,
    getFiles: () => { const list = Object.keys(files).filter(k => files[k].parents.includes(id)); let i = 0; return { hasNext: () => i < list.length, next: () => fileApi(list[i++]) }; },
    createFile: blob => { const fid = nid('f'); files[fid] = { kind: 'blob', name: blob.getName(), parents: [id], size: blob.getBytes().length, created: new Date(Date.now() + idN) }; return fileApi(fid); }
  });
  const makeBlob = (bytes, name) => ({ getBytes: () => bytes, setName(n) { name = n; return this; }, getName: () => name });

  const g = {
    console, JSON, Math, Date, Object, Array, String, Number, Intl, isFinite, encodeURIComponent, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    SpreadsheetApp: {
      create: n => new Spreadsheet(n), openById: id => { if (!files[id] || files[id].kind !== 'ss') throw new Error('no ss'); return files[id].obj; }, flush() {},
      ProtectionType: { SHEET: 'SHEET' }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => { const m = g.__cache || (g.__cache = {}); return { get: k => m[k] || null, put: (k, v) => { m[k] = v; } }; } },
    UrlFetchApp: {
      fetch: (url) => {
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          const t = decodeURIComponent(url.split('id_token=')[1]); const info = tokens[t];
          return { getResponseCode: () => info ? 200 : 400, getContentText: () => JSON.stringify(info || {}) };
        }
        if (url.includes('/export?format=xlsx')) return { getResponseCode: () => opts.exportCode || 200, getBlob: () => makeBlob(new Array(5000).fill(1), 'x.xlsx') };
        throw new Error('unexpected fetch ' + url);
      }
    },
    DriveApp: { getFileById: fileApi, getFolderById: folderApi, createFolder: n => { const id = nid('dir'); files[id] = { kind: 'dir', name: n, parents: [], created: new Date() }; return folderApi(id); } },
    ScriptApp: {
      getProjectTriggers: () => g.__triggers || [], deleteTrigger() {}, getOAuthToken: () => 'oauth',
      newTrigger: fn => { const t = { fn }; const b = { timeBased: () => b, everyHours: h => { t.hours = h; return b; }, atHour: h => { t.at = h; return b; }, everyDays: () => b, inTimezone: () => b, create: () => { (g.__triggers = g.__triggers || []).push(t); return t; } }; return b; }
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.owner || 'doctor@gmail.com' }) },
    Utilities: {
      formatDate: (d, tz, f) => { const s = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {}); return f.replace('yyyy', s.year).replace('MM', s.month).replace('dd', s.day).replace('HH', s.hour).replace('mm', s.minute); },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(s).digest()), base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'), DigestAlgorithm: { SHA_256: 'sha256' }
    },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    MailApp: { sendEmail: (to, subj, body) => mail.push({ to, subj, body }) },
    Logger: { log() {} }
  };
  g.globalThis = g;
  const ctx = vm.createContext(g);
  const root = path.join(__dirname, '..');
  const code = ['shared/ledger.js', 'shared/core.js', 'apps-script/server.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
  vm.runInContext(code.replace(/if \(typeof module !== 'undefined' && module\.exports\) module\.exports = \w+;/g, ''), ctx, { filename: 'Code.gs' });
  ctx.__files = files; ctx.__props = props; ctx.__mail = mail;
  ctx.post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return ctx;
}
module.exports = { makeEnv };
