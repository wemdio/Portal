import { setImmediate as yieldLoop } from 'node:timers/promises';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { HE_ENG_NACE_CLASSES } from './engNaceRegistryCatalog';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { heEngRegistryBackgroundList, ownHeEngRegistryText, readHeEngRegistryRemoteZipDirectory, readHeEngRegistryRemoteZipFile,
  type HeEngRegistryBuildOptions } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';
import { heEngListedWebsite, heEngSiteEmail, heEngSiteHost, heEngWebsiteNamesOrganisation } from './engSecAdviserRegistry';

/**
 * German organisations from the Federal Network Agency's energy market
 * register (Marktstammdatenregister, keyless, daily, Datenlizenz Deutschland):
 * every operator of a solar, wind or CHP unit and every other market actor
 * files its legal form, commercial register and VAT numbers, address, main
 * economic activity (a NACE group), whether it is an SME, and often its
 * website and e-mail. Germany has no free company register file, and this one
 * reaches well beyond energy: about 290 000 organisations, firms of every
 * sector with a unit on their roof. Kept: legal persons of the catalogue's
 * activity groups (sole traders and partnerships of people name people; natural
 * persons are filed apart). Only the 58 market-actor files (170 MB) are read out
 * of the 3.3 GB export, by byte ranges, once a day.
 */
