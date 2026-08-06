import 'server-only';
import { datasetQuery, isDatasetConfigured } from '@/lib/instantlyDataset';
import type { HeMarket } from './market';

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
 *  - raw_campaign_analytics_overview_snap — lifetime-агрегаты Instantly per
 *    campaign. Берём per-campaign DISTINCT ON по всем ok-снапшотам (каноника
 *    012_canonical_metrics.sql): ночные снапшоты partial (только кампании,
 *    активные этой ночью), полный refresh — по воскресеньям, поэтому пин
 *    к v_latest_snapshot занижал sent/replies в 10–100 раз и занулял reply_pct
 *    у data-rich вертикалей. Тот же семейный источник, что и baseline
 *    open 58.2% / reply 1.03% из docs/research/instantly-email-patterns.md,
 *    поэтому reply_pct сегмента сравним с baseline_pct. raw_emails (3.66M строк)
 *    сознательно НЕ сканируем — есть предагрегаты;
 *  - raw_campaign_steps × raw_campaign_step_analytics_snap — темы/паттерны шагов
 *    (та же DISTINCT ON-дедупликация, по (campaign_id, step_n, variant_n)).
 *    Пулинг внутри сегмента — эвристика для калибровки, НЕ доказательство A/B
 *    (within-campaign честность — отдельная mv_subject_ab_within_campaign);
 *  - dim_campaign_client (011) — авторитетный КЛИЕНТ студии (заказчик, от чьего
 *    имени идёт аутрич) per campaign: source=project — чистый маппинг из
 *    project_instantly_campaigns→projects.client, source=name_match — имя
 *    клиента найдено в названии кампании. Ось портфеля getPortfolioProfile.
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

/* ─────────────────── рыночный гейт калибровки ─────────────────── */

/**
 * Датасет Instantly — это кампании RU-рынка, а словарь матчинга сегментов
 * (SEGMENT_LABEL_KEYWORDS) русскоязычный. Для проектов рынка 'us' калибровка
 * по нему бессмысленна: пропускаем её (пустой/нейтральный результат + лог),
 * НЕ падаем — never-throw контракт модуля сохраняется. Дефолт (без market) —
 * прежнее поведение.
 */
function calibrationMarketSkip(market: HeMarket | undefined, fn: string): boolean {
  if (market !== 'us') return false;
  console.info(`[datasetStats] ${fn}: market=us — калибровка по датасету RU-кампаний пропущена`);
  return true;
}

const US_MARKET_SKIP_NOTE = 'рыночный гейт: market=us — калибровка по датасету RU-кампаний пропущена';

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

export interface HePortfolioEntry {
  segment: string; // метка сегмента (из dim_campaign_segment)
  campaigns: number;
  clients: number; // distinct client companies in the segment
  sent: number;
  replies: number;
  reply_pct: number | null; // null when sent < 1000 (same honesty gate as getSegmentStats)
}

/* ─────────────────────────── SQL ─────────────────────────── */

/**
 * Per-campaign «последнее известное состояние»: DISTINCT ON по кампании поверх
 * всех ok-снапшотов (каноника 012_canonical_metrics.sql). Ночные снапшоты
 * partial, поэтому суммировать надо по этой дедуп-выборке, а не по одному
 * «последнему» снапшоту — иначе sent/replies занижаются в 10–100 раз.
 */
const SQL_LATEST_OVERVIEW = `
WITH latest AS (
  SELECT DISTINCT ON (o.campaign_id)
         o.campaign_id, o.emails_sent_count, o.reply_count
  FROM raw_campaign_analytics_overview_snap o
  JOIN dataset_snapshots ds ON ds.id = o.snapshot_id AND ds.ok
  ORDER BY o.campaign_id, ds.started_at DESC
)`;

/**
 * Агрегат по совпавшим сегментам: lifetime sent/replies из per-campaign latest.
 * Кампании сегмента без ни одной ok-строки в overview-снапшотах дают 0 отправок,
 * но считаются в campaigns (LEFT JOIN).
 */
const SQL_SEGMENT_AGG = `${SQL_LATEST_OVERVIEW}
SELECT s.segment,
       count(*)::int AS campaigns,
       COALESCE(sum(l.emails_sent_count), 0)::bigint AS sent,
       COALESCE(sum(l.reply_count), 0)::bigint AS replies
FROM dim_campaign_segment s
LEFT JOIN latest l ON l.campaign_id = s.campaign_id
WHERE s.segment ~* $1
GROUP BY s.segment
ORDER BY sent DESC`;

