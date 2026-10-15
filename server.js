import express from 'express';
import multer from 'multer';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { page, esc, initial, colorFor, when, readTime } from './views/pages.js';
import { fetchUrl, articleToChapters, FetchError } from './lib/article.js';
import { fetchArxiv, arxivId } from './lib/arxiv.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const q = (text, params) => db.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];
const scrypt = promisify(crypto.scrypt);
const run = promisify(execFile);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: '30d', immutable: true }));

/* ---------------------------------------------------------------- sessions */
const COOKIE = 'sid';
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`insert into sessions (token, user_id, expires_at) values ($1, $2, now() + interval '60 days')`, [token, userId]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 86400}${PROD ? '; Secure' : ''}`);
}
app.use(async (req, res, next) => {
  const token = cookies(req)[COOKIE];
  req.user = token ? await one(`select u.id, u.name, u.email from sessions s join users u on u.id = s.user_id where s.token = $1 and s.expires_at > now()`, [token]).catch(() => null) : null;
  next();
});
const needUser = (req, res, next) => req.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
const needUserApi = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Your session ended. Sign in again.' });

async function membership(groupId, userId) {
  if (!/^[0-9a-f-]{36}$/.test(groupId)) return null;
  return one(`select g.*, m.role from groups g join memberships m on m.group_id = g.id and m.user_id = $2 where g.id = $1`, [groupId, userId]);
}
async function docFor(docId, userId, cols = 'd.id, d.group_id, d.title, d.status, d.uploaded_by, d.pages, d.words, d.created_at') {
  if (!/^[0-9a-f-]{36}$/.test(docId)) return null;
  return one(`select ${cols}, g.name as group_name, m.role from documents d join groups g on g.id = d.group_id
              join memberships m on m.group_id = d.group_id and m.user_id = $2 where d.id = $1`, [docId, userId]);
}

/* ---------------------------------------------------------------- auth pages */
const safeNext = n => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) ? n : '/';
app.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.send(loginPage({ next: req.query.next, mode: req.query.mode === 'signup' ? 'signup' : 'signin' }));
});
app.post('/login', async (req, res) => {
  const mode = req.body.mode === 'signup' ? 'signup' : 'signin';
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 60);
  const next = safeNext(req.body.next);
  const fail = error => res.status(400).send(loginPage({ next, mode, error, email, name }));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8) return fail('Passwords are at least 8 characters.');
  let user = await one(`select * from users where email = $1`, [email]);
  if (mode === 'signup') {
    if (user) return fail('There’s already an account with that email. Sign in instead.');
    if (!name) return fail('Enter your name. Group members see it next to your comments.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    user = await one(`insert into users (email, name, pw_hash, pw_salt) values ($1, $2, $3, $4) returning *`, [email, name, hash, salt]);
  } else {
    const hash = user ? (await scrypt(password, user.pw_salt, 64)).toString('hex') : '';
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pw_hash, 'hex')))
      return fail('That email and password don’t match.');
  }
  await startSession(res, user.id);
  res.redirect(next);
});
app.post('/logout', async (req, res) => {
  const token = cookies(req)[COOKIE];
  if (token) await q(`delete from sessions where token = $1`, [token]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/login');
});

function loginPage({ next = '/', mode, error, email = '', name = '' }) {
  const signup = mode === 'signup';
  const other = `/login?mode=${signup ? 'signin' : 'signup'}${next && next !== '/' ? '&next=' + encodeURIComponent(next) : ''}`;
  return page({
    title: signup ? 'Create account' : 'Sign in', body: `
    <section class="intro">
      <p class="eyebrow">${signup ? 'New account' : 'Welcome back'}</p>
      <h1>${signup ? 'Create your account' : 'Sign in'}</h1>
      <p>Upload PDFs to a group, read them as clean text, and comment in the margins together.</p>
    </section>
    <section class="section">
      <form method="post" action="/login" class="form">
        <input type="hidden" name="mode" value="${mode}"><input type="hidden" name="next" value="${esc(next || '/')}">
        ${signup ? `<label>Name<input name="name" autocomplete="name" value="${esc(name)}" required></label>` : ''}
        <label>Email<input name="email" type="email" autocomplete="email" value="${esc(email)}" required></label>
        <label>Password<input name="password" type="password" minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
        ${error ? `<p class="error">${esc(error)}</p>` : ''}
        <div><button class="btn">${signup ? 'Create account' : 'Sign in'}</button></div>
      </form>
      <p class="switch-auth muted">${signup ? 'Already have an account?' : 'New here?'} <a href="${esc(other)}">${signup ? 'Sign in' : 'Create an account'}</a></p>
    </section>`,
  });
}

/* ---------------------------------------------------------------- groups */
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'web page'; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
async function myGroups(userId) {
  return (await q(`
    select g.id, g.name, m.role,
      (select count(*) from memberships x where x.group_id = g.id)::int as members,
      (select count(*) from documents d where d.group_id = g.id)::int as docs,
      greatest(g.created_at, (select max(created_at) from documents d where d.group_id = g.id)) as active
    from groups g join memberships m on m.group_id = g.id and m.user_id = $1
    order by active desc nulls last`, [userId])).rows;
}
app.get('/', needUser, async (req, res) => {
  const rows = await myGroups(req.user.id);
  res.send(page({
    title: 'Your groups', user: req.user,
    body: `
    <section class="intro">
      <p class="eyebrow">Library</p>
      <h1>Your groups</h1>
      <p>Start a bookshelf with some friends.</p>
    </section>
    <section class="section">
      <h2>Groups</h2>
      ${rows.length ? `<ul class="entries">${rows.map(g => `
        <li class="entry tappable"><div class="entry-header"><a class="entry-title" href="/g/${g.id}">${esc(g.name)}</a>
          <span class="entry-date">${g.role === 'owner' ? 'owner' : 'member'}</span></div>
          <div class="entry-role">${plural(g.docs, 'document')} · ${plural(g.members, 'member')}</div></li>`).join('')}</ul>`
        : `<p class="empty">You’re not in any groups yet. Create one below, or open an invite link someone sent you.</p>`}
      <form method="post" action="/groups" class="row-form">
        <input name="name" placeholder="New group name, e.g. PHIL 210 reading group" maxlength="80" required aria-label="New group name">
        <button class="btn">Create group</button>
      </form>
    </section>`,
  }));
});

app.post('/groups', needUser, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.redirect('/');
  const g = await one(`insert into groups (name, invite_code, created_by) values ($1, $2, $3) returning id`, [name, crypto.randomBytes(9).toString('base64url'), req.user.id]);
  await q(`insert into memberships (group_id, user_id, role) values ($1, $2, 'owner')`, [g.id, req.user.id]);
  res.redirect('/g/' + g.id);
});

app.get('/g/:id', needUser, async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  if (!g) return res.status(404).send(notFound(req));
  const docs = (await q(`select d.id, d.title, d.status, d.error, d.pages, d.words, d.created_at, d.uploaded_by, d.source_url, u.name as uploader,
      (select count(*) from comments c where c.document_id = d.id)::int as comments
    from documents d left join users u on u.id = d.uploaded_by where d.group_id = $1 order by d.created_at desc`, [g.id])).rows;
  const members = (await q(`select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id where m.group_id = $1 order by m.role = 'owner' desc, m.joined_at`, [g.id])).rows;
  const invite = `${req.protocol}://${req.get('host')}/join/${g.invite_code}`;
  const processing = docs.some(d => d.status === 'processing');
  const owner = g.role === 'owner';
  res.send(page({
    title: g.name, user: req.user,
    body: `
    <a class="back" href="/">‹ All groups</a>
    <section class="intro">
      <p class="eyebrow">Group</p>
      <h1>${esc(g.name)}</h1>
      <p class="muted">${plural(docs.length, 'document')} · ${plural(members.length, 'member')}</p>
      ${owner ? `<details class="rename"><summary>Rename</summary>
        <form method="post" action="/g/${g.id}/rename" class="row-form">
          <input name="name" value="${esc(g.name)}" maxlength="80" required aria-label="Group name" autocomplete="off">
          <button class="btn">Save</button>
        </form></details>` : ''}
      <nav class="jump" aria-label="On this page"><a href="#documents">Documents</a><a href="#members">Members</a><a href="#invite">Invite link</a></nav>
    </section>

    <section class="section" id="documents"${processing ? ` data-poll="/api/g/${g.id}/status"` : ''}>
      <h2>Documents</h2>
      ${docs.length ? `<ul class="entries">${docs.map(d => docRow(d, req.user.id, owner)).join('')}</ul>` : `<p class="empty">No documents yet. Upload the first PDF below.</p>`}
      <form method="post" action="/g/${g.id}/upload" enctype="multipart/form-data" class="upload" id="upload">
        <label class="drop" for="pdf"><input type="file" id="pdf" name="pdf" accept="application/pdf,.pdf" required>
          <span class="drop-text"><b>Choose a PDF</b><span class="drop-hint"> or drop it here</span><span class="muted">Up to 50 MB · converted to text for everyone in the group</span></span></label>
        <div class="progress" hidden><span></span></div>
        <input name="title" placeholder="Title (optional)" maxlength="160" aria-label="Title">
        <button class="btn">Upload</button>
      </form>
      <form method="post" action="/g/${g.id}/link" class="link-form">
        <label for="url">Or add a link to an article or PDF</label>
        <div class="row-form"><input id="url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…" required>
        <button class="btn">Add link</button></div>
      </form>
    </section>

    <section class="section" id="members">
      <h2>Members</h2>
      <ul class="people">${members.map(m => `<li><span class="who"><span class="dot" style="background:${colorFor(m.id)}"></span>${esc(m.name)}${m.id === req.user.id ? ' <span class="muted">(you)</span>' : ''}</span><span class="muted small">${m.role}</span></li>`).join('')}</ul>
      <div class="invite" id="invite">
        <p>Invite link. Anyone signed in who opens it joins this group.</p>
        <div class="copy-row"><input id="inviteLink" value="${esc(invite)}" readonly aria-label="Invite link"><button class="btn btn-plain" type="button" data-copy="inviteLink" data-share-title="Join ${esc(g.name)} on Margins">Copy</button></div>
        ${owner ? `<form method="post" action="/g/${g.id}/invite/reset"><button class="link quiet" onclick="return confirm('Make a new link? The current one will stop working.')">Make a new link</button></form>` : ''}
      </div>
    </section>

    <section class="section">
      <form method="post" action="/g/${g.id}/leave"><button class="link" onclick="return confirm('Leave ${esc(g.name).replace(/'/g, '’')}?')">Leave this group</button></form>
    </section>`,
  }));
});

