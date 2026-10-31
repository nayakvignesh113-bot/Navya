/* Navya — Patent Engine: deterministic core.
 * Pure functions only (no network, no DOM). Everything that produces a number
 * lives here so the score is reproducible and auditable.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- text utils
  const STOP = new Set(('a an the and or of to in on at by for from with without into onto over under ' +
    'is are was were be been being has have had do does did this that these those it its their them ' +
    'as such than then there here which who whom whose what when where while within between among ' +
    'said wherein whereby thereof therein thereto therewith herein hereby comprising comprises comprise ' +
    'consisting consists including includes include having has characterized characterised claim claims ' +
    'claimed invention present embodiment embodiments accordance according provided providing provides ' +
    'least one two three plurality first second third configured adapted arranged operable means ' +
    'further also may can could should would will shall each any all other another same respective ' +
    'via about approximately substantially preferably optionally example examples e g i fig figs figure figures ' +
    'disclosed disclosure described shown method system device apparatus assembly unit member element ' +
    'part portion based using used use thereby so not no only more most less very well like etc').split(/\s+/));

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[‐-―]/g, '-').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function stem(w) {
    if (w.length <= 3) return w;
    if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
    if (/sses$/.test(w)) return w.slice(0, -2);
    if (/[^su]s$/.test(w)) w = w.slice(0, -1);
    if (w.length > 6 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 5 && /ed$/.test(w)) return w.slice(0, -2);
    if (w.length > 5 && /e$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function tokens(s) { const t = norm(s); return t ? t.split(' ') : []; }
  function contentTokens(s) {
    return tokens(s).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
  }

  // ------------------------------------------------------------ section parser
  const SECTION_PATTERNS = [
    ['title', /^\s*(?:title(?: of the invention)?)\s*[:\-]?\s*$/i],
    ['field', /^\s*(?:(?:technical\s+)?field(?: of(?: the)? invention)?|field)\s*[:\-]?\s*$/i],
    ['background', /^\s*(?:background(?: of(?: the)? invention| art)?|prior art|description of (?:the )?(?:related|prior) art)\s*[:\-]?\s*$/i],
    ['objects', /^\s*(?:objects?(?: of(?: the)? invention)?)\s*[:\-]?\s*$/i],
    ['summary', /^\s*(?:summary(?: of(?: the)? invention)?|statement of invention)\s*[:\-]?\s*$/i],
    ['drawings', /^\s*(?:brief description of (?:the )?(?:accompanying )?drawings?|description of (?:the )?drawings?)\s*[:\-]?\s*$/i],
    ['description', /^\s*(?:detailed description(?: of(?: the)? (?:invention|preferred embodiments?))?|description of (?:the )?(?:preferred )?embodiments?)\s*[:\-]?\s*$/i],
    ['claims', /^\s*(?:claims|we claim|i claim|what is claimed is|the claims|claims:?|we claim:|i claim:)\s*[:\-]?\s*$/i],
    ['abstract', /^\s*(?:abstract(?: of(?: the)? (?:invention|disclosure))?)\s*[:\-]?\s*$/i],
  ];

  function parseSections(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const marks = [];
    let off = 0;
    for (const line of lines) {
      const L = line.trim().replace(/^\d+(\.\d+)*\s*[.)]?\s*/, '');
      if (L.length && L.length < 90) {
        for (const [key, re] of SECTION_PATTERNS) {
          if (re.test(L)) { marks.push({ key, at: off, end: off + line.length }); break; }
        }
      }
      off += line.length + 1;
    }
    // Claims: the LAST claims heading wins (the word "claims" appears in prose too).
    const out = { _headingsFound: [] };
    const full = lines.join('\n');
    const claimMarks = marks.filter(m => m.key === 'claims');
    let use = marks.filter(m => m.key !== 'claims');
    if (claimMarks.length) use.push(claimMarks[claimMarks.length - 1]);
    // first occurrence for other keys
    const seen = new Set(); use = use.sort((a, b) => a.at - b.at).filter(m => (seen.has(m.key) ? false : (seen.add(m.key), true)));
    use.forEach((m, i) => {
      const next = use[i + 1];
      out[m.key] = full.slice(m.end, next ? next.at : full.length).trim();
      out._headingsFound.push(m.key);
    });
    // inline "We claim:" with claim 1 on the same line
    if (!out.claims) {
      const m = full.match(/\b(?:we|i)\s+claim\s*:?\s*\n?/i) || full.match(/what is claimed is\s*:?/i);
      if (m) {
        let rest = full.slice(m.index + m[0].length);
        const ab = rest.search(/\n\s*abstract\b/i);
        if (ab > 0) rest = rest.slice(0, ab);
        out.claims = rest.trim(); out._headingsFound.push('claims(inline)');
      }
    }
    if (!out.title) {
      const first = lines.map(l => l.trim()).find(l => l.length > 8 && l.length < 200 && !/^(form|the patents act|complete specification|provisional specification)/i.test(l));
      out.title = first || '';
    }
    out._full = full;
    return out;
  }

  // Blind the text: remove applicant / inventor / address lines before any model sees it.
  function blind(text) {
    return String(text || '').split('\n').filter(l => !/\b(applicant|inventor|nationality|address|e-?mail|phone|signature|agent for|dated this)\b/i.test(l)).join('\n');
  }

  // ------------------------------------------------------------- claim parser
  function parseClaims(claimsText) {
    const t = String(claimsText || '').replace(/\r/g, '');
    const re = /(?:^|\n|(?<=\.)\s{1,3})\s*(\d{1,3})\s*[.)]\s+(?=[A-Za-z(])/g;
    const hits = []; let m; let expect = 1;
    while ((m = re.exec(t))) {
      const n = parseInt(m[1], 10);
      if (n === expect) { hits.push({ n, at: m.index + m[0].length, start: m.index }); expect++; }
    }
    const claims = hits.map((h, i) => {
      const end = hits[i + 1] ? hits[i + 1].start : t.length;
      let text = t.slice(h.at, end).replace(/\s+/g, ' ').trim();
      if (i < hits.length - 1 || true) text = text.replace(/\s*(?:dated this|abstract\b).*$/i, '').trim();
      return { n: h.n, text };
    });
    for (const c of claims) {
      c.deps = claimRefs(c.text).filter(d => d !== c.n);
      c.selfRef = claimRefs(c.text).includes(c.n);
      c.independent = c.deps.length === 0;
    }
    return claims;
  }

  function claimRefs(text) {
    const out = new Set();
    const re = /\bclaims?\s+((?:\d+\s*(?:,|to|-|–|or|and|and\/or)?\s*)+)/gi; let m;
    while ((m = re.exec(text))) {
      const seg = m[1];
      const nums = seg.match(/\d+/g) || [];
      if (/\d+\s*(?:to|-|–)\s*\d+/.test(seg)) {
        const r = seg.match(/(\d+)\s*(?:to|-|–)\s*(\d+)/);
        const a = +r[1], b = +r[2];
        for (let k = Math.min(a, b); k <= Math.max(a, b) && k - a < 50; k++) out.add(k);
      }
      nums.forEach(x => out.add(+x));
    }
    return [...out].sort((a, b) => a - b);
  }

  const TRANSITION = /\b(comprising|comprises|consisting essentially of|consisting of|which comprises|including|includes|characteri[sz]ed (?:in that|by)|having)\b\s*:?,?/i;

  function splitElements(claim) {
    const txt = claim.text.replace(/\.$/, '');
    const els = [];
    if (!claim.independent) {
      // "The X as claimed in claim 1, wherein ..." -> keep the added limitation
      let body = txt.replace(/^.*?\bclaims?\s+(?:\d+\s*(?:,|to|-|–|or|and)?\s*)+,?\s*/i, '');
      body = body.replace(/^(?:wherein|in which|further comprising|characteri[sz]ed in that|where)\s*,?\s*/i, '');
      splitBody(body).forEach(b => els.push({ text: b, kind: 'added' }));
      return label(claim.n, els.length ? els : [{ text: txt, kind: 'added' }]);
    }
    const m = txt.match(TRANSITION);
    let pre = '', body = txt;
    if (m && m.index > 3) { pre = txt.slice(0, m.index).replace(/[,:\s]+$/, ''); body = txt.slice(m.index + m[0].length); }
    if (pre) els.push({ text: pre, kind: 'preamble' });
    // two-part claim: part after "characterized in that" is the characterizing portion
    const ch = body.search(/\bcharacteri[sz]ed (?:in that|by)\b/i);
    if (ch >= 0) {
      splitBody(body.slice(0, ch)).forEach(b => els.push({ text: b, kind: 'body' }));
      splitBody(body.slice(ch).replace(/^characteri[sz]ed (?:in that|by)\s*,?/i, '')).forEach(b => els.push({ text: b, kind: 'characterizing' }));
    } else splitBody(body).forEach(b => els.push({ text: b, kind: 'body' }));
    return label(claim.n, els);
  }

  function splitBody(body) {
    return String(body)
      .split(/;\s*(?:and\s+)?|\s*,?\s*\bwherein\b\s*|\s(?=\(?[a-z]\)\s)|\s(?=\([ivx]+\)\s)/i)
      .map(s => s.replace(/^\(?[a-z]\)\s*|^\([ivx]+\)\s*/i, '').replace(/^(and|,)\s+/i, '').replace(/[,;:\s]+$/, '').trim())
      .filter(s => s.length > 3);
  }

  function label(n, els) {
    return els.map((e, i) => ({ id: n + String.fromCharCode(97 + i), claim: n, text: e.text, kind: e.kind, weight: e.kind === 'preamble' ? 0.5 : 1 }));
  }

  // Full element chain for a claim (parent elements + own)
  function elementChain(claimNo, claimsByNo, elementsByClaim, guard) {
    guard = guard || new Set();
    if (guard.has(claimNo)) return [];
    guard.add(claimNo);
    const c = claimsByNo[claimNo]; if (!c) return [];
    const own = elementsByClaim[claimNo] || [];
    if (c.independent) return own.slice();
    const parent = c.deps.find(d => d < claimNo && claimsByNo[d]);
    return parent ? elementChain(parent, claimsByNo, elementsByClaim, guard).concat(own) : own.slice();
  }

  // ------------------------------------------------------------ formal checks
  const INDEFINITE = ['about', 'approximately', 'substantially', 'preferably', 'optionally', 'such as', 'for example', 'e.g.', 'etc', 'and/or', 'or the like', 'suitable', 'if desired', 'if required', 'may be', 'can be', 'generally', 'relatively', 'conventional'];

  function formalChecks(claims, sections) {
    const issues = [];
    const byNo = Object.fromEntries(claims.map(c => [c.n, c]));
    const desc = norm([sections.title, sections.abstract, sections.description, sections.summary, sections.drawings, sections.field, sections.background, sections.objects].join(' '));
    const descSet = new Set(desc.split(' ').map(stem));
    if (!claims.length) issues.push({ claim: 0, sev: 'error', code: 'NO_CLAIMS', msg: 'No numbered claims found. Claims must be numbered 1, 2, 3 … after a "We claim" / "Claims" heading.' });
    const ind = claims.filter(c => c.independent);
    if (claims.length && !ind.length) issues.push({ claim: 0, sev: 'error', code: 'NO_INDEPENDENT', msg: 'Every claim refers to another claim — there is no independent claim.' });
    if (claims.length > 10) issues.push({ claim: 0, sev: 'info', code: 'CLAIM_FEES', msg: claims.length + ' claims. Indian Patent Rules levy an additional fee per claim beyond 10 — check the current fee schedule.' });
    for (const c of claims) {
      const T = c.text;
      if (c.selfRef) issues.push({ claim: c.n, sev: 'error', code: 'SELF_REF', msg: 'Claim refers to itself.' });
      for (const d of c.deps) {
        if (!byNo[d]) issues.push({ claim: c.n, sev: 'error', code: 'BAD_DEP', msg: 'Refers to claim ' + d + ', which does not exist.' });
        else if (d > c.n) issues.push({ claim: c.n, sev: 'error', code: 'FORWARD_DEP', msg: 'Refers to a later claim (' + d + '). A dependent claim may refer only to preceding claims.' });
      }
      if (c.deps.length > 1) {
        issues.push({ claim: c.n, sev: 'info', code: 'MULTI_DEP', msg: 'Multiple dependency (claims ' + c.deps.join(', ') + '). Allowed in India but must be in the alternative ("or"); scoring uses the first parent.' });
        if (/\band\b/.test((T.match(/claims?\s+[\d\s,and]+/i) || [''])[0]) && !/\bor\b/.test((T.match(/claims?\s+[\d\s,ortand]+/i) || [''])[0])) issues.push({ claim: c.n, sev: 'warn', code: 'MULTI_DEP_AND', msg: 'Multiple dependency uses "and" instead of the alternative "or".' });
      }
      if (!/\.\s*$/.test(T)) issues.push({ claim: c.n, sev: 'warn', code: 'NO_PERIOD', msg: 'Claim does not end with a full stop (each claim should be one sentence ending in a period).' });
      const inner = T.replace(/\b(?:e\.g|i\.e|fig|figs|no|nos|approx|wt|vol|viz|etc|deg|min|max|dia)\./gi, 'X').replace(/\d\.\d/g, 'X');
      if (/\.\s+[A-Z]/.test(inner.replace(/\.\s*$/, ''))) issues.push({ claim: c.n, sev: 'warn', code: 'MULTI_SENTENCE', msg: 'Claim appears to contain more than one sentence.' });
      if (/\b(?:as shown in|as illustrated in|as depicted in|with reference to)\s+(?:the\s+)?(?:fig|figure|drawing)/i.test(T)) issues.push({ claim: c.n, sev: 'error', code: 'REF_DRAWING', msg: 'Claim relies on the drawings ("as shown in Fig…"). Claims must define the invention in words.' });
      const low = ' ' + T.toLowerCase() + ' ';
      const found = INDEFINITE.filter(w => low.includes(' ' + w + ' ') || low.includes(' ' + w + ',') || low.includes(' ' + w + '.'));
      if (found.length) issues.push({ claim: c.n, sev: 'warn', code: 'INDEFINITE', msg: 'Indefinite / optional wording: ' + found.map(w => '"' + w + '"').join(', ') + '. Optional or relative terms weaken the scope; state numeric ranges or move optional features to dependent claims.' });
      // antecedent basis
      const chainText = chainTextBefore(c, byNo);
      const ab = antecedentIssues(T, chainText);
      if (ab.length) issues.push({ claim: c.n, sev: 'warn', code: 'ANTECEDENT', msg: 'Possible missing antecedent basis: ' + ab.slice(0, 6).map(w => '"the ' + w + '"').join(', ') + (ab.length > 6 ? ' …' : '') + '. Introduce each feature with "a/an" before referring to it as "the/said".' });
      // support in description (Sec. 10(4)/(5))
      if (desc.length > 200) {
        const surf = tokens(T).filter(w => w.length > 4 && !STOP.has(w) && !/^\d+$/.test(w));
        const miss = [...new Set(surf.filter(w => !descSet.has(stem(w))))];
        if (miss.length) issues.push({ claim: c.n, sev: 'warn', code: 'SUPPORT', msg: 'Terms not found anywhere in the description: ' + miss.slice(0, 8).join(', ') + (miss.length > 8 ? ' …' : '') + '. Claims must be fairly based on the matter disclosed.' });
      }
      if (T.length > 1800) issues.push({ claim: c.n, sev: 'info', code: 'LONG', msg: 'Very long claim (' + T.length + ' characters). Long independent claims are narrow and easy to design around.' });
    }
    return issues;
  }

  function chainTextBefore(c, byNo) {
    let s = ''; const seen = new Set(); let cur = c;
    while (cur && !cur.independent) {
      const p = cur.deps.find(d => d < cur.n && byNo[d]);
      if (!p || seen.has(p)) break; seen.add(p); cur = byNo[p]; s = cur.text + ' ' + s;
    }
    return s;
  }

  const AB_SKIP = new Set(['same', 'said', 'other', 'first', 'second', 'third', 'one', 'two', 'end', 'top', 'bottom', 'outer', 'inner', 'upper', 'lower', 'front', 'rear', 'left', 'right', 'center', 'centre', 'middle', 'rest', 'remaining', 'entire', 'whole', 'invention', 'claim', 'group', 'range', 'time', 'help', 'aid', 'form', 'presence', 'absence', 'use', 'case', 'order', 'basis', 'manner', 'way', 'like', 'atmosphere', 'ambient', 'environment', 'surface', 'surrounding', 'art', 'user', 'following']);
  function antecedentIssues(text, before) {
    const out = [];
    const low = text.toLowerCase();
    const re = /\b(?:the\s+said|the|said)\s+([a-z][a-z\-]+)/g; let m;
    while ((m = re.exec(low))) {
      const w = m[1];
      if (w.length < 4 || AB_SKIP.has(w) || STOP.has(w)) continue;
      const earlier = (before + ' ' + low.slice(0, m.index)).toLowerCase();
      const sw = stem(w);
      const has = new RegExp('\\b' + sw.replace(/[-]/g, '\\-') + '[a-z]*\\b').test(earlier);
      if (!has && !out.includes(w)) out.push(w);
    }
    return out;
  }

  // ------------------------------------------------------- keyword extraction
  function keywords(sections, n) {
    n = n || 18;
    const tf = new Map(), raw = new Map(), surface = new Map();
    const add = (s, w) => {
      const surf = tokens(s).filter(x => x.length > 2 && !STOP.has(x) && !/^\d+$/.test(x));
      const t = surf.map(stem);
      t.forEach((x, i) => { if (!surface.has(x)) surface.set(x, surf[i]); tf.set(x, (tf.get(x) || 0) + w); raw.set(x, (raw.get(x) || 0) + 1); });
      for (let i = 0; i + 1 < t.length; i++) {
        if (t[i] === t[i + 1]) continue;
        const b = t[i] + ' ' + t[i + 1]; tf.set(b, (tf.get(b) || 0) + w * 1.5); raw.set(b, (raw.get(b) || 0) + 1);
      }
    };
    add(sections.title || '', 3);
    add(sections.claimsText || sections.claims || '', 2);
    add(sections.abstract || '', 2);
    add(sections.summary || '', 1);
    add(sections.field || '', 1.5);
    const items = [...tf.entries()].filter(([k]) => (raw.get(k) || 0) >= 2).sort((a, b) => b[1] - a[1]);
    return items.slice(0, n).map(([k]) => k.split(' ').map(x => surface.get(x) || x).join(' '));
  }

  // ---------------------------------------------------- similarity (TF-IDF)
  function tfidfRank(queryText, docs) {
    const qd = contentTokens(queryText);
    const D = docs.map(d => contentTokens(d));
    const df = new Map();
    [qd, ...D].forEach(arr => new Set(arr).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
    const N = D.length + 1;
    const vec = arr => {
      const v = new Map(); arr.forEach(w => v.set(w, (v.get(w) || 0) + 1));
      let nrm = 0; for (const [w, c] of v) { const x = (1 + Math.log(c)) * Math.log(1 + N / df.get(w)); v.set(w, x); nrm += x * x; }
      nrm = Math.sqrt(nrm) || 1; for (const [w, x] of v) v.set(w, x / nrm); return v;
    };
    const q = vec(qd);
    return D.map(arr => { const v = vec(arr); let s = 0; for (const [w, x] of q) if (v.has(w)) s += x * v.get(w); return s; });
  }

  // ------------------------------------------------------- quote verification
  function verifyQuote(quote, source) {
    const q = tokens(quote), S = tokens(source);
    if (q.length < 4) return { ok: false, how: 'too-short', score: 0 };
    const qs = q.join(' '), ss = ' ' + S.join(' ') + ' ';
    if (ss.includes(' ' + qs + ' ')) return { ok: true, how: 'exact', score: 1 };
    const m = q.length; if (S.length < m) return { ok: false, how: 'none', score: 0 };
    const need = new Map(); q.forEach(w => need.set(w, (need.get(w) || 0) + 1));
    const win = new Map(); let matched = 0, best = 0;
    const inc = w => { if (!need.has(w)) return; const c = (win.get(w) || 0) + 1; win.set(w, c); if (c <= need.get(w)) matched++; };
    const dec = w => { if (!need.has(w)) return; const c = win.get(w); win.set(w, c - 1); if (c <= need.get(w)) matched--; };
    for (let i = 0; i < S.length; i++) {
      inc(S[i]); if (i >= m) dec(S[i - m]);
      if (i >= m - 1 && matched > best) best = matched;
    }
    const score = best / m;
    return { ok: score >= 0.85, how: score >= 0.85 ? 'fuzzy' : 'none', score: +score.toFixed(3) };
  }

  // ------------------------------------------------------------------ scoring
  const VAL = { disclosed: 1, partial: 0.5, absent: 0 };

  /* evidence[refId][elementId] = [{status, quote, verified}, ...runs]
   * returns per-element {mean, lo, hi, disagree, unverified}
   */
  function elementValue(runs) {
    if (!runs || !runs.length) return { mean: 0, lo: 0, hi: 0, disagree: false, unverified: false };
    const vals = runs.map(r => (r.verified ? (VAL[r.status] || 0) : 0));
    const unverified = runs.some(r => (r.status === 'disclosed' || r.status === 'partial') && !r.verified);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { mean, lo: Math.min(...vals), hi: Math.max(...vals), disagree: Math.min(...vals) !== Math.max(...vals), unverified };
  }

  function scoreClaim(elements, refIds, evidence) {
    const W = elements.reduce((a, e) => a + e.weight, 0) || 1;
    const V = {}; // V[ref][el] = elementValue
    refIds.forEach(r => { V[r] = {}; elements.forEach(e => { V[r][e.id] = elementValue(evidence[r] && evidence[r][e.id]); }); });
    const cov = (r, k) => elements.reduce((a, e) => a + e.weight * V[r][e.id][k], 0) / W;
    const pair = (r, q, k) => elements.reduce((a, e) => a + e.weight * Math.max(V[r][e.id][k], V[q][e.id][k]), 0) / W;
    const res = {};
    for (const k of ['mean', 'lo', 'hi']) {
      let c1 = 0, best1 = null, c2 = 0, best2 = null;
      refIds.forEach(r => { const c = cov(r, k); if (c > c1) { c1 = c; best1 = r; } });
      for (let i = 0; i < refIds.length; i++) for (let j = i; j < refIds.length; j++) {
        const c = pair(refIds[i], refIds[j], k); if (c > c2) { c2 = c; best2 = [refIds[i], refIds[j]]; }
      }
      res[k] = { singleCoverage: c1, closest: best1, pairCoverage: c2, bestPair: best2, novelty: 1 - c1, inventive: 1 - c2 };
    }
    const distinguishing = elements.filter(e => refIds.every(r => V[r][e.id].hi === 0)).map(e => e.id);
    const uncertain = elements.filter(e => refIds.some(r => V[r][e.id].disagree || V[r][e.id].unverified)).map(e => e.id);
    return {
      anticipated: res.mean.singleCoverage >= 0.999,
      novelty: res.mean.novelty,
      inventive: res.mean.inventive,
      patentability: res.mean.inventive,               // inventive ≤ novelty always
      band: [res.hi.inventive, res.lo.inventive],       // more prior art found → lower score
      closest: res.mean.closest, bestPair: res.mean.bestPair,
      singleCoverage: res.mean.singleCoverage, pairCoverage: res.mean.pairCoverage,
      distinguishing, uncertain, perElement: V,
    };
  }

  function overall(claimScores, opts) {
    opts = opts || {};
    const list = Object.entries(claimScores).map(([n, s]) => Object.assign({ n: +n }, s)).filter(x => !x.invalid);
    if (!list.length) return { index: 0, band: [0, 0], verdict: 'No valid claims to score', bestClaim: null, bestIndependent: null, broadIndex: 0, fallbackIndex: 0 };
    const pickBest = arr => arr.reduce((a, b) => (b.patentability > a.patentability ? b : a));
    const indep = list.filter(x => x.independent);
    const bestInd = indep.length ? pickBest(indep) : pickBest(list);
    const best = pickBest(list);
    // Headline = the broadest independent claim as filed; fallback = best claim incl. dependents.
    let index = Math.round(100 * bestInd.patentability);
    let band = [Math.round(100 * bestInd.band[0]), Math.round(100 * bestInd.band[1])];
    let fallbackIndex = Math.round(100 * best.patentability);
    if (opts.excluded) { index = 0; band = [0, 0]; fallbackIndex = 0; }
    const verdict = opts.excluded ? 'Excluded subject matter (user-confirmed)'
      : index >= 70 ? 'Strong — distinguishing features survive the search'
        : index >= 40 ? 'Moderate — amend claims toward the distinguishing features'
          : index > 0 ? 'Weak as filed — most claimed features are found in the prior art' + (fallbackIndex >= 40 ? '; a dependent-claim fallback is stronger' : '')
            : 'Anticipated / fully covered by the references found';
    return { index, band, verdict, bestClaim: best.n, bestIndependent: bestInd.n, broadIndex: index, fallbackIndex };
  }

  function searchDepth(stats) {
    const notes = [];
    if (stats.sourcesOk < 2) notes.push('fewer than two search sources responded');
    if (stats.mapped < 6) notes.push('fewer than six references were mapped element-by-element');
    if (stats.screened < 30) notes.push('fewer than 30 candidates were screened');
    return { level: notes.length === 0 ? 'adequate' : notes.length === 1 ? 'limited' : 'shallow', notes };
  }


  // ------------------------------------------------- rule-based mapper (no AI)
  // Lexical: finds the reference sentence that best covers each element's
  // content words, weighted by rarity. Misses synonyms, so it tends to OVERstate
  // novelty — consistent with the score being an upper bound.
  const RULE = { disclosed: 0.75, partial: 0.45 };
  function sentences(text) {
    return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.;:])\s+(?=[A-Z0-9(])/).map(x => x.trim()).filter(x => x.length > 20);
  }
  function ruleMap(elements, refText) {
    const S = sentences(refText);
    const ST = S.map(x => new Set(contentTokens(x)));
    const df = new Map(); ST.forEach(set => set.forEach(w => df.set(w, (df.get(w) || 0) + 1)));
    const N = S.length || 1;
    const out = {};
    for (const e of elements) {
      const terms = [...new Set(contentTokens(e.text))];
      if (!terms.length) { out[e.id] = [{ status: 'absent', quote: '', verified: false, how: 'rule' }]; continue; }
      const w = t => Math.log(1 + N / (1 + (df.get(t) || 0))) + 0.5;
      const W = terms.reduce((a, t) => a + w(t), 0);
      let best = 0, bestOwn = 0, bi = -1;
      ST.forEach((set, i) => {
        // allow a window of the sentence and its neighbour (features often span two sentences)
        const nb = ST[i + 1] || new Set();
        const c = terms.reduce((a, t) => a + (set.has(t) || nb.has(t) ? w(t) : 0), 0) / W;
        const own = terms.reduce((a, t) => a + (set.has(t) ? w(t) : 0), 0) / W;
        if (c + 0.01 * own > best + 0.01 * bestOwn) { best = c; bestOwn = own; bi = i; }
      });
      const status = best >= RULE.disclosed ? 'disclosed' : best >= RULE.partial ? 'partial' : 'absent';
      out[e.id] = [{ status, quote: status === 'absent' ? '' : (S[bi] + (ST[bi + 1] && ![...new Set(contentTokens(e.text))].every(t => ST[bi].has(t)) ? ' ' + S[bi + 1] : '')).slice(0, 500), verified: status !== 'absent', how: 'rule', cover: +best.toFixed(2) }];
    }
    return out;
  }

  // ------------------------------------------- Sec. 3 keyword screen (no AI)
  const SEC3 = [
    ['3(d)', /\b(new use|novel use|use of (?:a |the )?known|new form of a known|known substance)\b/i, 'Mere new use / new form of a known substance, or mere use of a known process or machine'],
    ['3(e)', /\b(admixture|mixture of|blend of|composition comprising)\b/i, 'Mere admixture giving only an aggregation of the properties of its components'],
    ['3(f)', /\b(arrangement of known|re-?arrangement|duplication of known)\b/i, 'Mere arrangement / re-arrangement / duplication of known devices functioning independently'],
    ['3(h)', /\bmethod of (?:agriculture|horticulture|cultivat|growing|farming)/i, 'Method of agriculture or horticulture'],
    ['3(i)', /\b(treatment of (?:a )?(?:patient|disease|human|animal)|surgical|therapeutic|diagnostic method)\b/i, 'Process for medicinal, surgical, curative, diagnostic or therapeutic treatment'],
    ['3(k)', /\b(computer program|software|algorithm|business method|mathematical method)\b/i, 'Mathematical or business method, computer program per se, or algorithm'],
    ['3(m)', /\b(mental act|method of playing|scheme|rule for)\b/i, 'Mere scheme, rule or method of performing a mental act or playing a game'],
    ['3(n)', /\b(presentation of information|displaying information)\b/i, 'Presentation of information'],
  ];
  function sec3Screen(claimsText) {
    const flags = [];
    for (const [cl, re, what] of SEC3) { const m = String(claimsText).match(re); if (m) flags.push({ clause: cl, risk: 'check', reason: what, quote: m[0], how: 'keyword' }); }
    return flags;
  }

  // ------------------------------------------- deterministic amendment helper
  function mergeClaim(parentText, childText) {
    const base = String(parentText).replace(/\.\s*$/, '');
    let add = String(childText).replace(/\.\s*$/, '');
    add = add.replace(/^.*?\bclaims?\s+(?:\d+\s*(?:,|to|-|–|or|and)?\s*)+,?\s*/i, '').replace(/^(?:wherein|in which|where)\s*,?\s*/i, '');
    const joiner = /^further compris/i.test(add) ? ', ' : ', wherein ';
    return base + joiner + add + '.';
  }

  const API = { ruleMap, sentences, sec3Screen, mergeClaim, norm, stem, tokens, contentTokens, parseSections, blind, parseClaims, claimRefs, splitElements, elementChain,
    formalChecks, antecedentIssues, keywords, tfidfRank, verifyQuote, elementValue, scoreClaim, overall, searchDepth, VAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Engine = API;
})(typeof window !== 'undefined' ? window : globalThis);
