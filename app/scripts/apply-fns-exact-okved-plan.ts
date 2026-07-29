import path from 'node:path';

import { Client } from 'pg';

import {
  assertFnsExactApplyAuthorized,
  assertFnsProductionTarget,
  executeFnsExactApply,
  executeFnsExactCheck,
  parseFnsExactApplyCliArgs,
} from '@/lib/companiesDirectory/fnsExactApply';
import {
  processFnsExactPlanFiles,
} from '@/lib/companiesDirectory/fnsExactPlanFiles';
import {
  FnsExactPostgresApplySession,
  verifyFnsExactDatabaseIdentity,
  type FnsExactPgClient,
} from '@/lib/companiesDirectory/fnsExactPostgresApply';

function importDatabaseUrl(): string {
  const value = process.env.FNS_EXACT_IMPORT_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      'FNS_EXACT_IMPORT_DATABASE_URL is required; generic database variables are intentionally ignored',
    );
  }
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseFnsExactApplyCliArgs(process.argv.slice(2));
  const planDir = path.resolve(args.planDir);
  const manifestPath = path.resolve(
    args.manifestPath ?? path.join(planDir, 'manifest.json'),
  );

  process.stdout.write('Validating frozen FNS exact OKVED artifacts locally...\n');
  const localPlan = await processFnsExactPlanFiles({
    planDir,
    manifestPath,
    batchSize: args.batchSize,
  });
  process.stdout.write(
    `Validated ${localPlan.updateRows} update-only rows; `
    + `${localPlan.conflictRows} preserved conflicts.\n`,
  );

  const databaseUrl = importDatabaseUrl();
  const target = assertFnsProductionTarget(
    databaseUrl,
    args.confirmedTarget,
  );
  if (args.mode === 'apply') {
    assertFnsExactApplyAuthorized({
      mode: args.mode,
      planFingerprint: localPlan.planFingerprint,
      confirmedPlanFingerprint: args.confirmedPlanFingerprint,
      previewFingerprint: args.confirmedPreviewFingerprint ?? '',
      confirmedPreviewFingerprint: args.confirmedPreviewFingerprint,
    });
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "SELECT set_config('application_name', $1, false)",
      [`fns-exact-okved-${args.mode}`],
    );
    const identity = await verifyFnsExactDatabaseIdentity(
      client as unknown as FnsExactPgClient,
    );
    const session = new FnsExactPostgresApplySession({
      client: client as unknown as FnsExactPgClient,
      expectedPlanFingerprint: localPlan.planFingerprint,
      processArtifacts: async ({ onUpdateBatch }) =>
        processFnsExactPlanFiles({
          planDir,
          manifestPath,
          batchSize: args.batchSize,
          onUpdateBatch,
        }),
    });

    if (args.mode === 'check') {
      const preview = await executeFnsExactCheck(session);
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

    const result = await executeFnsExactApply(
      session,
      args.confirmedPreviewFingerprint as string,
      args.batchSize,
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
