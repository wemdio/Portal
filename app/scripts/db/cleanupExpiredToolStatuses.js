#!/usr/bin/env node
/**
 * Снимает статус 'new' с инструментов, которым он висит больше 7 дней.
 * Запускается из `.semaphore/scheduled-deploy.yml` после миграций.
 *
 * Плашка на UI пропадает и без этого скрипта (эффективный статус считается
 * в `effectiveToolStatus` на каждое чтение `/api/user/tools`), но скрипт
 * приводит таблицу в честный вид — чтобы в admin-модалке не висели
 * «протухшие» 'new'-строки.
 *
 * Никаких аргументов. Падать не должен — ошибки логирует и выходит с 0,
 * чтобы не валить деплой целиком.
 */
const { createClient } = require('@supabase/supabase-js');

const NEW_TTL_DAYS = 7;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[cleanup-tool-statuses] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return;
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const cutoffMs = Date.now() - NEW_TTL_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const { data, error } = await db
    .from('global_tool_visibility')
    .update({ status: 'active', new_since: null, updated_at: new Date().toISOString() })
    .eq('status', 'new')
    .lt('new_since', cutoffIso)
    .select('tool_id, new_since');

  if (error) {
    console.error('[cleanup-tool-statuses] update failed:', error.message);
    return;
  }
  const demoted = data ?? [];
  if (demoted.length === 0) {
    console.log(`[cleanup-tool-statuses] OK: no expired 'new' statuses (cutoff=${cutoffIso}, TTL=${NEW_TTL_DAYS}d)`);
    return;
  }
  console.log(
    `[cleanup-tool-statuses] OK: demoted ${demoted.length} tool(s) from 'new' to 'active' (cutoff=${cutoffIso}):`,
    demoted.map((r) => `${r.tool_id} (since ${r.new_since})`).join(', '),
  );
}

main().catch((err) => {
  console.error('[cleanup-tool-statuses] unexpected:', err && err.message ? err.message : err);
  // Не валим деплой из-за этого.
  process.exit(0);
});