const LISTING = 'https://www.marktstammdatenregister.de/MaStR/Datendownload';
const EXPORT = /https:\/\/download\.marktstammdatenregister\.de\/Gesamtdatenexport_(\d{8})_\d+(?:\.\d+)*\.zip/g;
const ACTOR_FILE = /^Marktakteure_\d+\.xml$/;
const CATALOGUE_FILE = 'Katalogwerte.xml';
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const FILE_TIMEOUT_MS = 5 * 60_000;
const PAGE_SIZE = 25;
// The register's catalogue ids (Katalogwerte): an organisation, Germany, the commercial register's prefixes.
const ORGANISATION = '517';
const GERMANY = '84';
const REGISTERS: Readonly<Record<string, string>> = { 1003: 'HRA', 1004: 'HRB', 1005: 'GnR', 1006: 'PR', 1007: 'VR', 3101: 'GsR' };
// NACE groups (category 159) of the catalogue's sectors → the sector's class: the register files a group, not a class.
// Both the WZ 2008 ids and the newer WZ 2025 ids occur; each name is checked against the export's catalogue.
const GROUPS: Readonly<Record<string, readonly [string, string]>> = {
  2748: ['58.29', 'Verlegen von Software'], 2757: ['62.10', 'Erbringung von Dienstleistungen der Informationstechnologie'],
  3138: ['62.10', 'Programmierungstätigkeiten'],
  3139: ['62.20', 'Erbringung von Dienstleistungen der IT-Beratung sowie des Betriebs von Datenverarbeitungseinrichtungen'],
  3140: ['62.90', 'Erbringung von sonstigen Dienstleistungen der Informationstechnologie'], 2760: ['64.19', 'Zentralbanken und Kreditinstitute'],
  2767: ['66.19', 'Mit Finanzdienstleistungen verbundene Tätigkeiten'], 2769: ['66.30', 'Fondsmanagement'], 2764: ['65.11', 'Versicherungen'],
  2765: ['65.20', 'Rückversicherungen'], 2768: ['66.22', 'Mit Versicherungsdienstleistungen und Pensionskassen verbundene Tätigkeiten'],
  2816: ['86.10', 'Krankenhäuser'], 2817: ['86.21', 'Arzt- und Zahnarztpraxen'], 2728: ['49.41', 'Güterbeförderung im Straßenverkehr, Umzugstransporte'],
  2696: ['41.00', 'Bau von Gebäuden'], 3128: ['41.00', 'Hochbau'], 2740: ['55.10', 'Hotels, Gasthöfe und Pensionen'],
  2664: ['28.99', 'Herstellung von nicht wirtschaftszweigspezifischen Maschinen'],
  2665: ['28.29', 'Herstellung von sonstigen nicht wirtschaftszweigspezifischen Maschinen'],
  2666: ['28.99', 'Herstellung von land- und forstwirtschaftlichen Maschinen'], 2667: ['28.99', 'Herstellung von Werkzeugmaschinen'],
  2668: ['28.99', 'Herstellung von Maschinen für sonstige bestimmte Wirtschaftszweige'], 2773: ['69.10', 'Rechtsberatung'],
  2774: ['69.20', 'Wirtschaftsprüfung und Steuerberatung; Buchführung'],
  2772: ['68.31', 'Vermittlung und Verwaltung von Grundstücken, Gebäuden und Wohnungen für Dritte'],
  2777: ['71.12', 'Tätigkeiten von Architektur- und Ingenieurbüros'], 2787: ['75.00', 'Veterinärwesen'],
  2795: ['79.11', 'Reisebüros und Reiseveranstalter'], 2792: ['78.10', 'Vermittlung von Arbeitskräften'],
  2793: ['78.20', 'Überlassung von Arbeitskräften und sonstige Personaldienstleistungen'], 2794: ['78.20', 'Sonstige Überlassung von Arbeitskräften'],
  2781: ['73.11', 'Werbung'],
};
// Legal persons (category 16): companies, co-operatives, registered associations, foundations, public bodies and municipal
// enterprises, partnerships whose liable partner is a company («GmbH & Co. KG»), foreign companies. Sole traders, civil-law and
// general partnerships of people and «other» forms are left out: their records name people.
const FORMS: Readonly<Record<string, string>> = {
  409: 'AG', 410: 'AG & Co. KGaA', 411: 'Anstalt des öffentlichen Rechts', 423: 'eG', 425: 'e.V.', 426: 'Eigenbetrieb', 429: 'GmbH',
  430: 'GmbH & Co. KG', 431: 'GmbH & Co. KGaA', 432: 'GmbH & Co. oHG', 435: 'InvAG', 439: 'KGaA', 440: 'Körperschaft des öffentlichen Rechts',
  452: 'SE', 457: 'Stiftung des öffentlichen Rechts', 458: 'Stiftung des Privatrechts', 460: 'UG (haftungsbeschränkt)',
  461: 'UG (haftungsbeschränkt) & Co. KG', 462: 'UG (haftungsbeschränkt) & Co. oHG', 464: 'VVaG', 466: 'gGmbH', 1001674: 'SE ＆ Co. KG',
  407: 'a.s.', 408: 'AB', 412: 'ApS', 413: 'AS', 414: 'BV', 415: 'BVBA', 441: 'Ltd.', 442: 'N.V.', 444: 'OY', 446: 'plc', 447: 'S.A.', 448: 'S.p.A.',
  449: 's.r.l.', 450: 's.r.o.', 451: 'SARL', 454: 'sp. z.o.o.', 456: 'SPRL', 1001685: 'B.V.',
};
const CATALOGUE_CHECK: Readonly<Record<string, string>> = {
  [ORGANISATION]: 'Organisation (Unternehmen, Personengesellschaft, juristische Person, Behörde, Verband)', [GERMANY]: 'Deutschland',
  1004: 'HRB', ...Object.fromEntries(Object.entries(GROUPS).map(([id, [, name]]) => [id, name])), ...FORMS,
};
const CLASSES = new Set(HE_ENG_NACE_CLASSES);
// The SME flag: 1 an SME by the EU definition (under 250 staff), 0 not one (250+ staff or a large turnover).
const SME = '1';
const NOT_SME = '0';
const SME_MAX_EMPLOYEES = 249;
// A company, its subsidiary and its foundation share a site and an address; more organisations at one address,
// or several addresses, are a group's or a developer's project companies.
const MAX_FAMILY = 3;
// «vorname.nachname@…» is a person's mailbox and is left out; «energie-service@…» or «info.berlin@…» is the company's.
const PERSON_MAILBOX = /^([a-zäöüß]{2,})[._-]([a-zäöüß]{2,})@/i;
const ROLE_WORDS = /^(?:info|kontakt|contact|office|mail|post|service|support|zentrale|empfang|verwaltung|buchhaltung|rechnungs?|rechnungen|energie|strom|technik|einkauf|vertrieb|sales|team|hallo|hello|sekretariat|personal|jobs|karriere|presse|marketing|netz|betrieb|anlagen|solar|pv|haus|hotel|klinik|bank|kanzlei|praxis|firma|admin|it|edv)$/i;
function companyMailbox(email: string): string {
  const match = PERSON_MAILBOX.exec(email);
  return match && !ROLE_WORDS.test(match[1]) && !ROLE_WORDS.test(match[2]) ? '' : email;
}

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
// [MaStR number, name, street, postcode, city, form id, group id, SME flag, website, e-mail, register number, VAT number]
type Organisation = [string, string, string, string, string, string, string, string, string, string, string, string];
interface Register { byClass: Map<string, Organisation[]> }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  // The register writes some names with a full-width ampersand («Lemken GmbH ＆ Co. KG»).
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/＆/g, '&').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(raw: string): string {
  return raw.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (whole, hex: string, decimal: string, name: string) => {
    const point = hex ? parseInt(hex, 16) : decimal ? Number(decimal) : -1;
    return point >= 0 ? (point <= 0x10ffff ? String.fromCodePoint(point) : '') : ENTITIES[name.toLowerCase()] ?? whole;
  });
}
// A file's text is decoded a window at a time: a whole file is 110 MB of UTF-16, twice that as one string.
const WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_CHARS = 1024 * 1024;
/**
 * Each `<tag>…</tag>` record of one of the export's files (UTF-16 with a
 * byte-order mark): its fields by name. The values are views of the window and
 * are copied before they are kept.
 */
