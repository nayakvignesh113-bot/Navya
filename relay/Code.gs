/**
 * Navya — Patent Engine relay (Google Apps Script web app)
 * Holds the Gemini key, verifies Google sign-in, searches Google Patents / OpenAlex / the web,
 * stores reports in Drive + a Sheet, and runs the weekly Opportunity Radar.
 *
 * Script Properties (Project Settings → Script properties):
 *   GEMINI_KEY            required  Gemini API key
 *   OAUTH_CLIENT_ID       required  Google OAuth Web client ID used by the site's sign-in button
 *   OWNER_EMAILS          required  comma-separated, e.g. vignesh@mite.ac.in,nayak.vignesh113@gmail.com
 *   AUTO_APPROVE_DOMAIN   optional  e.g. mite.ac.in  (accounts on this domain are approved automatically)
 *   MODEL                 optional  default gemini-flash-latest
 *   STUDENT_DAILY_CALLS   optional  default 150 model calls per approved user per day (~4 full analyses)
 *   RADAR_EMAIL           optional  "true" to email owners the weekly radar digest
 *   CONTACT_EMAIL         optional  sent to OpenAlex as mailto (polite pool)
 * Run setup() once from the editor; it creates the Sheet, Drive folder and weekly trigger.
 */

const P = PropertiesService.getScriptProperties();
const prop = (k, d) => P.getProperty(k) || d;

