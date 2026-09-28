/**
 * «Отправить в запуск»: из готового шаблона «Движка вертикалей» создать
 * кампанию в Instantly НА ПАУЗЕ (никогда не активируем — сотрудник проверяет
 * её в Instantly сам) и загрузить лидов базы. Один запуск на шаблон: повтор
 * только с force (создаёт НОВУЮ paused-кампанию и перезаписывает launch_info).
 *
 * ИСКЛЮЧЕНИЕ — НЕЗАКОНЧЕННЫЙ ЗАПУСК (с 28.09.2026, шаг 6). При сплите по
 * сегментам кампаний создаётся несколько, и отказ поздней группы оставлял
 * созданные кампании без записи о них: повтор создавал каждому уже уехавшему
 * сегменту ВТОРУЮ одноимённую кампанию, а ёмкость воркспейса тратилась дважды.
 * Теперь кампания попадает в launch_info СРАЗУ, как узнан её id, недоехавшие
 * сегменты записываются в launch_info.pending, и такой запуск:
 *   - повтор НЕ блокирует (409 остаётся только у законченного запуска);
 *   - повтор ДОСТРАИВАЕТ: кампания, которая уже приняла адреса, не трогается
 *     вовсе; пустая — переиспользуется (адреса, уже лежащие у рассыльщика, он
 *     пропускает сам); заново создаются только сегменты, у которых кампании нет.
 * Законченный запуск ведёт себя как до 28.09.2026 (force = новые кампании), и
 * записи без ключа pending — все, что есть в RU-инструменте, — считаются
 * законченными.
 *
 * ЧЕМ ЭТО НАЖИМАЕТСЯ (28.09.2026, там же). Механика достройки сама по себе была
 * недостижима из кабинета: шаг «Review & Launch» считал запускаемым шаблон без
 * ЛЮБОЙ записи о запуске, а частичный запуск запись оставляет — кнопка
 * пропадала ровно тогда, когда нужна. Вход теперь тот же, что и у первого
 * запуска: «Launch all (paused)» берёт и шаблоны с НЕЗАКОНЧЕННОЙ записью
 * (components/client-eng/EngStepReview.tsx), новой кнопки для этого не
 * появилось. Признак кабинет получает из той же записи — `launch_info.pending`
 * теперь проходит проекцию (clientEngProjection.ts, LAUNCH_PENDING_FIELDS), и
 * предикат один на оба конца: heLaunchIsIncomplete. Повтор идёт БЕЗ force
 * (см. шаг 1) и идемпотентен: сегмент, чья кампания уже приняла адреса, не
 * трогается вовсе, поэтому лишнее нажатие ничего не создаёт и никому не пишет.
 *
 * Ядро вынесено из POST api/tools/hypothesis-engine/templates/[id]/launch —
 * клиентский ENG-контур (api/client/eng/templates/[id]/launch) делегирует
 * сюда же, отличия только в обвязке роута:
 *   - scopeClientUserId: пресет читается со скоупом владельца (у staff —
 *     service-level read любого пресета по id, см. launchHandoff.ts);
 *   - locale: тексты ошибок RU (staff-UI) / EN (клиентский кабинет);
 *   - eventPrefix: имена событий logAudit/logError своего контура.
 * Имя кампании от контура НЕ зависит: оно выбирается по рынку проекта (шаг 4b),
 * потому что клиент видит его в своём рассыльщике, кто бы запуск ни нажал.
 *
 * Тарифных гейтов и журнала client_campaign_launches тут нет осознанно (см.
 * launchHandoff.ts): запуск HE-шаблона billing клиента не меняет.
 *
 * Три предохранителя стоят ДО первого вызова рассыльщика и все fail-closed —
 * ни один адрес не должен уехать «на всякий случай» (шаги 4c, 5 и 5a):
 *   - запуск с базы us-проекта, собранной до обязательного разноса адресов по
 *     строкам, не состоится: её вердикт валидации может принадлежать другому
 *     адресу той же компании (шаг 4c);
 *   - вердикт валидации почты обязателен у market='us': строка без вердикта
 *     лидом не становится;
 *   - чёрный список контактов клиента применяется в ОБОИХ контурах; не
 *     прочитался — запуск не состоялся.
 * ЧТО ИЗ ЭТОГО ВИДИТ RU-ИНСТРУМЕНТ (он же ежедневный staff-инструмент): только
 * чёрный список — он про получателя и не зависит от рынка. Требование вердикта
 * и отказ по легаси-сборке скоупнуты на 'us': RU-базы собираются без разноса
 * адресов и законно бывают без вердиктов, а запрещать сотруднику привычный
 * запуск никто не просил. Взамен RU получает счёт таких строк вслух.
 * Сколько строк сняли эти предохранители (и сколько RU отправил без вердикта),
 * уходит в warnings ответа (их показывает и staff-UI, и — после сужения
 * роутом — ENG-кабинет) и в аудит.
 *
 * ПОТОЛОК ЗАПУСКА (HE_LAUNCH_MAX_LEADS) считает АДРЕСА, а число клиента —
 * КОМПАНИИ, и после разноса адресов по строкам это уже не одно и то же: 2000
 * компаний при капе 5 адресов дают до 10 000 строк. У market='us' запуск такую
 * базу больше НЕ ОТКЛОНЯЕТ (шаг 5b): уезжают лучшие адреса — сначала по одному
 * на каждую компанию, потом вторые, — а сколько компаний и адресов уехало и
 * сколько снял потолок, говорят предупреждение ответа и аудит. RU-инструмент
 * по-прежнему получает 413 (шаг 5b): там строка = компания (split_emails в
 * RU-списке шагов нет), у staff-UI на этот случай свой пречек и свой ответ
 * «скачайте CSV и запускайте порциями» (Step5Template.tsx). Сам пречек с этой
 * правкой РАСХОДИТСЯ с запуском у us-проекта, открытого сотрудником: он гасит
 * кнопку по row_count базы, не спрашивая рынок. Правило вынесено одной функцией
 * heLaunchRefusesOverCap (launchHandoff.ts) — компонент чужой, постановка на его
 * правку в отчёте лейна.
 *
 * Материализация 15% (сегментные варианты): если у писем шаблона есть
 * segment_variants, строки базы классифицируются по условиям сегментов
 * (segmentClassify, bulk-модель) и запуск сплитится — одна paused-кампания
 * на сегмент с текстами его вариантов + основная с дефолтными текстами.
 * Системный сбой классификатора → легаси-путь: одна кампания, варианты
 * выкинуты с явным предупреждением. launch_info.campaigns хранит весь
 * список; скалярные поля — основная кампания (их читает refill-долив).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { hasUsableCampaignSequences } from '@/lib/clientLaunch/campaignSequences';
import { filterBlockedLeads, getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { createCampaign, createLeads, updateCampaign } from '@/lib/instantly/client';
import { isInstantlyContactCapacityError } from '@/lib/instantly/errors';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError } from '@/lib/loggerServer';
import type { HeBase, HeTemplate } from './types';
import { classifyBaseRowsIntoSegments, detectSegmentLanguage } from './segmentClassify';
import { projectMarket, type HeMarket } from './market';
import {
  HE_ENG_CAMPAIGN_NAMING,
  HE_LAUNCH_MAX_LEADS,
  buildLaunchCampaignName,
  buildLaunchSequence,
  findEmailColumn,
  heConstructContactCap,
  heLaunchEmailVerdict,
  heLaunchIsIncomplete,
  heLaunchRefusesOverCap,
  instantlyCampaignUrl,
  mapBaseRowsToLeads,
  parseLaunchInfo,
  segmentVariantsWarning,
  selectLeadsWithinLaunchCap,
  type HeTemplateLaunchCampaign,
  type HeTemplateLaunchInfo,
  type HeTemplateLaunchPending,
} from './launchHandoff';

export type HeLaunchLocale = 'ru' | 'en';

interface HeLaunchMessages {
  templateNotFound: string;
  templateNotReady: string;
  alreadyLaunched: string;
  baseNotFound: string;
  presetLoadFailed: string;
  presetNotFound: string;
  noLetters: string;
  noEmailColumn: string;
  noValidEmails: string;
  /** Все строки отсеял гейт вердиктов: база не проверена — отправлять нечего. */
  baseNotVerified: (unverified: number) => string;
  /** База us-проекта собрана до разноса адресов: вердикт может быть чужим. */
  baseCollectedBeforeSplit: string;
  /** Чёрный список клиента не прочитался — запуск не состоялся (fail-closed). */
  blocklistLoadFailed: string;
  /** Весь остаток аудитории оказался в чёрном списке клиента. */
  allContactsBlocked: string;
  tooManyLeads: (count: number) => string;
  /**
   * Потолок сработал как ВЫБОР, а не отказ (market='us', шаг 5b): что уехало и
   * что снято. Четыре числа, потому что клиенту важны оба измерения — компании
   * и адреса, — и обе стороны потолка.
   */
  launchCapTrimmedNote: (
    companiesSent: number,
    addressesSent: number,
    addressesHeldBack: number,
    companiesHeldBack: number,
  ) => string;
  segmentSplitInfo: (campaignsCount: number) => string;
  rowsSkippedNote: (invalid: number, irrelevant: number) => string;
  unverifiedSkippedNote: (unverified: number) => string;
  /** RU: строки без вердикта ОТПРАВЛЕНЫ (как до 26.09.2026) — назвать вслух. */
  unverifiedSentNote: (unverified: number) => string;
  unparsedEmailNote: (multiAddress: number, malformed: number) => string;
  blockedContactsNote: (blocked: number) => string;
  instantlyFailedFallback: string;
  zeroAccepted: string;
  launchInfoSaveWarning: string;
  segmentVariantsWarning: (dropped: number, lettersCount: number) => string;
  /** Рассыльщик подтвердил МЕНЬШЕ адресов, чем мы отправили (шаг 6). */
  partialImportNote: (requested: number, accepted: number) => string;
  /** Повтор: кампании, уже принявшие адреса, оставлены как есть. */
  relaunchKeptCampaignsNote: (kept: number) => string;
  /** Повтор: пустые кампании прошлой попытки дозаполнены вместо дублей. */
  relaunchRefilledCampaignsNote: (refilled: number) => string;
  /** Повтор: сколько кампаний создано СЕЙЧАС (сегментам, у которых их не было). */
  relaunchCreatedCampaignsNote: (created: number) => string;
  /** Место под контакты в воркспейсе кончилось — остальные сегменты не создавались. */
  capacityStopNote: (segments: number) => string;
}

