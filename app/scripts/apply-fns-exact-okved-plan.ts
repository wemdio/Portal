import {
  runExactOkvedApplyCli,
} from '@/lib/companiesDirectory/exactOkvedApplyCli';
import {
  processFnsExactPlanFiles,
} from '@/lib/companiesDirectory/fnsExactPlanFiles';

runExactOkvedApplyCli({
  argv: process.argv.slice(2),
  environment: process.env,
  output: process.stdout,
  planLabel: 'FNS exact OKVED',
  databaseUrlEnvironmentVariable: 'FNS_EXACT_IMPORT_DATABASE_URL',
  defaultCheckpointFile: '.fns-exact-okved-apply.checkpoint.json',
  applicationNamePrefix: 'fns-exact-okved',
  exactSource: 'fns_sme_registry',
  processPlanFiles: processFnsExactPlanFiles,
}).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
