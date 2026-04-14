/**
 * Email permutator for Russian ФИО + company domain.
 * Generates candidate email addresses using common naming patterns
 * found in Russian corporate email systems.
 *
 * Input: "Иванов Петр Сергеевич" + "company.ru"
 * Output: ["ivanov@company.ru", "p.ivanov@company.ru", "pivanov@company.ru", ...]
 */

const TRANSLIT_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const TRANSLIT_MAP_ALT: Record<string, string> = {
  ...TRANSLIT_MAP,
  ж: 'j', х: 'h', ц: 'c', щ: 'sch', ю: 'iu', я: 'ia',
};

function transliterate(text: string, map: Record<string, string> = TRANSLIT_MAP): string {
  return text
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

export interface FioParts {
  lastName: string;
  firstName: string;
  patronymic: string | null;
}

export function parseFio(fullName: string): FioParts | null {
  const words = fullName.trim().split(/\s+/);
  if (words.length < 2) return null;
  return {
    lastName: words[0]!,
    firstName: words[1]!,
    patronymic: words[2] ?? null,
  };
}

export function generateEmailPermutations(fio: FioParts, domain: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const add = (local: string) => {
    const email = `${local}@${domain}`.toLowerCase();
    if (!seen.has(email) && local.length >= 2) {
      seen.add(email);
      results.push(email);
    }
  };

  for (const map of [TRANSLIT_MAP, TRANSLIT_MAP_ALT]) {
    const last = transliterate(fio.lastName, map);
    const first = transliterate(fio.firstName, map);
    const fl = first[0] ?? '';
    const pat = fio.patronymic ? transliterate(fio.patronymic, map) : '';
    const pl = pat ? pat[0] ?? '' : '';

    // Most common Russian corporate patterns
    add(last);                          // ivanov
    add(`${fl}.${last}`);               // p.ivanov
    add(`${fl}${last}`);                // pivanov
    add(`${first}.${last}`);            // petr.ivanov
    add(`${first}_${last}`);            // petr_ivanov
    add(`${last}.${fl}`);               // ivanov.p
    add(`${last}${fl}`);                // ivanovp
    add(`${last}.${first}`);            // ivanov.petr
    add(`${last}_${first}`);            // ivanov_petr
    add(first);                         // petr
    add(`${first}${last}`);             // petrivanov
    add(`${fl}${last[0] ?? ''}`);       // pi (too short, filtered)

    if (pl) {
      add(`${fl}.${pl}.${last}`);       // p.s.ivanov
      add(`${fl}${pl}${last}`);         // psivanov
      add(`${last}.${fl}.${pl}`);       // ivanov.p.s
      add(`${last}.${fl}${pl}`);        // ivanov.ps
    }

    add(`${fl}-${last}`);               // p-ivanov
    add(`${first}-${last}`);            // petr-ivanov
    add(`${last}-${first}`);            // ivanov-petr
  }

  return results;
}

export function generateEmailCandidates(fullName: string, domain: string): string[] {
  const fio = parseFio(fullName);
  if (!fio) return [];
  const cleanDomain = domain.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/\/.*$/, '').trim().toLowerCase();
  if (!cleanDomain || !cleanDomain.includes('.')) return [];
  return generateEmailPermutations(fio, cleanDomain);
}
