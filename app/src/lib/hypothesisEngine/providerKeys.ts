/**
 * Свои ключи провайдеров для ENG (P-A-separate-provider-keys, решение
 * владельца 10.10.2026). ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНЫ: пока переменные не заданы
 * (пусто или переменной нет — это дефолт), каждый вызов идёт по общему ключу,
 * как до правки.
 *
 *  - HE_US_REQUESTY_API_KEY — ключ Requesty для вызовов модели
 *    (llm.ts → getApiKey в rawCall: единственный fetch к роутеру в V1);
 *  - HE_US_SERPER_API_KEY — ключ Serper для поиска
 *    (stages/searchIo.ts → defaultSearch: единственный вызов Serper в V1).
 *
 * ЧЬЯ РАБОТА. Только работа по проекту he_projects.market = 'us': признак тот
 * же, что у журнала расхода ENG (costTelemetry.ts, heProviderJournalMarket) —
 * журнал открывается только для 'us'. Открывают его воркер вокруг стадии
 * (worker/hypothesisEngine.ts → runHeStage) и оба роута запуска шаблона вокруг
 * ядра запуска (классификатор сегментов): клиентский
 * api/client/eng/templates/[id]/launch и staff
 * api/tools/hypothesis-engine/templates/[id]/launch. Ночной крон
 * (worker/heAutoPipelineCron.ts) провайдеров сам не зовёт — он ставит джобы,
 * их исполняет воркер под журналом.
 *
 * Без журнала — общий ключ, ровно как до правки, и эти переменные даже не
 * читаются: RU-проекты, verticalEngineV2, CLI-скрипты, staff-структуризация
 * кейсов (api/tools/hypothesis-engine/projects/[id]/cases) и staff-запуск,
 * у которого роут не прочитал рынок проекта. Общий ключ: у Requesty —
 * OPENROUTER_HYPOTHESIS_ENGINE_API_KEY, иначе OPENROUTER_BRIEF_API_KEY (в
 * воркере движка первую заранее подменяет HE_OPENROUTER_API_KEY, если он
 * задан); у Serper — SERPER_API_KEY.
 *
 * ОТКАТА НА ОБЩИЙ КЛЮЧ ПРИ ОТКАЗЕ НЕТ. Свой ключ задан, а провайдер его
 * отверг (кончились деньги, ключ отклонён) — вызов падает тем же классом
 * отказа, что и раньше по общему ключу. Повтор по общему ключу тратил бы
 * общий баланс, от которого ENG и отделяют.
 *
 * Serper считает кредиты на АККАУНТ: второй ключ того же аккаунта баланс не
 * разделяет, для отдельного баланса нужен отдельный аккаунт Serper.
 *
 * Значение ключа не логируется: в лог процесса один раз уходит только ИМЯ
 * переменной и задана ли она (noteKeyChoice).
 */

import { heProviderJournalMarket } from './costTelemetry';

export const HE_US_REQUESTY_KEY_ENV = 'HE_US_REQUESTY_API_KEY';
export const HE_US_SERPER_KEY_ENV = 'HE_US_SERPER_API_KEY';

export type HeUsProviderKeyEnv = typeof HE_US_REQUESTY_KEY_ENV | typeof HE_US_SERPER_KEY_ENV;

/** Уже сказанное в лог этим процессом: «переменная | задана ли». */
const choiceLogged = new Set<string>();

/**
 * Один раз на процесс сказать, по какому ключу идёт работа проектов 'us':
 * так после выката видно в логе контейнера, что переменная дошла. Только имя.
 */
function noteKeyChoice(env: HeUsProviderKeyEnv, set: boolean): void {
  const key = `${env}|${set}`;
  if (choiceLogged.has(key)) return;
  choiceLogged.add(key);
  console.info(
    set
      ? `[he-keys] проекты market=us: свой ключ ${env}`
      : `[he-keys] проекты market=us: ${env} не задан — общий ключ`,
  );
}

/**
 * Свой ключ ENG для текущего вызова — или undefined, и тогда вызывающий берёт
 * общий ключ, как до правки. Не undefined только под журналом проекта 'us' и
 * при непустой переменной; вне журнала переменная не читается.
 */
export function heUsProviderKey(env: HeUsProviderKeyEnv): string | undefined {
  if (heProviderJournalMarket() !== 'us') return undefined;
  const key = (process.env[env] ?? '').trim();
  noteKeyChoice(env, key.length > 0);
  return key || undefined;
}
