# Чат на Node.js, Socket.IO и Redis

Многопользовательский чат: общие комнаты (коллективная рассылка) и личные сообщения.
История сообщений и список «кто онлайн» хранятся в Redis.

## Запуск

Вариант 1 — Docker (приложение + Redis):

```bash
docker compose up --build
# http://localhost:3000
```

Вариант 2 — локально (нужен запущенный Redis):

```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
npm install
npm start          # http://localhost:3000
```

## Проверка несколькими клиентами

```bash
npm test           # подключает трёх клиентов socket.io-client и проверяет рассылку
```
