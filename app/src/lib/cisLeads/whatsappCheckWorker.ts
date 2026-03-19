import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * WhatsApp number verification worker.
 * Checks if phone numbers are registered on WhatsApp.
 *
 * Currently checks via baileys `onWhatsApp` when a WA session is available.
 * If no WA session exists → silently skips (returns processed: 0).
 *
 * WA session setup: store creds.json in Supabase storage bucket `wa-auth/{userId}/creds.json`
 */

const WA_CHECK_BATCH = 50;
const WA_CREDS_BUCKET = 'wa-auth';

function normalizeToWaNumber(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return digits;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

export async function runWhatsAppCheckBatch(
  jobId: string,
  userId: string,
): Promise<{ processed: number; registered: number }> {
  if (!supabaseAdmin) return { processed: 0, registered: 0 };

  // Get company IDs for this job
  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(new Set(
    (leads ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean),
  ));
  if (companyIds.length === 0) return { processed: 0, registered: 0 };

  // Get contacts with phones but no WA check yet
  const { data: contactsToCheck } = await supabaseAdmin
    .from('company_contacts')
    .select('id, channel_phone')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .not('channel_phone', 'is', null)
    .is('wa_registered', null)
    .limit(WA_CHECK_BATCH);

  if (!contactsToCheck?.length) return { processed: 0, registered: 0 };

  const contacts = contactsToCheck as Array<{ id: string; channel_phone: string }>;

  // Collect unique numbers
  const numberToContactIds = new Map<string, string[]>();
  for (const c of contacts) {
    const num = normalizeToWaNumber(c.channel_phone);
    if (!num) continue;
    const ids = numberToContactIds.get(num) ?? [];
    ids.push(c.id);
    numberToContactIds.set(num, ids);
  }

  const numbers = Array.from(numberToContactIds.keys());
  if (numbers.length === 0) return { processed: 0, registered: 0 };

  // Try to load WA creds from Supabase storage
  const credsPath = `${userId}/creds.json`;
  const { data: credsBlob } = await supabaseAdmin
    .storage
    .from(WA_CREDS_BUCKET)
    .download(credsPath);

  if (!credsBlob) {
    console.log('[cis-leads] whatsappCheck: no WA session in storage, skipping');
    return { processed: 0, registered: 0 };
  }

  // If we have creds, try to check via baileys
  const registeredSet = new Set<string>();

  try {
    const credsText = await credsBlob.text();
    const creds = JSON.parse(credsText);

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default;

    const sock = makeWASocket({
      auth: { creds, keys: {} } as never,
      printQRInTerminal: false,
      logger: { level: 'silent', child: () => ({ level: 'silent' }) } as never,
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WA connection timeout')), 15_000);
      sock.ev.on('connection.update', (update: { connection?: string }) => {
        if (update.connection === 'open') { clearTimeout(timeout); resolve(); }
        if (update.connection === 'close') { clearTimeout(timeout); reject(new Error('WA closed')); }
      });
    });

    try {
      const jids = numbers.map((n) => `${n}@s.whatsapp.net`);
      const results = await sock.onWhatsApp(...jids);

      for (const r of results ?? []) {
        if (r.exists) {
          const num = r.jid.replace(/@s\.whatsapp\.net$/, '');
          registeredSet.add(num);
        }
      }

      console.log(`[cis-leads] whatsappCheck: checked ${numbers.length}, registered: ${registeredSet.size}`);
    } finally {
      try { await sock.logout(); } catch { /* */ }
      try { sock.end(undefined); } catch { /* */ }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[cis-leads] whatsappCheck: failed (${msg}), skipping`);
    return { processed: 0, registered: 0 };
  }

  // Update contacts with results
  let registered = 0;
  for (const [num, contactIds] of numberToContactIds) {
    const isRegistered = registeredSet.has(num);
    if (isRegistered) registered += contactIds.length;

    for (const id of contactIds) {
      if (isRegistered) {
        // Merge source_details
        const { data: existing } = await supabaseAdmin
          .from('company_contacts')
          .select('source_details')
          .eq('id', id)
          .maybeSingle<{ source_details: Record<string, string> | null }>();
        const details = (existing?.source_details && typeof existing.source_details === 'object' ? existing.source_details : {}) as Record<string, string>;
        details.whatsapp = 'WhatsApp проверка';
        await supabaseAdmin
          .from('company_contacts')
          .update({ wa_registered: true, source_details: details })
          .eq('id', id)
          .eq('user_id', userId);
      } else {
        await supabaseAdmin
          .from('company_contacts')
          .update({ wa_registered: false })
          .eq('id', id)
          .eq('user_id', userId);
      }
    }
  }

  return { processed: contacts.length, registered };
}
