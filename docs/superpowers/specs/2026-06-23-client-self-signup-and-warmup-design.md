# Саморегистрация клиентов + 15-дневный прогрев

**Статус:** draft → ожидает аппрува юзера
**Дата:** 2026-06-23
**Скоуп:** открыть саморегистрацию клиентов на новом домене `app.outreachos.pro` (и на polza-portal.ru), добавить выбор тарифа/оплату в ЛК клиента, заменить 3-дневную setup-фазу на 15-дневный прогрев почт, и снять гейт прогрева со всего кроме запуска кампаний.

## Контекст

Сейчас аккаунты заводит админ через `/admin/users`. Self-registration закрыта в middleware (см. [middleware.ts:205-212](app/src/middleware.ts:205)). Тарифы (`client_tariffs`), периоды, ЮKassa-биллинг, гейты на статусы `setup` / `active` — всё уже есть в коде. Сетап-фаза = 3 дня и блокирует у клиента **все** действия (парсеры, конструктор баз, append leads, запуск кампаний).

Юзер хочет:
- Открытая регистрация (email + пароль) на `app.outreachos.pro`. На polza-portal.ru — без изменений.
- После регистрации клиент в ЛК в «демо-режиме» (status=inactive): видит интерфейс, но не может запускать кампании.
- На `/client/tariff` — виджет выбора тарифа (standard/pro), периода (1/3/6/12 мес, дефолт 1), кнопка «Оплатить».
- После оплаты: **15 дней прогрев** (status=setup, можно пользоваться всем КРОМЕ запуска кампаний). Через 15 дней — реальный отсчёт тарифа (status=active).

## Архитектура

Всё в рамках существующих компонентов. Никаких новых подсистем.

### 1. Регистрация

Новые файлы:
- `app/src/app/signup/page.tsx` — UI (email/password + «зарегистрироваться»).
- `app/src/app/api/signup/route.ts` — POST endpoint.

Логика endpoint'a:
1. Валидирует email/password (минимум: непустые, password ≥ 8 символов).
2. `supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: false })` — создаёт юзера с подтверждённым email (для self-serve без подтверждения, чтобы не теряли клиентов на email-flow; ставится в backlog как улучшение).
3. Создаёт `profiles` row с `role='client'`, `locale='ru'`.
4. Создаёт `client_tariffs` row с `is_active=false`, `tariff_type='standard'`, `payment_locked=false`, остальные поля null.
5. Возвращает 201 + ссылку на /login (или сразу `signInWithPassword` на клиенте после успешного response — авто-вход).

Middleware ([middleware.ts:117-127](app/src/middleware.ts:117)):
- Добавляем `/signup` в `isPublicPath`.
- Default-deny для аккаунтов без роли остаётся — но т.к. signup ставит роль сразу, эта ветка нас не задевает.

### 2. Кнопка регистрации только на нужном поддомене

Login страница ([app/src/app/login/page.tsx](app/src/app/login/page.tsx)):
- Считываем `window.location.hostname` на клиенте.
- Если совпадает с `app.outreachos.pro` (точная строка или env var `NEXT_PUBLIC_SIGNUP_HOSTS=app.outreachos.pro`) — рендерим кнопку/ссылку «Зарегистрироваться» рядом с формой логина.
- Иначе — кнопки нет, доступ через админа (текущая копия «Доступ к порталу выдаёт администратор» остаётся).

`NEXT_PUBLIC_SIGNUP_HOSTS` — comma-separated. Можно перечислить несколько хостов без ребилда логики.

### 3. Выбор тарифа в ЛК клиента

`/client/tariff` ([app/src/app/client/tariff/page.tsx](app/src/app/client/tariff/page.tsx)):
- При `status === 'inactive'` и нет `paid_at` — наверху страницы показываем виджет «Выбрать тариф»:
  - Селектор: standard (40k/мес) / pro (80k/мес).
  - Селектор периода: 1 месяц / 3 месяца / 6 месяцев / 1 год.
  - Дефолт: standard, 1 месяц.
  - Подытог цены (умножение мес × месяцев). Без скидок (пока).
  - Кнопка «Оплатить через ЮKassa».
- Для `status === 'setup'/'active'/'expired'` — текущий вид страницы (без виджета покупки).

При клике «Оплатить»:
- POST `/api/client/payment/create` (новый endpoint, либо расширение существующего `/api/client/payment`).
- Endpoint:
  - Читает `client_tariffs` юзера.
  - Если `paid_at` уже set — отказ «Подписка уже оплачена».
  - Обновляет row: `billing_mode='invoice'`, `tariff_type` (selected), `billing_period` (selected), `billing_amount` (calc), `is_active=true`, `setup_until = now + 15 days`.
  - Вызывает `ensurePendingInvoiceForTariff()` (уже есть в [lib/billing.ts](app/src/lib/billing.ts)) — он создаёт invoice + получает payment_url от ЮKassa.
  - Возвращает `{ payment_url }`.
- Клиент редиректится на `payment_url` → ЮKassa.

После успешной оплаты webhook (`/api/invoices/webhook`) дёргает `applyInvoicePaidToTariff` ([tariffs.ts:106](app/src/lib/tariffs.ts:106)) — этот код уже корректно считает `paid_until = setup_until + period`, так что менять там ничего не надо.

### 4. Новый период «3 месяца»

