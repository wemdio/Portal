/**
 * Сортировка id-инструментов по локализованному названию.
 *
 * Для RU-локали — кириллические названия первой (А-Я по алфавиту),
 * затем латинские (A-Z). Так нативные тулы оказываются сверху одним
 * блоком, а английские (AI Звонилка, Sales Copilot, TG Аутрич и т.п.) —
 * под ними.
 *
 * Для EN-локали — просто алфавитная сортировка через localeCompare:
 * все названия и так латинские.
 *
 * Используется в ToolVisibilityModal (админская шестерёнка) и
 * в `/tools` при выборе режима «Списком» (per-user тумблер).
 */
import { TOOLS_CONFIG, type ToolId } from './toolsRegistry';
import type { Locale } from './i18n';

const CYRILLIC_LEAD_RE = /^[Ѐ-ӿ]/;

export function sortToolIdsByTitle(
  ids: readonly ToolId[],
  locale: Locale,
): ToolId[] {
  const titleFor = (id: ToolId): string => {
    const cfg = TOOLS_CONFIG[id];
    return locale === 'en' ? (cfg.title_en ?? cfg.title) : cfg.title;
  };
  return [...ids].sort((a, b) => {
    const ta = titleFor(a).trim();
    const tb = titleFor(b).trim();
    if (locale !== 'en') {
      const aIsCyr = CYRILLIC_LEAD_RE.test(ta);
      const bIsCyr = CYRILLIC_LEAD_RE.test(tb);
      if (aIsCyr && !bIsCyr) return -1;
      if (!aIsCyr && bIsCyr) return 1;
    }
    return ta.localeCompare(tb, locale);
  });
}
