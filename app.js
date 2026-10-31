/* Navya — Patent Engine: UI + orchestration. All numbers come from engine.js. */
(function () {
'use strict';
const CFG = window.NAVYA_CONFIG || {};
const E = window.Engine;
const VERSION = '1.0';
const S = { idToken: null, user: null, sections: null, claims: [], elements: {}, report: null, abort: false, studioEval: null };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = x => (x == null || isNaN(x)) ? '–' : Math.round(100 * x) + '%';

// ======================================================================== relay
async function relay(action, data) {
  if (!CFG.RELAY_URL || /PASTE_/.test(CFG.RELAY_URL)) throw new Error('Relay URL not set in config.js');
  const r = await fetch(CFG.RELAY_URL, { method: 'POST', body: JSON.stringify(Object.assign({ action, idToken: S.idToken }, data || {})) });
  const j = await r.json();
  if (!j.ok) {
    if (j.error === 'not_signed_in') { signInAgain(); throw new Error('Session expired — please sign in again.'); }
    throw new Error(j.error || 'relay_error');
  }
  return j;
}
function parseLoose(t) {
  t = String(t || '').replace(/```json|```/g, '');
  try { return JSON.parse(t); } catch (e) { }
  const o = t.indexOf('{'), c = t.lastIndexOf('}'), a = t.indexOf('['), b = t.lastIndexOf(']');
  try { if (o >= 0 && c > o && (a < 0 || o < a)) return JSON.parse(t.slice(o, c + 1)); } catch (e) { }
  try { if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1)); } catch (e) { }
  return null;
}
async function ai(prompt, opt) {
  opt = opt || {};
  const r = await relay('gemini', { prompt, system: opt.system, json: !opt.grounded, grounded: !!opt.grounded, temperature: opt.temperature, maxTokens: opt.maxTokens });
  if (opt.grounded) return r;
  const v = parseLoose(r.text);
  if (v == null) throw new Error('AI returned unreadable output');
  return v;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const k = i++; if (S.abort) return; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e.message || e) }; } }
  }));
  return out;
}

// ====================================================================== sign-in
function initAuth() {
  if (!window.google || !google.accounts) { setTimeout(initAuth, 300); return; }
  if (!CFG.OAUTH_CLIENT_ID || /PASTE_/.test(CFG.OAUTH_CLIENT_ID)) { $('#whoText').textContent = 'Set OAUTH_CLIENT_ID in config.js'; return; }
  google.accounts.id.initialize({ client_id: CFG.OAUTH_CLIENT_ID, callback: onCredential, auto_select: true });
  google.accounts.id.renderButton($('#gsi'), { size: 'medium', theme: 'outline', text: 'signin' });
  google.accounts.id.prompt();
}
function signInAgain() { S.idToken = null; $('#gsi').classList.remove('hidden'); try { google.accounts.id.prompt(); } catch (e) { } }
async function onCredential(resp) {
  S.idToken = resp.credential;
  try {
    const w = await relay('whoami');
    S.user = w; $('#gsi').classList.add('hidden');
    $('#whoText').textContent = w.email + ' · ' + w.role + (w.role !== 'owner' ? ' · ' + w.usedToday + '/' + w.limit + ' AI calls today' : '');
    $$('.owner-only').forEach(x => x.classList.toggle('hidden', w.role !== 'owner'));
    gate();
  } catch (e) { $('#whoText').textContent = 'Sign-in failed: ' + e.message; }
}
function gate() {
  const u = S.user, body = $('#lockBody');
  const ok = u && (u.role === 'owner' || u.role === 'approved');
  document.body.classList.toggle('locked', !ok);
  if (ok) { if (u.role === 'owner') pendingBadge(); return; }
  if (!u) { body.innerHTML = '<p>Sign in with your Google account (button at the top right). Access is granted individually by the administrator.</p>'; return; }
  if (u.status === 'blocked') { body.innerHTML = '<p>Your access request (' + esc(u.email) + ') was not approved. Contact the administrator if this is a mistake.</p>'; return; }
  if (u.status === 'requested') { body.innerHTML = '<p>Request received for <b>' + esc(u.email) + '</b>' + (u.since ? ' on ' + esc(new Date(u.since).toLocaleDateString()) : '') + '. You will get access once the administrator approves it — reload this page later.</p>'; return; }
  body.innerHTML = '<p>Signed in as <b>' + esc(u.email) + '</b>. This account does not have access yet.</p>' +
    '<label class="fld">Your name, department / USN, guide, and what you want to analyse<textarea id="reqNote" rows="3"></textarea></label>' +
    '<button class="btn primary" id="reqBtn">Request access</button>';
  $('#reqBtn').onclick = async () => {
    const note = $('#reqNote').value.trim();
    if (note.length < 10) { $('#reqNote').focus(); return; }
    $('#reqBtn').disabled = true;
    try { await relay('requestAccess', { note }); u.status = 'requested'; u.since = new Date().toISOString(); gate(); }
    catch (e) { $('#reqBtn').disabled = false; body.insertAdjacentHTML('beforeend', '<p class="sev-error">' + esc(e.message) + '</p>'); }
  };
}
async function pendingBadge() {
  try {
    const r = await relay('listUsers'); const n = r.users.filter(x => x.status === 'pending').length;
    const b = $('[data-tab="admin"]'); b.innerHTML = 'Admin' + (n ? '<span class="badge">' + n + '</span>' : '');
  } catch (e) { }
}

// ======================================================================== tabs
function showTab(t) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + t));
  if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  if (t === 'radar' && !$('#radarList').dataset.loaded) loadRadar();
  if (t === 'history' && !$('#histList').dataset.loaded) loadHistory();
  if (t === 'admin' && !$('#usersList').dataset.loaded) { $('#usersList').dataset.loaded = '1'; loadUsers(); }
}

// ================================================================ file reading
async function readFile(f) {
  const name = f.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      const lines = new Map();
      tc.items.forEach(it => { const y = Math.round(it.transform[5] / 2); if (!lines.has(y)) lines.set(y, []); lines.get(y).push(it); });
      [...lines.entries()].sort((a, b) => b[0] - a[0]).forEach(([, its]) => { text += its.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim() + '\n'; });
      text += '\n';
    }
    if (text.replace(/\s/g, '').length < 300) throw new Error('This PDF has almost no text layer (scanned image). Run OCR first or paste the text.');
    return text;
  }
  if (name.endsWith('.docx')) return (await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })).value;
  return await f.text();
}

// ===================================================================== parsing
function parseDoc(raw) {
  const blinded = E.blind(raw);
  const sec = E.parseSections(blinded);
  const claims = E.parseClaims(sec.claims || '');
  S.sections = sec; S.claims = claims; S.elements = {};
  claims.forEach(c => { S.elements[c.n] = E.splitElements(c); });
  renderParsed();
}
function renderParsed() {
  const sec = S.sections;
  $('#parsed').classList.remove('hidden');
  $('#secFound').innerHTML = '<b>Title:</b> ' + esc(sec.title || '—') + ' &nbsp; <b>Sections found:</b> ' + (sec._headingsFound.join(', ') || 'none') +
    ' &nbsp; <b>Claims:</b> ' + S.claims.length + ' (' + S.claims.filter(c => c.independent).length + ' independent)' +
    (S.claims.length ? '' : '<p class="sev-error">No numbered claims found. Make sure the claims start after a “We claim:” or “Claims” heading and are numbered 1., 2., …</p>');
  $('#claimsView').innerHTML = S.claims.map(c =>
    '<div class="claim ' + (c.independent ? 'ind' : '') + '"><h3>Claim ' + c.n + ' <span class="tag">' + (c.independent ? 'independent' : 'depends on ' + c.deps.join(', ')) + '</span></h3>' +
    (S.elements[c.n] || []).map(e => '<div class="el"><code>' + e.id + '</code><input type="text" data-el="' + e.id + '" data-claim="' + c.n + '" value="' + esc(e.text) + '">' +
      '<span class="tag">' + e.kind + '</span><select data-w="' + e.id + '" data-claim="' + c.n + '" title="weight in scoring">' +
      [1, 0.5, 0].map(w => '<option value="' + w + '"' + (w === e.weight ? ' selected' : '') + '>' + (w === 1 ? 'limiting' : w === 0.5 ? 'half' : 'ignore') + '</option>').join('') + '</select></div>').join('') +
    '</div>').join('');
  $$('#claimsView input[data-el]').forEach(i => i.oninput = () => { const e = S.elements[i.dataset.claim].find(x => x.id === i.dataset.el); e.text = i.value; });
  $$('#claimsView select[data-w]').forEach(s => s.onchange = () => { const e = S.elements[s.dataset.claim].find(x => x.id === s.dataset.w); e.weight = +s.value; });
}