/** Dataset-wide baseline: сумма per-campaign latest по всему датасету (baseline 1.03% из research-дока). */
const SQL_BASELINE = `${SQL_LATEST_OVERVIEW}
SELECT COALESCE(sum(l.emails_sent_count), 0)::bigint AS sent,
       COALESCE(sum(l.reply_count), 0)::bigint AS replies
FROM latest l`;

/**
 * Портфельное досье: агрегат по ВСЕМ сегментам сразу — сколько кампаний и
 * СКОЛЬКИХ РАЗНЫХ КЛИЕНТОВ студия уже вела в нише (объективное доказательство
 * «кому мы уже успешно продаём»). Клиент — из dim_campaign_client (011):
 * source=project авторитетен, name_match — эвристика по имени кампании; обе
 * строки считаем, distinct по имени клиента (NULL — кампания без маппинга —
 * count(DISTINCT) игнорирует). Оба джойна 1:1 (dim_campaign_client.campaign_id
 * — PK, latest — DISTINCT ON), fan-out нет; кампании без клиента или без
 * ok-снапшотов дают 0 отправок, но считаются в campaigns (LEFT JOIN).
 */
const SQL_PORTFOLIO_PROFILE = `${SQL_LATEST_OVERVIEW}
SELECT s.segment,
       count(*)::int AS campaigns,
       count(DISTINCT cl.client)::int AS clients,
       COALESCE(sum(l.emails_sent_count), 0)::bigint AS sent,
       COALESCE(sum(l.reply_count), 0)::bigint AS replies
FROM dim_campaign_segment s
LEFT JOIN dim_campaign_client cl ON cl.campaign_id = s.campaign_id
LEFT JOIN latest l ON l.campaign_id = s.campaign_id
GROUP BY s.segment
ORDER BY campaigns DESC, sent DESC, s.segment
LIMIT $1`;

/**
 * Step-level «последнее известное состояние»: одна строка на (кампания, шаг,
 * вариант) — самая свежая из ok-снапшотов. Агрегаты тем/паттернов считаем
 * только из этой дедуп-выборки.
 */
const SQL_LATEST_STEP = `
WITH latest_step AS (
  SELECT DISTINCT ON (a.campaign_id, a.step_n, a.variant_n)
         a.campaign_id, a.step_n, a.variant_n, a.sent, a.unique_replies
  FROM raw_campaign_step_analytics_snap a
  JOIN dataset_snapshots ds ON ds.id = a.snapshot_id AND ds.ok
  ORDER BY a.campaign_id, a.step_n, a.variant_n, ds.started_at DESC
)`;

/** Топ-темы сегмента: пулинг по нормализованной теме, гейт по объёму, сортировка по reply rate. */
const SQL_TOP_SUBJECTS = `${SQL_LATEST_STEP}
SELECT min(btrim(st.subject)) AS subject
FROM raw_campaign_steps st
JOIN latest_step a
     ON a.campaign_id = st.campaign_id
    AND a.step_n = st.step_n
    AND a.variant_n = st.variant_n
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
const SQL_WINNER_PATTERNS = `${SQL_LATEST_STEP}
SELECT t.pattern,
       sum(t.sent)::bigint AS sent,
       sum(t.replies)::bigint AS replies
