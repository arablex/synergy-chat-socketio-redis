// Наполняет чат «живыми» сообщениями от трёх пользователей и держит их онлайн,
// пока скрипт не остановят (нужно для скриншотов). URL=http://localhost:4784 node test/seed.js
const { io } = require("socket.io-client");
const URL = process.env.URL || "http://localhost:3000";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const connect = (nick) => new Promise((resolve) => {
  const s = io(URL, { transports: ["websocket"], forceNew: true });
  s.on("connect", async () => { await emit(s, "join", { nick }); resolve(s); });
});
(async () => {
  const [anna, boris, vera] = await Promise.all(["Анна", "Борис", "Вера"].map(connect));
  const say = async (s, room, text) => { await emit(s, "message:room", { room, text }); await wait(120); };
  const dm = async (s, to, text) => { await emit(s, "message:private", { to, text }); await wait(120); };
  await say(anna, "общий", "Всем привет! Кто уже посмотрел лекцию про Redis?");
  await say(boris, "общий", "Привет! Да, посмотрел. Адаптер для Socket.IO — удобная штука.");
  await say(vera, "общий", "Я тоже. Давайте обсудим итоговый проект в комнате #разработка");
  await say(anna, "общий", "Хорошо, переходим туда.");
  await say(vera, "разработка", "Предлагаю хранить историю в Redis-списках (LPUSH/LRANGE).");
  await say(boris, "разработка", "Согласен. И ограничим историю последними 100 сообщениями.");
  await dm(boris, "Анна", "Анна, привет! Скинь, пожалуйста, ссылку на репозиторий.");
  await dm(anna, "Борис", "Привет! Отправлю вечером, ещё дописываю README.");
  await dm(boris, "Анна", "Спасибо, жду.");
  console.log("Данные добавлены, клиенты онлайн. Ctrl+C для выхода.");
  await new Promise(() => {});
})();
