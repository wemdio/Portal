/**
 * Worker runner for Docker: selects a specific worker kind.
 *
 * Usage:
 *  WORKER_KIND=hh|enghiring|search|enrich|yandexmaps|tgparser|
 *              tgtranscribe|saleschatlogger|saleschatarchive|innerenrich|websiteinnlookup|all (default: all)
 */

const kind = String(process.env.WORKER_KIND ?? 'all').trim().toLowerCase();

/**
 * libuv reads UV_THREADPOOL_SIZE once, when the pool is first used; here no
 * worker module has been loaded yet. VE2 runs up to 16 jobs whose website
 * reads resolve dead domains (getaddrinfo holds a pool thread until the
 * resolver gives up), while undici inflates every gzip database response on
 * the same pool: with the default 4 threads a body of a few dozen bytes waits
 * for as long as the pool stays busy (23.09.2026). An explicit value from the
 * environment wins.
 */
if ((kind === 'verticalenginev2' || kind === 'vertical-engine-v2') && !process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

function run(modulePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(modulePath);
}

switch (kind) {
  case 'hh':
    run('./hh');
    break;
  case 'enghiring':
  case 'eng-hiring':
    run('./engHiring');
    break;
  case 'polzaoutreach':
  case 'polza-outreach':
    run('./polzaOutreach');
    break;
  case 'search':
    run('./search');
    break;
  case 'enrich':
    run('./enrich');
    break;
  // Single-writer для website_enrichment_results_buffer. Запускается
  // отдельным docker-сервисом worker-enrich-coordinator (1 реплика),
  // активируется выставлением ENRICH_USE_BUFFER=true на scraper'ах.
  // См. lib/enrich/enrichBuffer.ts и worker/enrichCoordinator.ts.
  case 'enrichcoordinator':
  case 'enrich-coordinator':
    run('./enrichCoordinator');
    break;
  case 'yandexmaps':
    run('./yandexmaps');
    break;
  case 'googleparsers':
  case 'google-parsers':
    run('./googleparsers');
    break;
  case 'emailvalidation':
    run('./emailvalidation');
    break;
  case 'innerenrich':
  case 'inn-enrich':
    run('./innEnrich');
    break;
  case 'websiteinnlookup':
  case 'website-inn-lookup':
    run('./websiteInnLookup');
    break;
  case 'tgoutreach':
    run('./tgOutreach');
    break;
  case 'salescopilot':
    run('./salesCopilot');
    break;
  case 'salesaianalysis':
  case 'sales-ai-analysis':
    run('./salesAiAnalysis');
    break;
  case 'hypothesisengine':
  case 'hypothesis-engine':
    run('./hypothesisEngine');
    break;
  case 'verticalenginev2':
  case 'vertical-engine-v2':
    run('./verticalEngineV2');
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
  case 'byosend':
  case 'byo-send':
    run('./byoSend');
    break;
  case 'byoreplies':
  case 'byo-replies':
    run('./byoReplies');
    break;
  case 'sender':
    run('./sender');
    break;
  case 'saleschatlogger':
    run('./salesChatLogger');
    break;
  case 'saleschatarchive':
    run('./salesChatArchive');
    break;
  case 'clientreportexports':
  case 'client-report-exports':
    run('./clientReportExports');
    break;
  case 'all':
  default:
    run('./index');
    break;
}