const MESSAGES: Record<HeLaunchLocale, HeLaunchMessages> = {
  ru: {
    templateNotFound: 'Шаблон не найден',
    templateNotReady: 'Шаблон ещё не готов — запуск возможен после статуса «Готов»',
    alreadyLaunched: 'Шаблон уже отправлен в запуск. Повторный — только с force: true.',
    baseNotFound: 'База не найдена',
    presetLoadFailed: 'Не удалось загрузить пресет',
    presetNotFound: 'Пресет не найден',
    noLetters: 'У шаблона нет писем для запуска',
    noEmailColumn: 'В базе не найдена колонка с email',
    noValidEmails: 'В базе нет валидных email-адресов',
    baseNotVerified: (unverified) =>
      'Запуск остановлен: в базе нет ни одного адреса с вердиктом валидации. ' +
      `Строк без вердикта: ${unverified.toLocaleString('ru-RU')}, а непроверенный адрес в рассылку не идёт ` +
      '(баунсы ложатся на домен отправителя). ' +
      'Пересоберите базу так, чтобы конструктор дошёл до шага валидации почт.',
    baseCollectedBeforeSplit:
      'Запуск остановлен: база us-проекта собрана до 26.09.2026, когда конструктор ещё не разносил ' +
      'адреса по строкам (шага split_emails в джобе не было). ' +
      'Валидация в такой сетке ставила ОДИН вердикт на всю склеенную ячейку — лучший из её адресов, — ' +
      'а в базу импортирован первый адрес ячейки: «ok» на строке может принадлежать другому адресу. ' +
      'Отправлять по такой базе нельзя, вердикт не проверить постфактум. ' +
      'Пересоберите базу (новая сборка держит один адрес на строку со своим вердиктом) и запустите снова.',
    blocklistLoadFailed:
      'Не удалось прочитать чёрный список клиента — запуск остановлен до создания кампании. ' +
      'Повторите попытку; если ошибка повторяется, это инцидент доступа к базе.',
    allContactsBlocked: 'Все адреса базы в чёрном списке клиента — отправлять некому.',
    tooManyLeads: (count) =>
      `Слишком много лидов для запуска из мастера: ${count.toLocaleString('ru-RU')}. Максимум — ${HE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')}`,
    // Достижим у us-проекта, запущенного сотрудником из RU-инструмента: гейт и
    // выборку по потолку задаёт рынок ПРОЕКТА, а язык текстов — контур.
    launchCapTrimmedNote: (companiesSent, addressesSent, addressesHeldBack, companiesHeldBack) =>
      `Потолок одного запуска — ${HE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')} адресов, ` +
      'поэтому отправлено не всё: ' +
      `${addressesSent.toLocaleString('ru-RU')} адресов у ${companiesSent.toLocaleString('ru-RU')} компаний — ` +
      'сначала по одному адресу на компанию — с лучшим вердиктом валидации, — ' +
      'потом вторые, пока хватало потолка. ' +
      `Потолок снял ${addressesHeldBack.toLocaleString('ru-RU')} адресов` +
      (companiesHeldBack > 0
        ? ` у ${companiesHeldBack.toLocaleString('ru-RU')} компаний, которым не досталось ни одного адреса`
        : ' у компаний, чей лучший адрес уже уехал') +
      '. Снятые строки остались в базе и НЕ помечены отправленными.',
    segmentSplitInfo: (campaignsCount) =>
      `Сегментные варианты материализованы: запуск разбит на ${campaignsCount} кампании по сегментам базы (у каждой сегментной — свои тексты писем). Все кампании на паузе.`,
    rowsSkippedNote: (invalid, irrelevant) =>
      `Пропущено строк базы: ${invalid.toLocaleString('ru-RU')} с невалидным email (верификация) и ${irrelevant.toLocaleString('ru-RU')} нерелевантных вертикали.`,
    unverifiedSkippedNote: (unverified) =>
      `Не отправлено строк без вердикта валидации email: ${unverified.toLocaleString('ru-RU')} — ` +
      'непроверенный адрес в рассылку не идёт.',
    unverifiedSentNote: (unverified) =>
      `ОТПРАВЛЕНО строк без вердикта валидации email: ${unverified.toLocaleString('ru-RU')} — ` +
      'у этой базы конструктор не дошёл до шага валидации почт. Правило RU-инструмента прежнее ' +
      '(такие строки уезжают), но баунсы по ним лягут на домен отправителя: ' +
      'если адреса важны, пересоберите базу до валидации.',
    unparsedEmailNote: (multiAddress, malformed) =>
      `Не отправлено строк с несколькими адресами в одной ячейке: ${multiAddress.toLocaleString('ru-RU')}; ` +
      `с неразборным email: ${malformed.toLocaleString('ru-RU')}. ` +
      'В базе один адрес на строку, а вердикт валидации у ячейки один — ' +
      'выбрать за специалиста, какому из адресов он относится, нельзя.',
    blockedContactsNote: (blocked) =>
      `Исключено контактов из чёрного списка клиента: ${blocked.toLocaleString('ru-RU')}.`,
    instantlyFailedFallback: 'Не удалось создать кампанию',
    zeroAccepted: 'Система рассылки не приняла ни одного контакта. Кампания оставлена на паузе.',
    launchInfoSaveWarning:
      'Кампания создана, но запись о запуске не сохранилась в шаблон (вероятно, не применена миграция he_templates.launch_info) — повторный запуск не будет заблокирован.',
    segmentVariantsWarning: (dropped, lettersCount) =>
      `Сегментные варианты (${dropped} шт. в ${lettersCount} письмах) не попали в кампанию: ` +
      'Instantly не умеет условные блоки — в рассылку ушёл основной текст писем.',
    partialImportNote: (requested, accepted) =>
      `Instantly подтвердил ${accepted.toLocaleString('ru-RU')} адресов из ` +
      `${requested.toLocaleString('ru-RU')} отправленных: остаток ` +
      `${(requested - accepted).toLocaleString('ru-RU')} в кампанию не попал. ` +
      'Отправленными эти строки НЕ помечены (запуск в базу не пишет вовсе), поэтому остаток ' +
      'повторяем — но повторная загрузка делается осознанно, а не автоматически: ' +
      'адрес, уже лежащий в кампании, получил бы второе письмо.',
    relaunchKeptCampaignsNote: (kept) =>
      `Повтор запуска: ${kept.toLocaleString('ru-RU')} кампаний этого шаблона уже созданы прошлой ` +
      'попыткой — они оставлены как есть, второй раз не создавались и лидов в них не досылали.',
    relaunchRefilledCampaignsNote: (refilled) =>
      `Повтор запуска: ${refilled.toLocaleString('ru-RU')} пустых кампаний прошлой попытки ` +
      'дозаполнены вместо создания одноимённых дублей. Адреса, которые уже лежат в кампаниях ' +
      'воркспейса, Instantly при этом пропускает — иначе получатель получил бы второе письмо.',
    relaunchCreatedCampaignsNote: (created) =>
      `Повтор запуска: создано кампаний сейчас — ${created.toLocaleString('ru-RU')}: ` +
      'по тем частям аудитории, у которых кампании не было вовсе. Адреса, уже лежащие в кампаниях ' +
      'воркспейса, Instantly в них не берёт (защита от второго письма), поэтому принятых в такой ' +
      'кампании может быть меньше, чем отправлено.',
    capacityStopNote: (segments) =>
      'В воркспейсе Instantly кончилось место под контакты, поэтому ' +
      `${segments.toLocaleString('ru-RU')} сегментов этого запуска не создавались вовсе. ` +
      'Освободите место и повторите запуск: уже созданные кампании повтор не дублирует.',
  },
  en: {
    templateNotFound: 'Template not found',
    templateNotReady: 'Template is not ready — launch is possible once it reaches the ready status',
    alreadyLaunched: 'Template has already been sent to launch. Re-launch requires force: true.',
    baseNotFound: 'Base not found',
    presetLoadFailed: 'Failed to load the preset',
    // «Preset not found» не говорило клиенту НИ ЧТО случилось, ни что делать:
    // пресет он выбирает списком, который загрузился при открытии шага 5, и
    // пропасть тот может, пока экран открыт. Текст ОДИН на оба случая («такого
    // id нет» и «id не твой») — расщепление выдало бы существование чужого id
    // и было бы регрессом к волне 0. Действие — то, которое в кабинете ЕСТЬ:
    // перечитать список, а если он пуст, попросить менеджера — той же фразой,
    // что печатает пустой список на шаге 5 (EngStepReview.tsx).
    presetNotFound:
      'This sending preset is no longer available. Refresh the page and pick a sending preset again — '
      + 'if none is offered, ask your manager to set one up.',
    noLetters: 'The template has no letters to launch',
    noEmailColumn: 'No email column found in the collected base',
    noValidEmails: 'The base contains no valid email addresses',
    // Действие — то, которое в кабинете ЕСТЬ. Пересобрать базу клиент из
    // кабинета не может: шаг 4 — витрина, UI-вызова POST /verticals/[id]/collect
    // нет, а «Start outreach» новой сборки при готовой базе не ставит. Поэтому
    // просим менеджера — той же фразой, что и карточка базы на шаге 4
    // (EngStepBases.tsx) и пустой пресет на шаге 5: два экрана про одну и ту же
    // беду обязаны просить одного и того же.
    baseNotVerified: (unverified) =>
      'Launch stopped: not a single address in this base has passed email validation. ' +
      `Rows without a validation verdict: ${unverified.toLocaleString('en-US')}. ` +
      'An unverified address is never contacted, because the bounces would hit your sending domain. ' +
      'Ask your manager to collect this audience again — a new collection runs the email check to the end.',
    // Клиенту — без имён шагов, таблиц и дат нашего релиза: ему важны факт,
    // причина и действие. Слово instantly в тексте недопустимо (scrubBrand
    // заменил бы его русской фразой на английском экране). Действие — просьба
    // к менеджеру по той же причине, что у baseNotVerified выше: кнопки
    // «собрать заново» в кабинете нет.
    baseCollectedBeforeSplit:
      'Launch stopped: this audience was collected by an earlier version of our collection pipeline. ' +
      'Back then one row could hold several addresses of the same company, and the email check saved a ' +
      'single result for the whole group — the best one of them. ' +
      'So we cannot prove that the address left on a row is the one that passed the check, and writing to ' +
      'the wrong one would put bounces on your sending domain. ' +
      'Ask your manager to collect this audience again — a new collection keeps one address per row with ' +
      'its own check result — and this template launches after that.',
    blocklistLoadFailed:
      'Your blocked-contacts list could not be read, so the launch was stopped before any campaign was created. ' +
      'Please try again in a minute.',
    allContactsBlocked: 'Every address in this base is on your blocked-contacts list, so there is nobody to write to.',
    tooManyLeads: (count) =>
      `Too many leads for a wizard launch: ${count.toLocaleString('en-US')}. Maximum is ${HE_LAUNCH_MAX_LEADS.toLocaleString('en-US')}.`,
    // Обещать «остальное уедет позже» нельзя: добора именно этих строк в
    // движке нет, ночной долив собирает НОВЫЕ компании. Поэтому говорим ровно
    // то, что правда: что уехало, что снято и что снятое не сожжено.
    launchCapTrimmedNote: (companiesSent, addressesSent, addressesHeldBack, companiesHeldBack) =>
      `One launch carries at most ${HE_LAUNCH_MAX_LEADS.toLocaleString('en-US')} addresses, so not every ` +
      `address of this audience is in it: ${addressesSent.toLocaleString('en-US')} addresses across ` +
      `${companiesSent.toLocaleString('en-US')} companies are being sent — one address per company first, ` +
      'the one whose email check came back strongest, then second addresses while the limit allowed. ' +
      `The limit held back ${addressesHeldBack.toLocaleString('en-US')} addresses` +
      (companiesHeldBack > 0
        ? ` of ${companiesHeldBack.toLocaleString('en-US')} companies that got no address in this launch`
        : ' of companies whose strongest address is already in it') +
      '. Nothing was marked as contacted and your audience keeps every held-back address.',
    segmentSplitInfo: (campaignsCount) =>
      `Segment variants materialized: the launch was split into ${campaignsCount} campaigns by base segment (each segment campaign carries its own letter texts). All campaigns are paused.`,
    rowsSkippedNote: (invalid, irrelevant) =>
      `Base rows skipped: ${invalid.toLocaleString('en-US')} with an invalid email (verification) and ${irrelevant.toLocaleString('en-US')} irrelevant to the vertical.`,
    unverifiedSkippedNote: (unverified) =>
      `Rows left out because their address has no validation verdict: ${unverified.toLocaleString('en-US')}. ` +
      'An unverified address is never contacted.',
    // Недостижимо в en-контуре: у us-проекта вердикт обязателен, поэтому
    // строка без вердикта никогда не отправляется (шаг 5). Пара к RU-ключу
    // нужна типу словаря, и врать в ней нельзя — текст честный.
    unverifiedSentNote: (unverified) =>
      `Rows sent without a validation verdict: ${unverified.toLocaleString('en-US')}.`,
    unparsedEmailNote: (multiAddress, malformed) =>
      `Rows left out because one cell held several addresses: ${multiAddress.toLocaleString('en-US')}; ` +
      `because the address could not be read: ${malformed.toLocaleString('en-US')}. ` +
      'A base keeps one address per row, and a single validation verdict covers the whole cell, ' +
      'so picking one of those addresses would mean writing to an unverified one.',
    blockedContactsNote: (blocked) =>
      `Contacts left out because they are on your blocked-contacts list: ${blocked.toLocaleString('en-US')}.`,
    instantlyFailedFallback: 'Failed to create the campaign',
    zeroAccepted: 'The mailing system did not accept any contacts. The campaign was left paused.',
    launchInfoSaveWarning:
      'The campaign was created, but the launch record was not saved to the template (the he_templates.launch_info migration is probably not applied) — a re-launch will not be blocked.',
    segmentVariantsWarning: (dropped, lettersCount) =>
      `Segment variants (${dropped} across ${lettersCount} letters) were not included in the campaign: ` +
      'the mailing system cannot run conditional blocks — the main letter text was used instead.',
    // Клиенту важно, что остаток НЕ сожжён, и что второй загрузкой мы не рискуем
    // отправить кому-то второе письмо. Действие — к менеджеру, как и в других
    // текстах этого файла: кнопки повторной загрузки в кабинете нет.
    partialImportNote: (requested, accepted) =>
      `The mailing system confirmed ${accepted.toLocaleString('en-US')} of the ` +
      `${requested.toLocaleString('en-US')} addresses we sent, so ` +
      `${(requested - accepted).toLocaleString('en-US')} of them did not get into the campaign. ` +
      'Nothing in your audience was marked as contacted, so those addresses can still be used. ' +
      'Ask your manager to look at this launch before anyone uploads them a second time — an address ' +
      'that is already in a campaign would get two letters.',
    relaunchKeptCampaignsNote: (kept) =>
      `This launch was repeated: ${kept.toLocaleString('en-US')} campaigns of this template already ` +
      'existed from an earlier attempt. They were kept exactly as they were — not created again, and no ' +
      'contacts were added to them.',
    relaunchRefilledCampaignsNote: (refilled) =>
      `This launch was repeated: ${refilled.toLocaleString('en-US')} campaigns that an earlier attempt ` +
      'created but left without contacts were filled now, instead of creating a second campaign with ' +
      'the same name. Addresses that are already in a campaign are skipped, so nobody gets two letters.',
    relaunchCreatedCampaignsNote: (created) =>
      `This launch was repeated: ${created.toLocaleString('en-US')} campaign${created === 1 ? '' : 's'} ` +
      `${created === 1 ? 'was' : 'were'} created now, for the part${created === 1 ? '' : 's'} of your ` +
      'audience that had no campaign at all. Addresses that are already in one of your campaigns are ' +
      'skipped there, so such a campaign can end up with fewer contacts than we sent — that way nobody ' +
      'gets two letters.',
    capacityStopNote: (segments) =>
      'The mailing workspace has no room left for new contacts, so ' +
      `${segments.toLocaleString('en-US')} segments of this launch were not created at all. ` +
      'Ask your manager to free up room; repeating this launch does not duplicate the campaigns that ' +
      'were already created.',
  },
};

