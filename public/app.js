// Клиент чата. Общается с сервером через Socket.IO (WebSocket).
// Диалог бывает двух видов: комната ("room", ключ "r:название") и личный ("dm", ключ "u:ник").

const socket = io();

// ---------- Состояние ----------
const state = {
  nick: null,
  rooms: [],
  users: [],
  active: null,            // ключ открытого диалога
  messages: new Map(),     // ключ диалога -> массив сообщений
  unread: new Map(),       // ключ диалога -> число непрочитанных
  loaded: new Set(),       // для каких диалогов уже загружена история
};

const $ = (id) => document.getElementById(id);
const el = {
  login: $("login"), loginForm: $("login-form"), nickInput: $("nick-input"), loginError: $("login-error"),
  chat: $("chat"), meNick: $("me-nick"), conn: $("conn"),
  rooms: $("rooms"), users: $("users"), usersCount: $("users-count"),
  addRoom: $("add-room"), roomForm: $("room-form"), roomInput: $("room-input"),
  title: $("dialog-title"), sub: $("dialog-sub"), messages: $("messages"),
  sendForm: $("send-form"), textInput: $("text-input"),
};

const roomKey = (r) => `r:${r}`;
const userKey = (n) => `u:${n}`;
const keyOfMessage = (m) => (m.type === "room" ? roomKey(m.room) : userKey(m.from === state.nick ? m.to : m.from));

// ---------- Вход ----------
function login(nick) {
  socket.emit("join", { nick }, (res) => {
    if (!res.ok) { el.loginError.textContent = res.error; return; }
    state.nick = res.nick;
    state.rooms = res.rooms;
    state.users = res.users;
    sessionStorage.setItem("nick", res.nick); // чтобы обновление страницы не выкидывало из чата
    el.login.hidden = true;
    el.chat.hidden = false;
    el.meNick.textContent = res.nick;
    renderSidebar();
    // ?open=r:общий или ?open=u:Борис — открыть нужный диалог сразу (удобно для ссылок и скриншотов)
    const wanted = new URLSearchParams(location.search).get("open");
    if (!state.active && wanted) openDialog(wanted);
    else if (!state.active) openDialog(roomKey(res.rooms.includes("общий") ? "общий" : res.rooms[0]));
    else openDialog(state.active, true);
  });
}

el.loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  login(el.nickInput.value);
});

// Повторный вход после разрыва соединения (сервер перезапустился, пропал интернет)
socket.on("connect", () => {
  el.conn.classList.add("status--on");
  // ник можно передать в адресе (?nick=Анна) или взять из прошлого входа в этой вкладке
  const saved = new URLSearchParams(location.search).get("nick") || sessionStorage.getItem("nick");
  if (saved) login(saved);
});
socket.on("disconnect", () => el.conn.classList.remove("status--on"));

// ---------- Сайдбар ----------
function renderSidebar() {
  el.rooms.innerHTML = "";
  for (const r of state.rooms) el.rooms.append(listItem(roomKey(r), `# ${r}`));

  const others = state.users.filter((u) => u !== state.nick);
  el.users.innerHTML = "";
  for (const u of others) el.users.append(listItem(userKey(u), u, true));
  el.usersCount.textContent = others.length ? `${others.length}` : "";
  if (!others.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.style.cursor = "default";
    li.textContent = "Пока никого нет";
    el.users.append(li);
  }
}

function listItem(key, label, online = false) {
  const li = document.createElement("li");
  li.dataset.key = key;
  if (key === state.active) li.classList.add("active");
  const name = document.createElement("span");
  name.className = "name";
  if (online) { const dot = document.createElement("i"); dot.className = "dot"; name.append(dot); }
  name.append(label);
  li.append(name);
  const n = state.unread.get(key);
  if (n) { const b = document.createElement("span"); b.className = "badge"; b.textContent = n; li.append(b); }
  li.addEventListener("click", () => openDialog(key));
  return li;
}

// ---------- Диалоги ----------
function openDialog(key, force = false) {
  if (state.active === key && !force && state.loaded.has(key)) return;
  state.active = key;
  state.unread.delete(key);
  const isRoom = key.startsWith("r:");
  const name = key.slice(2);
  el.title.textContent = isRoom ? `# ${name}` : name;
  el.sub.textContent = isRoom ? "общая комната — сообщения видят все" : "личная переписка — только вы двое";
  el.textInput.placeholder = isRoom ? `Сообщение в #${name}` : `Личное сообщение для ${name}`;
  renderSidebar();

  const event = isRoom ? "history:room" : "history:private";
  const payload = isRoom ? { room: name } : { with: name };
  socket.emit(event, payload, (res) => {
    state.messages.set(key, res.messages || []);
    state.loaded.add(key);
    renderMessages();
  });
  renderMessages();
  el.textInput.focus();
}

function renderMessages() {
  const list = state.messages.get(state.active) || [];
  el.messages.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "Сообщений пока нет. Напишите первым!";
    el.messages.append(p);
    return;
  }
  for (const m of list) el.messages.append(messageNode(m));
  el.messages.scrollTop = el.messages.scrollHeight;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function messageNode(m) {
  if (m.type === "system") {
    const s = document.createElement("div");
    s.className = "sys";
    s.textContent = m.text;
    return s;
  }
  const mine = m.from === state.nick;
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " msg--mine" : "");
  const meta = document.createElement("div");
  meta.className = "msg__meta";
  meta.innerHTML = `<b></b> · ${fmtTime(m.ts)}`;
  meta.querySelector("b").textContent = mine ? "Вы" : m.from; // textContent — защита от HTML в нике
  const body = document.createElement("div");
  body.className = "msg__body";
  body.textContent = m.text; // textContent — текст не исполняется как HTML
  wrap.append(meta, body);
  return wrap;
}

// ---------- События от сервера ----------
socket.on("message", (m) => {
  const key = keyOfMessage(m);
  if (!state.messages.has(key)) state.messages.set(key, []);
  // если история диалога ещё не загружена, сообщение уже придёт в ней из Redis
  if (state.loaded.has(key)) state.messages.get(key).push(m);
  if (key === state.active) renderMessages();
  else if (m.from !== state.nick) {
    state.unread.set(key, (state.unread.get(key) || 0) + 1);
    renderSidebar();
  }
});

socket.on("system", (m) => {
  const key = roomKey(m.room);
  if (!state.loaded.has(key)) return;
  state.messages.get(key).push({ type: "system", text: m.text, ts: m.ts });
  if (key === state.active) renderMessages();
});

socket.on("users", (users) => { state.users = users; renderSidebar(); });
socket.on("rooms", (rooms) => { state.rooms = rooms; renderSidebar(); });

// ---------- Отправка ----------
el.sendForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.textInput.value.trim();
  if (!text || !state.active) return;
  const name = state.active.slice(2);
  const isRoom = state.active.startsWith("r:");
  socket.emit(isRoom ? "message:room" : "message:private", isRoom ? { room: name, text } : { to: name, text }, (res) => {
    if (!res.ok) alert(res.error);
  });
  el.textInput.value = "";
});

// ---------- Создание комнаты ----------
el.addRoom.addEventListener("click", () => {
  el.roomForm.hidden = !el.roomForm.hidden;
  if (!el.roomForm.hidden) el.roomInput.focus();
});
el.roomForm.addEventListener("submit", (e) => {
  e.preventDefault();
  socket.emit("room:create", { room: el.roomInput.value }, (res) => {
    if (!res.ok) return alert(res.error);
    el.roomInput.value = "";
    el.roomForm.hidden = true;
    openDialog(roomKey(res.room));
  });
});
