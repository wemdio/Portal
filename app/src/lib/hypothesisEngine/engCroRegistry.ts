import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { heEngNaceRev11Classes, heEngNaceRev2Classes } from './engNaceRegistryCatalog';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { readHeEngRegistryText } from './engRegistryHttp';

/**
 * The Irish Companies Registration Office's open company records (CRO open
 * data portal, keyless, CC BY 4.0): every company with its status, type,
 * registered office and NACE Rev. 2 code; companies registered before Rev. 2
 * carry only a Rev. 1.1 «principal object» code, read as a fallback. No
 * website and no headcount.
 *
 * The portal's datastore answers SQL, so a slice asks for exactly its live
 * companies, oldest registration first, 25 a page.
 */
const PORTAL = 'https://opendata.cro.ie/api/3/action';
const PAGE_SIZE = 25;
const MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RESOURCE_CACHE_MS = 24 * 60 * 60_000;
// Company types that trade: private and designated-activity companies limited
// by shares, unlimited and public companies, external (foreign) companies.
// Guarantee companies (clubs, charities, management companies) and investment
// funds are left out.
const TYPES = [1153, 1150, 1151, 1157, 1154, 1155, 1128, 1119, 1126, 1145];

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
type Row = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' || typeof raw === 'number'
    ? sliceWholeChars(stripUnstorableJsonChars(String(raw)).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
async function json(url: string, options: Options): Promise<Row> {
  let body: Row;
  try { body = JSON.parse(await readHeEngRegistryText(url, { ...options, accept: 'application/json', maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS })) as Row; }
  catch (error) { if (error instanceof SyntaxError) fail('registry_invalid_response'); throw error; }
  if (body?.success !== true || !body.result || typeof body.result !== 'object') fail('registry_invalid_response');
  return body.result as Row;
}

// The datastore table of the «companies» dataset; found by the dataset, not pinned, in case CRO replaces the file.
let resource: { at: number; id: string } | null = null;
async function companiesResource(options: Options): Promise<string> {
  const now = (options.now ?? Date.now)();
  if (resource && now - resource.at < RESOURCE_CACHE_MS) return resource.id;
  const result = await json(`${PORTAL}/package_show?id=companies`, options);
  const table = (Array.isArray(result.resources) ? result.resources as Row[] : [])
    .find(item => item?.datastore_active === true && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(str(item.id, 40)));
  if (!table) fail('registry_invalid_response');
  resource = { at: now, id: str(table!.id, 40) };
  return resource.id;
}

/** One 25-company page of an Irish slice; the caller validates the task and the position. */
export async function readHeEngCroRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'cro' || task.country !== 'ireland' || !/^\d{2}\.\d{2}$/.test(task.category)) fail('registry_invalid_task');
  const rev2 = heEngNaceRev2Classes(task.category).map(code => Number(code.replace('.', '')));
  const rev11 = heEngNaceRev11Classes(task.category);
  if (rev2.some(code => !Number.isSafeInteger(code)) || rev11.some(code => !/^\d{2}\.\d{2}$/.test(code))) fail('registry_invalid_task');
  const id = await companiesResource(options);
  // Values come from the closed class table above, never from a company or a plan.
  const sql = `SELECT company_num, company_name, company_type, company_reg_date, company_address_1, company_address_2, company_address_3, company_address_4, eircode, nace_v2_code, princ_object_code FROM "${id}" ` +
    `WHERE company_status IN ('Normal ', 'Normal') AND company_type_code IN (${TYPES.join(', ')}) AND (nace_v2_code IN (${rev2.join(', ')})` +
    `${rev11.length ? ` OR (nace_v2_code IS NULL AND princ_object_code IN (${rev11.map(code => `'${code}'`).join(', ')}))` : ''}) ` +
    `ORDER BY company_reg_date, company_num LIMIT ${PAGE_SIZE} OFFSET ${position}`;
  const url = new URL(`${PORTAL}/datastore_search_sql`);
  url.searchParams.set('sql', sql);
  const result = await json(url.href, options);
  if (!Array.isArray(result.records) || result.records.length > PAGE_SIZE) fail('registry_invalid_response');
  const excluded: Record<string, number> = {};
  const candidates: HeEngRegistryCandidate[] = [];
  for (const raw of result.records as Row[]) {
    const number = str(raw?.company_num, 10).replace(/\.0+$/, '');
    const name = str(raw?.company_name);
    const lines = [raw?.company_address_1, raw?.company_address_2, raw?.company_address_3, raw?.company_address_4]
      .map(line => str(line, 200).replace(/^[\s,]+|[\s,]+$/g, '')).filter(Boolean);
    // Without the Eircode: a company's own pages rarely print it, and every address word must appear there.
    const address = [...lines, 'Ireland'].join(', ');
    if (!/^\d{1,7}$/.test(number) || !name) { excluded.missing_identity = (excluded.missing_identity ?? 0) + 1; continue; }
    if (!lines.length) { excluded.country_unconfirmed = (excluded.country_unconfirmed ?? 0) + 1; continue; }
    const nace = str(raw?.nace_v2_code, 10).replace(/\.0+$/, '');
    const activity = nace ? `NACE ${nace.slice(0, 2)}.${nace.slice(2)}` : `NACE Rev. 1.1 ${str(raw?.princ_object_code, 10)}`;
    const registered = str(raw?.company_reg_date, 10).slice(0, 4);
    candidates.push({ provider: 'cro', recordId: number, company: name, country: 'ireland', address, addressKind: 'registered',
      category: activity, website: '', emails: [],
      description: str(`An Irish ${str(raw?.company_type, 120).replace(/^[A-Z]+\s*-\s*/, '') || 'company'} (${activity})${/^\d{4}$/.test(registered) ? `, registered ${registered}` : ''}. From the Companies Registration Office open data; registered office address. Website and employee count require verification.`, 1500),
      sourceUrl: `${PORTAL}/datastore_search?resource_id=${id}&filters=%7B%22company_num%22%3A${number}%7D` });
  }
  return { candidates, nextPosition: position + PAGE_SIZE, exhausted: result.records.length < PAGE_SIZE, excluded, recordsRead: result.records.length };
}
