import 'server-only';
import { datasetQuery, isDatasetConfigured } from '@/lib/instantlyDataset';

/**
 * Объективная статистика датасета Instantly (`instantly_dataset`, 3.66M писем /
 * ~1700 кампаний) для калибровки вертикалей «Движка вертикалей»: сколько реально
 * отправлено/отвечено в совпавших нишах и какие темы/паттерны там выигрывают.
 *
 * Источники (см. app/scripts/instantly-dataset/):
 *  - dim_campaign_segment (010) — LLM-метка ЦЕЛЕВОЙ ниши кампании (snake_case enum:
 *    logistics_transport, medical_pharma, it_software_saas, ...). Матчим термины
 *    вертикали по этой колонке, а не по имени кампании (regex по имени течёт,
 *    см. комментарий в 010_campaign_segment.sql);
 *  - raw_campaign_analytics_overview_snap (последний снапшот через v_latest_snapshot)
 *    — lifetime-агрегаты Instantly per campaign. Тот же семейный источник, что и
 *    baseline open 58.2% / reply 1.03% из docs/research/instantly-email-patterns.md,
 *    поэтому reply_pct сегмента сравним с baseline_pct. raw_emails (3.66M строк)
 *    сознательно НЕ сканируем — есть предагрегаты;
 *  - raw_campaign_steps × raw_campaign_step_analytics_snap — темы/паттерны шагов.
 *    Пулинг внутри сегмента — эвристика для калибровки, НЕ доказательство A/B
 *    (within-campaign честность — отдельная mv_subject_ab_within_campaign).
 *
 * Контракт деградации: функции НИКОГДА не бросают — датасет может лежать, а стадия
 * досье обязана доехать. Любой сбой → null-поля + note (или [] для паттернов).
 *
 * Все запросы read-only и параметризованы. Отдельный per-query statement_timeout
 * хелпер datasetQuery не поддерживает — таймаут задан на уровне пула (15s,
 * см. instantlyDataset.ts), чего достаточно для этих scoped-запросов.
 */

/** Меньше отправок — reply% считать нечестно (шум), отдаём null. */
const MIN_SENT_FOR_PCT = 1000;
/** Минимум отправок на тему/паттерн, чтобы попасть в топ. */
const MIN_SUBJECT_SENT = 300;
const TOP_SUBJECTS_LIMIT = 5;

/* ─────────────────────────── контракт ─────────────────────────── */

export interface HeDatasetStats {
  matched_segments: string[]; // какие сегменты датасета совпали
  campaigns: number;
  sent: number;
  replies: number;
  reply_pct: number | null; // null если sent < 1000 (мало данных)
  baseline_pct: number | null; // общий reply% по датасету для сравнения
  top_subjects: string[]; // до 5 тем с лучшим reply% (sent >= 300)
  note?: string;
}

export interface HeWinnerPattern {
  pattern: string;
  reply_pct: number;
  sent: number;
}

/* ─────────────────────────── SQL ─────────────────────────── */

/**
 * Агрегат по совпавшим сегментам: lifetime sent/replies из последнего
 * overview-снапшота. Кампании без строки в последнем снапшоте дают 0 отправок,
 * но считаются в campaigns (LEFT JOIN).
 */
const SQL_SEGMENT_AGG = `
SELECT s.segment,
       count(*)::int AS campaigns,
       COALESCE(sum(o.emails_sent_count), 0)::bigint AS sent,
       COALESCE(sum(o.reply_count), 0)::bigint AS replies
FROM dim_campaign_segment s
LEFT JOIN raw_campaign_analytics_overview_snap o
       ON o.campaign_id = s.campaign_id
      AND o.snapshot_id = (SELECT id FROM v_latest_snapshot)
WHERE s.segment ~* $1
GROUP BY s.segment
ORDER BY sent DESC`;

