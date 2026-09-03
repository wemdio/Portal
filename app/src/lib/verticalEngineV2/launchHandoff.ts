/**
 * «Последняя миля» мастера «Движка вертикалей»: подготовка данных для
 * отправки готового шаблона (шаг 5) в запуск — создание пустой кампании
 * в Instantly с цепочкой шаблона и сохранение проверенной базы в durable
 * Portal-резерв для последующей дозированной загрузки.
 *
 * Модуль ЧИСТЫЙ (без server-only/DB/фетчей): собирает sequence из писем
 * шаблона и маппит строки базы в лиды. HTTP-роут
 * (api/tools/vertical-engine-v2/templates/[id]/launch) делает все вызовы
 * Instantly/Supabase сам, переиспользуя клиентский стек запуска:
 *   - buildCampaignPayloadFromPreset (delay-лесенка, HTML-обёртка, text_only,
 *     расписание/лимиты/трекинг из пресета);
 *   - instantly client createCampaign → (updateCampaign, если Instantly
 *     не принял sequences); контакты добавляет отдельный delivery runner;
 *   - подготовка не активирует кампанию: после одобрения специалиста отдельный
 *     delivery runner загружает дневную партию и активирует её через DB-fence.
 *
 * Отличия от клиентского runLaunch осознанные:
 *   - нет self-service тарифного гейта (managed-contract). Blocklist клиента
 *     проверяется и при подготовке, и при загрузке; принятые контакты журналируются;
 *   - пресет читается по id без client_user_id-скоупа (service-level read через
 *     тот же supabaseInstantly, что и clientLaunch);
 *   - ошибки НЕ проходят scrubBrand — текст идёт во внутренний UI, где точная
 *     формулировка Instantly важнее white-label.
 */

import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP,
  type ClientLaunchSequenceStep,
} from '@/lib/clientLaunch/types';
import type {
  VeChainLetter,
  VeOperatorMapping,
  VeRuSeasonality,
  VeRuSeasonalityPrioritySnapshot,
} from './types';
import { normalizeLaunchMailboxIds } from './launchPortfolio';

/** Максимум контактов в проверенном резерве одного шаблона, 413 сверх. */
// Bounded durable reserve, not an Instantly upload batch. The worker sends
// smaller exact daily batches; a 5k-contact period must fit in one reserve.
export const VE_LAUNCH_MAX_LEADS = 20_000;

/**
 * Кампания одного сегмента в записи о запуске. При материализации сегментных
 * вариантов запуск создаёт НЕСКОЛЬКО paused-кампаний: по одной на сегмент +
 * основная (segment=null, дефолтные тексты).
 */
export interface VeTemplateLaunchCampaign {
  campaign_id: string;
  campaign_name: string;
  campaign_url: string;
  /** Условие сегмента (when дословно); null — основная кампания. */
  segment: string | null;
  leads_count: number;
  /** Immutable initial reserve prepared in Portal; not yet uploaded. */
  ready_leads_count?: number;
}

/**
 * Запись о запуске, сохраняемая в `ve_templates.launch_info` (jsonb).
 * NB: колонка появляется отдельной миграцией — до неё роут создаёт кампанию,
 * но предупреждает, что запись не сохранилась.
 * Скалярные поля (campaign_id и т.п.) — всегда про ОСНОВНУЮ кампанию
 * (обратная совместимость: долив refill и старый UI читают только их).
 */
