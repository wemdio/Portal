export const TRANSLIT_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

export function transliterate(text: string): string {
  return text.toLowerCase().split('').map((ch) => TRANSLIT_MAP[ch] ?? ch).join('');
}

export function normalizeCompanyNameForSearch(companyName: string): string {
  const cleaned = String(companyName ?? '')
    .replace(/[«»"'`]/g, ' ')
    .replace(/[(){}[\],;:|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const legalForms = new Set(['ооо', 'ао', 'пао', 'зао', 'оао', 'ип', 'llc', 'inc', 'ltd', 'corp', 'corporation']);
  return cleaned
    .split(/\s+/)
    .filter((w) => !legalForms.has(w.toLowerCase()))
    .join(' ')
    .trim();
}

export function extractCompanyAliases(companyName: string): string[] {
  const base = normalizeCompanyNameForSearch(companyName);
  if (!base) return [];
  const words = base.split(/\s+/).filter((w) => w.length > 2);
  const short = words.slice(0, 4).join(' ');
  return Array.from(new Set([companyName.trim(), base, short].filter((s) => s && s.length > 1)));
}

export function personNameVariants(name: string): string[] {
  const parts = name.split(/\s+/).filter((p) => p.length > 1);
  const latin = parts.map(transliterate).join(' ');
  const short = parts.length > 1 ? `${parts[0]} ${parts[1]}` : name;
  return Array.from(new Set([name.trim(), short.trim(), latin.trim()].filter(Boolean)));
}
