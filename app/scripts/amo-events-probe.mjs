/**
 * Разовая проба: за какой период AMO CRM отдаёт события смены этапа сделки
 * (`GET /api/v4/events`, filter[type][]=lead_status_changed).
 *
 * Не продакшн-код, не часть синка — просто диагностика перед тем, как писать
 * app/scripts/amo-events-probe.mjs → sources/amo_events.py (см. спеку
 * docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md, §"Спайк до кода").
 *
 * Запуск из app/:
 *   node scripts/amo-events-probe.mjs
 *
 * ВАЖНО: кредов AMO в локальных .env нет — они живут только на проде 139.
 * Фактически проба 2026-07-30 была прогнана внутри контейнера, где env уже есть:
 *   docker exec -i portal-external-sync python - <<'PY'   (см. спеку, §"Открытые вопросы")
 * Этот файл оставлен для повторной проверки с любой машины, где креды доступны.
 *
 * Результат прогона 2026-07-30: события lead_status_changed есть с января 2024,
 * то есть за всю жизнь аккаунта. Id статуса лежит в value_before[0].lead_status.id
 * и value_after[0].lead_status.id.
 *
 * Только чтение (GET). Ничего не создаёт и не меняет в AMO.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env в корне репозитория (../../.env от app/scripts) — тот же файл, что грузит
// services/portal-external-sync/main.py для AmoSync. app/.env.local — оверлей, если есть.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const TOKEN = (process.env.AMO_ACCESS_TOKEN || process.env.AMOCRM_TOKEN || '').trim();
const BASE = (process.env.AMO_BASE_URL || '').trim().replace(/\/$/, '');

if (!TOKEN || !BASE) {
  const missing = [];
  if (!TOKEN) missing.push('AMO_ACCESS_TOKEN (или AMOCRM_TOKEN)');
  if (!BASE) missing.push('AMO_BASE_URL');
  console.error(`BLOCKED: не найдены переменные окружения: ${missing.join(', ')}.`);
  console.error('Ожидались в .env корня репозитория (тот же файл грузит services/portal-external-sync/main.py).');
  process.exit(1);
}

const base = BASE.startsWith('http') ? BASE : `https://${BASE}`;
const headers = { Authorization: `Bearer ${TOKEN}` };

async function get(url) {
  const res = await fetch(url, { headers });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// 1. Есть ли вообще эндпоинт и какие типы событий приходят.
const probe = await get(`${base}/api/v4/events?limit=1`);
console.log('эндпоинт отвечает:', probe ? 'да' : 'пусто (204)');

// 2. Самое старое событие смены этапа: сортировка по возрастанию не поддержана
//    в /api/v4/events, поэтому идём "точками" по фильтру created_at[from..to]
//    с шагом ~месяц, отступая на 0/1/2/3 года назад от текущего момента.
const YEAR = 365 * 24 * 3600;
const MONTH = 30 * 24 * 3600;
const now = Math.floor(Date.now() / 1000);

async function hasEventsSince(fromUnix, toUnix) {
  const url =
    `${base}/api/v4/events?limit=1` +
    `&filter[type][]=lead_status_changed` +
    `&filter[created_at][from]=${fromUnix}` +
    `&filter[created_at][to]=${toUnix}`;
  const data = await get(url);
  return Boolean(data?._embedded?.events?.length);
}

console.log('\nпроверка глубины истории (окно ~месяц, каждый год назад):');
for (const yearsBack of [0, 1, 2, 3]) {
  const from = now - Math.round(yearsBack * YEAR) - MONTH;
  const to = from + MONTH;
  const iso = new Date(from * 1000).toISOString().slice(0, 10);
  let ok = false;
  try {
    ok = await hasEventsSince(from, to);
  } catch (e) {
    console.log(`  ${iso}: ОШИБКА ${e.message}`);
    continue;
  }
  console.log(`  ${iso}: ${ok ? 'события есть' : 'событий нет'}`);
}

// 3. Форма одного события — что именно писать в amo_events.
const sample = await get(
  `${base}/api/v4/events?limit=1&filter[type][]=lead_status_changed`,
);
const ev = sample?._embedded?.events?.[0];
console.log('\nобразец события lead_status_changed:');
console.log(ev ? JSON.stringify(ev, null, 2) : '(нет ни одного события этого типа)');

// 4. На случай если имя типа события в этом амо другое — список всех типов
//    из первой страницы без фильтра по типу, чтобы не гадать вслепую.
const anyPage = await get(`${base}/api/v4/events?limit=50`);
const types = [...new Set((anyPage?._embedded?.events || []).map((e) => e.type))];
console.log('\nтипы событий, встреченные в последних 50 событиях аккаунта:');
console.log(types.length ? types.join(', ') : '(пусто)');
