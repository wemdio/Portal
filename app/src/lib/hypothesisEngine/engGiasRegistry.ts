import { createReadStream } from 'node:fs';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { heEngCharityNameKey, readHeEngCorporateCharities, type HeEngCorporateCharities } from './engCharityCommissionRegistry';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, heEngRegistryCsvRows, ownHeEngRegistryText,
  readHeEngRegistryBulkFile, type HeEngRegistryBuildOptions } from './engRegistryBulkFile';
import { heEngListedWebsite, heEngSiteHost, heEngWebsiteNamesOrganisation } from './engSecAdviserRegistry';

/**
 * Schools and colleges in England from the Department for Education's «Get
 * Information about Schools» (keyless, daily): every open establishment with
 * its type, address, website and number of pupils (65 MB, Windows-1252), and
 * the academy trusts that run them, with their Companies House numbers. The
 * files are dated by day and read once a week.
 * - state_schools: academies, free schools, local-authority maintained and
 *   special schools (their governing bodies and trusts are legal persons);
 * - independent_schools: independent and independent special schools whose
 *   proprietor is a company or other corporation, by its name or because it is
 *   a corporate charity of the Charity Commission's register (the Girls' Day
 *   School Trust) — a school owned by a person, a partnership or an
 *   unincorporated trust may not be e-mailed without consent under UK law (PECR);
 * - colleges: further education and sixth form colleges, universities;
 * - academy_trusts: multi-academy trusts, which buy for their schools; they
 *   come without a website, and print their company number on their own.
 * The number of pupils orders a slice (staff are about one per nine pupils).
 * A website several schools give is their trust's or a platform's, so those
 * schools are searched for their own.
 */
const DOWNLOADS = 'https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public/';
const MAX_BYTES = 512 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// A file is published each day; a missing day falls back to the one before.
const DAYS_BACK = 7;
const PAGE_SIZE = 25;
export const HE_ENG_GIAS_CATEGORIES: readonly string[] = ['state_schools', 'independent_schools', 'colleges', 'academy_trusts'];
const STAFF_PER_PUPIL = 1 / 9;
const STAFF_TOLERANCE = 2;
// A proprietor that is a legal person: «… Ltd», «Corporation of London», «… University», «… CIO». A «school
// trust» without «Ltd» or a diocese may be an unincorporated trust, which PECR treats like a person.
const CORPORATE = /\b(?:ltd|limited|plc|llp|cio|cic|incorporated|inc|company|corporation|council|university)\b/i;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface School { id: string; name: string; category: string; kind: string; address: string; website: string; pupils: number | null; detail: string;
  /** Academy trust: its Companies House number. */
  company?: string }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function count(raw: string): number | null { return /^\d{1,7}$/.test(raw) ? Number(raw) : null; }

