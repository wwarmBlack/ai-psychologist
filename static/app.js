/* ===== Тихая Гавань — логика фронтенда =====
   Речь: Web Speech API (SpeechRecognition — распознавание, speechSynthesis — озвучка).
   Бесплатно, встроено в браузер. Лучше всего работает в Chrome/Edge. */

let token = localStorage.getItem('token') || '';
let profile = null;
let psychologists = [];
let onboardingQuestions = [];
let currentSession = null;   // {id, psy}
let recognition = null;
let recording = false;
let voices = [];

// ---------------- API ----------------
async function api(path, method = 'GET', body = null) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Ошибка сервера');
  return data;
}

// ---------------- Навигация ----------------
function show(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.add('hidden'));
  document.getElementById('tab-content-' + name).classList.remove('hidden');
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'history') loadHistory();
  if (name === 'schedule') loadBookings();
  if (name === 'profile') renderProfile();
}
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ---------------- Авторизация ----------------
async function doRegister() { await authAction('/register'); }
async function doLogin()    { await authAction('/login'); }

async function authAction(path) {
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  const err = document.getElementById('auth-error');
  err.textContent = '';
  try {
    const data = await api(path, 'POST', { email, password });
    token = data.token;
    localStorage.setItem('token', token);
    await boot();
  } catch (e) { err.textContent = e.message; }
}

function logout() {
  localStorage.removeItem('token');
  token = '';
  location.reload();
}

// ---------------- Загрузка приложения ----------------
async function boot() {
  try {
    [profile, psychologists, onboardingQuestions] = await Promise.all([
      api('/profile'),
      api('/psychologists').then(d => d.psychologists),
      api('/onboarding').then(d => d.questions),
    ]);
  } catch (e) { show('view-auth'); return; }

  if (!profile.onboarded) { renderOnboarding(); show('view-onboarding'); return; }
  enterApp();
}

function enterApp() {
  document.getElementById('home-name').textContent = profile.name ? ', ' + profile.name : '';
  renderPsyGrid();
  renderDefaultPsy();
  fillBookingSelect();
  show('view-app');
  showTab('home');
  initNotifications();
}

// ---------------- Онбординг ----------------
function questionBlock(q, prefix, selected) {
  const opts = q.options.map(o =>
    `<label style="display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer">
       <input type="radio" name="${prefix}-${q.id}" value="${o}" style="width:auto;margin:0" ${o === selected ? 'checked' : ''}> ${o}
     </label>`).join('');
  return `<div class="card"><h3>${q.question}</h3>${opts}</div>`;
}
function collectAnswers(prefix) {
  const answers = {};
  onboardingQuestions.forEach(q => {
    const sel = document.querySelector(`input[name="${prefix}-${q.id}"]:checked`);
    if (sel) answers[q.id] = sel.value;
  });
  return answers;
}

function renderOnboarding() {
  document.getElementById('ob-questions').innerHTML =
    onboardingQuestions.map(q => questionBlock(q, 'ob', null)).join('');
}

async function saveOnboarding() {
  await api('/profile', 'PUT', {
    name: document.getElementById('ob-name').value,
    age: document.getElementById('ob-age').value,
    about: '',
    answers: collectAnswers('ob'),
  });
  profile = await api('/profile');
  enterApp();
}

// ---------------- Психологи ----------------
function psyCardHTML(p, clickFn, withFav) {
  const isFav = profile.default_psychologist === p.id;
  return `<div class="psy-card ${isFav ? 'selected' : ''}" onclick="${clickFn}('${p.id}')">
    ${isFav ? '<span class="fav-badge">⭐</span>' : ''}
    <div class="psy-avatar">${p.avatar}</div>
    <h3>${p.name}</h3>
    <div class="psy-spec">${p.specialty}</div>
    <div class="psy-desc">${p.description}</div>
    ${withFav ? `<button class="psy-fav" onclick="event.stopPropagation();setDefaultPsy('${p.id}')">
        ${isFav ? '⭐ Ваш постоянный психолог' : '☆ Сделать постоянным'}</button>` : ''}
  </div>`;
}

