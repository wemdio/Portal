import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_CLEANUP_API_KEY = process.env.OPENROUTER_CLEANUP_API_KEY ?? '';
const OPENROUTER_CLEANUP_MODELS = (
  process.env.OPENROUTER_CLEANUP_MODELS ??
  process.env.OPENROUTER_CLEANUP_MODEL ??
  'x-ai/grok-4.1-fast,google/gemini-3-flash-preview'
)
  .split(',')
  .map((model) => model.trim())
  .filter((model) => model.length > 0);
const OPENROUTER_TIMEOUT_MS = 70000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const SYSTEM_PROMPT = `Сейчас я пришлю тебе названия компаний.
1)Основная задача оставить только название компании, которое потом будет использоваться как автоматическая переменная для персонализации писем (поэтому название компании должно быть без лишней информации). Ты должен вернуть список очищенных названий в той же последовательности в столбик и без перечисления, сразу пиши результат. Убери всё то, что не является названием, а лишь его описанием.
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
Верни ТОЛЬКО очищенные названия, каждое на новой строке, без нумерации, без пояснений, без кавычек.
Количество строк в ответе должно ТОЧНО совпадать с количеством компаний во входных данных.
Порядок должен быть ТОЧНО таким же, как во входных данных.`;

type CompanyEntry = {
  idx: number;
  name: string;
  domain?: string;
};

type RequestBody = {
  companies: CompanyEntry[];
};

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

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
  if (OPENROUTER_CLEANUP_MODELS.length === 0) {
    return jsonError('OPENROUTER_CLEANUP_MODELS not configured on server', 500);
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

  // --- Build user message ---
  const companyLines = companies.map((c) => {
    if (c.domain && c.domain.trim()) {
      return `${c.name} Домен: ${c.domain.trim()}`;
    }
    return c.name;
  });

  const userMessage = companyLines.join('\n');

  // --- Call OpenRouter with retries and model fallback ---
  const modelErrors: string[] = [];

  for (const model of OPENROUTER_CLEANUP_MODELS) {
    let lastModelError = `Model ${model}: unknown error`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response: Response;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_CLEANUP_API_KEY}`,
            'HTTP-Referer': 'https://portal.app',
            'X-Title': 'Portal - Name Cleanup',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
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
          lastModelError = 'Превышено время ожидания ответа от AI';
        } else {
          const msg = err instanceof Error ? err.message : 'Network error';
          lastModelError = `Ошибка сети при обращении к AI: ${msg}`;
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
          lastModelError = 'Пустой ответ от AI';
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
            continue;
          }
          break;
        }

        // Parse the response - each line is a cleaned name
        const cleanedNames = content
          .split('\n')
          .map((line: string) => line.trim())
          .filter((line: string) => line.length > 0);

        // Map cleaned names back to indices
        const results = companies.map((c, i) => ({
          idx: c.idx,
          cleanedName: cleanedNames[i] ?? c.name, // fallback to original if mismatch
        }));

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

      lastModelError = errorMessage;
      const providerError = /provider returned error/i.test(errorMessage);
      const shouldRetry = providerError || [429, 500, 502, 503, 504].includes(response.status);
      if (shouldRetry && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
      break;
    }

    modelErrors.push(`${model}: ${lastModelError}`);
  }

  return jsonError(`Не удалось получить ответ от AI. ${modelErrors.join(' | ')}`, 502);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
