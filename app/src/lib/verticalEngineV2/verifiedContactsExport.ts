import type { SupabaseClient } from '@supabase/supabase-js';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { findEmailColumn, mapBaseRowsToLeads } from './launchHandoff';
import { prepareSegmentationAudience } from './segmentationAudit';
import { projectCompanyNames } from './companyNames';
import { getVeProjectExclusionIdentity, loadVeProjectExclusions, matchVeProjectExclusion } from './projectExclusions';

type Row = Record<string, unknown>;
type Identity = ReturnType<typeof getVeProjectExclusionIdentity>;
type BaseReference = { id: string; project_id: string; hypothesis_id: string; source: string; created_at: string };
type ItemReference = { id: string; project_id: string; hypothesis_id: string; base_id: string };
type DeliveryRow = { id: string; ve_project_id: string; item_id: string; supply_batch_id: string | null;
  email_normalized: string; lead_payload: unknown; status: string };
type BaseFacts = { observed: Set<string>; ready: Set<string>; blocked: Set<string>; identities: Map<string, Identity> };
type ExportContact = { row: Row; identity: Identity };

const ID_BATCH = 100;
const DELIVERY_STATES = new Set(['ready', 'reserved', 'attempting', 'accepted', 'skipped', 'uncertain']);
const PRIVATE_COLUMNS = new Set(['__proto__', 'constructor', 'prototype', 'custom_variables']);

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicColumn(column: string): boolean {
  return Boolean(column.trim()) && !column.trim().startsWith('_') && !PRIVATE_COLUMNS.has(column);
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function publicCells(row: Row, columns: string[]): Row {
  return Object.fromEntries(columns.filter(publicColumn).flatMap(column =>
    scalar(row[column]) ? [[column, row[column]]] : []));
}

function emailCell(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return JSON.stringify([...left.inns].sort()) === JSON.stringify([...right.inns].sort())
    && JSON.stringify([...left.domains].sort()) === JSON.stringify([...right.domains].sort());
}

function combinedIdentity(left: Identity, right?: Identity): Identity {
  return { inns: [...new Set([...left.inns, ...(right?.inns ?? [])])],
    domains: [...new Set([...left.domains, ...(right?.domains ?? [])])] };
}

/** The delivery ledger contains the immutable, previously audited recipient
 * payload, not source candidates. Do not export its provider/account metadata. */
function deliveryCells(payload: Row, email: string): Row {
  const variables = isRecord(payload.custom_variables) ? payload.custom_variables : {};
  const result = publicCells(variables, Object.keys(variables));
  for (const field of ['first_name', 'last_name', 'company_name', 'website', 'phone']) {
    if (scalar(payload[field])) result[field] = payload[field];
  }
  if (!result.company && typeof payload.company_name === 'string') result.company = payload.company_name;
  return { ...result, email };
}

async function* deliveryPages(db: SupabaseClient, projectId: string, itemIds: string[], capturedAt: string) {
  let offset = 0, total: number | null = null;
  while (total === null || offset < total) {
    const page = await db.from('ve_contact_delivery_rows')
      .select('id,ve_project_id,item_id,supply_batch_id,email_normalized,lead_payload,status', { count: 'exact' })
      .eq('ve_project_id', projectId).in('item_id', itemIds).lte('created_at', capturedAt)
      .order('id').range(offset, offset + 499);
    if (page.error || !Number.isSafeInteger(page.count) || (page.count ?? -1) < 0
      || (total !== null && page.count !== total) || !Array.isArray(page.data)
      || (!page.data.length && offset < (page.count ?? 0)) || offset + page.data.length > (page.count ?? 0)) {
      throw new Error('Не удалось полностью прочитать историю контактов. Повторите скачивание.');
    }
    total = page.count as number;
    offset += page.data.length;
    yield page.data as DeliveryRow[];
  }
}

/** Read-only cumulative export of saved verified contacts for one hypothesis.
 * No launch, collection, reconciliation, provider call or quality re-check is
 * performed. The ready parts of active/failed bases remain downloadable.
 */
export async function loadVeVerifiedContactsExport(
  db: SupabaseClient,
  projectId: string,
  hypothesisId: string,
  capturedAt = new Date().toISOString(),
): Promise<{ columns: string[]; rows: Row[]; excludedCount: number; unidentifiedCount: number }> {
  if (!projectId || !hypothesisId || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error('Не удалось определить состав выгрузки. Обновите страницу.');
  }
  const policy = await loadVeProjectExclusions(db, projectId);
  const references = await readContactDeliveryPages<BaseReference>('verified export bases', (from, to) => db
    .from('ve_bases').select('id,project_id,hypothesis_id,source,created_at', { count: 'exact' })
    .eq('project_id', projectId).eq('hypothesis_id', hypothesisId).eq('source', 'auto')
    .lte('created_at', capturedAt).order('created_at', { ascending: false }).order('id').range(from, to));
  const baseFacts = new Map<string, BaseFacts>();
  const contacts = new Map<string, ExportContact>();
  const eligibleEmails = new Set<string>();
  const blockedEmails = new Set<string>();
  const ignoredBases = new Set<string>();
  async function readBaseFacts(baseId: string, includeContacts: boolean): Promise<BaseFacts | null> {
    // Only one base payload at a time, never collect_info/harvest/reserve.
    const { data, error } = await db.from('ve_bases')
      .select('id,project_id,hypothesis_id,source,columns,data')
      .eq('id', baseId).eq('project_id', projectId).maybeSingle();
    if (error || !data || data.id !== baseId || data.project_id !== projectId
      || (data.hypothesis_id !== hypothesisId && (includeContacts || data.hypothesis_id !== null))) {
      throw new Error('Не удалось проверить исходную базу запуска. Повторите скачивание.');
    }
    // A legacy shared vertical base is owned here only through its exact launch
    // item. Read its facts for that item's delivery snapshots, never export all
    // rows of the shared base or treat uploaded source rows as verified.
    if (!includeContacts && data.source !== 'auto') {
      ignoredBases.add(baseId);
      return null;
    }
    if (data.source !== 'auto' || !Array.isArray(data.data) || !data.data.every(isRecord)
      || !Array.isArray(data.columns) || !data.columns.every((column: unknown) => typeof column === 'string')) {
      throw new Error('Не удалось полностью прочитать проверенные контакты. Повторите скачивание.');
    }
    const rows = data.data as Row[], columns = data.columns as string[];
    const facts: BaseFacts = { observed: new Set(), ready: new Set(), blocked: new Set(), identities: new Map() };
    const ambiguousEmails = new Set<string>();
    const emailColumn = findEmailColumn(columns, rows);
    for (const row of rows) {
      const email = emailColumn ? emailCell(row[emailColumn]) : '';
      if (!email) continue;
      facts.observed.add(email);
      const identity = getVeProjectExclusionIdentity({ ...row, email });
      const previous = facts.identities.get(email);
      if (previous && !sameIdentity(previous, identity)) ambiguousEmails.add(email);
      facts.identities.set(email, identity);
      // Remember this even if quality now rejects the source: an old aliased
      // delivery payload must not resurrect its known excluded company.
      if (matchVeProjectExclusion({ ...row, email }, policy)) {
        facts.blocked.add(email);
        if (includeContacts) blockedEmails.add(email);
      }
    }
    ambiguousEmails.forEach(email => facts.identities.delete(email));
    const audience = prepareSegmentationAudience({ rows, columns, source: 'auto' });
    const visible = projectCompanyNames(audience.rows);
    audience.rows.forEach((row, index) => {
      const email = audience.leads[index].email.trim().toLowerCase();
      facts.ready.add(email);
      if (matchVeProjectExclusion({ ...row, email }, policy)) {
        facts.blocked.add(email);
        if (includeContacts) blockedEmails.add(email);
      }
      if (!includeContacts) return;
      eligibleEmails.add(email);
      // Newer source bases win duplicate email presentation; never merge
      // arbitrary fields from different companies sharing a mailbox.
      if (!contacts.has(email)) contacts.set(email, { row: { ...publicCells(visible[index], columns), email },
        identity: getVeProjectExclusionIdentity({ ...row, email }) });
    });
    baseFacts.set(baseId, facts);
    return facts;
  }
  for (const reference of references) {
    if (!reference.id || baseFacts.has(reference.id) || reference.project_id !== projectId
      || reference.hypothesis_id !== hypothesisId || reference.source !== 'auto') {
      throw new Error('Состав баз изменился во время выгрузки. Повторите скачивание.');
    }
    await readBaseFacts(reference.id, true);
  }

  const items = await readContactDeliveryPages<ItemReference>('verified export launches', (from, to) => db
    .from('ve_launch_queue_items').select('id,project_id,hypothesis_id,base_id', { count: 'exact' })
    .eq('project_id', projectId).eq('hypothesis_id', hypothesisId).lte('created_at', capturedAt)
    .order('id').range(from, to));
  const itemBases = new Map<string, string>();
  for (const item of items) {
    if (!item.id || !item.base_id || itemBases.has(item.id) || item.project_id !== projectId || item.hypothesis_id !== hypothesisId) {
      throw new Error('Не удалось проверить принадлежность сохранённых запусков. Повторите скачивание.');
    }
    itemBases.set(item.id, item.base_id);
  }
  const itemIds = [...itemBases.keys()];
  const seenDeliveryRows = new Set<string>();
  for (let offset = 0; offset < itemIds.length; offset += ID_BATCH) {
    const ids = itemIds.slice(offset, offset + ID_BATCH);
    for await (const delivery of deliveryPages(db, projectId, ids, capturedAt)) {
      const batchIds = [...new Set(delivery.map(row => row.supply_batch_id).filter((id): id is string => Boolean(id)))];
      const batchBases = new Map<string, string>();
      for (let batchOffset = 0; batchOffset < batchIds.length; batchOffset += ID_BATCH) {
        const requested = batchIds.slice(batchOffset, batchOffset + ID_BATCH);
        const batches = await readContactDeliveryPages<{ id: string; base_id: string }>('verified export supply binding', (from, to) => db
          .from('ve_contact_supply_batches').select('id,base_id', { count: 'exact' })
          .in('id', requested).order('id').range(from, to));
        if (batches.length !== requested.length || batches.some(batch => !requested.includes(batch.id) || !baseFacts.has(batch.base_id))) {
          throw new Error('Не удалось полностью связать ежедневные доборы с гипотезой. Повторите скачивание.');
        }
        for (const batch of batches) {
          if (batchBases.has(batch.id)) throw new Error('Состав ежедневных доборов изменился. Повторите скачивание.');
          batchBases.set(batch.id, batch.base_id);
        }
      }
      for (const entry of delivery) {
        const email = emailCell(entry.email_normalized);
        if (!entry.id || seenDeliveryRows.has(entry.id) || entry.ve_project_id !== projectId || !ids.includes(entry.item_id)
          || !DELIVERY_STATES.has(entry.status) || !email || email !== entry.email_normalized || !isRecord(entry.lead_payload)
          || emailCell(entry.lead_payload.email) !== email
          || mapBaseRowsToLeads({ rows: [{ email }], columns: ['email'] }).leads.length !== 1) {
          throw new Error('Не удалось проверить сохранённые контакты запуска. Повторите скачивание.');
        }
        seenDeliveryRows.add(entry.id);
        const sourceBaseId = entry.supply_batch_id ? batchBases.get(entry.supply_batch_id) : itemBases.get(entry.item_id);
        if (!sourceBaseId) throw new Error('Не удалось проверить исходную базу запуска. Повторите скачивание.');
        if (ignoredBases.has(sourceBaseId)) continue;
        const facts = baseFacts.get(sourceBaseId) ?? await readBaseFacts(sourceBaseId, false);
        if (!facts) continue;
        const identity = combinedIdentity(getVeProjectExclusionIdentity(entry.lead_payload), facts.identities.get(email));
        if (facts.blocked.has(email)
          || matchVeProjectExclusion({ ...entry.lead_payload, email, _ve_company_identity: identity }, policy)) blockedEmails.add(email);
        // A current explicit rejection wins over its old launch snapshot. A lone
        // skipped snapshot can also be a permanent provider/invalid-email refusal.
        if (entry.status === 'skipped' || (facts.observed.has(email) && !facts.ready.has(email))) continue;
        eligibleEmails.add(email);
        if (!contacts.has(email)) contacts.set(email, { row: deliveryCells(entry.lead_payload, email), identity });
      }
    }
  }
  const currentPolicy = await loadVeProjectExclusions(db, projectId);
  if (currentPolicy.revision !== policy.revision) {
    throw new Error('Исключения проекта изменились во время выгрузки. Повторите скачивание.');
  }
  const columns = new Set<string>(['email']);
  const rows: Row[] = [];
  let unidentifiedCount = 0;
  for (const [email, contact] of contacts) {
    if (blockedEmails.has(email)) continue;
    if ((policy.inns.length && !contact.identity.inns.length) || (policy.domains.length && !contact.identity.domains.length)) unidentifiedCount++;
    Object.keys(contact.row).forEach(column => columns.add(column));
    rows.push(contact.row);
  }
  return { columns: [...columns], rows,
    excludedCount: [...blockedEmails].filter(email => eligibleEmails.has(email)).length, unidentifiedCount };
}