// ================================================================ progress UI
function step(label) {
  const li = document.createElement('li'); li.className = 'run'; li.textContent = label; $('#steps').appendChild(li);
  return { done: m => { li.className = 'done'; li.textContent = label + (m ? ' — ' + m : ''); }, err: m => { li.className = 'err'; li.textContent = label + ' — ' + m; }, note: m => { li.textContent = label + ' — ' + m; } };
}

// ======================================================= analysis pipeline
const MAP_SYSTEM = 'You compare patent-claim elements against ONE prior-art document. You are NOT deciding patentability and must not guess. ' +
  'For each element decide whether THIS document alone discloses it. "disclosed" = the same feature, stated explicitly or necessarily implied. ' +
  '"partial" = a similar feature that differs (broader, different arrangement, or only some sub-features). "absent" = not found. ' +
  'For disclosed or partial you MUST copy a verbatim quote (10–40 consecutive words) from the document that shows it; never paraphrase or join fragments. ' +
  'If you cannot quote it, answer "absent". Judge only the text given, ignore who wrote it, and do not reward or penalise length or style.';

function inventionText() {
  const s = S.sections; const ind = S.claims.filter(c => c.independent).map(c => c.text).join(' ');
  return [s.title, s.title, s.abstract, s.summary, ind, ind].join(' ');
}
function buildQueries() {
  const kw = E.keywords(Object.assign({}, S.sections, { claimsText: S.claims.map(c => c.text).join(' ') }), 24);
  const single = kw.filter(k => !k.includes(' '));
  const pairs = kw.filter(k => k.includes(' '));
  const qs = [];
  qs.push(single.slice(0, 5).join(' '));
  if (pairs.length >= 2) qs.push(pairs.slice(0, 2).join(' '));
  S.claims.filter(c => c.independent).slice(0, 3).forEach(c => {
    const ct = new Set(E.contentTokens(c.text));
    const surf = t => E.tokens(t).filter(w => w.length > 2 && !/^\d+$/.test(w) && E.contentTokens(w).length);
    const t = single.filter(k => ct.has(E.stem(k))).slice(0, 5); if (t.length >= 3) qs.push(t.join(' '));
    const ch = (S.elements[c.n] || []).filter(e => e.kind === 'characterizing' || e.kind === 'body').slice(-2).map(e => surf(e.text).slice(0, 3).join(' ')).join(' ');
    if (ch.split(' ').length >= 3) qs.push(ch);
  });
  const tt = E.tokens(S.sections.title || '').filter(w => w.length > 2 && E.contentTokens(w).length).slice(0, 6).join(' '); if (tt.split(' ').length >= 2) qs.push(tt);
  return [...new Set(qs.map(q => q.trim()).filter(q => q.split(' ').length >= 2))].slice(0, 6);
}

