import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { buildVeContactDeliveryPreview, type ContactDeliveryPreviewRequest, type ContactDeliveryPreviewOutcome } from './contactDeliveryPreview';

/** An approval records the reviewed input, never starts a campaign or binds a different client. */
export async function approveVeContactSupply(
  portalDb: SupabaseClient,
  instantlyDb: SupabaseClient,
  input: ContactDeliveryPreviewRequest & { userId: string; confirmed: boolean; reviewedRevision: string },
): Promise<ContactDeliveryPreviewOutcome> {
  if (!input.confirmed || !input.segmentationAuditId || !input.reviewedRevision) {
    return { status: 400, body: { error: 'Подтвердите согласование превью, писем и сегментации с заказчиком.' } };
  }
  // Read BEFORE validation; SQL compares again atomically to close the preflight race.
  const { data: revision, error: revisionError } = await portalDb.rpc('ve_contact_supply_preview_revision', { p_template_id: input.templateId });
  if (revisionError || typeof revision !== 'string' || !revision) {
    return { status: 503, body: { error: 'Согласование сейчас недоступно. Проверьте доступность миграции автопополнения.' } };
  }
  if (revision !== input.reviewedRevision) return { status: 409, body: { error: 'Превью или условия изменились после просмотра. Обновите страницу и проверьте их заново.' } };
  const preview = await buildVeContactDeliveryPreview(portalDb, instantlyDb, input);
  if (preview.status !== 200) return preview;
  const planPreview = preview.body.preview as { prospective_ready?: number } | undefined;
  if (!planPreview?.prospective_ready) return { status: 409, body: { error: 'В превью нет новых пригодных контактов после проверок клиента и дублей.' } };
  const { data: preset, error: presetError } = await instantlyDb.from('client_campaign_presets')
    .select('id, instantly_account_id, email_account_ids').eq('id', input.presetId).maybeSingle();
  if (presetError || !preset) return { status: 503, body: { error: 'Клиентский пресет недоступен.' } };
  if (!Array.isArray(preset.email_account_ids) || !preset.email_account_ids.some((value: unknown) => typeof value === 'string' && value.trim())) {
    return { status: 409, body: { error: 'В пресете нет отправителей. Сначала выберите тег почт.' } };
  }
  const { data, error } = await portalDb.rpc('ve_approve_contact_supply', {
    p_template_id: input.templateId,
    p_audit_id: input.segmentationAuditId,
    p_expected_preview_revision: revision,
    p_preset_id: input.presetId,
    p_portal_project_id: input.portalProjectId,
    p_portal_period_id: input.expectedPortalPeriodId,
    p_target_contacts: input.targetContacts,
    p_instantly_account_id: resolveInstantlyAccountId(preset.instantly_account_id),
    p_approved_by: input.userId,
    p_now: (input.now ?? new Date()).toISOString(),
  });
  if (error || !data) return { status: 409, body: { error: error?.message ?? 'Не удалось сохранить согласование.' } };
  return { status: 200, body: { approved: true } };
}