Файл [tariffs.ts](app/src/lib/tariffs.ts):
- `BillingPeriod`: добавить `'quarter'` → `month | quarter | half_year | year`.
- `BILLING_PERIOD_MONTHS`: добавить `quarter: 3`.

UI на /client/tariff: показать все 4 опции.

Существующих миграций не требуется — `billing_period` уже TEXT в БД, новый литерал не ломает схему.

### 5. SETUP_DAYS: 3 → 15

Одна правка: [tariffs.ts:31](app/src/lib/tariffs.ts:31): `export const SETUP_DAYS = 15`.

Влияет на любого нового клиента (admin-created тоже). Существующие клиенты с уже-проставленным `setup_until` не задеваются.

### 6. Снятие гейта прогрева со всего кроме кампаний

В файлах ниже убрать ветку `if (clientStatus === 'setup') return jsonError('Ваш личный кабинет настраивается...', 403)`:
- [app/src/app/api/parsers/yandexmaps/route.ts:57-59](app/src/app/api/parsers/yandexmaps/route.ts:57)
- [app/src/app/api/parsers/search/route.ts:93](app/src/app/api/parsers/search/route.ts:93)
- [app/src/lib/clientLaunch/appendLeads.ts:103-106](app/src/lib/clientLaunch/appendLeads.ts:103) — но! appendLeads касается **добавления лидов к существующей кампании**. Это близко к запуску кампании. Оставлю как есть и сниму гейт только с парсеров. См. «Открытые вопросы» ниже.

Оставляем гейт **только** в:
- [app/src/lib/clientLaunch/runLaunch.ts:202](app/src/lib/clientLaunch/runLaunch.ts:202) — собственно запуск кампании.

После снятия гейта парсер видит `tariffUsage.status === 'setup'` и просто пропускает проверку — переходит к остальной логике (лимиты по тарифу). Поведение: клиент в прогреве может парсить, делать брифы, конструктор баз — но не запускать кампании.

### 7. UI копия в баннере и сообщениях

[PaymentLockedBanner.tsx:55-69](app/src/components/client/PaymentLockedBanner.tsx:55) — текущий текст подходит, не трогаем.

[runLaunch.ts:204](app/src/lib/clientLaunch/runLaunch.ts:204) — сейчас:
> «Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.»

Заменить на:
> «Идёт прогрев почт. Запуск кампаний станет доступен после завершения прогрева (15 дней с момента оплаты). До этого вы можете пользоваться всеми остальными инструментами.»

## Тестирование

- **Юнит на `applyInvoicePaidToTariff`** (расширить существующий [tests/lib/tariffs.test.ts](app/tests/lib/tariffs.test.ts) если есть): payment landing когда setup_until стоит на now+15d → paid_until = now+45d (для period='month').
- **Юнит на calcBillingAmount** для `quarter`: standard × 3 = 120k.
- **Юнит на `getClientStatus`**: статусы корректны на разных датах setup_until/paid_until.
- **Integration / E2E** (вручную):
  1. Регистрация на app.outreachos.pro → попадает в /client со status=inactive.
  2. Идёт на /client/tariff → видит виджет выбора → выбирает standard + 1 месяц → платит → редирект на ЮKassa.
  3. После оплаты (можно симулировать webhook) — status=setup, setup_until через 15 дней. Парсеры работают, запуск кампаний выдаёт ошибку про прогрев.
  4. Через 15 дней (можно проставить руками в БД) — status=active, кампании запускаются.

## Открытые вопросы

1. **appendLeads — гейт оставлять?** Сейчас он блокирует добавление лидов к существующей кампании в setup-фазе. Технически клиент не сможет «доливать» лидов в кампанию пока идёт прогрев. Если он не может **запустить** кампанию в прогреве, то и доливать особо некого. Оставляю гейт здесь — менее рискованно. Если ты хочешь снять — скажи, поправлю.

2. **Email confirmation на signup**. Сейчас в плане отключено (`email_confirm: false`), чтобы клиент сразу зашёл. Spam-bots могут регать аккаунты. Если хочешь подтверждение email — включаем (Supabase шлёт письмо с ссылкой). Это +1 шаг для клиента.

3. **Реклама/онбординг страницы**. Saas-классик: landing page на app.outreachos.pro/ с «Зарегистрироваться» CTA, потом /signup. Сейчас в дизайне сразу /login с кнопкой «зарегистрироваться». Если нужен лендинг — это отдельный спек.

4. **Локализация (en/ru)**. Login страница уже двуязычная (есть `locale`). /signup — копируем русский. Если outreachos.pro — международный продукт, нужен EN. Не делаю в этом спеке.

5. **Запрет повторной регистрации с тем же email**. Supabase Auth сам бросит 422 на дубликат — обрабатываем и показываем «Аккаунт уже существует, войдите».

## Что НЕ делаем сейчас

- Лендинг на app.outreachos.pro
- Email-confirmation flow (см. п.2 выше)
- Скидки за длинные периоды
- Бесплатный trial
- Stripe / международные платежи
- Восстановление пароля (есть в Supabase, но UI не приделан в этом спеке)
- Telegram-link для новых клиентов
- Email-warmup как процесс (предполагается что внешний прогрев почт делается клиентом самостоятельно через Instantly за эти 15 дней; портал просто не пускает в кампании раньше срока)