async function runAnalysis() {
  if (!S.claims.length) { alertBox('No claims to analyse.'); return; }
  const mode = $('#mode').value, consistency = $('#optConsistency').checked, useWeb = $('#optWeb').checked && mode === 'ai', useNpl = $('#optNpl').checked;
  const nMap = Math.max(3, Math.min(15, +$('#nMap').value || 8));
  const cutoff = $('#cutoff').value || new Date().toISOString().slice(0, 10);
  S.abort = false; $('#runBtn').disabled = true; $('#stopBtn').classList.remove('hidden');
  $('#progress').classList.remove('hidden'); $('#steps').innerHTML = '';
  const stats = { sourcesOk: 0, sourcesTried: 0, screened: 0, mapped: 0, aiCalls: 0, aiFallbacks: 0 };
  const notes = [];
  try {
    relay('logAnalysis', { title: S.sections.title }).catch(() => { });
    // ---- 1. queries
    let st = step('Building search queries');
    const queries = buildQueries().map(q => ({ q, by: 'keywords' }));
    let ipc = [];
    if (mode === 'ai') {
      try {
        const ind = S.claims.filter(c => c.independent).map(c => c.n + '. ' + c.text).join('\n');
        const r = await ai('Invention (identity removed):\nTITLE: ' + S.sections.title + '\nABSTRACT: ' + (S.sections.abstract || S.sections.summary || '').slice(0, 2500) + '\nINDEPENDENT CLAIMS:\n' + ind.slice(0, 6000) +
          '\n\nWrite prior-art search strings for Google Patents and Google Scholar. Return JSON {"queries":["6 strings of 3–7 keywords: one broad, three combining different claim elements, one problem-oriented, one using synonyms a skilled searcher would use"],"ipc":["up to 4 IPC/CPC groups"]}',
          { system: 'You are a patent search professional. Output JSON only.' });
        stats.aiCalls++;
        (r.queries || []).slice(0, 6).forEach(q => queries.push({ q: String(q).replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim(), by: 'AI' }));
        ipc = r.ipc || [];
      } catch (e) { notes.push('AI query expansion failed: ' + e.message); }
    }
    st.done(queries.length + ' queries');
    if (S.abort) throw new Error('stopped');

    // ---- 2. search
    st = step('Searching Google Patents' + (useNpl ? ' + OpenAlex' : '') + (useWeb ? ' + open web' : ''));
    const jobs = [];
    queries.forEach(q => { jobs.push({ kind: 'gp', q: q.q }); if (useNpl) jobs.push({ kind: 'oa', q: q.q }); });
    const cand = new Map(); const srcOk = { gp: 0, oa: 0, web: 0 };
    const addCand = (c, q) => {
      const key = c.pn ? 'pn:' + c.pn : c.doi ? 'doi:' + c.doi.toLowerCase() : 't:' + E.norm(c.title).slice(0, 80);
      if (!c.title && !c.pn) return;
      if (!cand.has(key)) cand.set(key, Object.assign({ key, foundBy: [] }, c));
      const x = cand.get(key); if (!x.foundBy.includes(q)) x.foundBy.push(q);
    };
    let done = 0;
    await pool(jobs, 3, async j => {
      const r = j.kind === 'gp' ? await relay('gpSearch', { q: j.q, num: 25, before: cutoff }) : await relay('openalex', { q: j.q, perPage: 15, before: cutoff });
      srcOk[j.kind]++; (r.results || []).forEach(c => addCand(c, j.q)); st.note(++done + '/' + jobs.length + ' searches, ' + cand.size + ' candidates');
    });
    let webSources = [], webQueries = [];
    if (useWeb) {
      try {
        const ind1 = (S.claims.find(c => c.independent) || S.claims[0]).text;
        const g = await ai('Find the closest prior art published before ' + cutoff + ' for this invention. Search patents (any country) and technical literature.\nTITLE: ' + S.sections.title + '\nCLAIM: ' + ind1.slice(0, 2500) +
          '\nList up to 12 items, one per line, as: PUBLICATION_NUMBER or DOI | title | year. Prefer documents that disclose several claim features together.', { grounded: true, maxTokens: 3000 });
        stats.aiCalls++; srcOk.web = 1; webSources = g.sources || []; webQueries = g.queries || [];
        const pns = [...new Set((g.text.match(/\b(?:US|EP|WO|CN|JP|KR|IN|DE|GB|FR|CA|AU|TW|RU)\s?\d{4}[\/\s]?\d{3,9}\s?[A-Z]\d?\b/g) || []).map(x => x.replace(/[\s\/]/g, '')))];
        pns.slice(0, 12).forEach(pn => addCand({ source: 'Web (Gemini + Google Search)', pn, title: '', url: 'https://patents.google.com/patent/' + pn + '/en' }, 'web search'));
        const dois = [...new Set((g.text.match(/\b10\.\d{4,9}\/[^\s|,;]+/g) || []))];
        dois.slice(0, 8).forEach(d => addCand({ source: 'Web (Gemini + Google Search)', doi: 'https://doi.org/' + d.replace(/[.)]+$/, ''), title: d, url: 'https://doi.org/' + d }, 'web search'));
      } catch (e) { notes.push('Web search failed: ' + e.message); }
    }
    stats.sourcesTried = 1 + (useNpl ? 1 : 0) + (useWeb ? 1 : 0);
    stats.sourcesOk = (srcOk.gp ? 1 : 0) + (srcOk.oa ? 1 : 0) + (srcOk.web ? 1 : 0);
    if (!cand.size) throw new Error('No candidates returned. Check the relay (Google Patents may be rate-limiting) and try again.');
    st.done(cand.size + ' unique candidates (Google Patents ' + srcOk.gp + ', OpenAlex ' + srcOk.oa + (useWeb ? ', web ' + srcOk.web : '') + ' searches answered)');
    if (S.abort) throw new Error('stopped');

    // ---- 3. screen
    st = step('Screening by text similarity (TF-IDF cosine, deterministic)');
    const all = [...cand.values()];
    const sims = E.tfidfRank(inventionText(), all.map(c => [c.title, c.snippet, c.abstract].join(' ')));
    all.forEach((c, i) => c.sim = sims[i]);
    all.forEach(c => { if (c.source && c.source.startsWith('Web') && !c.snippet) c.sim = Math.max(c.sim, 0.2); }); // web hits have no snippet yet
    all.sort((a, b) => b.sim - a.sim);
    stats.screened = all.length;
    let pick = all.slice(0, nMap + 3);
    st.done('top ' + pick.length + ' shortlisted for full text');

    // ---- 4. full text
    st = step('Fetching full text of shortlisted patents');
    await pool(pick, 3, async c => {
      if (c.pn) {
        try { const d = (await relay('gpFetch', { pn: c.pn })).doc; Object.assign(c, { title: c.title || d.title, abstract: d.abstract, claimsText: d.claims, description: d.description, date: c.date || d.priorityDate, pubDate: d.pubDate, full: true }); }
        catch (e) { c.full = false; c.fetchErr = e.message; }
      }
    });
    pick.forEach(c => { c.text = [c.title, c.abstract || c.snippet, c.claimsText, c.description].filter(Boolean).join('\n'); });
    pick = pick.filter(c => c.text.length > 80);
    // drop documents dated on/after the cut-off (web hits are not date-filtered at source)
    pick = pick.filter(c => { const d = String(c.date || c.pubDate || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'); return !d || d < cutoff; });
    const re = E.tfidfRank(inventionText(), pick.map(c => c.text.slice(0, 20000)));
    pick.forEach((c, i) => c.simFull = re[i]);
    pick.sort((a, b) => b.simFull - a.simFull);
    const refs = pick.slice(0, nMap).map((c, i) => Object.assign(c, { rid: 'R' + (i + 1) }));
    st.done(refs.length + ' references; ' + refs.filter(r => r.full).length + ' with full text');
    if (S.abort) throw new Error('stopped');

    // ---- 5. element mapping
    st = step(mode === 'ai' ? 'Mapping claim elements to each reference (AI, quotes verified' + (consistency ? ', two runs' : '') + ')' : 'Mapping claim elements to each reference (rule-based)');
    const allEls = S.claims.flatMap(c => S.elements[c.n] || []).filter(e => e.weight > 0 || e.kind === 'preamble');
    const evidence = {}; let mapped = 0; let aiDead = mode !== 'ai';
    await pool(refs, 2, async r => {
      const docText = r.text.slice(0, 30000);
      if (!aiDead) {
        try {
          evidence[r.rid] = await aiMap(allEls, docText, consistency); stats.aiCalls += consistency ? 2 : 1; r.mapMode = 'ai';
        } catch (e) {
          if (/daily_limit|429|quota/i.test(e.message)) { aiDead = true; notes.push('AI daily limit reached — remaining references mapped rule-based.'); }
          else notes.push(r.rid + ': AI mapping failed (' + e.message + ') — used rule-based.');
          stats.aiFallbacks++;
        }
      }
      if (!evidence[r.rid]) { evidence[r.rid] = E.ruleMap(allEls, docText); r.mapMode = 'rule'; }
      st.note(++mapped + '/' + refs.length + ' references mapped');
    });
    stats.mapped = refs.length;
    st.done(refs.length + ' references mapped (' + refs.filter(r => r.mapMode === 'ai').length + ' AI, ' + refs.filter(r => r.mapMode === 'rule').length + ' rule-based)');

    // ---- 6. exclusions
    st = step('Screening Sec. 3 exclusions & industrial applicability');
    let exclusions = { flags: E.sec3Screen(S.claims.map(c => c.text).join(' ')), industrial: null, how: 'keyword' };
    if (mode === 'ai' && !aiDead) {
      try {
        const spec = [S.sections.title, S.sections.field, S.sections.summary, S.claims.map(c => c.n + '. ' + c.text).join('\n')].join('\n');
        const x = await ai('INVENTION:\n' + spec.slice(0, 20000) + '\n\nAssess only against the Indian Patents Act, 1970: Section 3 clauses (a) frivolous/contrary to natural laws, (b) public order, (c) mere discovery, (d) new form or new use of a known substance or mere use of a known process/machine, (e) mere admixture, (f) mere arrangement/duplication of known devices functioning independently, (h) method of agriculture/horticulture, (i) medical treatment, (k) mathematical/business method, computer program per se, algorithm, (m) mental act/scheme/game, (n) presentation of information, (p) traditional knowledge; and Section 2(1)(ac) industrial applicability. ' +
          'Flag only clauses with a real basis and quote the claim wording that triggers it. Return JSON {"flags":[{"clause":"3(f)","risk":"low|medium|high","reason":"","quote":"verbatim from the invention"}],"industrial":{"ok":true,"reason":""}}',
          { system: 'You are an Indian patent examiner. Be specific; no flag without a verbatim quote. Output JSON only.' });
        stats.aiCalls++;
        const inv = spec;
        exclusions = { flags: (x.flags || []).map(f => Object.assign(f, { verified: E.verifyQuote(f.quote || '', inv).ok, how: 'ai' })), industrial: x.industrial || null, how: 'ai' };
      } catch (e) { notes.push('AI exclusion screen failed — keyword screen used.'); }
    }
    st.done(exclusions.flags.length + ' flag(s)');

    // ---- 7. score
    st = step('Scoring (deterministic formula)');
    const rep = {
      version: VERSION, created: new Date().toISOString(), title: S.sections.title, mode, cutoff, settings: { consistency, useWeb, useNpl, nMap },
      spec: { title: S.sections.title, abstract: S.sections.abstract || '', field: S.sections.field || '', summary: (S.sections.summary || '').slice(0, 8000), description: (S.sections.description || '').slice(0, 60000), headings: S.sections._headingsFound },
      claims: S.claims, elements: S.elements, queries, ipc, webSources, webQueries,
      candidates: all.slice(0, 80).map(c => ({ key: c.key, pn: c.pn, doi: c.doi, title: c.title, date: c.date, source: c.source, sim: +(+c.sim).toFixed(3), url: c.url, foundBy: c.foundBy })),
      refs: refs.map(r => ({ rid: r.rid, pn: r.pn, doi: r.doi, title: r.title, date: r.date, pubDate: r.pubDate, source: r.source, url: r.url, sim: +(+r.simFull).toFixed(3), full: !!r.full, mapMode: r.mapMode, text: r.text.slice(0, 30000) })),
      evidence, exclusions, excludedConfirmed: false, stats, notes,
    };
    scoreReport(rep);
    rep.refsMapped = refs.length;
    S.report = rep; S.studioEval = null;
    st.done('Patentability index ' + rep.summary.index + ' (band ' + rep.summary.band.join('–') + ')');
    renderReport(); renderStudio(); showTab('report');
  } catch (e) {
    step('Stopped').err(e.message);
  } finally { $('#runBtn').disabled = false; $('#stopBtn').classList.add('hidden'); }
}

async function aiMap(els, docText, twice) {
  const list = arr => arr.map(e => '[' + e.id + '] ' + e.text).join('\n');
  const ask = async (arr, docFirst) => {
    const doc = 'DOCUMENT:\n<<<\n' + docText + '\n>>>';
    const elsT = 'ELEMENTS:\n' + list(arr);
    const r = await ai((docFirst ? doc + '\n\n' + elsT : elsT + '\n\n' + doc) +
      '\n\nReturn JSON {"elements":[{"id":"","status":"disclosed|partial|absent","quote":"","where":"abstract|claims|description"}]} covering every element id.', { system: MAP_SYSTEM, temperature: 0 });
    const m = {}; (r.elements || []).forEach(x => { m[x.id] = x; }); return m;
  };
  const runs = [await ask(els, false)];
  if (twice) runs.push(await ask(els.slice().reverse(), true));
  const ev = {};
  els.forEach(e => {
    ev[e.id] = runs.map(m => {
      const x = m[e.id] || { status: 'absent', quote: '' };
      const st = ['disclosed', 'partial', 'absent'].includes(x.status) ? x.status : 'absent';
      const v = st === 'absent' ? { ok: false } : E.verifyQuote(x.quote || '', docText);
      return { status: st, quote: String(x.quote || '').slice(0, 600), where: x.where || '', verified: !!v.ok, match: v.how, how: 'ai' };
    });
  });
  return ev;
}

function scoreReport(rep) {
  const byNo = Object.fromEntries(rep.claims.map(c => [c.n, c]));
  const rids = rep.refs.map(r => r.rid);
  rep.claimScores = {};
  rep.claims.forEach(c => {
    const chain = E.elementChain(c.n, byNo, rep.elements);
    const sc = E.scoreClaim(chain, rids, rep.evidence);
    delete sc.perElement;
    const invalid = !c.independent && !c.deps.some(d => d < c.n && byNo[d]);
    rep.claimScores[c.n] = Object.assign(sc, { independent: c.independent, invalid, chain: chain.map(e => e.id) });
  });
  const o = E.overall(rep.claimScores, { excluded: rep.excludedConfirmed });
  const d = E.searchDepth(rep.stats);
  rep.issues = E.formalChecks(rep.claims, Object.assign({}, rep.spec, { description: rep.spec.description }));
  rep.summary = Object.assign(o, { depth: d.level, depthNotes: d.notes });
}

// ======================================================================= report
const SYM = v => '<span class="dot ' + (v.mean >= 0.999 ? 'full' : v.mean > 0 ? 'half' : 'none') + '"></span>';
function cellValue(rep, rid, eid) { return E.elementValue(rep.evidence[rid] && rep.evidence[rid][eid]); }
function refLabel(r) { return r.pn || (r.doi ? r.doi.replace('https://doi.org/', 'doi:') : '') || r.title.slice(0, 40); }

function renderReport() {
  const rep = S.report; if (!rep) return;
  const s = rep.summary, byRid = Object.fromEntries(rep.refs.map(r => [r.rid, r]));
  const allEls = Object.values(rep.elements).flat(); const elById = Object.fromEntries(allEls.map(e => [e.id, e]));
  const ind = rep.claims.filter(c => c.independent);
  const best = rep.claimScores[s.bestIndependent];
  const gauge = (v, b) => '<div class="gauge"><i style="left:' + b[0] + '%;width:' + Math.max(1, b[1] - b[0]) + '%"></i><em style="left:' + v + '%"></em></div>';
  let h = '<div class="card"><div class="row"><h2>' + esc(rep.title || 'Untitled invention') + '</h2>' +
    '<button class="btn sm" id="saveRep">Save to cloud</button><button class="btn sm" id="dlJson">Download JSON</button><button class="btn sm" id="dlHtml">Download report (HTML)</button><button class="btn sm" id="printRep">Print / PDF</button></div>' +
    '<p class="muted">' + new Date(rep.created).toLocaleString() + ' · mode: ' + (rep.mode === 'ai' ? 'AI-assisted (quotes verified)' : 'rule-based') + ' · prior-art cut-off ' + rep.cutoff + '</p>' +
    '<div class="kpis">' +
    '<div class="kpi"><span>Patentability index · claim ' + s.bestIndependent + ' as filed</span><b>' + s.index + '</b>' + gauge(s.index, s.band) + '<span>band ' + s.band[0] + '–' + s.band[1] + ' · novelty ' + pct(best && best.novelty) + '</span></div>' +
    '<div class="kpi"><span>Best fallback · claim ' + s.bestClaim + '</span><b>' + s.fallbackIndex + '</b><span>' + (s.bestClaim === s.bestIndependent ? 'same as independent claim' : 'if claim ' + s.bestClaim + ' is merged into its independent claim') + '</span></div>' +
    '<div class="kpi"><span>Search depth</span><b style="font-size:1.3rem">' + s.depth + '</b><span>' + rep.stats.screened + ' screened · ' + rep.stats.mapped + ' mapped · ' + rep.stats.sourcesOk + '/' + rep.stats.sourcesTried + ' sources</span></div>' +
    '<div class="kpi"><span>Formal issues</span><b>' + rep.issues.filter(i => i.sev === 'error').length + ' / ' + rep.issues.filter(i => i.sev === 'warn').length + '</b><span>errors / warnings</span></div></div>' +
    '<p class="verdict">' + esc(s.verdict) + '</p>' +
    '<p class="note"><b>How to read this.</b> The index is an <b>upper bound</b> given this search: finding more prior art can only lower it. ' +
    'The band spans the two blinded AI runs (or unverified quotes) — a wide band means the evidence is ambiguous. ' +
    (s.depthNotes.length ? 'Search depth is <b>' + s.depth + '</b>: ' + esc(s.depthNotes.join('; ')) + '. ' : '') +
    'Not a legal opinion; Indian Patent Office examination also tests sufficiency, unity and Sec. 3.</p>' +
    (rep.notes.length ? '<p class="note">' + rep.notes.map(esc).join('<br>') + '</p>' : '') + '</div>';

  // per-claim table
  h += '<div class="card"><h2>Claim-by-claim</h2><table><tr><th>Claim</th><th>Type</th><th>Novelty</th><th>Inventive step</th><th>Band</th><th>Closest single reference</th><th>Best 2-reference combination</th><th>Features not found</th></tr>' +
    rep.claims.map(c => { const x = rep.claimScores[c.n]; if (x.invalid) return '<tr><td>' + c.n + '</td><td>→ ' + c.deps.join(',') + '</td><td colspan="6" class="sev-error">Invalid dependency — not scored (see formal checks)</td></tr>'; return '<tr><td>' + c.n + '</td><td>' + (c.independent ? 'independent' : '→ ' + c.deps.join(',')) + '</td><td class="c">' + pct(x.novelty) + (x.anticipated ? ' <span class="sev-error">anticipated</span>' : '') + '</td><td class="c"><b>' + pct(x.inventive) + '</b></td><td class="c">' + pct(x.band[0]) + '–' + pct(x.band[1]) + '</td><td>' + (x.closest ? esc(x.closest + ' ' + refLabel(byRid[x.closest])) + ' (' + pct(x.singleCoverage) + ')' : '—') + '</td><td>' + (x.bestPair ? esc(x.bestPair.join(' + ')) + ' (' + pct(x.pairCoverage) + ')' : '—') + '</td><td>' + (x.distinguishing.length ? x.distinguishing.join(', ') : '<span class="muted">none</span>') + '</td></tr>'; }).join('') + '</table></div>';

  // distinguishing features
  const distAll = [...new Set(ind.flatMap(c => rep.claimScores[c.n].distinguishing))];
  const distDep = [...new Set(rep.claims.filter(c => !c.independent).flatMap(c => rep.claimScores[c.n].distinguishing))].filter(id => !distAll.includes(id));
  h += '<div class="card"><h2>Distinguishing features <small class="muted">elements no mapped reference disclosed, even partially</small></h2>' +
    (distAll.length ? distAll.map(id => '<div class="dist"><code>' + id + '</code> ' + esc(elById[id] && elById[id].text) + '</div>').join('') : '<p class="sev-error">Every element of the independent claims appears, at least partially, in some reference.</p>') +
    (distDep.length ? '<h3>Only in dependent claims</h3>' + distDep.map(id => '<div class="dist"><code>' + id + '</code> ' + esc(elById[id] && elById[id].text) + '</div>').join('') : '') + '</div>';

  // claim chart
  h += '<div class="card"><div class="row"><h2>Claim chart</h2><select id="chartClaim">' + rep.claims.map(c => '<option value="' + c.n + '"' + (c.n === s.bestIndependent ? ' selected' : '') + '>Claim ' + c.n + '</option>').join('') + '</select></div>' +
    '<p class="muted"><span class="dot full"></span> disclosed · <span class="dot half"></span> partial / runs disagree · <span class="dot none"></span> absent · ‡ AI cited a quote that could not be found in the document (counted as absent). Click a cell for the evidence.</p><div id="chart"></div></div>';

  // references
  h += '<div class="card"><h2>References mapped</h2><table><tr><th>#</th><th>Document</th><th>Date</th><th>Source</th><th>Similarity</th><th>Text</th><th>Mapping</th></tr>' +
    rep.refs.map(r => '<tr><td>' + r.rid + '</td><td><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(refLabel(r)) + '</a><br>' + esc(r.title) + '</td><td>' + esc(r.date || r.pubDate || '') + '</td><td>' + esc(r.source) + '</td><td class="c">' + pct(r.sim) + '</td><td>' + (r.full ? 'full text' : 'abstract only') + '</td><td>' + r.mapMode + '</td></tr>').join('') + '</table>' +
    '<details><summary>Other screened candidates (' + Math.max(0, rep.candidates.length - rep.refs.length) + ')</summary><table>' + rep.candidates.filter(c => !rep.refs.find(r => r.title === c.title)).slice(0, 60).map(c => '<tr><td><a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.pn || c.title.slice(0, 50)) + '</a></td><td>' + esc(c.title) + '</td><td>' + esc(c.date || '') + '</td><td>' + pct(c.sim) + '</td></tr>').join('') + '</table></details>' +
    (rep.webSources.length ? '<details><summary>Web pages the AI search consulted (' + rep.webSources.length + ')</summary><ul>' + rep.webSources.map(w => '<li><a href="' + esc(w.uri) + '" target="_blank" rel="noopener">' + esc(w.title || w.uri) + '</a></li>').join('') + '</ul></details>' : '') + '</div>';

  // exclusions
  const ex = rep.exclusions;
  h += '<div class="card"><h2>Section 3 & industrial applicability <small class="muted">' + (ex.how === 'ai' ? 'AI screen, quotes verified' : 'keyword screen') + '</small></h2>' +
    (ex.flags.length ? '<table><tr><th>Clause</th><th>Risk</th><th>Reason</th><th>Trigger</th></tr>' + ex.flags.map(f => '<tr><td>' + esc(f.clause) + '</td><td>' + esc(f.risk) + '</td><td>' + esc(f.reason) + '</td><td>' + esc(f.quote) + (f.how === 'ai' && !f.verified ? ' <span class="sev-warn">‡ not found in text</span>' : '') + '</td></tr>').join('') + '</table>' : '<p>No exclusion flags.</p>') +
    (ex.industrial ? '<p>Industrial applicability: <b>' + (ex.industrial.ok ? 'yes' : 'doubtful') + '</b> — ' + esc(ex.industrial.reason) + '</p>' : '') +
    '<label class="chk"><input type="checkbox" id="exclConfirm"' + (rep.excludedConfirmed ? ' checked' : '') + '> I confirm the claimed subject matter is excluded under Sec. 3 (sets the index to 0). Flags alone never change the score.</label></div>';

  // formal
  h += '<div class="card"><h2>Formal checks on the claims</h2>' + (rep.issues.length ? '<table><tr><th>Claim</th><th>Severity</th><th>Issue</th></tr>' + rep.issues.map(i => '<tr><td>' + (i.claim || 'all') + '</td><td class="sev-' + i.sev + '">' + i.sev + '</td><td>' + esc(i.msg) + '</td></tr>').join('') + '</table>' : '<p>No formal issues detected.</p>') + '</div>';

  // reproducibility
  h += '<div class="card"><h2>Reproducibility record</h2><p><b>Queries:</b></p><ul>' + rep.queries.map(q => '<li>' + esc(q.q) + ' <span class="tag">' + q.by + '</span></li>').join('') + '</ul>' +
    (rep.ipc.length ? '<p><b>Suggested classes to search manually:</b> ' + rep.ipc.map(esc).join(', ') + '</p>' : '') +
    '<p><b>Settings:</b> ' + esc(JSON.stringify(rep.settings)) + ' · AI calls ' + rep.stats.aiCalls + ' · engine v' + rep.version + '</p>' +
    '<p class="muted">Scores are computed only from the evidence table above by the formula in the Method tab. Re-running the same document with the same references reproduces the rule-based scores exactly; AI scores vary within the reported band.</p></div>';

  $('#reportView').className = ''; $('#reportView').innerHTML = h;
  renderChart(+$('#chartClaim').value);
  $('#chartClaim').onchange = e => renderChart(+e.target.value);
  $('#exclConfirm').onchange = e => { rep.excludedConfirmed = e.target.checked; scoreReport(rep); renderReport(); };
  $('#saveRep').onclick = async e => { e.target.disabled = true; try { const r = await relay('saveReport', { report: rep }); e.target.textContent = 'Saved'; rep.cloudId = r.id; } catch (err) { e.target.disabled = false; alertBox('Save failed: ' + err.message); } };
  $('#dlJson').onclick = () => download('navya_report.json', JSON.stringify(rep, null, 1), 'application/json');
  $('#dlHtml').onclick = () => download('navya_report.html', standaloneHtml(), 'text/html');
  $('#printRep').onclick = () => window.print();
}

function renderChart(n) {
  const rep = S.report; const sc = rep.claimScores[n]; const allEls = Object.values(rep.elements).flat(); const elById = Object.fromEntries(allEls.map(e => [e.id, e]));
  const rids = rep.refs.map(r => r.rid);
  let h = '<div style="overflow:auto"><table class="chart"><tr><th>Element</th>' + rep.refs.map(r => '<th class="ref" title="' + esc(r.title) + '">' + r.rid + ' ' + esc(refLabel(r)) + '</th>').join('') + '</tr>';
  sc.chain.forEach(id => {
    const e = elById[id];
    h += '<tr><td><code>' + id + '</code> ' + esc(e.text) + (e.weight !== 1 ? ' <span class="tag">w ' + e.weight + '</span>' : '') + '</td>' + rids.map(rid => {
      const v = cellValue(rep, rid, id); const mark = SYM(v) + (v.unverified ? '‡' : '') + (v.disagree ? '≠' : '');
      return '<td class="cell" data-r="' + rid + '" data-e="' + id + '">' + mark + '</td>';
    }).join('') + '</tr>';
  });
  h += '<tr><th>Coverage</th>' + rids.map(rid => { const W = sc.chain.reduce((a, id) => a + elById[id].weight, 0) || 1; return '<th class="c">' + pct(sc.chain.reduce((a, id) => a + elById[id].weight * cellValue(rep, rid, id).mean, 0) / W) + '</th>'; }).join('') + '</tr></table></div>';
  $('#chart').innerHTML = h;
  $$('#chart td.cell').forEach(td => td.onclick = () => showEvidence(td.dataset.r, td.dataset.e));
}
function showEvidence(rid, eid) {
  const rep = S.report; const r = rep.refs.find(x => x.rid === rid); const e = Object.values(rep.elements).flat().find(x => x.id === eid);
  const runs = (rep.evidence[rid] || {})[eid] || [];
  modal('<h3>' + eid + ' vs ' + rid + ' — ' + esc(refLabel(r)) + '</h3><p><b>Element:</b> ' + esc(e.text) + '</p>' +
    runs.map((x, i) => '<p><b>Run ' + (i + 1) + ' (' + x.how + '):</b> ' + x.status + (x.status !== 'absent' ? (x.verified ? ' — <span style="color:var(--ok)">quote found in document (' + (x.match || 'match') + ')</span>' : ' — <span class="sev-error">quote NOT found in document → counted as absent</span>') : '') + (x.cover != null ? ' · coverage ' + x.cover : '') + '</p>' + (x.quote ? '<blockquote>' + esc(x.quote) + '</blockquote>' : '')).join('') +
    '<p><a href="' + esc(r.url) + '" target="_blank" rel="noopener">Open document</a></p>');
}

// ================================================================ claims studio
function claimsToText(claims) { return claims.map(c => c.n + '. ' + c.text).join('\n'); }
function renderStudio() {
  const rep = S.report; if (!rep) return;
  const byNo = Object.fromEntries(rep.claims.map(c => [c.n, c]));
  const allEls = Object.values(rep.elements).flat(); const elById = Object.fromEntries(allEls.map(e => [e.id, e]));
  // fallback merges (deterministic)
  const merges = [];
  rep.claims.filter(c => !c.independent).forEach(c => {
    let root = c, chain = [c];
    while (root && !root.independent) { const p = byNo[root.deps.find(d => d < root.n)]; if (!p) break; root = p; chain.unshift(p); }
    if (!root || !root.independent) return;
    const gain = rep.claimScores[c.n].patentability - rep.claimScores[root.n].patentability;
    if (gain > 0.04 && !rep.claimScores[c.n].invalid) {
      let txt = root.text; chain.slice(1).forEach(x => { txt = E.mergeClaim(txt, x.text); });
      merges.push({ from: c.n, into: root.n, gain, text: txt, score: rep.claimScores[c.n].patentability });
    }
  });
  merges.sort((a, b) => b.gain - a.gain);
  const bestInd = rep.summary.bestIndependent;
  const dist = rep.claimScores[bestInd].distinguishing;
  let h = '<div class="card"><h2>Claims Studio</h2><p class="muted">Suggestions are derived from the evidence table. Every amendment must be supported by the original description (Sec. 59 bars adding new matter after filing).</p></div>';
  h += '<div class="card"><h3>A · What makes claim ' + bestInd + ' different</h3>' + (dist.length ? dist.map(id => '<div class="dist"><code>' + id + '</code> ' + esc(elById[id].text) + '</div>').join('') : '<p class="sev-error">No element of claim ' + bestInd + ' is free of prior art. Look at dependent claims below or at features described in the specification but not claimed.</p>') + '</div>';
  h += '<div class="card"><h3>B · Stronger fallback positions (merge a dependent claim into its independent claim)</h3>' +
    (merges.length ? merges.slice(0, 6).map((m, i) => '<div class="claim"><b>Merge claim ' + m.from + ' into claim ' + m.into + '</b> — inventive-step score ' + pct(rep.claimScores[m.into].patentability) + ' → ' + pct(m.score) + '<pre class="claims">' + esc(m.text) + '</pre>' + (rep.issues.filter(i => i.claim === m.from && i.sev !== 'info').length ? '<p class="sev-warn">Claim ' + m.from + ' has its own formal issues (see C) — fix them before merging.</p>' : '') + '<button class="btn sm" data-merge="' + i + '">Use as new claim ' + m.into + '</button></div>').join('') : '<p class="muted">No dependent claim raises the score by more than 4 points.</p>') + '</div>';
  const fixable = rep.issues.filter(i => i.sev !== 'info');
  h += '<div class="card"><h3>C · Formal corrections</h3>' + (fixable.length ? '<ul>' + fixable.map(i => '<li class="sev-' + i.sev + '">Claim ' + (i.claim || '–') + ': ' + esc(i.msg) + '</li>').join('') + '</ul>' : '<p>None.</p>') + '</div>';
  h += '<div class="card"><h3>D · Rewrite the claim set</h3><p class="muted">AI drafts a new set aimed at the distinguishing features, fixes formal issues, and must cite a verbatim basis in your description for every added limitation (checked automatically).</p>' +
    '<div class="row"><button class="btn primary" id="aiRewrite">Draft amended claims (AI)</button><span id="rwStatus" class="muted"></span></div><div id="rwOut"></div></div>';
  h += '<div class="card"><h3>E · Amended claim set — edit, then re-score against the same ' + rep.refs.length + ' references</h3><textarea id="newClaims" rows="14">' + esc(claimsToText(rep.claims)) + '</textarea>' +
    '<div class="row"><button class="btn primary" id="rescore">Re-score</button><button class="btn" id="copyClaims">Copy claims</button><span id="rsStatus" class="muted"></span></div><div id="rsOut"></div></div>';
  $('#studioView').className = ''; $('#studioView').innerHTML = h;
  $$('[data-merge]').forEach(b => b.onclick = () => {
    const m = merges[+b.dataset.merge]; const ta = $('#newClaims');
    const cl = E.parseClaims(ta.value); const t = cl.find(c => c.n === m.into); if (t) t.text = m.text;
    ta.value = claimsToText(cl); b.textContent = 'Applied'; });
  $('#aiRewrite').onclick = aiRewrite;
  $('#rescore').onclick = rescore;
  $('#copyClaims').onclick = async () => { try { await navigator.clipboard.writeText('We claim:\n' + $('#newClaims').value); $('#rsStatus').textContent = 'Copied.'; } catch (e) { $('#rsStatus').textContent = 'Copy blocked — select the text and copy manually.'; } };
  if (S.studioEval) showRescore(S.studioEval);
}

async function aiRewrite() {
  const rep = S.report; const st = $('#rwStatus'); st.textContent = 'Drafting…'; $('#aiRewrite').disabled = true;
  try {
    const allEls = Object.values(rep.elements).flat(); const elById = Object.fromEntries(allEls.map(e => [e.id, e]));
    const dist = [...new Set(rep.claims.flatMap(c => rep.claimScores[c.n].distinguishing))].map(id => id + ': ' + elById[id].text);
    const closest = rep.refs.slice(0, 6).map(r => {
      const disc = Object.entries(rep.evidence[r.rid] || {}).filter(([, runs]) => E.elementValue(runs).mean > 0).map(([id]) => id);
      return r.rid + ' ' + refLabel(r) + ' "' + r.title + '" discloses elements: ' + (disc.join(', ') || 'none');
    }).join('\n');
    const descr = [rep.spec.summary, rep.spec.description].join('\n').slice(0, 45000);
    const x = await ai('CURRENT CLAIMS:\n' + claimsToText(rep.claims) + '\n\nELEMENTS NOT FOUND IN PRIOR ART:\n' + (dist.join('\n') || 'none') + '\n\nCLOSEST PRIOR ART:\n' + closest +
      '\n\nFORMAL ISSUES:\n' + rep.issues.filter(i => i.sev !== 'info').map(i => 'claim ' + i.claim + ': ' + i.msg).join('\n') + '\n\nDESCRIPTION (the only permissible source of new limitations):\n<<<\n' + descr + '\n>>>\n\n' +
      'Rewrite the claim set for filing in India. Rules: (1) independent claim 1 must contain at least one element not found in the prior art, but stay as broad as the evidence allows; ' +
      '(2) every limitation you ADD must be supported by a verbatim quote (10–40 words) from the DESCRIPTION; (3) one sentence per claim, ending with a full stop; "a/an" before "the/said"; no "preferably", "such as", "about" without a range; no reference to drawings; ' +
      '(4) dependent claims read "The <preamble> as claimed in claim N, wherein …"; keep fallback positions in dependent claims; (5) consider a parallel independent method/process claim if the description supports it. ' +
      'Return JSON {"claims":[{"n":1,"text":"","basis":[{"feature":"","quote":""}]}],"rationale":["one line per change"],"risks":["remaining weaknesses"]}',
      { system: 'You are an Indian patent agent drafting claims. Never invent features absent from the description. Output JSON only.', maxTokens: 8192 });
    const spec = [rep.spec.summary, rep.spec.description, rep.spec.abstract, claimsToText(rep.claims)].join('\n');
    const cl = (x.claims || []).map(c => Object.assign(c, { basis: (c.basis || []).map(b => Object.assign(b, { ok: E.verifyQuote(b.quote || '', spec).ok })) }));
    const unsupported = cl.flatMap(c => c.basis.filter(b => !b.ok).map(b => 'claim ' + c.n + ': ' + b.feature));
    $('#rwOut').innerHTML = '<pre class="claims">' + esc(cl.map(c => c.n + '. ' + c.text).join('\n')) + '</pre>' +
      (unsupported.length ? '<p class="sev-error">Basis NOT found in your description for: ' + unsupported.map(esc).join('; ') + ' — remove these or add support before filing (new matter).</p>' : '<p style="color:var(--ok)">Every cited basis quote was found in the description.</p>') +
      '<h3>Changes</h3><ul>' + (x.rationale || []).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
      ((x.risks || []).length ? '<h3>Remaining risks</h3><ul>' + x.risks.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' : '') +
      '<button class="btn sm" id="useRw">Load into editor (E)</button>';
    $('#useRw').onclick = () => { $('#newClaims').value = cl.map(c => c.n + '. ' + c.text).join('\n'); $('#newClaims').scrollIntoView({ behavior: 'smooth' }); };
    st.textContent = '';
  } catch (e) { st.textContent = 'Failed: ' + e.message; } finally { $('#aiRewrite').disabled = false; }
}

async function rescore() {
  const rep = S.report; const st = $('#rsStatus');
  const claims = E.parseClaims('We claim:\n' + $('#newClaims').value);
  if (!claims.length) { st.textContent = 'No numbered claims found.'; return; }
  const elements = {}; claims.forEach(c => elements[c.n] = E.splitElements(c));
  const allEls = Object.values(elements).flat();
  st.textContent = 'Mapping ' + allEls.length + ' elements against ' + rep.refs.length + ' references…';
  const evidence = {}; const useAi = rep.mode === 'ai'; let fell = 0;
  await pool(rep.refs, 2, async r => {
    if (useAi) { try { evidence[r.rid] = await aiMap(allEls, r.text, rep.settings.consistency); return; } catch (e) { fell++; } }
    evidence[r.rid] = E.ruleMap(allEls, r.text);
  });
  const nrep = Object.assign({}, rep, { claims, elements, evidence, excludedConfirmed: rep.excludedConfirmed });
  scoreReport(nrep);
  S.studioEval = { claims, elements, evidence, claimScores: nrep.claimScores, summary: nrep.summary, issues: nrep.issues, fell };
  st.textContent = fell ? fell + ' reference(s) fell back to rule-based mapping.' : '';
  showRescore(S.studioEval);
}
function showRescore(ev) {
  const rep = S.report;
  $('#rsOut').innerHTML = '<table><tr><th></th><th>Before</th><th>After</th></tr>' +
    '<tr><td>Patentability index</td><td>' + rep.summary.index + ' (' + rep.summary.band.join('–') + ')</td><td><b>' + ev.summary.index + '</b> (' + ev.summary.band.join('–') + ')</td></tr>' +
    '<tr><td>Best fallback (dependent claims)</td><td>' + rep.summary.fallbackIndex + '</td><td>' + ev.summary.fallbackIndex + '</td></tr>' +
    '<tr><td>Formal errors / warnings</td><td>' + rep.issues.filter(i => i.sev === 'error').length + ' / ' + rep.issues.filter(i => i.sev === 'warn').length + '</td><td>' + ev.issues.filter(i => i.sev === 'error').length + ' / ' + ev.issues.filter(i => i.sev === 'warn').length + '</td></tr></table>' +
    '<h3>Amended claims</h3><table><tr><th>Claim</th><th>Novelty</th><th>Inventive step</th><th>Features not found</th></tr>' + ev.claims.map(c => { const x = ev.claimScores[c.n]; return '<tr><td>' + c.n + '</td><td>' + pct(x.novelty) + '</td><td><b>' + pct(x.inventive) + '</b></td><td>' + (x.distinguishing.join(', ') || '—') + '</td></tr>'; }).join('') + '</table>' +
    (ev.issues.length ? '<h3>Remaining formal issues</h3><ul>' + ev.issues.map(i => '<li class="sev-' + i.sev + '">Claim ' + (i.claim || '–') + ': ' + esc(i.msg) + '</li>').join('') + '</ul>' : '') +
    '<p class="note">Re-scored against the same references only. Narrower claims may have new prior art — run a fresh analysis on the amended specification before filing.</p>';
}

// ======================================================================= radar
async function loadRadar() {
  const box = $('#radarList'); box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await relay('radarList', { limit: 80 }); box.dataset.loaded = '1'; S.radar = r.items || [];
    const doms = [...new Set(S.radar.map(i => i.domain))];
    $('#radarDomain').innerHTML = '<option value="">All domains</option>' + doms.map(d => '<option>' + esc(d) + '</option>').join('');
    drawRadar();
  } catch (e) { box.innerHTML = '<p class="sev-error">' + esc(e.message) + '</p>'; }
}
function drawRadar() {
  const f = $('#radarDomain').value; const items = (S.radar || []).filter(i => !f || i.domain === f);
  $('#radarList').innerHTML = items.length ? items.map((it, k) =>
    '<div class="idea"><div class="meta">' + esc(new Date(it.when).toLocaleDateString()) + ' · ' + esc(it.domain) + (it.whitespace !== '' ? ' · white-space <b>' + esc(it.whitespace) + '</b>' : '') + '</div>' +
    '<h3>' + esc(it.title) + '</h3><p><b>Problem.</b> ' + esc(it.problem) + '</p><p><b>Concept.</b> ' + esc(it.concept) + '</p><p><b>Distinguishing feature.</b> ' + esc(it.feature) + '</p>' +
    '<p><b>Application.</b> ' + esc(it.application) + (it.indian ? ' <span class="muted">· ' + esc(it.indian) + '</span>' : '') + '</p>' +
    (it.nearest.length ? '<p class="muted">Nearest patents: ' + it.nearest.map(n => '<a href="' + esc(n.url) + '" target="_blank" rel="noopener">' + esc(n.pn) + '</a> (' + Math.round(100 * n.sim) + '%)').join(', ') + '</p>' : '') +
    (it.sources.length ? '<details><summary>Sources</summary><ul>' + it.sources.map(s => '<li><a href="' + esc(s.uri) + '" target="_blank" rel="noopener">' + esc(s.title || s.uri) + '</a></li>').join('') + it.papers.map(p => '<li><a href="' + esc(p.u) + '" target="_blank" rel="noopener">' + esc(p.t) + '</a></li>').join('') + '</ul></details>' : '') +
    '<button class="btn sm" data-idea="' + k + '">Screen this idea in Analyse</button></div>').join('') : '<p class="muted">No radar items yet. The first weekly run creates them' + (S.user && S.user.role === 'owner' ? ', or press Run now.' : '.') + '</p>';
  $$('[data-idea]').forEach(b => b.onclick = () => {
    const it = items[+b.dataset.idea];
    const pre = String(it.title).replace(/\.$/, '');
    $('#paste').value = it.title + '\n\nFIELD OF THE INVENTION\n' + it.domain + '. ' + it.application + '\n\nSUMMARY OF THE INVENTION\n' + it.problem + ' ' + it.concept + '\n\nWE CLAIM:\n1. A ' + pre.charAt(0).toLowerCase() + pre.slice(1) + ', comprising ' + String(it.feature).replace(/\.$/, '') + '.\n\nABSTRACT\n' + it.concept;
    parseDoc($('#paste').value); showTab('analyse'); $('#parsed').scrollIntoView({ behavior: 'smooth' });
  });
}

// ===================================================================== history
async function loadHistory() {
  const box = $('#histList'); box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await relay('listReports'); box.dataset.loaded = '1';
    box.innerHTML = r.reports.length ? '<table><tr><th>When</th><th>Title</th><th>Index</th><th>Verdict</th><th>Depth</th>' + (S.user.role === 'owner' ? '<th>By</th>' : '') + '<th></th></tr>' + r.reports.map(x => '<tr><td>' + esc(new Date(x.when).toLocaleString()) + '</td><td>' + esc(x.title) + '</td><td>' + esc(x.index) + ' (' + esc(x.band) + ')</td><td>' + esc(x.verdict) + '</td><td>' + esc(x.depth) + '</td>' + (S.user.role === 'owner' ? '<td>' + esc(x.email) + '</td>' : '') + '<td><button class="btn sm" data-open="' + esc(x.id) + '">Open</button></td></tr>').join('') + '</table>' : '<p class="muted">No saved reports.</p>';
    $$('[data-open]').forEach(b => b.onclick = async () => { b.disabled = true; try { S.report = (await relay('getReport', { id: b.dataset.open })).report; S.studioEval = null; renderReport(); renderStudio(); showTab('report'); } catch (e) { alertBox(e.message); } b.disabled = false; });
  } catch (e) { box.innerHTML = '<p class="sev-error">' + esc(e.message) + '</p>'; }
}

// ======================================================================= admin
async function loadUsers(r) {
  try {
    r = r || await relay('listUsers');
    const order = { pending: 0, approved: 1, blocked: 2 };
    r.users.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));
    const np = r.users.filter(x => x.status === 'pending').length;
    $('#usersList').innerHTML = '<p class="muted">' + np + ' pending request(s). Approved users get the default daily AI-call limit unless you set one.</p><table><tr><th>Email</th><th>Status</th><th>Daily AI calls</th><th>Used today</th><th>Note</th><th></th></tr>' + r.users.map(u => '<tr><td>' + esc(u.email) + '</td><td>' + esc(u.status) + '</td><td><input style="width:80px" data-lim="' + esc(u.email) + '" value="' + esc(u.limit) + '" placeholder="default"></td><td>' + esc(u.usedToday) + '</td><td>' + esc(u.note) + '</td><td>' +
      ['approved', 'blocked'].map(s => '<button class="btn sm" data-set="' + s + '" data-u="' + esc(u.email) + '">' + (s === 'approved' ? 'Approve' : (u.status === 'pending' ? 'Reject' : 'Block')) + '</button>').join(' ') + '</td></tr>').join('') + '</table>';
    $$('[data-set]').forEach(b => b.onclick = async () => { const lim = $('[data-lim="' + b.dataset.u + '"]').value; loadUsers(await relay('setUser', { email: b.dataset.u, status: b.dataset.set, limit: lim === '' ? '' : +lim })); pendingBadge(); });
  } catch (e) { $('#usersList').innerHTML = '<p class="sev-error">' + esc(e.message) + '</p>'; }
}

// ===================================================================== helpers
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function alertBox(msg) { modal('<p>' + esc(msg) + '</p>'); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function standaloneHtml() {
  const css = [...document.styleSheets].map(ss => { try { return [...ss.cssRules].map(r => r.cssText).join('\n'); } catch (e) { return ''; } }).join('\n');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Navya report — ' + esc(S.report.title) + '</title><style>' + css + ' .btn{display:none}</style></head><body><main>' + $('#reportView').innerHTML + '</main></body></html>';
}

const METHOD = `
<h2>How Navya scores a patent application</h2>
<p>No model is asked “is this patentable?”. The AI (or the rule-based matcher) is used only to answer narrow, checkable questions; the score is arithmetic on those answers.</p>
<h3>1. Claims → elements</h3>
<p>Claims are split at the transitional phrase (comprising / consisting of / characterised in that) and at semicolons and “wherein” clauses. The preamble is weighted 0.5 by default; you can change any weight or element text before running. A dependent claim's elements are its parent chain plus its own added limitation.</p>
<h3>2. Search</h3>
<p>Deterministic keyword queries (TF-weighted terms from title, claims, abstract) plus optional AI-written queries, run against Google Patents (dated before your cut-off) and OpenAlex. Optional: Gemini with Google Search grounding. All queries are recorded in the report.</p>
<h3>3. Screening</h3>
<p>Candidates are ranked by TF-IDF cosine similarity to the invention, then the top N (full text for patents) are mapped.</p>
<h3>4. Element mapping</h3>
<p>For every (reference, element) pair: <b>disclosed = 1</b>, <b>partial = 0.5</b>, <b>absent = 0</b>.<br>
AI mode: the model sees the blinded element list and one document, must quote 10–40 verbatim words for any disclosed/partial call, and the quote is searched in the document (exact, or ≥ 85 % token overlap in a sliding window). An unverifiable quote counts as 0. With double-check on, a second run reverses element order and document position; the cell value is the mean, and the min/max form the band.<br>
Rule mode: the best-covering sentence (or sentence pair) is found by rarity-weighted term overlap; coverage ≥ 0.75 → disclosed, ≥ 0.45 → partial.</p>
<h3>5. Scores for each claim (weights w<sub>i</sub>, values v<sub>r,i</sub>)</h3>
<p>Single-reference coverage C<sub>1</sub>(r) = Σ w<sub>i</sub> v<sub>r,i</sub> / Σ w<sub>i</sub>.<br>
<b>Novelty</b> = 1 − max<sub>r</sub> C<sub>1</sub>(r). A claim is <i>anticipated</i> when one reference discloses every element.<br>
Two-reference coverage C<sub>2</sub>(r,q) = Σ w<sub>i</sub> max(v<sub>r,i</sub>, v<sub>q,i</sub>) / Σ w<sub>i</sub>.<br>
<b>Inventive step</b> = 1 − max<sub>r,q</sub> C<sub>2</sub>(r,q). It is always ≤ novelty, so it is used as the claim's patentability score.<br>
<b>Patentability index</b> = 100 × the best claim's score; 0 only if you confirm a Sec. 3 exclusion. Verdict bands: ≥ 70 strong, 40–69 moderate, &lt; 40 weak.</p>
<h3>What the number does and does not mean</h3>
<ul><li>It is an <b>upper bound</b> given the search: more prior art can only raise coverage and lower the score. “Search depth” tells you how much to trust it.</li>
<li>Two-reference combination is a proxy for obviousness; it ignores whether a skilled person would combine them (motivation, teaching away). A real examiner may also combine three documents or rely on common general knowledge.</li>
<li>Rule mode misses synonyms (“tarpaulin” vs “sheet”), so it overstates novelty. AI mode reads meaning but can still miss implicit disclosure.</li>
<li>Bias controls: applicant / inventor / address lines are removed before any model sees the text; references are judged without assignee names; judgements need quotes; aggregation is fixed arithmetic. This reduces bias; it cannot remove the bias of what the search engines index.</li></ul>
<h3>Opportunity Radar</h3>
<p>Weekly, the relay takes two mechanical-engineering domains in rotation, pulls recent papers from OpenAlex, asks Gemini (with Google Search) for concrete device/process inventions tied to reported problems, then checks each idea's nearest Google Patents hits. White-space = 1 − similarity to the nearest hit — a screening signal only.</p>`;

// ====================================================================== wiring
function init() {
  $('#cutoff').value = new Date().toISOString().slice(0, 10);
  $('#methodView').innerHTML = METHOD;
  $$('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  const t = location.hash.slice(1); if (t && $('#tab-' + t)) showTab(t);
  const drop = $('#drop');
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  $('#file').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); };
  $('#parseBtn').onclick = () => { if ($('#paste').value.trim()) parseDoc($('#paste').value); };
  $('#runBtn').onclick = runAnalysis;
  $('#stopBtn').onclick = () => { S.abort = true; };
  $('#mode').onchange = () => { const ai = $('#mode').value === 'ai'; $('#optConsistency').disabled = !ai; $('#optWeb').disabled = !ai; };
  $('#radarLoad').onclick = loadRadar; $('#radarDomain').onchange = drawRadar;
  $('#radarRun').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Running (1–3 min)…'; try { await relay('radarRunNow'); await loadRadar(); } catch (err) { alertBox(err.message); } e.target.disabled = false; e.target.textContent = 'Run now'; };
  $('#histLoad').onclick = loadHistory; $('#usersLoad').onclick = () => loadUsers();
  $('#modalX').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
  initAuth();
}
async function loadFile(f) {
  $('#fileInfo').textContent = 'Reading ' + f.name + '…';
  try { const t = await readFile(f); $('#paste').value = t; $('#fileInfo').textContent = f.name + ' · ' + t.length.toLocaleString() + ' characters'; parseDoc(t); }
  catch (e) { $('#fileInfo').textContent = e.message; }
}
window.NavyaDebug = { S, scoreReport, renderReport, renderStudio };
document.addEventListener('DOMContentLoaded', init);
})();