function docRow(d, me, owner) {
  const meta = d.status === 'ready'
    ? `${d.pages ? `${d.pages} pages` : esc(hostOf(d.source_url))} · ${readTime(d.words)}${d.comments ? ` · ${plural(d.comments, 'comment')}` : ''}`
    : d.status === 'processing' ? `<span class="working">${d.source_url && !d.pages ? 'Fetching the article' : 'Converting to text'}</span>` : esc(d.error || 'Could not read this document.');
  const canDelete = owner || d.uploaded_by === me;
  return `<li class="entry ${d.status}${d.status === 'ready' ? ' tappable' : ''}">
    <div class="entry-header">
      ${d.status === 'ready' ? `<a class="entry-title" href="/d/${d.id}">${esc(d.title)}</a>` : `<span class="entry-title">${esc(d.title)}</span>`}
      <span class="entry-date">${when(d.created_at)}</span>
    </div>
    <div class="entry-role">${meta}</div>
    <div class="entry-actions"><span class="muted">Added by ${esc(d.uploader || 'a former member')}<span class="when-inline"> · ${when(d.created_at)}</span></span>
      ${d.source_url ? `<a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Original</a>` : d.status === 'ready' ? `<a href="/d/${d.id}/pdf">PDF</a>` : ''}
      ${d.status === 'failed' && canDelete ? `<form method="post" action="/d/${d.id}/retry"><button class="link">Retry</button></form>` : ''}
      ${canDelete ? `<form method="post" action="/d/${d.id}/delete"><button class="link quiet" onclick="return confirm('Delete “${esc(d.title).replace(/'/g, '’')}” and all its comments?')">Delete</button></form>` : ''}
    </div>
  </li>`;
}

