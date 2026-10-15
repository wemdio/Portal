/**
 * Страна прокси: код (UZ) → «Узбекистан» и флаг. Код приходит из проверки
 * прокси (proxyCheck.ts), название и флаг считаются на показе.
 */

const names = (() => {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function proxyCountryName(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  return names?.of(c) ?? c;
}

export function proxyCountryFlag(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)));
}

/** «🇺🇿 Узбекистан» или пусто, если страна не определена. */
export function proxyCountryLabel(code: string | null | undefined): string {
  const name = proxyCountryName(code);
  return name ? `${proxyCountryFlag(code)} ${name}`.trim() : '';
}