export interface HeTemplateLaunchInput {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  templateId: string;
  presetId: string;
  force: boolean;
  /** Для аудита (userId инициатора). */
  userId: string;
  /** Скоуп владельца пресета (клиентский контур); у staff — без скоупа. */
  scopeClientUserId?: string;
  locale: HeLaunchLocale;
  /** Префикс событий логирования/аудита своего контура. */
  eventPrefix: string;
}

export interface HeTemplateLaunchOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function runHeTemplateLaunch(input: HeTemplateLaunchInput): Promise<HeTemplateLaunchOutcome> {
  const { portalDb, instantlyDb, templateId, presetId, force, userId, scopeClientUserId, locale, eventPrefix } = input;
  const t = MESSAGES[locale];

  // 1. Шаблон.
  const { data: templateRow, error: tplErr } = await portalDb
    .from('he_templates')
    .select('*')
    .eq('id', templateId)
    .single();
  if (tplErr) {
    return {
      status: tplErr.code === 'PGRST116' ? 404 : 500,
      body: { error: tplErr.code === 'PGRST116' ? t.templateNotFound : tplErr.message },
    };
  }
  const template = templateRow as HeTemplate & { launch_info?: unknown };

  if (template.status !== 'ready') {
    return { status: 409, body: { error: t.templateNotReady } };
  }

