const CH = JSON.parse(document.getElementById('book').textContent);
const DOC = JSON.parse(document.getElementById('doc').textContent);   // { id, title, group: { id, name }, pdf }
const $ = id => document.getElementById(id);
// reading position is per document; display settings are shared
const scopeKey = k => (k === 'prefs' || k === 'docked') ? 'margins:' + k : `margins:${DOC.id}:${k}`;
const store = {
  get(k, d) { try { const v = localStorage.getItem(scopeKey(k)); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(scopeKey(k), JSON.stringify(v)); } catch {} }
};
const WPM = 230;
const mins = w => { const m = Math.max(1, Math.round(w / WPM)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const REF = /\[\[n:(\d+)\]\]/g;
const plain = s => s.replace(REF, '');

// § index per treatise: { first: {27: chapterIndex}, second: {...} }
// § numbers can restart per part (e.g. First / Second Treatise), so index them per group
const SEC_GROUPS = [];
const secIndex = {};
CH.forEach((c, i) => c.blocks.forEach(b => {
  const m = b.x.match(/^§ ?(\d+)\./); if (!m) return;
  if (!(c.group in secIndex)) { secIndex[c.group] = {}; SEC_GROUPS.push(c.group); }
  secIndex[c.group][m[1]] ??= i;
}));
const secGroupOf = c => Math.max(0, SEC_GROUPS.indexOf(c.group));
if (SEC_GROUPS.length) {
  $('gotoTreatise').innerHTML = SEC_GROUPS.map((g, i) => `<option value="${i}">${g.replace(/[<>&]/g, '').slice(0, 28)}</option>`).join('');
  $('gotoTreatise').hidden = SEC_GROUPS.length < 2;
} else $('gotoForm').hidden = true;

/* ---------- settings ---------- */
const FACES = [
  { id: 'literata', name: 'Literata', note: 'Made for screens', css: '"Literata", "Iowan Old Style", Georgia, serif' },
  { id: 'source', name: 'Source Serif', note: 'Crisp and modern', css: '"Source Serif 4", Georgia, serif' },
  { id: 'newsreader', name: 'Newsreader', note: 'Editorial', css: '"Newsreader", Georgia, serif', scale: 1.04 },
  { id: 'lora', name: 'Lora', note: 'Soft, calligraphic', css: '"Lora", Georgia, serif', scale: .97 },
  { id: 'garamond', name: 'EB Garamond', note: 'Locke’s own era', css: '"EB Garamond", Garamond, Georgia, serif', scale: 1.12 },
  { id: 'crimson', name: 'Crimson Pro', note: 'Classic book face', css: '"Crimson Pro", Georgia, serif', scale: 1.1 },
  { id: 'atkinson', name: 'Atkinson', note: 'Highest legibility', css: '"Atkinson Hyperlegible", system-ui, sans-serif', scale: .96 },
  { id: 'lexend', name: 'Lexend', note: 'Easy on tired eyes', css: '"Lexend", system-ui, sans-serif', scale: .92 },
];
const DEFAULTS = { theme: 'system', size: innerWidth < 560 ? '19' : '21', measure: '66', leading: '1.65', face: 'literata', comments: 'on' };
const prefs = Object.assign({}, DEFAULTS, store.get('prefs', {}));
if (prefs.face === 'serif') prefs.face = 'literata';
if (prefs.face === 'sans') prefs.face = 'atkinson';
$('faces').innerHTML = FACES.map(f => `<button data-face="${f.id}" style="font-family:${f.css.replace(/"/g, "'")}">${f.name}<small>${f.note}</small></button>`).join('');
$('faces').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const anchor = topVisibleBlock();
  prefs.face = b.dataset.face; store.set('prefs', prefs); applyPrefs();
  if (anchor) anchor.scrollIntoView({ block: 'start' });
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyPrefs());
function applyPrefs() {
  const r = document.documentElement;
  if (prefs.theme === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', prefs.theme);
  r.style.setProperty('--size', prefs.size + 'px');
  r.style.setProperty('--measure', prefs.measure + 'ch');
  r.style.setProperty('--leading', prefs.leading);
  document.body.classList.toggle('no-cmts', prefs.comments === 'off');
  if (prefs.comments === 'off') document.body.classList.remove('side-open');
  const face = FACES.find(f => f.id === prefs.face) || FACES[0];
  r.style.setProperty('--font-text', face.css);
  r.style.setProperty('--fscale', face.scale || 1);
  document.querySelectorAll('#faces button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.face === face.id)));
  document.querySelectorAll('.seg').forEach(seg => seg.querySelectorAll('button').forEach(b =>
    b.setAttribute('aria-pressed', String(prefs[seg.dataset.key] === b.dataset.v))));
}
document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const anchor = topVisibleBlock();
  prefs[seg.dataset.key] = b.dataset.v; store.set('prefs', prefs); applyPrefs();
  if (anchor) anchor.scrollIntoView({ block: 'start' });
}));
applyPrefs();

