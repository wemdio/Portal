/**
 * Re-export bundle для CLI dry-run скрипта.
 *
 * scripts/run-auto-pipeline-dry-run.mjs импортирует этот бандл напрямую.
 * Сборка: добавляется в package.json → "build:workers" вместе с другими
 * worker/*.ts entry-point'ами.
 *
 * Зачем отдельный entry — runAutoPipelineForClient использует `server-only`
 * + Next.js path aliases (@/lib/*), их нельзя просто запустить через
 * `node app/src/lib/jobs/autoPipelineRunner.ts`. Esbuild собирает граф в один
 * файл с правильно резолвленными alias'ами, и его уже можно вызвать из
 * standalone Node-скрипта.
 */

export { runAutoPipelineForClient } from '@/lib/jobs/autoPipelineRunner';
export { supabaseAdmin } from '@/lib/supabaseAdmin';
