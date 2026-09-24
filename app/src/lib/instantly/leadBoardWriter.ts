import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import { createBoardToken, boardTokenSecret, boardUrl } from '@/lib/leadBoard/boardToken';
import { resolveCampaignProjectOwner } from './campaignProjectOwnerResolver';
import { joinLeadPhones } from './leadContactValues';

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
  /** Current reply; qualificationId remains the elected thread's winner. */
  sourceQualificationId?: string;
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
 * qualificationId is the elected project/thread winner, not each new reply's
 * qualification. The unique key arbitrates concurrent first inserts. Subsequent
 * replies only fill gaps, union phones and append new authored answers; existing
 * text/manual values remain intact. Quality/comment/taken/custom are never sent.
 */
export async function upsertBoardRow(db: InstantlyDb, input: BoardRowInput): Promise<void> {
  const sourceId = input.sourceQualificationId ?? input.qualificationId;
  const payload = {
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
    };
  const { error } = await db.from('project_lead_board_rows').upsert(
    { ...payload, auto_reply_ids: [sourceId] },
    { onConflict: 'qualification_id', ignoreDuplicates: true },
  );
  if (error) {
    if (['42703', 'PGRST204'].includes(error.code ?? '') && /auto_reply_ids/iu.test(error.message)) {
      // A worker can roll before PostgREST refreshes its migration/schema cache.
      // Keep first-lead delivery/table creation working in insert-only mode;
      // never guess idempotency from editable text while the ledger is absent.
      const legacy = await db.from('project_lead_board_rows').upsert(payload,
        { onConflict: 'qualification_id', ignoreDuplicates: true });
      if (legacy.error) throw new Error(`lead board compatibility insert failed: ${legacy.error.message}`);
      throw new Error('lead board row retained in insert-only mode; auto_reply_ids migration/schema refresh required');
    }
    throw new Error(`project_lead_board_rows upsert failed: ${error.message}`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: row, error: readError } = await db.from('project_lead_board_rows')
      .select('id, project_id, lead_name, company_name, phone, website, request_text, auto_reply_ids, updated_at')
      .eq('qualification_id', input.qualificationId).maybeSingle();
    if (readError || !row) throw new Error(`lead board merge read failed: ${readError?.message ?? 'missing row'}`);
    if (row.project_id !== input.projectId) throw new Error('lead board merge refused: different project');
    const seen: string[] = Array.isArray(row.auto_reply_ids) && row.auto_reply_ids.length
      ? row.auto_reply_ids : [input.qualificationId];
    if (seen.includes(sourceId)) return;
    const patch: Record<string, string | string[]> = { auto_reply_ids: [...seen, sourceId] };
    for (const [key, value] of [['lead_name', input.leadName], ['company_name', input.companyName], ['website', input.website]] as const) {
      if (!row[key]?.trim() && value) patch[key] = value;
    }
    // Keep manually entered values/formatting first, including long legacy
    // fields. New automatic values must never truncate an existing field.
    const phone = joinLeadPhones([row.phone, input.phone], Math.max(200, row.phone?.length ?? 0));
    if (phone && phone !== row.phone && (!row.phone || phone.startsWith(row.phone))) patch.phone = phone;
    const request = appendBoardReply(row.request_text, input.requestText, input.replyTimestamp);
    if (request && request !== row.request_text) patch.request_text = request;
    if (!row.updated_at) throw new Error('lead board merge refused: missing row version');
    patch.updated_at = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
    const { data: updated, error: updateError } = await db.from('project_lead_board_rows')
      .update(patch).eq('id', row.id).eq('project_id', input.projectId)
      .eq('updated_at', row.updated_at).select('id').maybeSingle();
    if (updateError) throw new Error(`lead board merge failed: ${updateError.message}`);
    if (updated) return;
    // A specialist or another reply won the race: reread and merge again,
    // never overwrite the newer request/contact value with our stale copy.
  }
  throw new Error('lead board merge deferred: concurrent edits');
}

function appendBoardReply(existing: string | null, incoming: string | null, timestamp: string | null): string | null {
  if (!incoming?.trim()) return existing;
  if (!existing?.trim()) return incoming;
  const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const firstReply = existing.split(/\n\nДополнительный ответ(?: \([^\n]+\))?:\n/u)[0];
  if (normalize(firstReply) === normalize(incoming)) return existing;
  const date = timestamp && Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : null;
  const block = `Дополнительный ответ${date ? ` (${date})` : ''}:\n${incoming.trim()}`;
  if (normalize(existing).includes(normalize(block))) return existing;
  return `${existing}\n\n${block}`;
}