app.post('/g/:id/rename', needUser, async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (g?.role === 'owner' && name) await q(`update groups set name = $2 where id = $1`, [g.id, name]);
  res.redirect('/g/' + req.params.id);
});

app.post('/g/:id/invite/reset', needUser, async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  if (g?.role === 'owner') await q(`update groups set invite_code = $2 where id = $1`, [g.id, crypto.randomBytes(9).toString('base64url')]);
  res.redirect('/g/' + req.params.id);
});

app.post('/g/:id/leave', needUser, async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  if (!g) return res.redirect('/');
  await q(`delete from memberships where group_id = $1 and user_id = $2`, [g.id, req.user.id]);
  const left = await one(`select count(*)::int n, count(*) filter (where role = 'owner')::int owners from memberships where group_id = $1`, [g.id]);
  if (left.n === 0) await q(`delete from groups where id = $1`, [g.id]);
  else if (left.owners === 0) await q(`update memberships set role = 'owner' where (group_id, user_id) = (select group_id, user_id from memberships where group_id = $1 order by joined_at limit 1)`, [g.id]);
  res.redirect('/');
});

app.get('/join/:code', needUser, async (req, res) => {
  const g = await one(`select g.id, g.name, (select count(*) from memberships m where m.group_id = g.id)::int as members,
      exists(select 1 from memberships m where m.group_id = g.id and m.user_id = $2) as joined
    from groups g where g.invite_code = $1`, [req.params.code, req.user.id]);
  if (!g) return res.status(404).send(page({ title: 'Invite expired', user: req.user, body: `<h1>This invite link doesn’t work</h1><p class="muted">It may have been replaced with a new one. Ask the person who sent it for the current link.</p><p><a href="/">Your groups</a></p>` }));
  if (g.joined) return res.redirect('/g/' + g.id);
  res.send(page({
    title: 'Join ' + g.name, user: req.user, body: `
    <section class="intro">
      <p class="eyebrow">You’ve been invited</p>
      <h1>${esc(g.name)}</h1>
      <p class="muted">${plural(g.members, 'member')}</p>
      <form method="post"><button class="btn">Join group</button></form>
    </section>`,
  }));
});
app.post('/join/:code', needUser, async (req, res) => {
  const g = await one(`select id from groups where invite_code = $1`, [req.params.code]);
  if (!g) return res.redirect('/join/' + encodeURIComponent(req.params.code));
  await q(`insert into memberships (group_id, user_id) values ($1, $2) on conflict do nothing`, [g.id, req.user.id]);
  res.redirect('/g/' + g.id);
});

