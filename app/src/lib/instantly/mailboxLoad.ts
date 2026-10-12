import 'server-only';
import { datasetQuery } from '@/lib/instantlyDataset';
import { isReservedMailboxPoolTag } from '@/lib/instantly/mailboxTags';
import {
  DEFAULT_DAILY_LIMIT, RECENT_WINDOW_DAYS,
  assembleMailboxLoad, isCalendarDay, num, pickDefaultDay, sendingWeekdays, weekdayOf,
  type BoxRow, type CampaignRefRow, type CampaignVolumeRow, type DaySendRow, type MailboxLoad,
  type MailboxRow, type ProjectLinkRow, type ProjectRow, type ScheduleVotes,
} from '@/lib/instantly/mailboxLoadModel';

export type {
  InactiveReason, InactiveTag, MailboxLoad, MailboxRow, OwnerSource, SpecialistLoad, TagLoad, TagStatus,
} from '@/lib/instantly/mailboxLoadModel';

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
 * Поэтому «день» по умолчанию — последний ПОЛНЫЙ день в датасете, в который
 * кампании шлют по расписанию (выходные пропускаются, см. mailboxLoadModel.ts).
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
 *  - клиент:   по СВОИМ кампаниям тега (ссылаются на тег или на его ящики в
 *              email_list): кто слал с его ящиков в этот день (raw_emails), иначе
 *              за неделю (v_campaign_daily_canonical), иначе активные, иначе
 *              последняя прежняя. Проект — portal_project_campaigns ∪
 *              portal_period_campaigns → portal_projects.
 *  - в работе: свои кампании слали за RECENT_WINDOW_DAYS дней или проект тега
 *              не завершён; остальные теги — блок «Не в работе».
 *  - пул:      теги «неименные …» — резерв ящиков; при взятии клиента в
 *              работу ящику ставят ВТОРОЙ (клиентский) тег. Поэтому пул-тег
 *              не показываем строкой клиента (дублировал бы клиентские цифры).
 *
 * Даты возвращаются строками 'YYYY-MM-DD' — чтобы pg/JS не сдвинул день по tz.
 */

// синк считается устаревшим, если последний успешный старше стольких часов
const STALE_SYNC_HOURS = 30;

type FreshRow = {
  last_send_day: string | null; last_synced_day: string | null;
  last_sync: string | null; sync_age_hours: string | null;
};

export type ResolvedDay = {
  asOfDay: string;
  latestDay: string | null;
  isSendingDay: boolean;
  skippedDays: string[];
  lastSync: string | null;
  syncAgeHours: number | null;
  stale: boolean;
};

/**
 * Определяет день страницы и свежесть синка.
 *
 * Без явного дня — последний полный день, в который шлёт большинство активных
 * кампаний (по их расписаниям). Явный день принимается, если он не позже
 * последнего полного: будущий или ещё не долитый день дал бы нули по всем
 * тегам = ложный «все в простое».
 */
