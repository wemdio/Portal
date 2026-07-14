import 'server-only';
import { datasetQuery } from '@/lib/instantlyDataset';

/**
 * Нагрузка на почтовые ящики (mailbox load) по тегам и специалистам.
 *
 * Идея (запрос руководства): быстро видеть, полностью ли выбран дневной потолок
 * отправок по ящикам клиента. Потолок = Σ effective daily_limit активных ящиков
 * под тегом; факт = число отправленных писем за день. utilization = факт / потолок.
 * Низкая утилизация = ресурс простаивает (не хватает запусков/контактов или
 * ящики на паузе); 100% = выжали всё.
 *
 * Источник — аналитический датасет instantly_dataset (ночной синк), НЕ live API.
 * Поэтому «день» — это последний ПОЛНЫЙ день в датасете (датасет всегда отстаёт
 * на ночной синк, так что max(день отправок) = последний завершённый день).
 *
 * Данные:
 *  - потолок:  coalesce(raw_accounts.daily_limit, 30) по активным (status=1).
 *              NULL = лимит явно не выставляли, ящик работает на дефолте
 *              воркспейса; замер по факту (2 недели, 73 ящика: max=p95=median=30)
 *              подтверждает дефолт = 30.
 *  - тег→ящик: raw_custom_tag_mappings (resource_type='1', resource_id = email).
 *              Маппинги дедупим (бывают точные дубли строк).
 *  - факт:     raw_emails (ue_type=1) за день, bucket по UTC. Считается по ВСЕМ
 *              ящикам тега независимо от текущего status — факт есть факт
 *              (ящик мог слать утром и встать на паузу вечером).
 *  - специалист: raw_campaigns.email_tag_list → portal_project_campaigns →
 *              portal_projects.specialist (доминирующий по числу кампаний тега)
 *  - пул:      тег «неименные почты» — резерв ящиков; при взятии клиента в
 *              работу ящику ставят ВТОРОЙ (клиентский) тег. Поэтому пул-тег
 *              не показываем строкой клиента (дублировал бы клиентские цифры),
 *              а считаем по нему свободный резерв (ящики без второго тега).
 *
 * Даты возвращаются строками 'YYYY-MM-DD' — чтобы pg/JS не сдвинул день по tz.
 */