/** The newest daily file (today or up to a week back); a fresh copy on disk is used as it is. */
async function download(prefix: string, options: HeEngRegistryBuildOptions): Promise<string> {
  const now = (options.now ?? Date.now)();
  for (let back = 0; back <= DAYS_BACK; back += 1) {
    const day = new Date(now - back * 24 * 60 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
    try {
      return await readHeEngRegistryBulkFile(`${DOWNLOADS}${prefix}${day}.csv`, heEngRegistryCacheFile(`gias-${prefix}.csv`),
        { fetch: options.fetch, now: options.now, maxBytes: MAX_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 10 * 60_000 });
    } catch (error) {
      // Today's file may not be out yet: 404 (or the 500 this host gives for a missing name) moves to the day before.
      if (!(error instanceof Error) || !/^registry_http_(?:404|500)$/.test(error.message) || back === DAYS_BACK) throw error;
    }
  }
  return fail('registry_invalid_response');
}
async function* rows(file: string, required: readonly string[]): AsyncGenerator<(name: string, max?: number) => string> {
  let column: Record<string, number> | null = null;
  for await (const row of heEngRegistryCsvRows(createReadStream(file), ',', { maxBytes: MAX_BYTES, encoding: 'windows-1252' })) {
    if (!column) {
      column = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
      if (required.some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    yield (name, max = 300) => column![name] === undefined ? '' : str(row[column![name]], max);
  }
}

function schoolCategory(group: string, type: string): string {
  if (group === 'Independent schools' || type === 'Other independent special school') return 'independent_schools';
  if (['Academies', 'Local authority maintained schools', 'Free Schools', 'Special schools'].includes(group)) return 'state_schools';
  if (group === 'Colleges' || group === 'Universities') return 'colleges';
  return '';
}

// Words every school's name has: a domain carrying only these («myschoolsite») does not name one school.
const SCHOOL_WORDS = /\b(?:schools?|primary|secondary|junior|infants?|nursery|academy|college|church|england|cofe|catholic|high|community|federation|trust|saint|st)\b/gi;

async function parse(schoolsFile: string, groupsFile: string, charities: HeEngCorporateCharities | null): Promise<Map<string, School[]>> {
  const lists = new Map(HE_ENG_GIAS_CATEGORIES.map(category => [category, [] as School[]]));
  const trusts = new Map<string, { schools: number; pupils: number }>();
  // A website's schools and their postcode (null: several).
  const hosts = new Map<string, { schools: number; postcode: string | null }>();
  let seen = 0;
  for await (const cell of rows(schoolsFile, ['URN', 'EstablishmentName', 'TypeOfEstablishment (name)', 'EstablishmentTypeGroup (name)',
    'EstablishmentStatus (name)', 'PhaseOfEducation (name)', 'NumberOfPupils', 'Trusts (code)', 'Trusts (name)', 'Street', 'Town', 'Postcode',
    'SchoolWebsite', 'PropsName'])) {
    seen += 1;
    const status = cell('EstablishmentStatus (name)', 40);
    const type = cell('TypeOfEstablishment (name)', 80); const group = cell('EstablishmentTypeGroup (name)', 60);
    const category = schoolCategory(group, type);
    const id = cell('URN', 10); const name = cell('EstablishmentName'); const street = cell('Street', 150); const town = cell('Town', 80);
    const postcode = cell('Postcode', 12);
    if (!['Open', 'Open, but proposed to close'].includes(status) || !category || !/^\d{5,7}$/.test(id) || !name || !street || !town || !postcode) continue;
    const website = heEngListedWebsite(cell('SchoolWebsite', 2048), { home: true });
    const host = heEngSiteHost(website);
    if (host) {
      const shared = hosts.get(host); const code = postcode.toUpperCase().replace(/\s+/g, '');
      if (!shared) hosts.set(host, { schools: 1, postcode: code });
      else { shared.schools += 1; if (shared.postcode !== code) shared.postcode = null; }
    }
    // An independent school whose proprietor is a person or a partnership is not e-mailed (PECR).
    const proprietor = cell('PropsName', 200);
    if (category === 'independent_schools' && !CORPORATE.test(proprietor) && !charities?.names.has(heEngCharityNameKey(proprietor))) continue;
    const pupils = count(cell('NumberOfPupils', 10));
    const trust = cell('Trusts (code)', 10);
    if (trust && /^\d{1,7}$/.test(trust)) {
      const known = trusts.get(trust) ?? { schools: 0, pupils: 0 };
      known.schools += 1; known.pupils += pupils ?? 0; trusts.set(trust, known);
    }
    const address = [street, cell('Locality', 100), cell('Address3', 100), town, postcode].filter(Boolean).join(', ');
    const phase = cell('PhaseOfEducation (name)', 40);
    // Copies: the lists must not keep the parsed file text alive.
    lists.get(category)!.push({ id: ownHeEngRegistryText(id), name: ownHeEngRegistryText(name), category, kind: ownHeEngRegistryText(type.toLowerCase()),
      address: ownHeEngRegistryText(`${address}, United Kingdom`), website: ownHeEngRegistryText(website),
      pupils, detail: ownHeEngRegistryText([phase && phase !== 'Not applicable' ? phase.toLowerCase() : '', cell('Trusts (name)', 200) ? `part of ${cell('Trusts (name)', 200)}` : '']
        .filter(Boolean).join(', ')) });
  }
  // A truncated or reshaped file is not GIAS (52 594 establishments, 27 193 open in October 2026).
  if (seen < 30_000 || (lists.get('state_schools')?.length ?? 0) < 15_000) fail('registry_invalid_response');
  // A website up to three schools give at one postcode (an infant, a junior and a nursery school on one site) stays with the largest
  // whose own name it carries; given more widely (a trust's or federation's site, a platform's), it is dropped for all.
  const byHost = new Map<string, School[]>();
  for (const list of lists.values()) for (const school of list) {
    const host = heEngSiteHost(school.website);
    if ((hosts.get(host)?.schools ?? 0) > 1) byHost.set(host, [...(byHost.get(host) ?? []), school]);
  }
  for (const [host, group] of byHost) {
    const shared = hosts.get(host)!;
    const owner = shared.postcode === null || shared.schools > 3 ? undefined
      : group.filter(school => heEngWebsiteNamesOrganisation(school.website, [school.name.replace(SCHOOL_WORDS, ' ')]))
        .sort((a, b) => (b.pupils ?? -1) - (a.pupils ?? -1) || Number(a.id) - Number(b.id))[0];
    for (const school of group) if (school !== owner) school.website = '';
  }
  let groups = 0;
  for await (const cell of rows(groupsFile, ['Group UID', 'Group Name', 'Companies House Number', 'Group Type', 'Group Status', 'Group Street',
    'Group Town', 'Group Postcode'])) {
    groups += 1;
    const id = cell('Group UID', 10); const name = cell('Group Name');
    const members = trusts.get(id);
    if (cell('Group Type', 60) !== 'Multi-academy trust' || cell('Group Status', 20) !== 'Open' || !/^\d{1,7}$/.test(id) || !name || !members) continue;
    const address = [cell('Group Street', 150), cell('Group Locality', 100), cell('Group Address 3', 100), cell('Group Town', 80), cell('Group Postcode', 12)]
      .filter(Boolean).join(', ');
    if (!cell('Group Town', 80) || !cell('Group Postcode', 12)) continue;
    const company = cell('Companies House Number', 12).toUpperCase();
    lists.get('academy_trusts')!.push({ id: ownHeEngRegistryText(`T${id}`), name: ownHeEngRegistryText(name), category: 'academy_trusts',
      kind: 'multi-academy trust', address: ownHeEngRegistryText(`${address}, United Kingdom`), website: '', pupils: members.pupils || null,
      detail: `${members.schools} schools`, ...(/^[A-Z0-9]{8}$/.test(company) ? { company: ownHeEngRegistryText(company) } : {}) });
  }
  // A truncated groups file is not GIAS's (7 186 rows in October 2026).
  if (groups < 1_000) fail('registry_invalid_response');
  for (const list of lists.values()) list.sort((a, b) => (b.pupils ?? -1) - (a.pupils ?? -1) || (a.id < b.id ? -1 : 1));
  return lists;
}

const establishments = heEngRegistryBackgroundList(async (options: HeEngRegistryBuildOptions) => {
  const files = [await download('edubasealldata', options), await download('allgroupsdata', options)];
  // Charity-owned schools are told from trusts by the Charity Commission's register; without it only the proprietor's name decides.
  const charities = await readHeEngCorporateCharities(options);
  try { return await parse(files[0], files[1], charities); }
  catch (error) { for (const file of files) await discardHeEngRegistryBulkFile(file); throw error; }
});

/** Staff estimated from pupils outside the slice's range are skipped; colleges and universities have no pupil count and stay. */
function withinRange(school: School, task: HeEngRegistryTask): boolean {
  if (school.pupils === null) return school.category === 'colleges' || (task.minEmployees ?? 0) < 10;
  const staff = school.pupils * STAFF_PER_PUPIL;
  return staff * STAFF_TOLERANCE >= (task.minEmployees ?? 0) && (task.maxEmployees === undefined || staff / STAFF_TOLERANCE <= task.maxEmployees);
}

function candidate(school: School): HeEngRegistryCandidate {
  const trust = school.category === 'academy_trusts';
  return { provider: 'gias', recordId: school.id, company: school.name, country: 'united kingdom', address: school.address, addressKind: 'business',
    category: `GIAS ${school.kind}`, ...(school.company ? { localRegistryId: school.company } : {}), website: school.website, emails: [],
    description: str(`${trust ? `A multi-academy trust in England running ${school.detail}` : `A ${school.kind} in England${school.detail ? ` (${school.detail})` : ''}`}${school.pupils !== null ? `, ${school.pupils} pupils` : ''}${school.company ? `; company ${school.company}` : ''}. From the Department for Education's Get Information about Schools (address${school.website ? ', website' : ''}); staff count and buyers require verification.`, 1500),
    sourceUrl: trust ? `https://get-information-schools.service.gov.uk/Groups/Group/Details/${school.id.slice(1)}`
      : `https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/${school.id}` };
}

/** One 25-establishment page of a GIAS slice; the caller validates the task and the position. */
export async function readHeEngGiasRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'gias' || task.country !== 'united kingdom' || !HE_ENG_GIAS_CATEGORIES.includes(task.category)) fail('registry_invalid_task');
  const list = ((await establishments(options)).get(task.category) ?? []).filter(school => withinRange(school, task));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
