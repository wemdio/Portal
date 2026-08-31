import type { CustomTag } from '@/lib/instantly/types';
import type { VeLaunchPresetOption } from './launchHandoff';

export interface VeInstantlyTagMapping {
  id: string;
  tag_id: string;
  resource_id: string;
  resource_type: string;
}

export type VeLaunchPresetMailboxTagSummary = Pick<
  VeLaunchPresetOption,
  'mailbox_count' | 'mailbox_tags' | 'mailbox_tag_resolution'
>;

function normalizeMailboxId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function displayTag(tag: CustomTag): { id: string; name: string } {
  const name = tag.name?.trim() || tag.label?.trim() || tag.id;
  return { id: tag.id, name };
}

function sortTags(
  values: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  return values.sort(
    (left, right) => left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id),
  );
}

/**
 * Resolves a display-safe identity for a preset's exact sender pool.
 *
 * The exact mailbox addresses remain the launch authority and never leave the
 * server through this summary. A tag is shown only when it covers every
 * mailbox in the preset. Exact matches win over broader workspace tags; when
 * only partial tags exist we report `mixed` instead of inventing a primary tag.
 */
export function resolveVeLaunchPresetMailboxTags(input: {
  emailAccountIds: unknown;
  tags: CustomTag[];
  mappings: VeInstantlyTagMapping[];
  available?: boolean;
}): VeLaunchPresetMailboxTagSummary {
  const mailboxIds = new Set(
    (Array.isArray(input.emailAccountIds) ? input.emailAccountIds : [])
      .map(normalizeMailboxId)
      .filter(Boolean),
  );
  const mailboxCount = mailboxIds.size;
  const normalizedMailboxIds = Array.from(mailboxIds);
  const empty = {
    mailbox_count: mailboxCount,
    mailbox_tags: [],
  } satisfies Pick<VeLaunchPresetMailboxTagSummary, 'mailbox_count' | 'mailbox_tags'>;

  if (mailboxCount === 0) {
    return { ...empty, mailbox_tag_resolution: 'none' };
  }
  if (input.available === false) {
    return { ...empty, mailbox_tag_resolution: 'unavailable' };
  }

  const tagById = new Map(
    input.tags
      .filter((tag) => typeof tag?.id === 'string' && tag.id.trim())
      .map((tag) => [tag.id, tag] as const),
  );
  const accountsByTag = new Map<string, Set<string>>();
  for (const mapping of input.mappings) {
    if (mapping.resource_type !== 'account' || !tagById.has(mapping.tag_id)) continue;
    const mailboxId = normalizeMailboxId(mapping.resource_id);
    if (!mailboxId) continue;
    const accounts = accountsByTag.get(mapping.tag_id) ?? new Set<string>();
    accounts.add(mailboxId);
    accountsByTag.set(mapping.tag_id, accounts);
  }

  const exact: Array<{ id: string; name: string }> = [];
  const shared: Array<{ id: string; name: string }> = [];
  let hasPartialTag = false;
  for (const [tagId, accounts] of accountsByTag) {
    const coversWholePreset = normalizedMailboxIds.every((mailboxId) => accounts.has(mailboxId));
    if (coversWholePreset) {
      const tag = tagById.get(tagId) as CustomTag;
      if (accounts.size === mailboxCount) exact.push(displayTag(tag));
      else shared.push(displayTag(tag));
      continue;
    }
    if (normalizedMailboxIds.some((mailboxId) => accounts.has(mailboxId))) {
      hasPartialTag = true;
    }
  }

  if (exact.length > 0) {
    return {
      mailbox_count: mailboxCount,
      mailbox_tags: sortTags(exact),
      mailbox_tag_resolution: 'exact',
    };
  }
  if (shared.length > 0) {
    return {
      mailbox_count: mailboxCount,
      mailbox_tags: sortTags(shared),
      mailbox_tag_resolution: 'shared',
    };
  }
  return {
    ...empty,
    mailbox_tag_resolution: hasPartialTag ? 'mixed' : 'none',
  };
}
