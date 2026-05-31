/**
 * Re-export bundle для CLI backfill'а очистки названий.
 *
 * scripts/run-auto-pipeline-clean-names.mjs импортирует этот бандл напрямую.
 * Сборка добавляется в package.json → "build:workers" вместе с другими
 * worker/*.ts entry-point'ами.
 *
 * Зачем отдельный entry — runNameBackfill использует `server-only` + Next.js
 * path aliases (@/lib/*) и тянет stepNameCleanup; их нельзя запустить через
 * `node` напрямую. Esbuild (--conditions=react-server) собирает граф в один
 * файл с резолвленными alias'ами и снятым server-only.
 */

export { runNameBackfill } from '@/lib/jobs/autoPipelineNameBackfill';
export { supabaseAdmin } from '@/lib/supabaseAdmin';