  const existingLaunch = parseLaunchInfo(template.launch_info);
  // Незакончённый запуск (в записи остались сегменты без кампании или без
  // лидов) повтор НЕ блокирует и force для него не нужен: достраивать нечего
  // прятать, а дублей повтор не создаёт по построению — кампанию, которая уже
  // есть, он переиспользует (шаг 6). Требовать force здесь значило бы
  // заставлять оператора угадывать слово, чтобы дозапустить свой же запуск.
  const resumeLaunch = heLaunchIsIncomplete(existingLaunch);
  if (existingLaunch && !force && !resumeLaunch) {
    return { status: 409, body: { error: t.alreadyLaunched, launch: existingLaunch } };
  }

  // 2. База шаблона.
  //    project_id нужен, чтобы узнать рынок проекта (имя кампании и гейты, шаг
  //    4b): у he_templates своего project_id нет, а у he_bases он not null.
  //    collect_info — маркеру контракта сборки (шаг 4c); поле маленькое, в
  //    отличие от data.
  const { data: baseRow, error: baseErr } = await portalDb
    .from('he_bases')
    .select('id, project_id, filename, columns, data, source, collect_info')
    .eq('id', template.base_id)
    .single();
  if (baseErr) {
    return {
      status: baseErr.code === 'PGRST116' ? 404 : 500,
      body: { error: baseErr.code === 'PGRST116' ? t.baseNotFound : baseErr.message },
    };
  }
  const base = baseRow as Pick<HeBase, 'id' | 'project_id' | 'filename' | 'columns' | 'data'> & {
    source?: string;
    collect_info?: unknown;
  };

  // 3. Пресет — service-level read по id (у staff); в клиентском контуре —
  //    со скоупом владельца (чужой пресет = «не найден»).
  let presetQuery = instantlyDb
    .from('client_campaign_presets')
    .select('*')
    .eq('id', presetId);
  if (scopeClientUserId) {
    presetQuery = presetQuery.eq('client_user_id', scopeClientUserId);
  }
  const { data: presetRow, error: presetErr } = await presetQuery.maybeSingle();
  if (presetErr) {
    await logError(`${eventPrefix}.preset_failed`, presetErr, { userId });
    return { status: 500, body: { error: t.presetLoadFailed } };
  }
  if (!presetRow) return { status: 404, body: { error: t.presetNotFound } };
  const preset = presetRow as ClientCampaignPreset;

  // 4. Письма шаблона + условия сегментных вариантов (when) для сплита запуска.
  const templateLetters = Array.isArray(template.letters) ? template.letters : [];
  if (!buildLaunchSequence(templateLetters)) return { status: 400, body: { error: t.noLetters } };
  const segmentWhens = [
    ...new Set(
      templateLetters.flatMap((l) =>
        (l.segment_variants ?? []).map((v) => (v.when ?? '').trim()).filter(Boolean),
      ),
    ),
  ];

  // 4b. Рынок проекта. Нужен ИМЕНИ кампании (шаг 6: имя доезжает до клиента —
  //     launch_info.campaign_name на дашборде ENG-кабинета и на шаге баз,
  //     поэтому у us-проекта в нём не должно быть ни внутреннего «HE · », ни
  //     русского фолбэка «база») И гейту вердиктов ниже. Ключ — рынок
  //     ПРОЕКТА, а не locale контура: us-проект может запустить и сотрудник из
  //     внутреннего RU-инструмента, а клиент в своём рассыльщике увидит то же
  //     самое имя и получит те же письма со своих домённых ящиков.
  //     Читается ДО шага 5 (раньше было 5c) именно из-за гейта.
  const { data: projectRow, error: projectErr } = await portalDb
    .from('he_projects')
    .select('market')
    .eq('id', base.project_id)
    .maybeSingle();
  if (projectErr) {
    await logError(`${eventPrefix}.project_market_failed`, projectErr, { userId, templateId });
  }
  // Рынок не прочитался (блип БД или строки нет) — запуск НЕ роняем, имя того
  // не стоит. Фолбэк по контуру: ru-инструмент получает сегодняшние дефолты
  // (байт-в-байт), а en-контур обслуживает только eng-клиентов (гейт
  // requireEngMarket), и английское имя там безопаснее русского «база».
  // Для гейта вердиктов этот фолбэк тоже в безопасную сторону: неизвестный
  // рынок в клиентском контуре трактуется как 'us', то есть строже.
  const market: HeMarket = projectRow
    ? projectMarket(projectRow as { market?: string | null })
    : locale === 'en'
      ? 'us'
      : 'ru';
  // undefined = дефолты buildLaunchCampaignName, т.е. прежнее имя RU-запуска.
  const campaignNaming = market === 'us' ? HE_ENG_CAMPAIGN_NAMING : undefined;

  const allRows = Array.isArray(base.data) ? (base.data as Array<Record<string, unknown>>) : [];

  // 4c. ЧЕЙ вердикт лежит на строке. Гейт ниже верит колонке `_email_status`,
  //     но у базы us-проекта, собранной ДО 26.09.2026, этой веры она не
  //     заслуживает: конструктор тогда не разносил адреса по строкам, поэтому
  //     validate_emails писал ОДИН вердикт на склеенную ячейку («a@acme.com,
  //     b@acme.com») — и писал ЛУЧШИЙ из адресов (processingSteps.ts,
  //     applyCellStatus + STATUS_RANK), — а импорт клал на строку ПЕРВЫЙ адрес
  //     ячейки (stages/baseCollect.ts, importConstructRows: extractEmail).
  //     Строка читается как «a@acme.com / ok», хотя валидацию прошёл
  //     b@acme.com. На запуске это уже НЕ ВИДНО: ячейку схлопнул импорт, в
  //     базе лежит один чистый адрес с чистым вердиктом, и построчный гейт
  //     такую подмену не поймает по определению — поэтому проверка базовая, а
  //     не строчная.
  //
  //     Маркер — heConstructContactCap (ключ collect_info.construct.contact_cap
  //     пишет только постановка нового контракта; его границы описаны там же).
  //     Дополняем его вопросом «а есть ли вообще что портить»: база без ни
  //     одного вердикта — это не легаси-подмена, а непроверенная база, и про
  //     неё честнее сказать baseNotVerified ниже.
  //
  //     Выбрана КОНСЕРВАТИВНАЯ развилка — отказ, а не «считать вердикт
  //     неизвестным и отправить остальное». Причина: «остального» тут нет.
  //     Неизвестен вердикт КАЖДОЙ строки, где ячейка была склеенной, а какая
  //     была — постфактум не установить; трактовка «вердикта нет» отсекла бы
  //     всю базу тем же 400, только с текстом, который врёт про причину.
  //     Цена ошибки в другую сторону — баунсы на домене клиента, и починить
  //     репутацию нам нечем (обратной связи по баунсам у движка нет).
  //     RU здесь не участвует сознательно: в RU-списке шагов split_emails нет
  //     и сейчас, поэтому отказ по этому признаку закрыл бы ежедневный
  //     staff-инструмент целиком. Тот же дефект у RU-баз — состояние HEAD и
  //     отдельное решение владельца, см. отчёт лейна.
  if (market === 'us' && heConstructContactCap(base.collect_info) === null) {
    const rowsWithVerdict = allRows.reduce(
      (n, r) => n + (heLaunchEmailVerdict(r._email_status) === 'missing' ? 0 : 1),
      0,
    );
    if (rowsWithVerdict > 0) {
      // В аудит, а не только в ответ: так владелец находит такие базы по
      // журналу, не выгружая he_bases (запрос — в отчёте лейна).
      await logAudit(
        `${eventPrefix}.base_before_split_contract`,
        'Launch refused: us base collected before per-row email split — its validation verdicts are not per-address',
        {
          userId,
          templateId,
          baseId: base.id,
          projectId: base.project_id,
          source: base.source ?? null,
          rows: allRows.length,
          rowsWithVerdict,
        },
      );
      return { status: 400, body: { error: t.baseCollectedBeforeSplit } };
    }
  }