/* ---------- table of contents ---------- */
const done = store.get('done', {});
function buildToc() {
  let html = '', group = '';
  CH.forEach((c, i) => {
    if (c.group !== group) { group = c.group; if (!(CH.length === 1 || group === DOC.title)) html += `<div class="toc-group">${esc(group)}</div>`; }
    const tag = `<span class="n">${c.num || ''}</span>`;
    const sub = c.group === 'Essays' || c.id === 'introduction' ? `<span class="by">${esc(c.kicker.split(' · ')[1] || '')}</span>` : '';
    const cc = comments.filter(x => x.ch === c.id).length;
    html += `<button class="toc-item" data-i="${i}" aria-current="${i === cur}">${tag}<span class="t">${esc(c.title)}${cc ? `<span class="cc" title="${cc} comment${cc > 1 ? 's' : ''}"><svg viewBox="0 0 24 24"><path d="M5 5h14v10H10l-4 4v-4H5z"/></svg>${cc}</span>` : ''}${sub}</span>` +
            `<span class="m${done[c.id] ? ' done' : ''}">${mins(c.words)}</span></button>`;
  });
  $('tocList').innerHTML = html;
}
$('tocList').addEventListener('click', e => {
  const b = e.target.closest('.toc-item'); if (!b) return;
  go(+b.dataset.i); if (!wide()) toggleToc(false);
});
const wide = () => matchMedia('(min-width: 1180px)').matches;
function toggleToc(open) {
  if (wide()) { const d = open ?? !document.body.classList.contains('docked'); document.body.classList.toggle('docked', d); store.set('docked', d); return; }
  document.body.classList.toggle('toc-open', open ?? !document.body.classList.contains('toc-open'));
}
if (store.get('docked', true)) document.body.classList.add('docked');
$('tocBtn').onclick = () => toggleToc();
$('closeToc').onclick = () => toggleToc(false);
$('scrim').onclick = () => toggleToc(false);
$('setBtn').onclick = e => { e.stopPropagation(); $('panel').hidden = !$('panel').hidden; };
document.addEventListener('click', e => {
  if (!$('panel').hidden && !e.target.closest('#panel')) $('panel').hidden = true;
  if (!e.target.closest('.pop, sup.ref')) document.querySelector('.pop')?.remove();
});

/* ---------- search ---------- */
// Normalise curly quotes so typing ' or " matches the book's typography
const fold = s => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const INDEX = CH.map(c => c.blocks.map(b => fold(plain(b.x))));
const NOTEIDX = CH.map(c => (c.notes || []).map(n => fold(n)));
let hl = null;            // active highlight RegExp
let lastQuery = '', lastResults = [], selHit = 0, scope = 'all';

function parseQuery(q) {
  const terms = [];
  q.replace(/"([^"]+)"|(\S+)/g, (_, ph, w) => { const t = fold((ph || w).trim()); if (t.length >= 2 || ph) terms.push(t); });
  return terms;
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’‘]").replace(/"/g, '["“”]');
function buildHl(terms) { return terms.length ? new RegExp('(' + terms.map(reEsc).sort((a, b) => b.length - a.length).join('|') + ')', 'gi') : null; }

