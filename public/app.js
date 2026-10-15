// Copy / share the invite link. Phones get the native share sheet.
document.querySelectorAll('[data-copy]').forEach(b => { if (navigator.share && matchMedia('(pointer: coarse)').matches) b.textContent = 'Share'; });
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const input = document.getElementById(b.dataset.copy);
  if (b.textContent === 'Share') {
    try { await navigator.share({ title: b.dataset.shareTitle, text: b.dataset.shareTitle, url: input.value }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
  const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = was), 1600);
});

// Whole-row taps on lists open the row's main link (other links in the row still work)
document.addEventListener('click', e => {
  const row = e.target.closest('.entry.tappable');
  if (!row || e.target.closest('a, button, form, input')) return;
  if (getSelection().toString()) return;
  row.querySelector('.entry-title')?.click();
});

// Upload: file name, drag and drop on desktop, real progress on slow connections
const drop = document.querySelector('.drop');
if (drop) {
  const form = document.getElementById('upload');
  const input = drop.querySelector('input[type=file]');
  const label = drop.querySelector('.drop-text b');
  const show = () => { const f = input.files[0]; drop.classList.toggle('has-file', !!f); label.textContent = f ? f.name : 'Choose a PDF'; };
  input.addEventListener('change', show);
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); } });
  form.addEventListener('submit', e => {
    if (!window.XMLHttpRequest || !window.FormData) return;
    e.preventDefault();
    const btn = form.querySelector('.btn'), bar = form.querySelector('.progress'), fill = bar.firstElementChild;
    btn.disabled = true; btn.textContent = 'Uploading…'; bar.hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.upload.onprogress = ev => {
      if (!ev.lengthComputable) return;
      const pct = Math.round(ev.loaded / ev.total * 100);
      fill.style.width = pct + '%';
      btn.textContent = pct < 100 ? `Uploading ${pct}%` : 'Saving…';
    };
    xhr.onload = () => {
      if (xhr.status < 400) { location.href = xhr.responseURL || location.href; return; }
      document.open(); document.write(xhr.responseText); document.close();
    };
    xhr.onerror = () => { btn.disabled = false; btn.textContent = 'Upload'; bar.hidden = true; alert('The upload failed. Check your connection and try again.'); };
    xhr.send(new FormData(form));
  });
}

// While a PDF converts, check quietly and refresh only when it's done
const poll = document.querySelector('[data-poll]');
if (poll) {
  let busy = false;
  const tick = async () => {
    if (document.hidden || busy) return;
    const a = document.activeElement;
    if (a && a.matches('input:not([readonly])') && (a.value || a.type === 'file')) return; // don't wipe what you're typing
    busy = true;
    try {
      const s = await (await fetch(poll.dataset.poll, { credentials: 'same-origin', cache: 'no-store' })).json();
      if (s.processing === 0) location.reload();
    } catch {} finally { busy = false; }
  };
  setInterval(tick, 3000);
  document.addEventListener('visibilitychange', tick);
}
