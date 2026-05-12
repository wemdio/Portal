#!/usr/bin/env node
/**
 * Генерирует supabase/migrations/20260512_0003_companies_directory_okved_backfill.sql:
 *   1) Создаёт mapping-таблицу `public.activity_type_okved_mapping` (activity_type → okved_code)
 *      из activityTypeToOkved.json.
 *   2) Делает идемпотентный UPDATE companies_directory SET okved_code = m.okved_code
 *      FROM activity_type_okved_mapping m WHERE c.activity_type = m.activity_type.
 *
 * Запуск (из app/):
 *   node scripts/db/buildBackfillSql.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAP_PATH = resolve(__dirname, 'activityTypeToOkved.json');
const OUT_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '20260512_0003_companies_directory_okved_backfill.sql',
);

const pgEsc = (s) => s.replace(/'/g, "''");

const data = JSON.parse(await readFile(MAP_PATH, 'utf8'));
const entries = Object.entries(data.mapping);

const inserts = [];
const chunkSize = 200;
for (let i = 0; i < entries.length; i += chunkSize) {
  const chunk = entries.slice(i, i + chunkSize);
  const values = chunk
    .map(([name, code]) => `('${pgEsc(name)}', ${code === null ? 'null' : `'${pgEsc(code)}'`})`)
    .join(',\n  ');
  inserts.push(
    `insert into public.activity_type_okved_mapping (activity_type, okved_code) values\n  ${values}\non conflict (activity_type) do update set okved_code = excluded.okved_code;`,
  );
}

const sql = `-- AUTO-GENERATED from app/scripts/db/activityTypeToOkved.json
-- Перегенерация: cd app && node scripts/db/buildBackfillSql.mjs
--
-- Мэппинг companies_directory.activity_type (303 категории внутренней таксономии)
-- на коды ОКВЭД-2. Каждая категория связана с одним кодом из public.okved_reference;
-- категория "Прочие услуги" не имеет однозначного соответствия и оставлена с null.

create table if not exists public.activity_type_okved_mapping (
  activity_type text primary key,
  okved_code    text references public.okved_reference(code),
  updated_at    timestamptz not null default now()
);

create index if not exists activity_type_okved_mapping_code_idx
  on public.activity_type_okved_mapping(okved_code);

grant select on public.activity_type_okved_mapping to anon, authenticated;
grant select, insert, update, delete on public.activity_type_okved_mapping to service_role;

${inserts.join('\n\n')}

-- ── Backfill companies_directory.okved_code ──────────────────────────
-- Идемпотентно: можно повторно прогонять при изменении мэппинга. Затрагивает
-- ~2.1M строк, занимает несколько минут (одна транзакция, обычный UPDATE).
update public.companies_directory c
   set okved_code = m.okved_code
  from public.activity_type_okved_mapping m
 where c.activity_type = m.activity_type
   and (c.okved_code is distinct from m.okved_code);

-- Сводка после бэкфилла (для лога):
do $$
declare
  v_total bigint; v_mapped bigint; v_pct numeric;
begin
  select count(*) into v_total from public.companies_directory;
  select count(*) into v_mapped from public.companies_directory where okved_code is not null;
  v_pct := round((v_mapped::numeric / nullif(v_total,0)) * 100, 2);
  raise notice 'okved_code backfill: % / % rows mapped (% %%)', v_mapped, v_total, v_pct;
end $$;
`;

await writeFile(OUT_PATH, sql, 'utf8');
console.log('✓ wrote', OUT_PATH);
console.log('  mapping rows:', entries.length);
