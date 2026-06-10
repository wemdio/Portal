/**
 * Создаёт invoice через ТЕСТОВЫЙ магазин YooKassa с `save_payment_method=true`,
 * чтобы получить реально работающий payment_method_id в нашей БД и
 * заскриншотить флоу отвязки карты для подключения автоплатежей в проде.
 *
 * Зачем существует:
 *   Боевой магазин (YOOKASSA_SHOP_ID) автоплатежи ещё не подключены,
 *   YK support просит скриншоты UX-отвязки до того как подключит.
 *   Тестовый магазин YK по умолчанию умеет recurring — там можно
 *   привязать тестовую карту, увидеть активную кнопку «Отвязать карту»
 *   в /client/tariff и снять скриншот.
 *
 * Подготовка (один раз):
 *   1. Зарегистрируй ТЕСТОВЫЙ магазин в YooKassa:
 *        https://yookassa.ru/my/merchant/integration/keys
 *        (раздел «Тестовый магазин» — Shop ID и секретный ключ
 *        отдельные от боевых)
 *   2. В кабинете тестового магазина настрой http-уведомления:
 *        URL = https://polza-portal.ru/api/invoices/webhook
 *        События = payment.succeeded, payment.canceled
 *   3. В /app/.env.local (или ../.env) добавь:
 *        YOOKASSA_TEST_SHOP_ID=...
 *        YOOKASSA_TEST_SECRET_KEY=...
 *
 * Запуск:
 *   cd app
 *   node scripts/yookassa-test-invoice.mjs <clientUserId> [amount]
 *
 *   amount по умолчанию 10 (минимум для YK теста).
 *
 *   clientUserId — UUID профиля клиента (узнать через
 *   `node scripts/get-user-id.mjs <email>`).
 *
 * Что делает:
 *   1. Берёт email клиента из profiles для 54-ФЗ чека.
 *   2. Создаёт row в invoices (нашей таблице) со status='pending' и
 *      metadata.source='test-shop-screenshot'.
 *   3. Шлёт POST /v3/invoices в YooKassa **с тестовыми creds** и
 *      `save_payment_method: true`.
 *   4. Записывает yookassa_payment_id + yookassa_payment_url в наш row.
 *   5. Печатает URL.
 *
 * Что делаешь дальше:
 *   1. Открой напечатанный URL.
 *   2. Оплати тестовой картой YK (см. таблицу ниже).
 *   3. YK шлёт webhook → applyInvoicePaidToTariff сохранит
 *      yookassa_payment_method_id в client_tariffs.
 *   4. Зайди на https://polza-portal.ru/client/tariff под этим клиентом
 *      — увидишь активную кнопку «Отвязать карту».
 *   5. Снимай скриншоты для YK support.
 *   6. Нажми «Отвязать карту» — токен удалится из нашей БД,
 *      сделай ещё один скриншот «после».
 *
 * Тестовые карты YooKassa (https://yookassa.ru/developers/using-api/testing):
 *   5555 5555 5555 4444  MasterCard, успешно
 *   4111 1111 1111 1111  Visa, успешно
 *   CVC любой 3-значный, срок — любая будущая дата.
 *
 * Webhook важно:
 *   Тестовый магазин шлёт уведомления на тот же URL что и боевой
 *   (`/api/invoices/webhook`). Наш код различает invoice по `payment_id`,
 *   а не по shop — поэтому test- и prod-инвойсы прозрачно работают вместе.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const YOOKASSA_API = 'https://api.yookassa.ru/v3';

const clientUserId = (process.argv[2] || '').trim();
const amount = Number(process.argv[3] || '10');

if (!clientUserId) {
  console.error('Usage: node scripts/yookassa-test-invoice.mjs <clientUserId> [amount=10]');
  console.error('  clientUserId — UUID profile (см. scripts/get-user-id.mjs)');
  process.exit(1);
}
if (!Number.isFinite(amount) || amount <= 0) {
  console.error(`Amount должен быть положительным числом, получено: ${process.argv[3]}`);
  process.exit(1);
}

const TEST_SHOP_ID = process.env.YOOKASSA_TEST_SHOP_ID;
const TEST_SECRET_KEY = process.env.YOOKASSA_TEST_SECRET_KEY;
if (!TEST_SHOP_ID || !TEST_SECRET_KEY) {
  console.error('В env не заданы YOOKASSA_TEST_SHOP_ID / YOOKASSA_TEST_SECRET_KEY.');
  console.error('Заведи тестовый магазин на https://yookassa.ru и впиши их в .env.local.');
  process.exit(1);
}

const conn = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!conn) {
  console.error('Нет SUPABASE_DB_URL / DATABASE_URL в окружении.');
  process.exit(1);
}

const fallbackEmail = process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL?.trim() || null;

const db = new pg.Client({ connectionString: conn });
await db.connect();

let printedUrl = null;
try {
  // 1. Profile: email для чека, full_name для company_name.
  const profileRes = await db.query(
    `select id, email, full_name from public.profiles where id = $1`,
    [clientUserId],
  );
  if (!profileRes.rows.length) {
    console.error(`Профиль с id ${clientUserId} не найден.`);
    process.exit(2);
  }
  const profile = profileRes.rows[0];
  const customerEmail = (profile.email || '').trim() || fallbackEmail;
  if (!customerEmail) {
    console.error('Нет email клиента и YOOKASSA_FALLBACK_RECEIPT_EMAIL не задан — без email 54-ФЗ чек собрать нельзя.');
    process.exit(3);
  }
  const companyName = (profile.full_name || profile.email || profile.id).trim();

  // 2. Insert invoice row. metadata.source различает скрипт от боевых сценариев.
  const description = 'Подписка на Portal';
  const invoiceId = crypto.randomUUID();
  await db.query(
    `insert into public.invoices
       (id, company_name, client_user_id, amount, currency, description,
        created_by, status, metadata)
     values ($1, $2, $3, $4, 'RUB', $5, null, 'pending', $6::jsonb)`,
    [
      invoiceId,
      companyName,
      clientUserId,
      amount,
      description,
      JSON.stringify({ source: 'test-shop-screenshot', shop: 'test' }),
    ],
  );
  console.log(`[ok] DB invoice row создан: ${invoiceId}`);

  // 3. YK invoice через тестовый shop, save_payment_method=true.
  const auth = 'Basic ' + Buffer.from(`${TEST_SHOP_ID}:${TEST_SECRET_KEY}`).toString('base64');
  // expires_at: now + 30 дней - 15 минут safety buffer (как в lib/yookassa.ts).
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 - 15 * 60 * 1000);
  expiresAt.setUTCSeconds(0, 0);

  const body = {
    payment_data: {
      amount: { value: amount.toFixed(2), currency: 'RUB' },
      capture: true,
      description,
      save_payment_method: true,
      receipt: {
        customer: { email: customerEmail },
        items: [
          {
            description,
            quantity: '1.000',
            amount: { value: amount.toFixed(2), currency: 'RUB' },
            vat_code: 1,
            payment_mode: 'full_payment',
            payment_subject: 'service',
          },
        ],
      },
      metadata: { invoice_id: invoiceId, company_name: companyName, source: 'test-shop-screenshot' },
    },
    cart: [
      {
        description,
        quantity: 1.0,
        price: { value: amount.toFixed(2), currency: 'RUB' },
      },
    ],
    delivery_method_data: { type: 'self' },
    locale: 'ru_RU',
    expires_at: expiresAt.toISOString(),
    description,
    metadata: { invoice_id: invoiceId, company_name: companyName, source: 'test-shop-screenshot' },
  };

  const res = await fetch(`${YOOKASSA_API}/invoices`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'Idempotence-Key': invoiceId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`YK API error ${res.status}: ${errBody}`);
    // Помечаем нашу строку как cancelled чтобы не висела как pending.
    await db.query(
      `update public.invoices set status='cancelled', updated_at=now() where id=$1`,
      [invoiceId],
    );
    process.exit(4);
  }

  const ykInvoice = await res.json();
  const ykUrl = ykInvoice.url ?? ykInvoice.delivery_method?.url ?? null;
  if (!ykUrl) {
    console.error('YK invoice создан, но в ответе нет url:');
    console.error(JSON.stringify(ykInvoice, null, 2));
    process.exit(5);
  }

  // 4. Save yk fields в нашу row.
  await db.query(
    `update public.invoices
        set yookassa_payment_id=$1, yookassa_payment_url=$2, updated_at=now()
      where id=$3`,
    [ykInvoice.id, ykUrl, invoiceId],
  );
  printedUrl = ykUrl;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Тестовый счёт YooKassa создан');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Сумма:     ${amount} ₽ (тестовая)`);
  console.log(`  Клиент:    ${profile.email} (${clientUserId})`);
  console.log(`  Invoice:   ${invoiceId}`);
  console.log(`  YK Inv ID: ${ykInvoice.id}`);
  console.log('');
  console.log('  Открой URL и оплати тестовой картой YooKassa:');
  console.log(`    ${ykUrl}`);
  console.log('');
  console.log('  Тестовые карты (CVC любой 3 цифры, срок — будущая дата):');
  console.log('    5555 5555 5555 4444  MasterCard');
  console.log('    4111 1111 1111 1111  Visa');
  console.log('');
  console.log('  После оплаты:');
  console.log(`    1. Зайди в ЛК клиента: https://polza-portal.ru/client/tariff`);
  console.log(`    2. Увидишь раздел «02c → автопродление» с активной`);
  console.log(`       кнопкой «Отвязать карту» — снимай скриншот для YK support.`);
  console.log(`    3. Нажми «Отвязать карту» — токен удалится из БД,`);
  console.log(`       снимай ещё один скриншот «после».`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
} finally {
  await db.end();
}