// ------------------------------------------------------------------ entry points
function doGet() { return out({ ok: true, service: 'navya-relay', time: new Date().toISOString() }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad_json' }); }
  try {
    const who = auth(req.idToken);
    if (!who) return out({ ok: false, error: 'not_signed_in' });
    const a = req.action;
    if (a === 'whoami') return out({ ok: true, ...who, usedToday: used(who.email), limit: limitFor(who) });
    if (a === 'requestAccess') { requestAccess(who, req.note); return out({ ok: true, role: 'pending' }); }
    if (who.role === 'pending') return out({ ok: false, error: 'not_approved', email: who.email });

    switch (a) {
      case 'gemini': return out({ ok: true, ...gemini(who, req) });
      case 'gpSearch': return out({ ok: true, results: gpSearch(req.q, req.num || 20, req.before) });
      case 'gpFetch': return out({ ok: true, doc: gpFetch(req.pn) });
      case 'openalex': return out({ ok: true, results: openalex(req.q, req.perPage || 20, req.before, req.after) });
      case 'logAnalysis': log(who.email, 'analysis', req.title || ''); return out({ ok: true });
      case 'saveReport': return out({ ok: true, id: saveReport(who, req.report) });
      case 'listReports': return out({ ok: true, reports: listReports(who) });
      case 'getReport': return out({ ok: true, report: getReport(who, req.id) });
      case 'radarList': return out({ ok: true, items: radarList(req.limit || 60) });
      case 'radarRunNow': ownerOnly(who); radarRun(); return out({ ok: true, items: radarList(20) });
      case 'listUsers': ownerOnly(who); return out({ ok: true, users: listUsers() });
      case 'setUser': ownerOnly(who); setUser(req.email, req.status, req.limit); return out({ ok: true, users: listUsers() });
      default: return out({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ----------------------------------------------------------------------- auth
function auth(idToken) {
  if (!idToken) return null;
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  let info = cache.get(key);
  if (info) info = JSON.parse(info);
  else {
    const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return null;
    info = JSON.parse(r.getContentText());
    if (info.aud !== prop('OAUTH_CLIENT_ID') || String(info.email_verified) !== 'true') return null;
    cache.put(key, JSON.stringify({ email: info.email, name: info.name || '' }), 3000);
  }
  const email = String(info.email).toLowerCase();
  const owners = prop('OWNER_EMAILS', '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (owners.includes(email)) return { email, name: info.name, role: 'owner' };
  const u = findUser(email);
  if (u && u.status === 'approved') return { email, name: info.name, role: 'approved', limit: u.limit };
  if (u && u.status === 'blocked') return { email, name: info.name, role: 'pending' };
  const dom = prop('AUTO_APPROVE_DOMAIN', '').toLowerCase();
  if (dom && email.endsWith('@' + dom)) { setUser(email, 'approved'); return { email, name: info.name, role: 'approved' }; }
  return { email, name: info.name, role: 'pending' };
}
function ownerOnly(who) { if (who.role !== 'owner') throw new Error('owner_only'); }
function limitFor(who) { return who.role === 'owner' ? 100000 : (Number(who.limit) || Number(prop('STUDENT_DAILY_CALLS', '150'))); }

// ---------------------------------------------------------------- usage quota
function today() { return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd'); }
function used(email) { return Number(P.getProperty('u_' + today() + '_' + email) || 0); }
function charge(who, n) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const k = 'u_' + today() + '_' + who.email; const v = Number(P.getProperty(k) || 0);
    if (v + n > limitFor(who)) throw new Error('daily_limit_reached');
    P.setProperty(k, String(v + n));
  } finally { lock.releaseLock(); }
}
function cleanupUsage() {
  const t = today(); const all = P.getProperties();
  Object.keys(all).forEach(k => { if (/^u_\d{8}_/.test(k) && k.slice(2, 10) < t) P.deleteProperty(k); });
}

// --------------------------------------------------------------------- Gemini
function gemini(who, req) {
  charge(who, 1);
  return geminiCall(req);
}
function geminiCall(req) {
  const model = req.model || prop('MODEL', 'gemini-flash-latest');
  const body = {
    contents: [{ role: 'user', parts: [{ text: String(req.prompt || '').slice(0, 900000) }] }],
    generationConfig: { temperature: req.temperature == null ? (req.grounded ? 1.0 : 0) : req.temperature, maxOutputTokens: req.maxTokens || 8192 },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.grounded) body.tools = [{ google_search: {} }];
  else if (req.json) body.generationConfig.responseMimeType = 'application/json';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  let r, code, txt;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': prop('GEMINI_KEY') }, payload: JSON.stringify(body), muteHttpExceptions: true });
    code = r.getResponseCode(); txt = r.getContentText();
    if (code === 200) break;
    if ([429, 500, 502, 503, 504].indexOf(code) < 0) break;
    Utilities.sleep([2000, 6000, 15000, 0][attempt]);
  }
  if (code !== 200) throw new Error('gemini_' + code + ': ' + txt.slice(0, 300));
  const j = JSON.parse(txt);
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  const gm = cand.groundingMetadata || {};
  const sources = (gm.groundingChunks || []).map(c => c.web).filter(Boolean).map(w => ({ title: w.title || '', uri: w.uri || '' }));
  return { text, sources, queries: gm.webSearchQueries || [], finish: cand.finishReason || '', model };
}

// -------------------------------------------------------------- Google Patents
function strip(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|claim|heading)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function gpSearch(q, num, before) {
  let inner = 'q=' + q + '&num=' + Math.min(num || 20, 100);
  if (before) inner += '&before=priority:' + String(before).replace(/-/g, '');
  const url = 'https://patents.google.com/xhr/query?url=' + encodeURIComponent(inner) + '&exp=';
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (navya-relay)' } });
  if (r.getResponseCode() !== 200) throw new Error('google_patents_' + r.getResponseCode());
  const j = JSON.parse(r.getContentText());
  const res = [];
  ((j.results || {}).cluster || []).forEach(cl => (cl.result || []).forEach(x => {
    const p = x.patent || {};
    res.push({
      source: 'Google Patents', pn: p.publication_number || '', title: strip(p.title), snippet: strip(p.snippet),
      date: p.priority_date || p.filing_date || '', pubDate: p.publication_date || '',
      url: 'https://patents.google.com/patent/' + (p.publication_number || '') + '/en',
    });
  }));
  return res;
}

function gpFetch(pn) {
  pn = String(pn || '').replace(/[^A-Za-z0-9]/g, '');
  if (!pn) throw new Error('no_pn');
  const cache = CacheService.getScriptCache(); const ck = 'gp_' + pn;
  const hit = cache.get(ck); if (hit) return JSON.parse(hit);
  const url = 'https://patents.google.com/patent/' + pn + '/en';
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (navya-relay)' } });
  if (r.getResponseCode() !== 200) throw new Error('google_patents_page_' + r.getResponseCode());
  const h = r.getContentText();
  const meta = name => { const m = h.match(new RegExp('<meta[^>]+name="' + name + '"[^>]+content="([^"]*)"', 'i')); return m ? strip(m[1]) : ''; };
  const sect = prop => { const m = h.match(new RegExp('<section[^>]+itemprop="' + prop + '"[^>]*>([\\s\\S]*?)</section>', 'i')); return m ? strip(m[1]) : ''; };
  const time = prop => { const m = h.match(new RegExp('<time[^>]+itemprop="' + prop + '"[^>]*>([^<]*)<', 'i')); return m ? m[1].trim() : ''; };
  const doc = {
    source: 'Google Patents', pn, url, title: meta('DC.title'),
    abstract: sect('abstract') || meta('DC.description'),
    claims: sect('claims').slice(0, 15000),
    description: sect('description').slice(0, 30000),
    priorityDate: time('priorityDate'), pubDate: time('publicationDate'),
  };
  try { cache.put(ck, JSON.stringify(doc).slice(0, 99000), 21600); } catch (e) { }
  return doc;
}

// -------------------------------------------------------------------- OpenAlex
function openalex(q, perPage, before, after) {
  const f = [];
  if (before) f.push('to_publication_date:' + before);
  if (after) f.push('from_publication_date:' + after);
  let url = 'https://api.openalex.org/works?search=' + encodeURIComponent(q) + '&per-page=' + Math.min(perPage || 20, 50);
  if (f.length) url += '&filter=' + f.join(',');
  const mail = prop('CONTACT_EMAIL', ''); if (mail) url += '&mailto=' + encodeURIComponent(mail);
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('openalex_' + r.getResponseCode());
  const j = JSON.parse(r.getContentText());
  return (j.results || []).map(w => ({
    source: 'OpenAlex', pn: '', doi: w.doi || '', title: w.title || w.display_name || '',
    abstract: invert(w.abstract_inverted_index), date: w.publication_date || '', cited: w.cited_by_count || 0,
    venue: ((w.primary_location || {}).source || {}).display_name || '', url: w.doi || w.id,
  }));
}
function invert(ix) {
  if (!ix) return '';
  const arr = []; Object.keys(ix).forEach(w => ix[w].forEach(i => { arr[i] = w; }));
  return arr.filter(Boolean).join(' ');
}

// --------------------------------------------------------------------- storage
function ss() { return SpreadsheetApp.openById(prop('SPREADSHEET_ID')); }
function sheet(name) { return ss().getSheetByName(name); }
function log(email, kind, detail) { try { sheet('Log').appendRow([new Date(), email, kind, String(detail).slice(0, 300)]); } catch (e) { } }

function findUser(email) {
  const sh = sheet('Users'); if (!sh) return null;
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]).toLowerCase() === email) return { row: i + 1, email, status: v[i][1], limit: v[i][2] };
  return null;
}
function setUser(email, status, limit) {
  email = String(email).toLowerCase().trim();
  const sh = sheet('Users'); const u = findUser(email);
  if (u) { sh.getRange(u.row, 2).setValue(status); if (limit != null) sh.getRange(u.row, 3).setValue(limit); }
  else sh.appendRow([email, status, limit == null ? '' : limit, new Date(), '']);
}
function requestAccess(who, note) {
  if (!findUser(who.email)) { sheet('Users').appendRow([who.email, 'pending', '', new Date(), String(note || '').slice(0, 300)]); }
}
function listUsers() {
  const v = sheet('Users').getDataRange().getValues(); v.shift();
  return v.map(r => ({ email: r[0], status: r[1], limit: r[2], since: r[3], note: r[4], usedToday: used(String(r[0]).toLowerCase()) }));
}

function saveReport(who, report) {
  const folder = DriveApp.getFolderById(prop('FOLDER_ID'));
  const name = 'navya_' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd_HHmmss') + '_' + who.email.split('@')[0] + '.json';
  const f = folder.createFile(name, JSON.stringify(report), MimeType.PLAIN_TEXT);
  const s = report.summary || {};
  sheet('Reports').appendRow([new Date(), who.email, f.getId(), String(report.title || '').slice(0, 200), s.index, (s.band || []).join('–'), s.verdict || '', s.depth || '', report.refsMapped || 0]);
  return f.getId();
}
function listReports(who) {
  const v = sheet('Reports').getDataRange().getValues(); v.shift();
  return v.filter(r => who.role === 'owner' || String(r[1]).toLowerCase() === who.email).reverse().slice(0, 200)
    .map(r => ({ when: r[0], email: r[1], id: r[2], title: r[3], index: r[4], band: r[5], verdict: r[6], depth: r[7], mapped: r[8] }));
}
function getReport(who, id) {
  const v = sheet('Reports').getDataRange().getValues();
  const row = v.find(r => r[2] === id);
  if (!row) throw new Error('not_found');
  if (who.role !== 'owner' && String(row[1]).toLowerCase() !== who.email) throw new Error('forbidden');
  return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
}

// ------------------------------------------------------------ Opportunity Radar
const RADAR_DOMAINS = [
  ['Thermal management & heat transfer', 'heat transfer cooling thermal management heat exchanger'],
  ['Manufacturing & machining', 'machining additive manufacturing process monitoring tool wear'],
  ['Tribology, coatings & surface engineering', 'wear friction coating tribology erosion'],
  ['Materials & metallurgy', 'alloy composite heat treatment quenching microstructure'],
  ['Agricultural & food-processing machinery', 'agricultural machinery post-harvest drying threshing low cost'],
  ['Renewable energy & storage', 'solar thermal energy storage phase change material wind'],
  ['EV, automotive & powertrain', 'electric vehicle battery thermal brake suspension'],
  ['Mechanisms, robotics & automation', 'mechanism gripper actuator robot automation low cost'],
  ['Fluid machinery & HVAC', 'pump turbine fan HVAC refrigeration flow'],
  ['Sensors, condition monitoring & IoT', 'vibration monitoring sensor fault diagnosis bearing'],
];

function radarRun() {
  cleanupUsage();
  const idx = Number(prop('RADAR_CURSOR', '0'));
  const picks = [RADAR_DOMAINS[idx % RADAR_DOMAINS.length], RADAR_DOMAINS[(idx + 1) % RADAR_DOMAINS.length]];
  P.setProperty('RADAR_CURSOR', String((idx + 2) % RADAR_DOMAINS.length));
  const after = Utilities.formatDate(new Date(Date.now() - 60 * 864e5), 'UTC', 'yyyy-MM-dd');
  const sh = sheet('Radar'); const digest = [];
  picks.forEach(([domain, terms]) => {
    let papers = [];
    try { papers = openalex(terms, 15, null, after); } catch (e) { }
    const paperText = papers.slice(0, 12).map((p, i) => '[' + (i + 1) + '] ' + p.title + ' (' + p.date + ') — ' + String(p.abstract).slice(0, 500)).join('\n');
    const prompt = 'You are scouting PATENTABLE opportunities in mechanical engineering, domain: ' + domain + '.\n' +
      'Use Google Search to find (a) unsolved technical problems reported in the last 12 months by industry, standards bodies or researchers, and (b) recent products in this domain. ' +
      'Combine with these recent papers:\n' + paperText + '\n\n' +
      'Propose 4 concrete inventions (a device, mechanism, process or system — not a business idea, not software alone, not a mere new use or mixture, which Indian Patents Act Sec. 3(d)/(e) excludes). ' +
      'Each must have ONE crisp technical distinguishing feature that a mechanical-engineering lab at an Indian college could prototype within a year. ' +
      'Return ONLY a JSON array: [{"title":"","problem":"","concept":"","distinguishing_feature":"","application":"","indian_context":"","search_query":"5-8 keywords for a patent database search","evidence":"which paper number or web finding motivates it"}]';
    let ideas = [], sources = [];
    try {
      const g = geminiCall({ prompt, grounded: true, maxTokens: 6000 });
      sources = g.sources.slice(0, 8);
      ideas = parseJsonLoose(g.text) || [];
    } catch (e) { log('system', 'radar_error', String(e)); }
    ideas.slice(0, 4).forEach(it => {
      let nearest = [], white = '';
      try {
        const hits = gpSearch(it.search_query || it.title, 15);
        const q = [it.title, it.concept, it.distinguishing_feature].join(' ');
        const sc = hits.map(h => ({ pn: h.pn, title: h.title, url: h.url, sim: cosine(q, h.title + ' ' + h.snippet) })).sort((a, b) => b.sim - a.sim);
        nearest = sc.slice(0, 3); white = sc.length ? +(1 - sc[0].sim).toFixed(2) : '';
      } catch (e) { }
      const row = [new Date(), domain, it.title, it.problem, it.concept, it.distinguishing_feature, it.application, it.indian_context, it.search_query,
        JSON.stringify(nearest), white, JSON.stringify(sources), it.evidence || '', JSON.stringify(papers.slice(0, 6).map(p => ({ t: p.title, u: p.url })))];
      sh.appendRow(row);
      digest.push('• [' + domain + '] ' + it.title + ' — ' + it.distinguishing_feature + (white !== '' ? ' (white-space ' + white + ')' : ''));
    });
  });
  if (prop('RADAR_EMAIL', 'false') === 'true' && digest.length) {
    prop('OWNER_EMAILS', '').split(',').map(s => s.trim()).filter(Boolean).forEach(to =>
      MailApp.sendEmail(to, 'Navya Opportunity Radar — ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM yyyy'),
        'New mechanical-engineering patent opportunities this week:\n\n' + digest.join('\n') + '\n\nWhite-space = 1 − similarity to the nearest Google Patents hit (screening only, not a search report).'));
  }
}

function radarList(limit) {
  const sh = sheet('Radar'); const n = sh.getLastRow(); if (n < 2) return [];
  const start = Math.max(2, n - limit + 1);
  const v = sh.getRange(start, 1, n - start + 1, 14).getValues().reverse();
  const J = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
  return v.map(r => ({ when: r[0], domain: r[1], title: r[2], problem: r[3], concept: r[4], feature: r[5], application: r[6], indian: r[7], query: r[8], nearest: J(r[9]), whitespace: r[10], sources: J(r[11]), evidence: r[12], papers: J(r[13]) }));
}

function parseJsonLoose(t) {
  t = String(t || '').replace(/```json|```/g, '');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  const o = t.indexOf('{'), c = t.lastIndexOf('}');
  try { if (a >= 0 && b > a && (o < 0 || a < o)) return JSON.parse(t.slice(a, b + 1)); } catch (e) { }
  try { if (o >= 0 && c > o) return JSON.parse(t.slice(o, c + 1)); } catch (e) { }
  return null;
}
function toks(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2); }
function cosine(a, b) {
  const A = {}, B = {}; toks(a).forEach(w => A[w] = (A[w] || 0) + 1); toks(b).forEach(w => B[w] = (B[w] || 0) + 1);
  let d = 0, na = 0, nb = 0; Object.keys(A).forEach(w => { na += A[w] * A[w]; if (B[w]) d += A[w] * B[w]; }); Object.keys(B).forEach(w => nb += B[w] * B[w]);
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

// ----------------------------------------------------------------------- setup
function setup() {
  // Use the sheet this script is attached to (Extensions → Apps Script); else the saved one; else create one.
  let book = null;
  try { book = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { }
  if (book) P.setProperty('SPREADSHEET_ID', book.getId());
  else if (prop('SPREADSHEET_ID', '')) book = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  else { book = SpreadsheetApp.create('Navya Patent Engine — data'); P.setProperty('SPREADSHEET_ID', book.getId()); }
  const want = {
    Users: ['email', 'status (approved/pending/blocked)', 'daily call limit (blank = default)', 'since', 'note'],
    Reports: ['when', 'email', 'drive file id', 'title', 'index', 'band', 'verdict', 'search depth', 'refs mapped'],
    Radar: ['when', 'domain', 'title', 'problem', 'concept', 'distinguishing feature', 'application', 'Indian context', 'search query', 'nearest patents', 'white-space', 'web sources', 'evidence', 'papers'],
    Log: ['when', 'email', 'kind', 'detail'],
  };
  Object.keys(want).forEach(n => { let sh = book.getSheetByName(n); if (!sh) sh = book.insertSheet(n); if (sh.getLastRow() === 0) sh.appendRow(want[n]); sh.setFrozenRows(1); });
  const s1 = book.getSheetByName('Sheet1'); if (s1 && book.getSheets().length > 1) book.deleteSheet(s1);
  if (!prop('FOLDER_ID', '')) P.setProperty('FOLDER_ID', DriveApp.createFolder('Navya Patent Engine — reports').getId());
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'radarRun').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('radarRun').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  Logger.log('Sheet: ' + book.getUrl());
  Logger.log('Folder id: ' + prop('FOLDER_ID'));
  ['GEMINI_KEY', 'OAUTH_CLIENT_ID', 'OWNER_EMAILS'].forEach(k => { if (!prop(k, '')) Logger.log('MISSING script property: ' + k); });
}

// Run from the editor to confirm the key, model and Google Patents access all work.
function selfTest() {
  Logger.log(JSON.stringify(geminiCall({ prompt: 'Reply with the word OK.' })).slice(0, 300));
  Logger.log(JSON.stringify(gpSearch('rain actuated cover drying yard', 5)).slice(0, 600));
  Logger.log(JSON.stringify(openalex('nanofluid quenching', 3)).slice(0, 400));
}
