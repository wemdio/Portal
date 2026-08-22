/**
 * Рынок проекта Движка вертикалей: ru (по умолчанию, обратная совместимость)
 * или us (ENG-пайплайн). Определяет geo-параметры поиска (Serper), язык
 * промптов research-стадий и дефолтный язык цепочек писем.
 */

export type VeMarket = 'ru' | 'us';

export function normalizeVeMarket(value: unknown): VeMarket {
  return value === 'us' ? 'us' : 'ru';
}

/** Geo-параметры Serper (google.serper.dev): страна и язык интерфейса. */
export function serperGeoForMarket(market: VeMarket): { gl: string; hl: string } {
  return market === 'us' ? { gl: 'us', hl: 'en' } : { gl: 'ru', hl: 'ru' };
}

/** Дефолтный язык цепочки писем, если пользователь явно не выбрал. */
export function defaultChainLanguageForMarket(market: VeMarket): 'ru' | 'en' {
  return market === 'us' ? 'en' : 'ru';
}

/** Прочитать рынок из строки ve_projects (колонка market появилась в 20260804_0002). */
export function projectMarket(project: { market?: string | null }): VeMarket {
  return normalizeVeMarket(project.market);
}