/** Dataset-wide baseline: все кампании последнего снапшота (как baseline 1.03% в research-доке). */
const SQL_BASELINE = `
SELECT COALESCE(sum(o.emails_sent_count), 0)::bigint AS sent,
       COALESCE(sum(o.reply_count), 0)::bigint AS replies
FROM raw_campaign_analytics_overview_snap o
WHERE o.snapshot_id = (SELECT id FROM v_latest_snapshot)`;

/** Топ-темы сегмента: пулинг по нормализованной теме, гейт по объёму, сортировка по reply rate. */
const SQL_TOP_SUBJECTS = `
SELECT min(btrim(st.subject)) AS subject
FROM raw_campaign_steps st
JOIN raw_campaign_step_analytics_snap a
     ON a.campaign_id = st.campaign_id
    AND a.step_n = st.step_n
    AND a.variant_n = st.variant_n
    AND a.snapshot_id = (SELECT id FROM v_latest_snapshot)
WHERE st.campaign_id IN (SELECT campaign_id FROM dim_campaign_segment WHERE segment ~* $1)
  AND st.subject IS NOT NULL
  AND btrim(st.subject) <> ''
GROUP BY lower(btrim(st.subject))
HAVING sum(COALESCE(a.sent, 0)) >= ${MIN_SUBJECT_SENT}
ORDER BY 100.0 * sum(COALESCE(a.unique_replies, 0)) / sum(COALESCE(a.sent, 0)) DESC,
         sum(COALESCE(a.sent, 0)) DESC
LIMIT ${TOP_SUBJECTS_LIMIT}`;

/**
 * Winner-паттерны: тема шага, а если темы нет — первые 120 символов тела
 * (body-паттерн). $1 = null снимает сегментный фильтр (весь датасет).
 */
const SQL_WINNER_PATTERNS = `
SELECT t.pattern,
       sum(t.sent)::bigint AS sent,
       sum(t.replies)::bigint AS replies
FROM (
  SELECT COALESCE(NULLIF(btrim(st.subject), ''), NULLIF(left(btrim(st.body_text), 120), '')) AS pattern,
         COALESCE(a.sent, 0) AS sent,
         COALESCE(a.unique_replies, 0) AS replies
  FROM raw_campaign_steps st
  JOIN raw_campaign_step_analytics_snap a
       ON a.campaign_id = st.campaign_id
      AND a.step_n = st.step_n
      AND a.variant_n = st.variant_n
      AND a.snapshot_id = (SELECT id FROM v_latest_snapshot)
  WHERE ($1::text IS NULL OR st.campaign_id IN (SELECT campaign_id FROM dim_campaign_segment WHERE segment ~* $1))
) t
WHERE t.pattern IS NOT NULL
GROUP BY t.pattern
HAVING sum(t.sent) >= ${MIN_SUBJECT_SENT}
ORDER BY 100.0 * sum(t.replies) / sum(t.sent) DESC, sum(t.sent) DESC
LIMIT $2`;

/* ─────────────────────────── хелперы ─────────────────────────── */

interface SegmentAggRow {
  segment: string;
  campaigns: number | string;
  sent: number | string;
  replies: number | string;
}
interface TotalRow {
  sent: number | string;
  replies: number | string;
}
interface SubjectRow {
  subject: string | null;
}
interface PatternRow {
  pattern: string | null;
  sent: number | string;
  replies: number | string;
}

/** pg возвращает bigint/numeric строками — аккуратно в number. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Процент с округлением до 2 знаков (1.03 = 1.03%). total<=0 → 0. */
function pctOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((10000 * part) / total) / 100;
}

/** Процент с гейтом по объёму: мало данных → null (отказ, а не 0). */
function gatedPct(part: number, total: number): number | null {
  return total >= MIN_SENT_FOR_PCT ? pctOf(part, total) : null;
}

