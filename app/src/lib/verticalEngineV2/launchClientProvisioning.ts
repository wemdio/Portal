import 'server-only';

import { checkSyntax } from '@/lib/emailValidation/shared';
import {
  listInstantlyAccounts,
  resolveInstantlyAccountId,
  type InstantlyRequestOptions,
} from '@/lib/instantly/accounts';
import { listAccounts, listCustomTagMappings, listCustomTags } from '@/lib/instantly/client';
import type { CustomTag } from '@/lib/instantly/types';
import { SCHEDULE_DEFAULTS } from '@/lib/clientLaunch/scheduleMapping';
import { TARIFF_DEFAULTS, TARIFF_LAUNCH } from '@/lib/tariffPricing';
import { normalizeLaunchMailboxIds } from './launchPortfolio';
import type { VeInstantlyTagMapping } from './launchPresets';

const ACCOUNT_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 1_000;
const TAG_PAGE_SIZE = 100;
const MAX_TAG_PAGES = 20;
const MAX_MAPPING_PAGES = 50;

export const VE_LAUNCH_CLIENT_MAX_MAILBOXES =
  TARIFF_DEFAULTS[TARIFF_LAUNCH].max_emails;

export const VE_LAUNCH_CLIENT_PRESET_DEFAULTS = {
  daily_limit: 50,
  daily_max_leads: 50,
  email_gap_minutes: 10,
  open_tracking: true,
  link_tracking: true,
  stop_on_reply: true,
  text_only: false,
  schedule_from: SCHEDULE_DEFAULTS.from,
  schedule_to: SCHEDULE_DEFAULTS.to,
  schedule_days: [...SCHEDULE_DEFAULTS.days],
  schedule_timezone: SCHEDULE_DEFAULTS.timezone,
} as const;

export interface VeLaunchClientMailboxSnapshot {
  instantlyAccountId: string;
  instantlyAccountLabel: string;
  tag: { id: string; name: string };
  mailboxIds: string[];
}

export type ResolveVeLaunchClientMailboxSnapshotResult =
  | { ok: true; snapshot: VeLaunchClientMailboxSnapshot }
  | { ok: false; status: 400 | 404 | 502; error: string; cause?: unknown };

