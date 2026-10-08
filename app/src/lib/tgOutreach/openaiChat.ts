import type { OpenAISettings, DialogMessage } from './types';

// Requesty fallback chain policy: gpt-5-mini → gpt-4o-mini → gpt-5.
// Retries and model fallback handled by Requesty, not by us.
const DEFAULT_MODEL = 'policy/tg-outreach';

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// Retry config for transient OpenRouter failures (5xx, timeouts).
// gpt-5-mini on OpenRouter sporadically returns 500 "provider error" or
// hangs past the timeout — a single retry with backoff resolves most cases.
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [3_000, 6_000];

function isRetryable(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Рамка для ответов кампании — поверх её промпта. 08.10.2026 в «АИ МОП»
 * модель пообещала звонок «менеджера Алексея» (такого нет) и назвала
 * собеседника именем нашего же аккаунта: он начал с «Андрей, здравствуйте»,
 * обращаясь к нам.
 */
export const OUTREACH_FACTS_RULE = `Жёсткие правила поверх инструкции выше:
- Не выдумывай о нас ничего, чего нет в инструкции: имена и должности сотрудников, телефоны, сроки и время звонка или встречи. Спросят, кто свяжется, — ответь, что напишет коллега из команды, без имени.
- Не обещай позвонить сам. Номер телефона не давай.
- Имя, с которым собеседник здоровается («Андрей, здравствуйте»), — это обращение к нам, а не его имя. Называй собеседника только именем, которым он сам представился.
- Сообщение с пометкой «[Переслано …]» написал не собеседник: он показал нам чужое или наше же сообщение. Не приписывай собеседнику его слова.`;

export async function openaiGenerate(
  settings: OpenAISettings,
  chatHistory: DialogMessage[],
  opts?: { extraInstruction?: string | null; factsRule?: boolean },
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_TG_OUTREACH_API_KEY не задан в .env');
  }

  const messages: OpenAIChatMessage[] = [];

  if (settings.system_prompt) {
    let prompt = settings.system_prompt;
    if (settings.project_name) {
      prompt = prompt.replace(/\{project_name\}/g, settings.project_name);
    }
    messages.push({ role: 'system', content: prompt });
  }
  if (opts?.factsRule) {
    messages.push({ role: 'system', content: OUTREACH_FACTS_RULE });
  }

  for (const msg of chatHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Указание на этот конкретный ответ — после истории, чтобы модель не
  // растворила его в длинном промпте кампании.
  if (opts?.extraInstruction) {
    messages.push({ role: 'system', content: opts.extraInstruction });
  }

  // Всегда используем Requesty policy — fallback chain рулит моделями.
  // settings.llm_model игнорируем: в БД у старых кампаний лежит конкретная
  // модель (openai/gpt-5-mini), которая обходит fallback chain.
  const model = DEFAULT_MODEL;

  const body = {
    model,
    messages,
    max_tokens: 4096,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  // 90s по умолчанию: gpt-5-mini тратит 25-35с на reasoning в типичном
  // случае, но на сложных промптах (длинная история диалога) может уходить
  // в 60-80с. Прежний лимит 45с резал ~15% успешных запросов. Override
  // через env, если нужно.
  const GPT_TIMEOUT_MS = Number(process.env.TG_OUTREACH_GPT_TIMEOUT_MS) || 90_000;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 6_000;
      await new Promise(r => setTimeout(r, backoff));
    }

    try {
      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GPT_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`OpenRouter API error ${res.status}: ${text.slice(0, 200)}`);
        if (isRetryable(res.status) && attempt < RETRY_ATTEMPTS) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const data = (await res.json()) as OpenRouterResponse;
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('TIMEOUT');
      if ((isTimeout || (lastError && lastError.message.includes('500'))) && attempt < RETRY_ATTEMPTS) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('OpenRouter: all retry attempts exhausted');
}

/**
 * Явный интерес собеседника — отдельной проверкой, до генерации ответа.
 *
 * Зачем: лид уходит менеджеру только по фразе передачи в НАШЕМ ответе, а
 * модель ответа её то забывает, то перефразирует («Могу передать ваш
 * контакт…»). На 28.09.2026 в базе было ~80 диалогов с «Да, пришлите
 * условия», «Давайте», «Можем завтра созвониться» — и ни одной передачи.
 * Узкий вопрос «есть интерес или нет» дешёвая модель решает надёжнее, чем
 * длинный промпт кампании между делом.
 *
 * 30.09.2026 ужесточено: вопрос о цене или устройстве («стоимость ККТ, ФН
 * и/или аренды?») интересом больше не считается — человека передавали
 * менеджеру, когда он ещё только разбирался и ни на что не соглашался.
 *
 * interested: true — интерес есть, false — нет, null — проверка не удалась
 * (тогда всё решает ответ модели, как раньше; причина — в error).
 */
const INTEREST_MODEL = 'openai/gpt-4o-mini';
const INTEREST_TIMEOUT_MS = 30_000;
const INTEREST_HISTORY_MESSAGES = 10;

const INTEREST_PROMPT = `Ты проверяешь переписку в Telegram. «Мы» написали человеку холодное предложение (партнёрство, услуга, сервис). Реши, проявил ли «Собеседник» в своих ПОСЛЕДНИХ сообщениях явный интерес к нашему предложению.

Явный интерес (ответ ДА):
- просит прислать условия, подробности, презентацию, КП, прайс, ссылку ("да, пришлите", "присылайте", "скиньте", "расскажите подробнее");
- соглашается на наше предложение прислать условия, обсудить, подключиться, поговорить с менеджером ("давайте", "да, давай", "интересно") — если наш предыдущий вопрос был именно таким предложением;
- спрашивает, как начать, зарегистрироваться или подключиться — то есть уже собирается действовать;
- предлагает созвониться, встретиться, оставляет телефон или удобное время;
- прямо говорит, что готов попробовать или участвовать.

НЕТ интереса (ответ НЕТ):
- уточняющий вопрос о самом предложении без согласия и без просьбы что-то прислать: "сколько стоит?", "сколько платите?", "что входит?", "как это работает?", "в смысле?", "а оборудование нужно?" — человек только разбирается, на такой вопрос надо сначала ответить;
- отказ, "не интересно", "не актуально", "не пишите", "подумаю", "буду иметь в виду", "посмотрю", "если что обращусь";
- короткое "да"/"нет"/"бывает" в ответ на наш уточняющий вопрос о работе собеседника (например "бывают ли у вас такие клиенты?") — это ответ на вопрос, а не согласие;
- вопросы "кто вы", "откуда мой контакт", "что это", недоумение;
- встречное предложение своих услуг, реклама, автоответчик, спам, ошибся номером, болтовня не по теме;
- интерес вместе с просьбой больше не писать — это НЕТ.

Сомневаешься — отвечай НЕТ: ДА только когда согласие или просьба сказаны прямо.

Ответь одним словом: ДА или НЕТ.`;

/**
 * Узкий вариант — для кампаний, где квалификацию ведёт промпт
 * (handoff_direct_request_only). Передаём сами только прямую просьбу о
 * человеке: всё остальное, включая «расскажите подробнее», модель ответа
 * разбирает по своему промпту — уточняет роль, объём и бюджет.
 */
const DIRECT_REQUEST_PROMPT = `Ты проверяешь переписку в Telegram. «Мы» написали человеку холодное предложение. Реши, просит ли «Собеседник» в своих ПОСЛЕДНИХ сообщениях прямо связать его с живым человеком.

ДА:
- просит связать с менеджером, специалистом, человеком, дать контакт менеджера;
- предлагает созвониться или встретиться, оставляет телефон или удобное время для звонка;
- соглашается на наше предложение созвониться, встретиться или поговорить с менеджером ("давайте", "да", "можно") — если наш предыдущий вопрос был именно таким предложением.

НЕТ:
- просит рассказать подробнее, прислать презентацию, условия, КП, прайс, ссылку, запись;
- спрашивает о цене, устройстве, интеграциях, сроках;
- пишет "интересно" без просьбы о звонке или менеджере;
- отвечает на наш вопрос о своей роли, задачах или цифрах;
- отказ, "подумаю", "посмотрю", вопросы "кто вы", спам, автоответчик;
- просьба о звонке вместе с просьбой больше не писать.

Сомневаешься — отвечай НЕТ.

Ответь одним словом: ДА или НЕТ.`;

export async function detectInterest(
  chatHistory: DialogMessage[],
  opts?: { directRequestOnly?: boolean },
): Promise<{ interested: boolean | null; error?: string }> {
  const apiKey = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (!apiKey) return { interested: null, error: 'OPENROUTER_TG_OUTREACH_API_KEY не задан' };

  const transcript = chatHistory
    .slice(-INTEREST_HISTORY_MESSAGES)
    .map(m => `${m.role === 'assistant' ? 'Мы' : 'Собеседник'}: ${m.content}`)
    .join('\n\n');

  // Вторая попытка — на случайный сбой провайдера: пропущенная проверка
  // означает пропущенного лида. Причину последнего сбоя отдаём наверх, в
  // лог кампании: молча отвалившаяся проверка выглядела бы как «интереса нет».
  let error = 'модель не ответила ни ДА, ни НЕТ';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2_000));
    try {
      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: INTEREST_MODEL,
          messages: [
            { role: 'system', content: opts?.directRequestOnly ? DIRECT_REQUEST_PROMPT : INTEREST_PROMPT },
            { role: 'user', content: transcript },
          ],
          // Меньше 16 провайдер не принимает: отвечает ошибкой, а не словом.
          max_tokens: 16,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(INTEREST_TIMEOUT_MS),
      });
      if (!res.ok) {
        error = `ошибка ${res.status}: ${(await res.text()).slice(0, 200)}`;
        continue;
      }
      const data = (await res.json()) as OpenRouterResponse;
      const answer = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';
      if (answer.startsWith('да') || answer.startsWith('yes')) return { interested: true };
      if (answer.startsWith('нет') || answer.startsWith('no')) return { interested: false };
      error = `непонятный ответ модели: «${answer.slice(0, 50)}»`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { interested: null, error };
}

