#!/usr/bin/env node
// Generates SQL for a later, separately approved production enqueue.
// This program never connects to the database or changes campaigns.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const planDir = process.argv[2];
if (!planDir) throw new Error('Usage: node prepare-enqueue.mjs <plan-directory>');
const manifest = JSON.parse(readFileSync(join(planDir, 'manifest.json'), 'utf8'));
if (manifest.mode !== 'read-only-plan' || !Array.isArray(manifest.batchFiles)) {
  throw new Error('Invalid read-only plan manifest');
}
if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(manifest.clientId ?? '')) {
  throw new Error('Invalid client id in manifest');
}

const batches = manifest.batchFiles.map((filename) => {
  if (!/^no-email-retry-[0-9a-f]{12}-[0-9]{4}-[0-9]{8}\.txt$/.test(filename)) {
    throw new Error(`Unexpected batch filename: ${filename}`);
  }
  const domains = readFileSync(join(planDir, filename), 'utf8').trim().split('\n');
  if (domains.length < 1 || domains.length > 100) throw new Error(`Invalid batch size: ${filename}`);
  for (const domain of domains) {
    if (!/^[a-z0-9.-]+\.(ru|su|xn--p1ai)$/.test(domain)) {
      throw new Error(`Invalid planned domain: ${domain}`);
    }
  }
  return { filename, domains, id: randomUUID() };
});
const allDomains = batches.flatMap((batch) => batch.domains);
const hash = createHash('sha256').update(allDomains.join('\n') + '\n').digest('hex');
if (hash !== manifest.sha256 || allDomains.length !== manifest.candidateCount
    || new Set(allDomains).size !== allDomains.length || batches.length === 0) {
  throw new Error('Plan hash, count or uniqueness mismatch');
}

const statements = [
  '-- Generated locally. DO NOT RUN without explicit approval of migration, deployment and production enqueue.',
  `-- Planned ${allDomains.length} domains; SHA-256 ${hash}; ${batches.length} runs.`,
  'BEGIN;',
  "SET LOCAL statement_timeout = '180s';",
  'CREATE TEMP TABLE retry_plan (batch_no integer NOT NULL, domain text PRIMARY KEY) ON COMMIT DROP;',
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM public.portal_migrations WHERE name = '20261010_0001_client_no_email_retry_live_email_counts.sql') THEN RAISE EXCEPTION 'Deploy the no-email retry live email-count fix before enqueueing'; END IF; END $$;",
];
for (let start = 0; start < batches.length; start += 10) {
  const values = batches.slice(start, start + 10).flatMap((batch, index) =>
    batch.domains.map((domain) => `(${start + index + 1},'${domain}')`));
  statements.push(`INSERT INTO retry_plan (batch_no, domain) VALUES ${values.join(',')};`);
}
statements.push(
  `DO $$ BEGIN IF (SELECT count(*) FROM retry_plan) <> ${allDomains.length} THEN RAISE EXCEPTION 'Retry plan count changed'; END IF; END $$;`,
  'INSERT INTO public.client_manual_score_runs (id, client_user_id, source_filename, uploaded_count, unique_count, status, route_to_instantly, is_no_email_retry) VALUES',
  batches.map((batch) =>
    `('${batch.id}','${manifest.clientId}','${batch.filename}',${batch.domains.length},${batch.domains.length},'pending',true,true)`).join(',\n') + ';',
  'INSERT INTO public.client_manual_score_rows (run_id, raw_input, domain)',
  'SELECT mapping.run_id, plan.domain, plan.domain FROM retry_plan AS plan',
  'JOIN (VALUES',
  batches.map((batch, index) => `(${index + 1},'${batch.id}'::uuid)`).join(',\n'),
  ') AS mapping(batch_no, run_id) ON mapping.batch_no = plan.batch_no;',
  'COMMIT;',
);
const output = join(planDir, 'enqueue-after-approval.sql');
writeFileSync(output, statements.join('\n') + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ output, runs: batches.length, domains: allDomains.length, sha256: hash }) + '\n');
