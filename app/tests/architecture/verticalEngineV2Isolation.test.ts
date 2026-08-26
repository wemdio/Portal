/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

function tsFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function source(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('Vertical Engine v2 architecture boundary', () => {
  const v2Lib = path.resolve(process.cwd(), 'src/lib/verticalEngineV2');
  const v2Api = path.resolve(process.cwd(), 'src/app/api/tools/vertical-engine-v2');
  const v2Components = path.resolve(process.cwd(), 'src/components/vertical-engine-v2');
  const v2Worker = path.resolve(process.cwd(), 'worker/verticalEngineV2.ts');

  it('has a dedicated v2 source tree and API namespace', () => {
    expect(fs.existsSync(v2Lib)).toBe(true);
    expect(fs.existsSync(v2Api)).toBe(true);
  });

  it('never imports ENG-owned Hypothesis Engine business modules', () => {
    const files = [
      ...tsFiles(v2Lib),
      ...tsFiles(v2Api),
      ...tsFiles(v2Components),
      ...(fs.existsSync(v2Worker) ? [v2Worker] : []),
    ];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect({ file, text: source(file) }).not.toEqual(
        expect.objectContaining({
          text: expect.stringMatching(
            /(?:from\s+|import\s*\()\s*['"][^'"]*hypothesisEngine(?:\/[^'"]*)?['"]/,
          ),
        }),
      );
    }
  });

  it('never writes to an he_* table from v2 code', () => {
    const files = [...tsFiles(v2Lib), ...tsFiles(v2Api)];
    const heMutation =
      /\.from\(\s*['"]he_[^'"]+['"]\s*\)(?:.|\n){0,300}\.(?:insert|upsert|update|delete)\s*\(/;

    for (const file of files) {
      expect({ file, text: source(file) }).not.toEqual(
        expect.objectContaining({ text: expect.stringMatching(heMutation) }),
      );
    }
  });

  it('keeps ENG and the existing Hypothesis Engine independent from v2', () => {
    const engOwnedFiles = [
      ...tsFiles(path.resolve(process.cwd(), 'src/lib/hypothesisEngine')),
      ...tsFiles(path.resolve(process.cwd(), 'src/app/api/client/eng')),
      path.resolve(process.cwd(), 'worker/hypothesisEngine.ts'),
    ].filter((file) => fs.existsSync(file));

    for (const file of engOwnedFiles) {
      expect({ file, text: source(file) }).not.toEqual(
        expect.objectContaining({
          text: expect.stringMatching(
            /(?:from\s+|import\s*\()\s*['"][^'"]*verticalEngineV2(?:\/[^'"]*)?['"]/,
          ),
        }),
      );
    }
  });

  it('runs an isolated worker without ENG autopilot or HE models', () => {
    expect(fs.existsSync(v2Worker)).toBe(true);
    const worker = source(v2Worker);
    const llm = source(path.join(v2Lib, 'llm.ts'));

    expect(worker).toMatch(/from\('ve_jobs'\)/);
    expect(worker).not.toMatch(/from\('he_jobs'\)/);
    expect(worker).not.toMatch(/autopilotNext|enqueueAutopilotFollowups|enqueueHeAutopilot/);
    expect(llm).toMatch(/VE_MODEL_RESEARCH/);
    expect(llm).not.toMatch(/HE_MODEL_RESEARCH/);
  });

  it('exposes v2 in the registry while the legacy internal route stays mounted', () => {
    const registry = source(path.resolve(process.cwd(), 'src/lib/toolsRegistry.ts'));
    const legacyPage = source(
      path.resolve(process.cwd(), 'src/app/tools/hypothesis-engine/page.tsx'),
    );
    const v2Page = path.resolve(
      process.cwd(),
      'src/app/tools/vertical-engine-v2/page.tsx',
    );

    // Cutover: v2 видим в реестре; легаси-роут остаётся (read-only баннер).
    expect(registry).toContain("'vertical-engine-v2'");
    expect(legacyPage).toContain('HypothesisEngineView');
    expect(fs.existsSync(v2Page)).toBe(true);
  });

  it('bundles and deploys the v2 worker like every other dedicated worker', () => {
    const repoRoot = path.resolve(process.cwd(), '..');
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.worker'), 'utf8');
    const packageJson = fs.readFileSync(path.join(repoRoot, 'app/package.json'), 'utf8');
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    const deployTargets = fs.readFileSync(
      path.join(repoRoot, '.semaphore/select-deploy-targets.sh'),
      'utf8',
    );

    expect(dockerfile).toContain('worker/verticalEngineV2.ts');
    expect(packageJson).toContain('worker/verticalEngineV2.ts');
    expect(compose).toContain('worker-vertical-engine-v2:');
    expect(compose).toContain('WORKER_KIND=vertical-engine-v2');
    expect(deployTargets).toContain('worker-vertical-engine-v2');
  });
});
