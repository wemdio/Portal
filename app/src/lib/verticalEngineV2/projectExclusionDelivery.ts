import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import type { AppendLeadsToClientCampaignInput } from '@/lib/clientLaunch/appendLeads';
import { getVeProjectExclusionIdentity, loadVeProjectExclusions, matchVeProjectExclusion, veProjectExclusionRow } from './projectExclusions';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { findEmailColumn } from './launchHandoff';
import { isVeTwoGisLead, isVeTwoGisRow, VE_TWO_GIS_ROW_FIELD } from './twoGisQuarantine';

/** Private reserve metadata survives operator aliases, never goes to Instantly. */
export function withVeDeliveryCompanyIdentity(
  lead: LeadCreatePayload,
  row: Record<string, unknown>,
): LeadCreatePayload & Record<string, unknown> {
  return { ...lead, _ve_company_identity: getVeProjectExclusionIdentity(veProjectExclusionRow(row, lead.email)),
    // 2ГИС: компактный признак (не карточка и не адрес); guard такие строки не выпускает.
    ...(isVeTwoGisRow(row) ? { [VE_TWO_GIS_ROW_FIELD]: true } : {}) };
}

export function veDeliveryPolicyRow(row: { email_normalized: string; lead_payload?: unknown }): Record<string, unknown> {
  const payload = row.lead_payload && typeof row.lead_payload === 'object' && !Array.isArray(row.lead_payload)
    ? row.lead_payload as Record<string, unknown> : {};
  return { ...payload, email: row.email_normalized };
}

type PolicyInventoryRow = { email_normalized: string; lead_payload?: unknown; item_id?: string; supply_batch_id?: string | null };

/** Old reserves may have renamed an INN column to a template variable. Recover
 * only identities tied to the exact saved base/email; never infer from names.
 * Cache is scoped to one read/upload invocation, not shared across requests. */