export interface VeTemplateLaunchInfo {
  campaign_id: string;
  campaign_name: string;
  campaign_url: string;
  leads_count: number;
  /** Immutable initial launch-ready reserve. `leads_count` is accepted upload only. */
  ready_leads_count?: number;
  preset_id: string;
  created_at: string;
  /** Explicit operational ownership snapshot; never inferred from names. */
  portal_project_id?: string;
  portal_period_id?: string;
  target_contacts?: number;
  /** Immutable Instantly capacity scope captured from the chosen preset. */
  instantly_account_id?: string;
  mailbox_ids?: string[];
  /** Evidence-backed calendar state frozen when the paused bundle is prepared. */
  seasonality?: VeRuSeasonality;
  seasonality_input_hash?: string;
  priority_snapshot?: VeRuSeasonalityPrioritySnapshot;
  latest_activation_at?: string | null;
  seasonality_confidence?: 'low' | 'medium' | 'high';
  potential_pct?: number;
  estimated_run_days?: number;
  /** Проверенный снимок сегментации, по которому построены кампании. */
  segmentation_audit_id?: string;
  /** Хеш точной аудитории + условий + сохранённых назначений аудита. */
  segmentation_audit_input_hash?: string;
  /** External outcome needs explicit specialist reconciliation before retry. */
  reconciliation_required?: boolean;
  /** Все кампании запуска (основная + сегментные). Поля нет у запусков до сплита. */
  campaigns?: VeTemplateLaunchCampaign[];
}

/** Безопасный для UI пункт селектора пресетов (GET launch), без адресов почт. */
export interface VeLaunchPresetOption {
  id: string;
  name: string;
  instantly_account_id: string;
  instantly_account_label: string;
  mailbox_count: number;
  mailbox_tags: Array<{ id: string; name: string }>;
  mailbox_tag_resolution: 'exact' | 'shared' | 'mixed' | 'none' | 'unavailable';
}

/** Безопасный для UI тег пула отправителей, без адресов почтовых ящиков. */
export interface VeMailboxTagOption {
  id: string;
  name: string;
  instantly_account_id: string;
  instantly_account_label: string;
  /** Display-only hint from tag mappings; null means POST must resolve the live tag. */
  mailbox_count: number | null;
}