// пороги утилизации (доля факт/потолок)
const LOW = 0.4; // ниже — недогруз
const FULL = 0.9; // выше — фактически потолок
const OVER = 1.05; // выше — перебор (подняли лимиты / всплеск)
// синк считается устаревшим, если последний успешный старше стольких часов
const STALE_SYNC_HOURS = 30;
// дефолт воркспейса Instantly для ящиков без явного daily_limit (API тогда
// вообще не отдаёт блок настроек отправки). Значение подтверждено замером.
const DEFAULT_DAILY_LIMIT = 30;
// теги-пулы: резерв ящиков, не клиенты. Исключаются из клиентской таблицы.
const POOL_TAG_NAMES = ['неименные почты'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// формат + календарная валидность ('2026-02-31' проходит регексп, но ::date
// в Postgres кидает out of range → ложный 500 build_failed в мониторинге)
function isCalendarDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type TagStatus = 'no_capacity' | 'stopped' | 'idle' | 'low' | 'ok' | 'full' | 'over';

export type TagLoad = {
  tagId: string;
  tag: string;
  activeMailboxes: number;
  totalMailboxes: number;
  capacity: number; // Σ effective daily_limit по активным ящикам
  sent: number; // отправлено за день (все ящики тега)
  utilization: number | null; // sent/capacity; null если потолок 0
  status: TagStatus;
  specialist: string | null; // доминирующий специалист
  client: string | null; // доминирующий клиент
  otherSpecialists: string[]; // прочие специалисты тега (для подсказки)
  projectCount: number;
};

export type SpecialistLoad = {
  specialist: string; // '__unassigned__' → «Не привязано»
  tagCount: number;
  activeMailboxes: number;
  capacity: number;
  sent: number;
  utilization: number | null;
  status: TagStatus;
  clients: string[];
  tags: string[];
};

export type PoolInfo = {
  tagId: string;
  tag: string;
  totalMailboxes: number;
  takenMailboxes: number; // есть второй (клиентский) тег
  freeMailboxes: number; // активные, без второго тега — доступный резерв
  freeCapacity: number; // Σ effective daily_limit свободных активных
};

export type MailboxRow = {
  email: string;
  statusValue: number | null;
  status: string | null; // label_ru
  dailyLimit: number; // effective (NULL → дефолт 30)
  isDefaultLimit: boolean; // лимит не выставлен явно, действует дефолт
  sent: number;
  lastUsed: string | null; // 'YYYY-MM-DD' последней отправки (в пределах 30 дн)
};

export type MailboxLoad = {
  asOfDay: string; // 'YYYY-MM-DD' — за какой день данные
  latestDay: string | null; // последний полный день в датасете (для date-picker max)
  lastSync: string | null; // ISO последнего успешного синка
  syncAgeHours: number | null;
  stale: boolean; // синк устарел (> STALE_SYNC_HOURS)
  generatedAt: string;
  tags: TagLoad[];
  pool: PoolInfo[];
  specialists: SpecialistLoad[];
  totals: { activeMailboxes: number; capacity: number; sent: number; utilization: number | null };
  notes: string[];
};

const UNASSIGNED = '__unassigned__';

function classify(capacity: number, sent: number): TagStatus {
  // потолка нет: различаем «ничего не происходит» и «слал, но сейчас все
  // ящики выключены» (status — снимок текущего момента, отправки — история дня)
  if (capacity <= 0) return sent > 0 ? 'stopped' : 'no_capacity';
  const u = sent / capacity;
  if (u <= 0) return 'idle';
  if (u < LOW) return 'low';
  if (u < FULL) return 'ok';
  if (u <= OVER) return 'full';
  return 'over';
}

const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));

type FreshRow = { as_of: string | null; last_sync: string | null; sync_age_hours: string | null };
type TagRow = {
  tag_id: string; tag: string;
  active_mailboxes: string; total_mailboxes: string; capacity: string; sent: string;
};
type SpecRow = { tag_id: string; specialist: string | null; client: string | null; campaigns: string };
type TotalsRow = { active_mailboxes: string; capacity: string; sent: string };
type PoolRow = {
  tag_id: string; tag: string;
  total_mailboxes: string; taken_mailboxes: string; free_mailboxes: string; free_capacity: string;
};

/**
 * Определяет последний полный день в датасете (по отправкам, UTC) и свежесть синка.
 * Если day передан явно — использует его, но всё равно тянет свежесть и latestDay.
 */
export async function resolveAsOf(day?: string): Promise<{ asOfDay: string; latestDay: string | null; lastSync: string | null; syncAgeHours: number | null; stale: boolean }> {
  // as_of = последний ПОЛНЫЙ день по отправкам. `< current_date` (UTC) исключает
  // сегодняшний день: он либо ещё не наступил в данных, либо частично залит идущим
  // прямо сейчас ночным синком (иначе дефолт мог бы показать неполный день = ложный недогруз).
  const rows = await datasetQuery<FreshRow>(
    `SELECT
       (SELECT to_char(max(timestamp_email)::date, 'YYYY-MM-DD')
          FROM raw_emails
          WHERE ue_type = 1 AND timestamp_email >= now() - interval '14 days'
            AND timestamp_email < current_date) AS as_of,
       (SELECT to_char(max(finished_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          FROM dataset_snapshots WHERE ok) AS last_sync,
       (SELECT round((extract(epoch FROM (now() - max(finished_at))) / 3600)::numeric, 1)::text
          FROM dataset_snapshots WHERE ok) AS sync_age_hours`,
  );
  const r = rows[0] ?? { as_of: null, last_sync: null, sync_age_hours: null };
  // Явный день принимаем только если он не позже последнего ПОЛНОГО дня:
  // будущий/ещё-не-долитый день дал бы sent=0 по всем тегам = ложный «все в
  // простое» (max на дата-пикере — advisory, руками ввести можно; API — тем более).
  // ISO-строки сравниваются лексикографически корректно.
  const requested = day && isCalendarDay(day) ? day : null;
  const asOfDay = (requested && r.as_of && requested <= r.as_of) ? requested : (r.as_of ?? '');
  const syncAgeHours = r.sync_age_hours == null ? null : Number(r.sync_age_hours);
  const stale = syncAgeHours == null ? true : syncAgeHours > STALE_SYNC_HOURS;
  return { asOfDay, latestDay: r.as_of, lastSync: r.last_sync, syncAgeHours, stale };
}

