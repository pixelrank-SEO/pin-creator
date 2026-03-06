'use strict';

// ── Tab routing ───────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Toast ─────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Auth status helpers ────────────────────────────────────
function setAuthConnected() {
  document.getElementById('auth-dot').className = 'auth-dot connected';
  document.getElementById('auth-status-text').textContent = 'Connected';
  document.getElementById('connect-btn').style.display = 'none';
}

function setAuthDisconnected() {
  document.getElementById('auth-dot').className = 'auth-dot disconnected';
  document.getElementById('auth-status-text').textContent = 'Not connected';
  document.getElementById('connect-btn').style.display = '';
}

// ── Boards loader ─────────────────────────────────────────
async function loadBoards() {
  try {
    const res = await fetch('/api/boards');
    if (!res.ok) throw new Error('Failed to fetch boards');
    const { boards } = await res.json();

    const opts = boards.map(b =>
      `<option value="${b.id}">${b.name} &nbsp;·&nbsp; ID: ${b.id} &nbsp;(${b.pinCount} pins)</option>`
    ).join('');

    document.getElementById('s-board').innerHTML = opts || '<option value="">No boards found</option>';
    document.getElementById('b-board').innerHTML = opts || '<option value="">No boards found</option>';

    setAuthConnected();
  } catch {
    setAuthDisconnected();
    const err = '<option value="">Connect Pinterest first</option>';
    document.getElementById('s-board').innerHTML = err;
    document.getElementById('b-board').innerHTML = err;
  }
}

// ── Handle OAuth redirect params ──────────────────────────
(function handleOAuthParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected') === '1') {
    toast('Pinterest connected successfully!');
    window.history.replaceState({}, '', '/');
  } else if (params.get('auth_error')) {
    toast('Pinterest auth failed: ' + params.get('auth_error'), 'err');
    window.history.replaceState({}, '', '/');
  }
})();

loadBoards();

// Show board hint when selection changes
document.getElementById('s-board').addEventListener('change', function () {
  const opt = this.options[this.selectedIndex];
  const hint = document.getElementById('s-board-hint');
  if (opt && opt.value) {
    hint.innerHTML = `Pin will be posted to: <strong>${opt.text.split('·')[0].trim()}</strong> (Board ID: <code>${opt.value}</code>)`;
    hint.classList.add('visible');
  } else {
    hint.classList.remove('visible');
  }
});

// ── Single Pin: Preview ───────────────────────────────────
document.getElementById('s-preview-btn').addEventListener('click', async () => {
  const url    = document.getElementById('s-url').value.trim();
  const aff    = document.getElementById('s-aff').value.trim();
  const board  = document.getElementById('s-board').value;
  const tags   = document.getElementById('s-tags').value;
  const ai     = document.getElementById('s-ai').checked;

  if (!url || !aff) { toast('Product URL and Affiliate URL are required', 'err'); return; }

  const btn = document.getElementById('s-preview-btn');
  btn.disabled = true;
  btn.textContent = 'Scraping…';

  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, affiliateUrl: aff, board, hashtags: tags, ai }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const { pin, meta } = data;
    document.getElementById('prev-img').src = pin.imageUrl || '';
    document.getElementById('prev-title').textContent = pin.title;
    document.getElementById('prev-desc').textContent = pin.description;
    const linkEl = document.getElementById('prev-link');
    linkEl.href = pin.link;
    linkEl.textContent = pin.link.length > 60 ? pin.link.slice(0, 57) + '…' : pin.link;

    document.getElementById('prev-title-len').textContent = `${meta.titleLen} / 100`;
    document.getElementById('prev-desc-len').textContent = `${meta.descLen} / 500`;

    document.getElementById('preview-card').style.display = '';
    toast('Preview ready');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Preview';
  }
});

// ── Single Pin: Post ──────────────────────────────────────
document.getElementById('s-post-btn').addEventListener('click', async () => {
  const url   = document.getElementById('s-url').value.trim();
  const aff   = document.getElementById('s-aff').value.trim();
  const board = document.getElementById('s-board').value;
  const tags  = document.getElementById('s-tags').value;
  const ai    = document.getElementById('s-ai').checked;

  if (!url || !aff) { toast('Product URL and Affiliate URL are required', 'err'); return; }
  if (!board) { toast('Select a board first', 'err'); return; }

  const btn = document.getElementById('s-post-btn');
  btn.disabled = true;
  btn.textContent = 'Posting…';

  const resultEl = document.getElementById('s-result');
  resultEl.style.display = 'none';

  try {
    const res = await fetch('/api/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, affiliateUrl: aff, board, hashtags: tags, ai }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    resultEl.className = 'result success';
    resultEl.innerHTML = `Posted! <a href="${data.pinUrl}" target="_blank" style="color:inherit">${data.pinUrl}</a>`;
    resultEl.style.display = '';
    toast('Pin posted successfully!');
  } catch (err) {
    resultEl.className = 'result error';
    resultEl.textContent = err.message;
    resultEl.style.display = '';
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post to Pinterest';
  }
});

// ── Batch: file label ─────────────────────────────────────
document.getElementById('b-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  document.getElementById('file-label').textContent = f ? f.name : 'Drop CSV here or click to browse';
});

const dropZone = document.getElementById('file-drop');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) {
    document.getElementById('b-file').files = e.dataTransfer.files;
    document.getElementById('file-label').textContent = f.name;
  }
});

// ── Batch: Start ──────────────────────────────────────────
document.getElementById('b-start-btn').addEventListener('click', async () => {
  const file  = document.getElementById('b-file').files[0];
  const board = document.getElementById('b-board').value;
  const delay = document.getElementById('b-delay').value;
  const ai    = document.getElementById('b-ai').checked;

  if (!file) { toast('Select a CSV file first', 'err'); return; }

  const btn = document.getElementById('b-start-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';

  const progCard = document.getElementById('batch-progress');
  const progBar  = document.getElementById('prog-bar');
  const progLbl  = document.getElementById('prog-label');
  const batchLog = document.getElementById('batch-log');

  progCard.style.display = '';
  batchLog.innerHTML = '';
  progBar.style.width = '0%';

  const form = new FormData();
  form.append('file', file);
  form.append('board', board);
  form.append('delay', delay * 1000);
  form.append('ai', ai);

  try {
    const res = await fetch('/api/batch', { method: 'POST', body: form });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        const line = part.replace(/^data: /, '').trim();
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === 'start') {
          total = ev.total;
          progLbl.textContent = `0 / ${total}`;
        } else if (ev.type === 'progress') {
          const pct = Math.round((ev.index / total) * 100);
          progBar.style.width = pct + '%';
          progLbl.textContent = `${ev.index} / ${total}`;

          const row = document.createElement('div');
          row.className = 'log-row ' + (ev.status === 'ok' ? 'ok' : 'err');
          if (ev.status === 'ok') {
            row.innerHTML = `<span class="log-dot"></span><div><div class="log-url">${ev.url}</div><a class="log-pin" href="${ev.pinUrl}" target="_blank">${ev.pinUrl}</a></div>`;
          } else {
            row.innerHTML = `<span class="log-dot"></span><div><div class="log-url">${ev.url}</div><div class="log-err">${ev.error}</div></div>`;
          }
          batchLog.appendChild(row);
          batchLog.scrollTop = batchLog.scrollHeight;
        } else if (ev.type === 'done') {
          toast(`Done: ${ev.success} posted, ${ev.failed} failed`);
        }
      }
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start Batch';
  }
});
