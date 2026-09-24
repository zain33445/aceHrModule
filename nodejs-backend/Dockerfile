FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 5000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