FROM (
  SELECT COALESCE(NULLIF(btrim(st.subject), ''), NULLIF(left(btrim(st.body_text), 120), '')) AS pattern,
         COALESCE(a.sent, 0) AS sent,
         COALESCE(a.unique_replies, 0) AS replies
  FROM raw_campaign_steps st
  JOIN latest_step a
       ON a.campaign_id = st.campaign_id
      AND a.step_n = st.step_n
      AND a.variant_n = st.variant_n
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
interface PortfolioRow {
  segment: string;
  campaigns: number | string;
  clients: number | string;
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

/* ─────────────── маппинг вертикаль → метки сегментов ─────────────── */

/**
 * Метки dim_campaign_segment — 14 английских макро-сегментов (авторазметка
 * кампаний). Наши вертикали названы по-русски и точнее, поэтому прямой
 * текстовый матч почти всегда пуст. Словарь ниже маппит RU/EN ключи
 * вертикали на эти метки; если сработал — матчим по меткам, иначе
 * откатываемся на свободный текстовый матч по терминам вертикали.
 *
 * Маркеры в ключах (см. keywordHit):
 *  '=слово' — полная граница слова независимо от длины: '=салон' ловит
 *    «салон красоты», но НЕ «автосалоны»; '=персонал' не ловит «персональные»;
 *  '^стем'  — префикс-стем, граница только слева: '^фарм' ловит «фармацевтика»,
 *    '^агро' — «агропромышленный», '^банки' — «банки/банкиры/банкинг»;
 *  без маркера — ≤4 символов полная граница ('hr' не срабатывает на «охрана»),
 *    >4 — подстрока ('логистик' ловит «логистика/логистический»).
 */
const SEGMENT_LABEL_KEYWORDS: Record<string, string[]> = {
  it_software_saas: ['software', 'saas', 'разработк', 'вендор', 'интегратор', 'программн', 'ит-', 'it-'],
  logistics_transport: ['логистик', 'склад', 'вэд', 'экспедиц', 'транспорт', 'грузоперевоз', 'фулфилмент', 'logistics', '3pl'],
  education_hr: ['кадров', 'рекрут', 'аутстафф', 'обучен', '=персонал', 'hr', 'подбор персонала'],
  manufacturing_industrial: ['производств', 'промышленн', 'завод', 'оборудован', 'станк', 'manufactur', 'индустри'],
  construction_realestate: ['строительств', 'стройк', 'девелоп', 'недвижим', 'смр', 'realestate', 'construction'],
  retail_ecommerce: ['ритейл', 'ecommerce', 'e-com', 'маркетплейс', 'селлер', 'торговл', 'розниц', 'retail'],
  food_horeca: ['horeca', 'fmcg', 'ресторан', 'пищев', 'продукты питания'],
  medical_pharma: ['медицин', '^фарм', 'клиник', 'медтех', 'medical', 'pharma'],
  marketing_media_events: ['маркетинг', 'реклам', '=медиа', 'ивент', 'mice', 'digital'],
  finance_legal: ['финанс', 'бухгалтер', 'юридичес', 'лизинг', 'факторинг', 'страхов', 'банк', '^банки', '^банков', 'финтех', 'fintech', 'legal', 'm&a'],
  beauty_wellness: ['beauty', '=салон', 'велнес', 'wellness', 'спа', 'косметолог'],
  auto: ['автобизнес', 'автодилер', 'спецтехник', 'дилер', 'auto'],
  agriculture: ['^агро', 'сельхоз', 'фермер', 'agricultur'],
  other_unclear: [],
};

/**
 * Матч одного ключа (маркеры '='/'^' описаны над словарём). Короткие ключи
 * без маркера (≤4 символов) матчатся только по полной границе слова.
 */
function keywordHit(haystack: string, rawKeyword: string): boolean {
  let keyword = rawKeyword;
  let mode: 'auto' | 'word' | 'stem' = 'auto';
  if (keyword.startsWith('=')) {
    mode = 'word';
    keyword = keyword.slice(1);
  } else if (keyword.startsWith('^')) {
    mode = 'stem';
    keyword = keyword.slice(1);
  }
  if (!keyword) return false;
  if (mode === 'stem') {
    const re = new RegExp(`(^|[^a-zа-яё0-9])${escapeRegex(keyword)}`, 'i');
    return re.test(haystack);
  }
  if (mode === 'word' || keyword.length <= 4) {
    const re = new RegExp(`(^|[^a-zа-яё0-9])${escapeRegex(keyword)}([^a-zа-яё0-9]|$)`, 'i');
    return re.test(haystack);
  }
  return haystack.includes(keyword);
}

/** Метки датасета, соответствующие терминам вертикали (может быть несколько). */
export function matchSegmentLabels(terms: string[]): string[] {
  const haystack = terms.join(' ').toLowerCase();
  const labels: string[] = [];
  for (const [label, keywords] of Object.entries(SEGMENT_LABEL_KEYWORDS)) {
    if (keywords.some((k) => keywordHit(haystack, k))) labels.push(label);
  }
  return labels;
}

/* ─────────────────────────── API ─────────────────────────── */

export async function getSegmentStats(
  verticalName: string,
  synonyms: string[],
  opts?: { market?: HeMarket },
): Promise<HeDatasetStats> {
  const stats: HeDatasetStats = {
    matched_segments: [],
    campaigns: 0,
    sent: 0,
    replies: 0,
    reply_pct: null,
    baseline_pct: null,
    top_subjects: [],
  };

  if (calibrationMarketSkip(opts?.market, 'getSegmentStats')) {
    return { ...stats, note: US_MARKET_SKIP_NOTE };
  }
  if (!isDatasetConfigured()) {
    return { ...stats, note: 'датасет не сконфигурирован (нет INSTANTLY_DATASET_DB_URL)' };
  }
  const terms = normTerms([verticalName, ...synonyms]);
  if (!terms.length) {
    return { ...stats, note: 'не заданы термины вертикали для матчинга сегментов датасета' };
  }
  // Сначала пробуем маппинг на 14 макро-меток датасета (вертикали у нас
  // русские и точнее меток); если словарь молчит — свободный текстовый матч.
  const mappedLabels = matchSegmentLabels(terms);
  const segRe = boundaryRegex(mappedLabels.length ? mappedLabels : terms);

  // Сегменты и baseline независимы — считаем параллельно, падаем по отдельности.
  // pg-ошибки могут содержать host:port и внутренние детали подключения — наружу
  // отдаём generic-note, сырой текст ошибки только в серверный лог.
  const [segRows, baseRows] = await Promise.all([
    datasetQuery<SegmentAggRow>(SQL_SEGMENT_AGG, [segRe]).catch((e) => {
      console.error('[datasetStats] segment query failed:', errMsg(e));
      return null;
    }),
    datasetQuery<TotalRow>(SQL_BASELINE).catch(() => null),
  ]);

  if (baseRows && baseRows.length) {
    stats.baseline_pct = gatedPct(num(baseRows[0].replies), num(baseRows[0].sent));
  }
  if (segRows === null) {
    return { ...stats, note: 'датасет временно недоступен' };
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

export async function getWinnerPatterns(
  segmentHints: string[],
  limit = 5,
  opts?: { market?: HeMarket },
): Promise<HeWinnerPattern[]> {
  if (calibrationMarketSkip(opts?.market, 'getWinnerPatterns')) return [];
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

/**
 * Портфельное досье: по каждому сегменту датасета — сколько кампаний, скольких
 * РАЗНЫХ клиентов и с каким объёмом/ответами студия там уже работала. Сортировка
 * по числу кампаний (SQL), лимит opts.limit ?? 10 (кламп 1..50). Never-throw:
 * датасет не сконфигурирован или запрос упал → [] (+ console.error при падении).
 * Рынок us → рыночный гейт: [] без запроса (см. calibrationMarketSkip).
 */
export async function getPortfolioProfile(opts?: { limit?: number; market?: HeMarket }): Promise<HePortfolioEntry[]> {
  if (calibrationMarketSkip(opts?.market, 'getPortfolioProfile')) return [];
  if (!isDatasetConfigured()) return [];
  const limit = opts?.limit ?? 10;
  const lim = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
  try {
    const rows = await datasetQuery<PortfolioRow>(SQL_PORTFOLIO_PROFILE, [lim]);
    return rows.map((r) => {
      const sent = num(r.sent);
      const replies = num(r.replies);
      return {
        segment: r.segment,
        campaigns: num(r.campaigns),
        clients: num(r.clients),
        sent,
        replies,
        reply_pct: gatedPct(replies, sent),
      };
    });
  } catch (e) {
    console.error('[datasetStats] portfolio profile query failed:', errMsg(e));
    return [];
  }
}

/**
 * Фактические отправки/ответы по КОНКРЕТНЫМ кампаниям (петля сверки прогноза
 * «Движка вертикалей» с реальностью): per-campaign latest, отфильтрованный по
 * переданным id. Гейт по объёму мягче сегментного (100 vs 1000): одна-две
 * кампании вертикали редко набирают тысячи отправок в первые дни.
 */
const SQL_CAMPAIGNS_AGG = `${SQL_LATEST_OVERVIEW}
SELECT count(*)::int AS campaigns,
       COALESCE(sum(l.emails_sent_count), 0)::bigint AS sent,
       COALESCE(sum(l.reply_count), 0)::bigint AS replies
FROM latest l
WHERE l.campaign_id::text = ANY($1)`;

export interface HeCampaignActuals {
  /** Сколько из переданных кампаний вообще есть в датасете (снапшоты ещё могли не доехать). */
  campaigns_with_data: number;
  sent: number;
  replies: number;
  /** reply% при sent >= 100; null — данных пока мало для честного числа. */
  reply_pct: number | null;
}

/**
 * Факт по кампаниям запуска (he_templates.launch_info.campaigns). null —
 * датасет не сконфигурирован/упал или ни одна кампания ещё не синкнулась.
 * Never-throw по контракту модуля.
 */
export async function getCampaignActuals(campaignIds: string[]): Promise<HeCampaignActuals | null> {
  const ids = [...new Set(campaignIds.map((c) => (c ?? '').trim()).filter(Boolean))];
  if (!ids.length || !isDatasetConfigured()) return null;
  try {
    const rows = await datasetQuery<{ campaigns: number | string; sent: number | string; replies: number | string }>(
      SQL_CAMPAIGNS_AGG,
      [ids],
    );
    const row = rows[0];
    if (!row || num(row.campaigns) === 0) return null;
    const sent = num(row.sent);
    const replies = num(row.replies);
    return {
      campaigns_with_data: num(row.campaigns),
      sent,
      replies,
      reply_pct: sent >= 100 ? Math.round((replies / sent) * 10000) / 100 : null,
    };
  } catch (e) {
    console.error('[datasetStats] campaign actuals query failed:', errMsg(e));
    return null;
  }
}

function joinNotes(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}
