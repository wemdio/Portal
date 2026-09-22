/**
 * Легенда передачи лида (projects.handoff_legend) как ГОТОВЫЙ текст:
 * вставляется лиду дословно, без ИИ. Поддерживаемые плейсхолдеры —
 * только имя (остальной текст не трогаем).
 */

const NAME_PLACEHOLDER_RE = /\[(?:имя, если есть|имя)\]/giu;
const NAME_PLACEHOLDER_WITH_COMMA_RE = /[ \t]*,[ \t]*\[(?:имя, если есть|имя)\]/giu;

/**
 * «[Имя, если есть]»/«[Имя]» → имя лида. Имени нет — плейсхолдер срезаем
 * вместе с ведущей запятой, чтобы не осталось висячей пунктуации:
 * «Добрый день, [Имя, если есть].» → «Добрый день.»
 */
export function substituteHandoffLegend(legend: string, leadName: string | null): string {
  const name = (leadName ?? '').trim();
  if (name) return legend.replaceAll(NAME_PLACEHOLDER_RE, name);
  return legend
    .replaceAll(NAME_PLACEHOLDER_WITH_COMMA_RE, '')
    .replaceAll(NAME_PLACEHOLDER_RE, '');
}

// Keep recognised approved signatures outside the model, including their line
// breaks and typography. Unknown signature formats remain part of the legend.
const SIGNOFF_RE = /(?:^|\r?\n)[ \t]*(?:с уважением(?=[,! \t\r\n]|$)|best regards\b|kind regards\b|regards\b|sincerely\b)/iu;

function splitSignature(text: string): { body: string; signature: string } {
  const match = SIGNOFF_RE.exec(text);
  if (!match) return { body: text, signature: '' };
  const body = text.slice(0, match.index).trimEnd();
  return { body, signature: text.slice(body.length) };
}

function returnCommitments(text: string): number {
  // This is a conservative guard for the observed class, not a general semantic
  // classifier. Reject an added commitment, never delete arbitrary sentences.
  return (text.match(/(?<!\p{L})(?:вернусь|верн[её]мся|вернутся|(?:i|we)(?:['’]ll| will)?\s+(?:get|come|circle)\s+back)(?!\p{L})/giu) ?? []).length;
}

function hasAddedRepetition(draft: string, legend: string): boolean {
  if (returnCommitments(draft) > Math.max(1, returnCommitments(legend))) return true;
  const sentences = (text: string) => text.toLowerCase().split(/[.!?\r\n]+/u)
    .map((part) => part.replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .filter((part) => part.split(' ').length >= 4);
  const original = sentences(legend);
  const seen = new Map<string, number>();
  return sentences(draft).some((sentence) => {
    const count = (seen.get(sentence) ?? 0) + 1;
    seen.set(sentence, count);
    return count > Math.max(1, original.filter((part) => part === sentence).length);
  });
}

/**
 * Текст передачи лида с учётом пер-прокетного тумблера (projects.handoff_ai_adapt):
 *  - OFF (дефолт): легенда ДОСЛОВНО (+ подстановка имени) — полный контроль текста;
 *  - ON: ИИ адаптирует легенду; при сбое используется готовая легенда проекта.
 */
export async function buildHandoffDraft(opts: {
  aiAdapt: boolean;
  legend: string;
  leadName: string | null;
  leadReplyText: string;
  lastOutboundText?: string | null;
  apiKey: string;
  /** Safe diagnostic only: no provider response, email text or credentials. */
  onFallback?: (reason: 'missing_api_key' | 'ai_unavailable') => void;
}): Promise<string> {
  const fallback = substituteHandoffLegend(opts.legend.trim(), opts.leadName);
  // Never invent a legend for an unconfigured project, even when AI is enabled.
  if (!opts.aiAdapt || !fallback.trim()) return fallback;
  const reportFallback = (reason: 'missing_api_key' | 'ai_unavailable') => {
    try { opts.onFallback?.(reason); } catch { /* diagnostics must not block a card */ }
  };
  if (!opts.apiKey.trim()) {
    reportFallback('missing_api_key');
    return fallback;
  }
  const { body, signature } = splitSignature(fallback);
  if (!body.trim()) return fallback;
  try {
    const { generateHandoffReply } = await import('./handoffGenerator');
    const draft = await generateHandoffReply(
      {
        leadReplyText: opts.leadReplyText,
        lastOutboundText: opts.lastOutboundText ?? null,
        leadName: opts.leadName,
        framing: body,
      },
      // One bounded adaptation attempt; retries cannot improve the approved
      // fallback text and previously delayed or lost the specialist's button.
      { apiKey: opts.apiKey, maxRetries: 0 },
    );
    if (draft.trim() && !hasAddedRepetition(draft, body)
      && (!signature || !SIGNOFF_RE.test(draft))) {
      return draft.trim() + signature;
    }
  } catch {
    // Empty/truncated/wrong-language output, 402/429/5xx, malformed JSON or
    // timeout are failures of optional adaptation, not of the handoff itself.
  }
  reportFallback('ai_unavailable');
  return fallback;
}
