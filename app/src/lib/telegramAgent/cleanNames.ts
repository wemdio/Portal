import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';

const BATCH_SIZE = 100;
const TIMEOUT_MS = 70_000;

const CLEANUP_PROMPT = `Ты очищаешь названия компаний для использования в персонализированных email-письмах.

Правила:
1. Оставь только само название (2-3 слова максимум)
2. Удали: Inc, Ltd, Corp, LLC, ООО, ИП, АО, ЗАО, ПАО, ГК, НКО, GmbH и т.п.
3. Удали текст после: -, |, /, ,, :
4. Удали текст в скобках
5. Удали символы: ®, ™, ©, #, !, ?
6. Если >3 слов — сделай аббревиатуру (если уместно)
7. Если всё КАПСОМ (6+ букв) — преобразуй в Title Case
8. Результат должен красиво звучать в предложении: "Я заметил что КОМПАНИЯ..."

ФОРМАТ: Очищенные названия с нумерацией строго в формате:
1. Название
2. Название
...и так далее.
Без пояснений, без кавычек. Количество строк = количеству входных компаний. Порядок и нумерация те же.
Если не знаешь как очистить — верни оригинальное название с его номером. НИКОГДА не пропускай строки.`;

function getApiKey(): string {
  return (process.env.OPENROUTER_AGENT_API_KEY ?? '').trim();
}

async function callCleanupLlm(names: string[]): Promise<Map<number, string>> {
  const apiKey = getApiKey();
  if (!apiKey) return new Map();

  const input = names.map((n, i) => `${i + 1}. ${n}`).join('\n');

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
          { role: 'system', content: CLEANUP_PROMPT },
          { role: 'user', content: input },
        ],
        temperature: 0.1,
        max_tokens: 4000,
      }),
    });

    if (!res.ok) return new Map();

    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';

    const result = new Map<number, string>();
    for (const line of content.split('\n')) {
      const match = line.trim().match(/^(\d+)\.\s*(.+)/);
      if (match) {
        result.set(parseInt(match[1], 10), match[2].trim());
      }
    }
    return result;
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

  for (let i = 0; i < typedRows.length; i += BATCH_SIZE) {
    const batch = typedRows.slice(i, i + BATCH_SIZE);
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
