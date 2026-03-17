import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildHeuristicCleanupResults, type CompanyCleanupEntry } from '@/lib/companyNameCleanup';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_CLEANUP_API_KEY = process.env.OPENROUTER_CLEANUP_API_KEY ?? '';
const CLEANUP_MODEL = 'policy/cleanup';
const OPENROUTER_TIMEOUT_MS = 70000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const SYSTEM_PROMPT = `Сейчас я пришлю тебе названия компаний.
1)Основная задача оставить только название компании, которое потом будет использоваться как автоматическая переменная для персонализации писем (поэтому название компании должно быть без лишней информации). Ты должен вернуть список очищенных названий в той же последовательности с нумерацией (1. 2. 3. и т.д.). Убери всё то, что не является названием, а лишь его описанием.
2)Это должно выглядеть так: Я заметил что "КОМПАНИЯ" имеет большое количество сотрудников.
Вместо слова "компания" будут вставляться эти названия компаний. Они должны логично звучать.
3)Ориентируйся также на название домена этой компании при очистке, чтобы не обрезать лишнего. Действуй в совокупности. Если в домене есть что-то полезное для правильной корректировки названия компании, то учитывай это. (но это не значит что надо писать все слова слитно и с маленькой буквы, т.е. не просто скопировать название домена, а просто понять, как сокращенно может писаться название компании). Например, название компании: IBEX IT Business Experts. А домен компании: http://www.ibexexperts.com. Тогда очищенное название компании: IBEX Experts и так далее.
4)Вот остальной примерный план по очистке:
Удаление текста после определенных символов:
Удаляет все текст после первого знака дефиса (включая сам знак дефиса).
Удаляет все текст после символа "|" (включая сам символ "|").
Удаляет все текст после символа "/" (включая сам символ "/").
Удаляет все текст после символа "," (включая сам символ ",").
Удаляет все текст после символа ":" (включая сам символ ":").
Удаление определенных символов и фраз:
Удаляет символы: "®", "™", "©", "#", "!", "?".
Удаляет определенные слова и фразы: "Incorporated", "Inc", "Limited", "Ltd", "dba", "Corp", и другие подобные слова, а также названия стран и суффиксы (.com, .uk и т.п.).
5)Удаление текста внутри скобок:
Удаляет весь текст, который находится внутри скобок (включая сами скобки).
Преобразование текста к формату "Название С Заглавной Буквы":
6)Если ячейка содержит слово, состоящее из шести или более заглавных букв, то все слова в ячейке преобразуются к формату "Название С Заглавной Буквы".
Преобразование текста в аббревиатуру:
Если в ячейке текст содержит более 3 слов, то необходимо привести этот текст в формат аббревиатуры, если такое возможно.
7)Будь аккуратен и точен. Грамотно очищай названия компаний, чтобы их можно было в дальнейшем использовать в письмах и в них не оставалось лишних слов, не относящихся к названию компании.
8)Вот пару примеров по очистке:
Было: CGT Staffing (CompuGroup Technologies)
Стало: CGT Staffing
Было: Albano Systems, Inc.
Стало: Albano Systems
Было: Alliance of Professionals & Consultants, Inc. (APC)
Стало: APC
Было: BIO-key International, Inc. Домен: http://www.bio-key.com
Стало: BIO-key
Было: QuesTek Innovations LLC Домен: http://www.questek.com
Стало: QuesTek
9) Самое главное, чтобы результат был не более 2-3 слов и имел красивый, логичный и читаемый вид (включая аббревиатуры) ЭТО ОЧЕНЬ ВАЖНО!!!

ФОРМАТ ОТВЕТА:
Верни очищенные названия с нумерацией строго в формате:
1. Название
2. Название
3. Название
...и так далее.
Без пояснений, без кавычек. Количество строк в ответе должно ТОЧНО совпадать с количеством компаний во входных данных.
Порядок и нумерация должны быть ТОЧНО такими же, как во входных данных. Если не знаешь как очистить — верни оригинальное название с его номером.
НИКОГДА не пропускай строки. Если на входе 100 компаний — в ответе должно быть ровно 100 пронумерованных строк.`;

