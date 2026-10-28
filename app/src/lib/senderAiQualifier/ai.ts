import { PRODUCT_LABELS, PRODUCT_PITCH, type Product } from '@/lib/polzaRuOutreach/cascade';
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
  /** «Короткое КП» продукта (auto_ru) или папки — единственный источник цен и кейсов. */
  offerText: string;
  /**
   * Русский автоаутрич (auto_ru): ответ прогревает к разговору с менеджером, а не
   * выясняет. Английский (auto_en) идёт по прежнему промпту.
   */
  cascade: boolean;
  /** Что предлагали лиду (productPitchOf); null — продукт неизвестен (строка до каскада, auto_en). */
  productPitch: string | null;
  mode: 'reply' | 'reminder';
  /** Сколько писем ИИ уже отправил этому лиду. */
  aiMessages: number;
  /** Основная почта менеджера, которая встанет в копию письма передачи. */
  ccEmail: string | null;
  /** Вся переписка по времени: наши письма и письма лида. */
  history: Array<{ from: 'us' | 'lead'; at: string | null; text: string }>;
}

/** Цель разговора с менеджером по продукту (спека каскада, «Цели писем по продуктам»). */
const CALL_GOAL: Record<Product, string> = {
  sdr: 'менеджер возьмёт задачу в работу, назовёт ожидаемый результат и цену; список компаний от клиента заранее не нужен',
  classic: 'менеджер вместе с ними прикинет сегменты и ожидаемое число лидов',
  classic_abroad: 'менеджер вместе с ними прикинет рынки, каналы и ожидаемое число лидов',
  auto: 'менеджер вместе с ними прикинет базу компаний и темп рассылки',
};

/**
 * Что предлагали лиду и зачем разговор с менеджером — для промпта auto_ru.
 * Суть продукта общая с письмом 1 (PRODUCT_PITCH), чтобы письмо и ответ на него
 * не рассказывали о продукте по-разному.
 */
export function productPitchOf(product: Product): string {
  const { offer, need } = PRODUCT_PITCH[product];
  return `${PRODUCT_LABELS[product]} — ${offer}. Подходит, когда ${need}. На разговоре ${CALL_GOAL[product]}.`;
}

const RULE_STYLE = '- Пиши как живой человек, коротко, без канцелярита, без ссылок и вложений. Подпись — как в наших письмах выше.';
const RULE_LANGUAGE = '- Язык письма — язык последнего письма лида.';
const RULES_REST = [
  '- Если ответил не тот человек или общий ящик — попроси контакт того, кто у них отвечает за привлечение клиентов.',
  '- Если лид подтвердил, что актуально, и прислал слоты, телефон или контакт (в том числе «давайте обсудим по почте») — коротко поблагодари и скажи, что с ним свяжется коллега. Ничего больше не спрашивай.',
  '- Если отказ или «не актуально» — одна вежливая строка прощания.',
  '- Если просят больше не писать, удалить из базы, не беспокоить — письмо не пишешь вовсе: reply пустой, stop_requested=true.',
  '- Если лид сам предлагает нам свои услуги или партнёрство вместо интереса к нашим — это встречное предложение, письмо не нужно.',
];

/** Оценка и формат ответа — общие для обоих промптов: от них зависит решение кода (decideStep). */
const ASSESSMENT_AND_FORMAT = `Важно для оценки:
- Просьба прислать КП, цену или «расскажите подробнее» — ещё НЕ подтверждение актуальности (relevant=unclear).
- Телефон, почта или ссылки из подписи письма — НЕ контакт для связи. Контакт — только если лид сам предлагает связаться: «звоните», «вот мой номер», «удобно в четверг в 12», «давайте по почте».

Ответь строго одним JSON-объектом без пояснений:
{"relevant":"yes|no|unclear","contact":строка или null,"outcome":"continue|handoff|close|counter_offer","reply":"текст письма или пустая строка","summary":"1–3 строки для менеджера: кто, что им нужно, что прислал","stop_requested":true|false}
relevant=yes — только если лид прямо подтвердил интерес или актуальность. contact — слоты, телефон или контакт, которые лид сам прислал для связи, иначе null (без кавычек).`;

