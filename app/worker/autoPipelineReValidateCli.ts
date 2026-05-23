/**
 * Re-validate уже собранных email'ов в seen_employers через lite (MX-only).
 *
 * Зачем: после dry-run прогона у нас в БД лежат email_found, но
 * email_validation_status='smtp_unknown' для всех, потому что SMTP-прокси
 * требовал креды которых у нас не было. MX-данные уже под рукой (validator
 * до SMTP-шага успел сделать lookup), но просто статус не отразил это как
 * 'valid'. Этот ре-валидатор:
 *
 *   1. Берёт все строки status='dry_run' с email_found IS NOT NULL.
 *   2. Прогоняет через validateEmailForAutoPipeline (lite — без SMTP).
 *   3. Обновляет email_validation_status и details.
 *   4. После прогона запускается analysis SQL и видны честные цифры.
 */

export { runReValidate } from '@/lib/jobs/autoPipelineReValidator';
export { supabaseAdmin } from '@/lib/supabaseAdmin';