async function listVeInstantlyPages<T>(input: {
  resource: 'custom-tags' | 'custom-tag-mappings';
  maxPages: number;
  fetchPage: (startingAfter?: string) => Promise<unknown>;
  parseItem: (item: unknown) => T;
}): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let startingAfter: string | undefined;

  for (let page = 0; page < input.maxPages; page += 1) {
    const rawResponse = await input.fetchPage(startingAfter);
    if (!rawResponse || typeof rawResponse !== 'object') {
      throw new Error(`Instantly returned an invalid ${input.resource} page`);
    }
    const response = rawResponse as {
      items?: unknown;
      next_starting_after?: unknown;
    };
    if (!Array.isArray(response.items)) {
      throw new Error(`Instantly returned an invalid ${input.resource} page`);
    }
    items.push(...response.items.map(input.parseItem));

    const nextCursor = typeof response.next_starting_after === 'string'
      ? response.next_starting_after.trim()
      : '';
    if (!nextCursor) return items;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Instantly repeated the ${input.resource} pagination cursor`);
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;

    if (page === input.maxPages - 1) {
      throw new Error(`Instantly ${input.resource} pagination exceeded the safety limit`);
    }
  }

  throw new Error(`Instantly ${input.resource} pagination ended unexpectedly`);
}

function parseVeCustomTag(item: unknown): CustomTag {
  if (!item || typeof item !== 'object') {
    throw new Error('Instantly returned a malformed custom-tag item');
  }
  const raw = item as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || typeof raw.name !== 'string') {
    // Keep malformed values out of errors because routes persist exceptions.
    throw new Error('Instantly returned a malformed custom-tag item');
  }
  return { id, name: raw.name.trim() };
}

function parseVeAccountTagMapping(item: unknown): VeInstantlyTagMapping {
  if (!item || typeof item !== 'object') {
    throw new Error('Instantly returned a malformed custom-tag mapping');
  }
  const raw = item as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const tagId = typeof raw.tag_id === 'string' ? raw.tag_id.trim() : '';
  const resourceId = typeof raw.resource_id === 'string' ? raw.resource_id.trim() : '';
  const resourceType = typeof raw.resource_type === 'string'
    ? raw.resource_type.trim()
    : '';
  if (!id || !tagId || !resourceId || !resourceType) {
    throw new Error('Instantly returned a malformed custom-tag mapping');
  }
  return {
    id,
    tag_id: tagId,
    resource_id: resourceId,
    resource_type: resourceType,
  };
}

/** VE2-local guarded tag read; shared Instantly pagination remains untouched. */
export function listVeInstantlyCustomTags(
  requestOptions: InstantlyRequestOptions,
): Promise<CustomTag[]> {
  return listVeInstantlyPages({
    resource: 'custom-tags',
    maxPages: MAX_TAG_PAGES,
    fetchPage: (startingAfter) => listCustomTags(
      {
        limit: TAG_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      requestOptions,
    ),
    parseItem: parseVeCustomTag,
  });
}

/** VE2-local guarded account-tag mapping read for display metadata only. */
export function listVeInstantlyAccountTagMappings(
  requestOptions: InstantlyRequestOptions,
): Promise<VeInstantlyTagMapping[]> {
  return listVeInstantlyPages({
    resource: 'custom-tag-mappings',
    maxPages: MAX_MAPPING_PAGES,
    fetchPage: (startingAfter) => listCustomTagMappings(
      {
        limit: TAG_PAGE_SIZE,
        resource_type: 'account',
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      requestOptions,
    ),
    parseItem: parseVeAccountTagMapping,
  });
}

/**
 * Resolves the selected custom tag against the live Instantly accounts API.
 *
 * Custom-tag mappings are useful display metadata, but they are not the launch
 * authority: the `/accounts?tag_ids=…` result is the exact mailbox snapshot
 * that will be stored in the new client's preset.
 */
export async function resolveVeLaunchClientMailboxSnapshot(input: {
  instantlyAccountId: string;
  mailboxTagId: string;
}): Promise<ResolveVeLaunchClientMailboxSnapshotResult> {
  const instantlyAccountId = resolveInstantlyAccountId(input.instantlyAccountId);
  let configuredAccounts: ReturnType<typeof listInstantlyAccounts>;
  try {
    configuredAccounts = listInstantlyAccounts();
  } catch (cause) {
    return {
      ok: false,
      status: 502,
      error: 'Не удалось загрузить настройки Instantly',
      cause,
    };
  }

  const configuredAccount = configuredAccounts.find(
    (account) => account.id === instantlyAccountId,
  );
  if (!configuredAccount) {
    return {
      ok: false,
      status: 400,
      error: 'Выбранный аккаунт Instantly не настроен',
    };
  }

  const mailboxTagId = input.mailboxTagId.trim();
  const requestOptions: InstantlyRequestOptions = {
    accountId: instantlyAccountId,
    timeoutMs: 20_000,
    retryRateLimits: false,
  };

  let tags: CustomTag[];
  try {
    tags = await listVeInstantlyCustomTags(requestOptions);
  } catch (cause) {
    return {
      ok: false,
      status: 502,
      error: 'Не удалось проверить тег почт в Instantly',
      cause,
    };
  }

  const tag = tags.find((candidate) => candidate.id === mailboxTagId);
  if (!tag) {
    return {
      ok: false,
      status: 404,
      error: 'Тег почт не найден в выбранном аккаунте Instantly',
    };
  }

  const rawMailboxIds: string[] = [];
  const uniqueMailboxIds = new Set<string>();
  const seenCursors = new Set<string>();
  let startingAfter: string | undefined;

  try {
    for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
      const response = await listAccounts(
        {
          limit: ACCOUNT_PAGE_SIZE,
          tag_ids: mailboxTagId,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        requestOptions,
      );

      if (!Array.isArray(response?.items)) {
        throw new Error('Instantly returned an invalid accounts page');
      }

      for (const account of response.items) {
        const email = typeof account?.email === 'string'
          ? account.email.trim().toLocaleLowerCase('en-US')
          : '';
        if (!checkSyntax(email).valid) {
          // Do not include the mailbox value in the error: this error can be
          // persisted by the application logger.
          throw new Error('Instantly returned an account without a valid email');
        }
        rawMailboxIds.push(email);
        uniqueMailboxIds.add(email);
        if (uniqueMailboxIds.size > VE_LAUNCH_CLIENT_MAX_MAILBOXES) {
          return {
            ok: false,
            status: 400,
            error:
              `Стандартный лимит для нового клиента — `
              + `${VE_LAUNCH_CLIENT_MAX_MAILBOXES} почт; в выбранном теге больше`,
          };
        }
      }

      const nextCursor = typeof response.next_starting_after === 'string'
        ? response.next_starting_after.trim()
        : '';
      if (!nextCursor) {
        startingAfter = undefined;
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error('Instantly repeated the accounts pagination cursor');
      }
      seenCursors.add(nextCursor);
      startingAfter = nextCursor;

      if (page === MAX_ACCOUNT_PAGES - 1) {
        throw new Error('Instantly accounts pagination exceeded the safety limit');
      }
    }
  } catch (cause) {
    return {
      ok: false,
      status: 502,
      error: 'Не удалось получить почты выбранного тега из Instantly',
      cause,
    };
  }

  const mailboxIds = normalizeLaunchMailboxIds(rawMailboxIds);
  if (mailboxIds.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'В выбранном теге Instantly нет почт',
    };
  }
  return {
    ok: true,
    snapshot: {
      instantlyAccountId,
      instantlyAccountLabel: configuredAccount.label,
      tag: {
        id: tag.id,
        name: tag.name.trim() || tag.id,
      },
      mailboxIds,
    },
  };
}
