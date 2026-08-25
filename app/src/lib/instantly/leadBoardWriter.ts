import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createBoardToken, boardTokenSecret, boardUrl } from '@/lib/leadBoard/boardToken';
import { resolveCampaignProjectOwner } from './campaignProjectOwnerResolver';

export { resolveCampaignProjectOwner } from './campaignProjectOwnerResolver';
export type { CampaignProjectOwnerResolution } from './campaignProjectOwnerResolver';

/**
 * Гостевая таблица лидов проекта (lead board): создание/чтение доски и запись
 * авто-строк при квалификации лида (status='lead', project-linked кампания).
 *
 * Токен — постоянный capability (печатается в каждой TG-карточке лида), поэтому
 * доска создаётся лениво при первом лиде проекта и дальше только читается.
 * Отзыв ссылки — регенерация токена через staff-API (manage route).
 */

type InstantlyDb = NonNullable<typeof supabaseInstantly>;

export interface BoardColumnConfigEntry {
  key: string;
  visible: boolean;
  /** Кастомная колонка: лейбл из конфига (builtin берут из BOARD_COLUMN_LABELS). */
  label?: string;
  /** Признак кастомной колонки (значения лидов — в rows.custom[key]). */
  custom?: boolean;
}

/** Базовый набор (скриншот Asti Group) — зеркало DEFAULT в миграции 20260726_0001. */
export const DEFAULT_COLUMN_CONFIG: BoardColumnConfigEntry[] = [
  { key: 'phone', visible: true },
  { key: 'email', visible: true },
  { key: 'name', visible: true },
  { key: 'company', visible: true },
  { key: 'website', visible: true },
  { key: 'request', visible: true },
  { key: 'quality', visible: true },
  { key: 'comment', visible: true },
  { key: 'campaign', visible: true },
  { key: 'step', visible: true },
  { key: 'date', visible: true },
  { key: 'taken', visible: true },
];

export function parseColumnConfig(raw: unknown): BoardColumnConfigEntry[] {
  if (!Array.isArray(raw)) return DEFAULT_COLUMN_CONFIG;
  const out: BoardColumnConfigEntry[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { key?: unknown }).key === 'string'
    ) {
      const it = item as { key: string; visible?: unknown; label?: unknown; custom?: unknown };
      const entry: BoardColumnConfigEntry = {
        key: it.key,
        visible: it.visible !== false,
      };
      // Кастомные колонки: лейбл/флаг сохраняем (иначе при чтении конфига
      // из БД они терялись бы и кастомная колонка превращалась в безымянную).
      if (typeof it.label === 'string' && it.label) entry.label = it.label;
      if (it.custom === true) entry.custom = true;
      out.push(entry);
    }
  }
  return out.length > 0 ? out : DEFAULT_COLUMN_CONFIG;
}

/** Кампания → доказанный единственный проект; ambiguity/none → null. */
export async function resolveBoardProjectId(
  db: InstantlyDb,
  campaignId: string,
): Promise<string | null> {
  const owner = await resolveCampaignProjectOwner(db, campaignId);
  return owner.status === 'resolved' ? owner.projectId : null;
}

export interface LeadBoard {
  projectId: string;
  token: string;
  columnConfig: BoardColumnConfigEntry[];
}

export async function getOrCreateBoard(db: InstantlyDb, projectId: string): Promise<LeadBoard> {
  const { data: existing } = await db
    .from('project_lead_boards')
    .select('token, column_config')
    .eq('project_id', projectId)
    .maybeSingle();
  if (existing?.token) {
    return {
      projectId,
      token: existing.token as string,
      columnConfig: parseColumnConfig(existing.column_config),
    };
  }

  const token = createBoardToken(projectId, boardTokenSecret());
  const { data: inserted, error } = await db
    .from('project_lead_boards')
    .insert({ project_id: projectId, token })
    .select('token, column_config')
    .maybeSingle();
  if (error || !inserted?.token) {
    // Гонка двух одновременных первых лидов проекта: перечитываем чужую вставку.
    const { data: again } = await db
      .from('project_lead_boards')
      .select('token, column_config')
      .eq('project_id', projectId)
      .maybeSingle();
    if (again?.token) {
      return { projectId, token: again.token as string, columnConfig: parseColumnConfig(again.column_config) };
    }
    throw new Error(`project_lead_boards insert failed: ${error?.message ?? 'no row returned'}`);
  }
  return { projectId, token: inserted.token as string, columnConfig: parseColumnConfig(inserted.column_config) };
}

/**
 * Ссылка «Все лиды проекта» для TG-карточки. НИКОГДА не бросает: ссылка —
 * необязательное дополнение алерта, его доставка важнее (null = без строки).
 */
export async function getBoardLinkForProject(
  db: InstantlyDb,
  projectId: string,
): Promise<string | null> {
  try {
    const board = await getOrCreateBoard(db, projectId);
    return boardUrl(board.token);
  } catch {
    return null;
  }
}

/** Вариант по campaignId: резолвит проект (period-ссылки приоритетнее) и отдаёт ссылку. */
export async function getBoardLinkForCampaign(
  db: InstantlyDb,
  campaignId: string,
): Promise<string | null> {
  try {
    const projectId = await resolveBoardProjectId(db, campaignId);
    if (!projectId) return null;
    return await getBoardLinkForProject(db, projectId);
  } catch {
    return null;
  }
}

export interface BoardRowInput {
  qualificationId: string;
  projectId: string;
  campaignId: string | null;
  campaignName: string | null;
  leadEmail: string | null;
  leadName: string | null;
  companyName: string | null;
  phone: string | null;
  website: string | null;
  requestText: string | null;
  stepNumber: number | null;
  replyTimestamp: string | null;
}

/**
 * Авто-строка доски. upsert + ignoreDuplicates = INSERT ... ON CONFLICT DO NOTHING
 * (как дедуп квалификаций в воркере): повторная запись того же лида — no-op, а
 * клиентские колонки (quality/comment/taken) гарантированно не затираются —
 * их нет в payload и конфликт не обновляет строку.
 */
export async function upsertBoardRow(db: InstantlyDb, input: BoardRowInput): Promise<void> {
  const { error } = await db.from('project_lead_board_rows').upsert(
    {
      project_id: input.projectId,
      qualification_id: input.qualificationId,
      campaign_id: input.campaignId,
      campaign_name: input.campaignName,
      lead_email: input.leadEmail,
      lead_name: input.leadName,
      company_name: input.companyName,
      phone: input.phone,
      website: input.website,
      request_text: input.requestText,
      step_number: input.stepNumber,
      reply_timestamp: input.replyTimestamp,
    },
    { onConflict: 'qualification_id', ignoreDuplicates: true },
  );
  if (error) throw new Error(`project_lead_board_rows upsert failed: ${error.message}`);
}
