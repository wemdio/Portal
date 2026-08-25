import fs from 'fs';
import path from 'path';
import type { NextConfig } from 'next';

describe('Next build typecheck contract', () => {
  const trackedEnv = [
    'CI',
    'SEMAPHORE',
    'SEMAPHORE_GIT_BRANCH',
    'SEMAPHORE_GIT_REF_TYPE',
    'NEXT_BUILD_SKIP_TYPECHECK',
  ] as const;
  const originalEnv = Object.fromEntries(
    trackedEnv.map((name) => [name, process.env[name]]),
  );

  afterEach(() => {
    for (const name of trackedEnv) {
      const original = originalEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    jest.resetModules();
  });

  async function loadConfig(): Promise<NextConfig> {
    jest.resetModules();
    const loaded = await import('../../next.config');
    return loaded.default;
  }

  it('keeps the built-in TypeScript check enabled by default', async () => {
    for (const name of trackedEnv) delete process.env[name];

    const config = await loadConfig();

    expect(config.typescript?.ignoreBuildErrors).toBe(false);
  });

  it('does not allow a local flag alone to disable the built-in check', async () => {
    process.env.NEXT_BUILD_SKIP_TYPECHECK = '1';

    const config = await loadConfig();

    expect(config.typescript?.ignoreBuildErrors).toBe(false);
  });

  it('allows only a Semaphore branch build to skip the duplicate Next.js check', async () => {
    process.env.CI = 'true';
    process.env.SEMAPHORE = 'true';
    process.env.SEMAPHORE_GIT_BRANCH = 'Sergey';
    process.env.SEMAPHORE_GIT_REF_TYPE = 'branch';
    process.env.NEXT_BUILD_SKIP_TYPECHECK = '1';

    const config = await loadConfig();

    expect(config.typescript?.ignoreBuildErrors).toBe(true);
  });

  it.each(['main', 'test'])('never skips the built-in check for protected branch %s', async (branch) => {
    process.env.CI = 'true';
    process.env.SEMAPHORE = 'true';
    process.env.SEMAPHORE_GIT_BRANCH = branch;
    process.env.SEMAPHORE_GIT_REF_TYPE = 'branch';
    process.env.NEXT_BUILD_SKIP_TYPECHECK = '1';

    const config = await loadConfig();

    expect(config.typescript?.ignoreBuildErrors).toBe(false);
  });

  function namedSection(workflow: string, name: string, indentation: number): string {
    const prefix = ' '.repeat(indentation);
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex((line) =>
      new RegExp(`^${prefix}- name: ['\"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]?$`).test(line),
    );
    if (start < 0) throw new Error(`Workflow section not found: ${name}`);
    const next = lines.slice(start + 1).findIndex((line) =>
      new RegExp(`^${prefix}- name:`).test(line),
    );
    return lines.slice(start, next < 0 ? undefined : start + 1 + next).join('\n');
  }

  it('keeps route type generation and strict tsc in the required test job', () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), '..', '.semaphore', 'semaphore.yml'),
      'utf8',
    );
    const testBlock = namedSection(workflow, 'Run tests', 2);
    const typecheckJob = namedSection(testBlock, 'Lint, typecheck, test', 8);
    const typegenIndex = typecheckJob.indexOf('- npx next typegen');
    const routeValidatorIndex = typecheckJob.indexOf(
      '- npx tsc -p tsconfig.next-route-validator.json --noEmit --incremental --tsBuildInfoFile .next/cache/tsc/routes.tsbuildinfo',
    );
    const tscIndex = typecheckJob.indexOf('- npx tsc --noEmit --incremental');

    expect(testBlock).toContain("branch != 'main' AND branch != 'test'");
    expect(typegenIndex).toBeGreaterThan(-1);
    expect(routeValidatorIndex).toBeGreaterThan(typegenIndex);
    expect(tscIndex).toBeGreaterThan(routeValidatorIndex);
    expect(typecheckJob).toContain('--tsBuildInfoFile .next/cache/tsc/project.tsbuildinfo');
    expect(typecheckJob).toContain("cache restore tsc-v2-$SEMAPHORE_GIT_BRANCH,tsc-v2-");
    expect(typecheckJob).toContain('cache store tsc-v2-$SEMAPHORE_GIT_BRANCH .next/cache/tsc');
    expect(typecheckJob).not.toContain('.tsbuildinfo.ci');
    expect(typecheckJob).toContain('- npm test -- --watchAll=false');
  });

  it('includes Next generated page and route validators in a dedicated tsc program', () => {
    const validatorConfig = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), 'tsconfig.next-route-validator.json'),
        'utf8',
      ),
    ) as {
      extends?: string;
      include?: string[];
      exclude?: string[];
    };

    expect(validatorConfig.extends).toBe('./tsconfig.json');
    expect(validatorConfig.include).toEqual(expect.arrayContaining([
      '.next/types/validator.ts',
      '.next/types/routes.d.ts',
      'next-env.d.ts',
      'src/types/**/*.d.ts',
    ]));
    expect(validatorConfig.exclude).toEqual(['node_modules']);
  });

  it('sets the skip flag only inside the branch CI Next build job', () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), '..', '.semaphore', 'semaphore.yml'),
      'utf8',
    );
    const testBlock = namedSection(workflow, 'Run tests', 2);
    const nextBuildJob = namedSection(testBlock, 'Next build', 8);

    expect(nextBuildJob).toContain("- 'NEXT_BUILD_SKIP_TYPECHECK=1 npm run build'");
    expect(workflow.match(/NEXT_BUILD_SKIP_TYPECHECK=1 npm run build/g)).toHaveLength(1);
  });
});
