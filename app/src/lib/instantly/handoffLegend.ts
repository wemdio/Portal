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
  try {
    const { generateHandoffReply } = await import('./handoffGenerator');
    const draft = await generateHandoffReply(
      {
        leadReplyText: opts.leadReplyText,
        lastOutboundText: opts.lastOutboundText ?? null,
        leadName: opts.leadName,
        framing: opts.legend,
      },
      // One bounded adaptation attempt; retries cannot improve the approved
      // fallback text and previously delayed or lost the specialist's button.
      { apiKey: opts.apiKey, maxRetries: 0 },
    );
    if (draft.trim()) return draft;
  } catch {
    // Empty/truncated/wrong-language output, 402/429/5xx, malformed JSON or
    // timeout are failures of optional adaptation, not of the handoff itself.
  }
  reportFallback('ai_unavailable');
  return fallback;
}
