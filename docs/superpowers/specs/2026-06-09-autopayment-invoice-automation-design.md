# Автосоздание счетов и рекуррентные платежи для autopayment-режима

Дата: 2026-06-09 · ветка: `dmitriy_kuladmed`

## Что меняется

1. Когда админ активирует / продлевает подписку клиента с `billing_mode='autopayment'` —
   **счёт в YooKassa создаётся автоматически**, без перехода на страницу `/invoices`.
   Запись виден на `/invoices`, ссылка появляется в ЛК клиента.
2. Клиент в ЛК открывает существующую ссылку (один счёт = одна ссылка, пока invoice
   pending и `expires_at` не вышел). Платит, YooKassa сохраняет карту (флаг
   `save_payment_method=true` уже передаётся, на форме YK появится чекбокс
   «Запомнить данные карты» после подключения автоплатежей).
3. Раз в месяц (за 1 день до `paid_until`) cron создаёт **новый** invoice
   и через `chargeRecurringPayment()` списывает с сохранённой карты. Каждое
   списание видно как paid invoice в `/invoices`.
4. В ЛК клиента кнопка «Отключить автопродление» переименована в **«Отвязать
   карту»** — поведение прежнее (`yookassa_payment_method_id=null`,
   `auto_renew=false`). Это удовлетворяет требования YooKassa тех. поддержки:
   формальная процедура, видимая в кабинете, без обращения к их API.
5. Ошибки YooKassa маппятся в понятные русские тексты и показываются в ЛК
   и (для cron) сохраняются в `client_tariffs.last_renewal_error`.
6. Чинится баг webhook'а: `payment.canceled` больше не помечает наш invoice
   как `cancelled`. Клиент пробует оплатить по той же ссылке столько раз,
   сколько нужно.

## Архитектура

Новый файл `app/src/lib/billing.ts` — три экспорта:

```ts
ensurePendingInvoiceForTariff(userId, { reason })
  → { invoice, yookassaUrl, yookassaError? }
  // Идемпотентно: возвращает существующий pending invoice если YK-URL валиден
  //               и YK expires_at > now. Иначе создаёт новый.
  // Сумма: client_tariffs.billing_amount, fallback calcBillingAmount(tariff, period).
  // save_payment_method=true передаётся всегда.

mapYookassaErrorRu(reason: string | null | undefined) → string
  // YooKassa cancellation_details.reason → краткий русский текст для UI.

chargeMonthlyRenewal(tariffRow)
  → { invoiceId, success, errorRu? }
  // Cron-путь: создаёт invoices row, вызывает chargeRecurringPayment(),
  // результат записывает в тот же row (paid/pending) и продлевает paid_until.
```

## Кто кого зовёт

| Caller | Действие |
|---|---|
| `PUT /api/admin/users/[id]/tariff` action='activate' с `billing_mode='autopayment'` | После сохранения → `ensurePendingInvoiceForTariff(reason='admin_activate')`. В ответе появляется `{ invoice_id, payment_url, yookassa_error }`. |
| `PUT /api/admin/users/[id]/tariff` action='extend' с `billing_mode='autopayment'` | То же, `reason='admin_extend'`. |
| `GET /api/client/payment` | Упрощается до `ensurePendingInvoiceForTariff(reason='client_self')`. Хардкод цен 15k/25k удалён. |
| `GET /api/cron/auto-renew` | Окно меняется с 3 дней на 1 день. Для каждой подписки → `chargeMonthlyRenewal`. Хардкод цен удалён. |
| `POST /api/invoices/webhook` | `payment.canceled` → не меняет invoice.status; пишет короткий русский текст в `client_tariffs.last_payment_error`. `payment.succeeded` — как раньше. |

## БД

Миграция `20260609_0001_client_tariffs_last_payment_error.sql`:

```sql
ALTER TABLE client_tariffs
  ADD COLUMN IF NOT EXISTS last_payment_error TEXT;

COMMENT ON COLUMN client_tariffs.last_payment_error IS
  'Последняя ошибка попытки оплаты клиентом (из webhook payment.canceled), русский текст для UI.';
```

`last_renewal_error` (уже существует) — про cron-списания.
`last_payment_error` (новая) — про клиентские попытки.

## UI клиента (`app/src/app/client/tariff/page.tsx`)

- Кнопка «Отключить автопродление» → **«Отвязать карту»** (текст + иконка
  `Unlink` уже подходит).
- Заголовок модалки «Отключить автопродление?» → «Отвязать карту?». Тело модалки
  уточняется: «Сохранённая карта будет удалена из нашей системы. Автопродление
  выключится. Оплаченный доступ до {дата} сохраняется.»
- В секции `02b → доступ` под кнопкой «Оплатить подписку» — если
  `last_payment_error` есть, мелким красным mono: «Прошлая попытка: {текст}».
- В секции `02c → автопродление` рядом со строкой «карта» — кнопка «Отвязать
  карту» доступна также когда автопродление выключено, но карта ещё привязана.

## Маппер ошибок

`reason` (из YooKassa `cancellation_details.reason`):

| Код | Текст |
|---|---|
| `insufficient_funds` | Недостаточно средств на карте. |
| `expired_card` / `card_expired` | Срок действия карты истёк. |
| `issuer_unavailable` / `call_issuer` | Банк отклонил платёж. Свяжитесь с банком. |
| `3d_secure_failed` | Не прошла проверка 3-D Secure. |
| `payment_method_restricted` / `general_decline` | Платёж отклонён банком. |
| `fraud_suspected` | Платёж заблокирован системой безопасности. |
| `country_forbidden` | Платежи из вашей страны запрещены. |
| `payment_method_limit_exceeded` | Превышен лимит платежей по карте. |
| (всё остальное / null) | Не удалось списать. Попробуйте снова или другой картой. |

Используется в двух местах: webhook (`payment.canceled`) — пишет в
`last_payment_error`; cron auto-renew — пишет в `last_renewal_error`.
Сырой ответ YK для отладки логируется через `logError`, в БД не пишется.

## Тесты

`app/tests/lib/billing.test.ts`:

- `ensurePendingInvoiceForTariff` создаёт invoice + вызывает YK с
  `save_payment_method=true` + `amount=billing_amount` + возвращает URL.
- Повторный вызов возвращает тот же invoice (idempotency).
- При истёкшем `yookassa_payment_url` (моки YK expires_at в прошлом) — создаёт
  новый invoice.
- При `tariff.billing_mode !== 'autopayment'` — отказ с ошибкой.
- `mapYookassaErrorRu` — таблица проверяет каждый код и fallback.
- `chargeMonthlyRenewal` — успешный путь продлевает `paid_until` на 1 месяц
  и пишет `paid` в invoice; путь с YK-ошибкой пишет `last_renewal_error`
  через маппер и оставляет invoice в pending.

`app/tests/api/invoices/webhook.test.ts` (existing, если есть — иначе новый):
- `payment.canceled` не меняет invoice.status, но пишет `last_payment_error`.

## Out of scope

- Унификация всех хардкодов цен в проекте (есть и другие места, типа
  emails / contacts upsell) — только биллинг подписок.
- BG-queue для retry упавших YK-вызовов — пока retry один раз в день через
  cron.
- Отдельный endpoint для админского retry авто-создания invoice — если YK упал
  при activate, админ просто переоткроет форму и сохранит снова (всё
  идемпотентно).
