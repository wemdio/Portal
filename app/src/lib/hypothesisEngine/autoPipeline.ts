/**
 * ENG auto-pipeline Движка вертикалей: ежедневный тик добора лидов в уже
 * запущенные кампании us-проектов (аналог RU autoPipelineRunner поверх
 * HE-машинерии).
 *
 * Вызывается one-shot кроном app/worker/heAutoPipelineCron.ts. Один тик:
 *   1. enabled-конфиги he_auto_pipeline_configs, проект market='us';
 *   1-. ПАУЗА ПО ЁМКОСТИ: he_auto_pipeline_configs.refill_paused_at (миграция
 *      20260930_0005). Стоит — проект пропускается ЦЕЛИКОМ, до любых чтений и
 *      любых запросов к рассыльщику. Снимает её только человек кнопкой в
 *      staff-инструменте; подробности — в блоке «ПАУЗА ПО ЁМКОСТИ» ниже;
 *   2. вертикали проекта по created_at (стабильный порядок добора);
 *   3. вертикаль eligible, когда у неё есть шаблон с launch_info.campaign_id
 *      (последний по дате запуска) — есть куда доливать;
 *   2-. ДНЕВНОЙ БЮДЖЕТ ПРОЕКТА: сколько лидов на сегодняшние UTC-сутки ещё не
 *      занято бронями (he_refill_daily_budgets/he_refill_daily_reservations,
 *      миграция 20260930_0004 — тот же учёт, которым долив режет отправку).
 *      Ноль — сборку не получает НИ ОДНА вертикаль проекта: кап общий, а платит
 *      сборка. На ночном тике в 03:20 броней ещё нет, и проверка ничего не
 *      меняет; она про ВТОРОЙ за сутки прогон крона. Не прочиталось (нет
 *      миграции, нет прав, сбой) — работаем как раньше, обязательный fail-open;
 *   3-. СУХАЯ ВЕРТИКАЛЬ: серия ночей без единого добавленного контакта читается
 *      ИЗ ЖУРНАЛА he_auto_pipeline_runs ДО постановки сборки (см. блок «СУХАЯ
 *      ВЕРТИКАЛЬ» ниже). Дошла до he_auto_pipeline_configs.dry_nights_limit —
 *      слот не выдаётся и вертикаль помечается (he_verticals.refill_dry_*),
 *      пометку снимает клиент из кабинета. Правило выключено по умолчанию
 *      (флаг окружения HE_VERTICAL_DRY_STOP); без флага серия только считается
 *      в ночной лог;
 *   3a. ПРЕДПОЛЁТ ЁМКОСТИ: сколько контактов ещё принимает воркспейс
 *      рассыльщика. Ноль — сборка НЕ ставится (и остальные вертикали проекта
 *      тоже: воркспейс у них общий), потому что платит сборка, а не долив:
 *      краул сайтов и SMTP-пробы каждого адреса уходят ДО того, как долив
 *      упрётся в «нет места», и оплаченные компании при этом выжигаются из
 *      будущих сборок проекта. Ёмкость не определилась — работаем как раньше
 *      (обязательный fail-open: слепой предполёт, угадавший ноль, остановил бы
 *      продукт на ровном месте). Точный ноль вдобавок ЗАПИСЫВАЕТ durable-паузу
 *      проекта (шаг 1- выше) — иначе завтрашняя ночь спрашивала бы то же самое
 *      заново;
 *   4. постановка refill-сборки через общий enqueueHeBaseCollect (его же
 *      дедуп: уже собирающаяся auto-база / активная base_collect-джоба →
 *      'existing' и слот verticals_per_run НЕ расходуется): he_bases
 *      source='auto'/status='collecting' с filename «auto-refill: <вертикаль>
 *      · <дата>» и collect_info {limit, refill, campaign_id} + he_jobs
 *      base_collect с payload.refill;
 *   5. запись he_auto_pipeline_runs 'collecting' (финал запишет refill-ветка
 *      стадии по base_id); ошибка постановки — run 'failed' с base_id NULL;
 *   6. configs.last_run_at — по завершении обхода конфига (даже пустого).
 *
 * Дальше сборку и долив делает стадия base_collect (refill-ветка —
 * stages/baseCollectRefill.ts). Дедуп компаний при повторных сборах —
 * встроенный в HARVEST (исключение компаний других баз проекта), поэтому
 * refill поднимает только новые.
 *
 * ЧТО ЗАПИСЫВАЕТ БРОНЬ И КОГДА ЗАКРЫВАЕТСЯ (хендофф лейну ёмкости). Бронь
 * берёт САМ ДОЛИВ, а не этот тик: `stages/baseCollectRefill.ts`, шаг 5, один
 * вызов `he_reserve_refill_daily_budget(project, base, requested)` ДО первого
 * запроса к рассыльщику. Она пишет строку (проект, база, UTC-день,
 * reserved_count) и, если это первая бронь дня, замораживает кап дня из
 * `he_auto_pipeline_configs.daily_leads_cap`. Закрывается она в ТОМ ЖЕ прогоне,
 * после терминальной записи базы, фактическим расходом: принято при успехе,
 * max(принято, отдано в транспорт) при отказе, ноль при отказе до первого
 * запроса. Незакрытая бронь занимает весь свой объём до конца UTC-суток — для
 * всех, кроме СВОЕЙ ЖЕ базы: её новый прогон может забрать бронь, открытую
 * дольше двух часов (окно перехвата, миграция 20260930_0004), потому что
 * держатель за такой срок не может быть жив. Для ЭТОГО тика разницы нет:
 * остаток проекта он считает по всем броням, и зависшая продолжает занимать
 * объём, пока её не заберёт её же база или не кончатся сутки.
 * Отсюда правило для любой ПАУЗЫ: пауза, поставленная ПОСЛЕ брони, но ДО
 * отправки, не освобождает бюджет сама — освобождает только закрытие брони
 * нулём, и делать это имеет право только путь, который точно знает, что
 * провайдер строк не получил.
 *
 * Тарифная асимметрия ЗАКРЫТА на стороне вызывающего: `stages/baseCollectRefill.ts`
 * зовёт `appendLeadsToClientCampaign` с `entitlementMode: 'managed_contract'`
 * (доверенный серверный оркестратор), поэтому self-serve гейт к ночному доливу
 * не применяется — у ENG-клиента строка тарифа либо неактивна
 * (`api/signup/route.ts` ставит `is_active=false`), либо отсутствует, и раньше
 * это давало 403 «Подписка не активна» уже ПОСЛЕ оплаченного сбора, тогда как
 * ручной запуск ENG-кампании гейта не имеет вовсе (`TODO(tariffs)` в
 * `api/client/eng/templates/[id]/launch/route.ts`). Объём долива режет не тариф,
 * а дневной кап проекта `he_auto_pipeline_configs.daily_leads_cap`. Ветка по
 * рынку внутри общего биллинг-кода при этом НЕ появилась — решение принимает
 * вызывающий. Альтернатива на будущее (если ENG-пресеты станут провижиниться
 * централизованно): `agency_managed=true` у ENG-пресета вместо флага в вызове.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getWorkspaceContactCapacity } from '@/lib/instantly/client';
import { resolveClientInstantlyRequestOptions } from '@/lib/instantly/clientAccountOptions';
import type { InstantlyRequestOptions } from '@/lib/instantly/accounts';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';
import { parseLaunchInfo } from './launchHandoff';

/**
 * Потолок КОМПАНИЙ одной refill-сборки (на вертикаль за тик), а не строк — имя
 * константы старше разноса адресов по строкам. Уходит в payload.limit джобы, и
 * стадия считает его компаниями: после разноса одна компания даёт до
 * max_emails_per_company строк. Сколько компаний собрать на самом деле, стадия
 * ещё режет под остаток дневного капа (resolveHeRefillCollectCompanies,
 * stages/baseCollectRefill.ts), этот потолок — верхняя граница.
 */
export const HE_AUTO_REFILL_ROWS_LIMIT = 200;
/** Дефолт verticals_per_run — зеркало DEFAULT миграции 20260804_0005. */
export const HE_AUTO_DEFAULT_VERTICALS_PER_RUN = 3;

