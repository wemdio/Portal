import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';

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
  assertTrustedSbisPlanFingerprint,
  executeSbisApply,
  executeSbisCheck,
  parseSbisApplyCliArgs,
  shouldFinalizeSbisApplyReceipt,
} from '@/lib/companiesDirectory/sbisPlanApply';
import { processSbisPlanFiles } from '@/lib/companiesDirectory/sbisPlanFiles';
import {
  SBIS_BEFORE_IMAGE_SQL,
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

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
  await rename(temporaryPath, filePath);
}

async function main(): Promise<void> {
  const args = parseSbisApplyCliArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifestPath ?? DEFAULT_MANIFEST);
  const planDir = path.resolve(args.planDir);

  process.stdout.write('Validating frozen SBIS artifacts locally...\n');
  const localPlan = await processSbisPlanFiles({
    planDir,
    manifestPath,
  });
  assertTrustedSbisPlanFingerprint(
    localPlan.manifest.plan,
    localPlan.planFingerprint,
  );
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
      [`${localPlan.manifest.plan}-${args.mode}`.slice(0, 63)],
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

    const auditDir = path.join(planDir, 'apply-audit');
    await mkdir(auditDir, { recursive: true });
    const auditStem = `${localPlan.manifest.plan}-${localPlan.planFingerprint}`;
    const beforeImagePath = path.join(
      auditDir,
      `${auditStem}.before-image.json`,
    );
    const receiptPath = path.join(
      auditDir,
      `${auditStem}.receipt.json`,
    );
    const result = await executeSbisApply(
      session,
      args.confirmedPreviewFingerprint as string,
      {
        plan: localPlan.manifest.plan,
        planFingerprint: localPlan.planFingerprint,
        captureBeforeImage: async ({ before }) => {
          const result = await client.query(SBIS_BEFORE_IMAGE_SQL);
          const payload = {
            capturedAt: new Date().toISOString(),
            plan: localPlan.manifest.plan,
            planFingerprint: localPlan.planFingerprint,
            previewFingerprint: before.fingerprint,
            rows: result.rows,
          };
          const beforeImage = {
            ...payload,
            sha256: hashJson(payload),
          };
          await writeJsonAtomically(beforeImagePath, beforeImage);
          return beforeImage;
        },
        persistPendingReceipt: async (receipt) => {
          await writeJsonAtomically(receiptPath, {
            status: 'pending_commit',
            writtenAt: new Date().toISOString(),
            ...receipt,
            beforeImagePath,
          });
        },
      },
    );
    if (shouldFinalizeSbisApplyReceipt(result)) {
      await writeJsonAtomically(receiptPath, {
        status: 'committed',
        committedAt: new Date().toISOString(),
        plan: localPlan.manifest.plan,
        planFingerprint: localPlan.planFingerprint,
        beforeImagePath,
        result,
      });
    }
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
