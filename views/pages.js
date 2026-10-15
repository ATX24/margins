import fs from 'node:fs';
import crypto from 'node:crypto';
// content hashes bust browser caches whenever the files change
const v = f => crypto.createHash('sha1').update(fs.readFileSync(new URL('../public/' + f, import.meta.url))).digest('hex').slice(0, 10);
const ASSET = { css: v('app.css'), js: v('app.js') };
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();
const HUES = [12, 32, 150, 200, 255, 290, 330, 95];
// same colour per person as the reader's comment badges
export const colorFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${HUES[h % HUES.length]} 52% 46%)`; };
export const readTime = words => { const m = Math.max(1, Math.round(words / 230)); return m < 60 ? `${m} min read` : `${Math.floor(m / 60)} h ${m % 60} min read`; };
export function when(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)} d ago`;
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Page shell in the style of dhilan.dev: one 560px column, a side index, hairline rules.
 * index: [{ title, links: [{ href, label, current }] }]
 */
export function page({ title, body, user, refresh = 0 }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Margins</title>
<meta name="theme-color" content="#f5f6f3">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<link rel="icon" href="/static/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,600&family=Atkinson+Hyperlegible:wght@400;700&display=swap">
<link rel="stylesheet" href="/static/app.css?v=${ASSET.css}">
</head><body>
<div class="site-shell">
  <header class="site-header">
    <a class="brand" href="/">Margins<span class="brand-dot">.</span></a>
    <div class="header-tools">
      ${user ? `<span class="name">${esc(user.name)}</span><form method="post" action="/logout"><button class="index-link">Sign out</button></form>` : ''}
    </div>
  </header>
  <main>${body}</main>
  <footer class="site-footer">Margins · read together, write in the margins</footer>
</div>
<script src="/static/app.js?v=${ASSET.js}" defer></script>
</body></html>`;
}
