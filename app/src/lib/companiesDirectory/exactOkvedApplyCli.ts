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
  createFnsExactPgClient,
  type FnsExactNativePgClient,
} from '@/lib/companiesDirectory/fnsExactPgCopyClient';
import {
  FnsExactPostgresApplySession,
  verifyFnsExactDatabaseIdentity,
} from '@/lib/companiesDirectory/fnsExactPostgresApply';

const ARTIFACT_VALIDATION_BATCH_SIZE = 10_000;

type ExactOkvedSource = 'fns_sme_registry' | 'sbis_registry';

interface ExactPlanProcessorOptions {
  planDir: string;
  manifestPath: string;
  batchSize?: number;
  onUpdateBatch?: (rows: Record<string, unknown>[]) => Promise<void>;
}

interface ProcessedExactPlanFiles {
  planFingerprint: string;
  updateRows: number;
  conflictRows: number;
}

interface TextOutput {
  write(chunk: string): unknown;
}

export interface ExactOkvedApplyCliOptions {
  argv: string[];
  environment: NodeJS.ProcessEnv;
  output: TextOutput;
  planLabel: string;
  databaseUrlEnvironmentVariable: string;
  defaultCheckpointFile: string;
  applicationNamePrefix: string;
  exactSource: ExactOkvedSource;
  processPlanFiles(
    options: ExactPlanProcessorOptions,
  ): Promise<ProcessedExactPlanFiles>;
}

function importDatabaseUrl(
  environment: NodeJS.ProcessEnv,
  variableName: string,
): string {
  const value = environment[variableName]?.trim();
  if (!value) {
    throw new Error(
      `${variableName} is required; generic database variables are intentionally ignored`,
    );
  }
  return value;
}

function printJson(output: TextOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runExactOkvedApplyCli(
  options: ExactOkvedApplyCliOptions,
): Promise<void> {
  const args = parseFnsExactApplyCliArgs(options.argv);
  const planDir = path.resolve(args.planDir);
  const manifestPath = path.resolve(
    args.manifestPath ?? path.join(planDir, 'manifest.json'),
  );
  const checkpointPath = path.resolve(
    args.checkpointPath
      ?? path.join(planDir, options.defaultCheckpointFile),
  );

  options.output.write(
    `Validating frozen ${options.planLabel} artifacts locally...\n`,
  );
  const localPlan = await options.processPlanFiles({
    planDir,
    manifestPath,
    batchSize: ARTIFACT_VALIDATION_BATCH_SIZE,
  });
  options.output.write(
    `Validated ${localPlan.updateRows} update-only rows; `
    + `${localPlan.conflictRows} preserved conflicts.\n`,
  );

  const databaseUrl = importDatabaseUrl(
    options.environment,
    options.databaseUrlEnvironmentVariable,
  );
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
      [`${options.applicationNamePrefix}-${args.mode}`],
    );
    const identity = await verifyFnsExactDatabaseIdentity(client);
    const session = new FnsExactPostgresApplySession({
      client,
      expectedPlanFingerprint: localPlan.planFingerprint,
      exactSource: options.exactSource,
      processArtifacts: async ({ onUpdateBatch }) =>
        options.processPlanFiles({
          planDir,
          manifestPath,
          batchSize: ARTIFACT_VALIDATION_BATCH_SIZE,
          onUpdateBatch,
        }),
    });

    if (args.mode === 'check') {
      const preview = await executeFnsExactCheck(session);
      printJson(options.output, {
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
    printJson(options.output, {
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
