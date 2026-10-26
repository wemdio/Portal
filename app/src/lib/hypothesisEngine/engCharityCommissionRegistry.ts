import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { setImmediate as yieldLoop, setTimeout as sleep } from 'node:timers/promises';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { heCompanySiteIdentity } from './collectionIdentity';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, openHeEngRegistryZipEntry,
  ownHeEngRegistryText, readHeEngRegistryBulkFile, type HeEngRegistryBuildOptions } from './engRegistryBulkFile';
import { HeEngRegistryRetryError } from './engRegistryRetry';
import { heEngListedWebsite, heEngUsdAmount, heEngWebsiteNamesOrganisation, heEngWebsiteOfParentFederation } from './engSecAdviserRegistry';

/**
 * Registered charities in England and Wales from the Charity Commission's
 * public extract (keyless, daily, Open Government Licence): name, legal form,
 * contact address, website and e-mail, latest income and activities; the
 * number of employees from the annual return of the larger charities (about
 * 18 000); what, who and how codes. Three tables (60 MB zipped) are read once
 * a week.
 *
 * Only charities that are legal persons are kept: charitable companies, CIOs
 * and others with a company number. UK e-mail marketing law (PECR) treats an
 * unincorporated body — a trust, an association — like an individual, who
 * must have agreed to marketing e-mail first. The register's e-mail is kept
 * only on the charity's own website host: smaller charities often give a
 * trustee's personal address. A website several registered charities give
 * at different addresses or from one head office — a federation's or national
 * body's (bahai.org, citizensadvice.org.uk) given by its branches — is searched
 * for each; given by a charity and its trading arm at one address, it stays
 * with the larger whose name it carries.
 */
