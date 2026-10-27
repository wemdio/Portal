import { parseAiStep } from './decide';
import type { AiStep } from './types';

/**
 * Промпт и вызов модели квалифицирующего ИИ. Модель пишет письмо и оценивает
 * ход, но решение «передавать или нет» принимает код (decideStep).
 */

/** Та же политика, что у квалификатора ответов: уже одобрена на его ключе Requesty. */
const DEFAULT_MODEL = 'policy/gemini-flash';
const REQUEST_TIMEOUT_MS = 60_000;

export interface AiQualifierConfig {
  apiKey: string;
  model: string;
}

/** Свой ключ, иначе ключ квалификатора ответов — фича работает без новых переменных на сервере. */
export function aiQualifierConfig(env: NodeJS.ProcessEnv = process.env): AiQualifierConfig | null {
  const apiKey = (env.SENDER_AI_QUALIFIER_API_KEY ?? '').trim() || (env.SENDER_LEADS_AI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return { apiKey, model: (env.SENDER_AI_QUALIFIER_MODEL ?? '').trim() || DEFAULT_MODEL };
}

export interface AiPromptInput {
  /** Запасной язык письма, если по письму лида не понять. */
  language: 'ru' | 'en';
  /** «Короткое КП» папки — единственный источник цен и кейсов. */
  offerText: string;
  mode: 'reply' | 'reminder';
  /** Сколько писем ИИ уже отправил этому лиду. */
  aiMessages: number;
  /** Основная почта менеджера, которая встанет в копию письма передачи. */
  ccEmail: string | null;
  /** Вся переписка по времени: наши письма и письма лида. */
  history: Array<{ from: 'us' | 'lead'; at: string | null; text: string }>;
}

const SYSTEM_PROMPT = `Ты — сотрудник Polza Agency, который вёл эту email-переписку с компанией. Мы предлагаем привести новых клиентов в их отдел продаж (холодный аутрич, базы, лиды). Лид ответил на наше письмо. Твоя задача — понять, актуально ли им это, и получить, где и когда обсудить: удобные слоты, телефон или другой контакт. Встречу сам не назначаешь — после этого с ними свяжется менеджер.

Правила письма:
- Пиши как живой человек, коротко, без канцелярита, без ссылок и вложений. Подпись — как в наших письмах выше.
- Язык письма — язык последнего письма лида.
- Если просят КП, цену, «расскажите подробнее», «что предлагаете» — дай короткое КП в 5–7 строк только из блока «КОРОТКОЕ КП» ниже, затем спроси: «Актуально для вас? Пришлите пару удобных слотов или телефон».
- Цены, сроки, скидки, гарантии и кейсы — только из блока «КОРОТКОЕ КП». Чего там нет, не придумывай: «Это подробно разберёт менеджер — пришлите удобные слоты или телефон».
- Бюджет не спрашивай. Не больше одного-двух вопросов в письме.
- Если ответил не тот человек или общий ящик — попроси контакт того, кто у них отвечает за привлечение клиентов.
- Если лид подтвердил, что актуально, и прислал слоты, телефон или контакт (в том числе «давайте обсудим по почте») — коротко поблагодари и скажи, что с ним свяжется коллега. Ничего больше не спрашивай.
- Если отказ или «не актуально» — одна вежливая строка прощания.
- Если лид сам предлагает нам свои услуги или партнёрство вместо интереса к нашим — это встречное предложение, письмо не нужно.

Ответь строго одним JSON-объектом без пояснений:
{"relevant":"yes|no|unclear","contact":"слоты/телефон/контакт как прислал лид или null","outcome":"continue|handoff|close|counter_offer","reply":"текст письма или пустая строка","summary":"1–3 строки для менеджера: кто, что им нужно, что прислал"}
relevant=yes — только если лид прямо подтвердил интерес или актуальность. contact — только то, что лид реально прислал.`;

function formatHistory(history: AiPromptInput['history']): string {
  return history
    .map((m) => `[${m.at ? m.at.slice(0, 16).replace('T', ' ') : 'без даты'}] ${m.from === 'us' ? 'Мы' : 'Лид'}:\n${m.text.trim()}`)
    .join('\n\n---\n\n');
}

export function buildAiMessages(input: AiPromptInput): Array<{ role: 'system' | 'user'; content: string }> {
  const task = input.mode === 'reminder'
    ? 'Лид молчит после нашего прошлого письма. Напиши одно короткое напоминание к нему (outcome=continue, relevant=unclear).'
    : 'Ответь на последнее письмо лида по правилам.';
  const handoffLine = input.ccEmail
    ? `При передаче скажи, что коллега напишет с адреса ${input.ccEmail} (он будет в копии).`
    : 'При передаче скажи, что с ним свяжется коллега.';
  const user = [
    `КОРОТКОЕ КП:\n${input.offerText.trim() || '(не заполнено — цен и кейсов не называй)'}`,
    `Запасной язык: ${input.language === 'en' ? 'английский' : 'русский'}. Наших писем от ИИ уже: ${input.aiMessages}.`,
    handoffLine,
    `ПЕРЕПИСКА (по времени):\n${formatHistory(input.history)}`,
    task,
  ].join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export async function requestAiStep(cfg: AiQualifierConfig, input: AiPromptInput): Promise<AiStep> {
  const response = await fetch('https://router.requesty.ai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-Title': 'Portal - Auto Outreach Qualifying AI',
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      max_tokens: 1500,
      messages: buildAiMessages(input),
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Requesty ${response.status}: ${raw.slice(0, 300)}`);
  let data: { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Requesty вернул невалидный ответ');
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Ответ модели обрезан по лимиту токенов');
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  return parseAiStep(content);
}
