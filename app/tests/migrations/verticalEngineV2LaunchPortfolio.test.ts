/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Vertical Engine v2 launch portfolio migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../supabase/migrations');
  const migrationName = fs
    .readdirSync(migrationsDir)
    .find((name) => name.includes('vertical_engine_v2_launch_portfolio'));

  function sql(): string {
    expect(migrationName).toBeDefined();
    return fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
  }

  it('creates only v2-owned portfolio settings, bundle queue and campaign snapshots', () => {
    const text = sql();

    for (const table of [
      've_launch_portfolio_settings',
      've_launch_queue_items',
      've_launch_queue_campaigns',
    ]) {
      expect(text).toMatch(new RegExp(`create table if not exists public\\.${table}`, 'i'));
      expect(text).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    }

    for (const column of [
      'project_id',
      'vertical_id',
      'hypothesis_id',
      'base_id',
      'template_id',
      'segmentation_audit_id',
      'instantly_account_id',
      'mailbox_ids',
      'manual_order',
      'latest_activation_at',
      'seasonality_input_hash',
      'priority_snapshot',
      'plan_version',
      'activation_reservation_id',
      'ever_active_at',
      'released_at',
      'release_reason',
    ]) {
      expect(text).toMatch(new RegExp(`\\b${column}\\b`, 'i'));
    }

    for (const status of [
      'prepared',
      'queued',
      'activating',
      'active',
      'uncertain',
      'released',
      'skipped',
      'cancelled',
    ]) {
      expect(text).toContain(`'${status}'`);
    }
    expect(text).not.toContain('activation_uncertain');
    expect(text).not.toMatch(/\bhe_/i);
  });

  it('keeps the readonly grant DO block valid PL/pgSQL', () => {
    const text = sql();
    const readonlyGrantBlock = text.match(
      /do\s+\$\$([\s\S]*?rolname\s*=\s*'readonly'[\s\S]*?)\$\$;/i,
    )?.[1];

    expect(readonlyGrantBlock).toBeDefined();
    expect(readonlyGrantBlock).toMatch(/\bend;\s*$/i);
  });

  it('models one bundle with many campaigns and snapshots its immutable workspace scope', () => {
    const text = sql();

    expect(text).toMatch(/mailbox_ids\s+text\[\][\s\S]+check[\s\S]+cardinality\s*\(\s*mailbox_ids\s*\)\s*>\s*0/i);
    expect(text).toMatch(
      /create table if not exists public\.ve_launch_queue_campaigns[\s\S]+item_id[\s\S]+references public\.ve_launch_queue_items\s*\(\s*id\s*\)/i,
    );
    expect(text).toMatch(/campaign_id\s+text\s+not null/i);
    expect(text).toMatch(/remote_status\s+integer/i);
    expect(text).toMatch(/status_observed_at\s+timestamptz/i);
    expect(text).toMatch(
      /campaign_id\s+text\s+not null\s+unique|unique\s*\(\s*campaign_id\s*\)|unique index[\s\S]+campaign_id/i,
    );
  });

  it('refuses to cascade-delete every launch ledger that owns a tracked remote campaign', () => {
    const text = sql();

    expect(text).toMatch(/create or replace function public\.ve_guard_launch_queue_item_delete/i);
    expect(text).toMatch(
      /ve_guard_launch_queue_item_delete[\s\S]+old\.status\s+in\s*\(\s*'prepared'\s*,\s*'queued'\s*,\s*'activating'\s*,\s*'active'\s*,\s*'uncertain'\s*\)[\s\S]+raise exception/i,
    );
    expect(text).toMatch(
      /create trigger ve_launch_queue_items_guard_delete[\s\S]+before delete[\s\S]+execute function public\.ve_guard_launch_queue_item_delete/i,
    );
    expect(text).toMatch(
      /if\s+exists\s*\([\s\S]+ve_launch_queue_campaigns[\s\S]+c\.item_id\s*=\s*old\.id[\s\S]+raise exception/i,
    );
    const guard = text.match(
      /create or replace function public\.ve_guard_launch_queue_item_delete[\s\S]+?\$\$;/i,
    )?.[0];
    expect(guard).not.toMatch(/remote_status/i);
  });

  it('enforces RU portfolio timing while leaving the US rollout advisory', () => {
    const text = sql();

    expect(text).toMatch(
      /insert into public\.ve_launch_portfolio_settings\s*\(\s*id\s*,\s*market\s*,\s*timezone\s*,\s*mode\s*\)[\s\S]+\(\s*'ru'\s*,\s*'ru'\s*,\s*'Europe\/Moscow'\s*,\s*'enforced'\s*\)[\s\S]+\(\s*'us'\s*,\s*'us'\s*,\s*'UTC'\s*,\s*'advisory'\s*\)/i,
    );
  });

  it('atomically reserves capacity by overlapping mailbox sets in one workspace', () => {
    const text = sql();

    expect(text).toMatch(/create or replace function public\.ve_reserve_launch_activation/i);
    expect(text).toMatch(/ve_reserve_launch_activation[\s\S]+pg_advisory_xact_lock/i);
    expect(text).toMatch(/instantly_account_id\s*=\s*[^\n;]*instantly_account_id/i);
    expect(text).toMatch(/mailbox_ids\s*&&\s*[^\n;]*mailbox_ids/i);
    expect(text).toMatch(/status\s+in\s*\(\s*'activating'\s*,\s*'active'\s*,\s*'uncertain'\s*\)/i);
    expect(text).toMatch(/max_active_bundles/i);

    // Exact-item CAS: a stale plan or a second reservation cannot claim it.
    expect(text).toMatch(/p_expected_plan_version/i);
    expect(text).toMatch(/p_activation_reservation_id/i);
    expect(text).toMatch(
      /update public\.ve_launch_queue_items[\s\S]+status\s*=\s*'activating'[\s\S]+status\s*=\s*'queued'[\s\S]+plan_version\s*=\s*p_expected_plan_version/i,
    );
    expect(text).toMatch(
      /activation_reservation_id\s*=\s*p_activation_reservation_id/i,
    );

    // Same request is replay-safe; reservation code must recognize its own id.
    expect(text).toMatch(
      /activation_reservation_id\s*=\s*p_activation_reservation_id[\s\S]+(?:return|jsonb_build_object)/i,
    );

    // Capacity admission never evicts/relabels an existing holder.
    const reserveFunction = text.match(
      /create or replace function public\.ve_reserve_launch_activation[\s\S]+?\$\$;/i,
    )?.[0];
    expect(reserveFunction).toBeDefined();
    expect(reserveFunction).not.toMatch(/preempt|evict/i);
    expect(reserveFunction).not.toMatch(/set\s+status\s*=\s*'released'[\s\S]+id\s*<>/i);
  });

  it('enforces seasonal timing only for enforced portfolios while advisory queues stay launchable', () => {
    const text = sql();
    const reserveFunction = text.match(
      /create or replace function public\.ve_reserve_launch_activation[\s\S]+?\$\$;/i,
    )?.[0];

    expect(reserveFunction).toBeDefined();
    expect(reserveFunction).toMatch(/v_mode\s+text/i);
    expect(reserveFunction).toMatch(
      /select\s+s\.max_active_bundles\s*,\s*s\.mode[\s\S]+into\s+v_limit\s*,\s*v_mode/i,
    );
    expect(reserveFunction).toMatch(
      /if\s+v_mode\s*=\s*'enforced'[\s\S]+automatic_activation_eligible/i,
    );
    expect(reserveFunction).toMatch(
      /join\s+public\.ve_launch_portfolio_settings\s+qs\s+on\s+qs\.id\s*=\s*q\.portfolio_id/i,
    );
    expect(reserveFunction).toMatch(
      /qs\.mode\s*=\s*'advisory'[\s\S]+automatic_activation_eligible/i,
    );
    expect(reserveFunction).toMatch(
      /priority_override_decision\s*=\s*'wait'[\s\S]+VE_LAUNCH_TIMING_BLOCKED/i,
    );
    expect(reserveFunction).toMatch(
      /where\s+q\.status\s*=\s*'queued'[\s\S]+not\s*\([\s\S]+q\.priority_override_decision\s*=\s*'wait'[\s\S]+\)[\s\S]+order by/i,
    );
  });

  it('finalizes activation by exact reservation and keeps ambiguous outcomes uncertain', () => {
    const text = sql();

    expect(text).toMatch(/create or replace function public\.ve_finalize_launch_activation/i);
    expect(text).toMatch(/ve_finalize_launch_activation[\s\S]+pg_advisory_xact_lock/i);
    expect(text).toMatch(
      /ve_finalize_launch_activation[\s\S]+activation_reservation_id\s*=\s*p_activation_reservation_id/i,
    );
    expect(text).toMatch(
      /ve_finalize_launch_activation[\s\S]+status\s*=\s*'activating'/i,
    );
    expect(text).toMatch(/p_status[\s\S]+\(\s*'active'\s*,\s*'uncertain'\s*\)/i);
  });

  it('bumps the global portfolio plan across every still-admissible queue item', () => {
    const text = sql();
    const overrideFunction = text.match(
      /create or replace function public\.ve_override_launch_priority[\s\S]+?\$\$;/i,
    )?.[0];

    expect(overrideFunction).toBeDefined();
    expect(overrideFunction).toMatch(
      /update public\.ve_launch_portfolio_settings[\s\S]+plan_version\s*=\s*plan_version\s*\+\s*1/i,
    );
    expect(overrideFunction).toMatch(
      /update public\.ve_launch_queue_items[\s\S]+set[\s\S]+plan_version\s*=\s*v_plan_version[\s\S]+where[\s\S]+portfolio_id\s*=\s*v_item\.portfolio_id[\s\S]+status\s+in\s*\(\s*'prepared'\s*,\s*'queued'\s*\)/i,
    );
  });

  it('atomically refreshes RU timing snapshots with immutable-item CAS and one plan bump', () => {
    const text = sql();
    const refreshFunction = text.match(
      /create or replace function public\.ve_refresh_launch_seasonality_timing[\s\S]+?\$\$;/i,
    )?.[0];

    expect(refreshFunction).toBeDefined();
    expect(refreshFunction).toMatch(/p_portfolio_id\s+text/i);
    expect(refreshFunction).toMatch(/p_items\s+jsonb/i);
    expect(refreshFunction).toMatch(/p_now\s+timestamptz/i);
    expect(refreshFunction).toMatch(/p_portfolio_id\s*<>\s*'ru'/i);
    expect(refreshFunction).toMatch(/jsonb_array_elements\s*\(\s*p_items\s*\)/i);
    expect(refreshFunction).toMatch(/seasonality_input_hash/i);
    expect(refreshFunction).toMatch(/priority_snapshot/i);
    expect(refreshFunction).toMatch(/latest_activation_at/i);
    expect(refreshFunction).toMatch(/status\s+in\s*\(\s*'prepared'\s*,\s*'queued'\s*\)/i);
    expect(refreshFunction).toMatch(/for update/i);
    expect(refreshFunction).toMatch(
      /update public\.ve_launch_portfolio_settings[\s\S]+plan_version\s*=\s*plan_version\s*\+\s*1/i,
    );
    expect(refreshFunction?.match(/plan_version\s*=\s*plan_version\s*\+\s*1/gi)).toHaveLength(1);
    expect(refreshFunction).toMatch(
      /update public\.ve_launch_queue_items[\s\S]+plan_version\s*=\s*v_plan_version[\s\S]+status\s+in\s*\(\s*'prepared'\s*,\s*'queued'\s*\)/i,
    );

    expect(text).toMatch(
      /revoke all on function public\.ve_refresh_launch_seasonality_timing\(text, jsonb, timestamptz\) from public/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.ve_refresh_launch_seasonality_timing\(text, jsonb, timestamptz\)[\s\S]+to service_role, postgres/i,
    );
  });

  it('routes uncertain campaign recovery through the same atomic queue persistence path', () => {
    const text = sql();
    const finalizeFunction = text.match(
      /create or replace function public\.ve_finalize_template_launch[\s\S]+?\$\$;/i,
    )?.[0];
    const resolveFunction = text.match(
      /create or replace function public\.ve_resolve_template_launch[\s\S]+?\$\$;/i,
    )?.[0];

    expect(finalizeFunction).toBeDefined();
    expect(finalizeFunction).toMatch(
      /insert into public\.ve_launch_queue_campaigns\s*\([\s\S]+remote_status[\s\S]+status_observed_at/i,
    );
    expect(finalizeFunction).toMatch(/v_campaign\s*->>\s*'remote_status'/i);
    expect(finalizeFunction).toMatch(/v_campaign\s*->>\s*'status_observed_at'/i);
    expect(finalizeFunction).toMatch(/not\s*\(\s*v_campaign\s*\?\s*'remote_status'\s*\)/i);
    expect(finalizeFunction).toMatch(/jsonb_typeof[\s\S]+is distinct from\s*'number'/i);
    expect(finalizeFunction).toMatch(/v_remote_status\s+not\s+in\s*\(\s*2\s*,\s*3\s*\)/i);
    expect(finalizeFunction).toMatch(
      /ve_launch_queue_campaigns[\s\S]+remote_status\s+is\s+distinct\s+from\s+3[\s\S]+update public\.ve_launch_queue_items[\s\S]+status\s*=\s*'released'/i,
    );
    expect(resolveFunction).toBeDefined();
    expect(resolveFunction).toMatch(
      /p_resolution\s*=\s*'campaign_created'[\s\S]+launch_status\s*=\s*'running'[\s\S]+ve_finalize_template_launch\s*\(/i,
    );
    expect(resolveFunction).toMatch(/'succeeded'/i);
    expect(resolveFunction).not.toMatch(/insert into public\.ve_launch_queue_items/i);
    expect(resolveFunction).not.toMatch(/insert into public\.ve_launch_queue_campaigns/i);
    expect(text).toMatch(
      /revoke all on function public\.ve_resolve_template_launch\([^)]+\) from public/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.ve_resolve_template_launch\([^)]+\)[\s\S]+to service_role, postgres/i,
    );
  });

  it('reconciles auto-release and gates manual release on fresh non-active proof plus reason', () => {
    const text = sql();
    const reconcileFunction = text.match(
      /create or replace function public\.ve_reconcile_launch_campaign_statuses[\s\S]+?\$\$;/i,
    )?.[0];

    expect(reconcileFunction).toBeDefined();
    expect(reconcileFunction).toMatch(/pg_advisory_xact_lock/i);
    expect(reconcileFunction).toMatch(/remote_status/i);
    expect(reconcileFunction).toMatch(/status_observed_at/i);
    expect(reconcileFunction).toMatch(
      /(?:bool_and\s*\(\s*[^)]*remote_status\s*=\s*3|not exists[\s\S]+remote_status\s+is distinct from\s+3)/i,
    );
    expect(reconcileFunction).toMatch(/status\s*=\s*'released'/i);
    // Every live reconciliation must prove the exact child set. A subset can
    // never promote/release a bundle based on stale sibling rows.
    expect(reconcileFunction).toMatch(
      /cardinality\s*\(\s*v_seen_campaign_ids\s*\)\s*<>\s*v_campaign_count/i,
    );
    // Completed is terminal even for recovered rows that have no local
    // ever_active_at history; they must never be activated a second time.
    expect(reconcileFunction).toMatch(
      /if\s+v_campaign_count\s*>\s*0[\s\S]+v_all_completed[\s\S]+status\s*=\s*'released'/i,
    );
    expect(reconcileFunction).not.toMatch(
      /if\s+v_item\.ever_active_at\s+is\s+not\s+null[\s\S]+v_all_completed/i,
    );
    // Active is an all-child state. Partial active/completed/paused bundles
    // are uncertain and continue holding the slot.
    expect(reconcileFunction).toMatch(/v_all_active_or_completed\s+boolean/i);
    expect(reconcileFunction).toMatch(
      /elsif\s+coalesce\s*\(\s*v_all_active_or_completed\s*,\s*false\s*\)[\s\S]+status\s*=\s*'active'/i,
    );
    expect(reconcileFunction).toMatch(
      /elsif\s+coalesce\s*\(\s*v_any_active\s*,\s*false\s*\)[\s\S]+status\s*=\s*'uncertain'/i,
    );
    expect(reconcileFunction).toMatch(
      /elsif\s+coalesce\s*\(\s*v_all_paused\s*,\s*false\s*\)[\s\S]+v_item\.status\s+in\s*\(\s*'active'\s*,\s*'uncertain'\s*\)[\s\S]+status\s*=\s*'uncertain'/i,
    );

    expect(text).toMatch(/create or replace function public\.ve_manual_release_launch_slot/i);
    expect(text).toMatch(/ve_manual_release_launch_slot[\s\S]+pg_advisory_xact_lock/i);
    expect(text).toMatch(/btrim\s*\(\s*p_reason\s*\)/i);
    const manualReleaseFunction = text.match(
      /create or replace function public\.ve_manual_release_launch_slot[\s\S]+?\$\$;/i,
    )?.[0];
    expect(manualReleaseFunction).toMatch(/v_item\.status\s*=\s*'activating'/i);
    expect(manualReleaseFunction).toMatch(/VE_LAUNCH_ACTIVATION_IN_PROGRESS/i);
    expect(manualReleaseFunction).toMatch(
      /v_item\.status\s+not\s+in\s*\(\s*'active'\s*,\s*'uncertain'\s*\)/i,
    );
    expect(manualReleaseFunction).toMatch(
      /v_item\.status\s*=\s*'uncertain'[\s\S]+coalesce\s*\(\s*v_item\.activation_started_at\s*,\s*v_item\.updated_at\s*\)[\s\S]+interval\s+'10 minutes'/i,
    );
    expect(manualReleaseFunction).toMatch(
      /where\s+id\s*=\s*p_item_id[\s\S]+status\s+in\s*\(\s*'active'\s*,\s*'uncertain'\s*\)/i,
    );
    expect(text).toMatch(/status_observed_at/i);
    expect(text).toMatch(/remote_status\s+in\s*\(\s*1\s*,\s*4\s*\)/i);
    expect(text).toMatch(/release_reason\s*=\s*p_reason/i);

    // Service-only mutation boundary; browser roles cannot bypass capacity CAS.
    for (const fn of [
      've_reserve_launch_activation',
      've_finalize_launch_activation',
      've_reconcile_launch_campaign_statuses',
      've_manual_release_launch_slot',
    ]) {
      expect(text).toMatch(
        new RegExp(`revoke all on function public\\.${fn}[\\s\\S]+from public`, 'i'),
      );
      expect(text).toMatch(
        new RegExp(`grant execute on function public\\.${fn}[\\s\\S]+to service_role, postgres`, 'i'),
      );
    }
  });
});
