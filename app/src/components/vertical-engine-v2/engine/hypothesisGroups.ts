/** Порядок блоков на шаге «Гипотезы»: широкие отдельным блоком сверху, узкие — по вертикалям, как раньше. */

export const VE_BROAD_HYPOTHESES_TITLE = 'Широкие — для ежедневного добора';
export const VE_BROAD_HYPOTHESES_NOTE = 'Рынок большой, база пополняется каждый день.';

export interface VeHypothesisGroups<V, H> {
  /** Широкие гипотезы; пусто у старых проектов — тогда блока нет. */
  broad: H[];
  /** Вертикали с их узкими гипотезами; вертикаль из одних широких сюда не входит. */
  verticals: Array<{ vertical: V; hypotheses: H[] }>;
}

export function groupVeHypotheses<
  V extends { id: string },
  H extends { vertical_id: string | null; broad?: boolean },
>(verticals: V[], hypotheses: H[]): VeHypothesisGroups<V, H> {
  // Без вертикали гипотезу нельзя подготовить (база привязана к вертикали) — как и раньше, не показываем.
  const known = new Set(verticals.map((vertical) => vertical.id));
  const broad = hypotheses.filter((h) => h.broad === true && h.vertical_id !== null && known.has(h.vertical_id));
  const groups = verticals.flatMap((vertical) => {
    const own = hypotheses.filter((h) => h.vertical_id === vertical.id);
    const narrow = own.filter((h) => h.broad !== true);
    return own.length > 0 && narrow.length === 0 ? [] : [{ vertical, hypotheses: narrow }];
  });
  return { broad, verticals: groups };
}
