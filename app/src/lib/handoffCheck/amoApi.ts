/**
 * Живое чтение сделки из AMO для проверки карточки при передаче проекта
 * (спека `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md`, §5,
 * план Task 4). Не путать с ночным синком `amo_leads` — синк раз в сутки, а
 * передача проверяется сразу через `GET /api/v4/leads/<id>`.
 *
 * URL и заголовки повторяют `services/portal-external-sync/sources/amo.py`:
 * `AMO_BASE_URL` может быть с протоколом или без, `AMO_ACCESS_TOKEN` — bearer.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeInn } from '@/lib/firstSales/money';
import type { CardData } from './checkCard';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Сеть, 5xx или 401 при чтении сделки из AMO — воркер (Task 5) ловит это и
 * заводит проблему `AMO_UNAVAILABLE` без ответа в чат, а не падает.
 */
export class AmoUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AmoUnavailableError';
  }
}

function baseUrl(): string {
  const raw = (process.env.AMO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new AmoUnavailableError('AMO_BASE_URL is not set');
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

function token(): string {
  const raw = (process.env.AMO_ACCESS_TOKEN ?? '').trim();
  if (!raw) throw new AmoUnavailableError('AMO_ACCESS_TOKEN is not set');
  return raw;
}

type AmoCustomFieldValue = { value?: unknown };
type AmoCustomField = {
  field_name?: string;
  values?: AmoCustomFieldValue[];
};
type AmoLeadResponse = {
  id?: number;
  pipeline_id?: number;
  status_id?: number;
  price?: number;
  responsible_user_id?: number;
  custom_fields_values?: AmoCustomField[] | null;
};

function customFieldValue(fields: AmoCustomField[] | null | undefined, fieldName: string): string | null {
  for (const field of fields ?? []) {
    if ((field.field_name ?? '').trim() !== fieldName) continue;
    const value = field.values?.[0]?.value;
    if (value === null || value === undefined) return null;
    return String(value);
  }
  return null;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new AmoUnavailableError('AMO request failed (network)', error);
  } finally {
    clearTimeout(timer);
  }
}

const NOT_FOUND: CardData = {
  found: false,
  pipelineId: null,
  statusId: null,
  statusName: null,
  pipelineName: null,
  price: null,
  responsibleUserId: null,
  inn: null,
  source: null,
  innDuplicates: [],
};

async function lookupStatusName(
  db: SupabaseClient,
  pipelineId: number | null,
  statusId: number | null,
): Promise<{ statusName: string | null; pipelineName: string | null }> {
  if (pipelineId == null || statusId == null) return { statusName: null, pipelineName: null };
  const { data, error } = await db
    .from('amo_statuses')
    .select('status_name, pipeline_name')
    .eq('pipeline_id', pipelineId)
    .eq('status_id', statusId)
    .maybeSingle();
  if (error || !data) return { statusName: null, pipelineName: null };
  return {
    statusName: (data as { status_name: string | null }).status_name ?? null,
    pipelineName: (data as { pipeline_name: string | null }).pipeline_name ?? null,
  };
}

async function findInnDuplicates(
  db: SupabaseClient,
  pipelineId: number | null,
  amoId: number,
  inn: string,
): Promise<Array<{ amoId: number; name: string | null }>> {
  if (pipelineId == null) return [];
  const { data, error } = await db.rpc('handoff_inn_duplicates', {
    p_pipeline_id: pipelineId,
    p_inn: inn,
    p_exclude_amo_id: amoId,
  });
  if (error || !data) return [];
  return (data as Array<{ amo_id: number; name: string | null }>).map((row) => ({
    amoId: row.amo_id,
    name: row.name,
  }));
}

/**
 * Читает сделку из AMO живьём. 404/204 → `found:false` (сделки нет или её
 * скрыли правами токена — не повод падать). Сеть/5xx/401 → `AmoUnavailableError`.
 */
export async function fetchCard(db: SupabaseClient, amoId: number): Promise<CardData> {
  const url = `${baseUrl()}/api/v4/leads/${amoId}`;
  const response = await fetchWithTimeout(url, { Authorization: `Bearer ${token()}` });

  if (response.status === 404 || response.status === 204) {
    return NOT_FOUND;
  }
  if (!response.ok) {
    // Любой другой не-2xx — сбой, не «сделки нет»: 429 — рейт-лимит AMO,
    // 401/403 — токен/права, остальные 4xx и 5xx — тоже не повод молчать в
    // чат «сделка не найдена». Повтор (ручной или ежедневный) может дать
    // другой результат — в отличие от честного 404/204.
    throw new AmoUnavailableError(`AMO request failed: HTTP ${response.status}`);
  }

  const lead = (await response.json().catch(() => null)) as AmoLeadResponse | null;
  if (!lead || typeof lead.id !== 'number') return NOT_FOUND;

  const pipelineId = typeof lead.pipeline_id === 'number' ? lead.pipeline_id : null;
  const statusId = typeof lead.status_id === 'number' ? lead.status_id : null;
  const { statusName, pipelineName } = await lookupStatusName(db, pipelineId, statusId);

  const inn = customFieldValue(lead.custom_fields_values, 'ИНН');
  const source = customFieldValue(lead.custom_fields_values, 'Источник');

  const normalizedInn = normalizeInn(inn);
  const innDuplicates = normalizedInn ? await findInnDuplicates(db, pipelineId, amoId, normalizedInn) : [];

  return {
    found: true,
    pipelineId,
    statusId,
    statusName,
    pipelineName,
    price: typeof lead.price === 'number' ? lead.price : null,
    responsibleUserId: typeof lead.responsible_user_id === 'number' ? lead.responsible_user_id : null,
    inn,
    source,
    innDuplicates,
  };
}
