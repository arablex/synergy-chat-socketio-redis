// Многопользовательский чат: Express (раздаёт страницу) + Socket.IO (реальное время) + Redis.
//
// Что хранится в Redis:
//   chat:online               HASH   ник -> число открытых соединений (онлайн, если > 0)
//   chat:rooms                SET    названия общих комнат
//   chat:room:<комната>       LIST   история сообщений комнаты (последние HISTORY_LIMIT)
//   chat:dm:<ник1>:<ник2>     LIST   история личной переписки (ники в алфавитном порядке)
// Кроме этого Redis используется как «шина» между экземплярами сервера (@socket.io/redis-adapter):
// если запустить несколько копий приложения, рассылка всё равно дойдёт до всех пользователей.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const HISTORY_LIMIT = 100; // сколько последних сообщений помним в каждом чате
const DEFAULT_ROOMS = ["общий", "разработка", "флуд"];

const NICK_RE = /^[\p{L}\p{N}_-]{2,20}$/u; // буквы, цифры, _ и -, длина 2–20
const ROOM_RE = /^[\p{L}\p{N}_ -]{2,24}$/u;
const MAX_TEXT = 1000;

// ---------- Redis ----------
const redis = createClient({ url: REDIS_URL });
const pubClient = redis.duplicate(); // два отдельных соединения для адаптера (publish / subscribe)
const subClient = redis.duplicate();
[redis, pubClient, subClient].forEach((c) => c.on("error", (e) => console.error("Redis:", e.message)));

const kRoom = (room) => `chat:room:${room}`;
const kDm = (a, b) => `chat:dm:${[a, b].sort().join(":")}`;

async function saveMessage(key, msg) {
  await redis.rPush(key, JSON.stringify(msg));
  await redis.lTrim(key, -HISTORY_LIMIT, -1); // оставляем только последние N
}

async function readHistory(key) {
  const items = await redis.lRange(key, 0, -1);
  return items.map((s) => JSON.parse(s));
}

async function onlineUsers() {
  const all = await redis.hGetAll("chat:online");
  return Object.keys(all).filter((n) => Number(all[n]) > 0).sort((a, b) => a.localeCompare(b, "ru"));
}

// ---------- HTTP + Socket.IO ----------
const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server);

const clean = (s) => String(s ?? "").trim();
const makeMsg = (extra) => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...extra });

async function broadcastUsers() {
  io.emit("users", await onlineUsers()); // всем: обновлённый список «кто онлайн»
}
async function broadcastRooms() {
  io.emit("rooms", (await redis.sMembers("chat:rooms")).sort((a, b) => a.localeCompare(b, "ru")));
}

io.on("connection", (socket) => {
  let nick = null;

  // 1. Вход в чат по нику
  socket.on("join", async (data, ack) => {
    try {
      const wanted = clean(data?.nick);
      if (!NICK_RE.test(wanted)) return ack?.({ ok: false, error: "Ник: 2–20 символов, буквы, цифры, _ или -" });
      nick = wanted;
      socket.data.nick = nick;

      // личная «комната» пользователя — по ней доставляем личные сообщения (даже в нескольких вкладках)
      socket.join(`user:${nick}`);
      await redis.hIncrBy("chat:online", nick, 1);

      // все общие комнаты: подписываем сокет на каждую
      const rooms = (await redis.sMembers("chat:rooms")).sort((a, b) => a.localeCompare(b, "ru"));
      rooms.forEach((r) => socket.join(`room:${r}`));

      ack?.({ ok: true, nick, rooms, users: await onlineUsers() });
      await broadcastUsers();
      socket.to(`room:${rooms[0]}`).emit("system", { room: rooms[0], text: `${nick} вошёл в чат`, ts: Date.now() });
    } catch (e) {
      console.error(e);
      ack?.({ ok: false, error: "Ошибка сервера" });
    }
  });

  // 2. Групповое сообщение: уходит ВСЕМ, кто подписан на комнату (включая отправителя)
  socket.on("message:room", async (data, ack) => {
    if (!nick) return ack?.({ ok: false, error: "Сначала войдите" });
    const room = clean(data?.room);
    const text = clean(data?.text).slice(0, MAX_TEXT);
    if (!text) return ack?.({ ok: false, error: "Пустое сообщение" });
    if (!(await redis.sIsMember("chat:rooms", room))) return ack?.({ ok: false, error: "Нет такой комнаты" });

    const msg = makeMsg({ type: "room", room, from: nick, text });
    await saveMessage(kRoom(room), msg);
    io.to(`room:${room}`).emit("message", msg); // коллективная рассылка
    ack?.({ ok: true });
  });

  // 3. Личное сообщение: получает только адресат и отправитель (его другие вкладки)
  socket.on("message:private", async (data, ack) => {
    if (!nick) return ack?.({ ok: false, error: "Сначала войдите" });
    const to = clean(data?.to);
    const text = clean(data?.text).slice(0, MAX_TEXT);
    if (!text) return ack?.({ ok: false, error: "Пустое сообщение" });
    if (!NICK_RE.test(to) || to === nick) return ack?.({ ok: false, error: "Некорректный адресат" });

    const msg = makeMsg({ type: "private", from: nick, to, text });
    await saveMessage(kDm(nick, to), msg); // хранится, даже если адресат сейчас офлайн
    io.to(`user:${to}`).to(`user:${nick}`).emit("message", msg); // только эти две «комнаты»
    ack?.({ ok: true });
  });

  // 4. История комнаты / личной переписки
  socket.on("history:room", async (data, ack) => {
    ack?.({ ok: true, messages: await readHistory(kRoom(clean(data?.room))) });
  });
  socket.on("history:private", async (data, ack) => {
    if (!nick) return ack?.({ ok: false, messages: [] });
    ack?.({ ok: true, messages: await readHistory(kDm(nick, clean(data?.with))) });
  });

  // 5. Создание новой общей комнаты
  socket.on("room:create", async (data, ack) => {
    if (!nick) return ack?.({ ok: false, error: "Сначала войдите" });
    const room = clean(data?.room).replace(/\s+/g, " ");
    if (!ROOM_RE.test(room)) return ack?.({ ok: false, error: "Название комнаты: 2–24 символа" });
    const added = await redis.sAdd("chat:rooms", room);
    if (!added) return ack?.({ ok: false, error: "Такая комната уже есть" });
    io.socketsJoin(`room:${room}`); // подписываем всех подключённых (на всех экземплярах сервера)
    await broadcastRooms();
    ack?.({ ok: true, room });
  });

  // 6. Выход: уменьшаем счётчик соединений, при нуле пользователь «офлайн»
  socket.on("disconnect", async () => {
    if (!nick) return;
    try {
      const left = await redis.hIncrBy("chat:online", nick, -1);
      if (left <= 0) await redis.hDel("chat:online", nick);
      await broadcastUsers();
    } catch (e) {
      console.error(e);
    }
  });
});

async function start() {
  await Promise.all([redis.connect(), pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  // при старте приложения все «онлайн» из прошлого запуска недействительны — очищаем
  await redis.del("chat:online");
  if ((await redis.sCard("chat:rooms")) === 0) await redis.sAdd("chat:rooms", DEFAULT_ROOMS);

  server.listen(PORT, () => console.log(`Чат запущен: http://localhost:${PORT} (Redis: ${REDIS_URL})`));
}

start().catch((e) => {
  console.error("Не удалось запустить сервер:", e.message);
  process.exit(1);
});

// аккуратное завершение (Ctrl+C / docker stop)
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    io.close();
    await Promise.allSettled([redis.quit(), pubClient.quit(), subClient.quit()]);
    process.exit(0);
  });
}