export async function resolveAsOf(day?: string): Promise<ResolvedDay> {
  const [freshRows, voteRows] = await Promise.all([
    datasetQuery<FreshRow>(
      // last_send_day — есть ли вообще данные за 14 дней (иначе страница пуста).
      // last_synced_day — последний ПОЛНЫЙ день по календарю синка: день D
      // полон, если успешный синк, забиравший письма (counts.new_emails;
      // прогоны --leads-only и analytics-only письма не тянут), стартовал не
      // раньше 20:00 UTC этого дня (ночной стартует в 21:00; дневные ручные
      // прогоны день не закрывают), и не позже вчера. По календарю, а не по последнему дню с письмами:
      // будний день, в который рассылка встала целиком, обязан стать днём по
      // умолчанию и показаться пустым, а не исчезнуть.
      `SELECT
         (SELECT to_char(max(timestamp_email)::date, 'YYYY-MM-DD')
            FROM raw_emails
            WHERE ue_type = 1 AND timestamp_email >= now() - interval '14 days'
              AND timestamp_email < current_date) AS last_send_day,
         (SELECT CASE WHEN max(started_at) IS NOT NULL THEN to_char(least(current_date - 1,
                   (max(started_at AT TIME ZONE 'UTC') - interval '20 hours')::date), 'YYYY-MM-DD') END
            FROM dataset_snapshots WHERE ok AND counts ? 'new_emails') AS last_synced_day,
         (SELECT to_char(max(finished_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM dataset_snapshots WHERE ok) AS last_sync,
         (SELECT round((extract(epoch FROM (now() - max(finished_at))) / 3600)::numeric, 1)::text
            FROM dataset_snapshots WHERE ok) AS sync_age_hours`,
    ),
    // Голоса расписаний: сколько активных кампаний шлёт в каждый день недели.
    // Ключи days — '0'…'6', 0 = воскресенье (как getUTCDay). jsonpath, а не
    // jsonb_array_elements/jsonb_each: у тех оценка в миллионы строк, и
    // Postgres полсекунды JIT-компилировал запрос, работающий 5 мс, — на каждой
    // загрузке и каждом раскрытии тега (замер 12.10). Кривой JSON lax-режим
    // пропускает молча.
    datasetQuery<ScheduleVotes>(
      `SELECT count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days.*') AS scheduled,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."0" ? (@ == true)') AS d0,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."1" ? (@ == true)') AS d1,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."2" ? (@ == true)') AS d2,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."3" ? (@ == true)') AS d3,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."4" ? (@ == true)') AS d4,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."5" ? (@ == true)') AS d5,
              count(*) FILTER (WHERE campaign_schedule @? '$.schedules[*].days."6" ? (@ == true)') AS d6
       FROM raw_campaigns
       WHERE status = 1`,
    ),
  ]);
  const r = freshRows[0] ?? { last_send_day: null, last_synced_day: null, last_sync: null, sync_age_hours: null };
  const weekdays = sendingWeekdays(voteRows[0]);
  const latestDay = r.last_send_day ? (r.last_synced_day ?? r.last_send_day) : null;

  // ISO-строки сравниваются лексикографически корректно.
  const requested = day && isCalendarDay(day) && latestDay && day <= latestDay ? day : null;
  let asOfDay = '';
  let skippedDays: string[] = [];
  if (requested) {
    asOfDay = requested;
  } else if (latestDay) {
    ({ day: asOfDay, skipped: skippedDays } = pickDefaultDay(latestDay, weekdays));
  }
  const isSendingDay = !asOfDay || weekdays.length === 0 || weekdays.includes(weekdayOf(asOfDay));
  const syncAgeHours = r.sync_age_hours == null ? null : Number(r.sync_age_hours);
  const stale = syncAgeHours == null ? true : syncAgeHours > STALE_SYNC_HOURS;
  return { asOfDay, latestDay, isSendingDay, skippedDays, lastSync: r.last_sync, syncAgeHours, stale };
}

/**
 * Собирает всю картину нагрузки за день (по умолчанию — последний рабочий
 * полный день).
 */