function inScope(c) { return scope === 'all' || c.group === scope; }
// one scope chip per part of the document, when it has more than one
{
  const groups = [...new Set(CH.map(c => c.group))];
  $('scope').innerHTML = groups.length > 1
    ? `<button data-v="all" aria-pressed="true">Everything</button>` + groups.map(g => `<button data-v="${esc(g)}" title="${esc(g)}">${esc(g.length > 34 ? g.slice(0, 32) + '…' : g)}</button>`).join('')
    : '';
  $('scope').hidden = groups.length < 2;
}
function runSearch() {
  const q = $('q').value.trim();
  const terms = parseQuery(q);
  lastQuery = q;
  if (!terms.length) { lastResults = []; $('sCount').textContent = 'Type at least 2 letters. Use quotes for an exact phrase; otherwise every word must appear in the paragraph.'; $('sResults').innerHTML = ''; return; }
  const res = [];
  CH.forEach((c, i) => {
    if (!inScope(c)) return;
    INDEX[i].forEach((t, k) => { if (terms.every(w => t.includes(w))) res.push({ i, k }); });
    NOTEIDX[i].forEach((t, k) => { if (terms.every(w => t.includes(w))) res.push({ i, note: k }); });
  });
  lastResults = res; selHit = 0;
  const re = buildHl(terms);
  const chapters = new Set(res.map(r => r.i)).size;
  $('sCount').textContent = res.length ? `${res.length.toLocaleString()} paragraph${res.length > 1 ? 's' : ''} in ${chapters} chapter${chapters > 1 ? 's' : ''}` : 'No matches. Try fewer words, or a different spelling (Locke writes “labour”, “publick” is modernised).';
  let html = '', last = -1;
  res.slice(0, 400).forEach((r, n) => {
    const c = CH[r.i];
    if (r.i !== last) { last = r.i; html += `<div class="s-ch">${esc(c.num ? `${c.group} · ${c.num}. ${c.title}` : `${c.group} · ${c.title}`)}</div>`; }
    const raw = r.note != null ? c.notes[r.note] : plain(c.blocks[r.k].x);
    const sec = r.note != null ? 'Note' : (raw.match(/^§ (\d+)\./) || [])[1];
    html += `<button class="s-hit${n === 0 ? ' sel' : ''}" data-n="${n}">${sec ? `<span class="loc">${sec === 'Note' ? 'Note' : '§ ' + sec}</span>` : ''}${snippet(raw.replace(/^§ \d+\.\s*/, ''), re)}</button>`;
  });
  if (res.length > 400) html += `<div class="s-count">Showing the first 400. Add another word to narrow it down.</div>`;
  $('sResults').innerHTML = html;
}
function snippet(t, re) {
  re.lastIndex = 0;
  const m = re.exec(t); const at = m ? m.index : 0;
  const a = Math.max(0, at - 90), b = Math.min(t.length, at + 160);
  let s = (a > 0 ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
  return markText(s, re);
}
function markText(s, re) {
  if (!re) return esc(s);
  let out = '', i = 0; re.lastIndex = 0; let m;
  while ((m = re.exec(s))) { out += esc(s.slice(i, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; i = m.index + m[0].length; if (!m[0].length) re.lastIndex++; }
  return out + esc(s.slice(i));
}
let sT;
$('q').addEventListener('input', () => { clearTimeout(sT); sT = setTimeout(runSearch, 120); });
$('q').addEventListener('keydown', e => {
  const hits = [...document.querySelectorAll('.s-hit')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!hits.length) return;
    selHit = Math.max(0, Math.min(hits.length - 1, selHit + (e.key === 'ArrowDown' ? 1 : -1)));
    hits.forEach((h, n) => h.classList.toggle('sel', n === selHit)); hits[selHit].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sT); runSearch(); openHit(selHit); }
  else if (e.key === 'Escape') { closeSearch(); }
});
$('scope').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  scope = b.dataset.v; $('scope').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  runSearch(); $('q').focus();
});
$('sResults').addEventListener('click', e => { const b = e.target.closest('.s-hit'); if (b) openHit(+b.dataset.n); });
function openHit(n) {
  const r = lastResults[n]; if (!r) return;
  hl = buildHl(parseQuery(lastQuery));
  closeSearch();
  cur = -1; // force re-render with highlights
  go(r.i, r.note != null ? { note: r.note } : { block: r.k });
}
function openSearch() {
  $('search').hidden = false; $('q').focus(); $('q').select();
  if (wide()) {} else toggleToc(false);
}
function closeSearch() { $('search').hidden = true; }
$('searchBtn').onclick = e => { e.stopPropagation(); $('search').hidden ? openSearch() : closeSearch(); };
$('closeSearch').onclick = closeSearch;
document.addEventListener('mousedown', e => { if (!$('search').hidden && !e.target.closest('#search, #searchBtn, #findList')) closeSearch(); });

