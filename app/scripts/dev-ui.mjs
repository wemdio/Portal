// UI-only dev server: sets UI_ONLY=1 so next.config.ts skips loading ../.env.
// With no Supabase env, middleware disables auth (pages render without login)
// and data fetches hit the dead fallback URL → empty/error states. Pure UI/
// theme review, zero backend. Cross-platform (no cross-env dependency).
import { spawn } from 'node:child_process';

const child = spawn('npx', ['next', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, UI_ONLY: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