/** Фраза передачи менеджеру — первая строка положительных триггеров кампании. */
export function handoffPhrase(settings: OpenAISettings): string | null {
  const first = (settings.trigger_phrases_positive ?? '')
    .split('\n')
    .map(p => p.trim())
    .find(Boolean);
  return first ?? null;
}

/**
 * Указание модели ответа, когда проверка увидела явный интерес: ответить на
 * просьбу и закончить фразой передачи.
 */
export function handoffInstruction(phrase: string): string {
  return `Собеседник проявил явный интерес. Коротко ответь на его просьбу или вопрос (если просил условия — кратко изложи их) и закончи сообщение точной фразой «${phrase}». Фразу не меняй и не перефразируй, после неё ничего не пиши и вопросов не задавай.`;
}

/**
 * Модель могла не послушаться — фразу дописываем сами: без неё лид не уйдёт
 * менеджеру, а человек не узнает, что с ним свяжутся.
 */
export function ensureHandoffPhrase(reply: string, phrase: string): string {
  if (reply.toLowerCase().includes(phrase.toLowerCase())) return reply;
  let trimmed = reply.trim();
  // «…Вам интересно узнать подробнее? Передаю ваш контакт менеджеру» —
  // вопрос, на который уже никто не ответит. Отрезаем его, если до него
  // есть что оставить.
  const withoutQuestion = trimmed.match(/^([\s\S]*[.!…])\s+[^.!?…]*\?$/);
  if (withoutQuestion) trimmed = withoutQuestion[1].trim();
  const sep = /[.!?…)]$/.test(trimmed) ? ' ' : '. ';
  return `${trimmed}${sep}${phrase}`;
}

export function detectTrigger(
  text: string,
  settings: OpenAISettings,
): 'positive' | 'negative' | null {
  const lower = text.toLowerCase();

  if (settings.trigger_phrases_positive) {
    const phrases = settings.trigger_phrases_positive
      .split('\n')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
    for (const phrase of phrases) {
      if (lower.includes(phrase)) return 'positive';
    }
  }

  if (settings.trigger_phrases_negative) {
    const phrases = settings.trigger_phrases_negative
      .split('\n')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
    for (const phrase of phrases) {
      if (lower.includes(phrase)) return 'negative';
    }
  }

  return null;
}
