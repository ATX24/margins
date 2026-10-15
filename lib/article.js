// Fetch a web page or PDF safely and turn articles into reader chapters.
import { Agent } from 'undici';
import dns from 'node:dns';
import net from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const MAX_HTML = 8 * 1024 * 1024, MAX_PDF = 50 * 1024 * 1024;

// Block loopback, private, link-local, CGNAT and Fly's internal IPv6 ranges so a pasted
// URL can't reach anything inside our network. Checked at connect time, so DNS tricks don't help.
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
    || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}
const agent = new Agent({
  connect: {
    timeout: 10_000,
    lookup(host, opts, cb) {
      dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const ok = addrs.filter(a => !isPrivate(a.address));
        if (!ok.length) return cb(new Error('blocked-address'));
        opts.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
      });
    },
  },
});

export class FetchError extends Error {}

export async function fetchUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchError('That doesn’t look like a web address.'); }
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new FetchError('Only http and https links can be added.');
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivate(url.hostname.replace(/^\[|\]$/g, ''))) throw new FetchError('That address can’t be reached.');
    let res;
    try {
      res = await fetch(url, {
        dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(25_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarginsReader/1.0; +https://margins-reader.fly.dev)', Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5' },
      });
    } catch (e) {
      throw new FetchError(String(e?.cause?.message || e.message).includes('blocked-address') ? 'That address can’t be reached.' : 'Couldn’t reach that page. Check the link and try again.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url); continue; }
    if (!res.ok) throw new FetchError(res.status === 403 || res.status === 401 ? 'That site blocked the request (it may need a login or a subscription).' : `That page returned an error (${res.status}).`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const isPdf = type.includes('application/pdf');
    const limit = isPdf ? MAX_PDF : MAX_HTML;
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > limit) throw new FetchError(isPdf ? 'That PDF is over 50 MB.' : 'That page is too large.'); chunks.push(c); }
    const body = Buffer.concat(chunks);
    if (isPdf || body.subarray(0, 5).toString() === '%PDF-') return { kind: 'pdf', url: url.href, body };
    if (!type.includes('html') && !type.includes('xml') && type) throw new FetchError('That link isn’t an article or a PDF.');
    return { kind: 'html', url: url.href, html: body.toString('utf8') };
  }
  throw new FetchError('That link redirects too many times.');
}

const clean = t => t.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\[(\d{1,3})\]/g, '[[n:$1]]').trim();

// Readability's article HTML -> [{ t: 'h' | 'p' | 'q', x }]
function blocksFrom(root) {
  const out = [];
  const walk = el => {
    for (const n of el.children) {
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const x = clean(n.textContent); if (x) out.push({ t: 'h', x }); }
      else if (tag === 'p') { const x = clean(n.textContent); if (x) out.push({ t: 'p', x }); }
      else if (tag === 'blockquote' || tag === 'pre') {
        const inner = [...n.querySelectorAll('p')];
        (inner.length ? inner.map(p => p.textContent) : [n.textContent]).map(clean).filter(Boolean).forEach(x => out.push({ t: 'q', x }));
      }
      else if (tag === 'ul' || tag === 'ol') {
        [...n.children].filter(li => li.tagName.toLowerCase() === 'li').forEach((li, i) => {
          const x = clean(li.textContent); if (x) out.push({ t: 'p', x: (tag === 'ol' ? `${i + 1}. ` : '• ') + x });
        });
      }
      else if (tag === 'figure' || tag === 'table' || tag === 'img' || tag === 'picture' || tag === 'svg' || tag === 'script' || tag === 'style') {
        const cap = n.querySelector?.('figcaption'); if (cap && clean(cap.textContent)) out.push({ t: 'q', x: clean(cap.textContent) });
      }
      else if (n.children.length) walk(n);
      else { const x = clean(n.textContent); if (x) out.push({ t: 'p', x }); }
    }
  };
  walk(root);
  return out;
}

// Containers sites commonly put the article in; used when Readability's guess comes back thin
const CANDIDATES = 'article, [itemprop="articleBody"], #postContent, .post-content, .postBody, .entry-content, .article-body, .article-content, .post-body, .story-body, .content-body, main, [role="main"]';
const meta = (doc, ...names) => { for (const n of names) { const v = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content'); if (v) return v; } return ''; };

export function articleToChapters(html, url, fallbackTitle) {
  const words = b => b.reduce((n, x) => n + x.x.split(' ').length, 0);
  const { document } = parseHTML(html);
  // grab fallbacks before Readability rewrites the document
  const ogTitle = meta(document, 'og:title', 'twitter:title') || document.querySelector('title')?.textContent || '';
  const ogSite = meta(document, 'og:site_name');
  const author = meta(document, 'author', 'article:author');
  let best = null, bestLen = 0;
  for (const el of document.querySelectorAll(CANDIDATES)) {
    const len = [...el.querySelectorAll('p')].reduce((n, p) => n + p.textContent.trim().length, 0);
    if (len > bestLen) { best = el; bestLen = len; }
  }
  const fallbackBlocks = best ? blocksFrom(best) : [];

  let art = null;
  try { art = new Readability(document, { charThreshold: 400 }).parse(); } catch {}
  let blocks = [];
  if (art?.content) {
    const { document: d2 } = parseHTML(`<!doctype html><html><body><div id="a">${art.content}</div></body></html>`);
    blocks = blocksFrom(d2.getElementById('a'));
  }
  if (words(fallbackBlocks) > Math.max(80, words(blocks) * 1.3)) blocks = fallbackBlocks;
  if (!blocks.length) throw new FetchError('Couldn’t find article text on that page. It may load its text with JavaScript, or sit behind a login.');
  const title = clean(art?.title || ogTitle || fallbackTitle || new URL(url).hostname).replace(/\s+[—|–-]\s+(LessWrong|Medium|Substack|Project Gutenberg)$/i, '');
  if (art) { art.siteName ||= ogSite; art.byline ||= author; } else art = { siteName: ogSite, byline: author };
  // drop a heading that only repeats the title
  if (blocks[0]?.t === 'h' && blocks[0].x.toLowerCase() === title.toLowerCase()) blocks.shift();
  if (words(blocks) < 80) throw new FetchError('Couldn’t find enough article text on that page. It may load its text with JavaScript, or sit behind a login.');
  const site = clean(art.siteName || new URL(url).hostname.replace(/^www\./, ''));
  const kicker = [site, art.byline && clean(art.byline)].filter(Boolean).join(' · ').slice(0, 120);

  // Long pieces with several headings become sections; everything else is one chapter
  const heads = blocks.map((b, i) => (b.t === 'h' ? i : -1)).filter(i => i > 0);
  let chapters;
  if (words(blocks) > 2500 && heads.length >= 3) {
    const cuts = [0, ...heads];
    chapters = cuts.map((s, k) => {
      const part = blocks.slice(s, cuts[k + 1] ?? blocks.length);
      const t = part[0]?.t === 'h' ? part.shift().x : 'Introduction';
      return { title: t, blocks: part };
    }).filter(c => c.blocks.length);
  } else chapters = [{ title, blocks }];
  return {
    title, site,
    chapters: chapters.map((c, i) => ({ id: `c${i + 1}`, group: title, num: '', title: c.title.slice(0, 160), kicker, blocks: c.blocks, words: words(c.blocks) })),
    words: words(blocks),
  };
}