/**
 * Собирает всю картину нагрузки за день (по умолчанию — последний полный день).
 */
export async function buildMailboxLoad(day?: string): Promise<MailboxLoad> {
  const { asOfDay, latestDay, lastSync, syncAgeHours, stale } = await resolveAsOf(day);
  const generatedAt = new Date().toISOString();

  if (!asOfDay) {
    return {
      asOfDay: '', latestDay, lastSync, syncAgeHours, stale, generatedAt,
      tags: [], pool: [], specialists: [],
      totals: { activeMailboxes: 0, capacity: 0, sent: 0, utilization: null },
      notes: ['Нет данных об отправках за последние 14 дней в датасете.'],
    };
  }

  // 1) нагрузка по тегам за день. Потолок — по активным ящикам (status=1):
  //    ящик на паузе имеет daily_limit, но не шлёт → в знаменатель не берём.
  //    Отправки — по всем ящикам тега (факт есть факт). Маппинги дедупим.
  const [tagRows, specRows, totalsRows, poolRows, hiddenRows] = await Promise.all([
    datasetQuery<TagRow>(
      // hidden теги (клиент ведётся в Coldy/Trigga, в Instantly только прогрев)
      // исключаем — иначе вечный ложный «Простой». Список — mailbox_load_hidden_tags.
      `WITH mappings AS (
         SELECT DISTINCT tag_id, resource_id
         FROM raw_custom_tag_mappings
         WHERE resource_type = '1'
           AND tag_id NOT IN (SELECT tag_id FROM mailbox_load_hidden_tags)
       ),
       vol AS (
         SELECT eaccount, count(*) AS sent
         FROM raw_emails
         WHERE ue_type = 1 AND timestamp_email >= $1::date AND timestamp_email < ($1::date + 1)
         GROUP BY eaccount
       )
       SELECT ct.id AS tag_id, ct.name AS tag,
              count(*) FILTER (WHERE a.status = 1) AS active_mailboxes,
              count(*) AS total_mailboxes,
              coalesce(sum(coalesce(a.daily_limit, $2::int)) FILTER (WHERE a.status = 1), 0) AS capacity,
              coalesce(sum(v.sent), 0) AS sent
       FROM mappings m
       JOIN raw_custom_tags ct ON ct.id = m.tag_id
       JOIN raw_accounts a ON a.email = m.resource_id AND a.deleted_at IS NULL
       LEFT JOIN vol v ON v.eaccount = a.email
       GROUP BY ct.id, ct.name`,
      [asOfDay, DEFAULT_DAILY_LIMIT],
    ),
    // 2) тег → специалист/клиент (best-effort, через кампании тега).
    datasetQuery<SpecRow>(
      `SELECT ct.id AS tag_id, p.specialist, p.client, count(DISTINCT c.id) AS campaigns
       FROM raw_custom_tags ct
       JOIN raw_campaigns c ON c.email_tag_list @> ARRAY[ct.id]
       JOIN portal_project_campaigns ppc ON ppc.campaign_id = c.id
       JOIN portal_projects p ON p.id = ppc.project_id
       WHERE ct.id IN (SELECT DISTINCT tag_id FROM raw_custom_tag_mappings WHERE resource_type = '1')
         AND p.specialist IS NOT NULL AND btrim(p.specialist) <> ''
       GROUP BY ct.id, p.specialist, p.client`,
    ),
    // 3) итог по ВСЕМ тегированным ящикам (distinct — без двойного счёта тех,
    //    кто под 2+ тегами). sent без фильтра по статусу — как и в строках.
    datasetQuery<TotalsRow>(
      `WITH vol AS (
         SELECT eaccount, count(*) AS sent
         FROM raw_emails
         WHERE ue_type = 1 AND timestamp_email >= $1::date AND timestamp_email < ($1::date + 1)
         GROUP BY eaccount
       ),
       tagged AS (
         SELECT DISTINCT a.email, a.status, a.daily_limit
         FROM raw_custom_tag_mappings m
         JOIN raw_accounts a ON a.email = m.resource_id AND a.deleted_at IS NULL
         WHERE m.resource_type = '1'
           AND m.tag_id NOT IN (SELECT tag_id FROM mailbox_load_hidden_tags)
       )
       SELECT count(*) FILTER (WHERE t.status = 1) AS active_mailboxes,
              coalesce(sum(coalesce(t.daily_limit, $2::int)) FILTER (WHERE t.status = 1), 0) AS capacity,
              coalesce(sum(v.sent), 0) AS sent
       FROM tagged t
       LEFT JOIN vol v ON v.eaccount = t.email`,
      [asOfDay, DEFAULT_DAILY_LIMIT],
    ),
    // 4) пул(ы): свободный резерв = активные ящики пула без второго тега.
    datasetQuery<PoolRow>(
      `WITH mappings AS (
         SELECT DISTINCT tag_id, resource_id
         FROM raw_custom_tag_mappings
         WHERE resource_type = '1'
       ),
       pool_tags AS (SELECT id, name FROM raw_custom_tags WHERE name = ANY($1)),
       taken AS (
         SELECT DISTINCT m.resource_id
         FROM mappings m
         WHERE m.tag_id NOT IN (SELECT id FROM pool_tags)
       )
       SELECT pt.id AS tag_id, pt.name AS tag,
              count(*) AS total_mailboxes,
              count(*) FILTER (WHERE tk.resource_id IS NOT NULL) AS taken_mailboxes,
              count(*) FILTER (WHERE tk.resource_id IS NULL AND a.status = 1) AS free_mailboxes,
              coalesce(sum(coalesce(a.daily_limit, $2::int)) FILTER (WHERE tk.resource_id IS NULL AND a.status = 1), 0) AS free_capacity
       FROM pool_tags pt
       JOIN mappings m ON m.tag_id = pt.id
       JOIN raw_accounts a ON a.email = m.resource_id AND a.deleted_at IS NULL
       LEFT JOIN taken tk ON tk.resource_id = m.resource_id
       GROUP BY pt.id, pt.name`,
      [POOL_TAG_NAMES, DEFAULT_DAILY_LIMIT],
    ),
    // 5) счётчик скрытых тегов — для пояснения в notes.
    datasetQuery<{ n: string }>(`SELECT count(*) AS n FROM mailbox_load_hidden_tags`),
  ]);
  const hiddenCount = num(hiddenRows[0]?.n);

  // тег → ранжированный список (специалист, клиент, #кампаний)
  const specByTag = new Map<string, { specialist: string; client: string | null; campaigns: number }[]>();
  for (const s of specRows) {
    if (!s.specialist) continue;
    const arr = specByTag.get(s.tag_id) ?? [];
    arr.push({ specialist: s.specialist, client: s.client, campaigns: num(s.campaigns) });
    specByTag.set(s.tag_id, arr);
  }
  for (const arr of specByTag.values()) arr.sort((a, b) => b.campaigns - a.campaigns);

  const poolTagIds = new Set(poolRows.map((p) => p.tag_id));

  const tags: TagLoad[] = tagRows
    // пул-теги — не клиенты: их ящики уже посчитаны под клиентскими тегами,
    // строка пула дублировала бы цифры. Резерв пула — отдельным блоком.
    .filter((r) => !poolTagIds.has(r.tag_id))
    .map((r) => {
      const capacity = num(r.capacity);
      const sent = num(r.sent);
      const ranked = specByTag.get(r.tag_id) ?? [];
      const primary = ranked[0] ?? null;
      const others = [...new Set(ranked.slice(1).map((x) => x.specialist))];
      return {
        tagId: r.tag_id,
        tag: r.tag ?? '',
        activeMailboxes: num(r.active_mailboxes),
        totalMailboxes: num(r.total_mailboxes),
        capacity,
        sent,
        utilization: capacity > 0 ? sent / capacity : null,
        status: classify(capacity, sent),
        specialist: primary?.specialist ?? null,
        client: primary?.client ?? null,
        otherSpecialists: others,
        projectCount: new Set(ranked.map((x) => x.client)).size,
      };
    })
    // порядок: сначала теги с потолком по убыванию потолка (это рабочие клиенты),
    // затем «stopped» (слали, но выключены), затем пустые.
    .sort((a, b) => {
      if ((a.capacity > 0) !== (b.capacity > 0)) return a.capacity > 0 ? -1 : 1;
      if (a.capacity > 0) return b.capacity - a.capacity;
      return b.sent - a.sent;
    });

  const pool: PoolInfo[] = poolRows.map((p) => ({
    tagId: p.tag_id,
    tag: p.tag ?? '',
    totalMailboxes: num(p.total_mailboxes),
    takenMailboxes: num(p.taken_mailboxes),
    freeMailboxes: num(p.free_mailboxes),
    freeCapacity: num(p.free_capacity),
  }));

  // свод по специалистам (специалист = Σ его тегов; теги могут пересекаться по ящикам — редко)
  const bySpec = new Map<string, Omit<SpecialistLoad, 'status'>>();
  for (const t of tags) {
    const key = t.specialist ?? UNASSIGNED;
    const agg = bySpec.get(key) ?? {
      specialist: key, tagCount: 0, activeMailboxes: 0, capacity: 0, sent: 0, utilization: null, clients: [], tags: [],
    };
    agg.tagCount += 1;
    agg.activeMailboxes += t.activeMailboxes;
    agg.capacity += t.capacity;
    agg.sent += t.sent;
    agg.tags.push(t.tag);
    if (t.client) agg.clients.push(t.client);
    bySpec.set(key, agg);
  }
  const specialists: SpecialistLoad[] = [...bySpec.values()]
    .map((s) => ({
      ...s,
      clients: [...new Set(s.clients)],
      utilization: s.capacity > 0 ? s.sent / s.capacity : null,
      status: classify(s.capacity, s.sent),
    }))
    .sort((a, b) => {
      // «Не привязано» всегда в конец
      if ((a.specialist === UNASSIGNED) !== (b.specialist === UNASSIGNED)) return a.specialist === UNASSIGNED ? 1 : -1;
      return b.capacity - a.capacity;
    });

  const tt = totalsRows[0] ?? { active_mailboxes: '0', capacity: '0', sent: '0' };
  const totalCapacity = num(tt.capacity);
  const totalSent = num(tt.sent);

  const notes: string[] = [];
  notes.push('Потолок — по активным ящикам (status=Активен); ящикам без явного лимита подставлен дефолт воркспейса 30/день.');
  notes.push('«Отправлено» — по всем ящикам тега, включая выключенные сейчас (статус — снимок момента, отправки — история дня).');
  notes.push('Итог считает каждый ящик один раз; суммы строк могут быть выше (ящик под 2+ тегами попадает в каждый тег).');
  notes.push('«День» — по UTC (последний полный день в датасете). Датасет обновляется ночным синком, данные не реалтайм.');
  if (hiddenCount > 0) {
    notes.push(`Скрыто тегов: ${hiddenCount} — клиенты ведутся в Coldy/Trigga, в Instantly их ящики только на прогреве (отправок нет).`);
  }
  if (tags.some((t) => t.capacity > 0 && !t.specialist)) {
    notes.push('Часть тегов без привязки к специалисту (операционные пулы или новые теги) — они в группе «Не привязано».');
  }
  if (stale) {
    notes.push(`⚠️ Последний синк датасета старше ${STALE_SYNC_HOURS}ч — данные могут быть неактуальны (проверить ночной синк).`);
  }

  return {
    asOfDay, latestDay, lastSync, syncAgeHours, stale, generatedAt,
    tags, pool, specialists,
    totals: {
      activeMailboxes: num(tt.active_mailboxes),
      capacity: totalCapacity,
      sent: totalSent,
      utilization: totalCapacity > 0 ? totalSent / totalCapacity : null,
    },
    notes,
  };
}