// find bar: step through highlighted matches in the open chapter
let marks = [], markAt = 0;
function refreshFindbar(target) {
  marks = [...document.querySelectorAll('#page mark:not(.cmt)')];
  if (!hl || !marks.length) { $('findbar').hidden = true; return; }
  $('findbar').hidden = false;
  markAt = Math.max(0, target ? marks.findIndex(m => target.contains(m)) : 0);
  setMark(markAt, false);
}
function setMark(n, scroll = true) {
  marks.forEach(m => m.classList.remove('cur'));
  markAt = (n + marks.length) % marks.length;
  marks[markAt].classList.add('cur');
  if (scroll) marks[markAt].scrollIntoView({ block: 'center' });
  $('findLabel').textContent = `“${lastQuery}” · ${markAt + 1} of ${marks.length} in this chapter`;
}
$('findNext').onclick = () => setMark(markAt + 1);
$('findPrev').onclick = () => setMark(markAt - 1);
$('findList').onclick = e => { e.stopPropagation(); openSearch(); };
$('findClear').onclick = () => { hl = null; $('findbar').hidden = true; document.querySelectorAll('#page mark:not(.cmt)').forEach(m => m.replaceWith(...m.childNodes)); };

/* ---------- rendering ---------- */
let cur = -1;
function inline(x) {
  // split around note markers, highlight text pieces
  let out = '', i = 0, m; REF.lastIndex = 0;
  while ((m = REF.exec(x))) {
    out += markText(x.slice(i, m.index), hl) + `<sup class="ref"><a href="#n-${m[1]}" data-n="${m[1]}">${m[1]}</a></sup>`;
    i = m.index + m[0].length;
  }
  return out + markText(x.slice(i), hl);
}
function render(i) {
  const c = CH[i];
  let h = `<p class="kicker">${esc(c.kicker)}</p><h1>${esc(c.title)}</h1>`;
  const secs = c.blocks.map(b => b.x.match(/^§ ?(\d+)\./)).filter(Boolean).map(m => m[1]);
  h += `<p class="meta">${mins(c.words)} read · ${c.words.toLocaleString()} words${secs.length ? ` · §§ ${secs[0]}–${secs[secs.length - 1]}` : ''}</p>`;
  c.blocks.forEach((b, k) => {
    if (b.t === 'h') { h += `<h2 id="b${k}">${inline(b.x)}</h2>`; return; }
    if (b.t === 'q') { h += `<blockquote id="b${k}"><p>${inline(b.x)}</p></blockquote>`; return; }
    if (b.t === 'fn') { h += `<p class="fn" id="b${k}">${inline(b.x)}</p>`; return; }
    const m = b.x.match(/^§ ?(\d+)\.\s*([\s\S]*)$/);
    h += m ? `<p class="sec" id="b${k}" data-sec="${m[1]}"><a class="sec-no" href="#s${secGroupOf(c)}-${m[1]}">§ ${m[1]}</a>${inline(m[2])}</p>`
           : `<p id="b${k}">${inline(b.x)}</p>`;
  });
  if (c.notes) h += `<section class="notes"><h2>Notes</h2>${c.notes.map((n, k) => {
    const num = (n.match(/^(\d+)\./) || [])[1];
    return `<p id="n-${num}" data-k="${k}">${markText(n, hl)} <a class="back" href="#" data-back="${num}" aria-label="Back to text">↩</a></p>`; }).join('')}</section>`;
  $('page').innerHTML = h;
  paintComments();
  if (!$('side').hidden && sideView && sideView.kind === 'thread') { sideView = { kind: 'list' }; renderSide(); }
  else if (!$('side').hidden && sideView && sideView.kind === 'list') renderSide();

  const p = CH[i - 1], n = CH[i + 1];
  $('pager').innerHTML =
    (p ? `<button class="prev" data-i="${i - 1}"><small>← Previous</small><span>${esc(label(p))}</span></button>` : '') +
    (n ? `<button class="next" data-i="${i + 1}"><small>Next →</small><span>${esc(label(n))}</span></button>` : '');
  $('where').innerHTML = `${c.group === c.title || c.group === DOC.title ? '' : `<span class="ch-label">${esc(c.group.length > 38 ? c.group.slice(0, 36).trim() + '…' : c.group)} · </span>`}<b>${c.num ? 'Ch. ' + c.num + ' · ' : ''}${esc(c.title)}</b>`;
  $('prevBtn').disabled = !p; $('nextBtn').disabled = !n;
  $('prevBtn').style.opacity = p ? 1 : .3; $('nextBtn').style.opacity = n ? 1 : .3;
  document.querySelectorAll('.toc-item').forEach(t => t.setAttribute('aria-current', String(+t.dataset.i === i)));
  document.querySelector(`.toc-item[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  document.title = `${c.title} · Locke, Two Treatises`;
}
const label = c => (c.num ? `${c.group.replace(' Treatise', '')} ${c.num}: ` : '') + c.title;
$('pager').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(+b.dataset.i); });

function flash(el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
function go(i, opts = {}) {
  if (i < 0 || i >= CH.length) return;
  const changed = i !== cur;
  if (changed) { if (opts.block == null && opts.note == null) { hl = null; } cur = i; render(i); }
  store.set('chapter', CH[i].id);
  let target = null;
  if (opts.sec) target = document.querySelector(`#page [data-sec="${opts.sec}"]`);
  else if (opts.block != null) target = $('b' + opts.block);
  else if (opts.note != null) target = document.querySelector(`.notes [data-k="${opts.note}"]`);
  const c = CH[i];
  try { history.replaceState(null, '', '#' + (opts.sec ? `s${secGroupOf(c)}-${opts.sec}` : c.id)); } catch {}
  if (target) { target.scrollIntoView({ block: 'start' }); if (!hl) flash(target); }
  else if (opts.y != null) requestAnimationFrame(() => scrollTo(0, opts.y));
  else if (changed) scrollTo(0, 0);
  refreshFindbar(target);
  showBar(true); onScroll();
}
$('prevBtn').onclick = () => go(cur - 1);
$('nextBtn').onclick = () => go(cur + 1);

/* ---------- notes: popover on click ---------- */
document.addEventListener('click', e => {
  const a = e.target.closest('sup.ref a');
  if (a) {
    e.preventDefault(); document.querySelector('.pop')?.remove();
    const note = $('n-' + a.dataset.n); if (!note) return;
    const pop = document.createElement('div'); pop.className = 'pop';
    pop.innerHTML = note.innerHTML.replace(/<a class="back"[\s\S]*?<\/a>/, '');
    document.body.appendChild(pop);
    const r = a.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.max(16, Math.min(innerWidth - w - 16, r.left + scrollX - w / 2)) + 'px';
    pop.style.top = (r.bottom + scrollY + 8) + 'px';
    return;
  }
  const back = e.target.closest('.notes .back');
  if (back) { e.preventDefault(); const ref = document.querySelector(`sup.ref a[data-n="${back.dataset.back}"]`); if (ref) { ref.scrollIntoView({ block: 'center' }); flash(ref.closest('p, blockquote')); } }
  const s = e.target.closest('.sec-no');
  if (s) { e.preventDefault(); go(cur, { sec: s.closest('p').dataset.sec }); }
});

/* ---------- go to § ---------- */
$('gotoForm').addEventListener('submit', e => {
  e.preventDefault();
  const t = SEC_GROUPS[+$('gotoTreatise').value || 0], v = $('gotoInput').value.replace(/\D/g, '');
  const i = t != null ? secIndex[t][v] : undefined;
  if (i == null) { $('gotoMsg').textContent = v ? `No § ${v} there` : ''; return; }
  $('gotoMsg').textContent = ''; go(i, { sec: v }); if (!wide()) toggleToc(false);
});

/* ---------- scroll: progress, autohide bar, remember place ---------- */
let lastY = 0, saveT;
function showBar(v) { $('bar').classList.toggle('hide', !v); }
function topVisibleBlock() { return [...document.querySelectorAll('#page > *')].find(el => el.getBoundingClientRect().bottom > 70); }
function onScroll() {
  const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
  const pct = max > 0 ? Math.min(1, y / max) : 1;
  $('progress').style.width = (pct * 100) + '%';
  if (Math.abs(y - lastY) > 6) { showBar(y < lastY || y < 80); lastY = y; }
  document.querySelector('.pop')?.remove();
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    store.set('pos', { id: CH[cur].id, y });
    if (pct > 0.97 && !done[CH[cur].id]) { done[CH[cur].id] = true; store.set('done', done); buildToc(); }
  }, 300);
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('mousemove', e => { if (e.clientY < 60) showBar(true); });

