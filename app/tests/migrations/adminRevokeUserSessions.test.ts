/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260923192416_admin_revoke_user_sessions.sql',
);

const sql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

describe('admin session revocation migration', () => {
  it('deletes every auth session for exactly the requested user', () => {
    expect(sql).toContain('delete from auth.sessions where user_id = target_user_id');
  });

  it('is security-definer with an empty search path', () => {
    expect(sql).toContain('security definer');
    expect(sql).toContain("set search_path = ''");
  });

  it('is callable only by service_role', () => {
    expect(sql).toContain('revoke all on function public.admin_revoke_user_sessions(uuid) from public');
    expect(sql).toContain('revoke all on function public.admin_revoke_user_sessions(uuid) from anon');
    expect(sql).toContain('revoke all on function public.admin_revoke_user_sessions(uuid) from authenticated');
    expect(sql).toContain('grant execute on function public.admin_revoke_user_sessions(uuid) to service_role');
  });
});
