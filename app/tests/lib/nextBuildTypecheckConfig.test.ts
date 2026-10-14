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

  /**
   * Проверка типов — две команды: typecheck:fast (TypeScript 7; CI веток с
   * 28.09.2026 и прод-сборка в Dockerfile с 29.09.2026) и typecheck:strict
   * (TypeScript 5; запасная — откат одной строкой в Dockerfile, поэтому обязана
   * оставаться полной). Обе проверяют проект кусками, а не одним проходом:
   * целиком он не влезает в 4 ГБ машины сборки ни у 5-го, ни у 7-го. Поэтому
   * сторожим не одну команду, а инвариант для каждой — маршруты Next и КАЖДЫЙ
   * tsconfig.typecheck.*.json обязаны прогоняться. Так из команды не выпадет
   * кусок (часть проекта перестала бы проверяться молча) и не появится
   * файл-сирота, который завели, но запускать забыли.
   *
   * tsc вызывается только по явному пути: оба пакета объявляют команду `tsc`,
   * и какой из них окажется в node_modules/.bin, зависит от способа установки
   * (чистая — TypeScript 5, доустановка поверх — TypeScript 7). Голый `tsc`
   * молча подменил бы версию.
   */
  function expectChunkedTypecheck(script: string, tsc: string, flags: string, buildInfoDir: string) {
    const typegenIndex = script.indexOf('next typegen');
    const routeValidatorIndex = script.indexOf(
      `${tsc} -p tsconfig.next-route-validator.json --noEmit ${flags}--incremental --tsBuildInfoFile ${buildInfoDir}/routes.tsbuildinfo`,
    );
    const chunkConfigs = fs
      .readdirSync(process.cwd())
      .filter((name) => /^tsconfig\.typecheck\..+\.json$/.test(name))
      .sort();
    const chunkIndexes = chunkConfigs.map((name) =>
      script.indexOf(`${tsc} -p ${name} --noEmit ${flags}--incremental --tsBuildInfoFile ${buildInfoDir}/`),
    );
    const tscIndex = chunkIndexes.length ? Math.min(...chunkIndexes) : -1;

    expect(typegenIndex).toBeGreaterThan(-1);
    expect(routeValidatorIndex).toBeGreaterThan(typegenIndex);
    expect(chunkConfigs.length).toBeGreaterThan(0);
    expect(chunkIndexes).not.toContain(-1);
    expect(tscIndex).toBeGreaterThan(routeValidatorIndex);
    const allTscCalls = script.split('tsc -p ').length - 1;
    expect(allTscCalls).toBe(chunkConfigs.length + 1);
    expect(script.split(`${tsc} -p `).length - 1).toBe(allTscCalls);
    // Куски пишут разные файлы incremental-состояния: общий файл на две разные
    // программы означал бы, что каждый прогон обесценивает кэш соседнего.
    const buildInfoFiles = [...script.matchAll(/--tsBuildInfoFile (\S+)/g)].map((m) => m[1]);
    expect(new Set(buildInfoFiles).size).toBe(buildInfoFiles.length);
    expect(buildInfoFiles.every((file) => file.startsWith(`${buildInfoDir}/`))).toBe(true);
  }

  it('keeps both chunked typecheck commands complete and the fast one in the required test job', () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), '..', '.semaphore', 'semaphore.yml'),
      'utf8',
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const testBlock = namedSection(workflow, 'Run tests', 2);
    // Блок намеренно состоит из одной джобы: Semaphore считает минуты суммой
    // по джобам, и каждая лишняя заново платит за пролог. Поэтому и линт с
    // типами, и тесты проверяются в одной секции.
    const typecheckJob = namedSection(testBlock, 'Checks and tests', 8);
    const testsJob = typecheckJob;

    expectChunkedTypecheck(
      packageJson.scripts?.['typecheck:strict'] ?? '',
      'node node_modules/typescript/bin/tsc',
      '',
      '.next/cache/tsc',
    );
    // --checkers 1 — потолок памяти, а не вкус: с двумя проверяющими потоками
    // кусок маршрутов у TypeScript 7 берёт 3,7 ГБ, с одним — 2,9 ГБ при 4 ГБ
    // машины (замер 28.09.2026). Состояние TypeScript 7 лежит отдельно от
    // состояния 5-го: форматы у них разные.
    expectChunkedTypecheck(
      packageJson.scripts?.['typecheck:fast'] ?? '',
      'node node_modules/typescript-7/bin/tsc',
      '--checkers 1 ',
      '.next/cache/tsc7',
    );

    expect(testBlock).toContain("branch != 'main' AND branch != 'test'");
    expect(typecheckJob).toContain('- npm run typecheck:fast');
    expect(typecheckJob).not.toContain('- npx next typegen');
    expect(packageJson.scripts?.['pretypecheck:strict']).toContain(
      "mkdirSync('.next/cache/tsc', { recursive: true })",
    );
    // Проверяем инвариант, а не буквальный ключ: incremental-состояние
    // (.next/cache) обязано и подниматься из кэша, и складываться обратно.
    // Без этого проверка типов считает проект с нуля — у TypeScript 7 это
    // ~1 минута против ~10 секунд с кэшем.
    // Раньше здесь были прибиты точные строки ключей, и любая правка схемы
    // кэширования валила тест, ничего содержательного при этом не поймав.
    expect(typecheckJob).toMatch(/cache restore \S+/);
    expect(typecheckJob).toMatch(/cache store [^\n]*\.next\/cache/);
    expect(typecheckJob).not.toContain('.tsbuildinfo.ci');
    // Тесты обязаны остаться в обязательном блоке ветки; какие именно гонять
    // (связанные с изменениями или весь набор), решает один скрипт.
    // --shard без пересчёта долей однажды уже мог бы тихо недосчитать часть
    // набора, оставив прогон зелёным. Сейчас долей нет — и появиться они
    // должны осознанно, вместе с правкой этого теста.
    expect(testsJob).toContain('- \'node scripts/ci/branch-tests.mjs ');
    expect(fs.existsSync(path.resolve(process.cwd(), 'scripts', 'ci', 'branch-tests.mjs'))).toBe(true);
    expect(testsJob).not.toContain('--shard=');
    // Порядок внутри джобы: сначала дешёвые проверки, потом тесты.
    // Иначе за тесты платится даже там, где правка не проходит типы.
    expect(typecheckJob.indexOf('npm run typecheck:fast')).toBeLessThan(
      typecheckJob.indexOf('scripts/ci/branch-tests.mjs'),
    );
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

  it('prechecks the production Docker build with the fast typecheck before skipping the duplicate check', () => {
    const dockerfile = fs.readFileSync(
      path.resolve(process.cwd(), '..', 'Dockerfile'),
      'utf8',
    );
    const builderStage = dockerfile.match(
      /FROM node:22-alpine AS builder([\s\S]*?)FROM node:22-alpine AS runner/,
    )?.[1] ?? '';
    const precheckIndex = builderStage.indexOf('RUN npm run typecheck:fast');
    const buildIndex = builderStage.indexOf(
      'RUN NEXT_BUILD_PRECHECKED_TYPECHECK=1 NEXT_BUILD_SKIP_TYPECHECK=1 npm run build',
    );

    expect(builderStage).not.toBe('');
    expect(precheckIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(precheckIndex);
    expect(builderStage).not.toMatch(
      /(?:ARG|ENV) NEXT_BUILD_(?:PRECHECKED_TYPECHECK|SKIP_TYPECHECK)/,
    );
    expect(builderStage).not.toMatch(/npm run typecheck:[a-z]+[^\r\n]*\|\| true/);
    expect(dockerfile.match(/NEXT_BUILD_PRECHECKED_TYPECHECK=1/g)).toHaveLength(1);
  });
});