/* ---------- keyboard ---------- */
addEventListener('keydown', e => {
  if (e.target.closest('input, select') || e.metaKey || e.ctrlKey || e.altKey) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); openSearch(); }
  else if (e.key === 'ArrowRight') go(cur + 1);
  else if (e.key === 'ArrowLeft') go(cur - 1);
  else if (e.key === 'c' || e.key === 'C') toggleToc();
  else if ((e.key === 'n' || e.key === 'Enter') && !$('findbar').hidden) setMark(markAt + 1);
  else if (e.key === 'N' && !$('findbar').hidden) setMark(markAt - 1);
  else if (e.key === 'Escape') { toggleToc(false); $('panel').hidden = true; closeSearch(); closeSide(); document.querySelector('.pop')?.remove(); }
});

/* ---------- comments ---------- */
let comments = [];
const me = { user: JSON.parse(document.getElementById('me').textContent) };   // signed in by the server session
let pending = null;                        // anchor waiting for a comment
let sideView = null;                       // { kind: 'list' } | { kind: 'thread', key } | { kind: 'auth', then }
const HUES = [12, 32, 150, 200, 255, 290, 330, 95];
const colorFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${HUES[h % HUES.length]} 52% 46%)`; };
const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();
const keyOf = c => `${c.k}:${c.start}:${c.end}`;
const ago = iso => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}
async function loadComments() {
  try {
    const { comments: list } = await api(`/api/d/${DOC.id}/comments`);
    const before = JSON.stringify(comments.map(c => c.id));
    comments = list;
    if (JSON.stringify(comments.map(c => c.id)) !== before) { paintComments(); buildToc(); if (!$('side').hidden) renderSide(); }
  } catch (e) { console.warn('comments unavailable', e); }
}

// Wrap characters [start, end) of el's text in <mark> elements; returns the marks created.
function wrapRange(el, start, end, make) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const hits = []; let pos = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.data.length, a = Math.max(start, pos), b = Math.min(end, pos + len);
    if (a < b) hits.push([n, a - pos, b - pos]);
    pos += len; if (pos >= end) break;
  }
  return hits.map(([node, a, b]) => {
    let t = node;
    if (a > 0) t = t.splitText(a);
    if (b - a < t.data.length) t.splitText(b - a);
    const m = make(); t.parentNode.insertBefore(m, t); m.appendChild(t); return m;
  });
}
function paintComments() {
  const page = $('page'); if (!page || cur < 0) return;
  page.querySelectorAll('mark.cmt').forEach(m => m.replaceWith(...m.childNodes));
  page.normalize();
  const chId = CH[cur].id;
  const groups = {};
  comments.filter(c => c.ch === chId).forEach(c => (groups[keyOf(c)] ||= []).push(c));
  // paint longer ranges first so shorter, overlapping ones nest inside them
  Object.entries(groups).sort((a, b) => (b[1][0].end - b[1][0].start) - (a[1][0].end - a[1][0].start)).forEach(([key, list]) => {
    const el = $('b' + list[0].k); if (!el) return;
    const people = [...new Map(list.map(c => [c.uid, c])).values()];
    const marks = wrapRange(el, list[0].start, list[0].end, () => {
      const m = document.createElement('mark'); m.className = 'cmt'; m.dataset.key = key;
      m.style.setProperty('--hl', colorFor(people[0].uid)); return m;
    });
    const last = marks[marks.length - 1];
    if (last) {
      last.classList.add('end');
      last.dataset.who = people.slice(0, 2).map(p => initial(p.name)).join('') + (people.length > 2 ? '+' : '');
      last.title = people.map(p => p.name).join(', ');
    }
  });
  const n = comments.filter(c => c.ch === chId).length;
  $('cmtCount').hidden = !n; $('cmtCount').textContent = n;
}

/* selection -> "Add comment" */
function currentAnchor() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const block = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest('#page [id^="b"]');
  if (!block) return null;
  const pre = document.createRange(); pre.selectNodeContents(block); pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  let end;
  if (block.contains(range.endContainer)) { pre.setEnd(range.endContainer, range.endOffset); end = pre.toString().length; }
  else end = block.textContent.length;
  const quote = block.textContent.slice(start, end);
  const lead = quote.length - quote.trimStart().length, trail = quote.length - quote.trimEnd().length;
  if (end - trail - (start + lead) < 2) return null;
  return { ch: CH[cur].id, k: +block.id.slice(1), start: start + lead, end: end - trail, quote: quote.trim(), rect: range.getBoundingClientRect() };
}
let selT;
document.addEventListener('selectionchange', () => {
  clearTimeout(selT);
  selT = setTimeout(() => {
    const a = currentAnchor(); const btn = $('addCmt');
    if (!a || prefs.comments === 'off') { btn.hidden = true; return; }
    btn.hidden = false;
    if (!matchMedia('(max-width: 760px)').matches) {
      const w = btn.offsetWidth;
      btn.style.left = Math.max(12, Math.min(innerWidth - w - 12, a.rect.left + a.rect.width / 2 - w / 2)) + scrollX + 'px';
      btn.style.top = (a.rect.top + scrollY - 48) + 'px';
    } else { btn.style.left = ''; btn.style.top = ''; }
  }, 160);
});
$('addCmt').addEventListener('mousedown', e => e.preventDefault());
$('addCmt').addEventListener('click', () => {
  const a = currentAnchor(); if (!a) return;
  delete a.rect; pending = a;
  $('addCmt').hidden = true;
  openSide({ kind: 'compose' });
});

/* clicking highlighted text opens its thread */
$('page').addEventListener('click', e => {
  const m = e.target.closest('mark.cmt'); if (!m || prefs.comments === 'off') return;
  if (!getSelection().isCollapsed) return;
  openSide({ kind: 'thread', key: m.dataset.key });
});

/* side panel */
function openSide(view) { sideView = view; $('side').hidden = false; document.body.classList.add('side-open'); renderSide(); }
function closeSide() {
  $('side').hidden = true; document.body.classList.remove('side-open'); sideView = null;
  document.querySelectorAll('mark.cmt.active').forEach(m => m.classList.remove('active'));
}
$('sideClose').onclick = closeSide;
$('sideBack').onclick = () => openSide({ kind: 'list' });
$('cmtBtn').onclick = e => { e.stopPropagation(); $('side').hidden ? openSide({ kind: 'list' }) : closeSide(); };

function cmtHtml(c) {
  return `<div class="cmt-item"><div class="avatar" style="background:${colorFor(c.uid)}">${esc(initial(c.name))}</div><div>
    <div class="who">${esc(c.name)}<span class="when">${ago(c.at)}</span></div>
    <div class="txt">${esc(c.text)}</div>
    ${me && me.user.id === c.uid ? `<button class="del" data-del="${c.id}">Delete</button>` : ''}</div></div>`;
}
function composer(label) {
  return `<form class="form" id="cmtForm"><label for="cmtText">${label}</label>
    <textarea id="cmtText" placeholder="What do you think?" required></textarea>
    <p class="err" id="cmtErr" hidden></p><button class="btn" id="cmtPost">Post comment</button></form>`;
}
function renderSide() {
  const v = sideView; if (!v) return;
  const body = $('sideBody'); const chId = CH[cur].id;
  document.querySelectorAll('mark.cmt.active').forEach(m => m.classList.remove('active'));
  $('sideBack').hidden = v.kind === 'list';
  $('sideFoot').innerHTML = `<span>Select any passage to comment on it.</span>`;
  if (v.kind === 'compose') {
    $('sideTitle').textContent = 'New comment';
    body.innerHTML = `<blockquote class="quote">${esc(pending.quote)}<small>${esc(CH[cur].title)}</small></blockquote>${composer('Your comment')}`;
    setTimeout(() => $('cmtText')?.focus(), 50);
    return;
  }
  if (v.kind === 'thread') {
    const list = comments.filter(c => c.ch === chId && keyOf(c) === v.key);
    if (!list.length) { openSide({ kind: 'list' }); return; }
    $('sideTitle').textContent = list.length === 1 ? '1 comment' : `${list.length} comments`;
    document.querySelectorAll(`mark.cmt[data-key="${v.key}"]`).forEach(m => m.classList.add('active'));
    // wait for the panel to change the column width, then bring the highlight into view
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const m = document.querySelector(`mark.cmt[data-key="${v.key}"]`); if (!m) return;
      const r = m.getBoundingClientRect(), phone = matchMedia('(max-width: 760px)').matches;
      if (r.top < 70 || r.bottom > innerHeight * (phone ? .26 : .85)) scrollBy({ top: r.top - (phone ? 70 : innerHeight * .3), behavior: 'smooth' });
    }));
    body.innerHTML = `<blockquote class="quote">${esc(list[0].quote)}</blockquote>${list.map(cmtHtml).join('')}
      ${composer('Reply')}`;
    return;
  }
  // list of every thread in this chapter
  const groups = {};
  comments.filter(c => c.ch === chId).forEach(c => (groups[keyOf(c)] ||= []).push(c));
  const keys = Object.keys(groups).sort((a, b) => { const [ka, sa] = a.split(':').map(Number), [kb, sb] = b.split(':').map(Number); return ka - kb || sa - sb; });
  $('sideTitle').textContent = 'Comments in this chapter';
  body.innerHTML = keys.length ? keys.map(k => {
    const l = groups[k], f = l[0];
    return `<button class="thread-link" data-key="${k}"><span class="q">“${esc(f.quote)}”</span>
      <span class="first"><span class="avatar" style="background:${colorFor(f.uid)}">${esc(initial(f.name))}</span><span><b>${esc(f.name)}</b> ${esc(f.text)}</span></span>
      ${l.length > 1 ? `<span class="hint">${l.length - 1} more repl${l.length > 2 ? 'ies' : 'y'}</span>` : ''}</button>`;
  }).join('') : `<p class="empty">No comments in this chapter yet. Select a sentence or phrase in the text, then tap <b>Add comment</b>.</p>`;
}
$('side').addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('.thread-link')) { openSide({ kind: 'thread', key: t.closest('.thread-link').dataset.key }); return; }
  const del = t.closest('[data-del]');
  if (del) {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Tap again to delete'; return; }
    try { await api(`/api/d/${DOC.id}/comments/${del.dataset.del}`, { method: 'DELETE' }); comments = comments.filter(c => c.id !== del.dataset.del); paintComments(); buildToc(); renderSide(); }
    catch (err) { del.textContent = err.message; }
  }
});
$('side').addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'cmtForm') {
    const text = $('cmtText').value.trim(); if (!text) return;
    const anchor = sideView.kind === 'thread'
      ? (() => { const f = comments.find(c => keyOf(c) === sideView.key && c.ch === CH[cur].id); return { ch: f.ch, k: f.k, start: f.start, end: f.end, quote: f.quote }; })()
      : pending;
    const btn = $('cmtPost'), err = $('cmtErr'); btn.disabled = true; err.hidden = true;
    try {
      const { comment } = await api(`/api/d/${DOC.id}/comments`, { method: 'POST', body: JSON.stringify({ ...anchor, text }) });
      comments.push(comment); pending = null; getSelection().removeAllRanges();
      paintComments(); buildToc(); openSide({ kind: 'thread', key: keyOf(comment) });
    } catch (x) {
      err.textContent = x.message; err.hidden = false; btn.disabled = false;
    }
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadComments(); });
setInterval(() => { if (!document.hidden) loadComments(); }, 60000);

/* ---------- start ---------- */
function fromHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  const s = h.match(/^s(\d+)-(\d+)$/);
  if (s) { const t = SEC_GROUPS[+s[1]]; const i = t != null ? secIndex[t][s[2]] : undefined; if (i != null) { go(i, { sec: s[2] }); return true; } }
  const i = CH.findIndex(c => c.id === h);
  if (i >= 0) { go(i); return true; }
  return false;
}
addEventListener('hashchange', fromHash);
buildToc();
if (!fromHash()) {
  const pos = store.get('pos', null);
  const i = pos ? CH.findIndex(c => c.id === pos.id) : -1;
  if (i >= 0) go(i, { y: pos.y }); else go(0);
}
loadComments();
