import path from 'node:path';

import { Client } from 'pg';

/**
 * Two-phase, one-time SBIS v4 importer.
 *
 * 1. Run with --check to receive immutable plan/live-preview fingerprints.
 * 2. Run with --apply and confirm both fingerprints plus the production host.
 *
 * The large JSONL artifacts are intentionally not part of the Docker image.
 */
import {
  assertSbisApplyAuthorized,
  assertSbisProductionTarget,
  assertTrustedSbisV4PlanFingerprint,
  executeSbisApply,
  executeSbisCheck,
  parseSbisApplyCliArgs,
} from '@/lib/companiesDirectory/sbisPlanApply';
import { processSbisPlanFiles } from '@/lib/companiesDirectory/sbisPlanFiles';
import {
  SbisPostgresApplySession,
  verifySbisDatabaseIdentity,
  type SbisPgClient,
} from '@/lib/companiesDirectory/sbisPostgresApply';

const DEFAULT_MANIFEST = path.resolve(
  process.cwd(),
  'scripts',
  'sbis-directory-v4.manifest.json',
);

function requireImportDatabaseUrl(): string {
  const value = process.env.SBIS_IMPORT_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      'SBIS_IMPORT_DATABASE_URL is required; generic database variables are intentionally ignored',
    );
  }
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseSbisApplyCliArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifestPath ?? DEFAULT_MANIFEST);
  const planDir = path.resolve(args.planDir);

  process.stdout.write('Validating frozen SBIS v4 artifacts locally...\n');
  const localPlan = await processSbisPlanFiles({
    planDir,
    manifestPath,
  });
  assertTrustedSbisV4PlanFingerprint(localPlan.planFingerprint);
  process.stdout.write(
    `Validated ${localPlan.insertRows} inserts and ${localPlan.updateRows} updates.\n`,
  );

  const databaseUrl = requireImportDatabaseUrl();
  const target = assertSbisProductionTarget(
    databaseUrl,
    args.confirmedTarget,
  );

  if (args.mode === 'apply') {
    assertSbisApplyAuthorized({
      mode: args.mode,
      planFingerprint: localPlan.planFingerprint,
      confirmedPlanFingerprint: args.confirmedPlanFingerprint,
      previewFingerprint: args.confirmedPreviewFingerprint ?? '',
      confirmedPreviewFingerprint: args.confirmedPreviewFingerprint,
    });
  }

  const client = new Client({
    connectionString: databaseUrl,
  });
  await client.connect();

  try {
    await client.query(
      "SELECT set_config('application_name', $1, false)",
      [`sbis-directory-v4-${args.mode}`],
    );
    const identity = await verifySbisDatabaseIdentity(
      client as unknown as SbisPgClient,
    );
    const session = new SbisPostgresApplySession({
      client: client as unknown as SbisPgClient,
      expectedPlanFingerprint: localPlan.planFingerprint,
      processArtifacts: async (callbacks) =>
        processSbisPlanFiles({
          planDir,
          manifestPath,
          onInsertBatch: callbacks.onInsertBatch,
          onUpdateBatch: callbacks.onUpdateBatch,
        }),
    });

    if (args.mode === 'check') {
      const preview = await executeSbisCheck(session);
      printJson({
        mode: 'check',
        persistentWrites: false,
        target,
        identity,
        planFingerprint: localPlan.planFingerprint,
        preview,
        nextCommandRequires: [
          '--apply',
          `--confirm-plan ${localPlan.planFingerprint}`,
          `--confirm-preview ${preview.fingerprint}`,
          `--confirm-target ${target.host}`,
        ],
      });
      return;
    }

    const result = await executeSbisApply(
      session,
      args.confirmedPreviewFingerprint as string,
    );
    printJson({
      mode: 'apply',
      target,
      identity,
      planFingerprint: localPlan.planFingerprint,
      ...result,
    });
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
