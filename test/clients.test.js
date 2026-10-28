// Проверка чата несколькими клиентами (socket.io-client из Node.js).
// Перед запуском: сервер должен работать (npm start), по умолчанию http://localhost:3000.
//   URL=http://localhost:4784 npm test
//
// Проверяем:
//  1) коллективная рассылка — сообщение в комнату получают ВСЕ участники;
//  2) личные сообщения — получает только адресат (и отправитель), третий пользователь ничего не видит;
//  3) список «онлайн» обновляется при входе/выходе;
//  4) история хранится в Redis и приходит новому клиенту.

const { io } = require("socket.io-client");

const URL = process.env.URL || "http://localhost:3000";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const log = (...a) => console.log(...a);
let failed = 0;
function check(name, cond, extra = "") {
  log(`${cond ? "  OK  " : " FAIL "} ${name}${extra ? "  -> " + extra : ""}`);
  if (!cond) failed++;
}

function client(nick) {
  const s = io(URL, { transports: ["websocket"], forceNew: true });
  s.nick = nick;
  s.inbox = [];
  s.users = [];
  s.on("message", (m) => s.inbox.push(m));
  s.on("users", (u) => (s.users = u));
  return new Promise((resolve) => s.on("connect", async () => {
    const res = await emit(s, "join", { nick });
    s.rooms = res.rooms;
    resolve(s);
  }));
}

(async () => {
  const suffix = Math.random().toString(36).slice(2, 6); // чтобы ники не пересекались с прошлыми запусками
  log(`Сервер: ${URL}\n`);

  log("1. Подключаем трёх клиентов");
  const [anna, boris, vera] = await Promise.all(["Anna" + suffix, "Boris" + suffix, "Vera" + suffix].map(client));
  await wait(300);
  check("все трое видят друг друга в списке онлайн", [anna, boris, vera].every((c) => c.users.length >= 3), anna.users.join(", "));
  check("есть стартовые комнаты", anna.rooms.includes("общий"), anna.rooms.join(", "));

  log("\n2. Групповая рассылка в комнату «общий»");
  await emit(anna, "message:room", { room: "общий", text: "Всем привет! (от Anna)" });
  await wait(300);
  for (const c of [anna, boris, vera]) {
    check(`${c.nick} получил сообщение комнаты`, c.inbox.some((m) => m.type === "room" && m.text.startsWith("Всем привет")));
  }

  log("\n3. Личное сообщение Boris -> Vera (Anna не должна получить)");
  await emit(boris, "message:private", { to: vera.nick, text: "Привет, Vera, это личное" });
  await wait(300);
  const isDm = (m) => m.type === "private" && m.text.includes("это личное");
  check("Vera (адресат) получила", vera.inbox.some(isDm));
  check("Boris (отправитель) получил копию", boris.inbox.some(isDm));
  check("Anna (посторонняя) НЕ получила", !anna.inbox.some(isDm));

  log("\n4. Ответ Vera -> Boris");
  await emit(vera, "message:private", { to: boris.nick, text: "Привет, Boris! Получила" });
  await wait(300);
  check("Boris получил ответ", boris.inbox.some((m) => m.type === "private" && m.from === vera.nick));
  check("Anna снова ничего не получила", !anna.inbox.some((m) => m.type === "private"));

  log("\n5. Новая комната и сообщение в неё");
  const created = await emit(anna, "room:create", { room: "тест" + suffix });
  check("комната создана", created.ok, created.room);
  await emit(vera, "message:room", { room: created.room, text: "Первое сообщение в новой комнате" });
  await wait(300);
  check("Boris получил сообщение из новой комнаты", boris.inbox.some((m) => m.room === created.room));

  log("\n6. История из Redis");
  const histRoom = await emit(boris, "history:room", { room: "общий" });
  check("история комнаты содержит сообщение Anna", histRoom.messages.some((m) => m.from === anna.nick));
  const histDm = await emit(vera, "history:private", { with: boris.nick });
  check("история личной переписки: 2 сообщения", histDm.messages.length === 2, `${histDm.messages.length}`);
  const histOther = await emit(anna, "history:private", { with: boris.nick });
  check("у Anna с Boris истории нет", histOther.messages.length === 0);

  log("\n7. Выход пользователя");
  vera.disconnect();
  await wait(400);
  check("Vera пропала из списка онлайн", !anna.users.includes(vera.nick), anna.users.join(", "));

  log("\n8. Валидация");
  const bad = await emit(anna, "message:room", { room: "общий", text: "   " });
  check("пустое сообщение отклонено", bad.ok === false, bad.error);

  [anna, boris].forEach((c) => c.disconnect());
  log(failed ? `\nПровалено проверок: ${failed}` : "\nВсе проверки пройдены");
  process.exit(failed ? 1 : 0);
})();