/** Аккуратно прочитать launch_info из jsonb (могло прийти что угодно). */
export function parseLaunchInfo(raw: unknown): VeTemplateLaunchInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.campaign_id !== 'string' || r.campaign_id.length === 0) return null;
  const campaigns = Array.isArray(r.campaigns)
    ? (r.campaigns as Array<Record<string, unknown>>)
        .filter((c) => c && typeof c.campaign_id === 'string' && c.campaign_id.length > 0)
        .map((c) => ({
          campaign_id: c.campaign_id as string,
          campaign_name: typeof c.campaign_name === 'string' ? c.campaign_name : '',
          campaign_url: typeof c.campaign_url === 'string' ? c.campaign_url : '',
          segment: typeof c.segment === 'string' ? c.segment : null,
          leads_count:
            typeof c.leads_count === 'number' && Number.isFinite(c.leads_count) ? c.leads_count : 0,
          ...(typeof c.ready_leads_count === 'number' && Number.isFinite(c.ready_leads_count)
            ? { ready_leads_count: Math.max(0, Math.trunc(c.ready_leads_count)) }
            : {}),
        }))
    : undefined;
  const mailboxIds = Array.isArray(r.mailbox_ids)
    ? normalizeLaunchMailboxIds(r.mailbox_ids)
    : undefined;
  const seasonality = r.seasonality && typeof r.seasonality === 'object' && !Array.isArray(r.seasonality)
    ? (r.seasonality as unknown as VeRuSeasonality)
    : undefined;
  const prioritySnapshot =
    r.priority_snapshot &&
    typeof r.priority_snapshot === 'object' &&
    !Array.isArray(r.priority_snapshot)
      ? (r.priority_snapshot as unknown as VeRuSeasonalityPrioritySnapshot)
      : undefined;
  return {
    campaign_id: r.campaign_id,
    campaign_name: typeof r.campaign_name === 'string' ? r.campaign_name : '',
    campaign_url: typeof r.campaign_url === 'string' ? r.campaign_url : '',
    leads_count: typeof r.leads_count === 'number' && Number.isFinite(r.leads_count) ? r.leads_count : 0,
    ...(typeof r.ready_leads_count === 'number' && Number.isFinite(r.ready_leads_count)
      ? { ready_leads_count: Math.max(0, Math.trunc(r.ready_leads_count)) }
      : {}),
    preset_id: typeof r.preset_id === 'string' ? r.preset_id : '',
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    ...(typeof r.portal_project_id === 'string' && r.portal_project_id.trim()
      ? { portal_project_id: r.portal_project_id.trim() }
      : {}),
    ...(typeof r.portal_period_id === 'string' && r.portal_period_id.trim()
      ? { portal_period_id: r.portal_period_id.trim() }
      : {}),
    ...(typeof r.target_contacts === 'number' && Number.isSafeInteger(r.target_contacts) && r.target_contacts > 0
      ? { target_contacts: r.target_contacts }
      : {}),
    ...(typeof r.instantly_account_id === 'string' && r.instantly_account_id.trim()
      ? { instantly_account_id: r.instantly_account_id.trim() }
      : {}),
    ...(mailboxIds && mailboxIds.length > 0 ? { mailbox_ids: mailboxIds } : {}),
    ...(seasonality ? { seasonality } : {}),
    ...(typeof r.seasonality_input_hash === 'string' && /^[0-9a-f]{64}$/.test(r.seasonality_input_hash)
      ? { seasonality_input_hash: r.seasonality_input_hash }
      : {}),
    ...(prioritySnapshot ? { priority_snapshot: prioritySnapshot } : {}),
    ...(typeof r.latest_activation_at === 'string'
      ? { latest_activation_at: r.latest_activation_at }
      : r.latest_activation_at === null
        ? { latest_activation_at: null }
        : {}),
    ...(r.seasonality_confidence === 'low' ||
    r.seasonality_confidence === 'medium' ||
    r.seasonality_confidence === 'high'
      ? { seasonality_confidence: r.seasonality_confidence }
      : {}),
    ...(typeof r.potential_pct === 'number' && Number.isFinite(r.potential_pct)
      ? { potential_pct: r.potential_pct }
      : {}),
    ...(typeof r.estimated_run_days === 'number' && Number.isFinite(r.estimated_run_days)
      ? { estimated_run_days: r.estimated_run_days }
      : {}),
    ...(typeof r.segmentation_audit_id === 'string' && r.segmentation_audit_id
      ? { segmentation_audit_id: r.segmentation_audit_id }
      : {}),
    ...(typeof r.segmentation_audit_input_hash === 'string' && r.segmentation_audit_input_hash
      ? { segmentation_audit_input_hash: r.segmentation_audit_input_hash }
      : {}),
    ...(r.reconciliation_required === true ? { reconciliation_required: true } : {}),
    ...(campaigns && campaigns.length > 0 ? { campaigns } : {}),
  };
}

/** Ссылка на кампанию в Instantly (та же база URL, что и в остальном портале). */
export function instantlyCampaignUrl(campaignId: string): string {
  return `https://app.instantly.ai/app/campaign/${campaignId}`;
}

/** Имя кампании: узнаваемое в списке Instantly, с датой запуска (+ сегмент при сплите). */
export function buildLaunchCampaignName(
  baseFilename: string | null | undefined,
  now = new Date(),
  segment?: string | null,
): string {
  const base = (baseFilename ?? '').trim() || 'база';
  const seg = (segment ?? '').trim();
  return `HE · ${base}${seg ? ` · ${seg}` : ''} · ${now.toISOString().slice(0, 10)}`.slice(0, 200);
}

export interface VeLaunchSequence {
  steps: ClientLaunchSequenceStep[];
  /** Сколько сегментных вариантов выкинуто (легаси-путь без сплита по сегментам). */
  droppedSegmentVariants: number;
  /** В скольких письмах были сегментные варианты. */
  lettersWithSegmentVariants: number;
  /** Сколько сегментных вариантов применено (сплит-путь с segmentWhen). */
  appliedSegmentVariants: number;
}