/** Прежний промпт: «понять, актуально ли», до двух вопросов. Им пользуется английский автоаутрич. */
function legacySystemPrompt(): string {
  const intro = 'Ты — сотрудник Polza Agency, который вёл эту email-переписку с компанией. Мы предлагаем привести новых клиентов в их отдел продаж (холодный аутрич, базы, лиды). Лид ответил на наше письмо. Твоя задача — понять, актуально ли им это, и получить, где и когда обсудить: удобные слоты, телефон или другой контакт. Встречу сам не назначаешь — после этого с ними свяжется менеджер.';
  const rules = [
    RULE_STYLE,
    RULE_LANGUAGE,
    '- Если просят КП, цену, «расскажите подробнее», «что предлагаете» — дай короткое КП в 5–7 строк только из блока «КОРОТКОЕ КП» ниже, затем спроси: «Актуально для вас? Пришлите пару удобных слотов или телефон».',
    '- Цены, сроки, скидки, гарантии и кейсы — только из блока «КОРОТКОЕ КП». Чего там нет, не придумывай: «Это подробно разберёт менеджер — пришлите удобные слоты или телефон».',
    '- Бюджет не спрашивай. Не больше одного-двух вопросов в письме.',
    ...RULES_REST,
  ];
  return `${intro}\n\nПравила письма:\n${rules.join('\n')}\n\n${ASSESSMENT_AND_FORMAT}`;
}

/**
 * Русский автоаутрич (совет Андрея, руководителя продаж, 28.10.2026): меньше
 * вопросов квалификации, больше пользы под боль компании и приглашение на
 * разговор. Цель разговора зависит от продукта, который предлагали.
 */
function cascadeSystemPrompt(productPitch: string | null): string {
  const offered = productPitch
    ? `Мы предложили компании лида (в описании «компания-получатель» — это компания лида; пересказывай суть своими словами, фразы из описания не копируй): ${productPitch}`
    : 'Мы предлагаем привести новых клиентов в их отдел продаж (холодный аутрич, базы, лиды).';
  const intro = `Ты — сотрудник Polza Agency, который вёл эту email-переписку с компанией. ${offered} Лид ответил на наше письмо. Твоя задача — подвести человека к разговору или встрече с нашим менеджером: коротко показать пользу под задачу его компании и получить, где и когда обсудить: удобные слоты, телефон или другой контакт. Встречу сам не назначаешь — после этого с ними свяжется менеджер.`;
  const rules = [
    RULE_STYLE,
    RULE_LANGUAGE,
    '- Не выясняй, а прогревай: вопросов квалификации (кто решает, сколько клиентов, какие сегменты, бюджет) почти не задавай — их обсудит менеджер на разговоре. Ответь на то, что спросил лид, и в одну-две фразы покажи пользу именно под задачу его компании, как она видна из переписки. Ничего не выдумывай о компании сверх переписки.',
    '- Если просят КП, цену, «расскажите подробнее», «что предлагаете» — дай короткое КП в 5–7 строк только из блока «КОРОТКОЕ КП» ниже, затем позови на разговор: «Давайте созвонимся и разберём под вашу задачу — пришлите пару удобных слотов или телефон».',
    '- Пока лид не подтвердил интерес и не отказался, заканчивай письмо приглашением на звонок или встречу с менеджером. Список компаний, базу, ТЗ и бриф у клиента не проси: всё нужное менеджер уточнит на разговоре.',
    '- Цены, сроки, скидки, гарантии, кейсы, цифры и обещания результата (число заявок, сроки результата) — только из блока «КОРОТКОЕ КП». Чего там нет, не придумывай: «Это подробно разберёт менеджер на разговоре — пришлите удобные слоты или телефон».',
    '- Бюджет не спрашивай. Пока лид не подтвердил интерес и не отказался, в письме не больше одного вопроса — приглашения на разговор. Просьба дать контакт нужного человека (правило ниже) — отдельный вопрос и в этот счёт не входит.',
    ...RULES_REST,
  ];
  return `${intro}\n\nПравила письма:\n${rules.join('\n')}\n\n${ASSESSMENT_AND_FORMAT}`;
}

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
    { role: 'system', content: input.cascade ? cascadeSystemPrompt(input.productPitch) : legacySystemPrompt() },
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
