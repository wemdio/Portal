import fs from 'node:fs';
import { createRunner } from '@/lib/enrich/engBrowser/runner';

async function main() {
  const socket = process.env.ENG_BROWSER_RUNNER_SOCKET ?? '/sockets/runner.sock';
  try { fs.unlinkSync(socket); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const startupDeadline = setTimeout(() => process.exit(1), 20_000);
  const runner = await createRunner(process.env.ENG_BROWSER_BROKER_SOCKET ?? '/sockets/broker.sock');
  clearTimeout(startupDeadline);
  runner.server.listen(socket, () => fs.chmodSync(socket, 0o600));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { runner.server.close(); void runner.close(); });
}
void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message.slice(0, 1000) : 'unknown failure';
  console.error(`ENG browser runner failed isolation or browser initialization: ${reason}`);
  process.exit(1);
});