/**
 * Собирает ClientLaunchSequenceStep[] из финальных писем шаблона.
 *
 * Правила (зеркалят клиентский запуск):
 *   - тема только у первого письма; у follow-up'ов тема пустая — Instantly
 *     продолжает тред (Re: первой темы);
 *   - A/B-варианты письма → variants шага (основной текст = вариант A),
 *     всего не больше CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP с учётом основного;
 *   - wait_days остаются как есть: перевод в delay (wait_days СЛЕДУЮЩЕГО шага,
 *     у последнего 1) делает buildCampaignPayloadFromPreset — не дублируем;
 *   - segment_variants: без opts.segmentWhen НЕ переносятся (условные блоки
 *     Instantly не исполняет) — только считаем для предупреждения. С
 *     opts.segmentWhen (кампания конкретного сегмента при сплите) тело письма
 *     заменяется текстом варианта, чьё when совпало (регистронезависимо).
 *
 * Возвращает null, если писем нет.
 */
export function buildLaunchSequence(
  letters: VeChainLetter[] | null | undefined,
  opts?: { segmentWhen?: string | null },
): VeLaunchSequence | null {
  if (!Array.isArray(letters) || letters.length === 0) return null;

  const segmentKey = (opts?.segmentWhen ?? '').trim().toLowerCase();
  let droppedSegmentVariants = 0;
  let lettersWithSegmentVariants = 0;
  let appliedSegmentVariants = 0;

  const steps = letters.map<ClientLaunchSequenceStep>((letter, i) => {
    const variants = letter.segment_variants ?? [];
    let body = letter.body ?? '';
    if (variants.length > 0) {
      lettersWithSegmentVariants += 1;
      const matched = segmentKey
        ? variants.find((v) => (v.when ?? '').trim().toLowerCase() === segmentKey)
        : undefined;
      if (matched) {
        body = matched.text;
        appliedSegmentVariants += 1;
      } else {
        // Не материализовано (дефолтная кампания или легаси-путь) — считаем выкинутым.
        droppedSegmentVariants += variants.length;
      }
    }
    const first = i === 0;
    return {
      subject: first ? letter.subject ?? '' : '',
      body,
      wait_days:
        typeof letter.wait_days === 'number' && Number.isFinite(letter.wait_days)
          ? letter.wait_days
          : 0,
      variants: (letter.variants ?? [])
        .slice(0, CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP - 1)
        .map((v) => ({ subject: first ? v.subject ?? '' : '', body: v.body ?? '' })),
    };
  });

  return { steps, droppedSegmentVariants, lettersWithSegmentVariants, appliedSegmentVariants };
}

