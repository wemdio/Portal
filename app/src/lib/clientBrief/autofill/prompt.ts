/**
 * Prompt builder for the brief autofill flow.
 *
 * Conservative on purpose: the system prompt enumerates allowed fields,
 * tells the model what NOT to invent, and demands strict JSON output.
 * The mapper (mapAutofillToBriefPatch) is the actual safety boundary — this
 * file just biases the model toward producing useful, scoped JSON.
 */

export interface AutofillPromptInput {
  website: string;
  websiteText: string;
}

export interface AutofillPromptOutput {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = `Ты помогаешь предзаполнить структурированный бриф клиента маркетингового агентства на основе **публичного сайта компании**.

ЖЁСТКИЕ ПРАВИЛА:
1. Заполняй ТОЛЬКО поля из белого списка ниже. Любые другие поля — игнорируй, даже если кажется логичным их вывести.
2. Используй ТОЛЬКО факты, явно поддержанные текстом сайта. Никаких догадок, экстраполяций, общих фраз "обычно у таких компаний...".
3. Если факта на сайте нет — оставь поле пустой строкой "". Не пиши "не указано", "неизвестно" и т.п.
4. Никогда не выдумывай: цены, сроки сделки, средний чек, гарантии, контактные имена, email-получателей лидов, проблемы клиентов, ICP. Если этих фактов нет — НЕ заполняй и положи открытый вопрос в \`questions\`.
5. Все строки — на русском, лаконично, без HTML.
6. Возвращай СТРОГО JSON-объект, без преамбулы и без кодовых блоков.

БЕЛЫЙ СПИСОК ПОЛЕЙ (всё остальное игнорируется получателем):
- company_website: строка — каноничный домен компании (например, redev.ru).
- company_description: 1–3 предложения о том, чем компания занимается.
- company_contacts: контакты в свободной форме (телефоны, email, telegram), если они НАПИСАНЫ на сайте.
- product_description: подробное описание основного продукта/услуги.
- advantages: 3–5 преимуществ (по строке на пункт), которые сайт явно заявляет.
- usp: уникальное торговое предложение, если есть явный слоган/обещание.
- impressive_numbers: цифры, которые впечатляют (годы на рынке, число клиентов, кейсов, ассортимент). Только цифры с сайта.
- existing_clients: перечисление клиентов или брендов, если они показаны.
- impressive_results: примеры результатов/кейсов, если они описаны.
- target_audience: ЦА, ТОЛЬКО если она явно описана на сайте; иначе "".
- additional_notes: что важного видно на сайте, но не уложилось в другие поля (1–3 предложения).
- social_proof: объект с ключами ratings, media, photos, recommendations, cases, awards, press, presentations. Каждый ключ: { "has": true|false, "comment": "..." }. Ставь has=true только если соответствующее доказательство ВИДНО на сайте, и тогда в comment коротко напиши, что именно.

ДОПОЛНИТЕЛЬНЫЕ ВЫХОДНЫЕ ПОЛЯ:
- questions: массив строк — открытые вопросы, которые НУЖНО задать клиенту (например, "Какой средний чек?", "На какой бюджет ориентируемся?", "Кому слать тёплые лиды?").
- sources: объект, где ключ — имя поля из белого списка, значение — короткая цитата/фрагмент с сайта, подтверждающий заполнение. Только для тех полей, которые ты заполнил.

ВЫХОДНОЙ ФОРМАТ — РОВНО JSON-объект с полями выше. Никакого markdown, никаких комментариев, никакого текста снаружи JSON.`;

export function buildAutofillPrompt(input: AutofillPromptInput): AutofillPromptOutput {
  const safeWebsite = input.website?.trim() || 'неизвестен';
  const text = input.websiteText?.trim() || '(сайт пустой или нечитаемый)';

  const user = [
    `URL сайта: ${safeWebsite}`,
    '',
    'Извлечённый текст с сайта (используй как единственный источник фактов):',
    '"""',
    text,
    '"""',
    '',
    'Сформируй JSON по указанной схеме. Никаких полей вне белого списка.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}
