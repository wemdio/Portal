/** Executable PostgreSQL smoke for VE2 launches through «Рассылка» (migrations
 * 20261024_0020, 20261024_0030); never connects to Portal/prod.
 *
 * Run from app/: node scripts/vertical-engine-v2/sender-transport-sql-smoke.mjs
 * Supply PGLITE_MODULE when @electric-sql/pglite is installed outside this repo.
 * The sender tables are stubs with only the columns these migrations touch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const migration = (name) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const db = new PGlite();
let failures = 0;
const check = (ok, name, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
};
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await rows(sql, args))[0];
const expectError = async (name, sql, args, pattern) => {
  await db.exec('begin');
  try {
    await db.query(sql, args);
    check(false, name, 'no error');
  } catch (error) {
    check(pattern.test(error.message), name, error.message);
  } finally {
    await db.exec('rollback');
  }
};

try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role readonly;
    create table public.projects(id uuid primary key, client text, name text, status text,
      deadline text, launch_date text, contacts_obligation text, contacts_done text);
    create table public.project_periods(id uuid primary key default gen_random_uuid(),
      project_id uuid not null references public.projects on delete cascade, name text,
      status text not null default 'active', deadline date, contacts_done text,
      created_at timestamptz not null default now());
    create table public.sender_campaigns(id uuid primary key default gen_random_uuid(), name text,
      project_id uuid references public.projects on delete set null, created_at timestamptz not null default now(),
      source_kind text not null default 'manual', source_job_id uuid);
    create table public.sender_recipients(id uuid primary key default gen_random_uuid(),
      campaign_id uuid not null references public.sender_campaigns on delete cascade,
      email text, last_step_sent integer not null default 0);
    create table public.sender_mailboxes(id uuid primary key default gen_random_uuid(),
      email text unique, status text, enabled boolean);
  `);
  for (const name of [
    '20260820_0001_vertical_engine_v2_foundation.sql',
    '20260821_0001_vertical_engine_v2_runtime.sql',
    '20260824_0002_vertical_engine_v2_base_per_hypothesis.sql',
    '20260826_0001_vertical_engine_v2_fix_collecting_unique.sql',
    '20260828_0001_vertical_engine_v2_segmentation_audits.sql',
    '20260828_0003_vertical_engine_v2_launch_portfolio.sql',
    '20260831_0001_vertical_engine_v2_launch_preset_binding.sql',
    '20260902_0001_vertical_engine_v2_contact_delivery.sql',
    '20260903_0001_vertical_engine_v2_contact_supply.sql',
    '20260924_0010_ve_contact_delivery_without_period.sql',
    '20260924_0011_ve_project_deadline_card_formats.sql',
    '20260924_0013_ve_instantly_upload_capacity.sql',
    '20260924_0014_ve_contact_delivery_reconciliation.sql',
    '20260928_0004_ve_contact_delivery_rate.sql',
    '20261024_0020_ve_launch_transport.sql',
    '20261024_0030_sender_ve2_campaigns.sql',
  ]) {
    await db.exec(migration(name));
  }

  // ── Переключатель: по умолчанию всё в Instantly ──
  const settings = await rows('select market, mode, sender_uploads_enabled from public.ve_launch_transport_settings order by market');
  check(settings.length === 2 && settings.every((s) => s.mode === 'instantly' && s.sender_uploads_enabled === true),
    'switch rows ru/us default to instantly', JSON.stringify(settings));

  // ── Запуск: рассыльщик берётся из launch_info шаблона ──
  const USER = '00000000-0000-4000-8000-000000000001';
  const STAFF = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
  const PRESET = '77777777-7777-4777-8777-777777777777';
  const now = '2030-09-02T06:00:00Z';
  await rows(`insert into public.projects values ($1,'Staff Line','Аутрич','В работе','2030-09-30','2030-08-30','4000','0')`, [STAFF]);
  const VE = '22222222-2222-4222-8222-222222222222';
  const VERT = '33333333-3333-4333-8333-333333333333';
  const BASE = '44444444-4444-4444-8444-444444444444';
  await rows(`insert into public.ve_projects(id,created_by,name,website_url,launch_preset_id,
      launch_instantly_account_id,launch_preset_bound_at,launch_preset_bound_by)
    values($1,$2,'VE','https://example.org',$3,'main',$4,$2)`, [VE, USER, PRESET, now]);
  check((await one('select launch_transport_override from public.ve_projects where id=$1', [VE])).launch_transport_override === null,
    'project override defaults to null');
  await expectError('project override accepts only instantly/sender', `update public.ve_projects set launch_transport_override='other' where id=$1`, [VE], /check/);
  await rows(`insert into public.ve_verticals(id,project_id,name,potential_pct) values($1,$2,'HR',50)`, [VERT, VE]);
  await rows(`insert into public.ve_bases(id,project_id,vertical_id,columns,data,source,status)
    values($1,$2,$3,'["email"]','[]','auto','analyzed')`, [BASE, VE, VERT]);
  await one(`select public.ve_bind_contact_delivery_plan($1,$2,$3,$4,'{1,2,3,4,5}'::smallint[],'Europe/Moscow',20,$5,$6::timestamptz) as r`,
    [VE, STAFF, null, 4000, USER, now]);

  const launch = async ({ tpl, audit, res, campaign, transport }) => {
    await rows(`insert into public.ve_templates(id,base_id,vertical_id,letters,status)
      values($1,$2,$3,'[{"subject":"s","body":"b"}]','ready')`, [tpl, BASE, VERT]);
    await rows(`insert into public.ve_segmentation_audits(id,project_id,template_id,base_id,requested_by,status,input_hash,summary,
        launch_status,launch_reservation_id)
      values($1,$2,$3,$4,$5,'ready',repeat('a',64),'{}','running',$6)`, [audit, VE, tpl, BASE, USER, res]);
    const info = {
      campaign_id: campaign, campaign_name: 'C', campaign_url: 'u', leads_count: 0, preset_id: PRESET,
      instantly_account_id: 'main', mailbox_ids: ['sender@example.org'], portal_project_id: STAFF, portal_period_id: null,
      target_contacts: 4000, campaigns: [{ campaign_id: campaign, campaign_name: 'C', campaign_url: 'u', segment: null, leads_count: 0 }],
      ...(transport ? { transport } : {}),
    };
    const drip = [{ campaign_id: campaign, source_row_index: 0, drip_order: 0, lead_payload: { email: `${campaign}@example.org` } }];
    return (await one(`select public.ve_finalize_template_contact_delivery($1,$2,$3,'succeeded',$4::jsonb,null,$5::timestamptz,$6::jsonb) as r`,
      [audit, tpl, res, JSON.stringify(info), now, JSON.stringify(drip)])).r;
  };

  const instantlyLaunch = await launch({
    tpl: '55555555-5555-4555-8555-555555555555', audit: '66666666-6666-4666-8666-666666666666',
    res: '99999999-9999-4999-8999-999999999999', campaign: 'camp-instantly',
  });
  check(instantlyLaunch?.finalized === true, 'instantly launch finalizes', JSON.stringify(instantlyLaunch));
  const instantlyItem = instantlyLaunch?.queue_item?.id;
  const instantlyRows = await one(`select i.transport as item, c.transport as campaign from public.ve_launch_queue_items i
    join public.ve_launch_queue_campaigns c on c.item_id=i.id where i.id=$1`, [instantlyItem]);
  check(instantlyRows?.item === 'instantly' && instantlyRows?.campaign === 'instantly',
    'launch without transport is recorded as instantly', JSON.stringify(instantlyRows));

  const SENDER_CAMPAIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const senderLaunch = await launch({
    tpl: '55555555-5555-4555-8555-555555555556', audit: '66666666-6666-4666-8666-666666666667',
    res: '99999999-9999-4999-8999-999999999998', campaign: SENDER_CAMPAIGN, transport: 'sender',
  });
  const senderItem = senderLaunch?.queue_item?.id;
  const senderRows = await one(`select i.transport as item, c.transport as campaign from public.ve_launch_queue_items i
    join public.ve_launch_queue_campaigns c on c.item_id=i.id where i.id=$1`, [senderItem]);
  check(senderRows?.item === 'sender' && senderRows?.campaign === 'sender',
    'launch_info.transport=sender is recorded on the item and its campaigns', JSON.stringify({ senderLaunch, senderRows }));
  await expectError('item transport is immutable', `update public.ve_launch_queue_items set transport='instantly' where id=$1`, [senderItem], /immutable/);
  await expectError('campaign transport is immutable', `update public.ve_launch_queue_campaigns set transport='instantly' where item_id=$1`, [senderItem], /immutable/);
  await rows(`update public.ve_launch_queue_items set status='active' where id=$1`, [senderItem]);
  check((await one('select transport from public.ve_launch_queue_items where id=$1', [senderItem])).transport === 'sender',
    'other updates keep the transport');

  // ── Кампании ve2 и привязка к проекту ──
  const RESERVATION = '99999999-9999-4999-8999-999999999997';
  await rows(`insert into public.sender_campaigns(id,name,project_id,source_kind,source_job_id,source_ref,created_at)
    values($1,'VE',$2,'ve2',$3,'default','2030-09-01T00:00:00Z')`, [SENDER_CAMPAIGN, STAFF, RESERVATION]);
  await expectError('one ve2 campaign per reservation and segment',
    `insert into public.sender_campaigns(name,project_id,source_kind,source_job_id,source_ref) values('VE',$1,'ve2',$2,'default')`,
    [STAFF, RESERVATION], /duplicate key/);
  await expectError('unknown source_kind is rejected', `insert into public.sender_campaigns(name,source_kind) values('X','other')`, [], /check/);
  for (const step of [0, 1, 2, 1]) {
    await rows('insert into public.sender_recipients(campaign_id,email,last_step_sent) values($1,$2,$3)', [SENDER_CAMPAIGN, `r${Math.random()}@x.ru`, step]);
  }
  const first = await rows('select campaign_id, first_contacted from public.sender_campaign_first_contacted($1::uuid[])',
    [[SENDER_CAMPAIGN, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']]);
  check(first.length === 1 && Number(first[0].first_contacted) === 3, 'first contacted counts last_step_sent >= 1, unknown ids give no row', JSON.stringify(first));

  const reserve = 'select public.reserve_project_sender_campaigns($1,$2,$3::uuid[],$4,$5) as r';
  check((await one(reserve, [STAFF, null, [SENDER_CAMPAIGN], 've2 launch', USER])).r?.status === 'ok', 'link without period');
  check((await one(reserve, [STAFF, null, [SENDER_CAMPAIGN], 've2 launch', USER])).r?.status === 'ok', 'link replay is idempotent');
  check(Number((await one('select count(*) as n from public.project_sender_campaigns where campaign_id=$1', [SENDER_CAMPAIGN])).n) === 1,
    'replay does not duplicate the link');
  const PERIOD = '12121212-1212-4212-8212-121212121212';
  await rows(`insert into public.project_periods(id,project_id,name,created_at) values($1,$2,'Октябрь','2030-09-15T00:00:00Z')`, [PERIOD, STAFF]);
  await one(reserve, [STAFF, PERIOD, [SENDER_CAMPAIGN], 've2 launch', USER]);
  check(Number((await one('select baseline_contacts as b from public.project_sender_campaigns where period_id=$1', [PERIOD])).b) === 3,
    'a campaign created before the period opened gets the current count as baseline');
  const NEW_CAMPAIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await rows(`insert into public.sender_campaigns(id,name,project_id,source_kind,created_at) values($1,'VE2',$2,'ve2','2030-09-20T00:00:00Z')`, [NEW_CAMPAIGN, STAFF]);
  await rows('insert into public.sender_recipients(campaign_id,email,last_step_sent) values($1,$2,1)', [NEW_CAMPAIGN, 'n@x.ru']);
  await one(reserve, [STAFF, PERIOD, [NEW_CAMPAIGN], 've2 launch', USER]);
  check(Number((await one('select baseline_contacts as b from public.project_sender_campaigns where campaign_id=$1', [NEW_CAMPAIGN])).b) === 0,
    'a campaign created inside the period starts from 0');

  const OTHER = '13131313-1313-4313-8313-131313131313';
  await rows(`insert into public.projects values ($1,'Другой','Аутрич','В работе','2030-09-30','2030-08-30','10','0')`, [OTHER]);
  const conflict = (await one(reserve, [OTHER, null, [SENDER_CAMPAIGN], 've2 launch', USER])).r;
  check(conflict?.status === 'conflict' && JSON.stringify(conflict.conflicting_project_ids) === JSON.stringify([STAFF]),
    'a campaign of another project is a conflict naming that project, not the caller', JSON.stringify(conflict));
  const UNOWNED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await rows(`insert into public.sender_campaigns(id,name,source_kind) values($1,'Ничья','ve2')`, [UNOWNED]);
  const unowned = (await one(reserve, [STAFF, null, [UNOWNED], 've2 launch', USER])).r;
  check(unowned?.status === 'conflict' && unowned.conflicting_project_ids.length === 0, 'a campaign without a project is refused too', JSON.stringify(unowned));
  await expectError('guard rejects a link to a project the campaign does not belong to',
    'insert into public.project_sender_campaigns(project_id,campaign_id) values($1,$2)', [OTHER, SENDER_CAMPAIGN], /belongs to project/);
  const OTHER_PERIOD = '14141414-1414-4414-8414-141414141414';
  await rows(`insert into public.project_periods(id,project_id,name) values($1,$2,'Чужой')`, [OTHER_PERIOD, OTHER]);
  await expectError('guard rejects a period of another project',
    'insert into public.project_sender_campaigns(project_id,period_id,campaign_id) values($1,$2,$3)', [STAFF, OTHER_PERIOD, SENDER_CAMPAIGN], /does not belong/);
  await rows(`update public.project_sender_campaigns set match_reason='повтор' where campaign_id=$1`, [SENDER_CAMPAIGN]);
  check(true, 'updating a link keeps passing its own guard');
  await expectError('a linked campaign cannot move to another project', 'update public.sender_campaigns set project_id=$1 where id=$2',
    [OTHER, SENDER_CAMPAIGN], /unlink it first/);
  await rows('update public.sender_campaigns set project_id=$1 where id=$2', [OTHER, UNOWNED]);
  check((await one('select project_id from public.sender_campaigns where id=$1', [UNOWNED])).project_id === OTHER, 'an unlinked campaign can move');
  await expectError('a linked sender campaign cannot be deleted', 'delete from public.sender_campaigns where id=$1', [SENDER_CAMPAIGN], /foreign key/);
  const GONE = '15151515-1515-4515-8515-151515151515';
  const GONE_CAMPAIGN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await rows(`insert into public.projects values ($1,'Удаляемый','Аутрич','В работе','2030-09-30','2030-08-30','10','0')`, [GONE]);
  await rows(`insert into public.sender_campaigns(id,name,project_id,source_kind) values($1,'G',$2,'ve2')`, [GONE_CAMPAIGN, GONE]);
  await one(reserve, [GONE, null, [GONE_CAMPAIGN], 've2 launch', USER]);
  await rows('delete from public.projects where id=$1', [GONE]);
  const gone = await one(`select c.project_id, (select count(*) from public.project_sender_campaigns l where l.campaign_id=c.id) as links
    from public.sender_campaigns c where c.id=$1`, [GONE_CAMPAIGN]);
  check(gone.project_id === null && Number(gone.links) === 0, 'deleting a project drops its links and keeps the campaign', JSON.stringify(gone));

  // ── Остановленная кампания «Рассылки» (3) отпускает запуск, как завершённая у Instantly ──
  // Обязательство выполнено — неподанные строки больше не держат запуск.
  await rows(`update public.projects set contacts_done='4000' where id=$1`, [STAFF]);
  await one(`select public.ve_reconcile_launch_campaign_statuses($1,$2::jsonb,$3::timestamptz) as r`,
    [senderItem, JSON.stringify([{ campaign_id: SENDER_CAMPAIGN, status: 3, status_observed_at: now }]), now]);
  const released = await one('select status, release_reason from public.ve_launch_queue_items where id=$1', [senderItem]);
  check(released?.status === 'released' && released?.release_reason === 'Все кампании завершены',
    'a sender bundle with every campaign stopped is released', JSON.stringify(released));

  // ── Ящики пресета в «Рассылке» ──
  await rows(`insert into public.sender_mailboxes(email,status,enabled) values('Box@Example.org','verified',true),('off@example.org','failed',true)`);
  const pool = await rows('select email, status from public.ve_sender_pool_for_emails($1::text[]) order by email', [[' box@example.org', 'OFF@example.org', 'none@example.org']]);
  check(pool.length === 2 && pool[0].email === 'Box@Example.org', 'preset pool lookup is case-insensitive and returns status', JSON.stringify(pool));
} finally {
  await db.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