function* records(content: Buffer, tag: string): Generator<Record<string, string>> {
  const decoder = new TextDecoder(content[0] === 0xfe && content[1] === 0xff ? 'utf-16be' : 'utf-16le');
  const open = `<${tag}>`; const close = `</${tag}>`;
  let text = '';
  for (let offset = 0; offset < content.length; offset += WINDOW_BYTES) {
    text += decoder.decode(content.subarray(offset, offset + WINDOW_BYTES), { stream: offset + WINDOW_BYTES < content.length });
    let start = text.indexOf(open);
    for (let end = start >= 0 ? text.indexOf(close, start) : -1; start >= 0 && end >= 0; end = start >= 0 ? text.indexOf(close, start) : -1) {
      const fields: Record<string, string> = {};
      for (const match of text.slice(start + open.length, end).matchAll(/<(\w+)>([^<]*)<\/\1>/g)) fields[match[1]] = match[2];
      yield fields;
      start = text.indexOf(open, end + close.length);
    }
    text = start >= 0 ? text.slice(start) : text.slice(-open.length);
    if (text.length > MAX_RECORD_CHARS) fail('registry_invalid_response');
  }
}

async function build(options: HeEngRegistryBuildOptions): Promise<Register> {
  const listing = await readHeEngRegistryText(LISTING, { fetch: options.fetch, accept: 'text/html', maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000 });
  const url = [...listing.matchAll(EXPORT)].sort((a, b) => b[1].localeCompare(a[1]))[0]?.[0] ?? fail('registry_invalid_response');
  const remote = { fetch: options.fetch, timeoutMs: FILE_TIMEOUT_MS, maxBytes: MAX_FILE_BYTES };
  const directory = await readHeEngRegistryRemoteZipDirectory(url, remote, name => ACTOR_FILE.test(name) || name === CATALOGUE_FILE);
  const files = [...directory.entries.keys()].filter(name => ACTOR_FILE.test(name));
  // 58 market-actor files in October 2026; far fewer is not the export.
  if (files.length < 30) fail('registry_invalid_response');
  // The ids above are the export's own: a catalogue that names one differently is a renumbered register.
  const catalogue = new Map<string, string>();
  for (const value of records(await readHeEngRegistryRemoteZipFile(url, directory.entries.get(CATALOGUE_FILE) ?? fail('registry_invalid_response'),
    directory.end, remote), 'Katalogwert')) catalogue.set(value.Id, str(xmlText(value.Wert ?? '')));
  if (Object.entries(CATALOGUE_CHECK).some(([id, name]) => catalogue.get(id) !== str(name))) fail('registry_invalid_response');
  const kept: Organisation[] = [];
  // Every organisation's website and its postcode (null: several), kept or not, each company once.
  const hosts = new Map<string, { organisations: number; postcode: string | null }>();
  const counted = new Set<string>();
  // One company files a record per role or registration: the same register number at one postcode, or the same VAT number.
  const companies = new Map<string, Organisation>();
  let organisations = 0;
  for (const name of files) {
    for (const actor of records(await readHeEngRegistryRemoteZipFile(url, directory.entries.get(name)!, directory.end, remote), 'Marktakteur')) {
      if (actor.Personenart !== ORGANISATION) continue;
      organisations += 1;
      const field = (key: string, max = 300) => str(xmlText(actor[key] ?? ''), max);
      const postcode = field('Postleitzahl', 10);
      const prefix = REGISTERS[field('RegisternummerPraefix', 10)]; const register = field('Registernummer', 20).toUpperCase();
      const registerNumber = prefix && /^\d{1,7}(?: ?[A-Z]{1,3})?$/.test(register) ? `${prefix} ${register}` : '';
      const vat = /^DE\d{9}$/.test(field('Umsatzsteueridentifikationsnummer', 20).replace(/\s+/g, '').toUpperCase())
        ? field('Umsatzsteueridentifikationsnummer', 20).replace(/\s+/g, '').toUpperCase() : '';
      const company = ownHeEngRegistryText(registerNumber ? `${registerNumber}|${postcode}` : vat || `${field('Firmenname').toLowerCase()}|${postcode}`);
      const site = heEngListedWebsite(field('Webseite', 2048), { home: true });
      const host = site ? heEngSiteHost(site) : '';
      if (host && !counted.has(`${host} ${company}`)) {
        counted.add(ownHeEngRegistryText(`${host} ${company}`));
        const shared = hosts.get(host);
        if (!shared) hosts.set(host, { organisations: 1, postcode: ownHeEngRegistryText(postcode) });
        else { shared.organisations += 1; if (shared.postcode !== postcode) shared.postcode = null; }
      }
      // The writer's typo «Hauptwirtdschaftszweig» is the export's element name.
      const group = field('HauptwirtdschaftszweigGruppe', 10) || field('HauptwirtschaftszweigGruppe', 10);
      const form = field('Rechtsform', 10); const number = field('MastrNummer', 20);
      const street = [field('Strasse', 150), field('Hausnummer', 20)].filter(Boolean).join(' '); const city = field('Ort', 80);
      if (field('Land', 10) !== GERMANY || field('Taetigkeitsende', 20) || !GROUPS[group] || !FORMS[form] || !/^[A-Z]{3}9\d{11}$/.test(number) ||
        !field('Firmenname') || !street || !city || !/^\d{5}$/.test(postcode)) continue;
      const email = companyMailbox(heEngSiteEmail(field('Email', 254), site));
      const twin = companies.get(company);
      // A company's second record adds the website its first lacked.
      if (twin) { if (!twin[8] && site) { twin[8] = ownHeEngRegistryText(site); twin[9] = ownHeEngRegistryText(email); } continue; }
      // Copies: the index must not keep the parsed file text alive.
      const organisation: Organisation = [ownHeEngRegistryText(number), ownHeEngRegistryText(field('Firmenname')), ownHeEngRegistryText(street),
        ownHeEngRegistryText(postcode), ownHeEngRegistryText(city), ownHeEngRegistryText(form), ownHeEngRegistryText(group),
        ownHeEngRegistryText(field('Kmu', 4)), ownHeEngRegistryText(site), ownHeEngRegistryText(email), ownHeEngRegistryText(registerNumber),
        ownHeEngRegistryText(vat)];
      companies.set(company, organisation);
      kept.push(organisation);
    }
    await yieldLoop();
  }
  // A truncated export is not the register (293 373 organisations, 14 229 kept in October 2026).
  if (organisations < 150_000 || kept.length < 5_000) fail('registry_invalid_response');
  // A website several organisations give: at different addresses, or by more than a family at one, it is searched for each
  // (Helios gives one site for its hospitals); by a family at one address it stays with the larger one it names.
  const byHost = new Map<string, Organisation[]>();
  for (const organisation of kept) {
    const host = organisation[8] ? heEngSiteHost(organisation[8]) : '';
    if ((hosts.get(host)?.organisations ?? 0) > 1) byHost.set(host, [...(byHost.get(host) ?? []), organisation]);
  }
  for (const [host, group] of byHost) {
    const shared = hosts.get(host)!;
    const owner = shared.postcode === null || shared.organisations > MAX_FAMILY ? undefined
      : group.filter(organisation => heEngWebsiteNamesOrganisation(organisation[8], [organisation[1]]))
        .sort((a, b) => (a[7] === NOT_SME ? 0 : 1) - (b[7] === NOT_SME ? 0 : 1) || (a[0] < b[0] ? -1 : 1))[0];
    for (const organisation of group) if (organisation !== owner) { organisation[8] = ''; organisation[9] = ''; }
  }
  const byClass = new Map<string, Organisation[]>();
  for (const organisation of kept) {
    const key = GROUPS[organisation[6]][0];
    const list = byClass.get(key);
    if (list) list.push(organisation); else byClass.set(key, [organisation]);
  }
  for (const list of byClass.values()) list.sort((a, b) => a[0] < b[0] ? -1 : 1);
  return { byClass };
}
/** The register once read, rebuilt from the export after a day (engRegistryBulkFile). */
const register = heEngRegistryBackgroundList(build);