function renderPsyGrid() {
  document.getElementById('psy-grid').innerHTML =
    psychologists.map(p => psyCardHTML(p, 'startSessionWith', true)).join('');
}

function renderDefaultPsy() {
  const el = document.getElementById('home-default-psy');
  const p = psychologists.find(x => x.id === profile.default_psychologist);
  el.innerHTML = p ? `<p class="muted">Ваш постоянный психолог: <b>${p.avatar} ${p.name}</b> — ${p.specialty}</p>` : '';
}

async function setDefaultPsy(id) {
  await api('/psychologists/default', 'POST', { psychologist_id: id });
  profile.default_psychologist = id;
  renderPsyGrid(); renderDefaultPsy();
}

function openPsyPicker() {
  if (profile.default_psychologist) { startSessionWith(profile.default_psychologist); return; }
  document.getElementById('psy-picker').innerHTML =
    psychologists.map(p => psyCardHTML(p, 'startSessionWith', false)).join('');
  document.getElementById('modal-psy').classList.remove('hidden');
}

// ---------------- Сессия (только голос) ----------------
function setStatus(t) { document.getElementById('session-status').textContent = t; }
function setOrb(state) {
  const orb = document.getElementById('orb');
  orb.className = 'orb' + (state ? ' ' + state : '');
}

async function startSessionWith(psyId) {
  closeModal('modal-psy');
  unlockAudio(); // разблокировать звук, пока действует жест клика
  const psy = psychologists.find(p => p.id === psyId);
  show('view-session');
  document.getElementById('session-psy-name').textContent = psy.avatar + ' ' + psy.name + ' · ' + psy.specialty;
  document.getElementById('orb-avatar').textContent = psy.avatar;
  setOrb('thinking');
  setStatus('Подключение к ' + psy.name + '...');
  try {
    const data = await api('/session/start', 'POST', { psychologist_id: psyId });
    currentSession = { id: data.session_id, psy };
    await speak(data.reply);
  } catch (e) {
    alert(e.message);
    show('view-app');
  }
}

async function sendVoice(text) {
  if (!text || !currentSession) return;
  setOrb('thinking');
  setStatus(currentSession.psy.name + ' думает...');
  try {
    const data = await api('/session/message', 'POST', { session_id: currentSession.id, text });
    await speak(data.reply);
  } catch (e) {
    setOrb('');
    setStatus('⚠️ ' + e.message);
  }
}

async function endSession() {
  if (!currentSession) { show('view-app'); return; }
  stopMic(); stopAudio();
  setOrb('thinking');
  setStatus('Готовим резюме сессии...');
  let summary = '';
  try {
    const data = await api('/session/end', 'POST', { session_id: currentSession.id });
    summary = data.summary;
  } catch (e) { summary = 'Не удалось получить резюме: ' + e.message; }
  currentSession = null;
  document.getElementById('summary-text').textContent = summary;
  document.getElementById('modal-summary').classList.remove('hidden');
}
async function closeSummary() {
  closeModal('modal-summary');
  profile = await api('/profile');
  enterApp();
}

// ---------------- Распознавание речи (Web Speech API) ----------------
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'ru-RU';
  r.interimResults = false;
  r.continuous = false;
  r.onresult = e => {
    const text = e.results[0][0].transcript;
    stopMic();
    sendVoice(text);
  };
  r.onerror = e => {
    stopMic();
    setStatus(e.error === 'not-allowed'
      ? 'Доступ к микрофону запрещён — разрешите его в настройках браузера'
      : 'Не расслышал, попробуйте ещё раз');
  };
  r.onend = () => stopMic();
  return r;
}

