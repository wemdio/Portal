import {
  runExactOkvedApplyCli,
} from '@/lib/companiesDirectory/exactOkvedApplyCli';
import {
  processSbisExactPlanFiles,
} from '@/lib/companiesDirectory/sbisExactPlanFiles';

runExactOkvedApplyCli({
  argv: process.argv.slice(2),
  environment: process.env,
  output: process.stdout,
  planLabel: 'SBIS exact OKVED',
  databaseUrlEnvironmentVariable: 'SBIS_EXACT_IMPORT_DATABASE_URL',
  defaultCheckpointFile: '.sbis-exact-okved-apply.checkpoint.json',
  applicationNamePrefix: 'sbis-exact-okved',
  exactSource: 'sbis_registry',
  processPlanFiles: processSbisExactPlanFiles,
}).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
