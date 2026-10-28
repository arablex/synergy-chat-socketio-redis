# Образ приложения чата: Node.js + Express + Socket.IO
FROM node:22-alpine
WORKDIR /app
# сначала зависимости (слой кэшируется, пока не меняется package.json)
COPY package*.json ./
RUN npm ci --omit=dev
# затем исходники
COPY src ./src
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