const BASE = 'https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/';
const TABLES = { charity: 'publicextract.charity', classification: 'publicextract.charity_classification', partb: 'publicextract.charity_annual_return_partb' };
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_TABLE_BYTES = 1024 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PAGE_SIZE = 25;
export const HE_ENG_CHARITY_COMMISSION_CATEGORIES: readonly string[] = ['charities', 'foundations'];
// UK charity income is roughly £40 000 per employee, a factor of three either way.
const INCOME_PER_EMPLOYEE = 40_000;
const INCOME_TOLERANCE = 3;
// Charities type the return themselves: under £3 000 of income per employee («484577 employees» on
// £575 000) is a figure from another box, so the headcount stays unknown.
const MIN_INCOME_PER_EMPLOYEE = 3_000;
const UK_POSTCODE = /(?:^|[^A-Z0-9])(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})(?![A-Z0-9])/;
// Jersey, Guernsey and the Isle of Man are not in the United Kingdom.
const CROWN_DEPENDENCY = /^(?:JE|GY|IM)\d/i;
// Country names, for a foreign address whose country was typed into the postcode field or ends the address («Kenya»).
const FOREIGN_COUNTRIES: ReadonlySet<string> = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const found = new Set<string>();
  for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const name = ['GB', 'UK'].includes(a + b) ? undefined : names.of(a + b);
    if (name) found.add(name.toUpperCase());
  }
  return found;
})();
// A supporters' charity gives its beneficiary's site: «Friends of X School» or «X School PTA» with the school's domain.
const SUPPORTERS = /^(?:the\s+)?friends\s+of\b|\b(?:pta|ptfa|pfa|parent[\s-]+teacher|parents'?\s+(?:and\s+friends\s+)?association)\b/i;
// A charity, its trading arm and its foundation share a site and an address; more charities at one address are branches run
// from a head office (the Bahá'í assemblies at SW7 1PD).
const MAX_FAMILY = 3;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Charity { number: string; organisation: string; name: string; type: string; address: string; website: string; email: string;
  income: number | null; period: string; employees: number | null; employeeYear: number | null; company: string; activities: string;
  grantMaker: boolean; uniqueName: boolean }
type Cell = (name: string, max?: number) => string;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function amount(raw: string): number | null {
  const value = Number(raw);
  return raw !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Rows of a tab-separated table (the extract has no quoting), as cell readers by column name. */
async function* table(stream: Readable, required: readonly string[]): AsyncGenerator<Cell> {
  let column: Record<string, number> | null = null;
  let width = 0;
  let count = 0;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    const cells: string[] = (column ? line : line.replace(/^\ufeff/, '')).split('\t');
    if (!column) {
      column = Object.fromEntries(cells.map((name, i) => [name.trim(), i]));
      width = cells.length;
      if (required.some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    if (cells.length !== width) continue;
    yield (name, max = 300) => column![name] === undefined ? '' : str(cells[column![name]], max);
    if (++count % 5000 === 0) await yieldLoop();
  }
}
async function download(name: string, options: HeEngRegistryBuildOptions): Promise<string> {
  return readHeEngRegistryBulkFile(`${BASE}${name}.zip`, heEngRegistryCacheFile(`ccew-${name}.zip`), { fetch: options.fetch, now: options.now,
    maxBytes: MAX_ZIP_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 10 * 60_000 });
}
function siteHost(site: string): string {
  try { return new URL(site).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
/** A UK postcode as typed, with its slips: «SW1A 1AA.», «N1 9GU UK», «S017 1BJ» (a zero for the O of SO17). */
function ukPostcode(typed: string): string {
  return UK_POSTCODE.exec(` ${typed.toUpperCase().replace(/^([A-Z])0(?=\d)/, '$1O')} `)?.[1] ?? '';
}
// Role mailboxes: on the parent domain only these are the organisation's.
const ROLE_MAILBOX = /^(?:info|office|enquir(?:y|ies)|admin|hello|contact|mail|general|reception|secretary|clerk|team|support|accounts|finance|fundraising|donations?)@/;
/**
 * The register's e-mail when it is on the charity's own website host or, for a
 * role mailbox, that host's parent domain: cclp@hermes.cam.ac.uk and
 * jd123@cam.ac.uk are people's university mailboxes, not cclp.group.cam.ac.uk's.
 */
function ownEmail(raw: string, site: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (!site || at < 1 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) return '';
  const mailHost = email.slice(at + 1); const host = siteHost(site);
  // The parent must still be the charity's registrable domain, not a public suffix.
  return host && heCompanySiteIdentity(mailHost)?.registrable === heCompanySiteIdentity(site)?.registrable &&
    (mailHost === host || (host.endsWith(`.${mailHost}`) && ROLE_MAILBOX.test(email))) ? email : '';
}

async function parse(files: { charity: string; classification: string; partb: string }): Promise<Charity[]> {
  const kept = new Map<string, Charity>();
  // Every registered charity, kept or not: how many share a name, and a website's charities and their postcode (null: several).
  const names = new Map<string, number>();
  const hosts = new Map<string, { charities: number; postcode: string | null }>();
  let seen = 0;
  for await (const cell of table(await openHeEngRegistryZipEntry(files.charity, MAX_TABLE_BYTES), ['organisation_number', 'registered_charity_number',
    'linked_charity_number', 'charity_name', 'charity_type', 'charity_registration_status', 'date_of_removal', 'latest_acc_fin_period_end_date',
    'latest_income', 'charity_contact_address1', 'charity_contact_postcode', 'charity_contact_email', 'charity_contact_web',
    'charity_company_registration_number', 'charity_insolvent', 'charity_in_administration', 'cio_is_dissolved', 'charity_activities'])) {
    seen += 1;
    const number = cell('registered_charity_number', 12); const name = cell('charity_name'); const type = cell('charity_type', 40);
    const company = cell('charity_company_registration_number', 12).toUpperCase();
    if (!/^\d{6,8}$/.test(number) || !name || cell('linked_charity_number', 4) !== '0' || cell('charity_registration_status', 20) !== 'Registered' ||
      cell('date_of_removal', 30)) continue;
    const key = heEngCharityNameKey(name);
    names.set(key, (names.get(key) ?? 0) + 1);
    const typed = cell('charity_contact_postcode', 12);
    const site = heEngListedWebsite(cell('charity_contact_web', 2048), { home: true });
    const host = site ? siteHost(site) : '';
    if (host) {
      const shared = hosts.get(host); const code = typed.toUpperCase().replace(/\s+/g, '');
      if (!shared) hosts.set(host, { charities: 1, postcode: code });
      else { shared.charities += 1; if (shared.postcode !== code) shared.postcode = null; }
    }
    // A legal person: a charitable company, a CIO, or another charity with a company number (royal charter bodies).
    const corporate = type === 'Charitable company' || type === 'CIO' || !!company;
    if (!corporate || cell('charity_insolvent', 6) === 'True' || cell('charity_in_administration', 6) === 'True' || cell('cio_is_dissolved', 6) === 'True') continue;
    // A town fragment typed into the postcode field («Cambridg») is left out of the address; a foreign postcode («D02 X285», «10001»),
    // a country («KENYA») or none is not a UK address.
    const postcode = ukPostcode(typed);
    const lines = ['charity_contact_address1', 'charity_contact_address2', 'charity_contact_address3', 'charity_contact_address4',
      'charity_contact_address5'].map(field => cell(field, 120)).filter(Boolean);
    if (!lines.length || !typed || (!postcode && (/\d/.test(typed) || lines.length < 2 || FOREIGN_COUNTRIES.has(typed.toUpperCase()))) ||
      CROWN_DEPENDENCY.test(postcode || typed) || /\b(?:jersey|guernsey|isle of man|channel islands)\b/i.test(lines.at(-1) ?? '') ||
      FOREIGN_COUNTRIES.has((lines.at(-1) ?? '').toUpperCase())) continue;
    // A branch naming its federation's site («… OF GREATER LEEDS» with the national domain), or a supporters' charity its
    // beneficiary's, is searched for its own.
    const label = (heCompanySiteIdentity(site)?.registrable ?? '').split('.')[0];
    const website = site && !heEngWebsiteOfParentFederation(site, name) && !(SUPPORTERS.test(name) && !/friends|pta|pfa|parent/.test(label)) ? site : '';
    // Copies: the list must not keep the parsed file text alive.
    kept.set(number, { number: ownHeEngRegistryText(number), organisation: ownHeEngRegistryText(cell('organisation_number', 12)), name: ownHeEngRegistryText(name),
      type: ownHeEngRegistryText(type || 'charity with a company number'), address: ownHeEngRegistryText(`${[...lines, postcode].filter(Boolean).join(', ')}, United Kingdom`),
      website: ownHeEngRegistryText(website), email: ownHeEngRegistryText(ownEmail(cell('charity_contact_email', 254), website)),
      income: amount(cell('latest_income', 20)), period: ownHeEngRegistryText(cell('latest_acc_fin_period_end_date', 10)), employees: null, employeeYear: null,
      company: ownHeEngRegistryText(/^[A-Z0-9]{6,8}$/.test(company) ? company : ''), activities: ownHeEngRegistryText(cell('charity_activities', 400)),
      grantMaker: false, uniqueName: false });
  }
  // A truncated or reshaped file is not the register (398 905 rows, 71 586 corporate charities kept in October 2026).
  if (seen < 200_000 || kept.size < 30_000) fail('registry_invalid_response');
  // A website several registered charities give: at different addresses, or by more than a family at one, it is searched for
  // each; by a family at one address, it stays with the largest kept one whose name it carries.
  const byHost = new Map<string, Charity[]>();
  for (const charity of kept.values()) {
    charity.uniqueName = names.get(heEngCharityNameKey(charity.name)) === 1;
    const host = charity.website ? siteHost(charity.website) : '';
    if (host) byHost.set(host, [...(byHost.get(host) ?? []), charity]);
  }
  for (const [host, group] of byHost) {
    const shared = hosts.get(host);
    if (!shared || shared.charities < 2) continue;
    const owner = shared.postcode === null || shared.charities > MAX_FAMILY ? undefined
      : group.filter(charity => heEngWebsiteNamesOrganisation(charity.website, [charity.name]))
      .sort((a, b) => (b.income ?? -1) - (a.income ?? -1) || Number(a.number) - Number(b.number))[0];
    for (const charity of group) if (charity !== owner) { charity.website = ''; charity.email = ''; }
  }
  // Grant-makers: «makes grants to organisations» without «provides services».
  const how = new Map<string, Set<string>>();
  let classified = 0;
  for await (const cell of table(await openHeEngRegistryZipEntry(files.classification, MAX_TABLE_BYTES), ['registered_charity_number', 'linked_charity_number',
    'classification_type', 'classification_code'])) {
    classified += 1;
    const number = cell('registered_charity_number', 12);
    if (cell('linked_charity_number', 4) !== '0' || cell('classification_type', 10) !== 'How' || !kept.has(number)) continue;
    const codes = how.get(number) ?? new Set<string>(); codes.add(cell('classification_code', 6)); how.set(number, codes);
  }
  // 1.1 million classification rows and 80 000 annual returns in October 2026: far fewer is a truncated file.
  if (classified < 100_000) fail('registry_invalid_response');
  for (const [number, codes] of how) kept.get(number)!.grantMaker = codes.has('302') && !codes.has('306');
  // Employees from the latest annual return of the larger charities.
  let returns = 0;
  for await (const cell of table(await openHeEngRegistryZipEntry(files.partb, MAX_TABLE_BYTES), ['registered_charity_number', 'latest_fin_period_submitted_ind',
    'fin_period_end_date', 'count_employees'])) {
    returns += 1;
    const charity = kept.get(cell('registered_charity_number', 12));
    const employees = amount(cell('count_employees', 12));
    if (!charity || cell('latest_fin_period_submitted_ind', 6) !== 'True' || employees === null) continue;
    const income = amount(cell('income_total_income_and_endowments', 20)) ?? charity.income;
    if (employees > 0 && (income === null || income / employees < MIN_INCOME_PER_EMPLOYEE)) continue;
    charity.employees = Math.round(employees);
    const year = Number(cell('fin_period_end_date', 10).slice(0, 4));
    charity.employeeYear = year >= 2000 && year <= 2100 ? year : null;
  }
  if (returns < 10_000) fail('registry_invalid_response');
  return [...kept.values()].sort((a, b) => size(b) - size(a) || Number(a.number) - Number(b.number));
}
/** Known employees, otherwise employees estimated from income. */
function size(charity: Charity): number { return charity.employees ?? (charity.income ?? 0) / INCOME_PER_EMPLOYEE; }

const charities = heEngRegistryBackgroundList(async (options: HeEngRegistryBuildOptions) => {
  const files = { charity: await download(TABLES.charity, options), classification: await download(TABLES.classification, options),
    partb: await download(TABLES.partb, options) };
  try { return await parse(files); }
  catch (error) { for (const file of Object.values(files)) await discardHeEngRegistryBulkFile(file); throw error; }
});

/** A charity name compared with other lists' names: lower case, no accents or punctuation, without «the» and «limited». */
export function heEngCharityNameKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(word => word && !['the', 'limited', 'ltd'].includes(word)).join(' ');
}
export interface HeEngCorporateCharities { names: ReadonlySet<string>; numbers: ReadonlySet<string> }
const corporate = new WeakMap<readonly Charity[], HeEngCorporateCharities>();
// Other lists wait this long for the register while it is built (three downloads of up to 10 minutes each); then they go on without it.
const CORPORATE_WAIT_MS = 40 * 60_000;
/**
 * The registered charities that are legal persons, for other UK lists whose
 * bodies may be charities (school proprietors, care providers): PECR lets a
 * corporate charity be e-mailed, not a trust. By number, and by name only
 * where no other registered charity has it («St Mary's School Trust» is many
 * trusts). Waits for the list while it is built; null when it cannot be read.
 */
export async function readHeEngCorporateCharities(options: HeEngRegistryBuildOptions): Promise<HeEngCorporateCharities | null> {
  const deadline = Date.now() + CORPORATE_WAIT_MS;
  for (;;) {
    try {
      const list = await charities(options);
      let sets = corporate.get(list);
      if (!sets) {
        sets = { names: new Set(list.filter(charity => charity.uniqueName).map(charity => heEngCharityNameKey(charity.name)).filter(Boolean)),
          numbers: new Set(list.map(charity => charity.number)) };
        corporate.set(list, sets);
      }
      return sets;
    } catch (error) {
      if (!(error instanceof HeEngRegistryRetryError) || Date.now() >= deadline) return null;
      await sleep(Math.max(1_000, Math.min(error.delayMs, 30_000, deadline - Date.now())));
    }
  }
}

/**
 * A known headcount outside the slice's range is skipped; otherwise income
 * keeps charities of roughly the slice's size. An open range reads the largest
 * first, a closed one those nearest its middle first.
 */
function slice(list: readonly Charity[], task: HeEngRegistryTask): Charity[] {
  const min = task.minEmployees ?? 0; const max = task.maxEmployees;
  const kept = list.filter(charity => charity.employees !== null
    ? charity.employees >= min && (max === undefined || charity.employees <= max)
    : charity.income !== null && size(charity) * INCOME_TOLERANCE >= min && (max === undefined || size(charity) / INCOME_TOLERANCE <= max));
  if (max === undefined) return kept;
  const middle = Math.log(Math.sqrt(Math.max(1, min) * Math.max(1, max)));
  return kept.map(charity => ({ charity, distance: Math.abs(Math.log(Math.max(1, size(charity))) - middle) }))
    .sort((a, b) => a.distance - b.distance || Number(a.charity.number) - Number(b.charity.number)).map(item => item.charity);
}
let ordered: { list: readonly Charity[]; key: string; charities: Charity[] } | null = null;

function candidate(charity: Charity): HeEngRegistryCandidate {
  const period = /^(\d{4})-(\d{2})/.exec(charity.period);
  return { provider: 'charity_commission', recordId: charity.number, company: charity.name, country: 'united kingdom', address: charity.address,
    addressKind: 'registered', category: `Registered charity (${charity.type})${charity.grantMaker ? ', grant-maker' : ''}`,
    ...(charity.employees !== null ? { employees: String(charity.employees) } : {}),
    ...(charity.employees !== null && charity.employeeYear ? { employeeYear: charity.employeeYear } : {}),
    ...(charity.company ? { localRegistryId: charity.company } : {}), website: charity.website, emails: charity.email ? [charity.email] : [],
    description: str(`A registered charity in England and Wales (${charity.type.toLowerCase()}${charity.company ? `, company ${charity.company}` : ''})${charity.income !== null ? `: income ${heEngUsdAmount(charity.income, '£')}${period ? ` for the year to ${period[1]}-${period[2]}` : ''}` : ''}${charity.employees !== null ? `, ${charity.employees} employees` : ''}${charity.grantMaker ? '; makes grants to organisations' : ''}. ${charity.activities} From the Charity Commission register (contact address${charity.website ? ', website' : ''}${charity.email ? ', e-mail on its own domain' : ''}); services and buyers require verification.`, 1500),
    sourceUrl: `https://register-of-charities.charitycommission.gov.uk/en/charity-search/-/charity-details/${charity.organisation}` };
}

/** One 25-charity page of a Charity Commission slice; the caller validates the task and the position. */
export async function readHeEngCharityCommissionRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'charity_commission' || task.country !== 'united kingdom' || !HE_ENG_CHARITY_COMMISSION_CATEGORIES.includes(task.category)) {
    fail('registry_invalid_task');
  }
  const all = await charities(options);
  const key = `${task.category}:${task.minEmployees ?? ''}:${task.maxEmployees ?? ''}`;
  if (ordered?.list !== all || ordered.key !== key) {
    ordered = { list: all, key, charities: slice(task.category === 'foundations' ? all.filter(charity => charity.grantMaker) : all, task) };
  }
  const page = ordered.charities.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= ordered.charities.length,
    excluded: {}, recordsRead: page.length };
}
