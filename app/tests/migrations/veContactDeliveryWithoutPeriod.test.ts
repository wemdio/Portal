/** @jest-environment node */

/**
 * Миграция «доставка VE2 без периода» пересоздаёт тела функций контура
 * доставки из 20260902/20260903. Тест доказывает, что каждое тело — это
 * исходный текст ровно с перечисленными ниже точечными правками, а ветка
 * с периодом (формулы, ключ блокировки) осталась прежней. Тела на проде по
 * md5 совпадают с этими файлами репозитория (сверено 23.09.2026).
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { LAUNCHABLE_PORTAL_PROJECT_STATUSES } from '@/lib/verticalEngineV2/portalDeliveryTerm';

const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations');
const MIGRATION = '20260924_0010_ve_contact_delivery_without_period.sql';

const D = '20260902_0001_vertical_engine_v2_contact_delivery.sql';
const S = '20260903_0001_vertical_engine_v2_contact_supply.sql';

const TERM_PROJECT_ACTIVE = (projectExpr: string, veProjectExpr: string) =>
  `public.ve_contact_delivery_term(${projectExpr}, null, ${veProjectExpr})`;

const FUNCTION_EDITS: Array<{ file: string; name: string; target?: string; edits: Array<[string, string]> }> = [
  {
    file: D,
    name: 've_guard_contact_delivery_item_counters',
    edits: [[
      'where p.id = new.project_id and p.portal_period_id is not null',
      'where p.id = new.project_id and p.portal_project_id is not null',
    ]],
  },
  {
    file: D,
    name: 've_guard_contact_delivery_campaign_counters',
    edits: [[
      'where qi.id = new.item_id and p.portal_period_id is not null',
      'where qi.id = new.item_id and p.portal_project_id is not null',
    ]],
  },
  {
    file: D,
    name: 've_guard_contact_delivery_binding',
    edits: [
      ['v_bound := new.portal_period_id is not null;', 'v_bound := new.portal_project_id is not null;'],
      [
        "if tg_op = 'UPDATE' and old.portal_period_id is not null and (",
        "if tg_op = 'UPDATE' and old.portal_project_id is not null and (",
      ],
      [
        "if v_bound and (tg_op = 'INSERT' or old.portal_period_id is null) then",
        "if v_bound and (tg_op = 'INSERT' or old.portal_project_id is null) then",
      ],
      [
        `    if not exists (
      select 1
        from public.project_periods pp
       where pp.id = new.portal_period_id
         and pp.project_id = new.portal_project_id
         and pp.status = 'active'
    ) then
      raise exception 'bound Portal project period is not active';
    end if;`,
        `    if new.portal_period_id is not null and not exists (
      select 1
        from public.project_periods pp
       where pp.id = new.portal_period_id
         and pp.project_id = new.portal_project_id
         and pp.status = 'active'
    ) then
      raise exception 'bound Portal project period is not active';
    end if;
    if new.portal_period_id is null and not exists (
      select 1
        from ${TERM_PROJECT_ACTIVE('new.portal_project_id', 'new.id')} t
       where t.status = 'active'
    ) then
      raise exception 'bound Portal project without periods is not launchable';
    end if;`,
      ],
    ],
  },
  {
    file: D,
    name: 've_finalize_template_contact_delivery',
    edits: [
      [
        `  if v_project.portal_project_id is null
     or v_project.portal_period_id is null
     or v_project.target_contacts is null
     or v_project.launch_preset_id is null then`,
        `  if v_project.portal_project_id is null
     or v_project.target_contacts is null
     or v_project.launch_preset_id is null then`,
      ],
      [
        `  select pp.*
    into v_period
    from public.project_periods pp
   where pp.id = v_project.portal_period_id
     and pp.project_id = v_project.portal_project_id
     and pp.status = 'active'
   for share;
  if not found then
    raise exception 'bound Portal project period is not active at launch finalize';
  end if;`,
        `  if v_project.portal_period_id is not null then
    select pp.*
      into v_period
      from public.project_periods pp
     where pp.id = v_project.portal_period_id
       and pp.project_id = v_project.portal_project_id
       and pp.status = 'active'
     for share;
    if not found then
      raise exception 'bound Portal project period is not active at launch finalize';
    end if;
  else
    select t.deadline, t.contacts_done
      into v_period.deadline, v_period.contacts_done
      from ${TERM_PROJECT_ACTIVE('v_project.portal_project_id', 'v_project.id')} t
     where t.status = 'active';
    if not found then
      raise exception 'bound Portal project without periods is not launchable at launch finalize';
    end if;
  end if;`,
      ],
    ],
  },
  {
    file: D,
    name: 've_require_contact_delivery_rows',
    edits: [[
      `     where p.id = v_item.project_id
       and p.portal_period_id is not null`,
      `     where p.id = v_item.project_id
       and p.portal_project_id is not null`,
    ]],
  },
  {
    file: D,
    name: 've_bind_contact_delivery_plan',
    edits: [
      [
        `     or p_portal_project_id is null
     or p_expected_portal_period_id is null
     or p_bound_by is null`,
        `     or p_portal_project_id is null
     or p_bound_by is null`,
      ],
      [
        `  if v_project.portal_period_id is not null then
    if v_project.portal_project_id = p_portal_project_id
       and v_project.portal_period_id = p_expected_portal_period_id`,
        `  if v_project.portal_project_id is not null then
    if v_project.portal_project_id = p_portal_project_id
       and v_project.portal_period_id is not distinct from p_expected_portal_period_id`,
      ],
      [
        `  select pp.*
    into v_period
    from public.project_periods pp
   where pp.id = p_expected_portal_period_id
     and pp.project_id = p_portal_project_id
     and pp.status = 'active'
   for share;
  if not found then
    raise exception 'expected Portal project period is not active';
  end if;`,
        `  if p_expected_portal_period_id is not null then
    select pp.*
      into v_period
      from public.project_periods pp
     where pp.id = p_expected_portal_period_id
       and pp.project_id = p_portal_project_id
       and pp.status = 'active'
     for share;
    if not found then
      raise exception 'expected Portal project period is not active';
    end if;
  else
    select t.deadline, t.contacts_done
      into v_period.deadline, v_period.contacts_done
      from ${TERM_PROJECT_ACTIVE('p_portal_project_id', 'p_ve_project_id')} t
     where t.status = 'active';
    if not found then
      raise exception 'Portal project without periods is not launchable: it has periods, a non-working status, no ISO deadline or does not exist';
    end if;
  end if;`,
      ],
      [
        `  when unique_violation then
    raise exception 'Portal period already belongs to another VE2 delivery plan';`,
        `  when unique_violation then
    if p_expected_portal_period_id is null then
      raise exception 'Portal project without periods already belongs to another VE2 delivery plan';
    end if;
    raise exception 'Portal period already belongs to another VE2 delivery plan';`,
      ],
    ],
  },
  {
    file: D,
    name: 've_reserve_contact_delivery_day',
    target: 've_reserve_contact_delivery_day_before_supply',
    edits: [
      [
        `  if v_project.portal_project_id is null
     or v_project.portal_period_id is null
     or v_project.target_contacts is null
     or v_project.delivery_schedule_days is null`,
        `  if v_project.portal_project_id is null
     or v_project.target_contacts is null
     or v_project.delivery_schedule_days is null`,
      ],
      [
        `  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      've-contact-delivery-period:' || v_project.portal_period_id::text,
      0
    )
  );`,
        `  perform pg_catalog.pg_advisory_xact_lock(
    public.ve_contact_delivery_lock_key(v_project.portal_project_id, v_project.portal_period_id)
  );`,
      ],
      [
        `   where r.portal_period_id = v_project.portal_period_id
     and r.run_date = v_local_date
   for update;`,
        `   where (r.portal_period_id = v_project.portal_period_id
          or (v_project.portal_period_id is null
              and r.portal_period_id is null
              and r.ve_project_id = p_ve_project_id))
     and r.run_date = v_local_date
   for update;`,
      ],
      [
        `  select pp.*
    into v_period
    from public.project_periods pp
   where pp.id = v_project.portal_period_id
     and pp.project_id = v_project.portal_project_id
     and pp.status = 'active'
   for share;
  if not found then
    raise exception 'bound Portal project period is not active';
  end if;`,
        `  if v_project.portal_period_id is not null then
    select pp.*
      into v_period
      from public.project_periods pp
     where pp.id = v_project.portal_period_id
       and pp.project_id = v_project.portal_project_id
       and pp.status = 'active'
     for share;
    if not found then
      raise exception 'bound Portal project period is not active';
    end if;
  else
    -- Без периода факт плана — первые контакты кампаний этого VE2-проекта.
    select t.deadline
      into v_period.deadline
      from ${TERM_PROJECT_ACTIVE('v_project.portal_project_id', 'p_ve_project_id')} t
     where t.status = 'active';
    if not found then
      raise exception 'bound Portal project without periods is not launchable';
    end if;
    v_period.contacts_done := p_observed_ve_first_contacted::text;
  end if;`,
      ],
    ],
  },
  {
    file: D,
    name: 've_mark_contact_delivery_attempt',
    target: 've_mark_contact_delivery_attempt_before_supply',
    edits: [[
      `       select 1 from public.project_periods pp
        where pp.id = v_run.portal_period_id
          and pp.project_id = v_run.portal_project_id
          and pp.status = 'active'`,
      `       select 1 from public.ve_contact_delivery_term(v_run.portal_project_id, v_run.portal_period_id, v_run.ve_project_id) pp
        where pp.status = 'active'`,
    ]],
  },
  {
    file: D,
    name: 've_reserve_contact_delivery_activation',
    target: 've_reserve_contact_delivery_activation_before_supply',
    edits: [[
      `    select 1 from public.ve_projects p
    join public.project_periods pp on pp.id = p.portal_period_id
                                 and pp.project_id = p.portal_project_id`,
      `    select 1 from public.ve_projects p
    cross join lateral public.ve_contact_delivery_term(p.portal_project_id, p.portal_period_id, p.id) pp`,
    ]],
  },
  {
    file: D,
    name: 've_reconcile_launch_campaign_statuses',
    edits: [
      [
        '   where c.item_id = p_item_id and p.portal_period_id is not null;',
        '   where c.item_id = p_item_id and p.portal_project_id is not null;',
      ],
      [
        `    from public.ve_projects p
    join public.project_periods pp on pp.id = p.portal_period_id
                                 and pp.project_id = p.portal_project_id
   where p.id = v_item.project_id and p.portal_period_id is not null;`,
        `    from public.ve_projects p
    cross join lateral public.ve_contact_delivery_term(p.portal_project_id, p.portal_period_id, p.id) pp
   where p.id = v_item.project_id and p.portal_project_id is not null;`,
      ],
    ],
  },
  {
    file: S,
    name: 've_contact_supply_approval_current',
    edits: [[
      "and (p.portal_period_id is null or p.portal_period_id::text=s.approval_snapshot->>'portal_period_id')",
      "and (p.portal_project_id is null or p.portal_period_id is not distinct from (s.approval_snapshot->>'portal_period_id')::uuid)",
    ]],
  },
  {
    file: S,
    name: 've_approve_contact_supply',
    edits: [[
      `  if not exists(select 1 from public.project_periods pp where pp.id=p_portal_period_id
    and pp.project_id=p_portal_project_id and pp.status='active' and pp.deadline>=p_now::date) then`,
      `  if not exists(select 1 from public.ve_contact_delivery_term(p_portal_project_id,p_portal_period_id,null) pp
    where pp.status='active' and pp.deadline>=p_now::date) then`,
    ]],
  },
  {
    file: S,
    name: 've_require_contact_supply_active',
    edits: [[
      '    join public.project_periods pp on pp.id=p.portal_period_id and pp.project_id=p.portal_project_id\n    where qi.id=v_plan.item_id',
      '    cross join lateral public.ve_contact_delivery_term(p.portal_project_id,p.portal_period_id,p.id) pp\n    where qi.id=v_plan.item_id',
    ]],
  },
  {
    file: S,
    name: 've_append_contact_supply_batch',
    edits: [[
      `  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    've-contact-delivery-period:'||(v_plan.approval_snapshot->>'portal_period_id'),0));`,
      `  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(
    (v_plan.approval_snapshot->>'portal_project_id')::uuid,(v_plan.approval_snapshot->>'portal_period_id')::uuid));`,
    ]],
  },
  {
    file: S,
    name: 've_hold_continuous_supply_slot',
    edits: [[
      '      join public.project_periods pp on pp.id=p.portal_period_id and pp.project_id=p.portal_project_id\n      where s.item_id=old.id',
      '      cross join lateral public.ve_contact_delivery_term(p.portal_project_id,p.portal_period_id,p.id) pp\n      where s.item_id=old.id',
    ]],
  },
  {
    file: S,
    name: 've_reserve_contact_delivery_day',
    edits: [
      [
        'declare v_period uuid; v_result jsonb; v_date date; v_continuous boolean;',
        'declare v_period uuid; v_portal_project uuid; v_result jsonb; v_date date; v_continuous boolean;',
      ],
      [
        `  select portal_period_id,timezone(delivery_timezone,p_now)::date into v_period,v_date from public.ve_projects where id=p_ve_project_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ve-contact-delivery-period:'||v_period::text,0));`,
        `  select portal_project_id,portal_period_id,timezone(delivery_timezone,p_now)::date into v_portal_project,v_period,v_date from public.ve_projects where id=p_ve_project_id;
  perform pg_catalog.pg_advisory_xact_lock(public.ve_contact_delivery_lock_key(v_portal_project,v_period));`,
      ],
      [
        'delete from public.ve_contact_delivery_daily_runs r where r.portal_period_id=v_period and r.run_date=v_date',
        'delete from public.ve_contact_delivery_daily_runs r where (r.portal_period_id=v_period\n      or (v_period is null and r.portal_period_id is null and r.ve_project_id=p_ve_project_id)) and r.run_date=v_date',
      ],
    ],
  },
];

// Новые помощники закреплены целиком: это барьер п.6 (период появился —
// доставка стоп), разбор дедлайна и источник факта плана. Любая правка их
// текста должна сопровождаться правкой этого теста и прогоном SQL-смоука.
const SQL_STATUSES = LAUNCHABLE_PORTAL_PROJECT_STATUSES.map((status) => `'${status}'`).join(', ');
const HELPERS: Record<string, string> = {
  ve_try_iso_date: `create or replace function public.ve_try_iso_date(p_value text)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value text := btrim(p_value);
begin
  if v_value is null or v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return v_value::date;
exception
  when invalid_datetime_format or datetime_field_overflow then
    return null;
end;
$$;`,
  ve_contact_delivery_lock_key: `create or replace function public.ve_contact_delivery_lock_key(
  p_portal_project_id uuid,
  p_portal_period_id uuid
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.hashtextextended(
    case
      when p_portal_period_id is not null
        then 've-contact-delivery-period:' || p_portal_period_id::text
      else 've-contact-delivery-period:project:' || coalesce(p_portal_project_id::text, 'unbound')
    end,
    0
  )
$$;`,
  ve_contact_delivery_term: `create or replace function public.ve_contact_delivery_term(
  p_portal_project_id uuid,
  p_portal_period_id uuid,
  p_ve_project_id uuid
)
returns table(status text, deadline date, contacts_done text)
language sql
volatile
security definer
set search_path = ''
as $$
  select pp.status, pp.deadline, pp.contacts_done
    from public.project_periods pp
   where p_portal_period_id is not null
     and pp.id = p_portal_period_id
     and pp.project_id = p_portal_project_id
  union all
  select
    case
      when exists (
        select 1 from public.project_periods any_period where any_period.project_id = p.id
      ) then 'has_periods'
      when p.status in (${SQL_STATUSES}) then
        case when public.ve_try_iso_date(p.deadline::text) is null then 'no_deadline' else 'active' end
      else 'not_launchable'
    end,
    public.ve_try_iso_date(p.deadline::text),
    coalesce((
      select r.actual_first_contacted::text
        from public.ve_contact_delivery_daily_runs r
       where r.ve_project_id = p_ve_project_id
         and r.portal_project_id = p.id
         and r.portal_period_id is null
       order by r.run_date desc, r.created_at desc
       limit 1
    ), '0')
    from public.projects p
   where p_portal_period_id is null
     and p.id = p_portal_project_id
$$;`,
};

const SQL_SMOKE = path.resolve(__dirname, '../../scripts/vertical-engine-v2/contact-delivery-without-period-sql-smoke.mjs');

function pgliteModule(): string | null {
  if (process.env.PGLITE_MODULE) return process.env.PGLITE_MODULE;
  try {
    return require.resolve('@electric-sql/pglite');
  } catch {
    return null;
  }
}

function read(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
}

function extractFunction(sql: string, name: string): string {
  const matches = [...sql.matchAll(new RegExp(`create (?:or replace )?function public\\.${name}\\(`, 'g'))];
  if (matches.length !== 1) throw new Error(`${name}: expected one definition, got ${matches.length}`);
  const start = matches[0].index as number;
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(start, sql.indexOf(';', close) + 1);
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const migration = read(MIGRATION);

describe(`migration ${MIGRATION}`, () => {
  it.each(FUNCTION_EDITS.map((entry) => [entry.target ?? entry.name, entry] as const))(
    '%s is the original body with exactly the listed edits',
    (_name, entry) => {
      let expected = extractFunction(read(entry.file), entry.name);
      for (const [from, to] of entry.edits) {
        expect(occurrences(expected, from)).toBe(1);
        expected = expected.replace(from, () => to);
      }
      expected = expected.replace(
        new RegExp(`^create (?:or replace )?function public\\.${entry.name}\\(`),
        `create or replace function public.${entry.target ?? entry.name}(`,
      );
      expect(normalize(extractFunction(migration, entry.target ?? entry.name))).toBe(normalize(expected));
    },
  );

  it('recreates no other function besides the three new helpers', () => {
    const defined = [...migration.matchAll(/create (?:or replace )?function public\.([a-z_]+)\(/g)].map((match) => match[1]).sort();
    expect(defined).toEqual([
      ...FUNCTION_EDITS.map((entry) => entry.target ?? entry.name),
      've_contact_delivery_lock_key',
      've_contact_delivery_term',
      've_try_iso_date',
    ].sort());
  });

  it('relaxes the binding CHECK only for the period and adds the project-level guards', () => {
    const check = /add constraint ve_projects_delivery_plan_all_or_none\s+check \(([\s\S]*?)\n  \),/.exec(migration);
    expect(check).not.toBeNull();
    const [unbound, bound] = (check as RegExpExecArray)[1].split(/\n\s+or\n/);
    expect(unbound).toContain('portal_period_id is null');
    expect(bound).toContain('portal_project_id is not null');
    expect(bound).not.toContain('portal_period_id');
    expect(normalize(migration)).toContain(normalize(`add constraint ve_projects_portal_project_fkey
  foreign key (portal_project_id)
  references public.projects(id)
  on delete restrict`));
    expect(normalize(migration)).toContain(normalize(`create unique index if not exists ve_projects_one_delivery_plan_per_project_without_period
  on public.ve_projects(portal_project_id)
  where portal_project_id is not null and portal_period_id is null`));
    expect(normalize(migration)).toContain(normalize(`alter table public.ve_contact_delivery_daily_runs
  alter column portal_period_id drop not null`));
    expect(normalize(migration)).toContain(normalize(`create unique index if not exists ve_contact_delivery_daily_runs_project_date_without_period
  on public.ve_contact_delivery_daily_runs(portal_project_id, run_date)
  where portal_period_id is null`));
  });

  it('never writes Portal projects or periods', () => {
    const sql = migration.toLowerCase();
    expect(sql).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.(projects|project_periods)\b/);
    expect(sql).not.toMatch(/alter\s+table\s+public\.(projects|project_periods)\b/);
  });

  it('builds every delivery advisory key in one helper, keeping the period key byte-identical', () => {
    const helper = extractFunction(migration, 've_contact_delivery_lock_key');
    const outside = migration.replace(helper, '');
    expect(outside).not.toContain("'ve-contact-delivery-period:'");
    expect(helper).toContain("then 've-contact-delivery-period:' || p_portal_period_id::text");
    expect(helper).toContain("else 've-contact-delivery-period:project:' || coalesce(p_portal_project_id::text, 'unbound')");
    for (const name of ['ve_reserve_contact_delivery_day', 've_reserve_contact_delivery_day_before_supply', 've_append_contact_supply_batch']) {
      expect(extractFunction(migration, name)).toContain('public.ve_contact_delivery_lock_key(');
    }
  });

  it('matches the approval period exactly, including NULL', () => {
    expect(extractFunction(migration, 've_contact_supply_approval_current')).toContain(
      "p.portal_period_id is not distinct from (s.approval_snapshot->>'portal_period_id')::uuid",
    );
  });

  it.each(Object.keys(HELPERS))('%s is exactly the reviewed helper text', (name) => {
    expect(normalize(extractFunction(migration, name))).toBe(normalize(HELPERS[name]));
  });

  // Живой прогон SQL (PGlite): без периода, смена режима, кривой дедлайн,
  // регрессия с периодом. PGlite не зависимость проекта — без него тест
  // пропускается; запуск: PGLITE_MODULE=<путь к dist/index.js> npx jest <этот файл>.
  const pglite = pgliteModule();
  (pglite ? it : it.skip)('passes the PGlite SQL smoke', () => {
    const output = execFileSync(process.execPath, [SQL_SMOKE], {
      env: { ...process.env, PGLITE_MODULE: pglite ?? '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(output).toContain('PASS contact delivery without period');
  }, 90_000);

  it('keeps the new helpers internal like the existing delivery helpers', () => {
    for (const signature of ['ve_try_iso_date(text)', 've_contact_delivery_lock_key(uuid, uuid)', 've_contact_delivery_term(uuid, uuid, uuid)']) {
      expect(normalize(migration)).toContain(`revoke all on function public.${signature} from public, anon, authenticated, service_role;`);
      expect(migration).toContain(`grant execute on function public.${signature} to postgres;`);
    }
    for (const name of ['ve_try_iso_date', 've_contact_delivery_lock_key', 've_contact_delivery_term']) {
      expect(extractFunction(migration, name)).toContain("set search_path = ''");
    }
    expect(extractFunction(migration, 've_contact_delivery_term')).toContain('security definer');
  });
});
