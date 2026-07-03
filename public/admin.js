// Admin UI — create/configure a session, open/close it, and view results.
const $ = (id) => document.getElementById(id);

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

const activeId = () => $('activeSessionId').value.trim();
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function createSession() {
  const name = $('sessionName').value.trim();
  if (!name) return toast('กรอกชื่อรอบโหวต', 'err');
  try {
    const s = await api('/voting-sessions', json({ name, eventDate: $('eventDate').value || null }));
    $('activeSessionId').value = s.id;
    toast(`สร้างรอบโหวตแล้ว: ${s.id}`);
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function seedSample() {
  let id = activeId();
  try {
    if (!id) {
      const s = await api('/voting-sessions', json({ name: $('sessionName').value.trim() || 'System Design Vote — Today', eventDate: $('eventDate').value || null }));
      id = s.id;
      $('activeSessionId').value = id;
    }
    const cats = [
      ['Wow Factor', 'ความน่าประทับใจและความโดดเด่นของแนวคิด'],
      ['Creativity', 'ความคิดสร้างสรรค์ของการออกแบบ'],
      ['Technical Depth', 'ความลึกและความถูกต้องเชิงเทคนิค'],
      ['Practicality', 'นำไปใช้งานได้จริงเพียงใด'],
      ['Presentation Clarity', 'ความชัดเจนในการนำเสนอ'],
    ];
    for (let i = 0; i < cats.length; i++) {
      await api(`/voting-sessions/${id}/categories`, json({ name: cats[i][0], description: cats[i][1], displayOrder: i + 1 }));
    }
    for (let i = 1; i <= 10; i++) {
      await api(`/voting-sessions/${id}/presenters`, json({ participantCode: `a${i}`, displayName: `Presenter A${i}`, presentationOrder: i, topicTitle: `System Design Topic ${i}` }));
    }
    toast('Seed สำเร็จ (5 หมวด + a1..a10)');
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function addCategory() {
  if (!activeId()) return toast('เลือก session ก่อน', 'err');
  try {
    await api(`/voting-sessions/${activeId()}/categories`, json({
      name: $('catName').value.trim(),
      description: $('catDesc').value.trim() || null,
      displayOrder: Number($('catOrder').value) || 0,
    }));
    $('catName').value = ''; $('catDesc').value = '';
    $('catOrder').value = Number($('catOrder').value || 0) + 1;
    toast('เพิ่มประเภทคะแนนแล้ว');
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function addPresenter() {
  if (!activeId()) return toast('เลือก session ก่อน', 'err');
  try {
    await api(`/voting-sessions/${activeId()}/presenters`, json({
      participantCode: $('pCode').value.trim(),
      displayName: $('pName').value.trim(),
      presentationOrder: Number($('pOrder').value) || undefined,
      topicTitle: $('pTopic').value.trim() || null,
    }));
    $('pCode').value = ''; $('pName').value = ''; $('pOrder').value = ''; $('pTopic').value = '';
    toast('เพิ่มผู้นำเสนอแล้ว');
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

async function openSession() {
  if (!activeId()) return toast('เลือก session ก่อน', 'err');
  try { const s = await api(`/voting-sessions/${activeId()}/open`, json({})); toast(`เปิดรอบโหวตแล้ว (${s.status})`); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}

async function closeSession() {
  if (!activeId()) return toast('เลือก session ก่อน', 'err');
  try { const s = await api(`/voting-sessions/${activeId()}/close`, json({})); toast(`ปิดรอบโหวตแล้ว (${s.status})`); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}

// Load session status + join code + editable lists.
async function refresh() {
  if (!activeId()) return;
  try {
    const session = await api(`/voting-sessions/${activeId()}`);
    $('statusBadge').innerHTML = ` — <span class="pill ${session.status}">${session.status}</span>`;
    if (session.joinCode) {
      $('joinCodeBox').classList.remove('hidden');
      $('joinCodeValue').textContent = session.joinCode;
      $('joinLink').textContent = voteLink(session.joinCode);
    }

    // We reuse the ballot endpoint for the setup listing; a dummy voterId just yields alreadyVoted=false.
    const ballot = await api(`/voting-sessions/${activeId()}/ballot?voterId=__admin__`);
    renderCategoryEditor(ballot.categories);
    renderPresenterEditor(ballot.presenters);
  } catch (e) { toast(e.message, 'err'); }
}

function renderCategoryEditor(categories) {
  const list = $('catList');
  list.className = 'edit-list';
  if (!categories.length) { list.innerHTML = '<li class="muted">ยังไม่มีประเภทคะแนน</li>'; return; }
  list.innerHTML = '';
  for (const c of categories) {
    const li = document.createElement('li');
    li.className = 'edit-row';
    li.innerHTML = `
      <input class="order" type="number" value="${c.displayOrder}" title="ลำดับ" />
      <input class="name" value="${escapeHtml(c.name)}" title="ชื่อประเภท" />
      <input class="desc" value="${escapeHtml(c.description || '')}" placeholder="คำอธิบาย" />
      <span class="actions">
        <button class="small">บันทึก</button>
        <button class="small ghost">ลบ</button>
      </span>`;
    const [orderEl, nameEl, descEl] = li.querySelectorAll('input');
    const [saveBtn, delBtn] = li.querySelectorAll('button');
    saveBtn.addEventListener('click', () => saveCategory(c.id, {
      name: nameEl.value.trim(), description: descEl.value.trim() || null, displayOrder: Number(orderEl.value) || 0,
    }));
    delBtn.addEventListener('click', () => deleteCategory(c.id));
    list.appendChild(li);
  }
}

function renderPresenterEditor(presenters) {
  const list = $('presenterAdminList');
  list.className = 'edit-list';
  if (!presenters.length) { list.innerHTML = '<li class="muted">ยังไม่มีผู้นำเสนอ</li>'; return; }
  list.innerHTML = '';
  for (const p of presenters) {
    const li = document.createElement('li');
    li.className = 'edit-row';
    li.innerHTML = `
      <input class="order" type="number" value="${p.presentationOrder}" title="ลำดับนำเสนอ" />
      <span class="tag">${p.code}</span>
      <input class="name" value="${escapeHtml(p.displayName)}" title="ชื่อผู้นำเสนอ" />
      <input class="topic" value="${escapeHtml(p.topicTitle || '')}" placeholder="หัวข้อ" />
      <span class="actions">
        <button class="small">บันทึก</button>
        <button class="small ghost">ลบ</button>
      </span>`;
    const [orderEl, nameEl, topicEl] = li.querySelectorAll('input');
    const [saveBtn, delBtn] = li.querySelectorAll('button');
    saveBtn.addEventListener('click', () => savePresenter(p.id, {
      displayName: nameEl.value.trim(), presentationOrder: Number(orderEl.value) || undefined, topicTitle: topicEl.value.trim() || null,
    }));
    delBtn.addEventListener('click', () => deletePresenter(p.id));
    list.appendChild(li);
  }
}

const patch = (body) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function saveCategory(id, body) {
  try { await api(`/voting-sessions/${activeId()}/categories/${id}`, patch(body)); toast('บันทึกประเภทคะแนนแล้ว'); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteCategory(id) {
  try { await api(`/voting-sessions/${activeId()}/categories/${id}`, { method: 'DELETE' }); toast('ลบประเภทคะแนนแล้ว'); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}
async function savePresenter(id, body) {
  try { await api(`/voting-sessions/${activeId()}/presenters/${id}`, patch(body)); toast('บันทึกผู้นำเสนอแล้ว'); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}
async function deletePresenter(id) {
  try { await api(`/voting-sessions/${activeId()}/presenters/${id}`, { method: 'DELETE' }); toast('ลบผู้นำเสนอแล้ว'); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}

async function loadResults() {
  if (!activeId()) return toast('เลือก session ก่อน', 'err');
  try {
    const { results } = await api(`/voting-sessions/${activeId()}/results`);
    if (!results.length) { $('resultsArea').innerHTML = '<p class="muted">ยังไม่มีผลคะแนน</p>'; return; }
    const catNames = results[0].categoryAverages.map((c) => c.name);
    const head = `<tr><th>อันดับ</th><th>ผู้นำเสนอ</th><th class="num">โหวต</th>${catNames.map((n) => `<th class="num">${escapeHtml(n)}</th>`).join('')}<th class="num">รวมเฉลี่ย</th></tr>`;
    const rows = results.map((r) => `
      <tr>
        <td class="rank">${r.rank}</td>
        <td>${r.code} — ${escapeHtml(r.displayName)}</td>
        <td class="num">${r.voteCount}</td>
        ${r.categoryAverages.map((c) => `<td class="num">${c.average.toFixed(2)}</td>`).join('')}
        <td class="num"><strong>${r.overallAverage.toFixed(2)}</strong></td>
      </tr>`).join('');
    $('resultsArea').innerHTML = `<table>${head}${rows}</table>`;
  } catch (e) { toast(e.message, 'err'); }
}

$('createSessionBtn').addEventListener('click', createSession);
$('seedBtn').addEventListener('click', seedSample);
$('refreshBtn').addEventListener('click', refresh);
$('addCatBtn').addEventListener('click', addCategory);
$('addPresenterBtn').addEventListener('click', addPresenter);
$('openBtn').addEventListener('click', openSession);
$('closeBtn').addEventListener('click', closeSession);
$('resultsBtn').addEventListener('click', loadResults);
// Shareable voter link with the code embedded — opening it auto-fills the code and enters the room.
const voteLink = (code) => `${location.origin}/?code=${encodeURIComponent(code)}`;

async function copyToClipboard(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    // Fallback for browsers/contexts where the async clipboard API is blocked.
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(okMsg); } catch { toast('คัดลอกไม่สำเร็จ', 'err'); }
    ta.remove();
  }
}

$('copyCodeBtn').addEventListener('click', () => copyToClipboard($('joinCodeValue').textContent.trim(), 'คัดลอกโค้ดแล้ว'));
$('copyLinkBtn').addEventListener('click', () => copyToClipboard(voteLink($('joinCodeValue').textContent.trim()), 'คัดลอกลิงก์เชิญโหวตแล้ว'));
