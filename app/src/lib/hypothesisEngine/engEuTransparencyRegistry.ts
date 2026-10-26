import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { engCountryLabel, normalizeEngCountry } from './engCountries';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, ownHeEngRegistryText, readHeEngRegistryBulkFile,
  type HeEngRegistryBuildOptions } from './engRegistryBulkFile';
import { heEngListedWebsite, heEngSiteHost, heEngWebsiteNamesOrganisation } from './engSecAdviserRegistry';

/**
 * Organisations in the EU Transparency Register (keyless, daily XML export,
 * reusable under Commission Decision 2011/833/EU): the companies,
 * consultancies, law firms, associations, NGOs, think tanks and academic
 * institutions that represent interests to the EU institutions, from any
 * country, with their head office and nearly always a website. The register
 * says nothing of size: its staff figure counts the people working on EU
 * representation. Self-employed individuals and organisations of one person,
 * public authorities, churches and third-country offices are left out. The export (120 MB) is read once a week;
 * a slice reads one category in its countries, most EU staff first.
 */
const SOURCE = 'https://ec.europa.eu/transparencyregister/public/files/ODP/download/XML/latest';
const FILE = 'eu-transparency-register.xml';
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_RECORD_CHARS = 4 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const PAGE_SIZE = 25;
/** Registry categories → the register's registration categories. */
export const HE_ENG_EU_TRANSPARENCY_CATEGORIES: Readonly<Record<string, string>> = {
  companies: 'Companies & groups', consultancies: 'Professional consultancies', law_firms: 'Law firms',
  trade_associations: 'Trade and business associations', professional_associations: 'Trade unions and professional associations',
  ngos: 'Non-governmental organisations, platforms and networks and similar', think_tanks: 'Think tanks and research institutions',
  academic: 'Academic institutions',
};
const CATEGORY_KEYS = new Map(Object.entries(HE_ENG_EU_TRANSPARENCY_CATEGORIES).map(([key, name]) => [name, key]));
// A company, its subsidiary and its foundation share a site and an address; more organisations at one address,
// or several addresses (Deloitte's member firms, a group's subsidiaries), each have a site of their own to find.
const MAX_FAMILY = 3;
// Organisations that declare a one-person form are people: «ditta individuale», «eenmanszaak», «sole trader».
const ONE_PERSON_FORM = /\b(?:sole[ -]?(?:trader|proprietor\w*)|ditta individuale|impresa individuale|eenmanszaak|einzel(?:unternehm\w*|kaufm\w*|firma)|entreprise individuelle|auto-?entrepreneur|micro-?entrepreneur|aut[oó]nom[oa]|empresario individual|empresa individual|enskild firma|enkeltmandsvirksomhed|enkeltpersonforetak|toiminimi|freelancer?|self-?employed|natural person|private (?:person|individual))\b/i;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Organisation { id: string; name: string; category: string; form: string; country: string; address: string; website: string;
  staff: number; goals: string }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (whole, hex: string, decimal: string, name: string) => {
    const point = hex ? parseInt(hex, 16) : decimal ? Number(decimal) : -1;
    return point >= 0 ? (point <= 0x10ffff ? String.fromCodePoint(point) : '') : ENTITIES[name.toLowerCase()] ?? whole;
  });
}
function tag(block: string, name: string, max = 300): string {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return match ? str(xmlText(match[1]), max) : '';
}
/** The export's `<interestRepresentative>` records, read from disk without holding the file. */
async function* records(file: string): AsyncGenerator<string> {
  const open = '<interestRepresentative>'; const close = '</interestRepresentative>';
  const decoder = new StringDecoder('utf8');
  let text = '';
  let count = 0;
  for await (const chunk of createReadStream(file)) {
    text += decoder.write(chunk as Buffer);
    let start = 0;
    for (let end = text.indexOf(close); end >= 0; end = text.indexOf(close, start)) {
      const from = text.indexOf(open, start);
      if (from >= 0 && from < end) yield text.slice(from + open.length, end);
      start = end + close.length;
      if (++count % 1000 === 0) await yieldLoop();
    }
    text = text.slice(start);
    if (text.length > MAX_RECORD_CHARS) fail('registry_invalid_response');
  }
}

