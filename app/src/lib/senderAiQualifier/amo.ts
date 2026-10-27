import type { SupabaseClient } from '@supabase/supabase-js';
import { domainFromEmail } from '@/lib/polzaRuOutreach/company';

/** Успешно реализовано / закрыто и не реализовано — закрытые этапы AMO. */
const CLOSED_STATUS_IDS = '(142,143)';

/**
 * Есть ли у адреса открытая сделка в AMO — по ночной копии amo_leads, без
 * обращения к API. С такими уже работает менеджер: ИИ им не пишет, лид идёт
 * прежним путём (примечание в сделку).
 */
export async function hasOpenAmoDeal(db: SupabaseClient, email: string): Promise<boolean> {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return false;

  const byEmail = await db
    .from('amo_leads_with_origin_v')
    .select('amo_id')
    .ilike('contact_email', address)
    .is('closed_at', null)
    .not('status_id', 'in', CLOSED_STATUS_IDS)
    .limit(1);
  if (byEmail.error) throw new Error(`amo_leads: ${byEmail.error.message}`);
  if (byEmail.data?.length) return true;

  // Личную почту по сайту не сопоставляем: gmail.com есть у тысяч компаний.
  const domain = domainFromEmail(address);
  if (!domain) return false;
  const bySite = await db
    .from('amo_leads_with_origin_v')
    .select('amo_id')
    .ilike('company_website', `%${domain}%`)
    .is('closed_at', null)
    .not('status_id', 'in', CLOSED_STATUS_IDS)
    .limit(1);
  if (bySite.error) throw new Error(`amo_leads: ${bySite.error.message}`);
  return Boolean(bySite.data?.length);
}
