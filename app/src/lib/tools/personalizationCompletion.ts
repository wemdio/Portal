/** One bounded retry loop shared by the table, Base Constructor and DFYB. */
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 70_000;
const TOTAL_TIMEOUT_MS = 240_000;

export class PersonalizationError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'PersonalizationError';
  }
}

export class PersonalizationCancelledError extends Error {
  constructor() {
    super('Отменено');
    this.name = 'AbortError';
  }
}

type Options = {
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  title: string;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
};

async function assertNotCancelled(options: Options): Promise<void> {
  if (options.signal?.aborted || (options.isCancelled && await options.isCancelled())) {
    throw new PersonalizationCancelledError();
  }
}

function retryAfterMs(response: Response): number {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(60_000, delay)) : 0;
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PersonalizationCancelledError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new PersonalizationCancelledError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function generatePersonalizationCompletion(options: Options): Promise<string> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastError = new PersonalizationError('Не удалось получить персонализацию');
  let maxTokens = 1500;
  let emptyResponses = 0;

  // Transport and incomplete HTTP 200 responses consume the SAME four
  // attempts: do not wrap this helper in another server-side retry loop.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await assertNotCancelled(options);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw lastError;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));
    let canRetry = true;
    let delayMs = 1500 * 2 ** attempt;

    try {
      const response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': options.title,
        },
        signal: controller.signal,
        body: JSON.stringify({ model: options.model, messages: options.messages, temperature: 0.7, max_tokens: maxTokens }),
      });
      if (response.ok) {
        // The timer also covers a stalled response body.
        const data = await response.json();
        await assertNotCancelled(options);
        const choice = data?.choices?.[0];
        const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
        if (choice?.finish_reason === 'length') {
          lastError = new PersonalizationError('Ответ AI обрезан (length). Повторите персонализацию этой строки');
          // Reasoning tokens may consume the whole initial budget. Escalate
          // only incomplete results, never a 429/transport failure; cap 6000.
          maxTokens = Math.min(6000, maxTokens * 2);
        } else if (choice?.finish_reason && choice.finish_reason !== 'stop') {
          lastError = new PersonalizationError('AI не завершил персонализацию. Проверьте данные и повторите генерацию');
          canRetry = false;
        } else if (!text) {
          lastError = new PersonalizationError('AI вернул пустую персонализацию. Повторите генерацию этой строки');
          emptyResponses += 1;
          if (emptyResponses > 1) maxTokens = Math.min(6000, maxTokens * 2);
        } else {
          return text;
        }
      } else {
        lastError = new PersonalizationError(`Ошибка AI (HTTP ${response.status}). Повторите персонализацию позже`,
          response.status >= 500 ? 502 : response.status);
        canRetry = response.status === 408 || response.status === 429 || response.status >= 500;
        if (response.status === 429 || response.status === 408) {
          delayMs = Math.max([5000, 15_000, 30_000][Math.min(attempt, 2)], retryAfterMs(response));
        }
        // No provider payload is needed; release its stream before retrying.
        await response.body?.cancel();
      }
    } catch (error) {
      if (error instanceof PersonalizationCancelledError || options.signal?.aborted) {
        throw new PersonalizationCancelledError();
      }
      lastError = controller.signal.aborted
        ? new PersonalizationError('Превышено время ожидания персонализации. Повторите генерацию этой строки', 504)
        : new PersonalizationError('Не удалось прочитать ответ AI. Повторите персонализацию этой строки');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (!canRetry || attempt === MAX_ATTEMPTS - 1 || Date.now() + delayMs >= deadline) throw lastError;
    await assertNotCancelled(options);
    await waitForRetry(delayMs, options.signal);
  }
  throw lastError;
}

export function personalizationFailureMessage(error: unknown): string {
  return error instanceof PersonalizationError
    ? error.message
    : 'Не удалось создать персонализацию. Повторите генерацию этой строки';
}

export type PersonalizationRowResult = { source: string[]; proposal: string; error?: string };

export function buildPersonalizationTable(header: string[], results: PersonalizationRowResult[]): string[][] {
  const hasErrors = results.some((result) => result.error);
  return [
    [...header, 'Персонализация', ...(hasErrors ? ['Ошибка персонализации'] : [])],
    ...results.map((result) => [
      ...result.source,
      result.proposal,
      ...(hasErrors ? [result.error || ''] : []),
    ]),
  ];
}
