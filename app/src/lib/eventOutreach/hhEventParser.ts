/**
 * One-shot HH.ru parse: finds employers across Russia that are currently
 * hiring for event / internal-communications roles. Run once per collection;
 * the resulting employer map is matched against the company shortlist to
 * derive the `seeking_event_manager` signal.
 */

const HH_API = 'https://api.hh.ru/vacancies';
const UA = 'PortalBot/1.0 (portal@wemd.io)';
const AREA_RUSSIA = '113';

/** Search phrases that indicate a company invests in events / internal culture. */
const EVENT_KEYWORDS = [
  'ивент-менеджер',
  'менеджер мероприятий',
  'event manager',
  'внутренние коммуникации',
  'специалист по корпоративной культуре',
];

const MAX_PAGES_PER_KEYWORD = 3;
const PER_PAGE = 100;

const COMPANY_PREFIXES = [
  'общество с ограниченной ответственностью',
  'публичное акционерное общество',
  'непубличное акционерное общество',
  'закрытое акционерное общество',
  'открытое акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'нко', 'ано', 'нао',
];

/** Normalizes a company name for fuzzy matching between the registry and HH. */
export function normalizeCompanyName(raw: string): string {
  let s = raw.toLowerCase().replace(/[«»"'`]/g, ' ');
  for (const prefix of COMPANY_PREFIXES) {
    s = s.replace(new RegExp(`(^|\\s)${prefix}(\\s|$)`, 'g'), ' ');
  }
  return s.replace(/[^a-zа-я0-9\s-]/gi, ' ').replace(/\s+/g, ' ').trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HHVacanciesResponse {
  items?: Array<{ employer?: { name?: string } }>;
  pages?: number;
}

/**
 * Returns a map of normalized employer name -> count of matched event vacancies.
 * Failures on individual requests are swallowed — a partial map is still useful.
 */
export async function parseEventEmployers(): Promise<Map<string, number>> {
  const employers = new Map<string, number>();

  for (const keyword of EVENT_KEYWORDS) {
    for (let page = 0; page < MAX_PAGES_PER_KEYWORD; page++) {
      const params = new URLSearchParams({
        text: keyword,
        area: AREA_RUSSIA,
        per_page: String(PER_PAGE),
        page: String(page),
        search_field: 'name',
      });

      try {
        const res = await fetch(`${HH_API}?${params}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) break;

        const data = (await res.json()) as HHVacanciesResponse;
        for (const item of data.items ?? []) {
          const name = item.employer?.name?.trim();
          if (!name) continue;
          const key = normalizeCompanyName(name);
          if (key.length < 2) continue;
          employers.set(key, (employers.get(key) ?? 0) + 1);
        }

        if (page + 1 >= (data.pages ?? 1)) break;
      } catch {
        break;
      }

      await sleep(250);
    }
  }

  console.log(`[event-outreach] HH event parse: ${employers.size} employers`);
  return employers;
}
