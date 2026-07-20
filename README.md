# Portal - Система управления проектами

## Ветки проекта

- **`main`** - продакшн ветка. Используется для стабильной версии приложения.
- **`test`** - общая тестовая ветка. Содержит последние обновления и изменения для тестирования перед попаданием в продакшн.

## Функционал

Веб-приложение для управления проектами с следующими возможностями:

- **Управление проектами**: создание, редактирование и просмотр проектов
- **Множественные виды отображения**: карточки, канбан-доска, таблица
- **Фильтрация и поиск**: по названию, менеджеру, специалисту, статусу
- **Отслеживание статусов**: В работе, Тест, На паузе, Подготовка, Завершён
- **KPI метрики**: план и факт по каждому проекту
- **Управление дедлайнами**: визуальные предупреждения о просроченных и приближающихся дедлайнах
- **Команда проекта**: назначение менеджеров и специалистов
- **Комментарии**: отдельные комментарии от менеджеров (Эльвира, Аня)
- **Импорт данных**: загрузка проектов из CSV файлов
- **Аутентификация**: защита доступа через Supabase Auth

## Запуск проекта

### Требования

- Node.js 18+ 
- npm или yarn
- Docker и Docker Compose (для контейнерного запуска)

### Локальная разработка

#### Установка

```bash
cd app
npm install
```

#### Настройка переменных окружения

Создайте файл `.env.local` (или `.env`) в корне проекта:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_DB_URL=your_database_url
DATABASE_URL=your_database_url
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
AI_CALLER_TG_BOT_TOKEN=your_ai_caller_tg_bot_token
GUEST_TOKEN_SECRET=your_guest_token_secret
S3_BUCKET=your_s3_bucket_name
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your_s3_access_key_id
S3_SECRET_ACCESS_KEY=your_s3_secret_access_key
# Optional for S3-compatible storage (MinIO, Supabase Storage S3 protocol, etc.)
S3_ENDPOINT=http://localhost:9000
# Base URL where uploaded objects are publicly accessible (S3 website / CDN / public bucket URL)
# Example: https://my-bucket.s3.eu-central-1.amazonaws.com
S3_PUBLIC_BASE_URL=https://your-cdn-or-public-bucket-base
```

Для **Supabase Storage (S3 protocol)**:

- `S3_ENDPOINT`: возьмите из Supabase Dashboard → Storage → S3 → **Endpoint** (пример: `https://<project-ref>.supabase.co/storage/v1/s3`)
- `S3_REGION`: значение **Region** с этого же экрана
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`: создайте **Access key** там же
- `S3_BUCKET`: это **bucket id** в Supabase Storage (в проекте должен существовать, например `avatars`)
- `S3_PUBLIC_BASE_URL` можно **не задавать**, если bucket публичный — публичный URL будет выведен автоматически из `S3_ENDPOINT`

`SUPABASE_DB_URL` или `DATABASE_URL` используются для проверки соединения и автоприменения миграций при старте/деплое.
Локально миграции запускаются автоматически при `npm run dev` и `npm start`.

**Важно для продакшена:** используйте **Transaction pooler** (порт **6543**), не Session pooler (5432).
Supabase Dashboard → Connect → "Transaction" — иначе при нескольких сервисах (portal + workers) возникнет `MaxClientsInSessionMode`.

#### Запуск в режиме разработки

```bash
cd app
npm run dev
```

Приложение будет доступно по адресу [http://localhost:3000](http://localhost:3000)

### Запуск в Docker

#### Сборка и запуск

```bash
# Создайте .env.local в корне проекта с переменными окружения
docker-compose up -d --build
```

Приложение будет доступно по адресу [http://localhost:3000](http://localhost:3000)

#### Остановка

```bash
docker-compose down
```

#### Просмотр логов

```bash
docker-compose logs -f portal
```

## Логирование и аудит

- Логи приложения сохраняются в таблицу `application_logs` и доступны в админке (страница `/admin`).
- Для серверного логирования и приема клиентских логов через API необходим `SUPABASE_SERVICE_ROLE_KEY`.
- Realtime для логов включен миграцией, поэтому новые записи отображаются без обновления страницы.

### Ретеншн логов

Доступна функция очистки:

```sql
select public.cleanup_application_logs(30);
```

Для автоматизации можно настроить расписание через Supabase (pg_cron) на ежедневную очистку.

### Проверка логирования (manual)

1. Войдите под админом и откройте `/admin`.
2. Выполните действие (например, импорт CSV или изменение проекта).
3. Убедитесь, что новые записи появляются в блоке "Логи приложения" в realtime.

### Сборка для продакшена

```bash
cd app
npm run build
npm start
```

### Продакшн деплой

Для продакшн деплоя используйте `docker-compose.prod.yml`:

```bash
docker-compose -f docker-compose.prod.yml up -d
```

## Парсеры: масштабирование и безопасный роллаут

### Двухэтапное включение конкурентности

1. Этап A: задеплоить безопасные изменения (атомарный claim, конфиг), держать конкурентность низкой.
2. Этап B: повышать конкурентность постепенно, наблюдая стабильность.

### Где настраивается конкурентность (в коде)

- Worker-конкурентность: `MAX_CONCURRENCY` в `app/worker/hh.ts`, `app/worker/search.ts`, `app/worker/enrich.ts`, `app/worker/yandexmaps.ts`
- Search-конкурентность внутри job: `SEARCH_CONFIG` в `app/src/lib/config.ts`
- YandexMaps сервис: `YANDEXMAPS_CONCURRENCY` (Semaphore) в `services/yandexmaps/server.py`

### Чеклист после повышения

- Нет дублей выполнения job под нагрузкой.
- Среднее время job снижается, success rate приемлемый.
- Ошибки Supabase и блокировки провайдеров не растут.
- Запас RAM стабильно >20–30%.

## Проверка и согласование баз

### Процесс

1. **Специалист** подготавливает базу в «Работа с базами» → нажимает «На проверку».
2. **Ревьюер** (пользователь с включённым переключателем «Проверка баз» в админке) видит заявки в `/tools/databases/review`. Может одобрить, отправить на доработку, оставить цветовые пометки и комментарии к строкам.
3. После одобрения ревьюер отправляет базу в **Telegram-чат** проекта с inline-кнопками «Согласовано» / «Пожелания правок».
4. **Клиент** нажимает кнопку в Telegram:
   - «Согласовано» → база получает статус `client_approved`.
   - «Пожелания правок» → бот присылает гостевую ссылку; клиент оставляет комментарии и цветовые метки.

### Таблицы Supabase

- `database_review_requests` — заявки на проверку (статусы, привязка к вкладке, Telegram, guest-токен).
- `database_review_row_marks` — пометки строк (цвет, комментарий, тип автора).

### Переменные окружения

| Переменная | Описание |
|---|---|
| `AI_CALLER_TG_BOT_TOKEN` | Токен Telegram-бота (общий для звонилки и согласования) |
| `GUEST_TOKEN_SECRET` | Секрет для подписи гостевых токенов (по умолчанию `SUPABASE_SERVICE_ROLE_KEY`) |

### Настройка Telegram Webhook

После деплоя установите webhook для обработки inline-кнопок:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_DOMAIN>/api/ai-caller/telegram/webhook"
```