/** Текст предупреждения о выкинутых сегментных вариантах (null — если нечего). */
export function segmentVariantsWarning(sequence: VeLaunchSequence): string | null {
  if (sequence.droppedSegmentVariants === 0) return null;
  return (
    `Сегментные варианты (${sequence.droppedSegmentVariants} шт. в ` +
    `${sequence.lettersWithSegmentVariants} письмах) не попали в кампанию: ` +
    `Instantly не умеет условные блоки — в рассылку ушёл основной текст писем.`
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_COLUMN_NAME_RE = /e-?mail|почта|емейл/i;

/**
 * Колонка с email: сначала по имени («Email», «e-mail», «Почта»…), иначе по
 * содержимому — первая колонка, где ≥60% первых непустых значений похожи на email.
 */
export function findEmailColumn(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string | null {
  const byName = columns.find((c) => EMAIL_COLUMN_NAME_RE.test(c));
  if (byName) return byName;

  for (const col of columns) {
    const values = rows
      .slice(0, 50)
      .map((r) => String(r[col] ?? '').trim())
      .filter((v) => v.length > 0)
      .slice(0, 20);
    if (values.length === 0) continue;
    const hits = values.filter((v) => EMAIL_RE.test(v.toLowerCase())).length;
    if (hits / values.length >= 0.6) return col;
  }
  return null;
}

export interface MapBaseRowsInput {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  operatorMapping?: VeOperatorMapping[];
}

export interface MapBaseRowsResult {
  leads: LeadCreatePayload[];
  /** Колонка, из которой взят email (null — не нашли → лидов нет). */
  emailColumn: string | null;
  /** Индекс исходной строки базы для каждого лида (параллельно leads) — нужен
   *  сплиту по сегментам при запуске. */
  leadRowIndices: number[];
}

/**
 * Строки ve_bases.data → лиды Instantly, по мотивам mapCsvRowsToLeads:
 *   - email обязателен, lowercase, дедуп;
 *   - operator_mapping применяется для именования переменных: matched оператор
 *     «var → колонка» кладёт значение ячейки в custom_variables под именем
 *     оператора (так {{var}} в письме подставится на стороне Instantly).
 *     Переменная эмитится ВСЕГДА: пустая ячейка → fallback маппинга, иначе ''
 *     (Instantly рендерит существующую пустую переменную как ''; незаданная
 *     переменная осталась бы в письме литералом {{var}}, а превью
 *     (renderPreview) обещает именно подстановку — реальность обязана ей
 *     соответствовать). Unmatched-оператор с fallback → fallback у всех лидов;
 *   - остальные колонки проходят в custom_variables под своими именами.
 */
export function mapBaseRowsToLeads(input: MapBaseRowsInput): MapBaseRowsResult {
  const { rows, columns, operatorMapping } = input;

  const emailColumn = findEmailColumn(columns, rows);
  if (!emailColumn) return { leads: [], emailColumn: null, leadRowIndices: [] };

  // column → operator (первый matched-оператор на колонку выигрывает).
  const operatorByColumn = new Map<string, string>();
  // operator → fallback для unmatched (fallback'ы unmatched идут всем лидам).
  const unmatchedFallbacks = new Map<string, string>();
  // Все matched-операторы: переменную надо эмитить даже при пустой ячейке.
  const matchedOperators = new Map<string, { column: string; fallback: string }>();
  for (const m of operatorMapping ?? []) {
    if (!m?.operator) continue;
    if (m.matched && m.column) {
      if (!operatorByColumn.has(m.column)) operatorByColumn.set(m.column, m.operator);
      if (!matchedOperators.has(m.operator)) {
        matchedOperators.set(m.operator, { column: m.column, fallback: (m.fallback ?? '').trim() });
      }
    } else if (!m.matched) {
      const f = (m.fallback ?? '').trim();
      if (f && !unmatchedFallbacks.has(m.operator)) unmatchedFallbacks.set(m.operator, f);
    }
  }

  const leads: LeadCreatePayload[] = [];
  const leadRowIndices: number[] = [];
  const seenEmails = new Set<string>();

  rows.forEach((row, rowIndex) => {
    const email = String(row[emailColumn] ?? '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return;
    if (seenEmails.has(email)) return;
    seenEmails.add(email);

    const lead: LeadCreatePayload = { email };
    const customVars: Record<string, string> = {};

    for (const col of columns) {
      if (col === emailColumn) continue;
      const val = String(row[col] ?? '').trim();
      if (!val) continue;
      customVars[operatorByColumn.get(col) ?? col] = val;
    }
    // matched-операторы без значения (пустая ячейка/колонка вне списка):
    // fallback → иначе пустая строка (parity с превью, никаких литералов {{var}}).
    for (const [op, spec] of matchedOperators) {
      if (customVars[op] !== undefined) continue;
      customVars[op] = spec.fallback || '';
    }
    for (const [op, fallback] of unmatchedFallbacks) {
      if (customVars[op] === undefined) customVars[op] = fallback;
    }

    if (Object.keys(customVars).length > 0) {
      lead.custom_variables = customVars;
    }
    leads.push(lead);
    leadRowIndices.push(rowIndex);
  });

  return { leads, emailColumn, leadRowIndices };
}
