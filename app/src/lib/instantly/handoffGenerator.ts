/**
 * Generates the handoff reply for projects with handoff_ai_adapt=ON: takes the
 * project's READY legend text and MINIMALLY adapts it to the lead's reply
 * (greeting by name + one short ack of the lead's ask). Промпт намеренно
 * затянут против выдумок: запрещено отвечать по существу (цены/сроки/условия/
 * демо — это делает человек в копии), добавлять любую новую информацию, давать
 * обещания сверх легенды, задавать встречные вопросы и переписывать легенду
 * (итог не длиннее легенды +2 коротких предложения). Температура 0.2.
 * Проекты с тумблером OFF получают легенду дословно (см. handoffLegend.ts),
 * сюда не попадают.
 */

const ROUTER_URL = 'https://router.requesty.ai/v1/chat/completions';
const DEFAULT_MODEL = 'policy/gemini-flash';

/** Дефолтная «легенда» передачи. Переопределяется per-project (preset). */
export const DEFAULT_HANDOFF_FRAMING =
  'Вы передаёте переписку коллеге, которого ставите в копию письма, и он(а) ' +
  'продолжит общение напрямую. Подай это естественно — например «поставил(а) в ' +
  'копию коллегу» или «поставил(а) свою основную почту, скоро отвечу уже с неё».';

export interface HandoffInput {
  leadReplyText: string;
  lastOutboundText?: string | null;
  leadName?: string | null;
  /** Per-project override of the handoff legend. */
  framing?: string | null;
}

export interface HandoffOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
}

function buildSystemPrompt(framing: string): string {
  return `Ты — менеджер, ведущий переписку с заинтересованным лидом из холодной email-рассылки. Лид НЕ знает, что письма шли от агентства. Нужно бесшовно передать диалог нашему клиенту (его будущему прямому контакту), которого ставят в КОПИЮ письма.

Тебе дан ГОТОВЫЙ текст передачи (легенда проекта). Твоя задача — МИНИМАЛЬНО адаптировать его под ответ лида, не меняя сути.

ЯЗЫК — жёсткое правило: язык ответа = язык легенды и последнего сообщения лида. Легенда и переписка на русском → отвечай ТОЛЬКО на русском, ни слова по-английски. На английский переходи только если сама переписка на английском.

Текст легенды: ${framing}

Что разрешено сделать с текстом:
- Добавить/подправить обращение по имени лида, если уместно.
- Добавить ОДНУ короткую фразу-реакцию на конкретный запрос лида (демо / цена / звонок / вопрос) — просто подтвердить, что по этому вернутся («вернусь по демо», «соберу и пришлю»), БЕЗ ответа по существу.
- Подстроить язык и тон под переписку.

Что ЗАПРЕЩЕНО (нарушать нельзя даже частично):
- НЕ отвечать на вопросы лида по существу: ни цен, ни сроков, ни условий, ни описания продукта/демо — это сделает человек в копии, не ты. Никаких консультаций.
- НЕ добавлять никакой новой информации, которой нет в легенде и в переписке: ни о нас, ни о клиенте, ни о продукте, ни о компании лида.
- НЕ давать обещаний сверх легенды (даты, встречи, звонки, документы), НЕ задавать встречных вопросов.
- НЕ переписывать легенду: основной текст сохраняй как есть. Итог — не длиннее легенды больше чем на 2 коротких предложения.
- НЕ раскрывать, что человек в копии — из другой компании: это «коллега» / «основная почта» / «ответственный».

Форма:
- Пиши на ТОМ ЖЕ языке, что и последнее сообщение лида. Коротко, как обычный человек в рабочей переписке, без канцелярита.
- Никаких длинных тире («—», «–») — живой человек ставит запятую, точку или дефис. Без «вылизанной» типографики.
- Без подписи, без темы письма — только текст тела ответа.
- Верни ТОЛЬКО текст ответа, без кавычек и пояснений.`;
}

