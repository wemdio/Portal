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
    'NEXT_BUILD_PRECHECKED_TYPECHECK',
  ] as const;
  const originalEnv = Object.fromEntries(
    trackedEnv.map((name) => [name, process.env[name]]),
  );

  beforeEach(() => {
    for (const name of trackedEnv) delete process.env[name];
    jest.resetModules();
  });

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

  it('does not allow a Docker precheck flag alone to disable the built-in check', async () => {
    process.env.NEXT_BUILD_PRECHECKED_TYPECHECK = '1';

    const config = await loadConfig();

    expect(config.typescript?.ignoreBuildErrors).toBe(false);
  });

  it('allows an explicitly prechecked build to skip only the duplicate Next.js check', async () => {
    process.env.NEXT_BUILD_SKIP_TYPECHECK = '1';
    process.env.NEXT_BUILD_PRECHECKED_TYPECHECK = '1';

    const config = await loadConfig();

    expect(config.typescript?.ignoreBuildErrors).toBe(true);
  });

  it.each(['main', 'test'])(
    'does not let the Semaphore branch flag alone skip checks for protected branch %s',
    async (branch) => {
      process.env.CI = 'true';
      process.env.SEMAPHORE = 'true';
      process.env.SEMAPHORE_GIT_BRANCH = branch;
      process.env.SEMAPHORE_GIT_REF_TYPE = 'branch';
      process.env.NEXT_BUILD_SKIP_TYPECHECK = '1';

      const config = await loadConfig();

      expect(config.typescript?.ignoreBuildErrors).toBe(false);
    },
  );

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

  it('keeps the shared strict typecheck command in the required test job', () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), '..', '.semaphore', 'semaphore.yml'),
      'utf8',
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const testBlock = namedSection(workflow, 'Run tests', 2);
    const typecheckJob = namedSection(testBlock, 'Lint, typecheck, test', 8);
    const strictTypecheck = packageJson.scripts?.['typecheck:strict'] ?? '';
    const typegenIndex = strictTypecheck.indexOf('next typegen');
    const routeValidatorIndex = strictTypecheck.indexOf(
      'tsc -p tsconfig.next-route-validator.json --noEmit --incremental --tsBuildInfoFile .next/cache/tsc/routes.tsbuildinfo',
    );
    const tscIndex = strictTypecheck.indexOf(
      'tsc --noEmit --incremental --tsBuildInfoFile .next/cache/tsc/project.tsbuildinfo',
    );

    expect(testBlock).toContain("branch != 'main' AND branch != 'test'");
    expect(typecheckJob).toContain('- npm run typecheck:strict');
    expect(typecheckJob).not.toContain('- npx next typegen');
    expect(typegenIndex).toBeGreaterThan(-1);
    expect(routeValidatorIndex).toBeGreaterThan(typegenIndex);
    expect(tscIndex).toBeGreaterThan(routeValidatorIndex);
    expect(packageJson.scripts?.['pretypecheck:strict']).toContain(
      "mkdirSync('.next/cache/tsc', { recursive: true })",
    );
    // Проверяем инвариант, а не буквальный ключ: incremental-состояние tsc
    // обязано и подниматься из кэша, и складываться обратно из .next/cache/tsc.
    // Раньше здесь были прибиты точные строки ключей, и любая правка схемы
    // кэширования (например переход на ротацию ключа) валила тест, ничего
    // содержательного при этом не поймав.
    expect(typecheckJob).toContain('cache restore tsc-');
    expect(typecheckJob).toContain('cache store tsc-');
    expect(typecheckJob).toContain('.next/cache/tsc');
    expect(typecheckJob).not.toContain('.tsbuildinfo.ci');
    expect(typecheckJob).toContain('npm test -- --watchAll=false');
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

  it('sets the branch-CI skip flag only inside the branch Next build job', () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), '..', '.semaphore', 'semaphore.yml'),
      'utf8',
    );
    const testBlock = namedSection(workflow, 'Run tests', 2);
    const nextBuildJob = namedSection(testBlock, 'Next build', 8);

    expect(nextBuildJob).toContain("- 'NEXT_BUILD_SKIP_TYPECHECK=1 npm run build'");
    expect(workflow.match(/NEXT_BUILD_SKIP_TYPECHECK=1 npm run build/g)).toHaveLength(1);
  });

  it('strictly prechecks the production Docker build before skipping the duplicate check', () => {
    const dockerfile = fs.readFileSync(
      path.resolve(process.cwd(), '..', 'Dockerfile'),
      'utf8',
    );
    const builderStage = dockerfile.match(
      /FROM node:22-alpine AS builder([\s\S]*?)FROM node:22-alpine AS runner/,
    )?.[1] ?? '';
    const precheckIndex = builderStage.indexOf('RUN npm run typecheck:strict');
    const buildIndex = builderStage.indexOf(
      'RUN NEXT_BUILD_PRECHECKED_TYPECHECK=1 NEXT_BUILD_SKIP_TYPECHECK=1 npm run build',
    );

    expect(builderStage).not.toBe('');
    expect(precheckIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(precheckIndex);
    expect(builderStage).not.toMatch(
      /(?:ARG|ENV) NEXT_BUILD_(?:PRECHECKED_TYPECHECK|SKIP_TYPECHECK)/,
    );
    expect(builderStage).not.toMatch(/npm run typecheck:strict[^\r\n]*\|\| true/);
    expect(dockerfile.match(/NEXT_BUILD_PRECHECKED_TYPECHECK=1/g)).toHaveLength(1);
  });
});
