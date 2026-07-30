/**
 * «Последняя миля» мастера «Движка вертикалей»: подготовка данных для
 * отправки готового шаблона (шаг 5) в запуск — создание PAUSED-кампании
 * в Instantly с лидами базы и цепочкой шаблона.
 *
 * Модуль ЧИСТЫЙ (без server-only/DB/фетчей): собирает sequence из писем
 * шаблона и маппит строки базы в лиды. HTTP-роут
 * (api/tools/hypothesis-engine/templates/[id]/launch) делает все вызовы
 * Instantly/Supabase сам, переиспользуя клиентский стек запуска:
 *   - buildCampaignPayloadFromPreset (delay-лесенка, HTML-обёртка, text_only,
 *     расписание/лимиты/трекинг из пресета);
 *   - instantly client createCampaign → (updateCampaign, если Instantly
 *     не принял sequences) → createLeads (чанкует по 1000 внутри);
 *   - activateCampaign НЕ вызывается никогда — сотрудник проверяет кампанию
 *     в Instantly и запускает вручную.
 *
 * Отличия от клиентского runLaunch осознанные:
 *   - нет тарифных гейтов/чёрного списка клиента/журнала client_campaign_launches
 *     (запуск делает сотрудник из внутреннего инструмента, billing клиента не
 *     должен меняться);
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
import type { HeChainLetter, HeOperatorMapping } from './types';

/** Максимум лидов за один запуск из мастера (v1-ограничение роута, 413 сверх). */
export const HE_LAUNCH_MAX_LEADS = 2000;

/**
 * Запись о запуске, сохраняемая в `he_templates.launch_info` (jsonb).
 * NB: колонка появляется отдельной миграцией — до неё роут создаёт кампанию,
 * но предупреждает, что запись не сохранилась.
 */
export interface HeTemplateLaunchInfo {
  campaign_id: string;
  campaign_name: string;
  campaign_url: string;
  leads_count: number;
  preset_id: string;
  created_at: string;
}

/** Пункт селектора пресетов (GET launch): id + человекочитаемое имя клиента. */
export interface HeLaunchPresetOption {
  id: string;
  name: string;
}

/** Аккуратно прочитать launch_info из jsonb (могло прийти что угодно). */
export function parseLaunchInfo(raw: unknown): HeTemplateLaunchInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.campaign_id !== 'string' || r.campaign_id.length === 0) return null;
  return {
    campaign_id: r.campaign_id,
    campaign_name: typeof r.campaign_name === 'string' ? r.campaign_name : '',
    campaign_url: typeof r.campaign_url === 'string' ? r.campaign_url : '',
    leads_count: typeof r.leads_count === 'number' && Number.isFinite(r.leads_count) ? r.leads_count : 0,
    preset_id: typeof r.preset_id === 'string' ? r.preset_id : '',
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
  };
}

/** Ссылка на кампанию в Instantly (та же база URL, что и в остальном портале). */
export function instantlyCampaignUrl(campaignId: string): string {
  return `https://app.instantly.ai/app/campaign/${campaignId}`;
}

/** Имя кампании: узнаваемое в списке Instantly, с датой запуска. */
export function buildLaunchCampaignName(baseFilename: string | null | undefined, now = new Date()): string {
  const base = (baseFilename ?? '').trim() || 'база';
  return `HE · ${base} · ${now.toISOString().slice(0, 10)}`.slice(0, 200);
}

export interface HeLaunchSequence {
  steps: ClientLaunchSequenceStep[];
  /** Сколько сегментных вариантов выкинуто (Instantly не умеет условные блоки). */
  droppedSegmentVariants: number;
  /** В скольких письмах были сегментные варианты. */
  lettersWithSegmentVariants: number;
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
 *   - segment_variants НЕ переносятся (условные блоки Instantly не исполняет) —
 *     только считаем, чтобы роут вернул явное предупреждение.
 *
 * Возвращает null, если писем нет.
 */
export function buildLaunchSequence(
  letters: HeChainLetter[] | null | undefined,
): HeLaunchSequence | null {
  if (!Array.isArray(letters) || letters.length === 0) return null;

  let droppedSegmentVariants = 0;
  let lettersWithSegmentVariants = 0;

  const steps = letters.map<ClientLaunchSequenceStep>((letter, i) => {
    const segCount = (letter.segment_variants ?? []).length;
    if (segCount > 0) {
      droppedSegmentVariants += segCount;
      lettersWithSegmentVariants += 1;
    }
    const first = i === 0;
    return {
      subject: first ? letter.subject ?? '' : '',
      body: letter.body ?? '',
      wait_days:
        typeof letter.wait_days === 'number' && Number.isFinite(letter.wait_days)
          ? letter.wait_days
          : 0,
      variants: (letter.variants ?? [])
        .slice(0, CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP - 1)
        .map((v) => ({ subject: first ? v.subject ?? '' : '', body: v.body ?? '' })),
    };
  });

  return { steps, droppedSegmentVariants, lettersWithSegmentVariants };
}

/** Текст предупреждения о выкинутых сегментных вариантах (null — если нечего). */
export function segmentVariantsWarning(sequence: HeLaunchSequence): string | null {
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
  operatorMapping?: HeOperatorMapping[];
}

export interface MapBaseRowsResult {
  leads: LeadCreatePayload[];
  /** Колонка, из которой взят email (null — не нашли → лидов нет). */
  emailColumn: string | null;
}

/**
 * Строки he_bases.data → лиды Instantly, по мотивам mapCsvRowsToLeads:
 *   - email обязателен, lowercase, дедуп;
 *   - operator_mapping применяется ТОЛЬКО для именования переменных: matched
 *     оператор «var → колонка» кладёт значение ячейки в custom_variables под
 *     именем оператора (так {{var}} в письме подставится на стороне Instantly).
 *     Значения НЕ трансформируются: никаких fallback-подстановок и сегментной
 *     логики — письмо уходит как написано;
 *   - остальные колонки проходят в custom_variables под своими именами.
 */
export function mapBaseRowsToLeads(input: MapBaseRowsInput): MapBaseRowsResult {
  const { rows, columns, operatorMapping } = input;

  const emailColumn = findEmailColumn(columns, rows);
  if (!emailColumn) return { leads: [], emailColumn: null };

  // column → operator (первый matched-оператор на колонку выигрывает).
  const operatorByColumn = new Map<string, string>();
  for (const m of operatorMapping ?? []) {
    if (!m?.matched || !m.column || !m.operator) continue;
    if (!operatorByColumn.has(m.column)) operatorByColumn.set(m.column, m.operator);
  }

  const leads: LeadCreatePayload[] = [];
  const seenEmails = new Set<string>();

  for (const row of rows) {
    const email = String(row[emailColumn] ?? '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) continue;
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);

    const lead: LeadCreatePayload = { email };
    const customVars: Record<string, string> = {};

    for (const col of columns) {
      if (col === emailColumn) continue;
      const val = String(row[col] ?? '').trim();
      if (!val) continue;
      customVars[operatorByColumn.get(col) ?? col] = val;
    }

    if (Object.keys(customVars).length > 0) {
      lead.custom_variables = customVars;
    }
    leads.push(lead);
  }

  return { leads, emailColumn };
}
