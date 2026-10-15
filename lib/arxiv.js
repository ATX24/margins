// arXiv papers: any arXiv link -> the paper's full-text HTML (arxiv.org/html, else ar5iv), else its PDF.
// The HTML is LaTeXML output, which keeps real sections, captions and maths (as LaTeX in `alttext`).
import { parseHTML } from 'linkedom';
import { fetchUrl, FetchError } from './article.js';

// 2310.06825, 2310.06825v2, hep-th/9901001, math.GT/0309136v1
const ID = /((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/;

export function arxivId(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
  if (!/(^|\.)arxiv\.org$/i.test(u.hostname) && !/(^|\.)ar5iv(\.labs\.arxiv)?\.org$/i.test(u.hostname)) return null;
  const m = u.pathname.replace(/\.pdf$/i, '').match(new RegExp('^/(?:abs|pdf|html|format|papers)/' + ID.source + '/?$'));
  return m ? { id: m[1], version: m[2] || '' } : null;
}

// LaTeX source (from alttext) -> plain readable text. Not a renderer, just tidy enough to read in a sentence.
const SYM = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝',
  infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', forall: '∀', exists: '∃',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftrightarrow: '⇔', mapsto: '↦', ldots: '…', cdots: '⋯', dots: '…', circ: '∘', top: 'ᵀ', intercal: 'ᵀ',
  langle: '⟨', rangle: '⟩', lVert: '‖', rVert: '‖', Vert: '‖', mid: '|', ell: 'ℓ', prime: '′', star: '*', ast: '*', oplus: '⊕', otimes: '⊗', odot: '⊙',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '!': '', ' ': ' ', log: 'log', exp: 'exp', max: 'max', min: 'min', arg: 'arg', sin: 'sin', cos: 'cos', tanh: 'tanh' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', '(': '⁽', ')': '⁾' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', n: 'ₙ', t: 'ₜ', m: 'ₘ', x: 'ₓ' };
function group(s, i) { // read {…} or a single token starting at i -> [text, next]
  if (s[i] === '{') { let d = 0, j = i; for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break; } return [s.slice(i + 1, j), j + 1]; }
  if (s[i] === '\\') { const m = s.slice(i).match(/^\\([A-Za-z]+|.)/); return [m[0], i + m[0].length]; }
  return [s[i] || '', i + 1];
}
export function latexToText(src) {
  let s = String(src).replace(/\\(left|right|big|Big|bigg|Bigg)\b\.?/g, '').replace(/\\(displaystyle|textstyle|scriptstyle|limits|nolimits)\b/g, '');
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = s.slice(i).match(/^\\([A-Za-z]+|.)/); const cmd = m[1]; i += m[0].length;
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
        let a, b; [a, i] = group(s, i); [b, i] = group(s, i);
        const A = latexToText(a), B = latexToText(b);
        out += (A.length > 1 ? `(${A})` : A) + '/' + (B.length > 1 ? `(${B})` : B);
      } else if (cmd === 'sqrt') {
        let a; if (s[i] === '[') { const j = s.indexOf(']', i); i = j + 1; } [a, i] = group(s, i);
        const A = latexToText(a); out += '√' + (A.length > 1 ? `(${A})` : A);
      } else if (/^(mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|mathfrak|boldsymbol|bm|text|textbf|textit|textrm|operatorname|mbox|hat|bar|tilde|vec|dot|overline|underline|widehat|widetilde)$/.test(cmd)) {
        let a; [a, i] = group(s, i); const A = latexToText(a);
        out += cmd === 'hat' || cmd === 'widehat' ? A + '̂' : cmd === 'bar' || cmd === 'overline' ? A + '̄' : cmd === 'tilde' || cmd === 'widetilde' ? A + '̃' : A;
      } else if (cmd in SYM) out += SYM[cmd] + (/^[A-Za-z]+$/.test(cmd) && /^(log|exp|max|min|arg|sin|cos|tanh)$/.test(cmd) ? ' ' : '');
      else if (cmd === '{' || cmd === '}' || cmd === '_' || cmd === '%' || cmd === '&' || cmd === '#' || cmd === '$') out += cmd;
      else if (cmd === '\\') out += ' ';
      // unknown command: drop the backslash, keep the name
      else out += /^[A-Za-z]+$/.test(cmd) ? cmd : '';
    } else if (c === '^' || c === '_') {
      let a; [a, i] = group(s, i + 1); const A = latexToText(a); const map = c === '^' ? SUP : SUB;
      out += [...A].every(ch => ch in map) ? [...A].map(ch => map[ch]).join('') : (c === '^' ? (A === 'ᵀ' ? 'ᵀ' : `^(${A})`) : `_${A.length > 1 ? `(${A})` : A}`);
    } else if (c === '{' || c === '}') i++;
    else if (c === '~') { out += ' '; i++; }
    else if (c === '&') { out += ' '; i++; }
    else { out += c; i++; }
  }
  return out.replace(/\s+/g, ' ').replace(/\s*([=<>≤≥≈])\s*/g, ' $1 ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

const clean = t => t.replace(/\s+/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').replace(/\(\s+/g, '(').trim();

// Text of an element with maths turned into readable text, footnote marks dropped
function text(el) {
  const doc = el.ownerDocument;
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.ltx_note, .ltx_note_mark, .ltx_tag_note, .ltx_rule, script, style, .ltx_ERROR').forEach(n => n.remove());
  copy.querySelectorAll('math').forEach(m => m.replaceWith(doc.createTextNode(' ' + latexToText(m.getAttribute('alttext') || m.textContent) + ' ')));
  copy.querySelectorAll('br').forEach(b => b.replaceWith(doc.createTextNode('\n')));
  return clean(copy.textContent);
}

// One LaTeXML section -> blocks (subsection titles become headings inside the chapter)
function sectionBlocks(sec) {
  const out = [];
  const walk = el => {
    for (const n of el.children) {
      const cl = n.className || '';
      if (/\bltx_title\b/.test(cl)) { if (n.parentElement !== sec) { const x = text(n); if (x) out.push({ t: 'h', x }); } continue; }
      if (/\bltx_(figure|table|float)\b/.test(cl) || n.tagName === 'FIGURE') {
        const cap = n.querySelector('.ltx_caption'); const x = cap && text(cap); if (x) out.push({ t: 'q', x }); continue;
      }
      if (/\bltx_(equation|equationgroup)\b/.test(cl)) {
        const maths = [...n.querySelectorAll('math')].map(m => latexToText(m.getAttribute('alttext') || '')).filter(Boolean);
        const tag = n.querySelector('.ltx_tag_equation')?.textContent.trim();
        if (maths.length) out.push({ t: 'q', x: maths.join('   ') + (tag ? `   ${tag}` : '') }); continue;
      }
      if (/\bltx_(itemize|enumerate|description)\b/.test(cl)) {
        n.querySelectorAll(':scope > .ltx_item').forEach(li => {
          const tag = li.querySelector('.ltx_tag_item')?.textContent.trim() || '•';
          const c = li.cloneNode(true); c.querySelector('.ltx_tag_item')?.remove();
          const x = text(c); if (x) out.push({ t: 'p', x: `${tag} ${x}` });
        }); continue;
      }
      if (/\bltx_(theorem|proof)\b/.test(cl) || /ltx_theorem_/.test(cl)) {
        n.querySelectorAll('.ltx_p').forEach(p => { const x = text(p); if (x) out.push({ t: 'q', x }); }); continue;
      }
      if (n.tagName === 'P' || /\bltx_p\b/.test(cl)) { const x = text(n); if (x) out.push({ t: 'p', x }); continue; }
      if (/\bltx_(tabular|graphics|pagination|bibliography)\b/.test(cl) || n.tagName === 'TABLE' || n.tagName === 'IMG') continue;
      if (n.children.length) walk(n);
    }
  };
  walk(sec);
  return out;
}

function parseLatexml(html, id, sourceUrl) {
  const { document } = parseHTML(html);
  const doc = document.querySelector('.ltx_document');
  if (!doc || !doc.querySelector('.ltx_section, .ltx_para')) return null;
  const title = text(document.querySelector('.ltx_title_document') || document.querySelector('title')) || `arXiv:${id}`;
  const names = [...document.querySelectorAll('.ltx_authors .ltx_personname')].map(p => {
    const c = p.cloneNode(true); c.querySelectorAll('br').forEach(b => b.replaceWith(document.createTextNode('\n')));
    c.querySelectorAll('.ltx_note, sup').forEach(n => n.remove());
    return clean(c.textContent.split('\n')[0].replace(/[\d*†‡§¶,]+$/, ''));
  }).filter(n => n && n.length < 60 && !/@|univers|institut|google|research|department/i.test(n));
  const authors = names.length > 3 ? `${names[0]} et al.` : names.join(', ');
  const kicker = ['arXiv ' + id, authors].filter(Boolean).join(' · ').slice(0, 120);
  const words = b => b.reduce((n, x) => n + x.x.split(' ').length, 0);
  const chapters = [];
  const add = (title, group, blocks) => { if (words(blocks)) chapters.push({ id: `c${chapters.length + 1}`, group, num: '', title: title.slice(0, 160), kicker, blocks, words: words(blocks) }); };

  const abs = document.querySelector('.ltx_abstract');
  if (abs) add('Abstract', title, [...abs.querySelectorAll('.ltx_p')].map(p => ({ t: 'p', x: text(p) })).filter(b => b.x));
  for (const sec of doc.querySelectorAll(':scope > .ltx_section, :scope > section.ltx_section, .ltx_section:not(.ltx_section .ltx_section)')) {
    if (sec.closest('.ltx_appendix')) continue;
    add(text(sec.querySelector(':scope > .ltx_title')) || 'Section', title, sectionBlocks(sec));
  }
  for (const app of doc.querySelectorAll('.ltx_appendix')) add(text(app.querySelector(':scope > .ltx_title')) || 'Appendix', 'Appendix', sectionBlocks(app));
  const bib = document.querySelector('.ltx_bibliography');
  if (bib) add('References', 'Back matter', [...bib.querySelectorAll('.ltx_bibitem')].map(b => ({ t: 'p', x: text(b) })).filter(b => b.x));
  // de-duplicate chapters picked up twice by the section selector
  const seen = new Set();
  const uniq = chapters.filter(c => { const k = c.title + c.words; if (seen.has(k)) return false; seen.add(k); return true; }).map((c, i) => ({ ...c, id: `c${i + 1}` }));
  const total = uniq.reduce((n, c) => n + c.words, 0);
  if (total < 300) return null;
  return { title, site: 'arXiv', chapters: uniq, words: total, url: sourceUrl };
}

// Returns { kind: 'article', ... } or { kind: 'pdf', url, body } or throws FetchError
export async function fetchArxiv(raw) {
  const ref = arxivId(raw); if (!ref) return null;
  const idv = ref.id + ref.version;
  for (const url of [`https://arxiv.org/html/${idv}`, `https://ar5iv.labs.arxiv.org/html/${ref.id}`]) {
    try {
      const got = await fetchUrl(url);
      if (got.kind === 'html') {
        const a = parseLatexml(got.html, ref.id, `https://arxiv.org/abs/${idv}`);
        if (a) return { kind: 'article', ...a };
      }
    } catch (e) { if (!(e instanceof FetchError)) throw e; }
  }
  // No HTML version (mostly older papers): use the PDF, with title and authors from the abstract page
  let meta = {};
  try {
    const absPage = await fetchUrl(`https://arxiv.org/abs/${idv}`);
    if (absPage.kind === 'html') {
      const { document } = parseHTML(absPage.html);
      const get = n => [...document.querySelectorAll(`meta[name="${n}"]`)].map(m => m.getAttribute('content')).filter(Boolean);
      const names = get('citation_author').map(n => n.includes(',') ? n.split(',').reverse().map(x => x.trim()).join(' ') : n);
      meta = { title: clean(get('citation_title')[0] || ''), authors: names.length > 3 ? `${names[0]} et al.` : names.join(', ') };
    }
  } catch {}
  const pdf = await fetchUrl(`https://arxiv.org/pdf/${idv}`);
  if (pdf.kind !== 'pdf') throw new FetchError('arXiv didn’t return a PDF for that paper.');
  return { kind: 'pdf', url: `https://arxiv.org/abs/${idv}`, body: pdf.body, filename: `${ref.id.replace('/', '_')}.pdf`,
    title: meta.title || '', kicker: ['arXiv ' + ref.id, meta.authors].filter(Boolean).join(' · ') };
}