### Переключатель «Проверка баз»

Инструмент `database-review` по умолчанию **выключен**. Включается администратором в `/admin/users` через переключатель видимости инструментов.

## Telegram Mini App (TMA)

### Требования

- Приложение должно быть доступно по HTTPS.
- Нужен Telegram Bot Token (`TELEGRAM_BOT_TOKEN`).

### Настройка бота (Menu Button)

1. Создайте бота в BotFather.
2. Задайте Menu Button для бота (WebApp) и укажите HTTPS URL вашего приложения.
3. Откройте бота и запустите приложение через кнопку в меню.

### Привязка Telegram к аккаунту

- При запуске в Telegram WebApp выполняется верификация `initData`.
- После логина в `/login` аккаунт автоматически привязывается к Telegram (если токен верифицирован).

### Быстрая проверка

1. Откройте бота и запустите WebApp через Menu Button.
2. Войдите в аккаунт через `/login`.
3. Проверьте, что привязка Telegram выполнена и доступ к защищенным страницам сохраняется.

## Тестирование

### Запуск тестов

```bash
cd app
npm test
```

### Запуск тестов в watch режиме

```bash
cd app
npm run test:watch
```

### Запуск тестов с покрытием

```bash
cd app
npm run test:coverage
```

Тесты автоматически запускаются перед деплоем в CI/CD pipeline.

## Технологии

- **Next.js 16** - React фреймворк
- **TypeScript** - типизация
- **Supabase** - база данных и аутентификация
- **Tailwind CSS** - стилизация
- **PapaParse** - парсинг CSV файлов
- **Jest** - тестовый фреймворк
- **React Testing Library** - тестирование React компонентов