/* ---------------------------------------------------------------- documents */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
app.post('/g/:id/upload', needUser, (req, res, next) => upload.single('pdf')(req, res, err => {
  if (err) return res.status(413).send(page({ title: 'Upload failed', user: req.user, body: `<h1>That file is too large</h1><p class="muted">PDFs can be up to 50 MB.</p><p><a href="/g/${esc(req.params.id)}">Back to the group</a></p>` }));
  next();
}), async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  if (!g) return res.status(404).send(notFound(req));
  const f = req.file;
  if (!f || f.buffer.subarray(0, 5).toString() !== '%PDF-')
    return res.status(400).send(page({ title: 'Upload failed', user: req.user, body: `<h1>That isn’t a PDF</h1><p class="muted">Choose a .pdf file and try again.</p><p><a href="/g/${g.id}">Back to ${esc(g.name)}</a></p>` }));
  const filename = Buffer.from(f.originalname, 'latin1').toString('utf8');
  const title = String(req.body.title || '').trim().slice(0, 160) || filename.replace(/\.pdf$/i, '');
  const d = await one(`insert into documents (group_id, title, title_auto, filename, uploaded_by, pdf) values ($1, $2, $3, $4, $5, $6) returning id`, [g.id, title, !String(req.body.title || '').trim(), filename, req.user.id, f.buffer]);
  enqueue(d.id);
  res.redirect('/g/' + g.id);
});