  // 5. Лиды из базы. Все проверки — ДО любого вызова Instantly.
  //    Качественные пометки строк ставит АВТОсборка (base_collect):
  //    _email_status — вердикт валидации почты, _low_relevance — вердикт
  //    релевант-гейта.
  //
  //    ВЕРДИКТ ОБЯЗАТЕЛЕН (fail-closed) У market='us' — и у автосборки, и у
  //    ручной загрузки: письма уедут с домённых ящиков ENG-клиента, а
  //    непроверенный адрес в рассылку не идёт.
  //
  //    RU-ИНСТРУМЕНТ ОСТАЁТСЯ КАК БЫЛ, байт-в-байт: строка без вердикта
  //    уезжает (отсеивается только ОТКЛОНЁННЫЙ вердикт, как и до 26.09.2026
  //    условием `status && status !== 'ok'`). Требовать вердикт у RU значило бы
  //    запретить сотруднику запуск с частично собранной базы — импорт
  //    частичной сетки failed/cancelled джобы там спроектированный рабочий
  //    случай, и менять это никто не просил. Молчать об этом тоже нельзя:
  //    сколько строк уехало без вердикта, говорит unverifiedSentNote.
  //    Ручная RU-загрузка (source !== 'auto' у ru-проекта) фильтр не проходит
  //    вовсе — у CSV специалиста вердиктов нет по определению.
  const columns = Array.isArray(base.columns)
    ? base.columns.filter((c): c is string => typeof c === 'string')
    : [];
  const isAutoBase = base.source === 'auto';
  const requireEmailVerdict = market === 'us';
  const filterRows = isAutoBase || requireEmailVerdict;
  // Колонка адреса ищется ОДИН раз и по ОДНОМУ набору строк — по ПОЛНОЙ базе
  // (allRows), — и это же значение уходит в маппинг лидов ниже. Гейту колонка
  // нужна ДО фильтра, маппингу — после, а детекция по содержимому
  // (findEmailColumn: доля похожих значений среди первых непустых) зависит от
  // НАБОРА строк: посчитанная второй раз по остатку, она могла назвать другую
  // колонку или не найти ничего у базы, где гейт снял как раз строки с
  // адресами, — и ответ был бы «в базе не найдена колонка с email» вместо
  // честной причины отсева. Полная база — правильный набор для обеих: она не
  // зависит от того, что именно снял гейт.
  const detectedEmailColumn = findEmailColumn(columns, allRows);
  // Гейту колонка нужна, чтобы не требовать вердикт со строк, где адреса нет
  // вовсе: у автосборки это штатная компания без найденной почты (их бывает
  // большинство), и записать их в «сняты без вердикта» значило бы соврать в
  // отчёте. Такую строку, как и раньше, молча отбросит маппинг.
  const gateEmailColumn = filterRows ? detectedEmailColumn : null;
  let skippedInvalid = 0;
  let skippedUnverified = 0;
  let unverifiedSent = 0;
  let skippedIrrelevant = 0;
  const rows = filterRows
    ? allRows.filter((r) => {
        // Порядок причин прежний: строка и нерелевантная, и невалидная
        // по-прежнему считается нерелевантной (чтобы счётчики RU-запуска
        // автобазы не поехали).
        if (isAutoBase && r._low_relevance === true) {
          skippedIrrelevant += 1;
          return false;
        }
        if (gateEmailColumn && String(r[gateEmailColumn] ?? '').trim() === '') return true;
        const verdict = heLaunchEmailVerdict(r._email_status);
        if (verdict === 'rejected') {
          skippedInvalid += 1;
          return false;
        }
        if (verdict === 'missing') {
          if (requireEmailVerdict) {
            skippedUnverified += 1;
            return false;
          }
          // RU: отправляем, как и раньше, но считаем — предупреждение ниже.
          unverifiedSent += 1;
          return true;
        }
        return true;
      })
    : allRows;
  const {
    leads: mappedLeads,
    emailColumn,
    leadRowIndices: mappedRowIndices,
    multiAddressRows,
    malformedEmailRows,
    standardFieldsHeldBack,
  } = mapBaseRowsToLeads({
    rows,
    columns,
    emailColumn: detectedEmailColumn,
    operatorMapping: template.personalization_plan?.operator_mapping,
    // СТАНДАРТНЫЕ поля лида (company_name/website/phone) — в ОБОИХ контурах, не
    // только у market='us'. Проверено, кто их читает, прежде чем включать:
    //   - собственные переменные рассыльщика в письме ({{companyName}},
    //     {{website}}, {{phone}}) — единственный читатель, который может
    //     изменить ТЕКСТ письма. Поэтому поле не ставится, когда у строки есть
    //     одноимённая переменная письма с другим значением (правило и причина —
    //     mapBaseRowsToLeads, standardFields). Сколько полей так задержано,
    //     уходит в аудит ниже: «обычно безобидно» — не доказательство, а
    //     счётчик;
    //   - внутренние staff-экраны рассыльщика в портале (app/instantly/leads,
    //     app/instantly/campaigns/[id]) печатают lead.company_name и сегодня
    //     показывают «—» у всех кампаний движка — для RU это улучшение, а не
    //     риск;
    //   - durable-журнал отчётности (clientReports/ledger, company_name лида)
    //     висит на appendLeads, а запуск грузит лидов через createLeads
    //     напрямую — этого пути правка не касается вовсе.
    // Скоупить на 'us' было бы хуже: один и тот же шаблон сотрудник и клиент
    // запускают одним ядром, и расхождение полей лида по контуру пришлось бы
    // потом объяснять каждому, кто сверяет кампанию в рассыльщике.
    standardFields: true,
  });
  // Чёрный список (шаг 5a) режет аудиторию уже после маппинга, поэтому оба
  // массива переприсваиваются вместе: их параллельность держит сплит по
  // сегментам ниже.
  let leads = mappedLeads;
  let leadRowIndices = mappedRowIndices;
  if (!emailColumn) return { status: 400, body: { error: t.noEmailColumn } };
  if (leads.length === 0) {
    // «База не проверена» и «в базе нет валидных адресов» — разные причины и
    // разные действия: в первом случае базу надо пересобрать, а не искать
    // адреса. Не называть первую значило бы отправить специалиста и клиента
    // искать несуществующую проблему.
    return {
      status: 400,
      body: { error: skippedUnverified > 0 ? t.baseNotVerified(skippedUnverified) : t.noValidEmails },
    };
  }

  // 5a. Чёрный список контактов клиента. Его наполняет сам клиент (негативные
  //     ответы в кабинете + ручные блоки), он скоупится client_user_id пресета,
  //     и до этой правки ручной запуск шаблона его НЕ СПРАШИВАЛ ни в одном из
  //     контуров: фильтр стоял только на ночном доливе (stages/baseCollectRefill)
  //     и в клиентском runLaunch. То есть заблокированный получатель снова
  //     получал письмо, стоило запустить шаблон вручную.
  //
  //     Fail-closed и ДО первого вызова рассыльщика: список не прочитался или
  //     у пресета нет владельца — запуск не состоялся, кампании не созданы.
  //     Тихо отправить «на всякий случай» нельзя: ради этих адресов список и
  //     существует. Ошибку getBlockedEmailSet не разбираем на виды (она сама
  //     бросает и на сбое БД, и на неполной выдаче) — любая означает «не знаем
  //     список», а значит «не отправляем».
  //
  //     Оба контура, включая RU-инструмент: блок ставит клиент по негативному
  //     ответу, и получателю всё равно, кто нажал запуск. Для RU это новое
  //     поведение и новый режим отказа (500 вместо отправки), поэтому оба
  //     названы вслух — счёт снятых контактов в warnings, причина отказа в
  //     тексте ошибки, подробности в logError. Ветка пустого client_user_id
  //     оборонительная: в схеме колонка not null
  //     (instantly-migrations/20260429_0001), то есть в норме недостижима.
  const clientUserId =
    typeof preset.client_user_id === 'string' ? preset.client_user_id.trim() : '';
  let blockedContacts = 0;
  try {
    if (!clientUserId) {
      throw new Error(`пресет ${presetId}: пустой client_user_id — чей чёрный список применять, неизвестно`);
    }
    const blockedEmails = await getBlockedEmailSet(instantlyDb, clientUserId);
    // filterBlockedLeads — единственный носитель правил нормализации; здесь по
    // его результату восстанавливается параллельность leadRowIndices (адреса
    // лидов уже lowercase и уникальны, так что Set по ним однозначен).
    const filtered = filterBlockedLeads(leads, blockedEmails);
    blockedContacts = filtered.blockedCount;
    if (blockedContacts > 0) {
      const allowed = new Set(filtered.kept.map((l) => l.email));
      const keptLeads: typeof leads = [];
      const keptRowIndices: number[] = [];
      leads.forEach((lead, i) => {
        if (!allowed.has(lead.email)) return;
        keptLeads.push(lead);
        keptRowIndices.push(leadRowIndices[i]);
      });
      leads = keptLeads;
      leadRowIndices = keptRowIndices;
    }
  } catch (err) {
    await logError(`${eventPrefix}.blocklist_failed`, err, {
      userId,
      templateId,
      presetId,
      clientUserId: clientUserId || null,
    });
    return { status: 500, body: { error: t.blocklistLoadFailed } };
  }
  if (leads.length === 0) return { status: 400, body: { error: t.allContactsBlocked } };

