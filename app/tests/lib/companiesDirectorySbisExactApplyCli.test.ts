/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('SBIS exact OKVED apply CLI wiring', () => {
  it('uses the shared guarded runner with an isolated SBIS source and state', () => {
    const sharedRunner = readAppFile(
      'src/lib/companiesDirectory/exactOkvedApplyCli.ts',
    );
    const fnsCli = readAppFile('scripts/apply-fns-exact-okved-plan.ts');
    const sbisCli = readAppFile('scripts/apply-sbis-exact-okved-plan.ts');

    expect(sharedRunner).toContain('runExactOkvedApplyCli');
    expect(fnsCli).toContain('runExactOkvedApplyCli');
    expect(sbisCli).toContain('runExactOkvedApplyCli');
    expect(sbisCli).toContain('processSbisExactPlanFiles');
    expect(sbisCli).not.toContain('processFnsExactPlanFiles');
    expect(sbisCli).toMatch(/exactSource:\s*['"]sbis_registry['"]/);
    expect(sbisCli).toMatch(
      /databaseUrlEnvironmentVariable:\s*['"]SBIS_EXACT_IMPORT_DATABASE_URL['"]/,
    );
    expect(sbisCli).toMatch(
      /defaultCheckpointFile:\s*['"]\.sbis-exact-okved-apply\.checkpoint\.json['"]/,
    );
    expect(sbisCli).toMatch(
      /applicationNamePrefix:\s*['"]sbis-exact-okved['"]/,
    );
    expect(sbisCli).not.toContain('FNS_EXACT_IMPORT_DATABASE_URL');
  });

  it('bundles the SBIS importer into the production image without changing FNS tooling', () => {
    const packageJson = JSON.parse(readAppFile('package.json')) as {
      scripts?: Record<string, string>;
    };
    const fnsBuildScript = packageJson.scripts?.['build:fns-exact-tools'] ?? '';
    const buildScript = packageJson.scripts?.['build:sbis-exact-importer'] ?? '';

    expect(fnsBuildScript).toContain('./scripts/apply-fns-exact-okved-plan.ts');
    expect(fnsBuildScript).not.toContain('./scripts/apply-sbis-exact-okved-plan.ts');
    expect(buildScript).toContain('./scripts/apply-sbis-exact-okved-plan.ts');
    expect(buildScript).toContain(
      '--outfile=./dist/scripts/apply-sbis-exact-okved-plan.cjs',
    );

    const dockerfile = readAppFile('../Dockerfile');
    expect(dockerfile).toContain('RUN npm run build:sbis-exact-importer');
    expect(dockerfile).toContain(
      '/app/dist/scripts/apply-sbis-exact-okved-plan.cjs ./scripts/apply-sbis-exact-okved-plan.cjs',
    );
  });
});
