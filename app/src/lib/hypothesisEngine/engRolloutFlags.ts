/**
 * Выключатели выпуска трёх доработок ENG-кабинета (план
 * docs/handoff/2026-10-16-eng-countries/implementation-plan.md, F5). Все три по
 * умолчанию ВЫКЛЮЧЕНЫ и включаются после того, как каждый контейнер работает на
 * новой сборке (старый воркер молча проигнорировал бы список стран, старый
 * читатель чёрного списка упал бы на доменной записи). Соглашение значений —
 * как у HE_ENG_DNC_REMOVE (engDncRemoval.ts).
 */

const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

function flagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return ON_VALUES.has((env[name] ?? '').trim().toLowerCase());
}

/** Запись списка стран проекта (клиент, создание проекта, staff). Замок сборки соблюдает сохранённый список всегда. */
export function heEngCollectCountriesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env, 'HE_ENG_COLLECT_COUNTRIES');
}

/** Добавление доменов в Do not contact ENG-клиента. Читатели доменных записей работают всегда. */
export function heEngDncDomainsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env, 'HE_ENG_DNC_DOMAINS');
}

/** Полный список поясов рассыльщика в выборе окна отправки (timezone_options). */
export function heEngTimezonesAllEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env, 'HE_ENG_TIMEZONES_ALL');
}
