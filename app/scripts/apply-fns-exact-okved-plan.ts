import path from 'node:path';

import { Client } from 'pg';

import {
  assertFnsExactApplyAuthorized,
  assertFnsProductionTarget,
  executeFnsExactCheck,
  executeFnsExactResumableApply,
  parseFnsExactApplyCliArgs,
} from '@/lib/companiesDirectory/fnsExactApply';
import {
  FileFnsExactApplyCheckpointStore,
  type FnsExactApplyTarget,
} from '@/lib/companiesDirectory/fnsExactCheckpoint';
import {
  processFnsExactPlanFiles,
} from '@/lib/companiesDirectory/fnsExactPlanFiles';
import {
  createFnsExactPgClient,
  type FnsExactNativePgClient,
} from '@/lib/companiesDirectory/fnsExactPgCopyClient';
import {
  FnsExactPostgresApplySession,
  verifyFnsExactDatabaseIdentity,
} from '@/lib/companiesDirectory/fnsExactPostgresApply';

const ARTIFACT_VALIDATION_BATCH_SIZE = 10_000;
const DEFAULT_CHECKPOINT_FILE =
  '.fns-exact-okved-apply.checkpoint.json';

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
  const checkpointPath = path.resolve(
    args.checkpointPath
      ?? path.join(planDir, DEFAULT_CHECKPOINT_FILE),
  );

  process.stdout.write('Validating frozen FNS exact OKVED artifacts locally...\n');
  const localPlan = await processFnsExactPlanFiles({
    planDir,
    manifestPath,
    batchSize: ARTIFACT_VALIDATION_BATCH_SIZE,
  });
  process.stdout.write(
    `Validated ${localPlan.updateRows} update-only rows; `
    + `${localPlan.conflictRows} preserved conflicts.\n`,
  );

  const databaseUrl = importDatabaseUrl();
  const databaseTarget = assertFnsProductionTarget(
    databaseUrl,
    args.confirmedTarget,
  );
  const applyTarget: FnsExactApplyTarget = {
    ...databaseTarget,
    table: 'public.companies_directory',
  };
  if (args.mode === 'apply') {
    assertFnsExactApplyAuthorized({
      mode: args.mode,
      planFingerprint: localPlan.planFingerprint,
      confirmedPlanFingerprint: args.confirmedPlanFingerprint,
      previewFingerprint: args.confirmedPreviewFingerprint ?? '',
      confirmedPreviewFingerprint: args.confirmedPreviewFingerprint,
    });
  }

  const nativeClient = new Client({ connectionString: databaseUrl });
  await nativeClient.connect();
  try {
    const client = createFnsExactPgClient(
      nativeClient as unknown as FnsExactNativePgClient,
    );
    await client.query(
      "SELECT set_config('application_name', $1, false)",
      [`fns-exact-okved-${args.mode}`],
    );
    const identity = await verifyFnsExactDatabaseIdentity(client);
    const session = new FnsExactPostgresApplySession({
      client,
      expectedPlanFingerprint: localPlan.planFingerprint,
      processArtifacts: async ({ onUpdateBatch }) =>
        processFnsExactPlanFiles({
          planDir,
          manifestPath,
          batchSize: ARTIFACT_VALIDATION_BATCH_SIZE,
          onUpdateBatch,
        }),
    });

    if (args.mode === 'check') {
      const preview = await executeFnsExactCheck(session);
      printJson({
        mode: 'check',
        persistentWrites: false,
        target: databaseTarget,
        identity,
        planFingerprint: localPlan.planFingerprint,
        preview,
        checkpointPath,
        nextCommandRequires: [
          '--apply',
          `--confirm-plan ${localPlan.planFingerprint}`,
          `--confirm-preview ${preview.fingerprint}`,
          `--confirm-target ${databaseTarget.host}`,
        ],
      });
      return;
    }

    const checkpointStore = new FileFnsExactApplyCheckpointStore(
      checkpointPath,
    );
    const result = await executeFnsExactResumableApply(
      session,
      checkpointStore,
      {
        planFingerprint: localPlan.planFingerprint,
        expectedPreviewFingerprint:
          args.confirmedPreviewFingerprint as string,
        target: applyTarget,
        pageSize: args.batchSize,
        resume: args.resume,
      },
    );
    printJson({
      mode: 'apply',
      resume: args.resume,
      target: databaseTarget,
      identity,
      planFingerprint: localPlan.planFingerprint,
      checkpointPath,
      pageSize: args.batchSize,
      ...result,
    });
  } finally {
    await nativeClient.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