// Кнопка-рация: удерживайте, пока говорите; отпустили — отправилось
const micBtn = document.getElementById('mic-btn');
micBtn.addEventListener('pointerdown', startListening);
micBtn.addEventListener('pointerup', stopListening);
micBtn.addEventListener('pointercancel', stopListening);
micBtn.addEventListener('pointerleave', stopListening);
micBtn.addEventListener('contextmenu', e => e.preventDefault());

function startListening(e) {
  e.preventDefault();
  if (recording || !currentSession) return;
  if (!recognition) recognition = initRecognition();
  if (!recognition) {
    setStatus('Браузер не поддерживает распознавание речи — используйте Chrome или Edge');
    return;
  }
  unlockAudio();   // разблокировать звук, пока действует жест нажатия
  stopAudio();     // не слушать себя
  recording = true;
  micBtn.classList.add('recording');
  setOrb('listening');
  setStatus('Слушаю... Говорите и держите кнопку');
  try { recognition.start(); } catch (err) {}
}

function stopListening() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove('recording');
  if (recognition) try { recognition.stop(); } catch (err) {} // stop() завершает распознавание и отдаёт результат в onresult
}

function stopMic() {
  recording = false;
  micBtn.classList.remove('recording');
}

// ---------------- Озвучка (Edge-TTS на сервере, фолбэк — браузер) ----------------
// Один общий <audio>: «разблокирован» жестом пользователя, дальше Chrome разрешает
// ему играть без ограничений автовоспроизведения.
const player = new Audio();
let audioUnlocked = false;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

function unlockAudio() {
  if (audioUnlocked) return;
  player.src = SILENT_WAV;
  player.play().then(() => { audioUnlocked = true; }).catch(() => {});
}

function stopAudio() {
  try { player.pause(); } catch (e) {}
  speechSynthesis.cancel();
}

async function speak(text) {
  stopAudio();
  setOrb('speaking');
  setStatus(currentSession ? currentSession.psy.name + ' говорит...' : '');
  let played = false;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ text, psychologist_id: currentSession ? currentSession.psy.id : '' }),
    });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 200) {
        await new Promise((resolve, reject) => {
          player.src = URL.createObjectURL(blob);
          player.onended = resolve;
          player.onerror = resolve;
          player.play().then(() => { played = true; }).catch(reject);
        });
        played = true;
      }
    }
  } catch (e) { played = false; }
  if (!played) {
    // Фолбэк: голос браузера
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      u.rate = 1.1;
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
    });
  }
  setOrb('');
  setStatus('Удерживайте микрофон и говорите');
}

// ---------------- История сессий ----------------
async function loadHistory() {
  const data = await api('/sessions');
  const el = document.getElementById('history-list');
  if (!data.sessions.length) {
    el.innerHTML = '<p class="muted">Пока нет завершённых сессий.</p>';
    return;
  }
  el.innerHTML = data.sessions.map(s => {
    const d = new Date(s.started);
    return `<div class="card session-item" onclick="showSummary(${s.id})" id="sess-${s.id}">
      <h3>${s.psychologist}</h3>
      <p class="muted small">${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</p>
      <div class="summary hidden" id="sum-${s.id}" style="margin-top:10px">${escapeHtml(s.summary)}</div>
    </div>`;
  }).join('');
}
function showSummary(id) { document.getElementById('sum-' + id).classList.toggle('hidden'); }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ---------------- Расписание ----------------
function fillBookingSelect() {
  document.getElementById('book-psy').innerHTML =
    psychologists.map(p => `<option value="${p.id}">${p.avatar} ${p.name} — ${p.specialty}</option>`).join('');
}

async function createBooking() {
  const slot = document.getElementById('book-slot').value;
  if (!slot) { alert('Выберите дату и время'); return; }
  try {
    await api('/bookings', 'POST', {
      psychologist_id: document.getElementById('book-psy').value,
      slot,
    });
    loadBookings();
  } catch (e) { alert(e.message); }
}

