const TARGET_QUERY_COUNT = 10;

const CATEGORY_PATTERNS = {
  list: /(каталог|список|реестр|участник|тендер|закупк|импортер|дистриб|оптов|сеть|производител)/i,
  site: /(сайт|website|официал|контакт)/i,
  role: /(директор|ceo|собственник|закупк|коммерческ|операцион|маркетинг|продаж)/i,
} as const;

const REQUIRED_TEMPLATES = {
  list: '{topic} потенциальные клиенты "каталог компаний"',
  site: '{topic} потенциальные клиенты "официальный сайт" контакты',
  role: '{topic} "директор по закупкам" компании список',
} as const;

const FALLBACK_TEMPLATES = [
  '{topic} потенциальные клиенты "каталог компаний"',
  '{topic} потенциальные клиенты "список компаний"',
  '{topic} потенциальные клиенты "реестр компаний"',
  '{topic} потенциальные клиенты "участники выставки" 2024 2025',
  '{topic} "тендер" разработка внедрение',
  '{topic} "официальный сайт" контакты',
  '{topic} "сайт компании" контакты',
  '{topic} "отдел закупок" email',
  '{topic} "коммерческий директор" контакты',
];

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

export function deriveTopic(brief: string) {
  const cleaned = normalizeWhitespace(brief)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/[“”«»"]/g, '')
    .trim();
  if (!cleaned) return 'компания';
  const firstSentence = cleaned.split(/[.!?\n]/)[0]?.trim() ?? '';
  const words = firstSentence.split(' ').filter(Boolean).slice(0, 6);
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
  );
  const required: string[] = [];

  if (!parsed.some((q) => hasCategory(q, 'list'))) {
    required.push(applyTemplate(REQUIRED_TEMPLATES.list, topic));
  }
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
  ]);

  return filled.slice(0, TARGET_QUERY_COUNT);
}
