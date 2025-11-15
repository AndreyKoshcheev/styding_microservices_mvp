FROM node:18-alpine

WORKDIR /app

# Установка зависимостей
COPY package*.json ./
RUN npm ci --only=production

# Копирование исходного кода
COPY services/ ./services/
COPY shared/ ./shared/
COPY config/ ./config/
COPY scripts/ ./scripts/

# Установка curl для health checks
RUN apk add --no-cache curl

EXPOSE 3004

CMD ["node", "services/model-training-service/index.js"]