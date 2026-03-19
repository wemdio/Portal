import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { guessRoleFromTitle, isLikelyLpr } from '@/lib/cisLeads/lprRole';
import { sanitizeContactEmail } from '@/lib/cisLeads/contactEmailPolicy';

function normalizePhone(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const onlyDigits = s.replace(/\D/g, '');
  if (onlyDigits.length === 10) return `+7${onlyDigits}`;
  if (onlyDigits.length === 11 && onlyDigits.startsWith('8')) return `+7${onlyDigits.slice(1)}`;
  if (onlyDigits.length === 11 && onlyDigits.startsWith('7')) return `+${onlyDigits}`;
  if (s.startsWith('+') && onlyDigits.length >= 11 && onlyDigits.length <= 15) return `+${onlyDigits}`;
  return null;
}


export async function runContactAggregationBatch(): Promise<{ processed: number }> {
  if (!supabaseAdmin) return { processed: 0 };

  // Pull a bounded slice of leads that already have a company_id and contain contact clues.
  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('id,user_id,company_id,raw_phone,raw_email,raw_contact_name,raw_position')
    .not('company_id', 'is', null)
    .limit(400);

  const rows = (leads ?? []) as Array<{
    id: string;
    user_id: string;
    company_id: string;
    raw_phone: string | null;
    raw_email: string | null;
    raw_contact_name: string | null;
    raw_position: string | null;
  }>;

  if (rows.length === 0) return { processed: 0 };

  const phones = Array.from(
    new Set(
      rows
        .map((r) => normalizePhone(r.raw_phone))
        .filter((p): p is string => Boolean(p)),
    ),
  );

  const identityByPhone = new Map<
    string,
    { tg_user_id: number | null; tg_username: string | null; first_name: string | null; last_name: string | null }
  >();
  if (phones.length > 0) {
    const { data: identities } = await supabaseAdmin
      .from('phone_identities')
      .select('phone_normalized,tg_user_id,tg_username,first_name,last_name,check_status')
      .in('phone_normalized', phones)
      .eq('check_status', 'found');
    for (const row of identities ?? []) {
      identityByPhone.set(String((row as { phone_normalized: string }).phone_normalized), {
        tg_user_id: Number((row as { tg_user_id?: unknown }).tg_user_id ?? 0) || null,
        tg_username: (row as { tg_username?: string | null }).tg_username ?? null,
        first_name: (row as { first_name?: string | null }).first_name ?? null,
        last_name: (row as { last_name?: string | null }).last_name ?? null,
      });
    }
  }

  let inserted = 0;
  const batch: Array<Record<string, unknown>> = [];

  for (const lead of rows) {
    const phone = normalizePhone(lead.raw_phone);
    const identity = phone ? identityByPhone.get(phone) : null;

    const tgUsername = identity?.tg_username ? `@${identity.tg_username.replace(/^@/, '')}` : null;
    const fallbackName =
      [identity?.first_name, identity?.last_name].filter(Boolean).join(' ').trim() || null;

    const fullName =
      (lead.raw_contact_name ?? '').trim() ||
      fallbackName ||
      tgUsername;
    if (!fullName) continue;

    const title = (lead.raw_position ?? '').trim() || null;
    const role = guessRoleFromTitle(title);
    if (!isLikelyLpr(title, role.role)) continue;

    let score = role.score;
    if (tgUsername) score += 15;
    if (phone) score += 10;
    const leadEmail = sanitizeContactEmail(lead.raw_email);
    if (leadEmail) score += 10;

    const sourceDetails: Record<string, string> = {};
    if (lead.raw_contact_name) sourceDetails.name = 'Импорт файла';
    else if (fallbackName) sourceDetails.name = 'Telegram (MTProto)';
    if (title) sourceDetails.title = 'Импорт файла';
    if (phone) sourceDetails.phone = 'Импорт файла';
    if (tgUsername) sourceDetails.tg = 'Telegram (MTProto)';
    if (leadEmail) sourceDetails.email = 'Импорт файла';

    batch.push({
      user_id: lead.user_id,
      company_id: lead.company_id,
      source: tgUsername ? 'phone_tg' : 'manual',
      full_name: fullName,
      first_name: identity?.first_name ?? null,
      last_name: identity?.last_name ?? null,
      title,
      role_guess: role.role,
      channel_phone: phone,
      channel_tg_username: tgUsername,
      channel_tg_user_id: identity?.tg_user_id ?? null,
      channel_email: leadEmail,
      source_url: null,
      score,
      confidence: tgUsername ? 0.8 : 0.5,
      source_details: sourceDetails,
    });
  }

  if (batch.length === 0) return { processed: 0 };

  const chunkSize = 200;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const slice = batch.slice(i, i + chunkSize);
    const { error } = await supabaseAdmin
      .from('company_contacts')
      .upsert(slice, {
        onConflict: 'user_id,company_id,full_name',
      });
    if (!error) inserted += slice.length;
  }

  return { processed: inserted };
}

