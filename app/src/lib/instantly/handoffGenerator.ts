/**
 * Generates a context-aware "handoff" reply for an interested Instantly lead.
 *
 * The lead replied to one of our agency mailboxes but does NOT know it's an
 * agency. To hand the conversation over to our client (the lead's future
 * direct contact, added to CC), we send a short, natural reply that:
 *   - answers in the SAME language and tone as the lead,
 *   - acknowledges the lead's specific ask (demo / pricing / call / …),
 *   - explains the handoff naturally ("added my colleague / main address to CC"),
 *   - NEVER reveals that the CC'd person is from a different company.
 *
 * This is the auto-written equivalent of the text specialists currently type by
 * hand in the incoming-leads forward flow (see qualified-leads/forward-email).
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

Сценарий передачи: ${framing}

Правила:
- Пиши на ТОМ ЖЕ языке, что и последнее сообщение лида.
- Коротко и естественно, в тон уже идущей переписки. Без воды и канцелярита.
- ОБЯЗАТЕЛЬНО отреагируй на КОНКРЕТНЫЙ запрос лида (демо / цена / звонок / вопрос) — упомяни его. Если лид просит демо — подтверди, что скоро вернутся именно по демо.
- НЕ раскрывай, что человек в копии — из другой компании. Это «коллега» / «основная почта» / «ответственный».
- Не выдумывай фактов, цен, дат, имён. Никакой конкретики, которой нет в переписке.
- Никаких длинных тире («—», «–») — живой человек в письме ставит запятую, точку или дефис. Это касается и остальной «вылизанной» типографики: пиши как обычный человек в рабочей переписке.
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
          max_tokens: 600,
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
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text && attempt < maxRetries) {
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