/* ─── СУХАЯ ВЕРТИКАЛЬ ─────────────────────────────────────────────────────
 *
 * ПРАВИЛО. Вертикаль перестаёт получать ночной слот, когда N подряд
 * ЗАВЕРШЁННЫХ refill-прогонов не добавили ни одного контакта.
 *
 * ЭТО НЕ КОПИЯ ПРАВИЛА V2, и скопировать его было нельзя: там решение стоит на
 * партиях по сто компаний, ключе источника и цели «столько-то адресов НА
 * КОМПАНИЮ», а здесь цель ночи измеряется СТРОКАМИ (daily_leads_cap) и
 * источник за ночь не один — их до четырёх в плане, и перемешивает их
 * interleaveTaskHarvests именно затем, чтобы один источник не съел весь проход.
 * Считать «сухость» по источнику здесь не на чем. Поэтому единица правила —
 * ВЕРТИКАЛЬ ЗА НОЧЬ, а источником истины служит журнал прогонов, который и так
 * пишется по каждой ночи.
 *
 * ЧТО СЧИТАЕТСЯ СУХОЙ НОЧЬЮ — по ВСЕМУ множеству состояний строки
 * he_auto_pipeline_runs, а не по тем, что удобно:
 *   * 'no_new' — ЕДИНСТВЕННЫЙ кандидат в сухую ночь. Означает «добавить
 *     нечего»: либо harvest пуст, либо строки собрались, но ни у одной нет
 *     допущенного адреса. Оба случая платные и оба ничего не приносят. НО
 *     засчитывается такая ночь только вместе со вторым условием — ниже.
 *   * 'no_new' с `stats.scan_complete !== true` — НЕ сухая ночь, серию
 *     ОБРЫВАЕТ. Ночь, вставшая по потолку страниц каталога, оборвавшаяся на
 *     середине страницы или с упавшей задачей, отдаёт тот же ноль, что и
 *     исчерпанный срез, — но повтор у неё продолжает с закладки и приносит
 *     строки. Признак пишет сама стадия долива (refillScanComplete в
 *     stages/baseCollectRefill.ts); ключа нет — значит ночь записал писатель,
 *     который об этом различии не знал, и приговор по ней не выносится.
 *   * 'appended' — серию ОБРЫВАЕТ, даже когда stats.appended = 0. Ноль там
 *     означает наш собственный отрез: дневной кап проекта (capped) или
 *     блок-лист владельца пресета (skipped_blocklist). Считать его сухой ночью
 *     значило бы заглушить вертикаль за наш бюджет и за выбор самого клиента.
 *   * 'failed' — серию ОБРЫВАЕТ и сухой ночью НЕ считается. Сбой конструктора,
 *     ошибка долива, отказ провайдера дают ровно этот статус, и про рынок он не
 *     говорит НИЧЕГО. Обрыв (а не «прозрачный пропуск») выбран сознательно: мы
 *     не знаем, что принесла бы та ночь, и цена ошибки в эту сторону — ещё
 *     несколько ночей сбора, то есть обратимая.
 *   * 'collecting' — прогон не завершён (идёт сейчас либо повис от упавшей
 *     стадии). В окно не попадает вовсе: вердикта у него нет.
 *   * строки без base_id — отказы САМОЙ постановки (нет места у рассыльщика,
 *     сбой enqueue). Сбора не было, про срез они молчат — в окно не попадают.
 *     Тот же отбор, что у refillFailStreak в stages/baseCollectRefill.ts.
 *
 * ПОЧЕМУ ПОРОГ ИЗ КОНФИГА. he_auto_pipeline_configs ПУСТ, ночной добор в
 * production не запускался ни разу — истории, по которой можно было бы выбрать
 * N, не существует. Порог поэтому живёт в
 * he_auto_pipeline_configs.dry_nights_limit (дефолт 7 = неделя), а само правило
 * выключено флагом HE_VERTICAL_DRY_STOP. С выключенным флагом проход серию
 * СЧИТАЕТ и печатает в ночной лог — это и есть материал, по которому порог
 * потом можно поставить не вслепую, — но слот не отнимает ни у кого и снимает
 * пометки, если они остались от включённого периода.
 *
 * ПОЧЕМУ ПОМЕТКА, А НЕ ПРОСТО ПРОПУСК. Молча пропущенная вертикаль неотличима
 * от поломки: клиент видит, что добор по ней встал, и не видит почему. Поэтому
 * решение записывается в he_verticals (refill_dry_since/refill_dry_nights),
 * едет в кабинет проекцией и снимается оттуда же кнопкой, которая ставит
 * refill_resumed_at — с него и начинается новое окно серии.
 *
 * ОТДЕЛЬНОЙ СТРОКИ ЖУРНАЛА пропуск НЕ пишет. В he_auto_pipeline_runs.status нет
 * значения для «решили не собирать», а писать 'failed' значило бы выдать
 * намеренную остановку за сбой — ровно то, из-за чего правило и обязано быть
 * видимым. Что произошло, объясняют пометка со штампом и строка ночного лога.
 */

/**
 * Флаг включения правила. По умолчанию ВЫКЛЮЧЕНО: порог без единого замера —
 * это уже случавшаяся ошибка, а цена молчаливой остановки вертикали выше цены
 * нескольких лишних ночей сбора.
 */
export const HE_VERTICAL_DRY_FLAG_ENV = 'HE_VERTICAL_DRY_STOP';

/** Дефолт dry_nights_limit — зеркало DEFAULT миграции 20260930_0003. */
export const HE_AUTO_DEFAULT_DRY_NIGHTS_LIMIT = 7;