  // 5b. ПОТОЛОК ЗАПУСКА. Считается ПОСЛЕ чёрного списка (до 26.09.2026 списка
  //     тут не было вовсе): решение принимается по тому, что реально уедет.
  //
  //     Потолок считает АДРЕСА, а клиент заказывал КОМПАНИИ. После разноса
  //     адресов по строкам одна компания занимает до «капа адресов на компанию»
  //     строк, поэтому оплаченные 2000 компаний легально дают 4200 строк — и до
  //     этой правки запуск отвечал на них 413: клиент не мог отправить базу, за
  //     которую заплатил. Стадия сборки этот перекос уже называла вслух, но
  //     только в журнале для staff (stages/baseCollect.ts, предупреждение по
  //     okContacts > HE_LAUNCH_MAX_LEADS) — клиент по-прежнему узнавал о нём,
  //     нажав «Launch».
  //
  //     Теперь у market='us' потолок ВЫБИРАЕТ, а не отказывает: сначала по
  //     одному сильнейшему адресу каждой компании, потом вторые (правило и его
  //     причина — selectLeadsWithinLaunchCap в launchHandoff.ts). Компании при
  //     этом не пропадают молча: сколько компаний и адресов уехало и сколько
  //     снял потолок, идёт в warnings ответа (его читает и кабинет) и в аудит.
  //     Сам HE_LAUNCH_MAX_LEADS не меняется: его величина — решение владельца с
  //     последствиями для чанкования на стороне рассыльщика, см. отчёт лейна.
  //
  //     Снятые строки НЕ СОЖЖЕНЫ: запуск не пишет ни в he_bases.data, ни в
  //     статус базы, а исключение компаний из будущих сборок собирается по
  //     МЕМБЕРШИПУ в базах проекта (stages/baseCollect.ts,
  //     loadOtherBaseExclusionKeys), а не по факту отправки.
  //
  //     RU-ИНСТРУМЕНТ ОСТАЁТСЯ КАК БЫЛ: 413 байт-в-байт. Там строка = компания
  //     (split_emails в RU-списке шагов нет), то есть «адресов больше потолка»
  //     означает «компаний больше потолка», и обрезать оплаченный staff-срез до
  //     2000 компаний никто не просил: у инструмента на этот случай свой
  //     пречек по row_count и свой ответ «скачайте CSV и запускайте порциями»
  //     (Step5Template.tsx). Ключ развилки — рынок ПРОЕКТА, как у гейта
  //     вердиктов (шаг 5), а не контур запуска — и ровно поэтому пречек стал
  //     неверен: у us-проекта, открытого сотрудником в RU-инструменте, запуск
  //     такую базу принимает, а пречек кнопку всё ещё гасит. Предикат развилки
  //     теперь один (heLaunchRefusesOverCap), компонент — чужой лейн.
  let capCompaniesSent = 0;
  let capAddressesHeldBack = 0;
  let capCompaniesHeldBack = 0;
  if (leads.length > HE_LAUNCH_MAX_LEADS) {
    // Развилка «отказ или выбор» — ОДНА, из launchHandoff.ts: этим же
    // предикатом обязан пользоваться пречек staff-шага 5, который гасит кнопку
    // «Отправить в запуск» по row_count базы (см. отчёт лейна).
    if (heLaunchRefusesOverCap(market)) {
      return { status: 413, body: { error: t.tooManyLeads(leads.length) } };
    }
    const selection = selectLeadsWithinLaunchCap({
      rows,
      columns,
      leadRowIndices,
      limit: HE_LAUNCH_MAX_LEADS,
    });
    // Оба массива переписываются вместе и в исходном порядке базы: их
    // параллельность держит сплит по сегментам ниже, а порядок — приоритет
    // задач плана сборки.
    const keptLeads: typeof leads = [];
    const keptRowIndices: number[] = [];
    for (const leadPos of selection.keptLeadPositions) {
      keptLeads.push(leads[leadPos]);
      keptRowIndices.push(leadRowIndices[leadPos]);
    }
    leads = keptLeads;
    leadRowIndices = keptRowIndices;
    capCompaniesSent = selection.companiesSent;
    capAddressesHeldBack = selection.addressesHeldBack;
    capCompaniesHeldBack = selection.companiesHeldBack;
    // Ключ компании — то, на чём стоит вся арифметика выше: без него «по одному
    // адресу на компанию» вырождается в «первые N адресов подряд», а числа
    // предупреждения остаются внутренне согласованными и потому неотличимыми от
    // честных. Поэтому каждый НЕ-канонический выбор колонок и каждая строка без
    // ключа называются вслух отдельным событием аудита — по нему такие базы
    // находятся по журналу, без выгрузки he_bases. У сегодняшней авто-сборки
    // ключ всегда канонический (he_bases.columns = HE_AUTO_COLLECT_COLUMNS), так
    // что событие означает «контракт сетки разошёлся с запуском».
    const keyResolution = selection.companyKeyResolution;
    if (
      keyResolution.company !== 'canonical' ||
      keyResolution.website !== 'canonical' ||
      selection.addressesWithoutCompanyKey > 0
    ) {
      await logAudit(
        `${eventPrefix}.launch_cap_company_key`,
        'Launch cap grouped addresses without a canonical company key',
        {
          userId,
          templateId,
          baseId: base.id,
          projectId: base.project_id,
          source: base.source ?? null,
          columns,
          companyKeyResolution: keyResolution,
          addressesWithoutCompanyKey: selection.addressesWithoutCompanyKey,
          companiesSent: selection.companiesSent,
          addressesSent: selection.addressesSent,
        },
      );
    }
  }

  // 5c. Материализация 15%: сплит лидов по сегментам базы. Классификатор —
  //     LLM (bulk-модель, батчами); системный сбой → null → легаси-путь:
  //     одна кампания, сегментные варианты выкинуты с предупреждением.
  interface LeadGroup {
    segment: string | null;
    leadIdx: number[];
  }
  let groups: LeadGroup[] = [{ segment: null, leadIdx: leads.map((_, i) => i) }];
  let segmentsMaterialized = false;
  if (segmentWhens.length > 0) {
    let assignments: Map<number, string> | null = null;
    try {
      assignments = await classifyBaseRowsIntoSegments({
        rows: leadRowIndices.map((ri) => rows[ri] ?? {}),
        segments: segmentWhens,
        language: detectSegmentLanguage(segmentWhens),
      });
    } catch {
      assignments = null;
    }
    if (assignments) {
      const defaultIdx: number[] = [];
      const bySegment = new Map<string, number[]>();
      leadRowIndices.forEach((_rowIndex, leadPos) => {
        const seg = assignments.get(leadPos);
        if (!seg) {
          defaultIdx.push(leadPos);
          return;
        }
        const list = bySegment.get(seg) ?? [];
        list.push(leadPos);
        bySegment.set(seg, list);
      });
      const next: LeadGroup[] = [];
      if (defaultIdx.length > 0) next.push({ segment: null, leadIdx: defaultIdx });
      for (const when of segmentWhens) {
        const idxs = bySegment.get(when);
        if (idxs && idxs.length > 0) next.push({ segment: when, leadIdx: idxs });
      }
      if (next.length > 0) groups = next;
      segmentsMaterialized = segmentWhens.some((w) => (bySegment.get(w) ?? []).length > 0);
    }
  }

  const instantlyRequestOptions = { accountId: resolveInstantlyAccountId(preset.instantly_account_id) };

  // 6. Instantly: по кампании на группу (НЕ активируем!) + лиды группы. Текст
  //    ошибки идёт без scrubBrand — staff-UI нужна точная формулировка API;
  //    клиентский роут скрабит бренд на своей стороне. Основная кампания
  //    (segment=null) создаётся первой — её id уходит в скалярные поля
  //    launch_info (их читает refill-долив и старый UI).
  //
  //    ЧТО СОЗДАНО — ТО ЗАПИСАНО. Кампания попадает в campaigns[] сразу, как
  //    узнан её id, ДО загрузки лидов. До 28.09.2026 запись делалась после
  //    загрузки, поэтому кампания, у которой упала загрузка, не попадала в
  //    launch_info вообще: 500, сирота у рассыльщика, а повтор создавал ей
  //    двойника с тем же именем. Писем сирота сама не шлёт (V1 не активирует
  //    кампании никогда), но ёмкость воркспейса тратит.
  //
  //    ДОСТРОЙКА ПОВТОРА (resumeLaunch): что уже создано, берётся из записи
  //    прошлой попытки — по СЕГМЕНТУ. Кампания, которая уже приняла адреса, не
  //    трогается вовсе (её получатели могут быть в рассылке); пустая —
  //    переиспользуется под тот же сегмент; заново создаются только сегменты,
  //    у которых кампании нет. Это единственный способ не плодить одноимённые
  //    кампании, не выдумывая нового состояния: список кампаний запуск и так
  //    хранит.
  const recordedBySegment = new Map<string, HeTemplateLaunchCampaign>();
  if (resumeLaunch && existingLaunch) {
    for (const recorded of existingLaunch.campaigns ?? []) {
      const key = recorded.segment ?? '';
      if (!recordedBySegment.has(key)) recordedBySegment.set(key, recorded);
    }
    // Запись без campaigns[] (запуск до сплита по сегментам): скалярные поля
    // описывают ту же ОСНОВНУЮ кампанию, других у такого запуска нет.
    if (recordedBySegment.size === 0) {
      recordedBySegment.set('', {
        campaign_id: existingLaunch.campaign_id,
        campaign_name: existingLaunch.campaign_name,
        campaign_url: existingLaunch.campaign_url,
        segment: null,
        leads_count: existingLaunch.leads_count,
      });
    }
  }