async function parse(file: string): Promise<Organisation[]> {
  const kept: Organisation[] = [];
  // Every organisation's website and its postcode (null: several), kept or not.
  const hosts = new Map<string, { organisations: number; postcode: string | null }>();
  let seen = 0;
  for await (const block of records(file)) {
    seen += 1;
    const office = /<headOffice>([\s\S]*?)<\/headOffice>/.exec(block)?.[1] ?? '';
    const postcode = tag(office, 'postCode', 20).toUpperCase().replace(/\s+/g, '');
    const site = heEngListedWebsite(tag(block, 'webSiteURL', 2048), { home: true });
    const host = site ? heEngSiteHost(site) : '';
    if (host) {
      const shared = hosts.get(host);
      if (!shared) hosts.set(host, { organisations: 1, postcode });
      else { shared.organisations += 1; if (shared.postcode !== postcode) shared.postcode = null; }
    }
    const category = CATEGORY_KEYS.get(tag(block, 'registrationCategory', 120));
    const id = tag(block, 'identificationCode', 30);
    const name = str(xmlText(/<name>\s*<originalName>([^<]*)<\/originalName>/.exec(block)?.[1] ?? ''));
    const country = normalizeEngCountry(tag(office, 'country', 80));
    const street = tag(office, 'address', 200); const city = tag(office, 'city', 100);
    const form = tag(block, 'entityForm', 80);
    if (!category || !/^\d{9,15}-\d{2}$/.test(id) || !name || !country || !street || !city || ONE_PERSON_FORM.test(form)) continue;
    const staff = Number(tag(block, 'membersFTE', 20));
    // Copies: the list must not keep the parsed file text alive.
    kept.push({ id: ownHeEngRegistryText(id), name: ownHeEngRegistryText(name), category, form: ownHeEngRegistryText(form),
      country, address: ownHeEngRegistryText([street, [tag(office, 'postCode', 20), city].filter(Boolean).join(' '), engCountryLabel(country)].join(', ')),
      website: ownHeEngRegistryText(site), staff: Number.isFinite(staff) && staff >= 0 ? Math.round(staff * 10) / 10 : 0, goals: ownHeEngRegistryText(tag(block, 'goals', 300)) });
  }
  // A truncated or reshaped export is not the register (18 010 organisations, about 15 500 kept in October 2026).
  if (seen < 10_000 || kept.length < 5_000) fail('registry_invalid_response');
  // A website several organisations give: at different addresses, or by more than a family at one, it is searched for each;
  // by a family at one address it stays with the one with most EU staff that it names.
  const byHost = new Map<string, Organisation[]>();
  for (const organisation of kept) {
    const host = organisation.website ? heEngSiteHost(organisation.website) : '';
    if ((hosts.get(host)?.organisations ?? 0) > 1) byHost.set(host, [...(byHost.get(host) ?? []), organisation]);
  }
  for (const [host, group] of byHost) {
    const shared = hosts.get(host)!;
    const owner = shared.postcode === null || shared.organisations > MAX_FAMILY ? undefined
      : group.filter(organisation => heEngWebsiteNamesOrganisation(organisation.website, [organisation.name]))
        .sort((a, b) => b.staff - a.staff || (a.id < b.id ? -1 : 1))[0];
    for (const organisation of group) if (organisation !== owner) organisation.website = '';
  }
  return kept.sort((a, b) => b.staff - a.staff || (a.id < b.id ? -1 : 1));
}

const organisations = heEngRegistryBackgroundList(async (options: HeEngRegistryBuildOptions) => {
  const file = await readHeEngRegistryBulkFile(SOURCE, heEngRegistryCacheFile(FILE), { fetch: options.fetch, now: options.now, maxBytes: MAX_BYTES,
    maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  try { return await parse(file); }
  catch (error) { await discardHeEngRegistryBulkFile(file); throw error; }
});

function candidate(organisation: Organisation): HeEngRegistryCandidate {
  const { id, name, category, form, country, address, website, staff, goals } = organisation;
  const kind = HE_ENG_EU_TRANSPARENCY_CATEGORIES[category];
  return { provider: 'eu_transparency', recordId: id, company: name, country, address, addressKind: 'business',
    category: `EU Transparency Register: ${kind}`, website, emails: [],
    description: str(`An organisation in the EU Transparency Register (${kind}${form ? `, ${form}` : ''}), head office in ${engCountryLabel(country)}${staff ? `; ${staff} full-time equivalents on EU representation` : ''}.${goals ? ` ${goals}` : ''} Head office${website ? ' and website' : ''} from the register; size and buyers require verification.`, 1500),
    sourceUrl: `https://transparency-register.europa.eu/search-register-or-update/organisation-detail_en?id=${id}` };
}
let ordered: { list: readonly Organisation[]; key: string; organisations: Organisation[] } | null = null;

/** One 25-organisation page of a Transparency Register slice; the caller validates the task and the position. No size: every slice reads its whole category. */
export async function readHeEngEuTransparencyRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'eu_transparency' || task.country !== 'global' || !Object.hasOwn(HE_ENG_EU_TRANSPARENCY_CATEGORIES, task.category)) {
    fail('registry_invalid_task');
  }
  const all = await organisations(options);
  const countries = new Set(task.countries ?? []);
  const key = `${task.category}:${[...countries].join(',')}`;
  if (ordered?.list !== all || ordered.key !== key) {
    ordered = { list: all, key, organisations: all.filter(organisation => organisation.category === task.category && countries.has(organisation.country)) };
  }
  const page = ordered.organisations.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= ordered.organisations.length,
    excluded: {}, recordsRead: page.length };
}