function candidate(organisation: Organisation): HeEngRegistryCandidate {
  const [number, name, street, postcode, city, form, group, sme, website, email, registerNumber, vat] = organisation;
  const size = sme === SME ? ', an SME by the EU definition' : sme === NOT_SME ? ', not an SME by the EU definition (250+ staff or a large turnover)' : '';
  return { provider: 'mastr', recordId: number, company: name, country: 'germany', address: `${street}, ${postcode} ${city}, Germany`,
    addressKind: 'registered', category: `MaStR, WZ group «${GROUPS[group][1]}»`, ...(registerNumber ? { localRegistryId: registerNumber } : {}),
    ...(vat ? { vatNumber: vat } : {}), website, emails: email ? [email] : [],
    description: str(`A German organisation (${FORMS[form]}; main activity «${GROUPS[group][1]}»)${size}. From the Federal Network Agency's energy market register (Marktstammdatenregister), where it files as a market actor: registered address${website ? ', website' : ''}${email ? ', e-mail on its own domain' : ''}${registerNumber ? `, commercial register ${registerNumber}` : ''}. Size and buyers require verification.`, 1500),
    sourceUrl: `https://www.marktstammdatenregister.de/MaStR/Akteur/Marktakteur/IndexOeffentlich?filter=MaStR-Nr.~eq~%27${number}%27` };
}

