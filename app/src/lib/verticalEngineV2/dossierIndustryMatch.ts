import { getOkvedFlat } from '@/lib/companiesSearch/okved2';

export interface VeDossierIndustryCategory {
  code: string;
  name: string;
}

export interface VeDossierIndustryMatch {
  categories: VeDossierIndustryCategory[];
  note?: string;
}

// This is a broad directory slice, not an exact audience or a contact reserve.
const ALLOWED_CATEGORY_CODE = /^\d{2}(?:\.\d)?$/;
const GENERIC_TOKEN_PREFIXES = [
  'деятел', 'компан', 'организ', 'оказан', 'област', 'предос', 'произв',
  'проч', 'сервис', 'услуг',
  // A network of clinics is not an Internet network; a medical centre is not
  // a data centre. Organisational form must not establish an industry match.
  'сетев',
];
const GENERIC_TOKENS = new Set([
  'сети', 'сеть', 'сетей', 'сетям', 'сетями', 'сетях',
  'центр', 'центры', 'центра', 'центров', 'центрам', 'центрами', 'центрах', 'центре',
]);

function allTokens(value: string): string[] {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').match(/[a-zа-я0-9]+/g) ?? [];
}

function significantTokens(value: string): string[] {
  return [...new Set(allTokens(value))].filter((token) => token.length >= 4
    && !GENERIC_TOKENS.has(token)
    && !GENERIC_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix)));
}

function dedupeQueryTokenStems(tokens: string[]): string[] {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const stem = token.slice(0, 6);
    if (seen.has(stem)) return false;
    seen.add(stem);
    return true;
  });
}

// An exclusion in the official name is not a positive industry signal.
const NEGATIVE_CONTEXT_RE = /[\s(,;]+(?:кроме|исключая)(?:\s|:|$)/i;

function categoryScore(categoryName: string, queryTokens: string[]): number {
  const tokens = significantTokens(categoryName.split(NEGATIVE_CONTEXT_RE)[0]);
  return tokens.reduce((score, categoryToken) => score + queryTokens.reduce((tokenScore, queryToken) => {
    if (categoryToken === queryToken) return tokenScore + 2;
    const length = Math.min(6, categoryToken.length, queryToken.length);
    return tokenScore + (length >= 4 && categoryToken.slice(0, length) === queryToken.slice(0, length) ? 1 : 0);
  }, 0), 0);
}

/** Only a provider named by the vertical itself can select human healthcare. */
function namesHealthcareProvider(tokens: string[]): boolean {
  return tokens.some((token) => /^(?:медицина|медицины|медицине|медицину|медициной)$/.test(token)
    || /^(?:клиник|поликлиник|стоматолог|больниц|медцентр|здравоохран|санатор)/.test(token))
    || (tokens.some((token) => /^(?:медицинск|лечебн)/.test(token))
      && tokens.some((token) => /^(?:центр|учрежден|организац|помощ|практик|услуг|лаборатор)/.test(token)));
}

// Suppliers, software for clinics, veterinary services, etc. must not be
// counted as human healthcare providers merely because they mention clinics.
const NON_PROVIDER_CONTEXT = /^(?:оборуд|инструмент|техник|издели|продукт|лекар|фарм|аптек|постав|производ|оптов|торгов|дистриб|программ|маркет|реклам|интернет|портал|информацион|исслед|образова|обучен|ветерин|животн)/;

/**
 * Conservative VE2-only industry matching. Clear healthcare provider names
 * use their subject-matter class; lexical matches still need the original
 * vertical's support, not an unrelated word found only in generated synonyms.
 * An uncertain selection remains unknown rather than a spurious zero market.
 */
export function matchVeDossierIndustryCategories(
  verticalName: string,
  synonyms: string[] = [],
): VeDossierIndustryMatch {
  const categories = getOkvedFlat()
    .filter((entry) => ALLOWED_CATEGORY_CODE.test(entry.code))
    .map(({ code, name }) => ({ code, name }));
  const titleTokens = allTokens(verticalName);
  if (namesHealthcareProvider(titleTokens)) {
    if (titleTokens.some((token) => NON_PROVIDER_CONTEXT.test(token))) return { categories: [] };
    // Do not silently report only the medical half of "клиники и рестораны".
    // Synonyms can describe the slice, but cannot resolve a mixed title.
    const audiences = verticalName.split(/[,;/&+]|\s+(?:и|или)\s+/iu).map((part) => part.trim()).filter(Boolean);
    if (audiences.length > 1 && audiences.some((part) => !namesHealthcareProvider(allTokens(part)))) {
      return { categories: [] };
    }
    return {
      categories: categories.filter((category) => category.code === '86'),
      note: 'Широкий срез здравоохранения: ОКВЭД не отделяет частные организации от государственных. Это не оценка точной аудитории гипотезы или готовых контактов.',
    };
  }

  const primaryTokens = dedupeQueryTokenStems(significantTokens(verticalName));
  if (!primaryTokens.length) return { categories: [] };
  const queryTokens = dedupeQueryTokenStems(significantTokens([verticalName, ...synonyms].join(' ')));
  const ranked = categories
    .map((category) => ({ category, score: categoryScore(category.name, queryTokens) }))
    // Keep the original threshold: one medical stem must not include pharma
    // or medical-equipment manufacturing as a healthcare provider audience.
    .filter(({ category, score }) => score >= 2 && categoryScore(category.name, primaryTokens) > 0
      && !(category.code.startsWith('86') && titleTokens.some((token) => NON_PROVIDER_CONTEXT.test(token))))
    .sort((a, b) => b.score - a.score || a.category.code.localeCompare(b.category.code, 'ru-RU'));
  const best = ranked.filter(({ score }) => score === ranked[0]?.score);
  // Do not add weaker unrelated slices just to fill three slots (e.g. data
  // processing plus wood/stone processing). A tie across classes is ambiguous.
  if (new Set(best.map(({ category }) => category.code.slice(0, 2))).size > 1) return { categories: [] };
  return {
    categories: best.slice(0, 3).map(({ category }) => category),
  };
}