type RequestBody = {
  companies: CompanyCleanupEntry[];
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

function getFetchFailureReason(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) {
    const cause = err.cause as Error & { code?: string };
    const code = cause.code ?? '';
    const message = cause.message ?? '';
    if (code && message) return `${code}: ${message}`;
    if (code) return code;
    if (message) return message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function POST(req: NextRequest) {
  // --- Auth ---
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  // --- Check API key ---
  if (!OPENROUTER_CLEANUP_API_KEY) {
    return jsonError('OPENROUTER_CLEANUP_API_KEY not configured on server', 500);
  }

  // --- Parse body ---
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { companies } = body;
  if (!Array.isArray(companies) || companies.length === 0) {
    return jsonError('Missing required field: companies (non-empty array)', 400);
  }

  // --- Build user message (numbered for reliable mapping) ---
  const companyLines = companies.map((c, i) => {
    const num = i + 1;
    if (c.domain && c.domain.trim()) {
      return `${num}. ${c.name} Домен: ${c.domain.trim()}`;
    }
    return `${num}. ${c.name}`;
  });

  const userMessage = companyLines.join('\n');

  // --- Call Requesty with routing policy (handles fallback internally) ---

  let lastAiError = 'Unknown AI error';
  let sawNonRetryableFailure = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response: Response;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
      response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_CLEANUP_API_KEY}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Name Cleanup',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: CLEANUP_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: 4000,
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        lastAiError = 'Превышено время ожидания ответа от AI';
      } else {
        lastAiError = `Ошибка сети при обращении к AI: ${getFetchFailureReason(err)}`;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
      break;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';

      if (!content) {
        lastAiError = 'Пустой ответ от AI';
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
          continue;
        }
        break;
      }

      // Parse numbered response: "1. Name", "2. Name", etc.
      const lines = content.split('\n').map((line: string) => line.trim());
      const numberedMap = new Map<number, string>();

      for (const line of lines) {
        if (!line) continue;
        const match = line.match(/^(\d+)\.\s*(.+)/);
        if (match) {
          numberedMap.set(parseInt(match[1], 10), match[2].trim());
        }
      }

      let results: { idx: number; cleanedName: string }[];

      if (numberedMap.size >= companies.length * 0.8) {
        // Numbered format detected — map by number
        results = companies.map((c, i) => ({
          idx: c.idx,
          cleanedName: numberedMap.get(i + 1) || c.name,
        }));
      } else {
        // Fallback: positional mapping (non-empty lines only)
        const cleanedNames = lines.filter((l: string) => l.length > 0);
        results = companies.map((c, i) => ({
          idx: c.idx,
          cleanedName: cleanedNames[i] && cleanedNames[i].length > 0
            ? cleanedNames[i]
            : c.name,
        }));
      }

      return NextResponse.json({ results });
    }

    let errorMessage = `API error: ${response.status}`;
    try {
      const errorData = await response.json() as { error?: { message?: string } | string };
      if (typeof errorData.error === 'string') {
        errorMessage = errorData.error;
      } else if (typeof errorData.error?.message === 'string') {
        errorMessage = errorData.error.message;
      }
    } catch {
      // ignore
    }

    lastAiError = errorMessage;
    const providerError = /provider returned error/i.test(errorMessage);
    const shouldRetry = providerError || [500, 502, 503, 504].includes(response.status);
    if (!shouldRetry) {
      sawNonRetryableFailure = true;
    }
    if (shouldRetry && attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
      continue;
    }
    break;
  }

  if (!sawNonRetryableFailure) {
    const results = buildHeuristicCleanupResults(companies);
    const warning = `AI временно недоступен, применена локальная очистка. Модель: ${CLEANUP_MODEL}. Причина: ${lastAiError}`;

    console.warn('[cleanup-names] Falling back to heuristic cleanup', {
      model: CLEANUP_MODEL,
      companyCount: companies.length,
      reason: lastAiError,
    });

    return NextResponse.json(
      { results, warning },
      { headers: { 'X-Portal-Name-Cleanup-Fallback': 'heuristic' } },
    );
  }

  return jsonError(`Не удалось получить ответ от AI. ${CLEANUP_MODEL}: ${lastAiError}`, 502);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