/** Включено ли правило. Пустое/нераспознанное значение = выключено. */
export function heVerticalDryStopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[HE_VERTICAL_DRY_FLAG_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/* ─── ПАУЗА ПО ЁМКОСТИ ────────────────────────────────────────────────────
 *
 * ПРАВИЛО. У воркспейса рассыльщика кончилось место под контакты — ночной
 * добор ПРОЕКТА останавливается до явного возобновления СОТРУДНИКОМ.
 *
 * ПОЧЕМУ ПРОЕКТА, А НЕ ВЕРТИКАЛИ. Место меряется воркспейсом, а все вертикали
 * проекта живут в воркспейсе одного и того же клиента (пресет один на
 * client_user_id). Пауза по вертикали означала бы N одинаковых решений и N
 * одинаковых запросов к рассыльщику ради одного и того же ответа.
 *
 * СЧЁТЧИК ЁМКОСТИ ОБЩИЙ НА ВЕСЬ INSTANTLY-АККАУНТ. total_lead_limit и
 * current_lead_count из /workspace-billing/plan-details считаются по ВОРКСПЕЙСУ,
 * а не по кампании и не по клиенту: лиды RU-клиентов, сидящих в том же
 * аккаунте, входят в тот же знаменатель. ENG-проект поэтому может встать
 * из-за нагрузки, которую он не создавал, — и текст причины обязан называть
 * это прямо, иначе сотрудник будет искать поломку в ENG.
 *
 * КТО ЗАПИСЫВАЕТ ПАУЗУ — ДВА ПУТИ, И ОБА НУЖНЫ:
 *   * ПРЕДПОЛЁТ (ниже в этом файле): остаток ровно 0. Работает только пока
 *     ключ имеет право читать биллинг воркспейса;
 *   * ОТКАЗ САМОГО ДОЛИВА (stages/baseCollectRefill.ts): провайдер отказался
 *     принять строки по ёмкости. Работает ВСЕГДА, в том числе когда у ключа
 *     нет scope на биллинг и предполёт молчит, — это и есть требуемая
 *     деградация «ответ импорта авторитетен».
 * Без второго пути механизм имел бы дыру ровно по правам ключа: именно там,
 * где предполёт слеп, ночь за ночью покупалась бы сборка, которую некуда
 * отправить.
 *
 * ЧТО НЕ ЯВЛЯЕТСЯ ОСНОВАНИЕМ ДЛЯ ПАУЗЫ — по всему набору исходов предполёта:
 *   * null от getWorkspaceContactCapacity (403 без scope, 404, 429, 5xx,
 *     таймаут, нечитаемый ответ) — «не знаем». Паузу НЕ ставим;
 *   * ненайденный пресет, отсутствующая instantly-БД, сбой резолва аккаунта —
 *     то же «не знаем»;
 *   * положительный остаток любой величины — места мало, но оно есть; сколько
 *     влезет, столько долив и отправит (pauseOnWorkspaceCapacity в
 *     appendLeadsToClientCampaign грузит по месту, а не всё или ничего);
 *   * 402/тариф, 429 по частоте запросов, ошибка конструктора — это не
 *     ёмкость, у них свои ветки.
 * Пауза ставится ТОЛЬКО по доказанному нулю. Цена ошибки в эту сторону —
 * проект спит, пока человек не вернёт его; цена ошибки в другую — ночь платной
 * сборки, которую некуда отправить.
 *
 * ПОЧЕМУ БЕЗ ФЛАГА ОКРУЖЕНИЯ (в отличие от правила сухой вертикали). У сухой
 * вертикали есть ПОРОГ, выбранный без единого замера, — там флаг защищает от
 * неверного числа. Здесь порога нет: условие бинарное и приходит от самого
 * рассыльщика. Флаг, выключенный по умолчанию, означал бы механизм, которого
 * в дефолтной конфигурации нет, — а в докблоке он при этом описан.
 *
 * ПОЧЕМУ ВОЗОБНОВЛЕНИЕ — У СОТРУДНИКА, А НЕ У КЛИЕНТА. Возобновление запускает
 * платную работу у провайдера; мутирующая ручка в кабинете отдала бы клиенту
 * право начинать её. Кнопка живёт в staff-инструменте
 * (POST /api/tools/hypothesis-engine/projects/[id]/refill-pause) — там же, где
 * сотрудник и увидел бы переполненный воркспейс.
 *
 * АВТОСНЯТИЯ ПО ТАЙМЕРУ НЕТ. Пауза, снявшаяся сама, вернёт проект в тот же
 * воркспейс: если место не освободили — та же платная сборка заново, и никто
 * не узнал. Это и есть разница между «паузой» и «пропуском одной ночи».
 *
 * НОЧЬ ПОД ПАУЗОЙ НЕ СЧИТАЕТСЯ НИГДЕ. Строки he_auto_pipeline_runs пропуск не
 * пишет (в status нет значения «решили не собирать», а 'failed' выдал бы
 * намеренную экономию за сбой), поэтому ни серия сухих ночей
 * (readDryNightStreak), ни серия отказов вертикали (refillFailStreak в
 * stages/baseCollectRefill.ts) на паузе не растут: обе читают только
 * ЗАВЕРШЁННЫЕ прогоны. Это осознанно — пауза наша, а не рынка, и наказывать за
 * неё вертикаль нечем.
 */

/**
 * Первая половина текста причины — то, что сотрудник обязан прочитать раньше
 * всего: счётчик общий на весь воркспейс. Вторая половина (кто записал) —
 * в buildHeCapacityPauseReason.
 */
export const HE_CAPACITY_PAUSE_WORKSPACE_NOTE =
  'Instantly: в воркспейсе кончилось место под контакты. Счётчик общий на весь ' +
  'instantly-аккаунт — в него входят лиды других клиентов, в том числе RU, ' +
  'поэтому ENG-проект мог встать из-за чужой нагрузки.';

/**
 * Текст причины паузы для сотрудника. `source` — кто именно её записал: без
 * него «предполёт увидел ноль» и «провайдер отказал на доливе» выглядят
 * одинаково, а это разные проверки (вторая работает и без права читать
 * биллинг) и разная цена уже потраченного.
 *
 * Текст СТАФФНЫЙ и по-русски: колонка refill_pause_reason не проецируется в
 * ENG-кабинет ни одним маршрутом (client/eng/dashboard выбирает из конфига
 * только project_id, enabled, daily_leads_cap, verticals_per_run, last_run_at).
 */
export function buildHeCapacityPauseReason(source: string): string {
  return `${HE_CAPACITY_PAUSE_WORKSPACE_NOTE} Ночной добор остановлен до явного возобновления сотрудником. Записал: ${source}.`;
}

/** Состояние паузы проекта — ВЕСЬ набор, который умеет вернуть чтение. */
export type HeRefillPauseState =
  /** Колонок паузы нет (миграция 20260930_0005 не прокатана). */
  | { kind: 'unsupported' }
  /** Конфига добора у проекта нет вовсе — останавливать нечего. */
  | { kind: 'no_config' }
  | { kind: 'active'; pausedAt: string; reason: string | null; resumedAt: string | null }
  | { kind: 'running'; resumedAt: string | null };

/** Исход попытки возобновления — тот же полный набор плюс сам успех. */
export type HeRefillResumeOutcome = 'resumed' | 'not_paused' | 'no_config' | 'unsupported';

/**
 * Записать паузу по ёмкости. Возвращает true, только если паузу поставил
 * ИМЕННО ЭТОТ вызов.
 *
 * Идемпотентна по построению: условие `refill_paused_at is null` не даёт
 * второй записи переписать штамп и причину первой. Это важно не ради красоты —
 * штамп первой паузы отвечает на вопрос «сколько ночей проект стоит», а
 * причина первой называет того, кто заметил переполнение раньше всех.
 *
 * НИКОГДА НЕ БРОСАЕТ. Не записалось (нет колонок, нет конфига, сбой БД) —
 * паузы нет, и вызывающий ведёт себя как до этой правки: пропускает ночь и
 * пробует снова завтра. Из двух исходов этот обратимый; брошенная отсюда
 * ошибка уронила бы либо обход конфига в кроне, либо терминальную запись
 * долива.
 *
 * Конфига у проекта может не быть вовсе (таблица пуста, refill поставлен
 * руками) — тогда строк ноль и пауза не ставится. Это верно: без конфига
 * ночного тика у проекта и нет, останавливать нечего.
 */
export async function pauseHeAutoPipelineRefill(
  supabase: SupabaseClient,
  projectId: string,
  reason: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = (opts.now ?? new Date()).toISOString();
  try {
    const { data, error } = await supabase
      .from('he_auto_pipeline_configs')
      .update({ refill_paused_at: now, refill_pause_reason: reason, updated_at: now })
      .eq('project_id', projectId)
      .is('refill_paused_at', null)
      .select('id');
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Прочитать состояние паузы проекта. Для staff-роута: он обязан различать
 * «паузы нет», «конфига нет» и «колонок нет» — иначе кнопка молчала бы
 * одинаково во всех трёх случаях, и сотрудник не понял бы, чинить ему
 * окружение или разбирать воркспейс.
 *
 * БРОСАЕТ только на настоящем сбое БД: staff-роут отвечает на него 500, и это
 * правильно — читающая ручка, которая врёт «не на паузе» при сбое чтения,
 * хуже пятисотки.
 */
export async function readHeRefillPause(
  supabase: SupabaseClient,
  projectId: string,
): Promise<HeRefillPauseState> {
  const { data, error } = await supabase
    .from('he_auto_pipeline_configs')
    .select('refill_paused_at, refill_pause_reason, refill_resumed_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return { kind: 'unsupported' };
    throw new Error(`he_auto_pipeline_configs pause read: ${error.message}`);
  }
  if (!data) return { kind: 'no_config' };
  const row = data as Record<string, unknown>;
  const pausedAt = asStringOrNull(row.refill_paused_at);
  const resumedAt = asStringOrNull(row.refill_resumed_at);
  if (!pausedAt) return { kind: 'running', resumedAt };
  return { kind: 'active', pausedAt, reason: asStringOrNull(row.refill_pause_reason), resumedAt };
}

/**
 * Вернуть проект в ночной добор — ЕДИНСТВЕННЫЙ способ снять паузу по ёмкости.
 *
 * `refill_resumed_at` ставится тем же апдейтом: без него «возобновили вчера» и
 * «никогда не паузили» выглядят в таблице одинаково, а первая ночь после
 * возобновления — единственная, по которой видно, что кнопка вообще работает.
 * На решения тика этот штамп не влияет (в отличие от одноимённого у вертикали,
 * где он режет окно серии): паузу снимает сам факт refill_paused_at = null, а
 * истории, которая вернула бы её следующей ночью, у паузы нет.
 *
 * Условие `refill_paused_at is not null` отделяет настоящее возобновление от
 * повторного нажатия: во втором случае вернётся 'not_paused', и роут не
 * сделает вид, что что-то изменил.
 *
 * Права и рынок здесь НЕ проверяются: это делает вызывающий staff-роут
 * (requireInternalToolAuth).
 */
export async function resumeHeRefillPause(
  supabase: SupabaseClient,
  projectId: string,
  opts: { now?: Date } = {},
): Promise<HeRefillResumeOutcome> {
  const now = (opts.now ?? new Date()).toISOString();
  const { data, error } = await supabase
    .from('he_auto_pipeline_configs')
    .update({
      refill_paused_at: null,
      refill_pause_reason: null,
      refill_resumed_at: now,
      updated_at: now,
    })
    .eq('project_id', projectId)
    .not('refill_paused_at', 'is', null)
    .select('id');
  if (error) {
    if (isMissingColumnError(error)) return 'unsupported';
    throw new Error(`he_auto_pipeline_configs resume: ${error.message}`);
  }
  if ((data ?? []).length > 0) return 'resumed';
  // Ноль строк — либо паузы не было, либо конфига нет вовсе. Различает их
  // отдельное чтение: сотруднику это разные ответы («уже работает» против
  // «ночной добор этому проекту не настроен»).
  const state = await readHeRefillPause(supabase, projectId);
  return state.kind === 'no_config' ? 'no_config' : state.kind === 'unsupported' ? 'unsupported' : 'not_paused';
}

export type HeAutoPipelineDetailStatus =
  | 'enqueued'
  | 'existing'
  | 'no_campaign'
  | 'capacity_blocked'
  | 'budget_exhausted'
  | 'paused'
  | 'dry'
  | 'failed';

/**
 * Текст отказа предполёта — БЛИЗНЕЦ REFILL_CAPACITY_NOTE в
 * stages/baseCollectRefill.ts (там тот же отказ, но на этапе долива). Общая
 * подстрока «лимит контактов воркспейса» — единственный якорь, по которому
 * причину узнаёт клиентский классификатор (clientErrors.classifyHeClientError);
 * менять формулировку — сразу в обоих местах и вместе с его правилом.
 * Импортом константу не тянем осознанно: stages/baseCollectRefill.ts тащит за
 * собой всю стадию сборки (коллекторы, конструктор) в бандл крона.
 */
const CAPACITY_REFUSAL_ERROR =
  'Instantly: лимит контактов воркспейса исчерпан — сборка не ставилась, деньги не потрачены';

export interface HeAutoPipelineTickDetail {
  configId: string;
  projectId: string;
  verticalId?: string;
  baseId?: string | null;
  status: HeAutoPipelineDetailStatus;
  /**
   * Длина серии ночей без добавленного контакта на момент решения. Ставится
   * ВСЕГДА, когда серию удалось прочитать, — в том числе при выключенном
   * правиле и при постановке сборки: это единственный материал, по которому
   * порог dry_nights_limit можно будет выбрать по факту, а не на глаз. Нет
   * ключа — историю прочитать не удалось (тогда решение принимается как при
   * нулевой серии, см. readDryNightStreak).
   */
  dryNights?: number;
  message?: string;
}

export interface HeAutoPipelineTickSummary {
  /** Enabled-конфиги us-проектов, обработанные за тик. */
  configs: number;
  enqueued: number;
  /** Вертикаль уже собирается (дедуп enqueueHeBaseCollect) — слот не расходуется. */
  existing: number;
  /** У вертикали нет запущенной кампании — слот не расходуется. */
  noCampaign: number;
  /**
   * Вертикалей, которым отказал предполёт ёмкости: у рассыльщика нет места под
   * новые контакты, сборка не поставлена и ничего не оплачено. НЕ считается
   * failed: это штатный отказ, а не сбой тика, и ронять exit code крона каждую
   * ночь переполненного воркспейса нечем полезным (причина видна в логе,
   * в he_auto_pipeline_runs и в счётчике ниже).
   */
  capacityBlocked: number;
  /**
   * ПРОЕКТОВ, у которых дневной бюджет лидов на сегодняшние UTC-сутки уже
   * занят бронями: сборка не ставится ни одной их вертикали. Считается
   * ПРОЕКТАМИ, а не вертикалями, потому что кап общий на проект.
   *
   * НЕ failed и не capacityBlocked: это намеренная экономия (платит сборка, а
   * бюджет всё равно не даст отправить). На обычном ночном тике счётчик
   * нулевой — в 03:20 броней ещё нет; он бьёт по ВТОРОМУ за сутки прогону
   * крона, ради которого и написан.
   */
  budgetExhausted: number;
  /**
   * ПРОЕКТОВ, чей ночной добор стоит на durable-паузе по ёмкости воркспейса
   * (he_auto_pipeline_configs.refill_paused_at). Считается ПРОЕКТАМИ: пауза
   * общая на проект, потому что воркспейс у его вертикалей один.
   *
   * НЕ failed и не capacityBlocked. capacityBlocked — это СЕГОДНЯШНЕЕ
   * наблюдение предполёта (запрос к рассыльщику был, ответ ноль); paused —
   * решение, принятое РАНЬШЕ, из-за которого сегодня не было даже запроса.
   * Слить их в один счётчик значило бы потерять ровно то различие, ради
   * которого пауза и заведена.
   */
  paused: number;
  /**
   * Вертикалей, которым слот не выдан правилом сухой вертикали. НЕ failed и не
   * capacityBlocked: это намеренная экономия, а не отказ. Считается только при
   * включённом HE_VERTICAL_DRY_STOP — с выключенным флагом правило ничего не
   * отнимает и счётчик остаётся нулём.
   */
  dry: number;
  failed: number;
  details: HeAutoPipelineTickDetail[];
}

interface ConfigRow {
  id: string;
  project_id: string;
  verticals_per_run: number | null;
  /** null — колонки ещё нет (миграция не прокатана) либо значение нечитаемо. */
  dry_nights_limit: number | null;
  /**
   * NOT NULL ⇒ проект на паузе по ёмкости и сборку сегодня не получает.
   * null — паузы нет ЛИБО колонки ещё нет: оба случая ведут к прежней работе
   * (см. CONFIG_OPTIONAL_COLUMNS), и это единственный безопасный fail-open —
   * пауза, померещившаяся из-за непрокатанной миграции, усыпила бы продукт.
   */
  refill_paused_at: string | null;
  /** Причина паузы для ночного лога; null — пауза без текста либо её нет. */
  refill_pause_reason: string | null;
}

interface VerticalRow {
  id: string;
  name: string;
  created_at: string | null;
  /** Пометка сухой вертикали; null — пометки нет либо колонок ещё нет. */
  refill_dry_since: string | null;
  /** Длина серии, записанная вместе с пометкой (для ночного лога). */
  refill_dry_nights: number | null;
  refill_resumed_at: string | null;
}

/**
 * Колонки вертикали со стороны правила сухости. Отдельной строкой, потому что
 * при отсутствующей миграции запрос с ними падает целиком (PostgREST 42703), а
 * это стоило бы НОЧИ ВСЕМ проектам ради выключенного по умолчанию правила —
 * см. loadVerticals.
 */
const VERTICAL_DRY_COLUMNS = 'refill_dry_since, refill_dry_nights, refill_resumed_at';

/**
 * Колонки конфига, которых может не быть на окружении (та же причина, см.
 * loadConfigs): порог сухости (20260930_0003) и пауза по ёмкости
 * (20260930_0005).
 *
 * Группа ОДНА на обе миграции осознанно. Читать их двумя независимыми
 * запросами значило бы удвоить чтение конфигов ради окна в несколько минут
 * между двумя накатами, а исход у обеих недостающих колонок один и тот же —
 * прежнее поведение: без dry_nights_limit порог берётся из кода, без
 * refill_paused_at паузы просто нет. Обе стороны безопасны: непрочитанная
 * пауза = проект собирается, как собирался до неё.
 */
const CONFIG_OPTIONAL_COLUMNS = 'dry_nights_limit, refill_paused_at, refill_pause_reason';

/**
 * Ошибка PostgREST «колонки нет» (Postgres 42703). Ровно она отделяет
 * «миграция ещё не прокатана» от настоящего сбоя БД, и только её мы глушим.
 */
function isMissingColumnError(error: { code?: string } | null): boolean {
  return error?.code === '42703';
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Куда доливать вертикаль: кампания и пресет её последнего запуска. */
interface VerticalLaunchTarget {
  campaignId: string;
  /**
   * Пресет запуска: через него (client_user_id → instantly_account_id) ведёт
   * единственный путь к воркспейсу, в который долив реально пишет, — тот же,
   * что резолвит appendLeadsToClientCampaign. Предполёт ёмкости обязан спросить
   * ИМЕННО его, иначе он мерил бы чужой (дефолтный) воркспейс.
   */
  presetId: string;
}

/**
 * Карта «вертикаль → кампания и пресет» по шаблонам с launch_info: на вертикаль —
 * ПОСЛЕДНИЙ по дате запуска (force-перезапуск перезаписывает launch_info;
 * доливать надо в актуальную кампанию).
 */
function latestCampaignByVertical(
  templateRows: Array<Record<string, unknown>>,
): Map<string, VerticalLaunchTarget> {
  const best = new Map<string, VerticalLaunchTarget & { ts: number }>();
  for (const row of templateRows) {
    const launch = parseLaunchInfo(row.launch_info);
    if (!launch) continue;
    const verticalId = asString(row.vertical_id);
    if (!verticalId) continue;
    const ts =
      Date.parse(launch.created_at) ||
      Date.parse(asString(row.created_at)) ||
      0;
    // При сплите запуска по сегментам долив идёт ТОЛЬКО в основную кампанию
    // (segment=null) — новые лиды refill по сегментам не классифицированы;
    // сплит без основной кампании вертикаль пропускает (доливать некуда).
    const campaignId = launch.campaigns?.length
      ? launch.campaigns.find((c) => c.segment === null)?.campaign_id
      : launch.campaign_id;
    if (!campaignId) continue;
    const current = best.get(verticalId);
    if (!current || ts >= current.ts) {
      best.set(verticalId, { campaignId, presetId: launch.preset_id, ts });
    }
  }
  return new Map(
    [...best.entries()].map(([k, v]) => [k, { campaignId: v.campaignId, presetId: v.presetId }]),
  );
}

/**
 * Сколько контактов ещё принимает воркспейс рассыльщика: число — точный
 * остаток, null — «не знаем».
 */
type HeWorkspaceCapacityProbe = (presetId: string) => Promise<number | null>;

/**
 * Предполёт ёмкости на один тик.
 *
 * Запрос к рассыльщику — ОДИН на воркспейс за тик (мемоизация по аккаунту), а
 * не один на вертикаль: все вертикали одного проекта живут в воркспейсе своего
 * клиента (пресет — один на client_user_id), и переспрашивать то же самое
 * значило бы тратить общий rate-limit ради одинакового ответа.
 *
 * null — «не знаем», и это ОБЯЗАТЕЛЬНО не «ноль»: ключ без права читать биллинг
 * воркспейса, таймаут, 429/5xx у провайдера, нечитаемый ответ, ненайденный
 * пресет и отсутствующая instantly-БД дают именно null, после чего тик работает
 * как до этой правки. Предполёт, который угадывает ноль, останавливает продукт;
 * предполёт, который угадывает «место есть», в худшем случае возвращает нас к
 * прежнему поведению (отказ на доливе, где его уже умеют ставить на паузу).
 */
function createHeWorkspaceCapacityProbe(): HeWorkspaceCapacityProbe {
  const optionsByPreset = new Map<string, Promise<InstantlyRequestOptions | null>>();
  const remainingByAccount = new Map<string, Promise<number | null>>();

  const optionsFor = (presetId: string): Promise<InstantlyRequestOptions | null> => {
    const cached = optionsByPreset.get(presetId);
    if (cached) return cached;
    const pending = (async () => {
      if (!supabaseInstantly) return null;
      const { data, error } = await supabaseInstantly
        .from('client_campaign_presets')
        .select('client_user_id')
        .eq('id', presetId)
        .maybeSingle();
      if (error) throw new Error(`client_campaign_presets read: ${error.message}`);
      const userId = (data as { client_user_id?: unknown } | null)?.client_user_id;
      if (typeof userId !== 'string' || !userId) return null;
      // Тот же резолв, которым долив выбирает аккаунт (DRY, по client_user_id).
      return resolveClientInstantlyRequestOptions(userId);
    })();
    optionsByPreset.set(presetId, pending);
    return pending;
  };

  return async (presetId) => {
    if (!presetId) return null;
    try {
      const options = await optionsFor(presetId);
      if (!options) return null;
      const accountKey = options.accountId ?? '';
      const cached = remainingByAccount.get(accountKey);
      if (cached) return await cached;
      const pending = getWorkspaceContactCapacity(options).then((c) => c?.remaining ?? null);
      remainingByAccount.set(accountKey, pending);
      return await pending;
    } catch {
      // Любая неопределённость — «не знаем». Текст ошибки не логируем здесь:
      // вызывающий и без него работает как раньше, а шумная строка каждую ночь
      // у клиентов без права на биллинг-чтение прятала бы настоящие отказы.
      return null;
    }
  };
}

/**
 * Вертикали проекта. Колонки пометки читаются ОПЦИОНАЛЬНО: воркер может уехать
 * раньше миграции 20260930_0003, и тогда запрос с ними отвечает 42703 — а это
 * уронило бы весь ночной тик (ошибка чтения = фейл обхода конфига) ради
 * правила, которое по умолчанию выключено. Без колонок пометки просто нет:
 * вертикаль считается непомеченной, серия всё равно считается, а записать
 * решение не выйдет (writeDryMark вернёт false и слот будет выдан).
 */
async function loadVerticals(
  supabase: SupabaseClient,
  projectId: string,
): Promise<VerticalRow[]> {
  const base = 'id, name, created_at';
  let rows: Array<Record<string, unknown>> | null = null;
  const first = await supabase
    .from('he_verticals')
    .select(`${base}, ${VERTICAL_DRY_COLUMNS}`)
    .eq('project_id', projectId);
  if (first.error && !isMissingColumnError(first.error)) {
    throw new Error(`he_verticals read: ${first.error.message}`);
  }
  if (first.error) {
    const retry = await supabase.from('he_verticals').select(base).eq('project_id', projectId);
    if (retry.error) throw new Error(`he_verticals read: ${retry.error.message}`);
    rows = (retry.data ?? []) as Array<Record<string, unknown>>;
  } else {
    rows = (first.data ?? []) as Array<Record<string, unknown>>;
  }
  return rows.map((row) => ({
    id: asString(row.id),
    name: asString(row.name),
    created_at: asStringOrNull(row.created_at),
    refill_dry_since: asStringOrNull(row.refill_dry_since),
    refill_dry_nights: asNumberOrNull(row.refill_dry_nights),
    refill_resumed_at: asStringOrNull(row.refill_resumed_at),
  }));
}

/**
 * Сколько ЗАВЕРШЁННЫХ refill-прогонов вертикали подряд не добавили ни одного
 * контакта. Полный разбор состояний — в блоке «СУХАЯ ВЕРТИКАЛЬ» выше.
 *
 * Окно чтения — `limit + 1` строк: решение бинарное («серия достигла порога или
 * нет»), а лишняя строка отличает «ровно на пороге» от «длиннее» в логе.
 * Возвращаемое число поэтому НИКОГДА не больше limit + 1, и это не длина всей
 * истории. Тот же приём, что у refillFailStreak (stages/baseCollectRefill.ts).
 *
 * `resumedAt` — момент, с которого клиент попросил считать заново: прогоны
 * старше него в окно не идут, иначе снятая пометка вернулась бы той же ночью.
 *
 * НИКОГДА НЕ БРОСАЕТ: непрочитанная история = null («не знаем»), и вызывающий
 * трактует это как «серии нет». Из двух исходов этот обратимый — лишняя ночь
 * сбора против вертикали, заглушенной нашим же сбоем чтения.
 */
async function readDryNightStreak(
  supabase: SupabaseClient,
  vertical: VerticalRow,
  limit: number,
): Promise<number | null> {
  try {
    let query = supabase
      .from('he_auto_pipeline_runs')
      .select('status, stats')
      .eq('vertical_id', vertical.id)
      // Отбор делает запрос, а не JS: пропускаемые строки (отказы постановки
      // без base_id, незавершённые 'collecting') иначе занимали бы место в
      // окне и серия читалась бы короче, чем она есть.
      .not('base_id', 'is', null)
      .neq('status', 'collecting')
      .not('completed_at', 'is', null);
    if (vertical.refill_resumed_at) {
      query = query.gt('completed_at', vertical.refill_resumed_at);
    }
    const { data, error } = await query
      .order('completed_at', { ascending: false })
      .limit(limit + 1);
    if (error) throw new Error(error.message);
    let streak = 0;
    for (const row of (data ?? []) as Array<{ status?: unknown; stats?: unknown }>) {
      // Любой исход, кроме 'no_new', серию обрывает — включая 'failed'
      // (наш сбой) и 'appended' с нулём (наш кап либо блок-лист клиента).
      if (row.status !== 'no_new') break;
      // ...и 'no_new' ночи, у которой каталог остался недочитанным: её ноль
      // про наш предохранитель, а не про источник.
      const stats = row.stats as { scan_complete?: unknown } | null | undefined;
      if (stats?.scan_complete !== true) break;
      streak += 1;
    }
    return streak;
  } catch {
    return null;
  }
}

/**
 * Записать или снять пометку сухой вертикали. Возвращает false, если записать
 * не удалось (нет колонок, сбой БД).
 *
 * ПОЧЕМУ ЭТО ВАЖНО ИМЕННО РЕЗУЛЬТАТОМ. Пропуск, о котором не осталось следа в
 * he_verticals, — это молча пропавший добор: в кабинете ничего, у клиента
 * никакой кнопки, у поддержки никакого объяснения. Поэтому не записалось —
 * значит решение не принято, и вертикаль идёт в сборку как раньше.
 */
async function writeDryMark(
  supabase: SupabaseClient,
  verticalId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.from('he_verticals').update(patch).eq('id', verticalId);
  return !error;
}

/**
 * Вернуть вертикаль в ночной добор: снять пометку и открыть НОВОЕ окно серии.
 *
 * Единственный способ отменить решение правила, и он же — обработчик кнопки
 * кабинета (POST /api/client/eng/verticals/[id]/refill). `refill_resumed_at`
 * обязателен: без него следующая же ночь прочитала бы ту же самую историю из N
 * пустых прогонов и поставила пометку обратно, то есть кнопка ничего бы не
 * меняла.
 *
 * Рынок и владелец здесь НЕ проверяются: это делает вызывающий роут
 * (requireEngMarket + loadClientHeVertical).
 */
export async function resumeHeVerticalNightlyRefill(
  supabase: SupabaseClient,
  verticalId: string,
  opts: { now?: Date } = {},
): Promise<void> {
  const now = (opts.now ?? new Date()).toISOString();
  const { error } = await supabase
    .from('he_verticals')
    .update({ refill_dry_since: null, refill_dry_nights: null, refill_resumed_at: now })
    .eq('id', verticalId);
  if (error) throw new Error(`he_verticals refill resume: ${error.message}`);
}

/**
 * Сколько лидов дневной бюджет проекта ещё разрешает отправить СЕГОДНЯ (UTC).
 *
 * Источник — брони (`he_refill_daily_budgets` + `he_refill_daily_reservations`,
 * миграция 20260930_0004), то есть ровно тот же учёт, которым долив режет
 * отправку (reserveRefillDailyBudget в stages/baseCollectRefill.ts): открытая
 * бронь занимает весь свой объём, завершённая — фактический расход. Второго
 * определения «потрачено» тут не заводится.
 *
 * ВОЗРАСТ БРОНИ ЗДЕСЬ НЕ УЧИТЫВАЕТСЯ, и это совпадает с доливом: перехватить
 * зависшую бронь имеет право только СВОЯ ЖЕ база (окно в два часа), а для
 * суммы проекта такая бронь занята до конца суток. Иначе тик покупал бы сборку
 * под объём, который долив всё равно не выдаст.
 *
 * Зачем тику знать остаток. Платит СБОРКА (план источников, гейт, краул сайтов,
 * SMTP-проба каждого адреса), а бюджет режет уже ОТПРАВКУ: поставить сборку
 * проекту, чей день выбран, значит заплатить за компании, строки которых
 * бюджет выбросит, и выжечь эти компании из будущих сборок. На обычном ночном
 * тике этого не бывает — в 03:20 броней нет, — но второй за сутки прогон крона
 * (ручной перезапуск, повтор после сбоя) без этой проверки покупает ночь
 * заново.
 *
 * `null` — «не знаем, считаем что бюджет цел», и это ЕДИНСТВЕННОЕ значение для
 * всех неопределённостей: миграции нет, прав нет, сбой чтения, а также штатное
 * «сегодня ещё не бронировали» (строки капа за этот день нет). Все они обязаны
 * вести к прежнему поведению: предполёт, угадавший ноль, останавливает продукт.
 */
async function readRefillDayRemaining(
  supabase: SupabaseClient,
  projectId: string,
  now: Date,
): Promise<number | null> {
  const day = now.toISOString().slice(0, 10);
  try {
    const budget = await supabase
      .from('he_refill_daily_budgets')
      .select('daily_cap')
      .eq('project_id', projectId)
      .eq('budget_date', day)
      .maybeSingle();
    if (budget.error) throw new Error(budget.error.message);
    const cap = asNumberOrNull((budget.data as { daily_cap?: unknown } | null)?.daily_cap);
    // Кап дня не заморожен — значит сегодня не было ни одной брони, тратить
    // нечего. Это не «не знаем», но исход тот же: бюджет цел.
    if (cap === null) return null;
    const reservations = await supabase
      .from('he_refill_daily_reservations')
      .select('reserved_count, consumed_count, finalized_at')
      .eq('project_id', projectId)
      .eq('budget_date', day);
    if (reservations.error) throw new Error(reservations.error.message);
    let spent = 0;
    for (const row of (reservations.data ?? []) as Array<Record<string, unknown>>) {
      const open = asStringOrNull(row.finalized_at) === null;
      const amount = asNumberOrNull(open ? row.reserved_count : row.consumed_count);
      if (amount !== null) spent += amount;
    }
    return Math.max(0, cap - spent);
  } catch {
    return null;
  }
}

/** Запись журнала прогонов; ошибка вставки — фейл обхода конфига. */
async function insertRun(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('he_auto_pipeline_runs').insert(row);
  if (error) throw new Error(`he_auto_pipeline_runs insert: ${error.message}`);
}

/**
 * Enabled-конфиги добора. CONFIG_OPTIONAL_COLUMNS читаются ОПЦИОНАЛЬНО по той
 * же причине, что и колонки пометки у вертикалей (см. loadVerticals): воркер
 * может уехать раньше миграций 20260930_0003/0005, а 42703 здесь уронил бы
 * весь ночной тик. Колонок нет — порог берётся из кода, а паузы по ёмкости
 * просто не существует.
 *
 * `enabled=false` конфиги сюда не попадают вовсе — и паузу им поэтому не
 * ставят и не снимают. Это верно: выключенный добор и без паузы ничего не
 * собирает, а снятие паузы не должно включать добор тому, кто выключил его сам.
 */
async function loadConfigs(supabase: SupabaseClient): Promise<ConfigRow[]> {
  const base = 'id, project_id, verticals_per_run';
  let rows: Array<Record<string, unknown>>;
  const first = await supabase
    .from('he_auto_pipeline_configs')
    .select(`${base}, ${CONFIG_OPTIONAL_COLUMNS}`)
    .eq('enabled', true);
  if (first.error && !isMissingColumnError(first.error)) {
    throw new Error(`he_auto_pipeline_configs read: ${first.error.message}`);
  }
  if (first.error) {
    const retry = await supabase.from('he_auto_pipeline_configs').select(base).eq('enabled', true);
    if (retry.error) throw new Error(`he_auto_pipeline_configs read: ${retry.error.message}`);
    rows = (retry.data ?? []) as Array<Record<string, unknown>>;
  } else {
    rows = (first.data ?? []) as Array<Record<string, unknown>>;
  }
  return rows.map((row) => ({
    id: asString(row.id),
    project_id: asString(row.project_id),
    verticals_per_run: asNumberOrNull(row.verticals_per_run),
    dry_nights_limit: asNumberOrNull(row.dry_nights_limit),
    refill_paused_at: asStringOrNull(row.refill_paused_at),
    refill_pause_reason: asStringOrNull(row.refill_pause_reason),
  }));
}

async function runForConfig(
  supabase: SupabaseClient,
  config: ConfigRow,
  now: Date,
  summary: HeAutoPipelineTickSummary,
  capacityProbe: HeWorkspaceCapacityProbe,
): Promise<void> {
  const detail = (d: Omit<HeAutoPipelineTickDetail, 'configId' | 'projectId'>) => {
    summary.details.push({ configId: config.id, projectId: config.project_id, ...d });
  };

  /**
   * «Тик этот конфиг обошёл». Одно определение на оба выхода из функции —
   * обычный и ранний (пауза по ёмкости): под паузой добор не идёт, но обход
   * СОСТОЯЛСЯ, и last_run_at, застывший на дате паузы, читался бы как
   * сломавшийся крон.
   */
  const touchLastRun = async () => {
    const { error } = await supabase
      .from('he_auto_pipeline_configs')
      .update({ last_run_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', config.id);
    if (error) throw new Error(`he_auto_pipeline_configs last_run_at: ${error.message}`);
  };

  const dryStopEnabled = heVerticalDryStopEnabled();

  /**
   * Правило сухой вертикали выключено — снимаем пометки СО ВСЕГО ПРОЕКТА, и
   * делаем это РАНЬШЕ проверки паузы.
   *
   * Порядок важен: под паузой по ёмкости мы из функции выходим, и снятие,
   * стоящее после неё, не выполнилось бы НИ РАЗУ, пока проект стоит. Кабинет
   * продолжал бы писать «ночной добор по вертикали остановлен» про правило,
   * которое выключено. Статья расхода — один UPDATE, который в норме не
   * трогает ни строки (фильтр по непустой пометке).
   *
   * Внутри цикла вертикалей этого делать нельзя по отдельной причине: до
   * вертикали можно не дойти (бюджет ночи, пропавшая кампания), и она хранила
   * бы пометку вечно.
   */
  if (!dryStopEnabled) {
    await supabase
      .from('he_verticals')
      .update({ refill_dry_since: null, refill_dry_nights: null })
      .eq('project_id', config.project_id)
      .not('refill_dry_since', 'is', null);
  }

  // ─── ПАУЗА ПО ЁМКОСТИ (раньше всех решений: до чтения вертикалей и
  //     шаблонов, до бюджета, до рассыльщика, до денег) ───
  // Решение принято в прошлую ночь и записано в конфиге; перепроверять его
  // сегодняшним запросом к рассыльщику нельзя — ровно этот «автоматический
  // пересмотр» и превратил бы паузу обратно в пропуск одной ночи. Снимает её
  // только сотрудник (resumeHeRefillPause, staff-роут refill-pause).
  // Своей строки he_auto_pipeline_runs пропуск НЕ пишет — та же причина, что у
  // budget_exhausted и dry: в status нет значения «решили не собирать», а
  // 'failed' выдал бы намеренную остановку за сбой. И ровно поэтому ночь под
  // паузой не растит ни серию сухих ночей, ни серию отказов вертикали.
  if (config.refill_paused_at) {
    summary.paused += 1;
    detail({
      status: 'paused',
      message: `nightly refill paused since ${config.refill_paused_at}`
        + (config.refill_pause_reason ? ` — ${config.refill_pause_reason}` : ''),
    });
    // Что именно произошло, объясняют строка ночного лога и сама пометка со
    // штампом; last_run_at при этом двигается как у любого обойдённого конфига.
    await touchLastRun();
    return;
  }

  // Сортировка в JS (created_at asc): стабильный порядок добора вертикалей.
  const verticals = (await loadVerticals(supabase, config.project_id))
    .slice()
    .sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''));

  let campaignByVertical = new Map<string, VerticalLaunchTarget>();
  if (verticals.length > 0) {
    const { data: templateRows, error: tErr } = await supabase
      .from('he_templates')
      .select('vertical_id, launch_info, created_at')
      .in('vertical_id', verticals.map((v) => v.id))
      .not('launch_info', 'is', null);
    if (tErr) throw new Error(`he_templates read: ${tErr.message}`);
    campaignByVertical = latestCampaignByVertical((templateRows ?? []) as Array<Record<string, unknown>>);
  }

  const perRun = Math.max(1, config.verticals_per_run ?? HE_AUTO_DEFAULT_VERTICALS_PER_RUN);
  const dryLimit = Math.max(1, config.dry_nights_limit ?? HE_AUTO_DEFAULT_DRY_NIGHTS_LIMIT);
  const dateTag = now.toISOString().slice(0, 10);
  let enqueued = 0;

  // Снятие пометок выключенного правила сухой вертикали стоит ВЫШЕ, до
  // проверки паузы: иначе под паузой оно не выполнялось бы ни разу (см. там же
  // разбор обоих ограничений на его место).

  // ─── ДНЕВНОЙ БЮДЖЕТ ПРОЕКТА (до сухой вертикали, до ёмкости, до денег) ───
  // Кап общий на проект, поэтому и решение общее: выбран — ни одной вертикали
  // сборку не ставим. Проверка идёт ПЕРВОЙ из трёх, потому что она про
  // проект целиком, а две следующие — про вертикаль. Своей строки журнала
  // прогонов пропуск НЕ пишет: в he_auto_pipeline_runs.status нет значения для
  // «решили не собирать», а 'failed' выдал бы намеренную экономию за сбой (та
  // же причина, что у правила сухой вертикали).
  const dayRemaining = verticals.length === 0
    ? null
    : await readRefillDayRemaining(supabase, config.project_id, now);
  const budgetExhausted = dayRemaining === 0;
  if (budgetExhausted) {
    summary.budgetExhausted += 1;
    detail({ status: 'budget_exhausted', message: `daily lead budget for ${dateTag} is fully reserved` });
  }

  for (const vertical of budgetExhausted ? [] : verticals) {
    if (enqueued >= perRun) break;
    const target = campaignByVertical.get(vertical.id);
    if (!target) {
      summary.noCampaign += 1;
      detail({ verticalId: vertical.id, status: 'no_campaign' });
      continue;
    }
    const { campaignId } = target;

    // ─── СУХАЯ ВЕРТИКАЛЬ (до предполёта, до постановки, до денег) ───
    // Правило и разбор состояний — в блоке «СУХАЯ ВЕРТИКАЛЬ» вверху файла.
    // Идёт ПЕРВЫМ из двух отказов: чтение журнала своё и дешёвое, а предполёт
    // ёмкости — запрос к рассыльщику из общего rate-limit, и тратить его на
    // вертикаль, которую мы всё равно не собираем, незачем.
    if (dryStopEnabled && vertical.refill_dry_since) {
      // Решение уже записано — журнал ради него не перечитываем. Пометка это и
      // есть решение со своим числом ночей; отменяет его клиент кнопкой
      // (resumeHeVerticalNightlyRefill), а не следующее чтение истории. Иначе
      // сбой чтения или поднятый порог молча возвращали бы платные ночи, а
      // фраза кабинета («… — N daily refills in a row brought no new
      // contacts», EngStepVerticals.tsx) перестала бы совпадать с тем, что
      // происходит.
      summary.dry += 1;
      detail({
        verticalId: vertical.id,
        status: 'dry',
        ...(vertical.refill_dry_nights === null ? {} : { dryNights: vertical.refill_dry_nights }),
      });
      continue;
    }
    // Пометки выключенного правила сняты выше, разом по проекту: снимать их
    // здесь значило бы не снять у вертикали, до которой цикл не дошёл.
    // Серия считается ВСЕГДА, включая выключённое правило: это единственный
    // материал, по которому порог потом выбирается по факту (см. dryNights в
    // HeAutoPipelineTickDetail).
    const dryStreak = await readDryNightStreak(supabase, vertical, dryLimit);
    const dryNightsDetail = dryStreak === null ? {} : { dryNights: dryStreak };
    if (dryStopEnabled && dryStreak !== null && dryStreak >= dryLimit) {
      // Записать решение обязаны ДО пропуска: пропуск без пометки — это добор,
      // пропавший без объяснения (см. writeDryMark). Не записалось — решения
      // нет, вертикаль идёт в сборку как раньше.
      const marked = await writeDryMark(supabase, vertical.id, {
        refill_dry_since: now.toISOString(),
        refill_dry_nights: dryStreak,
      });
      if (marked) {
        summary.dry += 1;
        detail({ verticalId: vertical.id, status: 'dry', ...dryNightsDetail });
        continue;
      }
    }

    // ─── ПРЕДПОЛЁТ ЁМКОСТИ ВОРКСПЕЙСА (до постановки, до денег) ───
    // Платит СБОРКА: краул сайтов и SMTP-проба каждого адреса уходят задолго до
    // долива, и раньше «нет места у рассыльщика» обнаруживалось только на
    // append'е — после оплаты и с выжженными компаниями. Ноль остатка — не
    // ставим и не тратим; null («не знаем») — работаем как раньше, отказ поймает
    // пауза долива (stages/baseCollectRefill.ts).
    const remainingCapacity = await capacityProbe(target.presetId);
    if (remainingCapacity === 0) {
      summary.capacityBlocked += 1;
      detail({ verticalId: vertical.id, status: 'capacity_blocked', ...dryNightsDetail });
      // Ноль ДОКАЗАН (число пришло от самого рассыльщика, а не угадано) —
      // записываем durable-паузу проекта, иначе завтрашняя ночь спросит то же
      // самое заново и так каждую ночь, пока место не освободится. null
      // («не знаем») сюда не доходит по условию выше — это ключевое: пауза
      // ставится только по доказанному нулю.
      //
      // Best-effort: не записалось (нет колонок, нет конфига, сбой) — ведём
      // себя как до этой правки, то есть пропускаем ночь и пробуем завтра.
      // Пишем ДО insertRun: строка журнала — объяснение, а деньги экономит
      // пауза, и терять её из-за сбоя вставки журнала незачем.
      await pauseHeAutoPipelineRefill(
        supabase,
        config.project_id,
        buildHeCapacityPauseReason('ночной предполёт ёмкости (остаток 0)'),
        { now },
      );
      await insertRun(supabase, {
        config_id: config.id,
        project_id: config.project_id,
        vertical_id: vertical.id,
        // base_id NULL — сбора не было. Это же отличает отказ ПОСТАНОВКИ от
        // отказа среза: серию отказов вертикали (refillFailStreak, решает,
        // возвращать ли компании в пул) считают только строки с base_id.
        base_id: null,
        status: 'failed',
        stats: { error_kind: 'instantly_capacity' },
        error: CAPACITY_REFUSAL_ERROR,
        completed_at: now.toISOString(),
      });
      // Остальные вертикали проекта — в том же воркспейсе: пресет один на
      // client_user_id, а все запуски проекта идут от одного клиента. Спрашивать
      // по каждой одно и то же и писать ей такую же строку журнала незачем.
      break;
    }

    const result = await enqueueHeBaseCollect(supabase, {
      verticalId: vertical.id,
      projectId: config.project_id,
      verticalName: vertical.name,
      limit: HE_AUTO_REFILL_ROWS_LIMIT,
      hypothesisIds: null,
      filename: `auto-refill: ${vertical.name} · ${dateTag}`,
      refill: { campaignId },
    });
    if (!result.ok) {
      summary.failed += 1;
      detail({ verticalId: vertical.id, status: 'failed', message: result.message, ...dryNightsDetail });
      await insertRun(supabase, {
        config_id: config.id,
        project_id: config.project_id,
        vertical_id: vertical.id,
        base_id: null,
        status: 'failed',
        error: result.message.slice(0, 500),
        completed_at: now.toISOString(),
      });
      continue;
    }
    if (!result.created) {
      // Уже собирается (ручной запуск или вчерашний refill) — слот не ест.
      summary.existing += 1;
      detail({
        verticalId: vertical.id,
        baseId: asString(result.base.id) || null,
        status: 'existing',
        ...dryNightsDetail,
      });
      continue;
    }

    enqueued += 1;
    summary.enqueued += 1;
    const baseId = asString(result.base.id);
    await insertRun(supabase, {
      config_id: config.id,
      project_id: config.project_id,
      vertical_id: vertical.id,
      base_id: baseId,
      status: 'collecting',
    });
    detail({
      verticalId: vertical.id,
      baseId,
      status: 'enqueued',
      // Серия пустых ночей на момент постановки: с ней ночной лог отвечает на
      // вопрос «насколько эта вертикаль близка к порогу», не заходя в БД.
      ...dryNightsDetail,
      // Остаток ёмкости в строке журнала крона — доказательство, что предполёт
      // действительно отработал (а не молча деградировал в «не знаем»): для
      // первой ночи под присмотром это единственный способ отличить одно от
      // другого, не заходя в рассыльщик.
      ...(remainingCapacity === null ? {} : { message: `workspace capacity ${remainingCapacity}` }),
    });
  }

  // Тик по конфигу отработал (даже без новых постановок) — фиксируем.
  await touchLastRun();
}

/**
 * Один тик ENG auto-pipeline. Ошибки чтения конфигов/проектов — фатальны
 * (бросок, крон выйдет с кодом 1); ошибки обхода отдельного конфига изолированы
 * (summary.failed + detail), остальные конфиги продолжаются.
 */
export async function runHeAutoPipelineTick(
  supabase: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<HeAutoPipelineTickSummary> {
  const now = opts.now ?? new Date();
  const summary: HeAutoPipelineTickSummary = {
    configs: 0,
    enqueued: 0,
    existing: 0,
    noCampaign: 0,
    capacityBlocked: 0,
    budgetExhausted: 0,
    paused: 0,
    dry: 0,
    failed: 0,
    details: [],
  };

  const configs = (await loadConfigs(supabase)).filter((c) => c.id && c.project_id);
  if (configs.length === 0) return summary;

  // Только us-проекты: добор идёт в ENG-кампании (RU-поток покрывает
  // client_auto_pipeline_*).
  const { data: projectRows, error: projectsErr } = await supabase
    .from('he_projects')
    .select('id, market')
    .in('id', configs.map((c) => c.project_id));
  if (projectsErr) throw new Error(`he_projects read: ${projectsErr.message}`);
  const usProjectIds = new Set(
    ((projectRows ?? []) as Array<{ id?: unknown; market?: unknown }>)
      .filter((p) => p.market === 'us')
      .map((p) => asString(p.id)),
  );
  const eligible = configs.filter((c) => usProjectIds.has(c.project_id));
  summary.configs = eligible.length;

  // Предполёт ёмкости — один на тик: мемоизация внутри держит один запрос к
  // рассыльщику на воркспейс, сколько бы конфигов и вертикалей тик ни обошёл.
  const capacityProbe = createHeWorkspaceCapacityProbe();

  for (const config of eligible) {
    try {
      await runForConfig(supabase, config, now, summary, capacityProbe);
    } catch (e) {
      summary.failed += 1;
      summary.details.push({
        configId: config.id,
        projectId: config.project_id,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summary;
}