/**
 * An SME has fewer than 250 staff, so a slice of 250+ skips it; a non-SME may still have fewer (a large turnover) and stays.
 * Larger organisations come first, except in a slice of small ones.
 */
function slice(list: readonly Organisation[], task: HeEngRegistryTask): Organisation[] {
  const kept = list.filter(organisation => organisation[7] !== SME || (task.minEmployees ?? 0) <= SME_MAX_EMPLOYEES);
  const small = task.maxEmployees !== undefined && task.maxEmployees <= SME_MAX_EMPLOYEES;
  const rank = (organisation: Organisation) => organisation[7] === NOT_SME ? 0 : organisation[7] === SME ? 2 : 1;
  return kept.map((organisation, index) => ({ organisation, index }))
    .sort((a, b) => (rank(a.organisation) - rank(b.organisation)) * (small ? -1 : 1) || a.index - b.index).map(item => item.organisation);
}
let ordered: { register: Register; key: string; organisations: Organisation[] } | null = null;

/** One 25-organisation page of a German slice; the caller validates the task and the position. */
export async function readHeEngMastrRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'mastr' || task.country !== 'germany' || !CLASSES.has(task.category)) fail('registry_invalid_task');
  const current = await register(options);
  const key = `${task.category}:${task.minEmployees ?? ''}:${task.maxEmployees ?? ''}`;
  if (ordered?.register !== current || ordered.key !== key) ordered = { register: current, key, organisations: slice(current.byClass.get(task.category) ?? [], task) };
  const page = ordered.organisations.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= ordered.organisations.length,
    excluded: {}, recordsRead: page.length };
}