function buildUserMessage(input: HandoffInput): string {
  const parts: string[] = [];
  if (input.leadName) parts.push(`Имя лида: ${input.leadName}`);
  if (input.lastOutboundText) {
    parts.push(`Наше последнее письмо лиду:\n---\n${input.lastOutboundText.slice(0, 2000)}\n---`);
  }
  parts.push(`Последний ответ лида (на него и отвечаем):\n---\n${input.leadReplyText.slice(0, 2000)}\n---`);
  parts.push('Напиши ответ-передачу по правилам выше.');
  return parts.join('\n\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strips wrapping quotes a model sometimes adds around the whole reply. */
function unwrapQuotes(text: string): string {
  return text.replace(/^["'«»\s]+|["'«»\s]+$/g, '').trim();
}

/** Доля кириллицы среди букв — детерминированная проверка языка драфта. */
function cyrRatio(s: string): number {
  const letters = s.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  if (!letters.length) return 0;
  return ((letters.match(/[а-яА-ЯёЁ]/g) ?? []).length) / letters.length;
}

/**
 * Типографские тира («—», «–») — маркер ИИ-текста: живой человек в письме
 * печатает дефис. Промпт их запрещает, но модели правило иногда игнорируют,
 * поэтому дочищаем результат программно. Переводы строк не трогаем (матчим
 * только пробелы/табы вокруг символа), маркер списка в начале строки остаётся
 * аккуратным.
 */
function humanizeDashes(text: string): string {
  return text
    .replace(/[ \t]*[—–][ \t]*/g, ' - ')
    .replace(/^ - /gm, '- ');
}

export async function generateHandoffReply(
  input: HandoffInput,
  options: HandoffOptions,
): Promise<string> {
  // `||` not `??`: LEAD_HANDOFF_MODEL is passed via compose as `${...:-}`, so on
  // prod it's an EMPTY STRING, not undefined — `??` would keep "" and Requesty
  // rejects it ("Invalid model, expected provider/model"). `||` falls through.
  const model = options.model || process.env.LEAD_HANDOFF_MODEL || DEFAULT_MODEL;
  const maxRetries = options.maxRetries ?? 2;
  // deepseek (текущий бэкенд policy/gemini-flash) — reasoning-модель: тратит
  // 500–900 токенов на «размышления» ДО ответа, поэтому при max_tokens=600 ответ
  // мог обрезаться (finish=length) и вернуться пустым/куцым. Даём запас; env для
  // тюнинга без деплоя.
  const maxTokens = Math.max(600, Number(process.env.LEAD_HANDOFF_MAX_TOKENS) || 2000);
  const framing = input.framing?.trim() || DEFAULT_HANDOFF_FRAMING;
  const systemPrompt = buildSystemPrompt(framing);
  const userMessage = buildUserMessage(input);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(ROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Lead Handoff Draft',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.4,
          max_tokens: maxTokens,
        }),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      throw new Error(`Network error: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    if (response.ok) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };
      const choice = data.choices?.[0];
      const text = choice?.message?.content?.trim() ?? '';
      // Обрезка по лимиту (reasoning съел бюджет) либо пустой ответ — ретраим,
      // чтобы не отдать клиенту куцый/пустой драфт.
      if ((choice?.finish_reason === 'length' || !text) && attempt < maxRetries) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      // Языковой гард (инцидент 31.07: при русской переписке драфт ушёл на
      // английский): легенда кириллическая, а пришедший драфт — латиница →
      // ретрай, англоязычные проекты (легенда латиницей) не затрагиваются.
      if (cyrRatio(framing) >= 0.6 && cyrRatio(text) < 0.3 && attempt < maxRetries) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      return humanizeDashes(unwrapQuotes(text));
    }

    if ([429, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }

    const errText = await response.text().catch(() => '');
    throw new Error(`Handoff AI ${response.status}: ${errText.slice(0, 200)}`);
  }

  throw new Error('Handoff generation failed after retries');
}

// Внутренности для тестов (паттерн _private).
export const _private = {
  buildSystemPrompt,
};
