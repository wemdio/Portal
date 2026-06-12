# YooKassa тестовый магазин для счетов

Дата: 2026-06-12 · ветка: `dmitriy_kuladmed`

## Что меняется

Сейчас все счета и автоплатёжные подписки уходят в один и тот же YooKassa-магазин
(`YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY`). Нужно дать админам возможность
выставлять счёт в **тестовом** магазине — на этапе активации/продления подписки
с режимом «Автоплатёж», и на форме ручного выставления счёта во вкладке «Счета».

Тестовые креды задаются отдельной парой env:

```
YOOKASSA_TEST_SHOP_ID=...
YOOKASSA_TEST_SECRET_KEY=...
```

По умолчанию обе формы остаются на боевом магазине — переключатель надо явно
кликнуть. Тестовые счета визуально маркируются жёлтой плашкой в списке.

## Архитектура

### БД

Миграция `supabase/migrations/20260612_0001_invoices_is_test_shop.sql`:

```sql
ALTER TABLE invoices       ADD COLUMN IF NOT EXISTS is_test_shop BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_tariffs ADD COLUMN IF NOT EXISTS is_test_shop BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN invoices.is_test_shop IS
  'TRUE = счёт создан через YOOKASSA_TEST_SHOP_ID/SECRET. Влияет на бейдж в UI и креды для get/cancel/sync.';
COMMENT ON COLUMN client_tariffs.is_test_shop IS
  'TRUE = подписка завязана на тестовый магазин YK. Сохранённая карта и cron auto-renew используют тестовые креды.';
```

Индексы не нужны — фильтрация по `is_test_shop` нигде не предполагается.

### Слой YooKassa (`app/src/lib/yookassa.ts`)

Текущая реализация читает `YOOKASSA_SHOP_ID/SECRET_KEY` в момент импорта модуля.
Это удобно когда магазин один, но не подходит когда нужно выбирать креды на
каждый вызов.

Рефактор:

1. Удалить модульные константы `shopId`/`secretKey`. Читать env лениво.
2. Добавить `function getYookassaCreds(isTestShop: boolean): { shopId: string; secretKey: string }`:
   - `isTestShop=false` → возвращает `YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY`
   - `isTestShop=true`  → возвращает `YOOKASSA_TEST_SHOP_ID/YOOKASSA_TEST_SECRET_KEY`
   - Любой из них отсутствует → бросает `Error('Тестовый магазин YooKassa не настроен...')`
3. `basicAuth(isTestShop: boolean)` использует `getYookassaCreds`.
4. Все экспортируемые YK-функции получают `isTestShop: boolean` в параметрах
   (последним полем, по умолчанию `false` для обратной совместимости тестов):
   - `createYookassaInvoice(params, isTestShop)`
   - `getYookassaInvoice(ykInvoiceId, isTestShop)`
   - `cancelYookassaInvoice(ykInvoiceId, isTestShop)`
   - `chargeRecurringPayment(params, isTestShop)`
5. `isYookassaConfigured(isTestShop?: boolean)` проверяет соответствующую пару.

Этот рефактор затрагивает все вызовы YK по проекту — после него каждый вызов
обязан явно сказать, в какой магазин он бьёт.

### Слой billing (`app/src/lib/billing.ts`)

`ensurePendingInvoiceForTariff` получает доп. параметр `isTestShop` в
`EnsureInvoiceParams`:

```ts
ensurePendingInvoiceForTariff({ userId, reason, isTestShop })
```

Поведение:
- Передаёт флаг в `createYookassaInvoice` и `isYookassaConfigured`.
- Записывает `is_test_shop=isTestShop` в новую строку `invoices`.
- Записывает `is_test_shop=isTestShop` в `client_tariffs` UPDATE (важно для cron).
- При поиске существующего pending-invoice добавляется условие
  `is_test_shop=isTestShop`. Логика:
  - Если найден pending с тем же флагом и валидный по сроку → reuse как раньше.
  - Если pending существует на ДРУГОМ магазине → старый архивируется
    (`archived_at=NOW(), status='cancelled'`) и отменяется в YK через
    `cancelYookassaInvoice(old.yookassa_payment_id, !isTestShop)`. Создаётся
    новый pending на выбранном магазине.
  - Если pending нет вообще → как сейчас, INSERT новой строки.

`chargeMonthlyRenewal` читает `is_test_shop` из переданного tariff-row и
передаёт в `chargeRecurringPayment` + `isYookassaConfigured`.

### API: `/api/admin/users/[id]/tariff` (PUT)

Тело запроса `TariffBody` получает поле `is_test_shop?: boolean` (default false).

Применяется только в ветках `action='activate'` и `action='extend'`, и только
когда `billing_mode === 'autopayment'`. Передаётся в
`ensurePendingInvoiceForTariff({ ..., isTestShop: body.is_test_shop ?? false })`.

В ответе появляется поле `is_test_shop: boolean` рядом с `billing_mode` —
фронт использует для текста success-сообщения («Тестовый счёт создан…»).

