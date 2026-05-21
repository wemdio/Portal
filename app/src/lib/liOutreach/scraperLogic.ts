import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { UnipileClient, extractPublicIdentifier, extractActivityUrn } from './unipileClient';
import {
  applyCooldownToAccount,
  detectAccountCooldownError,
  isAccountInCooldown,
} from './accountCooldown';
import type { LiSettings } from './types';

/**
 * LinkedIn scraper — search by URL and post reactions.
 * Port of Python linkedin-ai-responder/app/services/scraper_logic.py → TypeScript.
 */

const DELAY_BETWEEN_PAGES_MS = 3000;

type ScraperAccountRow = {
  id: string;
  unipile_account_id: string;
  cooldown_until: string | null;
  cooldown_reason: 'invitation_limit' | 'already_invited' | 'account_restricted' | null;
};

/**
 * If the account is currently in cooldown, fail the task with a clear message
 * and return true (so the caller can short-circuit). The whole point: don't
 * waste any LinkedIn API quota on a parked account.
 */
async function bailIfAccountInCooldown(
  db: NonNullable<typeof supabaseAdmin>,
  taskId: string,
  account: ScraperAccountRow,
): Promise<boolean> {
  if (!isAccountInCooldown(account)) return false;
  const until = new Date(account.cooldown_until!).toLocaleString('ru-RU');
  await db
    .from('li_tasks')
    .update({
      status: 'failed',
      error_message: `Аккаунт в отлёжке до ${until} (причина: ${account.cooldown_reason ?? 'unknown'})`,
      completed_at: new Date().toISOString(),
    })
    .eq('id', taskId);
  return true;
}

/**
 * Best-effort cooldown bookkeeping when the scraper hits a Unipile error that
 * matches a LinkedIn-side limit signal. Mirrors what the campaign runner does
 * on the invite path so a single account is parked for *all* call sites.
 */
async function maybeParkAccountFromError(
  db: NonNullable<typeof supabaseAdmin>,
  accountDbId: string,
  err: unknown,
): Promise<void> {
  const cooldown = detectAccountCooldownError(err);
  if (!cooldown) return;
  const { error: cdErr } = await applyCooldownToAccount(db, accountDbId, cooldown.kind);
  if (cdErr) {
    // The DB write is best-effort, but a silent failure here means we'll keep
    // poking LinkedIn after they told us to stop — visible in worker logs so
    // ops can see it.
    console.warn(
      `[li-outreach][scraper] applyCooldownToAccount failed for account ${accountDbId} (${cooldown.kind}): ${cdErr}`,
    );
  }
}

function parseHeadline(headline: string | null): { position: string; company: string } {
  if (!headline) return { position: '', company: '' };
  // "Title at Company", "Title @ Company", "Title в Company"
  const separators = [' at ', ' @ ', ' в ', ' в компании ', ' | '];
  for (const sep of separators) {
    const idx = headline.indexOf(sep);
    if (idx > 0) {
      return { position: headline.slice(0, idx).trim(), company: headline.slice(idx + sep.length).trim() };
    }
  }
  return { position: headline.trim(), company: '' };
}

// ---- Search scraper -----------------------------------------------------

