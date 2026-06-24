# Client password change — Implementation Plan

> Status: **реализовано на ветке `dmitriy_kuladmed`** (2026-06-24). Merge + prod-deploy делает пользователь сам.

**Goal:** Клиент в ЛК может сменить пароль самостоятельно: вводит текущий пароль, задаёт новый (или генерирует кнопкой), получает на email подтверждение со ссылкой нового пароля.

**Provider decision history:**
- Brevo (Франция) — отброшен по соображениям санкционного риска и 152-ФЗ.
- RuSender — отброшен (Free API+SMTP = 100 писем/мес — тоже подойдёт, но Notisend лучше).
- **NotiSend** — выбран: российская юрисдикция (152-ФЗ ок), HTTPS API (никаких 25/587/465), free «Стартовый» = 200 уникальных получателей/мес + неогр. писем.

**Architecture:**
- UI: новая страница `/client/settings` + пункт «Настройки» в сайдбаре (между Support и Offer).
- API: `POST /api/client/password` под client bearer-токеном. Re-auth текущего пароля (одноразовый supabase client) → `supabase.auth.admin.updateUserById` → fire-and-forget email через NotiSend → audit log.
- Email: `POST https://api.notisend.ru/v1/email/messages`, `Authorization: Bearer <NOTISEND_API_KEY>`, плоский body (`from_email`/`from_name`/`to`/`subject`/`html`/`text`).
- Безопасность: re-auth перед сменой (защита от угнанной вкладки), HTML/IP escape в шаблоне письма, fire-and-forget email (его сбой не валит запрос).

**Tech Stack:** Next.js App Router + TypeScript, Supabase Auth, NotiSend REST API (без SDK — голый `fetch`), Jest, Tailwind v4, lucide-react иконки.

---

## File map (всё реализовано)

| Создано | Назначение |
|---|---|
| `app/src/lib/passwordGenerator.ts` | Крипто-стойкий генератор 8–72 символа (`crypto.getRandomValues`) |
| `app/src/lib/email/notisendClient.ts` | HTTPS-обёртка над NotiSend `/email/messages` |
| `app/src/lib/email/templates/passwordChanged.ts` | HTML+text шаблон письма с HTML-escape для password/IP |
| `app/src/app/api/client/password/route.ts` | POST endpoint смены пароля |
| `app/src/app/client/settings/page.tsx` | Серверный shell страницы Настройки |
| `app/src/app/client/settings/PasswordChangeForm.tsx` | Клиентская форма с кнопкой генерации и toggle visibility |
| `app/tests/lib/passwordGenerator.test.ts` | 9 тестов генератора |
| `app/tests/lib/email/notisendClient.test.ts` | 7 тестов клиента |
| `app/tests/lib/email/templates/passwordChanged.test.ts` | 7 тестов шаблона |
| `app/tests/api/clientPassword.test.ts` | 13 тестов роута |

| Изменено | Изменение |
|---|---|
| `app/src/lib/clientNav.ts` | Добавлен `CLIENT_NAV_SETTINGS` + ветка в `resolveActiveNavId` |
| `app/src/components/client/ClientNavList.tsx` | Рендер `CLIENT_NAV_SETTINGS` в bottom block между Support и Offer |
| `app/tests/lib/clientNav.test.ts` | +2 контрактных теста (href/id и активный сегмент) |

**Итого:** 62 unit-теста, все зелёные.

---

## Что должен сделать пользователь (один раз)

### 1. Brevo НЕ нужен — мы на NotiSend. Регистрация уже выполнена.

### 2. Подтвердить домен `outreachos.pro` в NotiSend
- NotiSend → раздел работы с доменами/отправителями → добавить `outreachos.pro`.
- Добавить выданные NotiSend DNS-записи (SPF / DKIM) у регистратора домена.
- Дождаться зелёных галочек верификации.

### 3. Получить API-ключ NotiSend
- NotiSend → API → создать новый ключ (имя «Portal production»).
- Скопировать (показывается один раз).

### 4. Положить env-переменные на prod (139.60.162.12)
В файл `.env` рядом с `docker-compose.prod.yml`:
```
NOTISEND_API_KEY=<ключ из шага 3>
NOTISEND_FROM_EMAIL=no-reply@outreachos.pro
NOTISEND_FROM_NAME=Portal
```
Затем `docker compose -f docker-compose.prod.yml up -d portal`.

### 5. Локально для dev — то же самое в локальный `.env` (или `host.env`).

---

## End-to-end сценарий проверки (после деплоя)

1. Войти под клиентским аккаунтом → в сайдбаре снизу появился пункт «Настройки».
2. Открыть `/client/settings`. Видна форма из 3 полей.
3. Ввести **неверный** текущий пароль + любой новый → ошибка «Неверный текущий пароль».
4. Нажать «🎲 Сгенерировать» → поля «Новый пароль» и «Подтверждение» заполняются сильным паролем (видимые после клика «Показать»).
5. Сохранить → «Готово. Письмо отправлено на ваш email.»
6. Проверить почту → пришло письмо с новым паролем, временем МСК, IP.
7. Разлогиниться, войти с новым паролем → успех.

Demo-аккаунт (если есть) получит 403 от `requireClientAuth` — это уже встроено в общий guard клиентских роутов.
