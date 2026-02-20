const TARGET_QUERY_COUNT = 30;

const CATEGORY_PATTERNS = {
  site: /(сайт|website|официал|контакт)/i,
  role: /(директор|ceo|собственник|закупк|коммерческ|операцион|маркетинг|продаж)/i,
} as const;

const REQUIRED_TEMPLATES = {
  site: '{topic} потенциальные клиенты "официальный сайт" контакты',
  role: '{topic} "директор по закупкам" компании список',
} as const;

const FALLBACK_TEMPLATES = [
  '{topic} "официальный сайт" контакты',
  '{topic} "официальный сайт" email',
  '{topic} "сайт компании" контакты',
  '{topic} "отдел закупок" email',
  '{topic} "отдел закупок" контакты',
  '{topic} "коммерческий директор" контакты',
  '{topic} "коммерческий директор" email',
  '{topic} "директор по развитию" контакты',
  '{topic} "директор по закупкам" email',
  '{topic} "руководитель отдела закупок" контакты',
  '{topic} "отдел снабжения" контакты',
  '{topic} "служба снабжения" email',
  '{topic} "операционный директор" контакты',
  '{topic} "финансовый директор" контакты',
  '{topic} "it-директор" контакты',
  '{topic} "генеральный директор" контакты',
  '{topic} компании "контакты" email',
  '{topic} компании официальный сайт',
  '{topic} компании контакты',
  '{topic} предприятия официальный сайт',
  '{topic} производители официальный сайт',
  '{topic} поставщики официальный сайт',
  '{topic} дистрибьюторы официальный сайт',
  '{topic} импортеры официальный сайт',
  '{topic} оптовые компании официальный сайт',
  '{topic} отраслевые компании контакты',
  '{topic} "отдел закупок" контакты',
  '{topic} "отдел продаж" контакты',
  '{topic} "отдел продаж" email',
  '{topic} "почта" контакты',
  '{topic} "контакты" email',
];

const BANNED_QUERY_PATTERN = /(каталог|список|реестр|участник|участники|тендер|выставк|конференц)/i;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function cleanQuery(value: string) {
  const trimmed = normalizeWhitespace(value);
  const noBullets = trimmed.replace(/^[\s\-*•\d.)]+\s*/, '');
  const noQuotes = noBullets.replace(/^["'`]+|["'`]+$/g, '');
  return normalizeWhitespace(noQuotes);
}

function dedupeQueries(queries: string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const query of queries) {
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(query);
  }
  return unique;
}

function extractJsonCandidate(content: string) {
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch?.[1] ?? content;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  return objectMatch?.[0] ?? null;
}

function parseJsonQueries(content: string) {
  const candidate = extractJsonCandidate(content);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as { queries?: unknown };
    if (!parsed?.queries || !Array.isArray(parsed.queries)) return null;
    return parsed.queries.filter((q) => typeof q === 'string') as string[];
  } catch {
    return null;
  }
}

function parseLineQueries(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => cleanQuery(line))
    .filter((line) => line.length > 2);
}

function applyTemplate(template: string, topic: string) {
  return template.replace('{topic}', topic);
}

function hasCategory(query: string, category: keyof typeof CATEGORY_PATTERNS) {
  return CATEGORY_PATTERNS[category].test(query);
}

function isBannedQuery(query: string) {
  return BANNED_QUERY_PATTERN.test(query);
}

export function deriveTopic(brief: string) {
  const cleaned = normalizeWhitespace(brief)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/[“”«»"]/g, '')
    .trim();
  if (!cleaned) return 'компания';

  const STOPWORDS = new Set(
    [
      // RU common filler/instructions
      'пожалуйста',
      'заполните',
      'заполни',
      'бриф',
      'анкету',
      'опрос',
      'как',
      'можно',
      'подробнее',
      'подробно',
      'чем',
      'тем',
      'чтобы',
      'нужно',
      'надо',
      'укажите',
      'укажи',
      'опишите',
      'описание',
      'пример',
      'например',
      'далее',
      'ниже',
      'выше',
      'ссылка',
      'ссылку',
      // generic parser words
      'контакты',
      'контакт',
      'email',
      'почта',
      'телефон',
      // EN common filler
      'please',
      'fill',
      'brief',
      'more',
      'details',
    ].map((s) => s.toLowerCase()),
  );

  const firstChunk = cleaned.split(/[\n\r]/)[0]?.trim() ?? cleaned;
  const rawWords = firstChunk
    .split(/\s+/g)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim())
    .filter(Boolean);

  const meaningful = rawWords.filter((w) => {
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) return false;
    if (/^\d{2,4}$/.test(lower)) return false; // years, short numbers
    if (lower.length < 3) return false;
    // require at least one letter (avoid pure punctuation)
    if (!/[\p{L}]/u.test(w)) return false;
    return true;
  });

  const words = (meaningful.length ? meaningful : rawWords).slice(0, 6);
  return words.join(' ') || 'компания';
}

export function parseSearchQueries(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const parsed = parseJsonQueries(trimmed);
  if (parsed) return parsed.map(cleanQuery).filter((q) => q.length > 2);
  return parseLineQueries(trimmed);
}

export function buildSearchQueries(content: string, brief: string) {
  const topic = deriveTopic(brief);
  const parsedRaw = parseSearchQueries(content).map(cleanQuery).filter(Boolean);
  const isRussianBrief = /[А-Яа-яЁё]/.test(brief);
  const parsed = dedupeQueries(
    isRussianBrief ? parsedRaw.filter((query) => /[А-Яа-яЁё]/.test(query)) : parsedRaw,
  ).filter((q) => !isBannedQuery(q));
  const required: string[] = [];

  if (!parsed.some((q) => hasCategory(q, 'site'))) {
    required.push(applyTemplate(REQUIRED_TEMPLATES.site, topic));
  }
  if (!parsed.some((q) => hasCategory(q, 'role'))) {
    required.push(applyTemplate(REQUIRED_TEMPLATES.role, topic));
  }

  const filled = dedupeQueries([
    ...required,
    ...parsed,
    ...FALLBACK_TEMPLATES.map((template) => applyTemplate(template, topic)),
  ]).filter((q) => !isBannedQuery(q));

  return filled.slice(0, TARGET_QUERY_COUNT);
}