export async function scrapeLinkedInSearch(
  taskId: string,
  userId: string,
  searchUrl: string,
  accountId: string,
  leadListId: string | null,
  maxResults: number,
): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  // Load settings
  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<LiSettings>();
  if (!settings?.unipile_dsn || !settings?.unipile_api_key) {
    await db.from('li_tasks').update({ status: 'failed', error_message: 'Нет настроек Unipile' }).eq('id', taskId);
    return;
  }

  // Get Unipile account ID + cooldown so we can bail out early.
  const { data: account } = await db
    .from('li_accounts')
    .select('id, unipile_account_id, cooldown_until, cooldown_reason')
    .eq('id', accountId)
    .maybeSingle<ScraperAccountRow>();
  if (!account) {
    await db.from('li_tasks').update({ status: 'failed', error_message: 'Аккаунт не найден' }).eq('id', taskId);
    return;
  }
  if (await bailIfAccountInCooldown(db, taskId, account)) return;

  const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key, account.unipile_account_id);

  await db.from('li_tasks').update({ status: 'running', started_at: new Date().toISOString(), total: maxResults }).eq('id', taskId);

  let cursor: string | undefined;
  let collected = 0;
  let page = 0;

  try {
    while (collected < maxResults) {
      // Check cancellation
      const { data: task } = await db.from('li_tasks').select('status').eq('id', taskId).maybeSingle<{ status: string }>();
      if (task?.status === 'cancelled') break;

      page++;
      const result = await client.searchByUrl(searchUrl, { limit: 25, cursor });
      const items = (result.items ?? []) as Array<Record<string, unknown>>;
      if (items.length === 0) break;

      for (const item of items) {
        if (collected >= maxResults) break;

        const name = String(item.name ?? item.full_name ?? '').trim();
        if (!name) continue;

        const profileUrl = String(item.profile_url ?? item.url ?? '').trim() || null;
        const linkedinId = String(item.provider_id ?? '').trim() || null;
        const publicId = extractPublicIdentifier(profileUrl ?? '') ?? (String(item.public_identifier ?? '').trim() || null);
        const headline = String(item.headline ?? '').trim() || null;
        const { position, company } = parseHeadline(headline);
        const firstName = String(item.first_name ?? '').trim() || null;
        const lastName = String(item.last_name ?? '').trim() || null;

        // Upsert lead (deduplicate by linkedin_id or profile_url)
        await db.from('li_leads').upsert(
          {
            user_id: userId,
            lead_list_id: leadListId,
            linkedin_id: linkedinId,
            public_identifier: publicId,
            profile_url: profileUrl,
            name,
            first_name: firstName,
            last_name: lastName,
            position: position || null,
            company: company || null,
            status: 'new',
            account_id: accountId,
          },
          { onConflict: 'user_id,lead_list_id,linkedin_id', ignoreDuplicates: true },
        );

        collected++;
      }

      // Update progress
      await db.from('li_tasks').update({ progress: collected }).eq('id', taskId);

      cursor = result.cursor as string | undefined;
      if (!cursor) break;

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PAGES_MS));
    }

    await db.from('li_tasks').update({
      status: 'completed',
      progress: collected,
      result: { collected, pages: page },
      completed_at: new Date().toISOString(),
    }).eq('id', taskId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[li-outreach] scraper search failed:`, msg);
    await maybeParkAccountFromError(db, account.id, e);
    await db.from('li_tasks').update({
      status: 'failed',
      error_message: msg,
      progress: collected,
      completed_at: new Date().toISOString(),
    }).eq('id', taskId);
  }
}

// ---- Post reactions scraper ---------------------------------------------

export async function scrapePostReactions(
  taskId: string,
  userId: string,
  postUrl: string,
  accountId: string,
  leadListId: string | null,
  maxResults: number,
): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const { data: settings } = await db
    .from('li_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<LiSettings>();
  if (!settings?.unipile_dsn || !settings?.unipile_api_key) {
    await db.from('li_tasks').update({ status: 'failed', error_message: 'Нет настроек Unipile' }).eq('id', taskId);
    return;
  }

  const { data: account } = await db
    .from('li_accounts')
    .select('id, unipile_account_id, cooldown_until, cooldown_reason')
    .eq('id', accountId)
    .maybeSingle<ScraperAccountRow>();
  if (!account) {
    await db.from('li_tasks').update({ status: 'failed', error_message: 'Аккаунт не найден' }).eq('id', taskId);
    return;
  }
  if (await bailIfAccountInCooldown(db, taskId, account)) return;

  const activityUrn = extractActivityUrn(postUrl);
  if (!activityUrn) {
    await db.from('li_tasks').update({ status: 'failed', error_message: 'Не удалось извлечь activity URN из URL' }).eq('id', taskId);
    return;
  }

  const client = new UnipileClient(settings.unipile_dsn, settings.unipile_api_key, account.unipile_account_id);

  await db.from('li_tasks').update({ status: 'running', started_at: new Date().toISOString(), total: maxResults }).eq('id', taskId);

  let cursor: string | undefined;
  let collected = 0;

  try {
    while (collected < maxResults) {
      const { data: task } = await db.from('li_tasks').select('status').eq('id', taskId).maybeSingle<{ status: string }>();
      if (task?.status === 'cancelled') break;

      const result = await client.getPostReactions(activityUrn, { limit: 100, cursor });
      const items = (result.items ?? []) as Array<Record<string, unknown>>;
      if (items.length === 0) break;

      for (const item of items) {
        if (collected >= maxResults) break;

        const name = String(item.name ?? item.full_name ?? '').trim();
        if (!name) continue;

        const profileUrl = String(item.profile_url ?? item.url ?? '').trim() || null;
        const linkedinId = String(item.provider_id ?? '').trim() || null;
        const publicId = extractPublicIdentifier(profileUrl ?? '') ?? null;
        const headline = String(item.headline ?? '').trim() || null;
        const { position, company } = parseHeadline(headline);

        await db.from('li_leads').upsert(
          {
            user_id: userId,
            lead_list_id: leadListId,
            linkedin_id: linkedinId,
            public_identifier: publicId,
            profile_url: profileUrl,
            name,
            first_name: String(item.first_name ?? '').trim() || null,
            last_name: String(item.last_name ?? '').trim() || null,
            position: position || null,
            company: company || null,
            status: 'new',
            account_id: accountId,
          },
          { onConflict: 'user_id,lead_list_id,linkedin_id', ignoreDuplicates: true },
        );

        collected++;
      }

      await db.from('li_tasks').update({ progress: collected }).eq('id', taskId);

      cursor = result.cursor;
      if (!cursor) break;

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PAGES_MS));
    }

    await db.from('li_tasks').update({
      status: 'completed',
      progress: collected,
      result: { collected },
      completed_at: new Date().toISOString(),
    }).eq('id', taskId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[li-outreach] scraper reactions failed:`, msg);
    await maybeParkAccountFromError(db, account.id, e);
    await db.from('li_tasks').update({
      status: 'failed',
      error_message: msg,
      progress: collected,
      completed_at: new Date().toISOString(),
    }).eq('id', taskId);
  }
}