app.post('/g/:id/link', needUser, async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  if (!g) return res.status(404).send(notFound(req));
  let url = String(req.body.url || '').trim().slice(0, 2000);
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  let host;
  try { host = new URL(url).hostname; } catch {
    return res.status(400).send(page({ title: 'Link not added', user: req.user, body: `<h1>That doesn’t look like a link</h1><p class="muted">Paste a full web address, like https://example.com/article.</p><p><a href="/g/${g.id}">Back to ${esc(g.name)}</a></p>` }));
  }
  const title = String(req.body.title || '').trim().slice(0, 160);
  const d = await one(`insert into documents (group_id, title, title_auto, source_url, uploaded_by) values ($1, $2, $3, $4, $5) returning id`,
    [g.id, title || host.replace(/^www\./, ''), !title, url, req.user.id]);
  enqueue(d.id);
  res.redirect('/g/' + g.id);
});

// one document at a time keeps memory predictable on a small machine
const queue = [];
let busy = false;
function enqueue(id) { queue.push(id); pump(); }
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const id = queue.shift();
  try { await processDoc(id); } catch (e) { console.error('parse failed', id, e); await q(`update documents set status = 'failed', error = 'Could not read this PDF.' where id = $1`, [id]).catch(() => {}); }
  busy = false; pump();
}
async function processDoc(id) {
  const d = await one(`select id, title, title_auto, filename, pdf, source_url from documents where id = $1`, [id]);
  if (!d) return;
  if (d.source_url && !d.pdf) {
    let got;
    try { got = arxivId(d.source_url) ? await fetchArxiv(d.source_url) : await fetchUrl(d.source_url); } catch (e) {
      return q(`update documents set status = 'failed', error = $2 where id = $1`, [id, e instanceof FetchError ? e.message : 'Couldn’t fetch that link.']);
    }
    if (got.kind === 'article') {
      // arXiv paper with a full-text HTML version, already split into sections
      const title = d.title_auto ? got.title.slice(0, 160) : d.title;
      return q(`update documents set status = 'ready', error = null, title = $2, content = $3, pages = null, words = $4, source_url = $5 where id = $1`,
        [id, title, JSON.stringify(got.chapters), got.words, got.url]);
    }
    if (got.kind === 'pdf') {
      // a link to a PDF: keep the file and run it through the PDF converter below
      if (got.title && d.title_auto) { d.title = got.title; d.title_auto = false; await q(`update documents set title = $2, title_auto = false where id = $1`, [id, got.title]); }
      d.kicker = got.kicker;
      const name = got.filename || decodeURIComponent(new URL(got.url).pathname.split('/').pop() || 'document.pdf');
      d.filename = name.endsWith('.pdf') ? name : name + '.pdf';
      await q(`update documents set pdf = $2, filename = $3, source_url = $4 where id = $1`, [id, got.body, d.filename, got.url]);
      d.pdf = got.body;
    } else {
      try {
        const a = articleToChapters(got.html, got.url, d.title);
        const title = d.title_auto ? a.title.slice(0, 160) : d.title;
        return q(`update documents set status = 'ready', error = null, title = $2, content = $3, pages = null, words = $4, source_url = $5 where id = $1`,
          [id, title, JSON.stringify(a.chapters), a.words, got.url]);
      } catch (e) {
        return q(`update documents set status = 'failed', error = $2 where id = $1`, [id, e instanceof FetchError ? e.message : 'Couldn’t read that page.']);
      }
    }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-'));
  const file = path.join(dir, 'in.pdf');
  try {
    await fs.writeFile(file, d.pdf);
    const { stdout } = await run('python3', [path.join(ROOT, 'parser/parse_pdf.py'), file, d.title], { maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    const out = JSON.parse(stdout);
    if (out.error) return q(`update documents set status = 'failed', error = $2 where id = $1`, [id, out.error]);
    // an uploaded arXiv PDF: arXiv's own HTML keeps sections and maths far better than PDF extraction
    if (out.arxiv && !d.source_url) {
      try {
        const a = await fetchArxiv(`https://arxiv.org/abs/${out.arxiv}`);
        if (a?.kind === 'pdf' && a.title && d.title_auto) {
          // no HTML version, but arXiv still knows the real title and authors
          out.chapters.forEach(c => { c.kicker = a.kicker; if (c.group === out.title || c.group === d.title) c.group = a.title; });
          await q(`update documents set status = 'ready', error = null, title = $2, content = $3, pages = $4, words = $5, source_url = $6 where id = $1`,
            [id, a.title.slice(0, 160), JSON.stringify(out.chapters), out.pages, out.words, a.url]);
          return;
        }
        if (a?.kind === 'article') {
          const fallback = (d.filename || '').replace(/\.pdf$/i, '');
          const keepName = (fallback.match(/[A-Za-z]{2,}/g) || []).length >= 2 && !/arxiv/i.test(fallback);
          const title = d.title_auto && !keepName ? a.title.slice(0, 160) : d.title;
          return q(`update documents set status = 'ready', error = null, title = $2, content = $3, pages = $4, words = $5, source_url = $6 where id = $1`,
            [id, title, JSON.stringify(a.chapters), out.pages, a.words, a.url]);
        }
      } catch (e) { console.warn('arXiv HTML lookup failed, using the PDF', out.arxiv, e.message); }
    }
    // no title typed at upload: prefer the title stored inside the PDF over the filename
    const fallback = (d.filename || '').replace(/\.pdf$/i, '');
    // a descriptive filename beats a guessed title; an ID-like one (3282307, 1706.03762v7) doesn't
    const meaningful = (fallback.match(/[A-Za-z]{2,}/g) || []).length >= 2;
    const title = d.title_auto && out.title && out.title !== fallback && !(meaningful && !d.source_url) ? out.title.slice(0, 160) : d.title;
    if (d.kicker) out.chapters.forEach(c => { c.kicker = d.kicker; if (c.group === d.title || c.group === out.title) c.group = title; });
    await q(`update documents set status = 'ready', error = null, title = $5, content = $2, pages = $3, words = $4 where id = $1`, [id, JSON.stringify(out.chapters), out.pages, out.words, title]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

app.post('/d/:id/delete', needUser, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id);
  if (d && (d.role === 'owner' || d.uploaded_by === req.user.id)) await q(`delete from documents where id = $1`, [d.id]);
  res.redirect(d ? '/g/' + d.group_id : '/');
});

app.post('/d/:id/retry', needUser, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id);
  if (d && d.status === 'failed' && (d.role === 'owner' || d.uploaded_by === req.user.id)) {
    await q(`update documents set status = 'processing', error = null where id = $1`, [d.id]);
    enqueue(d.id);
  }
  res.redirect(d ? '/g/' + d.group_id + '#documents' : '/');
});

app.get('/d/:id/pdf', needUser, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id, 'd.id, d.group_id, d.filename, d.pdf');
  if (!d || !d.pdf) return res.status(404).send(notFound(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filename || 'document.pdf')}`);
  res.end(d.pdf);
});

const READER = (await fs.readFile(path.join(ROOT, 'views/reader.template.html'), 'utf8'))
  .replace('__APP__', await fs.readFile(path.join(ROOT, 'views/reader.js'), 'utf8'));
const json = v => JSON.stringify(v).replace(/</g, '\\u003c');
app.get('/d/:id', needUser, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id, 'd.id, d.group_id, d.title, d.status, d.pages, d.words, d.content, d.created_at, d.uploaded_by, d.source_url, (d.pdf is not null) as has_pdf');
  if (!d) return res.status(404).send(notFound(req));
  if (d.status !== 'ready') return res.redirect('/g/' + d.group_id);
  const uploader = d.uploaded_by ? (await one(`select name from users where id = $1`, [d.uploaded_by]))?.name : null;
  const origin = d.has_pdf ? `<a href="/d/${d.id}/pdf">Original PDF</a>` : `<a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Original article</a>`;
  const meta = `${d.pages ? `${d.pages} pages` : esc(hostOf(d.source_url))}${uploader ? ` · added by ${esc(uploader)}` : ''} · ${origin}`;
  const html = READER
    .replace('__TITLE__', () => esc(d.title))
    .replace('__DATA__', () => json(d.content))
    .replace('__DOC__', () => json({ id: d.id, title: d.title, group: { id: d.group_id, name: d.group_name } }))
    .replace('__ME__', () => json({ id: req.user.id, name: req.user.name }))
    .replace('__GROUP_ID__', () => d.group_id)
    .replace('__GROUP_NAME__', () => esc(d.group_name))
    .replace('__DOC_TITLE__', () => esc(d.title))
    .replace('__DOC_META__', () => meta)
    .replace('__DOC_ID__', () => d.id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + '<link rel="icon" href="/static/icon.svg"></head><body style="margin:0">' + html + '</body></html>');
});

app.get('/api/g/:id/status', needUserApi, async (req, res) => {
  const g = await membership(req.params.id, req.user.id);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const { rows } = await q(`select count(*) filter (where status = 'processing')::int as processing, count(*)::int as total from documents where group_id = $1`, [g.id]);
  res.setHeader('Cache-Control', 'no-store');
  res.json(rows[0]);
});

/* ---------------------------------------------------------------- comments API */
const shape = c => ({ id: c.id, ch: c.ch, k: c.k, start: c.start_at, end: c.end_at, quote: c.quote, text: c.body, uid: c.user_id, name: c.name, at: c.created_at });
app.get('/api/d/:id/comments', needUserApi, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  const { rows } = await q(`select c.*, u.name from comments c join users u on u.id = c.user_id where c.document_id = $1 order by c.created_at`, [d.id]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ comments: rows.map(shape) });
});
app.post('/api/d/:id/comments', needUserApi, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 4000);
  const start = Number(b.start), end = Number(b.end), k = Number(b.k);
  if (!text) return res.status(400).json({ error: 'Write something first.' });
  if (!/^[a-z0-9-]{1,40}$/.test(String(b.ch)) || ![k, start, end].every(Number.isInteger) || end <= start)
    return res.status(400).json({ error: 'That selection could not be saved. Select the text again.' });
  const c = await one(`insert into comments (document_id, user_id, ch, k, start_at, end_at, quote, body) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [d.id, req.user.id, b.ch, k, start, end, String(b.quote || '').slice(0, 1000), text]);
  res.status(201).json({ comment: shape({ ...c, name: req.user.name }) });
});
app.delete('/api/d/:id/comments/:cid', needUserApi, async (req, res) => {
  const d = await docFor(req.params.id, req.user.id);
  if (!d || !/^[0-9a-f-]{36}$/.test(req.params.cid)) return res.status(404).json({ error: 'Comment not found.' });
  const r = await q(`delete from comments where id = $1 and document_id = $2 and (user_id = $3 or $4)`, [req.params.cid, d.id, req.user.id, d.role === 'owner']);
  if (!r.rowCount) return res.status(403).json({ error: 'You can only delete your own comments.' });
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- misc */
app.get('/healthz', async (req, res) => { await q('select 1'); res.send('ok'); });
function notFound(req) {
  return page({ title: 'Not found', user: req.user, body: `<h1>Nothing here</h1><p class="muted">This page doesn’t exist, or you’re not a member of its group.</p><p><a href="/">Your groups</a></p>` });
}
app.use((req, res) => res.status(404).send(notFound(req)));
app.use((err, req, res, next) => { console.error(err); res.status(500).send(page({ title: 'Error', user: req.user, body: `<h1>Something went wrong</h1><p class="muted">Try again in a moment.</p>` })); });

/* ---------------------------------------------------------------- boot */
await q(await fs.readFile(path.join(ROOT, 'db/schema.sql'), 'utf8'));
await q(`delete from sessions where expires_at < now()`);
for (const r of (await q(`select id from documents where status = 'processing' order by created_at`)).rows) enqueue(r.id);
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`margins on :${port}`));
