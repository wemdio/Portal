import 'server-only';
import fs from 'fs/promises';
import path from 'path';

export async function resolveEnvPath(): Promise<string> {
  const candidates = [
    process.env.ENV_FILE_PATH,
    path.resolve(process.cwd(), 'host.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch { /* try next */ }
  }
  throw new Error(`.env not found. Tried: ${candidates.join(', ')}. cwd=${process.cwd()}`);
}