/** Нормализация терминов: trim + lowercase + dedupe, пустые выбрасываем. */
function normTerms(terms: string[]): string[] {
  const out: string[] = [];
  for (const t of terms) {
    const s = (t || '').trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary regex для матчинга по snake_case меткам сегментов.
 * Границей слова считаем начало/конец строки и любой не-[буква/цифра] символ —
 * тогда '_' тоже граница: 'logistics' матчит 'logistics_transport',
 * а 'it' НЕ матчит случайную подстроку внутри другого слова.
 * Используется с ~* (case-insensitive), термины уже lowercased.
 */
function boundaryRegex(terms: string[]): string {
  const inner = terms.map(escapeRegex).join('|');
  return `(^|[^a-zа-яё0-9])(${inner})([^a-zа-яё0-9]|$)`;
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 120);
}

/* ─────────────────────────── API ─────────────────────────── */

export async function getSegmentStats(verticalName: string, synonyms: string[]): Promise<HeDatasetStats> {
  const stats: HeDatasetStats = {
    matched_segments: [],
    campaigns: 0,
    sent: 0,
    replies: 0,
    reply_pct: null,
    baseline_pct: null,
    top_subjects: [],
  };

  if (!isDatasetConfigured()) {
    return { ...stats, note: 'датасет не сконфигурирован (нет INSTANTLY_DATASET_DB_URL)' };
  }
  const terms = normTerms([verticalName, ...synonyms]);
  if (!terms.length) {
    return { ...stats, note: 'не заданы термины вертикали для матчинга сегментов датасета' };
  }
  const segRe = boundaryRegex(terms);

  // Сегменты и baseline независимы — считаем параллельно, падаем по отдельности.
  let segErr = 'unknown error';
  const [segRows, baseRows] = await Promise.all([
    datasetQuery<SegmentAggRow>(SQL_SEGMENT_AGG, [segRe]).catch((e) => {
      segErr = errMsg(e);
      return null;
    }),
    datasetQuery<TotalRow>(SQL_BASELINE).catch(() => null),
  ]);

  if (baseRows && baseRows.length) {
    stats.baseline_pct = gatedPct(num(baseRows[0].replies), num(baseRows[0].sent));
  }
  if (segRows === null) {
    return { ...stats, note: `датасет недоступен: ${segErr}` };
  }
  if (baseRows === null) {
    stats.note = 'baseline не посчитался (запрос к датасету упал)';
  }
  if (!segRows.length) {
    return { ...stats, note: joinNotes(stats.note, 'ни один сегмент датасета не совпал с терминами вертикали') };
  }

  stats.matched_segments = segRows.map((r) => r.segment);
  stats.campaigns = segRows.reduce((acc, r) => acc + num(r.campaigns), 0);
  stats.sent = segRows.reduce((acc, r) => acc + num(r.sent), 0);
  stats.replies = segRows.reduce((acc, r) => acc + num(r.replies), 0);
  stats.reply_pct = gatedPct(stats.replies, stats.sent);
  if (stats.reply_pct === null) {
    stats.note = joinNotes(stats.note, `мало данных для честного reply%: sent=${stats.sent} < ${MIN_SENT_FOR_PCT}`);
  }

  // Топ-темы — best-effort: падение этого запроса не отменяет основную статистику.
  stats.top_subjects = await datasetQuery<SubjectRow>(SQL_TOP_SUBJECTS, [segRe])
    .then((rows) => rows.map((r) => r.subject).filter((s): s is string => Boolean(s)))
    .catch(() => []);

  return stats;
}

export async function getWinnerPatterns(segmentHints: string[], limit = 5): Promise<HeWinnerPattern[]> {
  if (!isDatasetConfigured()) return [];
  const terms = normTerms(segmentHints);
  // Нет хинтов — считаем по всему датасету (без сегментного фильтра).
  const segRe = terms.length ? boundaryRegex(terms) : null;
  const lim = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 5;
  try {
    const rows = await datasetQuery<PatternRow>(SQL_WINNER_PATTERNS, [segRe, lim]);
    return rows
      .filter((r): r is PatternRow & { pattern: string } => Boolean(r.pattern))
      .map((r) => {
        const sent = num(r.sent);
        return { pattern: r.pattern, reply_pct: pctOf(num(r.replies), sent), sent };
      });
  } catch {
    return []; // датасет лёг — досье не должно падать из-за вспомогательной статистики
  }
}

function joinNotes(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}