  const campaigns: HeTemplateLaunchCampaign[] = [];
  const pending: HeTemplateLaunchPending[] = [];
  // Отказы сегментов машинно: имя сегмента обязано доехать до предупреждения
  // клиенту, а склеенную строку warnings разобрать обратно нельзя — в условии
  // сегмента бывает ': '. Клиентский роут читает этот список и НЕ отдаёт его
  // наружу (в error лежит сырьё рассыльщика).
  const segmentFailures: Array<{ segment: string | null; error: string }> = [];
  const groupErrors: string[] = [];
  const usedRecords = new Set<string>();
  let accepted = 0;
  let requested = 0;
  let attempted = 0;
  let keptCampaigns = 0;
  let refilledCampaigns = 0;
  // Кампании, созданные ИМЕННО СЕЙЧАС. На достройке это третье число рядом с
  // «перенесено» и «дозаполнено»: без него ответ про повтор говорит, что
  // сохранено, но молчит про то, что появилось (шаг 7, warnings и аудит).
  let createdCampaigns = 0;
  let capacityStopped = false;
  let capacitySkippedSegments = 0;
  for (const group of groups) {
    const segmentKey = group.segment ?? '';
    const recorded = recordedBySegment.get(segmentKey);

    // Кампания сегмента уже создана И приняла адреса: второй раз не создаём и
    // лидов не досылаем — её получатели уже у рассыльщика, и второй загрузкой
    // кто-то получил бы второе письмо. Запись переносим как есть, вместе с её
    // счётчиками: суммы записи не должны похудеть от повтора.
    if (recorded && recorded.leads_count > 0) {
      campaigns.push(recorded);
      usedRecords.add(segmentKey);
      accepted += recorded.leads_count;
      requested += recorded.leads_requested ?? recorded.leads_count;
      attempted += recorded.leads_attempted ?? recorded.leads_count;
      keptCampaigns += 1;
      continue;
    }

    // Место под контакты в воркспейсе кончилось: следующий сегмент этого не
    // переживёт, а созданная под него кампания стала бы ещё одной пустой
    // сиротой. Сегмент уходит в pending — повтор его достроит.
    if (capacityStopped) {
      pending.push({ segment: group.segment, stage: recorded ? 'leads' : 'campaign' });
      capacitySkippedSegments += 1;
      continue;
    }

    const sequence = buildLaunchSequence(templateLetters, { segmentWhen: group.segment });
    if (!sequence) {
      // Недостижимо (пустые письма отсёк шаг 4 на том же наборе), но отказом
      // выходить нельзя: созданные кампании остались бы без записи — ровно та
      // сирота, которую лечит этот шаг. Пока кампаний нет, ответ прежний.
      if (campaigns.length === 0) return { status: 400, body: { error: t.noLetters } };
      pending.push({ segment: group.segment, stage: recorded ? 'leads' : 'campaign' });
      groupErrors.push(`${group.segment ?? 'default'}: ${t.noLetters}`);
      segmentFailures.push({ segment: group.segment, error: t.noLetters });
      continue;
    }
    // У переиспользуемой кампании имя остаётся прежним: оно уже стоит у
    // рассыльщика и уже показано клиенту записью о запуске.
    const campaignName =
      recorded?.campaign_name ||
      buildLaunchCampaignName(base.filename, new Date(), group.segment, campaignNaming);
    const groupLeads = group.leadIdx.map((i) => leads[i]);
    let campaign: HeTemplateLaunchCampaign | null = null;
    try {
      const payload = buildCampaignPayloadFromPreset({
        preset,
        sequence: { name: campaignName, steps: sequence.steps },
      });
      let campaignId: string;
      if (recorded) {
        // Пустая кампания прошлой попытки. Цепочку досылаем PATCH'ем — той же
        // операцией, что и ниже при непринятых sequences: кампания на паузе и
        // без лидов, переписать её письма безопасно, а гарантия «внутри лежит
        // актуальная цепочка шаблона» нужна (упасть прошлая попытка могла и на
        // самом этом PATCH'е).
        campaignId = recorded.campaign_id;
        await updateCampaign(campaignId, { sequences: payload.sequences }, instantlyRequestOptions);
        refilledCampaigns += 1;
      } else {
        const created = await createCampaign(payload, instantlyRequestOptions);
        const createdId = (created as { id?: string }).id ?? null;
        if (!createdId) {
          throw new Error('Instantly вернул кампанию без идентификатора');
        }
        campaignId = createdId;
        // Считаем СРАЗУ после того, как id узнан: кампания у рассыльщика уже
        // есть, даже если PATCH цепочки или загрузка ниже упадут.
        createdCampaigns += 1;

        // Как в клиентском запуске: если Instantly не сохранил sequences при
        // создании — досылаем PATCH'ем.
        if (!hasUsableCampaignSequences(created.sequences)) {
          await updateCampaign(campaignId, { sequences: payload.sequences }, instantlyRequestOptions);
        }
      }

      // Кампания есть — записываем СРАЗУ, до загрузки лидов (см. шапку шага).
      // leads_requested известен уже здесь, leads_count/leads_attempted
      // дописываются ответом загрузки: у кампании, чья загрузка упала,
      // остаётся честный ноль принятых, а не догадка.
      campaign = {
        campaign_id: campaignId,
        campaign_name: campaignName,
        campaign_url: instantlyCampaignUrl(campaignId),
        segment: group.segment,
        leads_count: 0,
        leads_requested: groupLeads.length,
      };
      campaigns.push(campaign);
      if (recorded) usedRecords.add(segmentKey);
      requested += groupLeads.length;

      const leadResult = await createLeads(
        groupLeads,
        {
          campaign_id: campaignId,
          skip_if_in_workspace: false,
          // ПЕРВАЯ попытка запуска — три false, как и до 28.09.2026: наш
          // пайплайн сам решает, кому писать.
          //
          // ДОСТРОЙКА переворачивает флаг у ВСЕХ кампаний захода, а не только у
          // переиспользованных (в первой версии достройки здесь стояло
          // `Boolean(recorded)` — только переиспользованные).
          // Правило — «может ли этот шаблон УЖЕ держать эти адреса у
          // рассыльщика», и у СВЕЖЕЙ кампании достройки ответ тоже «да»:
          //   - сегменты раскладывает LLM (classifyBaseRowsIntoSegments), и на
          //     повторе раскладка своя: лид, уехавший в кампанию сегмента A
          //     (её достройка не трогает вовсе — leads_count > 0), на этом
          //     заходе попадает в сегмент B, чья кампания создаётся впервые, —
          //     и без флага получил бы второе письмо из B;
          //   - кампания прошлой попытки могла быть создана и потеряна
          //     (оборванный ответ createCampaign, таймаут роута до записи):
          //     сегмент лежит в pending со стадией 'campaign', хотя его адреса
          //     уже у рассыльщика;
          //   - переиспользуемая кампания — прежний случай: часть адресов могла
          //     лечь, не подтвердившись нам (чанк из 1000).
          // Цена флага: он шире имени (отсеивает и по ЧУЖИМ кампаниям
          // воркспейса), поэтому пропущенный адрес виден в partialImportNote
          // ниже — на повторе «потерять адрес» безопаснее, чем «отправить
          // дважды». На force-перезапуске ЗАКОНЧЕННОГО запуска флаг остаётся
          // false: там оператор осознанно создаёт новые кампании по той же
          // аудитории, и пропуск оставил бы их пустыми.
          skip_if_in_campaign: resumeLaunch,
          skip_if_in_list: false,
        },
        instantlyRequestOptions,
      );
      accepted += leadResult.leads_uploaded;
      attempted += leadResult.total_sent;
      campaign.leads_count = leadResult.leads_uploaded;
      campaign.leads_attempted = leadResult.total_sent;
      // Кампания создана, но не приняла ни одного адреса — запуск сегмента не
      // состоялся, и повтор обязан о нём знать: иначе он увидит «запуск
      // закончен» и по force создаст одноимённого двойника.
      //
      // Только у СВЕЖЕЙ кампании. У переиспользованной ноль принятых означает,
      // что рассыльщик партию обработал и не взял (в том числе потому, что
      // адреса уже лежат в кампании с прошлой попытки — мы сами просили их
      // пропустить), и следующий такой же повтор ничего нового не узнает.
      // Пометить её «не поехала» значило бы звать оператора нажимать запуск
      // по кругу; остаток при этом не теряется — он в partialImportNote.
      if (leadResult.leads_uploaded === 0 && !recorded) {
        pending.push({ segment: group.segment, stage: 'leads' });
      }
    } catch (err) {
      // Ни одной кампании нет — как раньше: весь запуск считается failed
      // (создавать было нечего, ретрай безопасен, записи не нужно). Дальше —
      // частичный успех: созданное записано, недоехавшее в pending.
      const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
      if (campaigns.length === 0) {
        await logError(`${eventPrefix}.failed`, err, { userId, templateId });
        return { status: 500, body: { error: message.slice(0, 300) } };
      }
      // Кампания у сегмента ЕСТЬ и когда упала загрузка (campaign записан), и
      // когда падение случилось на переиспользуемой кампании прошлой попытки
      // (recorded) — стадия обязана это различать, иначе журнал скажет «кампании
      // нет» про существующую.
      const stage = campaign || recorded ? 'leads' : 'campaign';
      pending.push({ segment: group.segment, stage });
      groupErrors.push(`${group.segment ?? 'default'}: ${message.slice(0, 200)}`);
      segmentFailures.push({ segment: group.segment, error: message.slice(0, 200) });
      await logError(`${eventPrefix}.group_failed`, err, {
        userId,
        templateId,
        segment: group.segment,
        stage,
      });
      // Отказ ПО МЕСТУ под контакты остальные сегменты переживут не лучше:
      // место не появится за миллисекунды, а каждая следующая кампания станет
      // пустой сиротой. Цикл останавливаем, остальные сегменты — в pending.
      if (isInstantlyContactCapacityError(err)) capacityStopped = true;
    }
  }

