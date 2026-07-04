import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import {
  CLEANUP_JSON_SYSTEM_PROMPT,
  CLEANUP_BATCH,
  buildCleanupUserMessage,
  parseCleanupResponseJson,
  parseCleanupResponse,
} from '@/lib/nameCleanupProtocol';

const TIMEOUT_MS = 70_000;

function getApiKey(): string {
  return (process.env.OPENROUTER_AGENT_API_KEY ?? '').trim();
}

/**
 * JSON-протокол nameCleanupProtocol — как в base-constructor'е. До 04.07.2026
 * тут была своя копия нумерованного текста: один уровень «N. » срезался, но
 * двойные префиксы протекали, а сбой нумерации молча терял хвост батча.
 * Возвращает Map с 1-based ключами (контракт parseCleanupResponseJson).
 */
async function callCleanupLlm(names: string[]): Promise<Map<number, string>> {
  const apiKey = getApiKey();
  if (!apiKey) return new Map();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - Agent Name Cleanup',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'policy/cleanup',
        messages: [
          { role: 'system', content: CLEANUP_JSON_SYSTEM_PROMPT },
          { role: 'user', content: buildCleanupUserMessage(names.map((n) => ({ name: n }))) },
        ],
        temperature: 0.1,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) return new Map();

    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) return new Map();

    return parseCleanupResponseJson(content)
      ?? parseCleanupResponse(content, names.length)
      ?? new Map();
  } catch {
    return new Map();
  } finally {
    clearTimeout(timeout);
  }
}

const NAME_COLUMN_MAP: Record<string, string> = {
  hh_vacancies: 'company_name',
  search_results: 'company_name',
  yandex_maps_organizations: 'name',
};

const JOB_ID_TABLE_MAP: Record<string, string> = {
  hh: 'hh_vacancies',
  search: 'search_results',
  yandex_maps: 'yandex_maps_organizations',
};

const JOB_TABLE_MAP: Record<string, string> = {
  hh: 'parser_jobs',
  search: 'search_parser_jobs',
  yandex_maps: 'yandex_maps_jobs',
};

async function resolveParserType(jobId: string): Promise<string | null> {
  const sb = supabaseAdmin!;
  for (const [type, table] of Object.entries(JOB_TABLE_MAP)) {
    const { data } = await sb.from(table).select('id').eq('id', jobId).maybeSingle();
    if (data) return type;
  }
  return null;
}

export async function cleanCompanyNames(
  jobId: string,
  parserType?: string,
): Promise<{ cleaned: number; total: number } | string> {
  if (!supabaseAdmin) return 'Supabase admin not configured';
  const sb = supabaseAdmin;

  const resolvedType = parserType || await resolveParserType(jobId);
  if (!resolvedType) return 'Задача не найдена.';

  const resultTable = JOB_ID_TABLE_MAP[resolvedType];
  if (!resultTable) return `Неизвестный тип парсера: ${resolvedType}`;

  const nameCol = NAME_COLUMN_MAP[resultTable];
  if (!nameCol) return 'Не удалось определить колонку с названием компании.';

  const { data: rows, error } = await sb
    .from(resultTable)
    .select(`id, ${nameCol}`)
    .eq('job_id', jobId)
    .not(nameCol, 'is', null);

  if (error) return `Ошибка: ${error.message}`;
  if (!rows?.length) return 'Нет записей для очистки.';

  type Row = { id: string } & Record<string, unknown>;
  const typedRows = rows as unknown as Row[];
  let cleanedCount = 0;

  for (let i = 0; i < typedRows.length; i += CLEANUP_BATCH) {
    const batch = typedRows.slice(i, i + CLEANUP_BATCH);
    const names = batch.map((r) => String(r[nameCol] ?? ''));

    const cleanedMap = await callCleanupLlm(names);
    if (cleanedMap.size === 0) continue;

    for (let j = 0; j < batch.length; j++) {
      const cleaned = cleanedMap.get(j + 1);
      if (cleaned && cleaned !== names[j]) {
        const { error: updateErr } = await sb
          .from(resultTable)
          .update({ [nameCol]: cleaned })
          .eq('id', batch[j].id);

        if (!updateErr) cleanedCount++;
      }
    }
  }

  return { cleaned: cleanedCount, total: typedRows.length };
}

export async function cleanNamesForPipelineStep(
  jobId: string,
  parserType: string,
): Promise<void> {
  const result = await cleanCompanyNames(jobId, parserType);
  if (typeof result === 'string') {
    await logError('telegram-agent.pipeline.clean-names-error', new Error(result));
  }
}
