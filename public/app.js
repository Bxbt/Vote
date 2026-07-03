// Voter UI — load a ballot, pick a presenter, give 1–5 stars per category, submit.
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  voterId: null,
  ballot: null,
  selectedPresenter: null,
  scores: {}, // categoryId -> 1..5
};

function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Reuse a per-device voter identity for a session so returning to the page keeps the same voter
// (and therefore the "one vote per presenter" rule). Falls back to minting a new identity via /join.
async function resolveVoterId(sessionId, displayName) {
  const key = `voter:${sessionId}`;
  const cached = localStorage.getItem(key);
  if (cached) return cached;
  const voter = await api(`/voting-sessions/${sessionId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  localStorage.setItem(key, voter.id);
  return voter.id;
}

async function loadBallot() {
  const code = $('joinCode').value.trim();
  const displayName = $('displayName').value.trim();
  if (!code) return toast('กรอกรหัสเข้าห้อง', 'err');
  try {
    const session = await api(`/voting-sessions/by-code/${encodeURIComponent(code)}`);
    state.sessionId = session.sessionId;
    state.voterId = await resolveVoterId(session.sessionId, displayName);
    state.ballot = await api(`/voting-sessions/${state.sessionId}/ballot?voterId=${encodeURIComponent(state.voterId)}`);
    renderBallot();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function statusPill(status) {
  return `<span class="pill ${status}">${status}</span>`;
}

function renderBallot() {
  const b = state.ballot;
  $('ballotCard').classList.remove('hidden');
  $('voteCard').classList.add('hidden');
  $('sessionStatus').innerHTML = statusPill(b.status);

  const votedCount = b.presenters.filter((p) => p.alreadyVoted).length;
  $('progress').textContent = `โหวตแล้ว ${votedCount} / ${b.presenters.length} คน` +
    (votedCount === b.presenters.length ? ' — โหวตครบแล้ว 🎉' : '');

  const list = $('presenterList');
  list.innerHTML = '';
  for (const p of b.presenters) {
    const el = document.createElement(p.alreadyVoted ? 'div' : 'button');
    el.className = 'presenter' + (p.alreadyVoted ? ' voted' : '');
    el.innerHTML = `
      <span class="code">${p.code}</span>
      <span class="name">${escapeHtml(p.displayName)}</span>
      <span class="status">${p.alreadyVoted ? '✓ โหวตแล้ว' : 'ยังไม่โหวต'}</span>`;
    if (!p.alreadyVoted) el.addEventListener('click', () => openVote(p));
    list.appendChild(el);
  }
}

function openVote(presenter) {
  if (state.ballot.status !== 'open') return toast('รอบโหวตไม่ได้เปิดอยู่', 'err');
  state.selectedPresenter = presenter;
  state.scores = {};
  $('votePresenterName').textContent = `${presenter.code} — ${presenter.displayName}`;

  const list = $('categoryList');
  list.innerHTML = '';
  for (const c of state.ballot.categories) {
    const row = document.createElement('div');
    row.className = 'category-row';
    row.innerHTML = `
      <div>
        <div class="category-name">${escapeHtml(c.name)}</div>
        ${c.description ? `<div class="category-desc">${escapeHtml(c.description)}</div>` : ''}
      </div>
      <div class="stars" data-category="${c.id}"></div>`;
    const stars = row.querySelector('.stars');
    for (let n = 1; n <= 5; n++) {
      const star = document.createElement('span');
      star.className = 'star';
      star.textContent = '★';
      star.title = `${n}`;
      star.addEventListener('click', () => { state.scores[c.id] = n; paintStars(stars, n); });
      stars.appendChild(star);
    }
    list.appendChild(row);
  }
  $('voteCard').classList.remove('hidden');
  $('voteCard').scrollIntoView({ behavior: 'smooth' });
}

function paintStars(container, value) {
  [...container.children].forEach((s, i) => s.classList.toggle('on', i < value));
}

async function submitVote() {
  const cats = state.ballot.categories;
  const scores = cats.map((c) => ({ categoryId: c.id, score: state.scores[c.id] }));
  if (scores.some((s) => !s.score)) return toast('กรุณาให้คะแนนทุกประเภท (1–5 ดาว)', 'err');

  try {
    await api(`/voting-sessions/${state.sessionId}/votes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterId: state.voterId, presenterId: state.selectedPresenter.id, scores }),
    });
    toast('ส่งคะแนนสำเร็จ', 'ok');
    await loadBallot();
    $('voteCard').classList.add('hidden');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('loadBtn').addEventListener('click', loadBallot);
$('submitBtn').addEventListener('click', submitVote);
$('cancelBtn').addEventListener('click', () => $('voteCard').classList.add('hidden'));

// Deep link: /?code=XXXX prefills the session code and enters the room automatically.
(function initFromUrl() {
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    $('joinCode').value = code.trim().toUpperCase();
    loadBallot();
  }
})();
