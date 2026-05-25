#!/usr/bin/env node
/** Re-validate emails for a dry-run client. Usage: node scripts/re-validate-emails.mjs <client_user_id> */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, '..', 'dist', 'workers', 'autoPipelineReValidateCli.js');
const { runReValidate } = await import(pathToFileURL(bundlePath).href);

const clientUserId = process.argv[2];
if (!clientUserId) {
  console.error('Usage: node scripts/re-validate-emails.mjs <client_user_id>');
  process.exit(1);
}

const t0 = Date.now();
const result = await runReValidate(clientUserId);
const sec = Math.round((Date.now() - t0) / 1000);
console.log('');
console.log(`✅ Re-validation done in ${sec}s`);
console.log(`   Total:   ${result.total}`);
console.log(`   Updated: ${result.updated}`);
console.log(`   Errors:  ${result.errors}`);
process.exit(0);
