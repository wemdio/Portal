/**
 * Worker runner for Docker: selects a specific worker kind.
 *
 * Usage:
 *  WORKER_KIND=hh|search|enrich|yandexmaps|tgparser|tgtranscribe|all (default: all)
 */

const kind = String(process.env.WORKER_KIND ?? 'all').trim().toLowerCase();

function run(modulePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(modulePath);
}

switch (kind) {
  case 'hh':
    run('./hh');
    break;
  case 'search':
    run('./search');
    break;
  case 'enrich':
    run('./enrich');
    break;
  case 'yandexmaps':
    run('./yandexmaps');
    break;
  case 'emailvalidation':
    run('./emailvalidation');
    break;
  case 'tgoutreach':
    run('./tgOutreach');
    break;
  case 'salescopilot':
    run('./salesCopilot');
    break;
  case 'aicaller':
    run('./aiCaller');
    break;
  case 'tgparser':
    run('./tgParser');
    break;
  case 'tgtranscribe':
    run('./tgTranscribe');
    break;
  case 'instantlyleads':
    run('./instantlyLeads');
    break;
  case 'outreach':
    run('./outreach');
    break;
  case 'lioutreach':
    run('./liOutreach');
    break;
  case 'baseconstructor':
    run('./baseConstructor');
    break;
  case 'all':
  default:
    run('./index');
    break;
}