  // Кампании прошлой попытки, которым в ЭТОМ запуске не нашлось сегмента
  // (классификатор разложил базу иначе): у рассыльщика они есть, и потерять их
  // из записи нельзя — иначе следующий повтор создаст им двойников.
  for (const [key, recorded] of recordedBySegment) {
    if (usedRecords.has(key)) continue;
    campaigns.push(recorded);
    accepted += recorded.leads_count;
    requested += recorded.leads_requested ?? recorded.leads_count;
    attempted += recorded.leads_attempted ?? recorded.leads_count;
    keptCampaigns += 1;
  }

  // 7. Запись о запуске в шаблон. Скалярные поля — ОСНОВНАЯ кампания
  //    (segment=null), полный список — campaigns[]. До 28.09.2026 тут стояло
  //    campaigns[0] — то же самое, пока основная группа идёт первой и доходит до
  //    конца; но теперь в campaigns[0] может лежать кампания, созданная без
  //    лидов, или перенесённая запись сегмента, и ночной долив (autoPipeline.ts
  //    ищет именно segment=null) ушёл бы не туда.
  // Пустым campaigns[] здесь быть не может: каждая ветка цикла либо кладёт
  // кампанию, либо переносит запись, либо (когда не создано ещё ничего)
  // отвечает отказом выше.
  const primary = campaigns.find((c) => c.segment === null) ?? campaigns[0];
  const launchInfo: HeTemplateLaunchInfo = {
    campaign_id: primary.campaign_id,
    campaign_name: primary.campaign_name,
    campaign_url: primary.campaign_url,
    leads_count: accepted,
    preset_id: presetId,
    created_at: new Date().toISOString(),
    campaigns,
    // Счётчики рассыльщика целиком, а не только принятые: без «сколько
    // запрошено» молчаливая частичная загрузка неотличима от «столько адресов и
    // было» (launchHandoff.ts, HeTemplateLaunchCampaign).
    leads_requested: requested,
    leads_attempted: attempted,
    // Пустого массива не пишем: ключ означает «запуск не закончен», и запись без
    // него читается как законченная — в том числе все записи до 28.09.2026.
    ...(pending.length > 0 ? { pending } : {}),
  };

  // Запись сохраняется ДО решения об ответе — и даже когда рассыльщик не принял
  // ни одного адреса. Всё, что создано у рассыльщика, обязано быть записано:
  // именно на этом пути (500 без записи) терялась кампания первой группы, и
  // повтор плодил ей двойника.
  const { error: updErr } = await portalDb
    .from('he_templates')
    .update({ launch_info: launchInfo })
    .eq('id', templateId);
  if (updErr) {
    // Кампания уже создана — не превращаем ответ в ошибку (иначе слепой
    // ретрай плодит дубли), но честно предупреждаем, что дедуп-записи нет.
    await logError(`${eventPrefix}.info_save_failed`, updErr, {
      userId,
      templateId,
      instantlyCampaignId: primary.campaign_id,
    });
  }

  // Ни одного принятого адреса — отправлять оказалось некому, и «ok» тут врал
  // бы клиенту про запущенный аутрич. Кампании остались на паузе и ЗАПИСАНЫ
  // выше, поэтому повтор их достроит, а не продублирует.
  if (accepted === 0) {
    return { status: 500, body: { error: t.zeroAccepted, campaign_id: primary.campaign_id } };
  }

  const warnings: string[] = [];
  if (updErr) warnings.push(t.launchInfoSaveWarning);
  if (skippedInvalid > 0 || skippedIrrelevant > 0) {
    warnings.push(t.rowsSkippedNote(skippedInvalid, skippedIrrelevant));
  }
  // Новые причины отсева — отдельными фразами, а не третьим аргументом
  // rowsSkippedNote: у прежней фразы текст остаётся байт-в-байт (её читает
  // staff во внутреннем UI), а новые появляются только когда реально отсеяли.
  if (skippedUnverified > 0) {
    warnings.push(t.unverifiedSkippedNote(skippedUnverified));
  }
  // RU: строки без вердикта уехали (правило инструмента прежнее) — но теперь
  // сотрудник видит, сколько именно. Раньше это был молчаливый риск.
  if (unverifiedSent > 0) {
    warnings.push(t.unverifiedSentNote(unverifiedSent));
  }
  if (multiAddressRows > 0 || malformedEmailRows > 0) {
    warnings.push(t.unparsedEmailNote(multiAddressRows, malformedEmailRows));
  }
  if (blockedContacts > 0) {
    warnings.push(t.blockedContactsNote(blockedContacts));
  }
  // Потолок запуска (шаг 5b) — первым делом среди «почему уехало не всё»: он
  // единственный, кто снимает ПРОВЕРЕННЫЕ адреса, и единственный, чьё число
  // клиент может сверить со своим заказом компаний. leads.length здесь — это
  // уже выбранное потолком, то есть ровно то, что уезжает.
  if (capAddressesHeldBack > 0) {
    warnings.push(
      t.launchCapTrimmedNote(
        capCompaniesSent,
        leads.length,
        capAddressesHeldBack,
        capCompaniesHeldBack,
      ),
    );
  }
  if (segmentWhens.length > 0 && !segmentsMaterialized) {
    const legacy = buildLaunchSequence(templateLetters);
    const segWarning =
      locale === 'en'
        ? legacy && legacy.droppedSegmentVariants > 0
          ? t.segmentVariantsWarning(legacy.droppedSegmentVariants, legacy.lettersWithSegmentVariants)
          : null
        : legacy
          ? segmentVariantsWarning(legacy)
          : null;
    if (segWarning) warnings.push(segWarning);
  }
  if (segmentsMaterialized && campaigns.length > 1) {
    warnings.push(t.segmentSplitInfo(campaigns.length));
  }
  // Частичная загрузка — ПРЕДУПРЕЖДЕНИЕ, а не отказ: кампании созданы, адреса
  // в них лежат, и бросок на accepted < requested сломал бы работающий запуск.
  if (requested > accepted) {
    warnings.push(t.partialImportNote(requested, accepted));
  }
  if (keptCampaigns > 0) {
    warnings.push(t.relaunchKeptCampaignsNote(keptCampaigns));
  }
  if (refilledCampaigns > 0) {
    warnings.push(t.relaunchRefilledCampaignsNote(refilledCampaigns));
  }
  // Что СОЗДАНО — только на достройке: у первой попытки «создано N кампаний»
  // ничего не объясняет (создано всё), а у повтора это ровно то, чего в ответе
  // не хватало рядом с «перенесено» и «дозаполнено».
  if (resumeLaunch && createdCampaigns > 0) {
    warnings.push(t.relaunchCreatedCampaignsNote(createdCampaigns));
  }
  if (capacitySkippedSegments > 0) {
    warnings.push(t.capacityStopNote(capacitySkippedSegments));
  }
  for (const ge of groupErrors) {
    warnings.push(
      locale === 'en' ? `Segment campaign failed: ${ge}` : `Кампания сегмента не создана: ${ge}`,
    );
  }

  await logAudit(
    `${eventPrefix}.success`,
    'Hypothesis engine template sent to Instantly (paused)',
    {
      userId,
      templateId,
      baseId: base.id,
      presetId,
      instantlyCampaignId: primary.campaign_id,
      campaigns: campaigns.length,
      segmentsMaterialized,
      accepted,
      // Все три счётчика рассыльщика: запрошено / признано полученным /
      // принято. Остаток requested-accepted ПОВТОРЯЕМ (ни одна строка базы
      // запуском не помечается отправленной), и по журналу видно, часто ли он
      // вообще бывает.
      requested,
      attempted,
      totalLeads: leads.length,
      // Воронка отсева — в аудит, чтобы «отправили меньше, чем в базе»
      // объяснялось без доступа к строкам базы.
      skippedInvalid,
      skippedUnverified,
      unverifiedSent,
      skippedIrrelevant,
      multiAddressRows,
      malformedEmailRows,
      blockedContacts,
      // Потолок запуска: что он оставил и что снял. В аудите, а не только в
      // ответе, чтобы владелец видел по журналу, у каких запусков потолок
      // реально мешает, — это и есть вход в решение «поднимать ли 2000».
      capCompaniesSent,
      capAddressesHeldBack,
      capCompaniesHeldBack,
      // Стандартные поля лида: сколько раз одноимённая переменная письма
      // запретила заполнить поле. 0 — правило коллизии ни разу не сработало.
      standardFieldsHeldBack,
      // Достройка повтора: что перенесено, что дозаполнено, что осталось.
      resumeLaunch,
      keptCampaigns,
      refilledCampaigns,
      createdCampaigns,
      pendingSegments: pending.length,
      capacitySkippedSegments,
      force,
    },
  );

  return {
    status: 200,
    body: {
      ok: true,
      launch: launchInfo,
      warnings,
      // Только для проекции клиентского роута (он же обязан не пустить это
      // наружу): в error лежит сырьё рассыльщика, а имя сегмента нужно, чтобы
      // сказать клиенту, какая именно часть аудитории не поехала.
      ...(segmentFailures.length > 0 ? { segment_failures: segmentFailures } : {}),
    },
  };
}
