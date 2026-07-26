/**
 * Standalone CLI: парсит HH-вакансии по web-URL и сохраняет xlsx.
 *
 * Использование:
 *   node --env-file=../.env dist/workers/hhParseUrlCli.js "<url>" <output.xlsx> [--area <id>] [--no-employers]
 *
 * Требует:
 *   HH_ACCESS_TOKEN   OAuth Bearer для api.hh.ru/vacancies
 *   PROXY_URLS        JSON-массив прокси-URL (иначе HH забанит IP)
 *
 * Использует стандартный fetchVacancies из app/src/lib/parsers/hhParser.ts,
 * т.е. те же партиционирование по датам/OR-split, retry, backoff, ротацию
 * прокси, что и продовый парсер.
 *
 * --area <id> нужно, если URL содержит региональный subdomain (spb.hh.ru,
 * ivanovo.hh.ru и т.п.): parseHhSearchUrl умеет запомнить subdomain, но HH API
 * (в отличие от веб-поиска) не учитывает hostname — фильтр по региону нужно
 * передать явно через параметр area.
 */

import ExcelJS from 'exceljs';
import path from 'path';
import { fetchVacancies, parseHhSearchUrl, type HHVacancy } from '@/lib/parsers/hhParser';

function formatSalary(v: HHVacancy): string {
  const parts: string[] = [];
  if (v.salary_from !== undefined) parts.push(`от ${v.salary_from}`);
  if (v.salary_to !== undefined) parts.push(`до ${v.salary_to}`);
  const range = parts.join(' ');
  return v.salary_currency ? `${range} ${v.salary_currency}`.trim() : range;
}

async function saveXlsx(vacancies: HHVacancy[], outPath: string, meta: { url: string; found: number }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Portal HH parser CLI';
  wb.created = new Date();

  const ws = wb.addWorksheet('Vacancies');
  ws.columns = [
    { header: 'ID', key: 'vacancy_id', width: 10 },
    { header: 'Название', key: 'name', width: 40 },
    { header: 'URL вакансии', key: 'url', width: 45 },
    { header: 'Компания', key: 'company_name', width: 32 },
    { header: 'HH-компания', key: 'company_url', width: 40 },
    { header: 'Сайт компании', key: 'company_site_url', width: 32 },
    { header: 'Индустрии', key: 'industries', width: 40 },
    { header: 'Регион', key: 'area', width: 20 },
    { header: 'Зарплата', key: 'salary', width: 22 },
    { header: 'Опубликовано', key: 'published_at', width: 22 },
    { header: 'Описание компании', key: 'company_description', width: 60 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const v of vacancies) {
    ws.addRow({
      vacancy_id: v.vacancy_id,
      name: v.name,
      url: v.url,
      company_name: v.company_name,
      company_url: v.company_url ?? '',
      company_site_url: v.company_site_url ?? '',
      industries: v.industries.join(', '),
      area: v.area,
      salary: formatSalary(v),
      published_at: v.published_at ?? '',
      company_description: v.company_description ?? '',
    });
  }

  const info = wb.addWorksheet('Meta');
  info.columns = [
    { header: 'Ключ', key: 'k', width: 20 },
    { header: 'Значение', key: 'v', width: 120 },
  ];
  info.addRow({ k: 'url', v: meta.url });
  info.addRow({ k: 'found (HH)', v: meta.found });
  info.addRow({ k: 'saved rows', v: vacancies.length });
  info.addRow({ k: 'exported_at', v: new Date().toISOString() });

  await wb.xlsx.writeFile(outPath);
}

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let areaOverride: string | undefined;
  let fetchEmployers = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--area') { areaOverride = argv[++i]; continue; }
    if (a === '--no-employers') { fetchEmployers = false; continue; }
    positional.push(a);
  }
  const [urlArg, outArg] = positional;
  if (!urlArg) {
    console.error('Usage: node hhParseUrlCli.js "<hh search URL>" [output.xlsx] [--area <id>] [--no-employers]');
    process.exit(2);
  }

  const outPath = path.resolve(outArg ?? 'hh-vacancies.xlsx');

  const proxyCount = (() => {
    try {
      const arr = JSON.parse(process.env.PROXY_URLS ?? '[]');
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  })();

  console.log(`[hh-cli] URL       : ${urlArg}`);
  console.log(`[hh-cli] Output    : ${outPath}`);
  console.log(`[hh-cli] Proxies   : ${proxyCount}`);
  console.log(`[hh-cli] HH token  : ${process.env.HH_ACCESS_TOKEN ? 'set' : 'MISSING'}`);
  console.log('');

  const config = parseHhSearchUrl(urlArg);
  config.fetch_employers = fetchEmployers;
  if (areaOverride) {
    if (config.area && (Array.isArray(config.area) ? config.area.length : 1)) {
      console.log(`[hh-cli] --area ${areaOverride} перекрывает area из URL (${JSON.stringify(config.area)})`);
    }
    config.area = areaOverride;
  } else if (
    (!config.area || (Array.isArray(config.area) && config.area.length === 0)) &&
    config.subdomain &&
    config.subdomain !== 'hh'
  ) {
    console.warn(
      `[hh-cli] WARNING: URL с subdomain "${config.subdomain}.hh.ru", но area из него не резолвится. ` +
        `HH API не учитывает hostname — фильтр по региону будет ПУСТЫМ (найдёт по всей РФ). ` +
        `Передайте --area <id>.`,
    );
  }

  console.log('[hh-cli] Parsed config:');
  console.log('  text        =', config.text);
  console.log('  area        =', config.area);
  console.log('  subdomain   =', config.subdomain);
  console.log('  fetch_emp   =', config.fetch_employers);
  console.log('  extra params=', config.params);
  console.log('');

  const startedAt = Date.now();
  let lastReport = 0;

  const { found, vacancies } = await fetchVacancies(config, {
    jobId: 'cli',
    searchText: config.text,
    onStage: (stage) => console.log(`[hh-cli] stage: ${stage}`),
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastReport < 5_000) return;
      lastReport = now;
      const empPart = p.employersTotal
        ? ` | employers: ${p.employersFetched ?? 0}/${p.employersTotal}`
        : '';
      console.log(
        `[hh-cli] progress: found=${p.found ?? '?'} parsed=${p.parsed ?? 0} fetched=${p.fetched ?? 0}${empPart}`,
      );
    },
    onPartitionProgress: (info) => {
      console.log(
        `[hh-cli] partitions: ${info.completed_subqueries}/${info.total_subqueries}` +
          (info.current_subquery ? ` — cur: ${info.current_subquery}` : ''),
      );
    },
  });

  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`[hh-cli] Done in ${took}s. found=${found}, unique vacancies=${vacancies.length}`);

  await saveXlsx(vacancies, outPath, { url: urlArg, found });
  console.log(`[hh-cli] Saved → ${outPath}`);
}

main().catch((err) => {
  console.error('[hh-cli] FAILED:', err);
  process.exit(1);
});
