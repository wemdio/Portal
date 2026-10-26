/** Executable PostgreSQL smoke for VE2 launches through «Рассылка» (migrations
 * 20261024_0020, 20261024_0030, 20261024_0070, 20261026_0010, 20261026_0020, 20261026_0040); never connects to Portal/prod.
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
    create table public.sender_messages(id uuid primary key default gen_random_uuid(),
      campaign_id uuid not null references public.sender_campaigns on delete cascade,
      recipient_id uuid not null references public.sender_recipients on delete cascade,
      step_no int not null, status text not null, sent_at timestamptz);
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
    '20261024_0070_sender_first_contacted_since.sql',
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

  // ── Первые письма с открытия периода ──
  // Получатели SENDER_CAMPAIGN (r0..r3 выше): первое письмо r0 — 05.09, r1 —
  // 20.09 (и второй шаг 21.09), у r2 упало, у r3 ещё в очереди.
  const recipients = (await rows('select id from public.sender_recipients where campaign_id=$1 order by email', [SENDER_CAMPAIGN])).map((r) => r.id);
  await rows(`insert into public.sender_messages(campaign_id,recipient_id,step_no,status,sent_at) values
    ($1,$2,1,'sent','2030-09-05T00:00:00Z'),($1,$3,1,'scheduled',null),($1,$3,2,'sent','2030-09-21T00:00:00Z'),
    ($1,$4,1,'failed','2030-09-22T00:00:00Z'),($1,$5,1,'scheduled',null)`, [SENDER_CAMPAIGN, ...recipients]);
  await rows(`update public.sender_messages set status='sent', sent_at='2030-09-20T00:00:00Z' where recipient_id=$1 and step_no=1`, [recipients[1]]);
  await rows(`update public.sender_messages set status='sent', sent_at='2030-09-25T00:00:00Z' where recipient_id=$1 and step_no=1`, [recipients[1]]);
  const stamped = await rows('select recipient_id, first_sent_at from public.sender_first_sends order by first_sent_at');
  check(stamped.length === 2 && stamped[1].recipient_id === recipients[1] && new Date(stamped[1].first_sent_at).toISOString() === '2030-09-20T00:00:00.000Z',
    'trigger records the first send of letter 1 once, nothing for other steps or failures', JSON.stringify(stamped));
  const since = await rows(`select campaign_id, first_contacted from public.sender_campaign_first_contacted_since($1::uuid[], $2::timestamptz[])
    order by campaign_id`, [[SENDER_CAMPAIGN, NEW_CAMPAIGN], ['2030-09-15T00:00:00Z', null]]);
  check(since.length === 2 && Number(since.find((r) => r.campaign_id === SENDER_CAMPAIGN).first_contacted) === 1
    && Number(since.find((r) => r.campaign_id === NEW_CAMPAIGN).first_contacted) === 1,
    'since counts recipients whose letter 1 went after the moment; null since — last_step_sent rule', JSON.stringify(since));
  await rows('delete from public.sender_messages where campaign_id=$1', [SENDER_CAMPAIGN]);
  const afterDelete = await one(`select first_contacted from public.sender_campaign_first_contacted_since($1::uuid[], $2::timestamptz[])`,
    [[SENDER_CAMPAIGN], ['2030-09-01T00:00:00Z']]);
  check(Number(afterDelete.first_contacted) === 2, 'deleting letters (mailbox cascade) does not lower the period count', JSON.stringify(afterDelete));
  await expectError('ids and moments must be pairs',
    `select * from public.sender_campaign_first_contacted_since($1::uuid[], $2::timestamptz[])`, [[SENDER_CAMPAIGN, NEW_CAMPAIGN], [null]], /pairs/);

  // ── Ящики пресета в «Рассылке» ──
  await rows(`insert into public.sender_mailboxes(email,status,enabled) values('Box@Example.org','verified',true),('off@example.org','failed',true)`);
  const pool = await rows('select email, status from public.ve_sender_pool_for_emails($1::text[]) order by email', [[' box@example.org', 'OFF@example.org', 'none@example.org']]);
  check(pool.length === 2 && pool[0].email === 'Box@Example.org', 'preset pool lookup is case-insensitive and returns status', JSON.stringify(pool));

  // ── Карточки лидов проектов (этап 5) ──
  await db.exec(`
    alter table public.sender_recipients add column lead_verdict text, add column lead_verdict_source text;
    create table public.sender_replies(id uuid primary key default gen_random_uuid(),
      recipient_id uuid references public.sender_recipients on delete set null, created_at timestamptz not null default now());
    create table public.sender_reply_qualifications(reply_id uuid primary key references public.sender_replies on delete cascade,
      recipient_id uuid not null references public.sender_recipients on delete cascade,
      campaign_id uuid not null references public.sender_campaigns on delete cascade,
      status text not null, qualified_at timestamptz);
    create table public.sender_manual_messages(id uuid primary key default gen_random_uuid(),
      recipient_id uuid references public.sender_recipients on delete cascade, status text not null, error text,
      cc_emails text[], handoff jsonb, created_at timestamptz not null default now());
  `);
  await db.exec(migration('20261026_0010_sender_project_lead_cards.sql'));
  const leadSettings = await rows('select enabled, enabled_at from public.sender_project_lead_settings');
  check(leadSettings.length === 1 && leadSettings[0].enabled === true, 'lead cards switch is seeded once, on', JSON.stringify(leadSettings));
  const privileges = await one(`select
      has_table_privilege('authenticated', 'public.sender_project_lead_cards', 'select') as auth_cards,
      has_table_privilege('anon', 'public.sender_project_lead_settings', 'select') as anon_settings,
      has_table_privilege('service_role', 'public.sender_project_lead_cards', 'update') as service_cards,
      has_function_privilege('authenticated', 'public.sender_project_lead_candidates(integer)', 'execute') as auth_candidates,
      has_function_privilege('service_role', 'public.sender_project_lead_card_events(integer)', 'execute') as service_events`);
  check(!privileges.auth_cards && !privileges.anon_settings && privileges.service_cards && !privileges.auth_candidates && privileges.service_events,
    'cards, switch and functions are service_role only', JSON.stringify(privileges));

  const VE2_CAMPAIGN = (await one(`insert into public.sender_campaigns(name, project_id, source_kind) values ('ve2', $1, 've2') returning id`, [STAFF])).id;
  const MANUAL_CAMPAIGN = (await one(`insert into public.sender_campaigns(name, project_id, source_kind) values ('manual', $1, 'manual') returning id`, [STAFF])).id;
  const lead = async (campaign, verdict, qualifiedAt, source = null) => {
    const recipient = (await one(`insert into public.sender_recipients(campaign_id, email, lead_verdict, lead_verdict_source)
      values ($1, 'x@y.ru', $2, $3) returning id`, [campaign, verdict, source])).id;
    const reply = (await one('insert into public.sender_replies(recipient_id) values ($1) returning id', [recipient])).id;
    await rows(`insert into public.sender_reply_qualifications values ($1, $2, $3, 'lead', $4)`, [reply, recipient, campaign, qualifiedAt]);
    return { recipient, reply };
  };
  const leadReply = async (recipient) => {
    const reply = (await one('insert into public.sender_replies(recipient_id) values ($1) returning id', [recipient])).id;
    await rows(`insert into public.sender_reply_qualifications values ($1, $2, $3, 'lead', now())`, [reply, recipient, VE2_CAMPAIGN]);
    return reply;
  };
  const candidates = async () => rows('select reply_id, recipient_id, has_card, card_status from public.sender_project_lead_candidates(10)');
  const fresh = await lead(VE2_CAMPAIGN, 'lead', 'now()');
  await lead(VE2_CAMPAIGN, 'lead', '2000-01-01T00:00:00Z');
  const aiNotLead = await lead(VE2_CAMPAIGN, 'not_lead', 'now()', 'ai');
  await lead(VE2_CAMPAIGN, 'not_lead', 'now()', 'manual');
  await lead(MANUAL_CAMPAIGN, 'lead', 'now()');
  let found = await candidates();
  check(found.length === 2 && found.some((row) => row.reply_id === fresh.reply) && found.some((row) => row.reply_id === aiNotLead.reply)
    && found.every((row) => row.has_card === false && row.card_status === null),
    'candidates: ve2 leads after the cutoff; only a manual «Не лид» drops the thread, not a later AI one', JSON.stringify(found));
  await rows('delete from public.sender_reply_qualifications where reply_id = $1', [aiNotLead.reply]);

  await rows(`insert into public.sender_project_lead_cards(recipient_id, reply_id, campaign_id, project_id, merged_reply_ids)
    values ($1, $2, $3, $4, array[$2]::uuid[])`, [fresh.recipient, fresh.reply, VE2_CAMPAIGN, STAFF]);
  const second = await leadReply(fresh.recipient);
  check((await candidates()).length === 0, 'a later lead reply waits until the card has its board row');
  await rows(`update public.sender_project_lead_cards set status = 'card_sent', board_written_at = now() where recipient_id = $1`, [fresh.recipient]);
  found = await candidates();
  check(found.length === 1 && found[0].reply_id === second && found[0].has_card === true && found[0].card_status === 'card_sent',
    'then it is merged into the same card', JSON.stringify(found));
  await rows(`update public.sender_project_lead_cards set merged_reply_ids = merged_reply_ids || $2::uuid where recipient_id = $1`, [fresh.recipient, second]);
  check((await candidates()).length === 0, 'a merged reply is not returned again');
  await rows(`update public.sender_project_lead_cards set status = 'undelivered' where recipient_id = $1`, [fresh.recipient]);
  const third = await leadReply(fresh.recipient);
  found = await candidates();
  check(found.length === 1 && found[0].reply_id === third && found[0].card_status === 'undelivered',
    'a card never delivered is reopened by a later lead reply', JSON.stringify(found));
  await rows(`update public.sender_project_lead_cards set status = 'card_sent', merged_reply_ids = merged_reply_ids || $2::uuid
    where recipient_id = $1`, [fresh.recipient, third]);
  await expectError('card status is checked', `update public.sender_project_lead_cards set status = 'unknown' where recipient_id = $1`, [fresh.recipient], /check/);

  const before = (await one('select enabled_at from public.sender_project_lead_settings')).enabled_at;
  const late = await lead(VE2_CAMPAIGN, 'lead', 'now()');
  await rows('update public.sender_project_lead_settings set enabled = false');
  check((await candidates()).length === 0, 'switched off: no candidates');
  await rows(`update public.sender_project_lead_settings set enabled = true`);
  const after = (await one('select enabled_at from public.sender_project_lead_settings')).enabled_at;
  found = await candidates();
  check(new Date(after) >= new Date(before) && !found.some((row) => row.reply_id === late.reply),
    'switching back on moves the cutoff: leads qualified while off get no card', JSON.stringify({ before, after, found }));

  const events = async () => rows('select recipient_id, kind, status, handoff_status from public.sender_project_lead_card_events(50)');
  const kinds = async () => (await events()).map((row) => `${row.kind}:${row.status}`).join(',');
  const card = (set) => rows(`update public.sender_project_lead_cards set ${set} where recipient_id = $1`, [fresh.recipient]);
  const handoff = async (status, createdAt = 'now()') => (await one(`insert into public.sender_manual_messages(recipient_id, status, handoff, created_at)
    values ($1, $2, '{}', $3) returning id`, [fresh.recipient, status, createdAt])).id;
  await card(`tg_message_id = 7, tg_rendered_status = 'card_sent'`);
  check((await events()).length === 0, 'no events for a delivered card without news');
  await handoff('sent');
  check(await kinds() === 'sent:card_sent', 'a sent handoff closes the card', await kinds());
  await card(`status = 'pending'`);
  check(await kinds() === 'publish:pending', 'sent while the card is undelivered: only publish the board row', await kinds());
  await card(`board_published_at = now()`);
  check(await kinds() === '', 'once published, an undelivered card is left to delivery', await kinds());

  await rows('delete from public.sender_manual_messages where recipient_id = $1', [fresh.recipient]);
  await card(`status = 'queued', tg_rendered_status = 'queued', decided_at = now(), board_published_at = null`);
  await handoff('failed', new Date(Date.now() - 3600_000).toISOString());
  check(await kinds() === '', 'a handoff that failed before the decision is not this card’s', await kinds());
  const own = await handoff('failed');
  await card(`manual_message_id = '${own}'`);
  check(await kinds() === 'failed:queued', 'the card’s own handoff failed', await kinds());
  await rows('delete from public.sender_manual_messages where recipient_id = $1', [fresh.recipient]);
  check(await kinds() === '', 'queued without a letter is not stuck yet', await kinds());
  await card(`updated_at = now() - interval '11 minutes'`);
  check(await kinds() === 'stuck:queued', 'queued without a letter for 10 minutes is stuck', await kinds());

  await card(`status = 'card_sent', tg_rendered_status = 'card_sent', decided_at = null, updated_at = now(),
    handoff_mode = 'auto', blocked_reason = 'Ящик переписки недоступен', next_attempt_at = now() + interval '15 minutes'`);
  check(await kinds() === '', 'a deferred auto handoff waits for its time', await kinds());
  await card(`next_attempt_at = now() - interval '1 minute'`);
  check(await kinds() === 'auto_retry:card_sent', 'then it is retried', await kinds());
  await card(`created_at = now() - interval '8 days'`);
  check(await kinds() === 'auto_retry:card_sent', 'past 7 days the worker gets one more event to give up on the card', await kinds());
  await card(`created_at = now() - interval '1 hour'`);
  await handoff('failed', new Date(Date.now() - 2 * 3600_000).toISOString());
  check(await kinds() === 'auto_retry:card_sent', 'a handoff that failed before the card does not stop the retry', await kinds());
  await handoff('failed');
  check(await kinds() === 'failed:card_sent', 'a handoff from «Письма» that failed while auto waited is shown, not re-sent', await kinds());
  await card(`status = 'queued', tg_rendered_status = 'queued', manual_message_id = null`);
  check(await kinds() === 'failed:queued', 'an auto card queued by itself sees a later handoff from «Письма» fail', await kinds());
  await rows('delete from public.sender_manual_messages where recipient_id = $1', [fresh.recipient]);
  await card(`status = 'card_sent', tg_rendered_status = 'card_sent', handoff_mode = 'manual', blocked_reason = null, next_attempt_at = null, created_at = now()`);

  await rows(`update public.sender_recipients set lead_verdict = 'not_lead', lead_verdict_source = 'ai' where id = $1`, [fresh.recipient]);
  check(await kinds() === '', 'an AI «не лид» does not close the card', await kinds());
  await rows(`update public.sender_recipients set lead_verdict_source = 'manual' where id = $1`, [fresh.recipient]);
  check(await kinds() === 'not_lead:card_sent', 'a manual «Не лид» in the sender closes the card', await kinds());
  await card(`status = 'undelivered', tg_rendered_status = null`);
  check(await kinds() === 'not_lead:undelivered', '…and hides the row of a card never delivered', await kinds());
  await card(`status = 'handoff_failed'`);
  check(await kinds() === 'not_lead:handoff_failed', '…or of a card whose handoff failed', await kinds());
  await card(`status = 'rejected', tg_rendered_status = 'card_sent', updated_at = now()`);
  check(await kinds() === '', 'a fresh status change is left to the press that made it', await kinds());
  await card(`updated_at = now() - interval '3 minutes'`);
  check(await kinds() === 'render:rejected', 'a card whose text lags its status is redrawn', await kinds());

  // ── Выключатели (этап 6) ──
  await db.exec(`
    alter table public.sender_campaigns add column if not exists status text not null default 'draft',
      add column if not exists updated_at timestamptz not null default now(),
      add column if not exists started_at timestamptz,
      add column if not exists scheduled_start_at timestamptz,
      add column if not exists scheduled_start_error text;
    alter table public.sender_recipients add column if not exists status text not null default 'active';
  `);
  const killSwitches = `begin; ${migration('20261026_0020_ve_sender_kill_switches.sql')} commit;`;
  await db.exec(killSwitches);
  const sendingFlag = async () => (await one('select sending_enabled from public.ve_sender_global_settings')).sending_enabled;
  check(await sendingFlag() === true, 'sending switch is seeded on');
  await rows('update public.ve_sender_global_settings set sending_enabled = false');
  await db.exec(killSwitches);
  check(await sendingFlag() === false, 're-applying the migration does not turn sending back on');
  await rows('update public.ve_sender_global_settings set sending_enabled = true');
  const columns6 = await rows(`select table_name, column_name from information_schema.columns
    where (table_name = 've_launch_transport_settings' and column_name = 'mode_before_stop')
       or (table_name = 'sender_project_lead_settings' and column_name in ('disabled_at', 'updated_by', 'note'))`);
  check(columns6.length === 4, 'stage 6 adds mode_before_stop and lead card who/when columns', JSON.stringify(columns6));
  await expectError('mode_before_stop accepts only pilot/sender', `update public.ve_launch_transport_settings set mode_before_stop = 'instantly'`, [], /check/);
  const privileges6 = await one(`select
      has_function_privilege('authenticated', 'public.ve_sender_pause_running(text)', 'execute') as auth_pause,
      has_function_privilege('authenticated', 'public.ve_sender_resume_finish(uuid,text,uuid,text)', 'execute') as auth_finish,
      has_function_privilege('anon', 'public.ve_sender_resume_claim(uuid)', 'execute') as anon_claim,
      has_function_privilege('service_role', 'public.ve_sender_pause_running(text)', 'execute') as service_pause,
      has_table_privilege('authenticated', 'public.ve_sender_global_settings', 'select') as auth_settings,
      has_table_privilege('authenticated', 'public.ve_sender_sending_pauses', 'select') as auth_pauses,
      has_table_privilege('service_role', 'public.ve_sender_sending_pauses', 'update') as service_pauses`);
  check(!privileges6.auth_pause && !privileges6.auth_finish && !privileges6.anon_claim && privileges6.service_pause
    && !privileges6.auth_settings && !privileges6.auth_pauses && privileges6.service_pauses,
    'kill switch tables and functions are service_role only', JSON.stringify(privileges6));

  const campaign6 = async (name, kind, status, extra = {}) => (await one(`insert into public.sender_campaigns
      (name, source_kind, status, scheduled_start_at, scheduled_start_error, updated_at)
    values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now())) returning id`,
    [name, kind, status, extra.at ?? null, extra.error ?? null, extra.updatedAt ?? null])).id;
  const recipient6 = async (campaign, status = 'active') => (await one(
    `insert into public.sender_recipients(campaign_id, email, status) values ($1, 'r@x.ru', $2) returning id`, [campaign, status])).id;
  const message6 = async (campaign, recipient, status) => rows(
    `insert into public.sender_messages(campaign_id, recipient_id, step_no, status) values ($1, $2, 1, $3)`, [campaign, recipient, status]);
  const statusOf = async (id) => (await one('select status, scheduled_start_at, scheduled_start_error from public.sender_campaigns where id = $1', [id]));

  const draft6 = await campaign6('ve2 draft', 've2', 'draft');
  await rows(`update public.sender_campaigns set status = 'running' where id = $1`, [draft6]);
  check((await statusOf(draft6)).status === 'running', 'a ve2 campaign starts while sending is on');
  await rows(`update public.sender_campaigns set status = 'paused' where id = $1`, [draft6]);
  await rows('update public.ve_sender_global_settings set sending_enabled = false');
  await expectError('while sending is stopped a ve2 campaign cannot start', `update public.sender_campaigns set status = 'running' where id = $1`, [draft6], /VE2_SENDING_STOPPED/);
  await expectError('…nor be inserted running', `insert into public.sender_campaigns(name, source_kind, status) values ('x', 've2', 'running')`, [], /VE2_SENDING_STOPPED/);
  const manual6 = await campaign6('folder', 'manual', 'draft');
  await rows(`update public.sender_campaigns set status = 'running' where id = $1`, [manual6]);
  check((await statusOf(manual6)).status === 'running', 'folder and manual campaigns start while ve2 sending is stopped');
  await rows('delete from public.ve_sender_global_settings');
  await rows(`update public.sender_campaigns set status = 'running' where id = $1`, [draft6]);
  check((await statusOf(draft6)).status === 'running', 'no switch row means sending is on');
  await rows(`insert into public.ve_sender_global_settings (id, sending_enabled) values (true, true)`);

  // Пауза: только идущие ve2, письма в очереди — отменить, «в отправке» — не трогать, назначенные — снять.
  const runningA = draft6;
  const recipientA = await recipient6(runningA);
  await message6(runningA, recipientA, 'scheduled');
  await message6(runningA, recipientA, 'sending');
  const runningB = await campaign6('ve2 B', 've2', 'running');
  const recipientB = await recipient6(runningB);
  await message6(runningB, recipientB, 'scheduled');
  const later6 = new Date(Date.now() + 86_400_000).toISOString();
  const draftC = await campaign6('ve2 C', 've2', 'draft', { at: later6 });
  const pausedD = await campaign6('ve2 D', 've2', 'paused', { error: 'запускается', updatedAt: '2020-01-01T00:00:00Z' });
  const recipientM = await recipient6(manual6);
  await message6(manual6, recipientM, 'scheduled');
  await rows('update public.ve_sender_global_settings set sending_enabled = false');
  const stop = (await one(`select public.ve_sender_pause_running('smoke') as r`)).r;
  const messageStatuses = await rows(`select c.name, m.status from public.sender_messages m join public.sender_campaigns c on c.id = m.campaign_id
    where c.id = any($1::uuid[]) order by c.name, m.status`, [[runningA, runningB, manual6]]);
  check(stop.paused === 2 && stop.unscheduled === 2 && stop.canceled_messages === 2 && stop.still_running === 0
    && (await statusOf(runningA)).status === 'paused' && (await statusOf(runningB)).status === 'paused'
    && (await statusOf(manual6)).status === 'running',
    'the stop pauses only running ve2 campaigns', JSON.stringify(stop));
  check(JSON.stringify(messageStatuses.map((m) => `${m.name}:${m.status}`)) === JSON.stringify(['folder:scheduled', 've2 B:canceled', 've2 draft:canceled', 've2 draft:sending']),
    '…cancels their queued letters, keeps letters already in sending and other campaigns', JSON.stringify(messageStatuses));
  const cAfter = await statusOf(draftC);
  const dAfter = await statusOf(pausedD);
  const pauseRows = await rows(`select campaign_id, action, prior_status, prior_scheduled_start_at, prior_scheduled_start_error
    from public.ve_sender_sending_pauses order by action, prior_status`);
  check(cAfter.scheduled_start_at === null && dAfter.scheduled_start_error === null && pauseRows.length === 4
    && new Date(pauseRows.find((r) => r.campaign_id === pausedD).prior_scheduled_start_at).toISOString() === '2020-01-01T00:00:00.000Z'
    && new Date(pauseRows.find((r) => r.campaign_id === draftC).prior_scheduled_start_at).toISOString() === later6,
    '…clears scheduled starts and «запускается» marks, remembering them', JSON.stringify(pauseRows));
  const again = (await one(`select public.ve_sender_pause_running('smoke') as r`)).r;
  check(again.paused === 0 && again.unscheduled === 0, 'a second stop finds nothing more to pause', JSON.stringify(again));

  // Продолжение: занять строку, без людей — только нетронутые.
  const pauseOf = async (campaign, action) => (await one(
    'select id from public.ve_sender_sending_pauses where campaign_id = $1 and action = $2', [campaign, action])).id;
  const pauseA = await pauseOf(runningA, 'paused');
  const claimA = (await one('select public.ve_sender_resume_claim($1) as r', [pauseA])).r;
  const claimAgain = (await one('select public.ve_sender_resume_claim($1) as r', [pauseA])).r;
  check(claimA.claimed && claimA.untouched && claimA.action === 'paused' && claimA.active_recipients === 1 && claimAgain.claimed === false,
    'a pause row is claimed by one resume at a time and reports the campaign untouched', JSON.stringify({ claimA, claimAgain }));
  await rows('update public.ve_sender_global_settings set sending_enabled = true');
  check((await one(`select public.ve_sender_resume_finish($1, 'raw_running', null, 'x') as r`, [pauseA])).r === 'skip',
    'the direct «идёт» is refused while the campaign has active recipients');
  await rows(`update public.sender_recipients set status = 'replied' where campaign_id = $1`, [runningA]);
  check((await one(`select public.ve_sender_resume_finish($1, 'raw_running', null, 'идёт') as r`, [pauseA])).r === 'done'
    && (await statusOf(runningA)).status === 'running'
    && (await one('select resumed_at is not null as closed from public.ve_sender_sending_pauses where id = $1', [pauseA])).closed,
    '…and done, closing the row, when there is nobody to queue');
  const pauseB = await pauseOf(runningB, 'paused');
  await rows(`update public.sender_campaigns set updated_at = now() + interval '1 second' where id = $1`, [runningB]);
  await rows('update public.ve_sender_sending_pauses set resume_claimed_until = null where id = $1', [pauseB]);
  check((await one('select public.ve_sender_resume_claim($1) as r', [pauseB])).r.untouched === false,
    'a campaign touched after the stop is reported as touched');
  check((await one(`select public.ve_sender_resume_finish($1, 'close', null, 'оставлена на паузе') as r`, [pauseB])).r === 'done'
    && (await one(`select public.ve_sender_resume_finish($1, 'close', null, 'again') as r`, [pauseB])).r === 'skip',
    'closing a row works once');
  const pauseC = await pauseOf(draftC, 'unscheduled');
  const pauseD = await pauseOf(pausedD, 'unscheduled');
  check((await one(`select public.ve_sender_resume_finish($1, 'restore_schedule', null, 'ok') as r`, [pauseC])).r === 'done'
    && new Date((await statusOf(draftC)).scheduled_start_at).toISOString() === later6,
    'a future scheduled start comes back as it was');
  const restoredD = (await one(`select public.ve_sender_resume_finish($1, 'restore_schedule', null, 'ok') as r`, [pauseD])).r;
  const restoredAt = new Date((await statusOf(pausedD)).scheduled_start_at).getTime();
  check(restoredD === 'done' && Math.abs(restoredAt - Date.now()) < 60_000, 'a past or interrupted start comes back as «now»', String(restoredAt));
  // Выключатели, переключённые не панелью (psql): «когда» — сейчас, «кто» — неизвестно.
  await rows(`update public.ve_sender_global_settings set sending_changed_at = '2020-01-01T00:00:00Z', sending_changed_by = $1`, [USER]);
  await rows('update public.ve_sender_global_settings set sending_enabled = false');
  const psqlStop = await one('select sending_changed_at, sending_changed_by from public.ve_sender_global_settings');
  check(new Date(psqlStop.sending_changed_at) > new Date('2026-01-01') && psqlStop.sending_changed_by === null,
    'a psql stop records its own time and an unknown author', JSON.stringify(psqlStop));
  await rows(`update public.ve_sender_global_settings set sending_enabled = true, sending_changed_at = '2026-10-26T12:00:00Z', sending_changed_by = $1`, [USER]);
  const panelResume = await one('select sending_changed_at, sending_changed_by from public.ve_sender_global_settings');
  check(new Date(panelResume.sending_changed_at).toISOString() === '2026-10-26T12:00:00.000Z' && panelResume.sending_changed_by === USER,
    'a panel write keeps its own who and when', JSON.stringify(panelResume));
  await rows(`update public.sender_project_lead_settings set enabled = true, disabled_at = '2020-01-01T00:00:00Z', updated_by = $1`, [USER]);
  await rows('update public.sender_project_lead_settings set enabled = false');
  const psqlCards = await one('select disabled_at, updated_by from public.sender_project_lead_settings');
  check(new Date(psqlCards.disabled_at) > new Date('2026-01-01') && psqlCards.updated_by === null,
    'lead cards switched off by psql record the moment', JSON.stringify(psqlCards));
  await rows('update public.sender_project_lead_settings set enabled = true');
  await rows(`update public.ve_launch_transport_settings set updated_at = '2020-01-01T00:00:00Z', updated_by = $1 where market = 'ru'`, [USER]);
  await rows(`update public.ve_launch_transport_settings set sender_uploads_enabled = false where market = 'ru'`);
  const psqlUploads = await one(`select updated_at, updated_by from public.ve_launch_transport_settings where market = 'ru'`);
  check(new Date(psqlUploads.updated_at) > new Date('2026-01-01') && psqlUploads.updated_by === null,
    'uploads switched off by psql record the moment', JSON.stringify(psqlUploads));
  await rows(`update public.ve_launch_transport_settings set sender_uploads_enabled = true where market = 'ru'`);
  await expectError('unknown resume mode is refused', `select public.ve_sender_resume_finish($1, 'other', null, 'x')`, [pauseD], /unknown resume mode/);

  // ── Выбор специалиста при запуске (этап 7) ──
  const choiceMigration = `begin; ${migration('20261026_0040_ve_launch_transport_choice.sql')} commit;`;
  await db.exec(choiceMigration);
  await db.exec(choiceMigration);
  const marketsAfter = await rows('select market, mode, mode_before_stop from public.ve_launch_transport_settings order by market');
  check(marketsAfter.every((row) => row.mode === 'instantly' && row.mode_before_stop === null),
    'the choice migration changes no market (applied twice)', JSON.stringify(marketsAfter));
  await rows(`update public.ve_launch_transport_settings set mode = 'choice' where market = 'ru'`);
  await rows(`update public.ve_launch_transport_settings set mode = 'instantly', mode_before_stop = 'choice' where market = 'ru'`);
  check((await one(`select mode_before_stop from public.ve_launch_transport_settings where market = 'ru'`)).mode_before_stop === 'choice',
    'ru accepts the choice mode and remembers it before «только Instantly»');
  await rows(`update public.ve_launch_transport_settings set mode = 'instantly', mode_before_stop = null where market = 'ru'`);
  await expectError('US cannot get the choice', `update public.ve_launch_transport_settings set mode = 'choice' where market = 'us'`, [], /us_instantly/);
  await expectError('US cannot remember a sender mode', `update public.ve_launch_transport_settings set mode_before_stop = 'choice' where market = 'us'`, [], /us_instantly/);
  await expectError('unknown modes stay refused', `update public.ve_launch_transport_settings set mode = 'other' where market = 'ru'`, [], /mode_check/);
} finally {
  await db.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