export async function buildMailboxLoad(day?: string): Promise<MailboxLoad> {
  const { asOfDay, latestDay, isSendingDay, skippedDays, lastSync, syncAgeHours, stale } = await resolveAsOf(day);
  const generatedAt = new Date().toISOString();

  if (!asOfDay) {
    return {
      asOfDay: '', latestDay, isSendingDay, skippedDays, lastSync, syncAgeHours, stale, generatedAt,
      tags: [], specialists: [], inactiveTags: [],
      totals: { activeMailboxes: 0, capacity: 0, sent: 0, utilization: null },
      inactiveTotals: { tagCount: 0, activeMailboxes: 0, capacity: 0 },
      notes: ['Нет данных об отправках за последние 14 дней в датасете.'],
    };
  }

  const [boxes, daySends, recentCampaigns, campaignRefs, projectLinks, projects, hiddenRows] = await Promise.all([
    // 1) ящики под тегами. Hidden теги (клиент ведётся в Coldy/Trigga, в
    //    Instantly только прогрев) исключаем — иначе вечный ложный «Простой».
    //    Список — mailbox_load_hidden_tags.
    datasetQuery<BoxRow>(
      `SELECT DISTINCT m.tag_id, ct.name AS tag, a.email, a.status, a.daily_limit
       FROM raw_custom_tag_mappings m
       JOIN raw_custom_tags ct ON ct.id = m.tag_id
       JOIN raw_accounts a ON a.email = m.resource_id AND a.deleted_at IS NULL
       WHERE m.resource_type = '1'
         AND m.tag_id NOT IN (SELECT tag_id FROM mailbox_load_hidden_tags)`,
    ),
    // 2) письма дня по ящикам и кампаниям: из них и «Отправлено» по ящикам,
    //    и чьи кампании на самом деле шлют с ящиков тега (~60 мс на день).
    datasetQuery<DaySendRow>(
      `SELECT s.eaccount, s.campaign_id, c.name AS campaign_name, s.sent
       FROM (
         SELECT eaccount, campaign_id, count(*) AS sent
         FROM raw_emails
         WHERE ue_type = 1 AND timestamp_email >= $1::date AND timestamp_email < ($1::date + 1)
         GROUP BY eaccount, campaign_id
       ) s
       LEFT JOIN raw_campaigns c ON c.id = s.campaign_id`,
      [asOfDay],
    ),
    // 3) отправки кампаний за окно «тег в работе» — из дневной аналитики
    //    Instantly, а не из писем: неделя писем по кампаниям — чтение кучи на
    //    секунды (до ~10 с на холодной неделе), аналитика — ~0,2 с. Сверка за
    //    03–09.10: 260 кампаний, 227 864 письма против 227 865.
    datasetQuery<CampaignVolumeRow>(
      `SELECT campaign_id, sum(sent) AS sent
       FROM v_campaign_daily_canonical
       WHERE date >= ($1::date - $2::int) AND date <= $1::date
       GROUP BY campaign_id
       HAVING sum(sent) > 0`,
      [asOfDay, RECENT_WINDOW_DAYS - 1],
    ),
    // 4) свои кампании тега: ссылаются на него списком тегов или его ящиками
    //    в email_list (часть кампаний назначает ящики поимённо).
    datasetQuery<CampaignRefRow>(
      //    Ящики — только живые: удалённый ящик, оставшийся в маппинге,
      //    связывал тег с кампаниями, где ни одного нынешнего ящика тега нет.
      //    list_overlap — сколько ящиков тега в email_list (сборка оставляет
      //    поимённую ссылку только тегу с наибольшим пересечением).
      `WITH tag_boxes AS (
         SELECT m.tag_id, array_agg(DISTINCT m.resource_id) AS boxes
         FROM raw_custom_tag_mappings m
         JOIN raw_accounts a ON a.email = m.resource_id AND a.deleted_at IS NULL
         WHERE m.resource_type = '1'
         GROUP BY m.tag_id
       )
       SELECT tb.tag_id, c.id AS campaign_id, c.name AS campaign_name, c.status,
              to_char(c.timestamp_created AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_day,
              to_char(c.timestamp_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
              coalesce(c.email_tag_list @> ARRAY[tb.tag_id], false) AS via_tag,
              CASE WHEN coalesce(c.email_tag_list @> ARRAY[tb.tag_id], false) THEN NULL
                   ELSE cardinality(ARRAY(SELECT unnest(c.email_list) INTERSECT SELECT unnest(tb.boxes))) END AS list_overlap
       FROM tag_boxes tb
       JOIN raw_campaigns c ON c.email_tag_list @> ARRAY[tb.tag_id] OR c.email_list && tb.boxes`,
    ),
    // 5) кампания → проект. Две привязки вместе: автоматическая
    //    (portal_project_campaigns) и кампании периодов проекта. Свежие запуски
    //    часто есть только во второй — одна первая покрывала 74% отправок дня,
    //    обе — 98% (замер 09.10.2026); проектам они друг другу не противоречат.
    datasetQuery<ProjectLinkRow>(
      `SELECT campaign_id, project_id::text AS project_id FROM portal_project_campaigns
       UNION
       SELECT campaign_id, project_id::text FROM portal_period_campaigns
       WHERE campaign_id IS NOT NULL AND project_id IS NOT NULL`,
    ),
    // 6) проекты: клиент, специалист, статус, формат работы.
    datasetQuery<ProjectRow>(
      `SELECT id::text AS id, client, specialist, status, work_format FROM portal_projects`,
    ),
    // 7) счётчик скрытых тегов — для пояснения в notes.
    datasetQuery<{ n: string }>(`SELECT count(*) AS n FROM mailbox_load_hidden_tags`),
  ]);
  const hiddenCount = num(hiddenRows[0]?.n);

  const assembled = assembleMailboxLoad({
    asOfDay, boxes, daySends, recentCampaigns, campaignRefs, projectLinks, projects,
    isPoolTag: isReservedMailboxPoolTag,
  });

  const notes: string[] = [];
  notes.push('Потолок — по активным ящикам (status=Активен); ящикам без явного лимита подставлен дефолт воркспейса 30/день.');
  notes.push('«Отправлено» — по всем ящикам тега, включая выключенные сейчас (статус — снимок момента, отправки — история дня).');
  notes.push('Клиент тега — по его собственным кампаниям (ссылаются на тег или на его ящики поимённо): кто слал в этот день, иначе за неделю, иначе по активным. Письма с общих ящиков через другой тег — работа того тега, они видны в подсказке «+N».');
  notes.push(`В таблице только теги в работе: свои кампании слали за ${RECENT_WINDOW_DAYS} дней или у тега есть свои кампании незавершённого проекта. Остальные — в блоке «Не в работе»; свободными там считаются только ящики, не занятые тегами в работе и не закреплённые за клиентом, которого ещё не запустили (проект найден по имени тега).`);
  notes.push('Итог и строки специалистов считают каждый ящик один раз; суммы строк тегов могут быть выше (ящик под 2+ тегами попадает в каждый тег).');
  notes.push('Ящики только с тегом «неименные …» (резерв без клиента) в цифры страницы не входят.');
  notes.push('«День» — по UTC. По умолчанию — последний полный день, когда кампании шлют по расписанию. Датасет обновляется ночным синком, данные не реалтайм.');
  if (hiddenCount > 0) {
    notes.push(`Скрыто тегов: ${hiddenCount} — клиенты ведутся в Coldy/Trigga, в Instantly их ящики только на прогреве (отправок нет).`);
  }
  if (assembled.tags.some((t) => t.capacity > 0 && !t.specialist)) {
    notes.push('Часть тегов без привязки к специалисту (кампании не привязаны к проекту в портале) — они в группе «Не привязано».');
  }
  if (asOfDay < (latestDay ?? asOfDay)) {
    notes.push('Для прошлого дня клиенты и проекты берутся по нынешним статусам кампаний и проектов — картина того дня приблизительная.');
  }
  if (stale) {
    notes.push(`⚠️ Последний синк датасета старше ${STALE_SYNC_HOURS}ч — данные могут быть неактуальны (проверить ночной синк).`);
  }

  return {
    asOfDay, latestDay, isSendingDay, skippedDays, lastSync, syncAgeHours, stale, generatedAt,
    ...assembled,
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
  // resolveAsOf валидирует и клампит день (будущий/невалидный → день по умолчанию).
  // Его запросы — единицы мс; дешевле, чем дыра «drill за будущий день = все
  // нули» при прямом вызове API мимо дашборда.
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
