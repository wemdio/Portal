/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260730_0001_harden_team_data_acl.sql',
);

const sql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

const INTERNAL_ROLE_PREDICATE =
  "actor.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')";

describe('team data ACL hardening migration', () => {
  it('removes broad profile writes and restores only the approved self-service columns', () => {
    expect(sql).toContain('revoke all privileges on table public.profiles from anon');
    expect(sql).toContain('revoke all privileges on table public.profiles from authenticated');
    expect(sql).toContain('grant select on table public.profiles to authenticated');
    expect(sql).toContain(
      'grant update ( full_name, avatar_url, email, default_board_id, locale, task_deadline_default_enabled, task_deadline_default_mode, task_deadline_default_at, task_deadline_default_time ) on table public.profiles to authenticated',
    );
    expect(sql).not.toMatch(/grant update \([^)]*\b(role|is_demo)\b[^)]*\) on table public\.profiles to authenticated/);
    expect(sql).not.toContain('grant all on table public.profiles to authenticated');
    expect(sql).not.toContain('grant all on table public.profiles to anon');
  });

  it('never trusts public auth metadata or an internal default role for new profiles', () => {
    expect(sql).toContain("alter table public.profiles alter column role set default 'client'");
    expect(sql).toContain('create or replace function public.handle_new_user()');
    expect(sql).toContain("'client'");
    expect(sql).not.toContain("new.raw_user_meta_data->>'role'");
  });

  it('blocks JWT callers from changing role or demo state while preserving trusted server writes', () => {
    expect(sql).toContain('create or replace function public.prevent_profile_privilege_escalation');
    expect(sql).toContain("auth.role() in ('anon', 'authenticated')");
    expect(sql).toContain('new.role is distinct from old.role');
    expect(sql).toContain('new.is_demo is distinct from old.is_demo');
    expect(sql).toContain('create trigger prevent_profile_privilege_escalation');
    expect(sql).toContain('before update on public.profiles');
    const triggerFunction = sql.match(
      /create or replace function public\.prevent_profile_privilege_escalation\(\).*?\$\$;/,
    )?.[0] ?? '';
    expect(triggerFunction).toContain('return new; end; $$;');
  });

  it('uses one exact non-demo role matrix for every project mutation', () => {
    expect(sql).toContain('create or replace function public.can_mutate_team_data(operation text)');
    expect(sql).toContain(INTERNAL_ROLE_PREDICATE);
    expect(sql).toContain(
      "when operation = 'project_insert' then actor.role in ('admin', 'manager', 'technician', 'director', 'lead')",
    );
    expect(sql).toContain(
      "when operation = 'project_delete' then actor.role in ('admin', 'manager', 'director', 'lead')",
    );
    expect(sql).toContain("when operation in ('project_update', 'project_period') then");
    expect(sql).toContain('coalesce(actor.is_demo, false) = false');
    expect(sql).not.toContain("actor.role <> 'client'");
  });

  it.each(['projects', 'project_periods'])(
    'allows %s mutations only through the internal-user RLS guard',
    (table) => {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all privileges on table public.${table} from anon`);
      expect(sql).toContain(`revoke all privileges on table public.${table} from authenticated`);
      expect(sql).toContain(`grant select, insert, update, delete on table public.${table} to authenticated`);
      expect(sql).toContain(`grant all on table public.${table} to service_role`);

      expect(sql).toContain(`create policy ${table}_insert_internal on public.${table}`);
      expect(sql).toContain(`create policy ${table}_update_internal on public.${table}`);
      expect(sql).toContain(`create policy ${table}_delete_internal on public.${table}`);
      expect(sql).toContain('public.can_mutate_team_data(');
    },
  );

  it('binds each RLS operation to the matching application permission', () => {
    expect(sql).toContain("with check (public.can_mutate_team_data('project_insert'))");
    expect(sql).toContain("using (public.can_mutate_team_data('project_update'))");
    expect(sql).toContain("using (public.can_mutate_team_data('project_delete'))");
    expect(sql).toContain("with check (public.can_mutate_team_data('project_period'))");
    expect(sql).toContain("using (public.can_mutate_team_data('project_period'))");
  });
  it('preserves the legacy authenticated project read surface', () => {
    expect(sql).toContain('drop policy if exists projects_select_authenticated on public.projects');
    expect(sql).toContain('create policy projects_select_authenticated on public.projects');
    expect(sql).toContain('for select to authenticated using (true)');
  });

  it('removes the legacy allow-all mutation policies', () => {
    expect(sql).toContain('drop policy if exists "projects_all" on public.projects');
    expect(sql).toContain('drop policy if exists "enable insert for all users" on public.projects');
    expect(sql).toContain('drop policy if exists "enable update for all users" on public.projects');
    expect(sql).toContain(
      'drop policy if exists project_periods_all_authenticated on public.project_periods',
    );
  });
});
