"""Turn a PDF into reader JSON: {title, pages, words, chapters:[{id, group, num, title, kicker, blocks:[{t, x}], words}]}.

Uses poppler's `pdftotext -bbox-layout` (columns come out in reading order, with line geometry) and
pypdf for the outline. Heuristics:
  * running heads / page numbers: short lines near the top or bottom edge that repeat across pages
  * paragraphs: a line indented from its block's left edge, or a short previous line ending a sentence
  * headings: lines noticeably taller than body text, or short centred lines
  * chapters: the PDF outline if it has one, else "Chapter N"-style headings, else large headings,
    else ~10-page chunks
Usage: python3 parse_pdf.py file.pdf [fallback title]
"""
import html, json, re, subprocess, sys, tempfile, os
from collections import Counter
from statistics import median

PDF = sys.argv[1]
FALLBACK_TITLE = sys.argv[2] if len(sys.argv) > 2 else 'Untitled'

LIG = {'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '‘‘': '“', '’’': '”', '\u00ad': ''}
SUPGLYPH = dict(zip('∞≤≥∂∑∏π∫\u2126≠', '1234567890'))  # some publishers' superscript-digit fonts
ROMAN = re.compile(r'^(?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{0,3})$', re.I)

def fail(msg):
    print(json.dumps({'error': msg})); sys.exit(0)

# ---------------------------------------------------------------- read geometry
TEXT_MODE = False
with tempfile.TemporaryDirectory() as tmp:
    out = os.path.join(tmp, 'b.html')
    r = subprocess.run(['pdftotext', '-bbox-layout', '-enc', 'UTF-8', PDF, out], capture_output=True, text=True)
    raw = open(out, encoding='utf-8', errors='replace').read() if r.returncode == 0 and os.path.exists(out) else ''
    if '<page' not in raw:
        # Some PDFs crash poppler's geometry output; plain text mode still reads them in order.
        r = subprocess.run(['pdftotext', '-enc', 'UTF-8', PDF, '-'], capture_output=True, text=True)
        if r.returncode != 0 or not r.stdout.strip():
            fail('Could not read this PDF. It may be damaged or password-protected.')
        TEXT_MODE = True
        raw = r.stdout

attr = lambda s, k: float(re.search(k + r'="([\d.\-]+)"', s).group(1))
pages = []   # bbox mode only; page = {h, w, blocks:[{x0,x1,lines:[{x0,x1,y0,y1,h,words:[(text,h,y0,y1)]}]}]}
for pm in ([] if TEXT_MODE else re.finditer(r'<page ([^>]*)>(.*?)</page>', raw, re.S)):
    page = {'w': attr(pm.group(1), 'width'), 'h': attr(pm.group(1), 'height'), 'blocks': []}
    for bm in re.finditer(r'<block ([^>]*)>(.*?)</block>', pm.group(2), re.S):
        blk = {'x0': attr(bm.group(1), 'xMin'), 'x1': attr(bm.group(1), 'xMax'), 'lines': []}
        for lm in re.finditer(r'<line ([^>]*)>(.*?)</line>', bm.group(2), re.S):
            words = [(html.unescape(w.group(2)), attr(w.group(1), 'yMax') - attr(w.group(1), 'yMin'), attr(w.group(1), 'yMin'), attr(w.group(1), 'yMax'))
                     for w in re.finditer(r'<word ([^>]*)>(.*?)</word>', lm.group(2), re.S)]
            if not words: continue
            la = lm.group(1)
            # rotated text (arXiv stamps, sideways margin notes) is page furniture
            if attr(la, 'yMax') - attr(la, 'yMin') > (attr(la, 'xMax') - attr(la, 'xMin')) * 1.5 and len(words) > 1: continue
            blk['lines'].append({'x0': attr(la, 'xMin'), 'x1': attr(la, 'xMax'), 'y0': attr(la, 'yMin'), 'y1': attr(la, 'yMax'), 'words': words})
        if blk['lines']: page['blocks'].append(blk)
    pages.append(page)

TEXT_PAGES = raw.split('\f') if TEXT_MODE else []
if TEXT_MODE:
    while TEXT_PAGES and not TEXT_PAGES[-1].strip(): TEXT_PAGES.pop()
if not pages and not TEXT_PAGES: fail('This PDF has no pages.')
alltext = raw if TEXT_MODE else ''.join(w[0] for p in pages for b in p['blocks'] for l in b['lines'] for w in l['words'])
if len(alltext) < 200:
    fail('This PDF has no selectable text. It looks like a scan, which needs OCR first.')

# body text height = most common line height
heights = [round(max(w[1] for w in l['words']), 1) for p in pages for b in p['blocks'] for l in b['lines'] if len(l['words']) > 3]  # empty in text mode
BODY_H = median(heights) if heights else 10

def line_text(l):
    out = []
    lh = median([w[1] for w in l['words']])
    for i, (t, h, y0, y1) in enumerate(l['words']):
        for a, b in LIG.items(): t = t.replace(a, b)
        # superscript note numbers: small, raised digits glued to the previous word
        glyph = ''.join(SUPGLYPH.get(c, '') for c in t)
        if i > 0 and ((re.fullmatch(r'\d{1,3}', t) and h < lh * 0.78 and y1 < l['words'][i - 1][3] - lh * 0.15) or (glyph and len(glyph) == len(t))):
            out[-1] += f'[[n:{glyph or t}]]'; continue
        m = re.match(r'^(.*?[a-z.,;:”’)])([∞≤≥∂∑∏π∫\u2126≠]+)$', t)
        if m:
            t = m.group(1) + '[[n:' + ''.join(SUPGLYPH[c] for c in m.group(2)) + ']]'
        out.append(t)
    return ' '.join(out)

# ---------------------------------------------------------------- running heads / page numbers
def key(s): return re.sub(r'\s+', ' ', re.sub(r'\b[\divxlc]+\b', '#', s.lower())).strip()
edge = Counter()
for p in pages:
    seen = set()
    for b in p['blocks']:
        for l in b['lines']:
            if l['y0'] < p['h'] * 0.09 or l['y1'] > p['h'] * 0.92:
                seen.add(key(line_text(l)))
    edge.update(seen)
def is_furniture(p, l, txt):
    if not (l['y0'] < p['h'] * 0.09 or l['y1'] > p['h'] * 0.92): return False
    if re.fullmatch(r'[\divxlc\-–— ]+', txt.lower()): return True
    return len(txt) < 90 and edge[key(txt)] >= 3

# ---------------------------------------------------------------- de-hyphenation
try:
    DICT = set(w.strip().lower() for w in open('/usr/share/dict/words', encoding='utf-8', errors='ignore'))
except OSError:
    DICT = set()
VOCAB = Counter(w.lower() for w in re.findall(r'[A-Za-z]+', alltext))
def isword(w):
    w = w.lower()
    if w in DICT or VOCAB[w] >= 2: return True
    for suf in ('s', 'es', 'ed', 'd', 'ing', 'ly', 'al'):
        if w.endswith(suf) and w[:-len(suf)] in DICT: return True
    return False
def join(a, b):
    if not a: return b
    m = re.search(r'([A-Za-z]+)-$', a)
    if m and re.match(r'[a-z]', b) and not re.match(r'(and|or|to)\b', b):
        right = re.match(r'[A-Za-z]+', b).group(0)
        if isword(m.group(1) + right) or not (isword(m.group(1)) and isword(right)):
            return a[:-1] + b
        return a + b
    return a + ' ' + b

# ---------------------------------------------------------------- lines -> paragraphs
# Every emitted item: {'t': 'p'|'h', 'x': text, 'page': n, 'big': float}
items = []
cur = None
def text_mode_items():
    # running heads: first/last lines repeated on 3+ pages, or bare page numbers
    def k(l): return re.sub(r'\s+', ' ', re.sub(r'\b[\divxlc]+\b', '#', l.strip().lower()))
    firsts = Counter(); lasts = Counter()
    plines = []
    for pt in TEXT_PAGES:
        ls = [l for l in pt.split('\n')]
        nb = [l for l in ls if l.strip()]
        if nb: firsts[k(nb[0])] += 1; lasts[k(nb[-1])] += 1
        plines.append(ls)
    lens = sorted(len(l.strip()) for ls in plines for l in ls if len(l.strip()) > 20)
    full = lens[int(len(lens) * 0.8)] if lens else 70
    out = []
    for pi, ls in enumerate(plines):
        nb_idx = [i for i, l in enumerate(ls) if l.strip()]
        drop = set()
        for i in nb_idx[:2] + nb_idx[-2:]:
            t = ls[i].strip()
            if re.fullmatch(r'[\divxlc\-–— ]+', t.lower()) or (len(t) < 90 and (firsts[k(t)] >= 3 or lasts[k(t)] >= 3)):
                drop.add(i)
        cur = None
        for i, l in enumerate(ls):
            t = l.strip()
            for a_, b_ in LIG.items(): t = t.replace(a_, b_)
            if i in drop: continue
            if not t:
                if cur: out.append(cur); cur = None
                continue
            # short, title-like line on its own: heading
            if cur is None and len(t) < 70 and not re.search(r'[.,;:]$', t) and (t.isupper() or t.istitle() or re.match(r'^(\d+(\.\d+)*|[IVX]+\.?)\s+[A-Z]', t)):
                out.append({'t': 'h', 'x': t, 'page': pi, 'big': 1.4 if re.match(r'^(\d+|[IVX]+)\.?\s', t) else 1.0}); continue
            if cur is None:
                cur = {'t': 'p', 'x': t, 'page': pi, 'big': 1.0}
            else:
                cur['x'] = join(cur['x'], t)
            if len(t) < full * 0.7 and re.search(r'[.?!:”"’)]$', t):
                out.append(cur); cur = None
        if cur:
            # carry a sentence that runs onto the next page
            if out and False: pass
            out.append(cur)
    out = [it for it in out if len(it['x']) > 3 or not re.fullmatch(r'[\d\W]*', it['x'])]
    # merge paragraphs split across pages
    merged = []
    for it in out:
        if merged and it['t'] == 'p' and merged[-1]['t'] == 'p' and it['page'] != merged[-1]['page'] and not re.search(r'[.?!:”"’)]$', merged[-1]['x']):
            merged[-1]['x'] = join(merged[-1]['x'], it['x']); continue
        merged.append(it)
    return merged

def flush():
    global cur
    if cur and cur['x'].strip(): items.append(cur)
    cur = None
if TEXT_MODE:
    items = text_mode_items()
NPAGES = len(TEXT_PAGES) if TEXT_MODE else len(pages)
for pi, p in enumerate(pages):
    for b in p['blocks']:
        lines = []
        for l in b['lines']:
            txt = line_text(l).strip()
            if txt and not is_furniture(p, l, txt):
                lines.append((l, txt))
        if not lines: continue
        width = max(l['x1'] for l, _ in lines) - min(l['x0'] for l, _ in lines)
        left = min(l['x0'] for l, _ in lines)
        right = max(l['x1'] for l, _ in lines)
        for idx, (l, txt) in enumerate(lines):
            h = median([w[1] for w in l['words']])
            big = h / BODY_H
            short = (l['x1'] - l['x0']) < width * 0.6
            centred = short and abs(((l['x0'] + l['x1']) / 2) - ((left + right) / 2)) < width * 0.08 and l['x0'] > left + width * 0.12
            heading = (big > 1.18 and len(txt) < 140) or (centred and len(txt) < 80 and not txt.endswith(('.', ',', ';')) or re.match(r'^(chapter|part|book|lecture)\s+\S+\.?$', txt, re.I))
            if heading and len(lines) <= 6 or (heading and big > 1.18):
                if cur and cur['t'] == 'h' and cur['page'] == pi and abs(cur['big'] - big) < 0.15:
                    cur['x'] += ' ' + txt; continue
                flush(); cur = {'t': 'h', 'x': txt, 'page': pi, 'big': big}; continue
            indent = l['x0'] - left
            prev = lines[idx - 1] if idx else None
            starts = (idx == 0 and cur is None) or indent > BODY_H * 0.9 or (cur is not None and cur['t'] == 'h')
            if prev is not None and prev[0]['x1'] < right - width * 0.18 and re.search(r'[.?!:”"’)]$', prev[1]):
                starts = True
            if idx == 0 and cur is not None and cur['t'] == 'p':
                # first line of a new block or page: continue the paragraph unless it clearly starts a new one
                starts = indent > BODY_H * 0.9 or bool(re.search(r'[.?!”"]$', cur['x'])) and txt[:1].isupper() and indent > 1
            if starts or cur is None:
                flush(); cur = {'t': 'p', 'x': txt, 'page': pi, 'big': big}
            else:
                cur['x'] = join(cur['x'], txt)
flush()

def norm(t):
    t = re.sub(r'“\s+', '“', t); t = re.sub(r'\s+”', '”', t)
    t = re.sub(r'\s+([;:,.?!])(?=\s|$|”|’|\))', r'\1', t)
    return re.sub(r'\s+', ' ', t).strip()
for it in items: it['x'] = norm(it['x'])

# ---------------------------------------------------------------- chapters
def outline_entries():
    try:
        from pypdf import PdfReader
        rd = PdfReader(PDF)
        def walk(nodes, depth, parent):
            out = []
            for i, n in enumerate(nodes):
                if isinstance(n, list):
                    prev = out[-1]['title'] if out else parent
                    out += walk(n, depth + 1, prev)
                else:
                    try: pg = rd.get_destination_page_number(n)
                    except Exception: continue
                    if pg is None: continue
                    out.append({'title': str(n.title).strip(), 'page': pg, 'depth': depth, 'parent': parent})
            return out
        return walk(rd.outline, 0, None)
    except Exception:
        return []

def title_key(s): return re.sub(r'[^a-z0-9]', '', s.lower())[:24]

def split_at(starts):
    """starts: list of (item_index, group, num, title) sorted"""
    chs = []
    if starts and starts[0][0] > 0:
        front = items[:starts[0][0]]
        if sum(len(i['x'].split()) for i in front) > 60:
            chs.append(('', '', 'Opening pages', front))
    for k, (ii, group, num, title) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else len(items)
        chs.append((group, num, title, items[ii:end]))
    return chs

CHPAT = re.compile(r'^(chapter|part|book|lecture|section)\s+([0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b\.?\s*(.*)$', re.I)
def chapter_heads(lo, hi):
    out = []
    for i in range(lo, hi):
        it = items[i]
        m = None
        if it['t'] == 'h' or len(it['x']) < 40:
            m = re.search(r'\b(chapter)\s+([0-9]+|[ivxlc]+)\b\.?\s*(.*)$', it['x'], re.I) if len(it['x']) < 160 else None
            m = m or CHPAT.match(it['x'])
        if m:
            title = m.group(3).strip(' .:—-')
            if not title and i + 1 < hi and (items[i + 1]['t'] == 'h' or len(items[i + 1]['x']) < 90):
                title = items[i + 1]['x'].strip(' .')
            num = m.group(2).upper() if ROMAN.match(m.group(2)) else m.group(2)
            out.append((i, num, title or f'{m.group(1).title()} {m.group(2)}'))
    return out

def subdivide(chs):
    # split long outline sections at their own "Chapter N" headings
    out = []
    for group, num, title, its in chs:
        words = sum(len(i['x'].split()) for i in its)
        lo = items.index(its[0]) if its else 0
        heads = chapter_heads(lo, lo + len(its)) if words > 6000 else []
        if len(heads) >= 2:
            if heads[0][0] > lo and sum(len(i['x'].split()) for i in items[lo:heads[0][0]]) > 60:
                out.append((title, '', title, items[lo:heads[0][0]]))
            for k, (i, n, t) in enumerate(heads):
                end = heads[k + 1][0] if k + 1 < len(heads) else lo + len(its)
                out.append((title, n, t, items[i:end]))
        else:
            out.append((group, num, title, its))
    return out

chapters_raw = None
ol = [e for e in outline_entries() if e['title']]
if len(ol) >= 2:
    depth0 = [e for e in ol if e['depth'] == 0]
    use = depth0 if len(depth0) >= 3 else [e for e in ol if e['depth'] <= 1]
    starts, used = [], set()
    for e in use:
        cand = [i for i, it in enumerate(items) if it['page'] == e['page']]
        if not cand:
            cand = [i for i, it in enumerate(items) if it['page'] > e['page']][:1]
        if not cand: continue
        tk = title_key(e['title'])
        hit = next((i for i in cand if tk and title_key(items[i]['x']).startswith(tk[:12])), cand[0])
        if hit in used: continue
        used.add(hit)
        starts.append((hit, e['parent'] or '', '', e['title']))
    starts.sort()
    if len(starts) >= 2: chapters_raw = subdivide(split_at(starts))

if chapters_raw is None:
    pat = re.compile(r'^(chapter|part|book|lecture|section)\s+([0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b\.?\s*(.*)$', re.I)
    starts = []
    for i, it in enumerate(items):
        m = pat.match(it['x']) if it['t'] == 'h' or len(it['x']) < 40 else None
        if m:
            title = m.group(3).strip(' .:—-')
            if not title and i + 1 < len(items) and items[i + 1]['t'] == 'h':
                title = items[i + 1]['x']
            num = m.group(2).upper() if ROMAN.match(m.group(2)) else m.group(2)
            starts.append((i, '', num, title or f'{m.group(1).title()} {m.group(2)}'))
    if len(starts) >= 2: chapters_raw = split_at(starts)

if chapters_raw is None:
    big = [i for i, it in enumerate(items) if it['t'] == 'h' and it['big'] > 1.3 and len(it['x']) < 100]
    if 2 <= len(big) <= max(3, NPAGES):
        chapters_raw = split_at([(i, '', '', items[i]['x']) for i in big])

if chapters_raw is None:
    # no structure: chunks of ~10 pages
    step = 10 if NPAGES > 14 else NPAGES
    starts = []
    for p0 in range(0, NPAGES, step):
        first = next((i for i, it in enumerate(items) if it['page'] >= p0), None)
        if first is not None and (not starts or first != starts[-1][0]):
            p1 = min(NPAGES, p0 + step)
            starts.append((first, '', '', f'Pages {p0 + 1}–{p1}' if step < NPAGES else 'Full text'))
    chapters_raw = split_at(starts)

# ---------------------------------------------------------------- output
info = subprocess.run(['pdfinfo', PDF], capture_output=True, text=True).stdout
mt = re.search(r'^Title:[ \t]*(\S.*)$', info, re.M)
doc_title = mt.group(1).strip() if mt and len(mt.group(1).strip()) > 3 and not mt.group(1).strip().lower().startswith(('microsoft', 'untitled')) else None
if not doc_title:
    # largest heading on the first two pages
    cands = [it for it in items if it['page'] <= 1 and it['t'] == 'h' and 8 <= len(it['x']) <= 140 and not re.match(r'(?i)arxiv:', it['x'])]
    doc_title = max(cands, key=lambda it: it['big'])['x'] if cands and max(c['big'] for c in cands) > 1.5 else FALLBACK_TITLE
    if TEXT_MODE and doc_title == FALLBACK_TITLE:
        first = next((it for it in items if it['page'] <= 1 and it['t'] == 'h' and 8 <= len(it['x']) <= 140 and not it['x'].isupper()), None)
        if first: doc_title = first['x']

chapters = []
for n, (group, num, title, its) in enumerate(chapters_raw):
    blocks = []
    for k, it in enumerate(its):
        if k == 0 and it['t'] == 'h' and title_key(it['x'])[:10] == title_key(title)[:10]: continue
        if blocks and blocks[-1]['t'] == 'h' and it['t'] == 'h' and k <= 2 and title_key(it['x'])[:10] == title_key(title)[:10]: continue
        blocks.append({'t': it['t'], 'x': it['x']})
    # drop a leading "Chapter N" heading that just repeats the title
    while blocks and len(blocks[0]['x']) < 160 and (re.search(r'\bchapter\s+[0-9ivxlc]+\b', blocks[0]['x'], re.I) or re.match(r'^(chapter|part|book|lecture|section)\s+\S+\.?$', blocks[0]['x'], re.I) or title_key(blocks[0]['x'])[:10] == title_key(title)[:10]):
        blocks.pop(0)
    words = sum(len(re.sub(r'\[\[n:\d+\]\]', '', b['x']).split()) for b in blocks)
    if words == 0: continue
    chapters.append({'id': f'c{n + 1}', 'group': group or doc_title, 'num': num, 'title': title[:160],
                     'kicker': (group or doc_title)[:80] + (f' · Chapter {num}' if num else ''), 'blocks': blocks, 'words': words})

doc_title = re.sub(r'\[\[n:\d+\]\]', '', doc_title).strip()
# arXiv stamps its ID (often rotated in the margin) on page 1
first_page = raw.split('\f')[0] if TEXT_MODE else (re.search(r'<page [^>]*>(.*?)</page>', raw, re.S) or [None, ''])[1]
first_text = re.sub(r'<[^>]+>', ' ', first_page)
am = re.search(r'arXiv:\s*(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?', first_text)
print(json.dumps({'title': doc_title, 'arxiv': (am.group(1) + (am.group(2) or '')) if am else None, 'pages': NPAGES, 'words': sum(c['words'] for c in chapters), 'chapters': chapters}, ensure_ascii=False))
