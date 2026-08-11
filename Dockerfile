# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# Copy package files and patches
COPY app/package.json app/package-lock.json ./
COPY app/patches ./patches

# Install dependencies and force musl lightningcss binary for Alpine.
# package-lock currently contains only gnu flavor, which breaks Next/Turbopack on musl.
#
# --ignore-scripts: sqlite3 (через gramjs-sqlitesession) тянет node-gyp rebuild,
# который требует Python + make + g++, а их в чистом node:22-alpine нет.
#
# Раньше здесь считалось, что main-app биндинги не нужны. Это неверно:
# gramClient.ts берёт сессию из файла .session через readSqliteSession, когда у
# аккаунта пуст session_data, и без биндингов такой аккаунт не подключается
# вовсе — «Could not locate the bindings file» на каждой проверке профиля.
# Поэтому пересобираем sqlite3 так же, как это делает Dockerfile.worker:
# ставим инструменты во временный пакет и удаляем сразу после сборки, чтобы
# образ не потолстел.
RUN npm install --include=optional --ignore-scripts \
  && apk add --no-cache --virtual .native-build-deps python3 make g++ \
  && npm rebuild sqlite3 \
  && apk del .native-build-deps \
  && LIGHTNINGCSS_VERSION=$(node -p "require('./node_modules/lightningcss/package.json').version") \
  && npm install --no-save --ignore-scripts "lightningcss-linux-x64-musl@${LIGHTNINGCSS_VERSION}"

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY app/ ./

# Set environment variables for build
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_RDP_WS_URL
# Comma-separated список хостов, на которых /login показывает кнопку
# «Зарегистрироваться» (см. app/src/app/login/page.tsx, isSignupHost).
# Пусто на polza-portal.ru → кнопки нет; «app.outreachos.pro» на новом домене.
# Инлайнится в client bundle на этапе `next build` — изменение требует пересборки.
ARG NEXT_PUBLIC_SIGNUP_HOSTS

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_RDP_WS_URL=$NEXT_PUBLIC_RDP_WS_URL
ENV NEXT_PUBLIC_SIGNUP_HOSTS=$NEXT_PUBLIC_SIGNUP_HOSTS

# Increase Node heap for Next.js build (avoids OOM in Docker)
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Build Next.js application
RUN npm run build
RUN npm run build:sbis-importer

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# FFmpeg для инструмента расшифровки аудио/видео (извлечение дорожки и конвертация в mp3)
# su-exec для переключения на непривилегированного пользователя в entrypoint
RUN apk add --no-cache ffmpeg su-exec

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=deps /app/node_modules ./node_modules
COPY app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/dist/scripts/apply-sbis-directory-plan.cjs ./scripts/apply-sbis-directory-plan.cjs
COPY supabase/migrations ./supabase/migrations
COPY supabase/instantly-migrations ./supabase/instantly-migrations

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV BODY_SIZE_LIMIT=600mb

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "scripts/start.js"]