export function createVeDeliveryIdentityResolver(db: SupabaseClient, projectId: string) {
  const bases = new Map<string, Promise<Map<string, ReturnType<typeof getVeProjectExclusionIdentity>>>>();
  const readBase = (baseId: string) => {
    let pending = bases.get(baseId);
    if (!pending) {
      pending = (async () => {
        const { data, error } = await db.from('ve_bases').select('id, columns, data')
          .eq('id', baseId).eq('project_id', projectId).maybeSingle();
        if (error) throw new Error('Не удалось проверить компании в сохранённом запасе. Загрузка отложена.');
        const identities = new Map<string, ReturnType<typeof getVeProjectExclusionIdentity>>();
        const ambiguousEmails = new Set<string>();
        if (!data || !Array.isArray(data.data)) return identities;
        const rows = data.data.filter((row: unknown): row is Record<string, unknown> =>
          Boolean(row) && typeof row === 'object' && !Array.isArray(row));
        const columns = Array.isArray(data.columns) ? data.columns.filter((column: unknown): column is string => typeof column === 'string') : [];
        const emailColumn = findEmailColumn(columns, rows);
        if (!emailColumn) return identities;
        for (const row of rows) {
          const email = typeof row[emailColumn] === 'string' ? String(row[emailColumn]).trim().toLowerCase() : '';
          if (!email) continue;
          const previous = identities.get(email);
          const next = getVeProjectExclusionIdentity(row);
          if (previous && (JSON.stringify([...previous.inns].sort()) !== JSON.stringify([...next.inns].sort())
            || JSON.stringify([...previous.domains].sort()) !== JSON.stringify([...next.domains].sort()))) ambiguousEmails.add(email);
          identities.set(email, next);
        }
        // Shared addresses can belong to distinct companies. Do not attribute
        // another company's INN/site to an old lead merely by that address.
        ambiguousEmails.forEach(email => identities.delete(email));
        return identities;
      })();
      bases.set(baseId, pending);
    }
    return pending;
  };
  return async (rows: PolicyInventoryRow[]): Promise<Record<string, unknown>[]> => {
    const projected = rows.map(veDeliveryPolicyRow);
    const legacyIndexes = projected.flatMap((row, index) => row._ve_company_identity
      && typeof row._ve_company_identity === 'object' && !Array.isArray(row._ve_company_identity) ? [] : [index]);
    if (!legacyIndexes.length) return projected;
    const bindings = new Map(rows.filter(row => row.item_id).map(row => [row.email_normalized, row]));
    const missingEmails = legacyIndexes.map(index => rows[index].email_normalized).filter(email => !bindings.has(email));
    for (let offset = 0; offset < missingEmails.length; offset += 100) {
      const found = await readContactDeliveryPages<PolicyInventoryRow>('legacy delivery source', (from, to) => db
        .from('ve_contact_delivery_rows').select('email_normalized,item_id,supply_batch_id', { count: 'exact' })
        .eq('ve_project_id', projectId).in('email_normalized', missingEmails.slice(offset, offset + 100)).order('id').range(from, to));
      found.forEach(row => bindings.set(row.email_normalized, row));
    }
    const itemIds = [...new Set(legacyIndexes.map(index => bindings.get(rows[index].email_normalized))
      .filter(row => row && !row.supply_batch_id).map(row => row!.item_id).filter((id): id is string => Boolean(id)))];
    const batchIds = [...new Set(legacyIndexes.map(index => bindings.get(rows[index].email_normalized)?.supply_batch_id)
      .filter((id): id is string => Boolean(id)))];
    const itemBases = new Map<string, string>(), batchBases = new Map<string, string>();
    for (const [table, ids, target] of [
      ['ve_launch_queue_items', itemIds, itemBases], ['ve_contact_supply_batches', batchIds, batchBases],
    ] as const) {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const mapping = await readContactDeliveryPages<{ id: string; base_id: string }>('legacy delivery base', (from, to) => {
          const query = db.from(table).select('id,base_id', { count: 'exact' }).in('id', ids.slice(offset, offset + 100));
          return (table === 've_launch_queue_items' ? query.eq('project_id', projectId) : query).order('id').range(from, to);
        });
        mapping.forEach(row => target.set(row.id, row.base_id));
      }
    }
    for (const index of legacyIndexes) {
      const binding = bindings.get(rows[index].email_normalized);
      const baseId = binding?.supply_batch_id ? batchBases.get(binding.supply_batch_id) : itemBases.get(binding?.item_id ?? '');
      if (!baseId) continue;
      const identity = (await readBase(baseId)).get(rows[index].email_normalized);
      if (identity) projected[index] = { ...projected[index], _ve_company_identity: identity };
    }
    return projected;
  };
}

/** Load one compact policy per chunk; recheck it after provider rate admission.
 * Saving a policy cannot recall a request whose HTTP transport already began. */
export function createVeDeliveryExclusionGuard(
  db: SupabaseClient,
  projectId: string,
): NonNullable<AppendLeadsToClientCampaignInput['prepareProviderChunk']> {
  const resolveIdentities = createVeDeliveryIdentityResolver(db, projectId);
  return async (leads) => {
    const rules = await loadVeProjectExclusions(db, projectId);
    const policyRows = rules.inns.length + rules.domains.length > 0
      ? await resolveIdentities(leads.map(lead => ({ email_normalized: lead.email.trim().toLowerCase(), lead_payload: lead })))
      : leads as unknown as Record<string, unknown>[];
    // 2ГИС (R1): выдача закрыта — снимаем с чанка окончательно, без новых чтений.
    const inputIndexes = policyRows.flatMap((row, index) =>
      isVeTwoGisLead(leads[index]) || matchVeProjectExclusion(row, rules) ? [] : [index]);
    return {
      inputIndexes,
      leads: inputIndexes.map((index) => {
        const clean = { ...leads[index] } as LeadCreatePayload & Record<string, unknown>;
        delete clean._ve_company_identity;
        delete clean[VE_TWO_GIS_ROW_FIELD];
        return clean;
      }),
      beforeRequest: async () => {
        const current = await loadVeProjectExclusions(db, projectId);
        if (current.revision !== rules.revision) {
          throw new Error('Исключения проекта изменились. Неотправленные контакты сохранены для повторной проверки.');
        }
      },
    };
  };
}
