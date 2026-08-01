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
 *  - ON: ИИ адаптирует легенду под ответ лида (старое поведение генератора).
 */
export async function buildHandoffDraft(opts: {
  aiAdapt: boolean;
  legend: string;
  leadName: string | null;
  leadReplyText: string;
  lastOutboundText?: string | null;
  apiKey: string;
}): Promise<string> {
  if (!opts.aiAdapt) return substituteHandoffLegend(opts.legend.trim(), opts.leadName);
  const { generateHandoffReply } = await import('./handoffGenerator');
  return generateHandoffReply(
    {
      leadReplyText: opts.leadReplyText,
      lastOutboundText: opts.lastOutboundText ?? null,
      leadName: opts.leadName,
      framing: opts.legend,
    },
    { apiKey: opts.apiKey },
  );
}
