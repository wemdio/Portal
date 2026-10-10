#!/usr/bin/env node
// Read-only cohort extraction and deterministic <=100-domain batch planning.
// No production writes and no calls to Mailganer or Instantly.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(clientId ?? '')) {
  throw new Error('Usage: node plan.mjs <client-uuid> [existing-output-directory]');
}

const outputDir = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'mailganer-no-email-retry-'));
if (process.argv[3]) mkdirSync(outputDir, { recursive: false });
const sql = readFileSync(join(here, 'select-candidates.sql'), 'utf8');

// Keep the same built-in brand exclusions as autoPipelineRunner; its live
// config-specific regexes are checked again by the worker before routing.
const builtInExcluded = [
  /сбер/i, /тинькофф/i, /т-банк/i, /альфа.?банк/i, /втб/i, /газпром/i,
  /яндекс/i, /мтс\b/i, /мегафон/i, /билайн/i, /ростелеком/i,
  /магнит/i, /пятёрочка|пятерочка/i, /x5|перекр(е|ё)сток/i,
  /wildberries/i, /ozon\b/i, /авито|avito/i,
];

const ssh = spawn('ssh', [
  '-i', '/Users/cybermart/.ssh/portal_hostkey_mac_ed25519',
  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
  'root@139.60.162.24',
  `docker exec -i main-postgres psql -X -U postgres -d postgres -At -v ON_ERROR_STOP=1 -v client_user_id=${clientId}`,
], { stdio: ['pipe', 'pipe', 'pipe'] });
ssh.stdin.end(sql);

let stdout = '';
let stderr = '';
ssh.stdout.setEncoding('utf8');
ssh.stderr.setEncoding('utf8');
ssh.stdout.on('data', (chunk) => { stdout += chunk; });
ssh.stderr.on('data', (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve, reject) => {
  ssh.on('error', reject);
  ssh.on('close', resolve);
});
if (exitCode !== 0) throw new Error(`Read-only cohort query failed: ${stderr.trim()}`);

const domains = new Set();
let excludedBrands = 0;
for (const line of stdout.split('\n')) {
  if (!line.startsWith('{')) continue;
  const row = JSON.parse(line);
  const domain = String(row.domain ?? '').trim().toLowerCase();
  if (!domain || !/\.(ru|su|xn--p1ai)$/.test(domain)) {
    throw new Error(`Unexpected domain in read-only cohort: ${domain}`);
  }
  if (builtInExcluded.some((pattern) => pattern.test(`${row.company_name ?? ''} ${domain}`))) {
    excludedBrands += 1;
    continue;
  }
  domains.add(domain);
}

const sorted = [...domains].sort();
const sha256 = createHash('sha256').update(sorted.join('\n') + '\n').digest('hex');
const generatedAt = new Date().toISOString();
const dateStamp = generatedAt.slice(0, 10).replaceAll('-', '');
const batchFiles = [];
for (let offset = 0; offset < sorted.length; offset += 100) {
  const name = `no-email-retry-${sha256.slice(0, 12)}-${String(offset / 100 + 1).padStart(4, '0')}-${dateStamp}.txt`;
  writeFileSync(join(outputDir, name), sorted.slice(offset, offset + 100).join('\n') + '\n', { flag: 'wx' });
  batchFiles.push(name);
}
const manifest = {
  mode: 'read-only-plan',
  clientId,
  generatedAt,
  candidateCount: sorted.length,
  excludedBuiltInBrands: excludedBrands,
  sha256,
  batchSize: 100,
  batchFiles,
  note: 'No production runs created. Recheck candidate history and config before any approved enqueue.',
};
writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ outputDir, candidateCount: sorted.length, excludedBrands, sha256, batches: batchFiles.length }) + '\n');
