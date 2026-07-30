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