type DrillRow = {
  email: string; status_value: number | null; status: string | null;
  daily_limit: string; is_default_limit: boolean; sent: string; last_used: string | null;
};

/**
 * Drill-down: ящики одного тега за день (потолок, отправлено, статус, последняя активность).
 */
export async function getTagMailboxes(tagId: string, day?: string): Promise<{ asOfDay: string; tag: string | null; mailboxes: MailboxRow[] }> {
  // resolveAsOf валидирует и клампит день (будущий/невалидный → последний полный).
  // Запрос свежести ~1мс — дешевле, чем дыра «drill за будущий день = все нули»
  // при прямом вызове API мимо дашборда.
  const { asOfDay } = await resolveAsOf(day);
  if (!asOfDay || !tagId) return { asOfDay: asOfDay ?? '', tag: null, mailboxes: [] };

  const [nameRows, rows] = await Promise.all([
    datasetQuery<{ name: string }>(`SELECT name FROM raw_custom_tags WHERE id = $1`, [tagId]),
    datasetQuery<DrillRow>(
      // last_send: top-1 per mailbox через индекс (eaccount, timestamp_email)
      // backward-scan — НЕ агрегатный скан 30-дневного окна (тот на больших
      // тегах выходил за statement_timeout=15s; этот ~0.5с на худшем теге).
      // Окно в 30 дней — нижняя граница, чтобы не ходить в глубь истории
      // по молчащим ящикам.
      `WITH boxes AS (
         SELECT DISTINCT resource_id AS email
         FROM raw_custom_tag_mappings
         WHERE resource_type = '1' AND tag_id = $2
       ),
       vol AS (
         SELECT eaccount, count(*) AS sent
         FROM raw_emails
         WHERE ue_type = 1 AND timestamp_email >= $1::date AND timestamp_email < ($1::date + 1)
           AND eaccount IN (SELECT email FROM boxes)
         GROUP BY eaccount
       )
       SELECT a.email,
              a.status AS status_value,
              ls.label_ru AS status,
              coalesce(a.daily_limit, $3::int) AS daily_limit,
              (a.daily_limit IS NULL) AS is_default_limit,
              coalesce(v.sent, 0) AS sent,
              to_char(last_send.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_used
       FROM boxes b
       JOIN raw_accounts a ON a.email = b.email AND a.deleted_at IS NULL
       LEFT JOIN vol v ON v.eaccount = a.email
       LEFT JOIN LATERAL (
         SELECT e.timestamp_email AS ts
         FROM raw_emails e
         WHERE e.eaccount = a.email AND e.ue_type = 1
           AND e.timestamp_email >= ($1::date - 30) AND e.timestamp_email < ($1::date + 1)
         ORDER BY e.timestamp_email DESC
         LIMIT 1
       ) last_send ON true
       LEFT JOIN lookup_account_status ls ON ls.value = a.status
       ORDER BY a.status = 1 DESC, sent DESC, daily_limit DESC`,
      [asOfDay, tagId, DEFAULT_DAILY_LIMIT],
    ),
  ]);

  return {
    asOfDay,
    tag: nameRows[0]?.name ?? null,
    mailboxes: rows.map((r) => ({
      email: r.email,
      statusValue: r.status_value == null ? null : Number(r.status_value),
      status: r.status,
      dailyLimit: num(r.daily_limit),
      isDefaultLimit: Boolean(r.is_default_limit),
      sent: num(r.sent),
      lastUsed: r.last_used,
    })),
  };
}