async function loadBookings() {
  const data = await api('/bookings');
  const el = document.getElementById('bookings-list');
  if (!data.bookings.length) {
    el.innerHTML = '<p class="muted">Запланированных сессий нет.</p>';
    return;
  }
  el.innerHTML = data.bookings.map(b => {
    const d = new Date(b.slot);
    return `<div class="card booking-item">
      <div><b>${b.psychologist}</b><br>
      <span class="muted small">${d.toLocaleDateString('ru-RU')} в ${d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span></div>
      <button class="btn ghost" onclick="cancelBooking(${b.id})">Отменить</button>
    </div>`;
  }).join('');
}

async function cancelBooking(id) {
  await api('/bookings/' + id, 'DELETE');
  loadBookings();
}

// Уведомление за час до сессии (пока открыта вкладка)
const notifiedIds = new Set(JSON.parse(localStorage.getItem('notified') || '[]'));
function initNotifications() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  setInterval(checkUpcoming, 60 * 1000);
  checkUpcoming();
}
async function checkUpcoming() {
  if (!token) return;
  try {
    const data = await api('/bookings');
    const now = Date.now();
    data.bookings.forEach(b => {
      const diff = new Date(b.slot).getTime() - now;
      if (diff > 0 && diff <= 60 * 60 * 1000 && !notifiedIds.has(b.id)) {
        notifiedIds.add(b.id);
        localStorage.setItem('notified', JSON.stringify([...notifiedIds]));
        const msg = `Сессия с ${b.psychologist} начнётся в ${new Date(b.slot).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}`;
        if (Notification.permission === 'granted') new Notification('🕊️ Тихая Гавань — напоминание', { body: msg });
        else alert('🔔 ' + msg);
      }
    });
  } catch (e) {}
}

// ---------------- Профиль ----------------
function renderProfile() {
  document.getElementById('pf-name').value = profile.name || '';
  document.getElementById('pf-age').value = profile.age || '';
  document.getElementById('pf-about').value = profile.about || '';
  document.getElementById('pf-answers').innerHTML =
    onboardingQuestions.map(q => questionBlock(q, 'pf', profile.answers[q.id])).join('');
  document.getElementById('pf-balance').textContent = profile.balance.toFixed(0) + ' ₽';
  renderCardBlock();
}

function renderCardBlock() {
  const el = document.getElementById('pf-card-block');
  if (profile.card_last4) {
    el.innerHTML = `<p>💳 Карта •••• ${profile.card_last4} привязана</p>
      <label>Сумма пополнения, ₽</label>
      <input id="topup-amount" type="number" value="500" min="1">
      <button class="btn primary" onclick="topUp()">Пополнить баланс</button>`;
  } else {
    el.innerHTML = `<label>Номер карты (демо — данные не сохраняются)</label>
      <input id="card-number" placeholder="0000 0000 0000 0000" maxlength="19">
      <button class="btn primary" onclick="bindCard()">Привязать карту</button>`;
  }
}

async function bindCard() {
  try {
    const r = await api('/card', 'POST', { number: document.getElementById('card-number').value });
    profile.card_last4 = r.card_last4;
    renderCardBlock();
  } catch (e) { alert(e.message); }
}

async function topUp() {
  try {
    const r = await api('/balance/topup', 'POST', { amount: parseFloat(document.getElementById('topup-amount').value) });
    profile.balance = r.balance;
    document.getElementById('pf-balance').textContent = profile.balance.toFixed(0) + ' ₽';
  } catch (e) { alert(e.message); }
}

async function saveProfile() {
  await api('/profile', 'PUT', {
    name: document.getElementById('pf-name').value,
    age: document.getElementById('pf-age').value,
    about: document.getElementById('pf-about').value,
    answers: { ...profile.answers, ...collectAnswers('pf') },
  });
  profile = await api('/profile');
  document.getElementById('home-name').textContent = profile.name ? ', ' + profile.name : '';
  alert('Профиль сохранён');
}

// ---------------- Старт ----------------
if (token) boot(); else show('view-auth');