### API: `/api/invoices` (POST)

Тело запроса получает `is_test_shop?: boolean`. Сохраняется в INSERT.
Передаётся в `isYookassaConfigured(isTestShop)` и `createYookassaInvoice(..., isTestShop)`.

### API: `/api/invoices/[id]` (PATCH)

Все YK-вызовы (`create_yookassa_payment`, `sync_yookassa`, `archive` через
`cancelYookassaInvoice`) читают `existing.is_test_shop` и передают флаг.

Тело PATCH не получает новый параметр — флаг определяется по строке.

### Webhook (`/api/invoices/webhook`)

Не меняется. Реализация ищет наш `invoices` row по `yookassa_payment_id`
(UUID — практически уникален между shop'ами), и сам HTTP-handler в YK API не
ходит. Конфигурация webhook URL на тестовом магазине настраивается вручную
через консоль YK на тот же endpoint.

Документируем это явным комментарием в файле webhook'а.

### Cron auto-renew (`/api/cron/auto-renew`)

При выборке `client_tariffs` добавляется `is_test_shop` в SELECT. Передаётся в
`chargeMonthlyRenewal` → `chargeRecurringPayment`. Таким образом подписка,
активированная на тестовом магазине, продлевается через тестовые креды.

## UI

### Модалка редактирования юзера (`app/src/app/admin/users/page.tsx`, SubscriptionPanel)

Новое состояние компонента: `const [useTestShop, setUseTestShop] = useState(false)`.

В двух местах (форма «Активировать» и форма «Продлить подписку») — под рядом
кнопок режима оплаты, **видимый только когда `activateBillingMode === 'autopayment'`**:

```
┌────────────────────────────────────────┐
│ Магазин YooKassa                       │
│ [ Боевой ]  [ 🧪 Тестовый ]            │
└────────────────────────────────────────┘
```

Стилистически — две пилюли в ряд, как и остальные toggles в форме. Цвет
активной кнопки «Боевой» — `bg-gray-900 text-white` (как у режима оплаты).
Активная «🧪 Тестовый» — `bg-yellow-500 text-white` для визуальной связки с
бейджом в таблице счетов.

Поле `is_test_shop: useTestShop` добавляется в body запроса для activate / extend.

Текст success-сообщения (`activateSuccessMessage` / `extendSuccessMessage`)
дополняется: если `is_test_shop` в ответе true → добавить « (тестовый магазин)»
в хвост.

### Вкладка «Счета» → CreateModal (`InvoicesPageView.tsx`)

В форму добавляется новый блок под полем «Назначение платежа»:

```
Магазин YooKassa
[ Боевой ]  [ 🧪 Тестовый ]
```

Состояние: `const [useTestShop, setUseTestShop] = useState(false)`.

В POST `/api/invoices` передаётся `is_test_shop: useTestShop`.

### Вкладка «Счета» → таблица

`Invoice` TS-интерфейс расширяется полем `is_test_shop: boolean`.

В ячейке «Статус» (помимо текущей плашки `STATUS_LABEL`) — рядом, если
`inv.is_test_shop`:

```tsx
<span className="inline-flex items-center gap-0.5 rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700">
  🧪 Тест
</span>
```

Без иконки (просто текст «Тест») — если эмодзи в моноширинной таблице будет
криво, переключим в реализации.

## Тесты

- `app/tests/lib/yookassa.test.ts` — добавить проверку что `getYookassaCreds(true)`
  отдаёт тестовые env, `getYookassaCreds(false)` — боевые, при отсутствии — ошибка.
- `app/tests/lib/billing.test.ts` — `ensurePendingInvoiceForTariff` с `isTestShop=true`
  пишет флаг в обе таблицы и зовёт YK с тестовыми кредами (моки).
- `app/tests/api/invoices/route.test.ts` (если есть) — POST с `is_test_shop=true`
  сохраняет флаг и зовёт YK с тестовыми кредами.

## Out of scope

- Динамическое переключение магазина в середине жизни подписки (только при
  activate/extend). Если админу нужно сменить — деактивировать и активировать
  заново.
- Маркировка тестовых клиентов в списке `/admin/users` — только в `/invoices`.
- Запрет на создание тестовых счетов на production-инстансе (доверяем админам).
- Отдельный webhook URL для тестового магазина — используем общий endpoint,
  лукап по UUID payment_id.

## Caveats для оператора

1. После деплоя — в кабинете тестового магазина YK настроить URL уведомлений
   на тот же `https://.../api/invoices/webhook` что и для боевого.
2. При тестовой оплате карта сохраняется в тестовом магазине. Через 30 дней
   cron попробует списать с неё через тестовые креды — это ожидаемое поведение,
   списание пройдёт (тестовая карта работает только на тестовом магазине).
3. Если планируется «перевести» тестового клиента на боевой магазин — нужно
   деактивировать подписку и активировать заново уже на боевом.
