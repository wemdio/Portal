/**
 * «Отправить в запуск»: из готового шаблона «Движка вертикалей» создать
 * кампанию в Instantly НА ПАУЗЕ (никогда не активируем — сотрудник проверяет
 * её в Instantly сам) и загрузить лидов базы. Один запуск на шаблон: повтор
 * только с force (создаёт НОВУЮ paused-кампанию и перезаписывает launch_info).
 * У шаблона us-проекта force законченного запуска — отказ 409
 * 'force_relaunch_refused' (шаг 4b, с 14.10.2026): перезапись записи выводит
 * прежние кампании из паузы клиента, «Выключить отправку», блокировки и
 * engBlockedSweep, а получатели получили бы вторую цепочку.
 *
 * ИСКЛЮЧЕНИЕ — НЕЗАКОНЧЕННЫЙ ЗАПУСК (с 28.09.2026, шаг 6). При сплите по
 * сегментам кампаний создаётся несколько, и отказ поздней группы оставлял
 * созданные кампании без записи о них: повтор создавал каждому уже уехавшему
 * сегменту ВТОРУЮ одноимённую кампанию, а ёмкость воркспейса тратилась дважды.
 * Теперь launch_info пишется ПО ХОДУ запуска (с 01.10.2026): сразу, как узнан
 * id новой кампании (до досылки цепочки и до загрузки), и после каждого
 * подтверждённого чанка загрузки. В записи — созданные кампании с
 * подтверждёнными счётчиками и launch_info.pending: что ещё должно уехать, по
 * сегментам и ПОИМЁННО (адреса). Такой запуск:
 *   - повтор НЕ блокирует (409 остаётся только у законченного запуска);
 *   - повтор ДОСТРАИВАЕТ ровно должное: кампания сегмента без долга не
 *     трогается вовсе; кампания с долгом дозаполняется его адресами (адреса,
 *     уже лежащие у рассыльщика, он пропускает сам); заново создаются только
 *     сегменты, у которых кампании нет (или она удалена у рассыльщика).
 * Смерть процесса посреди запуска (рестарт, деплой) теряет поэтому не больше
 * одного шага: кампанию, созданную между ответом рассыльщика и записью, или
 * судьбу одного чанка — его повтор досылает с skip_if_in_campaign.
 *
 * АРЕНДА. Пока запуск идёт, запись держит running_until (продлевается каждой
 * записью, HE_LAUNCH_LEASE_MS; у первой попытки — с её первой записи, у
 * остальных — до первого обращения к рассыльщику, шаг 5b′), и второй запрос на
 * тот же шаблон получает 409, а не достраивает запуск параллельно с первым.
 * Каждая запись попытки условна (токен попытки attempt): попытка, у которой
 * запись перехватили, дальше не идёт. Финальная запись аренду снимает; после
 * смерти процесса она истекает сама.
 *
 * Законченный запуск ведёт себя как до 28.09.2026 (force = новые кампании), и
 * записи без ключа pending — все, что есть в RU-инструменте, — считаются
 * законченными.
 *
 * RU-ПРОЕКТ — КАК ДО ПОРТА ENG (решение владельца 14.10.2026 «Как было», с
 * 15.10.2026). Всё, что описано в этой шапке про запись по ходу, аренду,
 * достройку, предохранители и предполёт, — путь market='us'. Шаблон проекта с
 * любым другим рынком (то есть каждый проект staff-инструмента) после чтения
 * рынка (шаг 4b) уходит в runHeTemplateLaunchAsBeforePort (в конце файла):
 * прежний запуск байт в байт — одна запись в конце без pending и аренды,
 * отказ поздней группы сегментов — предупреждение законченного запуска, без
 * гейта вердиктов, чёрного списка клиента, стандартных полей лида и новых
 * предупреждений. Аренду и долг в записи шаблона RU-проекта (их мог оставить
 * код порта, работавший на проде с 14.10.2026) запуск не читает: рынок для
 * этого читается заранее (шаг 1, readHeLaunchStateMarket). Отличие от
 * прежнего — отказ на непрочитанном рынке (докблок той функции).
 *
 * ЧЕМ ЭТО НАЖИМАЕТСЯ (28.09.2026, там же). Механика достройки сама по себе была
 * недостижима из кабинета: шаг «Review & Launch» считал запускаемым шаблон без
 * ЛЮБОЙ записи о запуске, а частичный запуск запись оставляет — кнопка
 * пропадала ровно тогда, когда нужна. Вход теперь тот же, что и у первого
 * запуска: «Launch all» берёт и шаблоны с НЕЗАКОНЧЕННОЙ записью
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
 * ДВЕ ЗАЩИТЫ АУДИТОРИИ us-проекта (шаг 4b′, с 08.10.2026), до классификатора и
 * рассыльщика, force их не снимает: у ДРУГОГО шаблона той же базы уже есть
 * запуск — отказ 409 с кодом 'sibling_template_launched' (вторая цепочка тем же
 * людям); у проекта идёт повторное исследование — отказ 409 с кодом
 * 'research_running' (кластеризация удалит шаблон вместе с записью о запуске).
 * Признак «у шаблона есть запуск» один на ядро и research-роут кабинета:
 * heTemplateLaunchMarked. RU-проекты эти защиты не видят.
 *
 * Тарифных гейтов и журнала client_campaign_launches тут нет осознанно (см.
 * launchHandoff.ts): запуск HE-шаблона billing клиента не меняет.
 *
 * Три предохранителя стоят ДО первого вызова рассыльщика и все fail-closed —
 * ни один адрес не должен уехать «на всякий случай» (шаги 4c, 5 и 5a). Их
 * общее условие — прочитанный рынок проекта (шаг 4b): не прочитался — запуск
 * не состоялся в ОБОИХ контурах, потому что угадывать рынок по контуру значило
 * бы снять us-предохранители с us-проекта, запущенного из RU-инструмента:
 *   - запуск с базы us-проекта, собранной до обязательного разноса адресов по
 *     строкам, не состоится: её вердикт валидации может принадлежать другому
 *     адресу той же компании (шаг 4c);
 *   - вердикт валидации почты обязателен у market='us': строка без вердикта
 *     лидом не становится;
 *   - чёрный список контактов клиента: не прочитался — запуск не состоялся.
 * RU-ИНСТРУМЕНТ (он же ежедневный staff-инструмент) этих предохранителей не
 * видит: RU-проект идёт прежним запуском (runHeTemplateLaunchAsBeforePort) — без
 * гейта вердиктов и без чёрного списка клиента, как до порта ENG (решение
 * владельца 14.10.2026 «Как было»: список не вошёл в то, что остаётся у RU).
 * Сколько строк сняли эти предохранители, уходит в warnings ответа (после
 * сужения роутом — в ENG-кабинет) и в аудит.
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
 * launch_info.campaigns хранит весь список; скалярные поля — основная
 * кампания (их читает refill-долив). Что делать со строкой БЕЗ ответа
 * классификатора, решает рынок проекта (шаг 5c):
 *  - RU (как до 09.10.2026): строка уходит в дефолтный текст; системный сбой
 *    (упали все батчи) → легаси-путь: одна кампания, варианты выкинуты с
 *    явным предупреждением;
 *  - us (с 09.10.2026): «нет ответа» ≠ дефолтный сегмент. Такие строки
 *    ОТКЛАДЫВАЮТСЯ — не уходят в этом запуске и лежат в launch_info.pending
 *    стадией 'classify' поимённо; запуск записан незаконченным, и повтор
 *    («Launch all») классифицирует ровно их — это вторая и последняя
 *    попытка: что и она не разметила, уходит с основным текстом. Если без
 *    ответа больше HE_SEGMENT_HOLD_REFUSE_SHARE строк, запуск без такого
 *    долга (первый или force) отказывает до рассыльщика.
 *
 * ПРЕДПОЛЁТ us-ПРОЕКТА (с 09.10.2026, шаги 4b″–4b⁗), до классификатора и
 * рассыльщика, на любом пути к отправке через это ядро — запуск из кабинета,
 * запуск us-шаблона сотрудником из RU-инструмента, достройка незаконченного
 * запуска и force-перезапуск:
 *  - письма с подстановкой, которую база не наполнит (templateOperatorGate),
 *    — отказ 409 'template_unresolved_operators';
 *  - письма, которые называют наш бренд или вымышленную компанию из примера
 *    промпта, а клиент проекта не мы (letterBrandGuard: английские и
 *    польские — всегда, русские — у проекта клиента ENG-кабинета), — отказ
 *    409 'template_brand_leak';
 *  - английские письма со строкой отказа от писем или прощания (правило
 *    владельца, letterBrandGuard.heTemplateOptOutLines) — отказ 409
 *    'template_opt_out_lines' (с 14.10.2026; раньше — только на старте
 *    отправки, после оплаченного классификатора и созданных кампаний);
 *  - пресет без ящиков отправки — отказ 409 'preset_no_mailboxes';
 *  - окно отправки новых кампаний — выбор клиента, иначе дефолт кабинета, а не
 *    часы пресета (launchSchedule.ts).
 * Ночной долив (stages/baseCollectRefill) этим ядром не идёт: он доливает
 * адреса в кампанию, созданную здесь, — с её письмами, ящиками и окном.
 *
 * ОТКАЗ ПО МЕСТУ ПОД КОНТАКТЫ (решение владельца 04.10.2026). ENG-кабинет
 * читает нейтральную фразу без слова про место и рассыльщика (EN
 * capacityStopNote, HE_TEAM_ON_IT_EN), а команда получает алерт в health-бот
 * (alertTeamOnLaunchCapacity → opsAlert.ts) — на ЛЮБОМ таком отказе из
 * кабинета, в том числе когда клиент читает лишь общий отказ запуска.
 * RU-инструмент (locale 'ru') алерта не шлёт и читает прежний текст байт в байт.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { hasUsableCampaignSequences } from '@/lib/clientLaunch/campaignSequences';
import { filterBlockedLeads, getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { filterBlockedContacts, getBlockedContactSnapshot } from '@/lib/clientBlocklist/blockedDomains';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { createCampaign, createLeads, updateCampaign } from '@/lib/instantly/client';
import type { CampaignCreatePayload } from '@/lib/instantly/types';
import { InstantlyApiError, isInstantlyContactCapacityError } from '@/lib/instantly/errors';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError } from '@/lib/loggerServer';
// Справочник клиентских текстов без зависимостей: нейтральная фраза про отказ,
// который чинит команда (решение владельца 04.10.2026).
import { HE_TEAM_ON_IT_EN } from '@/components/client-eng/clientFailureText';
import type { ClientLaunchScheduleOverride } from '@/lib/clientLaunch/types';
import type { HeBase, HeTemplate } from './types';
import {
  classifyBaseRowsIntoSegmentsDetailed,
  detectSegmentLanguage,
  heLegacySegmentAssignments,
  type HeSegmentClassification,
} from './segmentClassify';
import {
  checkHeTemplateOperators,
  describeHeTemplateOperatorGate,
  withHeEmptyCellFallbacks,
  type HeTemplateStandInUse,
} from './templateOperatorGate';
import { describeHeLaunchWindow, resolveHeLaunchSendingWindow, type HeLaunchWindowSource } from './launchSchedule';
import { readHeCollectCountries } from './engCountries';
import { readHeEngBaseFirst } from './engBaseFirst';
import { rethrowHeEngBaseBudgetError, withHeEngBaseBudget } from './engBaseBudget';
import { getHeClientFailure } from './clientErrors';
import {
  HE_ENG_COMPANY_QUALIFICATION_REQUIRED,
  heEngCompanyQualified,
  heEngLaunchQualified,
  heEngQualifiedLaunchStamp,
  heEngScopeWithinCurrentCountries,
  readHeEngQualificationScope,
  type HeEngQualificationScope,
} from './engCompanyQualificationPolicy';
import { projectMarket, type HeMarket } from './market';
import { HE_OPS_STAGE_TEMPLATE_LAUNCH, notifyHeClientStop } from './opsAlert';
import {
  describeHeBrandLeaks,
  describeHeOptOutLines,
  heBrandNeedsOwner,
  heTemplateBrandLeaks,
  heTemplateOptOutLines,
  readHeBrandEngClient,
  readHeProjectOwnerKind,
} from './letterBrandGuard';
import { HE_ENG_POOL_CAMPAIGN_SETTINGS } from './engSendingPreset';
import { HE_RESEARCH_STAGES } from './researchJob';
import {
  HE_ENG_CAMPAIGN_NAMING,
  HE_LAUNCH_LEASE_MS,
  HE_LAUNCH_MAX_LEADS,
  buildLaunchCampaignName,
  buildLaunchSequence,
  findCompanyKeyColumns,
  findEmailColumn,
  heConstructContactCap,
  heLaunchEmailStrength,
  heLaunchEmailVerdict,
  heLaunchIsIncomplete,
  heLaunchRefusesOverCap,
  instantlyCampaignUrl,
  mapBaseRowsToLeads,
  parseLaunchInfo,
  readHeLaunchLease,
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
  /** Рынок проекта не прочитался — запуск остановлен до рассыльщика (шаг 4b). */
  marketReadFailed: string;
  /** Другой шаблон той же базы уже запущен — второй запуск тем же людям (шаг 4b′). */
  siblingTemplateLaunched: string;
  /** У проекта идёт research: кластеризация удалит этот шаблон вместе с записью (шаг 4b′). */
  researchRunning: string;
  /** Защиты шага 4b′ не прочитались — запуск остановлен до рассыльщика. */
  launchGuardReadFailed: string;
  /** Запуск этого шаблона идёт (или оборвался) — аренда записи жива (шаг 1). */
  launchInProgress: string;
  /** Начало запуска не записалось в шаблон — остановлено до рассыльщика (шаг 5b′). */
  launchStartSaveFailed: string;
  /** Незаконченный запуск: пресета, с которым он начат, больше нет (шаг 3). */
  resumePresetMissing: string;
  /** Незаконченный запуск достроен с пресетом записи, а не с выбранным (шаг 3). */
  resumePresetPinnedNote: string;
  /**
   * Потолок сработал как ВЫБОР, а не отказ (market='us', шаг 5b): что уехало и
   * что снято. Пять чисел, потому что клиенту важны оба измерения — компании
   * и адреса, — обе стороны потолка, и снятые адреса делятся на два разных
   * случая: все адреса компаний без единого адреса в запуске и вторые-третьи
   * адреса компаний, у которых один адрес уехал.
   */
  launchCapTrimmedNote: (
    companiesSent: number,
    addressesSent: number,
    addressesHeldBack: number,
    companiesHeldBack: number,
    addressesOfHeldBackCompanies: number,
  ) => string;
  segmentSplitInfo: (campaignsCount: number) => string;
  rowsSkippedNote: (invalid: number, irrelevant: number) => string;
  unverifiedSkippedNote: (unverified: number) => string;
  /** RU: строки без вердикта ОТПРАВЛЕНЫ (как до 26.09.2026) — назвать вслух. */
  unverifiedSentNote: (unverified: number) => string;
  unparsedEmailNote: (multiAddress: number, malformed: number) => string;
  blockedContactsNote: (blocked: number) => string;
  /** us-запуск: контакты, чей домен (адреса или сайта компании) в списке Do not contact. */
  blockedByDomainNote: (blocked: number) => string;
  instantlyFailedFallback: string;
  zeroAccepted: string;
  /**
   * Итоговая запись о запуске не сохранилась. Аргумент — сохранилась ли хоть
   * одна запись этой попытки (аренда или промежуточная): тогда в шаблоне
   * осталась более ранняя запись с живой арендой, и повтор сначала получит
   * «запуск ещё идёт»; иначе записи нет вовсе, и повтор не заблокирован.
   */
  launchInfoSaveWarning: (intermediateSaved: boolean) => string;
  segmentVariantsWarning: (dropped: number, lettersCount: number) => string;
  /**
   * Рассыльщик подтвердил МЕНЬШЕ адресов, чем мы отправили (шаг 6). Третье
   * число — сколько из отправленных он пропустил как уже лежащие в кампаниях
   * воркспейса (только загрузки достройки): они не «непринятые».
   */
  partialImportNote: (requested: number, accepted: number, alreadyPresent: number) => string;
  /** Повтор: кампании, уже принявшие адреса, оставлены как есть. */
  relaunchKeptCampaignsNote: (kept: number) => string;
  /** Повтор: пустые или недозаполненные кампании прошлой попытки дозаполнены вместо дублей. */
  relaunchRefilledCampaignsNote: (refilled: number) => string;
  /** Повтор: сколько кампаний создано СЕЙЧАС (сегментам, у которых их не было). */
  relaunchCreatedCampaignsNote: (created: number) => string;
  /** Повтор: кампаний прошлой попытки у рассыльщика больше нет — созданы новые. */
  relaunchReplacedCampaignsNote: (replaced: number) => string;
  /** Повтор: адреса долга уже лежали в кампаниях воркспейса и не добавлялись. */
  resumeAlreadyInCampaignNote: (present: number) => string;
  /** Повтор: адреса долга больше нельзя отправлять (блок, вердикт, ушли из базы). */
  owedUnsendableNote: (unsendable: number) => string;
  /**
   * Место под контакты в воркспейсе кончилось — остальные сегменты не
   * создавались. Второй аргумент — позвало ли ядро на этом отказе алерт
   * команде с рынком 'us' (шаг 6, catch): только тогда EN-текст вправе сказать
   * «команда уже работает». RU-текст его не читает.
   */
  capacityStopNote: (segments: number, teamAlerted: boolean) => string;
  /**
   * Письма us-шаблона несут подстановку, которую база не наполнит (шаг 4b″).
   * Аргумент — сводка гейта для staff (describeHeTemplateOperatorGate); EN его
   * не печатает: в сводке имена операторов и колонок.
   */
  templateOperatorsUnresolved: (detail: string) => string;
  /** В пресете us-запуска нет ни одного ящика отправки (шаг 4b‴). */
  presetNoMailboxes: string;
  /**
   * Классификатор сегментов не ответил по слишком большой доле строк us-запуска
   * (шаг 5c) — запуск не начат. EN — константа без чисел (её роут кабинета
   * пропускает как есть, HE_LAUNCH_CLIENT_SAFE_SERVER_ERRORS).
   */
  segmentClassifyIncomplete: (unanswered: number, total: number) => string;
  /** Строки us-запуска без ответа классификатора отложены до повтора (шаг 5c). */
  segmentRowsHeldNote: (held: number) => string;
  /**
   * Достройка us-запуска: отложенные адреса и на этой попытке классификатора
   * (номер `attempt`, последняя) остались без ответа — им основной текст (шаг 5c).
   */
  segmentRowsMainTextNote: (count: number, attempt: number) => string;
  /**
   * us: сегментные варианты есть, но ни один ОТПРАВЛЕННЫЙ адрес этого запуска в
   * сегмент не попал — все они получили основной текст (отложенные
   * классификатором не отправлены, о них segmentRowsHeldNote). Причина — ответ классификатора, а не
   * «рассыльщик не умеет условные блоки» (её у us больше не бывает: полный
   * сбой классификатора у us — отказ, а не легаси-путь).
   * `unanswered` > 0 — достройка отдала основной текст адресам, по которым
   * классификатор не ответил и на второй попытке (о них segmentRowsMainTextNote):
   * фраза говорит только про адреса, по которым ответ БЫЛ, иначе «ни один не
   * подошёл» спорило бы с «не смогли определить».
   */
  segmentNoMatchNote: (dropped: number, lettersCount: number, unanswered: number) => string;
  /**
   * Новые кампании us-запуска созданы с окном, которое выбрало ядро (окно не
   * передано — запуск сотрудником, достройка без кабинета): какое и откуда.
   */
  launchWindowNote: (window: string, source: HeLaunchWindowSource) => string;
  /** Сохранённое окно клиента не прочиталось — взят следующий источник. */
  launchWindowReadFailedNote: string;
}

/**
 * Отказ классификатора сегментов клиенту — ОДНА английская константа без
 * чисел: роут кабинета показывает 5xx ядра, только если текст совпал с
 * константой (HE_LAUNCH_CLIENT_SAFE_SERVER_ERRORS). Числа — в аудите и в
 * тексте staff. Срока повтора нет: роут кабинета ограничивает неудачные
 * запуски шаблона за час и отдаёт свой текст с этим правилом
 * (api/client/eng/templates/[id]/launch, SEGMENT_CHECK_STOPPED), а «через
 * несколько минут» на последнем месте этого лимита было бы неправдой.
 */
const SEGMENT_CLASSIFY_INCOMPLETE_EN =
  'We could not work out which segment of these letters fits too many of the addresses in this launch, so ' +
  'it was stopped before anything was sent or changed. You can try again later; if it keeps happening, ' +
  'contact Support.';

/**
 * Отказ шага 4b″ за чужую компанию в письмах (template_brand_leak). Тексты —
 * вне словаря MESSAGES: его RU-блок сверяется байт в байт. EN — клиенту, без
 * самого слова (письма — его, а не повод печатать наш бренд), с той же
 * кнопкой, что у отказа за подстановки: «Rewrite letters» рынка на шаге 3
 * (новые письма проходят эту проверку до сохранения); кнопки нет (бюджет
 * писем исчерпан, отправка аккаунта выключена, запуск незакончен) — Support.
 * RU — сотруднику, запускающему us-шаблон из RU-инструмента, со сводкой.
 */
const TEMPLATE_BRAND_LEAK_TEXT: { en: string; ru: (detail: string) => string } = {
  en:
    'These letters mention a brand or company name that is not yours, so this launch was stopped before ' +
    'anything was sent or changed. Press «Rewrite letters» on this market in step 3 to get new letters; if ' +
    'the button is not there, message Support.',
  // Новая сборка проходит ту же проверку до сохранения (стадии template и
  // chain — то же правило языка, letterBrandGuard), но у клиента
  // ENG-кабинета русская или польская цепочка пишется ролью «Polza» и
  // проверку проходить не будет — поэтому сначала английская цепочка.
  ru: (detail) =>
    'Запуск остановлен: письма шаблона us-проекта называют наш бренд или вымышленную компанию из примера ' +
    `промпта, а клиент проекта — другая компания (${detail}). Ничего не отправлено и не изменено. ` +
    'Пересоберите шаблон — новая сборка проходит эту проверку до сохранения; если цепочка вертикали не на ' +
    'английском, сначала перегенерируйте её на английском.',
};

/**
 * Отказ шага 4b″ за строки отказа от писем и прощания (template_opt_out_lines).
 * Тексты — вне словаря MESSAGES: его RU-блок сверяется байт в байт. EN —
 * клиенту: что не так и что делать. «Rewrite letters» не называется: кнопку
 * карточка рисует только по признаку `needs_rewrite`, а он этой причины пока
 * не знает, — поэтому Support. Фразы — из его же писем, без внутренних слов.
 * RU — сотруднику, со сводкой: письмо, вариант и фраза.
 */
const TEMPLATE_OPT_OUT_TEXT: { en: string; ru: (detail: string) => string } = {
  en:
    'These letters include a line that offers to stop writing to the recipient or says this is the last ' +
    "email, and letters can't include such lines. This launch was stopped before anything was sent or " +
    'changed. Message Support to have the letters rewritten.',
  ru: (detail) =>
    'Запуск остановлен: в письмах шаблона us-проекта есть строка, которая предлагает получателю отписаться ' +
    `или называет письмо последним (${detail}), — правило владельца такие строки запрещает. Ничего не ` +
    'отправлено и не изменено. Пересоберите шаблон без этих строк.',
};

/**
 * Отказ force законченного запуска us-шаблона (шаг 4b, force_relaunch_refused).
 * Тексты — вне словаря MESSAGES: его RU-блок сверяется байт в байт. RU —
 * сотруднику (staff-роут запуска шаблона принимает force); EN — на случай
 * вызова из контура кабинета (его роут force не пропускает до ядра).
 */
const FORCE_RELAUNCH_US_TEXT = {
  en: 'This template has already been launched, so it cannot be launched again. Nothing was sent or changed.',
  ru:
    'Повторный запуск с force закрыт для шаблона проекта английского кабинета: он создал бы новые кампании ' +
    'по тем же адресам и перезаписал бы запись о запуске, а прежние кампании (возможно, уже отправляющие из ' +
    'ящиков пула) выпали бы из паузы клиента, «Выключить отправку» и блокировки — получатели получили бы вторую ' +
    'цепочку. Ничего не создано и не изменено. Незаконченный запуск достраивается без force.',
} as const;

/** Аренда запуска в минутах — для текстов: число в них обязано следовать константе. */
const LEASE_MINUTES = Math.round(HE_LAUNCH_LEASE_MS / 60_000);

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
    marketReadFailed:
      'Не удалось прочитать рынок проекта — запуск остановлен до создания кампании: без рынка ' +
      'неизвестно, какие проверки адресов обязательны. Повторите попытку через минуту.',
    // Обе защиты шага 4b′ скоупнуты на market='us', поэтому RU-проект их не
    // видит; RU-тексты читает сотрудник, запускающий us-проект из RU-инструмента.
    siblingTemplateLaunched:
      'Запуск остановлен: другой шаблон этой же базы уже отправлен в запуск, и этот написал бы тем же ' +
      'людям вторую цепочку. Кампания не создавалась. По одной базе запускается один шаблон.',
    researchRunning:
      'Запуск остановлен: у проекта снова идёт исследование, а его кластеризация пересобирает ' +
      'вертикали и удаляет их базы и шаблоны вместе с записью о запуске — и этот шаблон тоже. ' +
      'Кампания не создавалась.',
    launchGuardReadFailed:
      'Не удалось проверить, не идёт ли у проекта исследование и не запущен ли другой шаблон этой базы, — ' +
      'запуск остановлен до создания кампании. Повторите попытку через минуту.',
    launchInProgress:
      'Запуск этого шаблона ещё идёт или оборвался посередине меньше ' +
      `${LEASE_MINUTES} минут назад. Подождите несколько минут и откройте шаблон снова: если часть ` +
      'запуска осталась незаконченной, повторный запуск достроит её, а не создаст второй запуск.',
    launchStartSaveFailed:
      'Не удалось отметить начало запуска в шаблоне — запуск остановлен до первого обращения к ' +
      'Instantly. Повторите попытку через минуту.',
    resumePresetMissing:
      'Запуск этого шаблона не закончен, а пресета, с которым он начат, больше нет. Достроить его ' +
      'можно только в том же воркспейсе Instantly (там лежат его кампании): верните пресет клиенту ' +
      'или разберите запуск вручную.',
    resumePresetPinnedNote:
      'Незаконченный запуск достроен с пресетом, с которым он начат, а не с выбранным сейчас: ' +
      'его кампании живут в воркспейсе того пресета.',
    // Достижим у us-проекта, запущенного сотрудником из RU-инструмента: гейт и
    // выборку по потолку задаёт рынок ПРОЕКТА, а язык текстов — контур.
    launchCapTrimmedNote: (
      companiesSent,
      addressesSent,
      addressesHeldBack,
      companiesHeldBack,
      addressesOfHeldBackCompanies,
    ) => {
      const extra = addressesHeldBack - addressesOfHeldBackCompanies;
      const parts: string[] = [];
      if (addressesOfHeldBackCompanies > 0) {
        parts.push(
          `${addressesOfHeldBackCompanies.toLocaleString('ru-RU')} — все адреса ` +
            `${companiesHeldBack.toLocaleString('ru-RU')} компаний, которым не досталось ни одного адреса`,
        );
      }
      if (extra > 0) {
        parts.push(
          `${extra.toLocaleString('ru-RU')} — вторые и следующие адреса компаний, чей лучший адрес уже уехал`,
        );
      }
      return (
        `Потолок одного запуска — ${HE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')} адресов, ` +
        'поэтому отправлено не всё: ' +
        `${addressesSent.toLocaleString('ru-RU')} адресов у ${companiesSent.toLocaleString('ru-RU')} компаний — ` +
        'сначала по одному адресу на компанию — с лучшим вердиктом валидации, — ' +
        'потом вторые, пока хватало потолка. ' +
        `Потолок снял ${addressesHeldBack.toLocaleString('ru-RU')} адресов: ${parts.join('; ')}` +
        '. Снятые строки остались в базе и НЕ помечены отправленными.'
      );
    },
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
    // Текст staff для us-запуска; RU-путь (runHeTemplateLaunchAsBeforePort)
    // доменов не читает и эту строку не печатает.
    blockedByDomainNote: (blocked) =>
      `Исключено контактов, чей домен в чёрном списке клиента: ${blocked.toLocaleString('ru-RU')}.`,
    instantlyFailedFallback: 'Не удалось создать кампанию',
    zeroAccepted: 'Система рассылки не приняла ни одного контакта. Кампания оставлена на паузе.',
    launchInfoSaveWarning: (intermediateSaved) =>
      intermediateSaved
        ? 'Кампании созданы, но итоговая запись о запуске не сохранилась в шаблон — в нём осталась ' +
          'более ранняя запись (промежуточная запись этой попытки или запись до неё). Повтор в ближайшие ' +
          `${LEASE_MINUTES} минут ответит «запуск ещё идёт»; прежде чем повторять, сверьте кампании ` +
          'шаблона в Instantly с этой записью.'
        : 'Кампания создана, но запись о запуске не сохранилась в шаблон (вероятно, не применена миграция he_templates.launch_info) — повторный запуск не будет заблокирован.',
    segmentVariantsWarning: (dropped, lettersCount) =>
      `Сегментные варианты (${dropped} шт. в ${lettersCount} письмах) не попали в кампанию: ` +
      'Instantly не умеет условные блоки — в рассылку ушёл основной текст писем.',
    partialImportNote: (requested, accepted, alreadyPresent) =>
      `Instantly подтвердил ${accepted.toLocaleString('ru-RU')} адресов из ` +
      `${requested.toLocaleString('ru-RU')} отправленных` +
      (alreadyPresent > 0
        ? `, ещё ${alreadyPresent.toLocaleString('ru-RU')} уже лежали в кампаниях воркспейса`
        : '') +
      ': остаток ' +
      `${(requested - accepted - alreadyPresent).toLocaleString('ru-RU')} в кампанию не попал. ` +
      'Отправленными эти строки НЕ помечены (запуск в базу не пишет вовсе), поэтому остаток ' +
      'повторяем — но повторная загрузка делается осознанно, а не автоматически: ' +
      'адрес, уже лежащий в кампании, получил бы второе письмо.',
    relaunchKeptCampaignsNote: (kept) =>
      `Повтор запуска: ${kept.toLocaleString('ru-RU')} кампаний этого шаблона уже созданы прошлой ` +
      'попыткой — они оставлены как есть, второй раз не создавались и лидов в них не досылали.',
    relaunchRefilledCampaignsNote: (refilled) =>
      `Повтор запуска: ${refilled.toLocaleString('ru-RU')} пустых или недозаполненных кампаний ` +
      'прошлой попытки дозаполнены вместо создания одноимённых дублей. Адреса, которые уже лежат в кампаниях ' +
      'воркспейса, Instantly при этом пропускает — иначе получатель получил бы второе письмо.',
    relaunchCreatedCampaignsNote: (created) =>
      `Повтор запуска: создано кампаний сейчас — ${created.toLocaleString('ru-RU')}: ` +
      'по тем частям аудитории, у которых кампании не было вовсе. Адреса, уже лежащие в кампаниях ' +
      'воркспейса, Instantly в них не берёт (защита от второго письма), поэтому принятых в такой ' +
      'кампании может быть меньше, чем отправлено.',
    relaunchReplacedCampaignsNote: (replaced) =>
      `Повтор запуска: ${replaced.toLocaleString('ru-RU')} кампаний прошлой попытки в Instantly больше ` +
      'нет (удалены) — для тех же частей аудитории созданы новые. Адреса, уже лежащие в кампаниях ' +
      'воркспейса, Instantly в них не берёт.',
    resumeAlreadyInCampaignNote: (present) =>
      `Повтор запуска: ${present.toLocaleString('ru-RU')} адресов уже лежали в кампаниях воркспейса ` +
      '(скорее всего, их успела принять оборванная попытка) — второй раз их не добавляли, и ' +
      'непринятыми они не считаются.',
    owedUnsendableNote: (unsendable) =>
      `Повтор запуска: ${unsendable.toLocaleString('ru-RU')} адресов из незаконченной части запуска ` +
      'не отправлено — с прошлой попытки они попали в чёрный список клиента, лишились допускающего ' +
      'вердикта валидации или ушли из базы.',
    capacityStopNote: (segments) =>
      'В воркспейсе Instantly кончилось место под контакты, поэтому ' +
      `${segments.toLocaleString('ru-RU')} сегментов этого запуска не создавались вовсе. ` +
      'Освободите место и повторите запуск: уже созданные кампании повтор не дублирует.',
    // Тексты ниже достижимы только у us-проекта (их условия скоупнуты на
    // market='us'); RU-тексты читает сотрудник, запускающий us-шаблон из
    // RU-инструмента.
    templateOperatorsUnresolved: (detail) =>
      'Запуск остановлен: в письмах шаблона us-проекта есть подстановки, которые база не наполнит, — ' +
      `получатель увидел бы пустое место, слово-заглушку или сырой шаблон (${detail}). ` +
      'Ничего не отправлено и не изменено. Пересоберите шаблон: новая сборка проходит эту проверку до сохранения.',
    presetNoMailboxes:
      'Запуск остановлен: в пресете нет ни одного ящика отправки (email_account_ids пуст) — кампания ' +
      'us-проекта не отправила бы ни письма. Ничего не отправлено и не изменено. Привяжите ящики к пресету ' +
      'клиента и повторите запуск.',
    segmentClassifyIncomplete: (unanswered, total) =>
      `Запуск остановлен: классификатор сегментов не дал ответа по ${unanswered.toLocaleString('ru-RU')} из ` +
      `${total.toLocaleString('ru-RU')} адресов — больше допустимой доли. Дефолтный текст вместо их сегмента ` +
      'us-проекту не отправляется, а запускать меньшую часть при лежащем классификаторе незачем. ' +
      'Ничего не отправлено и не изменено, повтор безопасен; класс сбоя батчей — в аудите запуска.',
    segmentRowsHeldNote: (held) =>
      `Отложено адресов: ${held.toLocaleString('ru-RU')} — классификатор сегментов не дал по ним ответа ` +
      '(упавший батч или неразмеченная строка), а дефолтный текст вместо их сегмента с первой попытки ' +
      'us-проекту не отправляется. Они не отправлены и записаны в запуск поимённо: запуск помечен ' +
      'незаконченным, и повтор (POST этого шаблона …/launch или «Launch all (paused)» в кабинете клиента) ' +
      'классифицирует ровно их и доложит в кампании их сегментов. Это последняя попытка: адреса, по которым ' +
      'классификатор не ответит и на ней, уйдут с основным текстом писем.',
    segmentRowsMainTextNote: (count, attempt) =>
      `С основным текстом вместо сегментного: ${count.toLocaleString('ru-RU')} адр. — классификатор ` +
      `сегментов не дал по ним ответа ни при запуске, который их отложил, ни на этом повторе (попыток: ` +
      `${attempt}). Третьей платной попытки нет: основной текст писем читается верно, он лишь не сегментный.`,
    segmentNoMatchNote: (dropped, lettersCount, unanswered) =>
      unanswered > 0
        ? `Сегментные варианты (${dropped} шт. в ${lettersCount} письмах) не использованы: ни один адрес этого ` +
          'запуска, по которому классификатор ответил, не попал ни в один сегмент.'
        : `Сегментные варианты (${dropped} шт. в ${lettersCount} письмах) не понадобились: ни один отправленный ` +
          'в этом запуске адрес классификатор не отнёс ни к одному сегменту — все они получили основной текст писем.',
    launchWindowNote: (window, source) =>
      `Окно отправки новых кампаний us-запуска: ${window} — ` +
      (source === 'template'
        ? 'выбор клиента для этого шаблона'
        : source === 'project'
          ? 'окно «Launch» этого проекта'
          : source === 'client'
            ? 'последний выбор клиента на другом шаблоне этого проекта'
            : source === 'suggested'
              ? 'пояс по списку стран проекта, часы дефолта ENG-кабинета'
              : 'дефолт ENG-кабинета') +
      '. Часы пресета us-проекту не ставятся.',
    launchWindowReadFailedNote:
      'Сохранённые окна отправки клиента не прочитались — новые кампании созданы с окном из строки выше. ' +
      'Если клиент выбирал своё окно, сверьте его до активации.',
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
    // перечитать список, а если он пуст, написать в Support (пресеты заводит
    // команда) — той же фразой, что печатает пустой список на шаге 5
    // (EngStepReview.tsx).
    presetNotFound:
      'This sending preset is no longer available. Refresh the page and pick a sending preset again — '
      + 'if none is offered, message Support to have one set up.',
    noLetters: 'The template has no letters to launch',
    noEmailColumn: 'No email column found in the collected base',
    noValidEmails: 'The base contains no valid email addresses',
    // Действие — то, которое в кабинете ЕСТЬ. Пересобрать базу клиент из
    // кабинета не может: шаг 4 — витрина, UI-вызова POST /verticals/[id]/collect
    // нет для готовой базы («Collect again» — только у остановленной сборки), а
    // «Start outreach» новой сборки при готовой базе не ставит. Поэтому —
    // Support (сборку заново ставит команда), той же фразой, что и карточка
    // базы на шаге 4 (EngStepBases.tsx): два экрана про одну и ту же беду
    // обязаны вести к одному и тому же.
    baseNotVerified: (unverified) =>
      'Launch stopped: not a single address in this base has passed email validation. ' +
      `Rows without a validation verdict: ${unverified.toLocaleString('en-US')}. ` +
      'An unverified address is never contacted, because the bounces would hit your sending domain. ' +
      'Message Support to have this audience collected again — a new collection runs the email check to the end.',
    // Клиенту — без имён шагов, таблиц и дат нашего релиза: ему важны факт,
    // причина и действие. Слово instantly в тексте недопустимо (scrubBrand
    // заменил бы его русской фразой на английском экране). Действие — Support
    // по той же причине, что у baseNotVerified выше: собрать готовую базу
    // заново из кабинета нельзя. Обещания «и этот шаблон запустится» нет: новая
    // сборка — новая база, и шаблон у неё свой.
    baseCollectedBeforeSplit:
      'Launch stopped: this audience was collected by an earlier version of our collection pipeline. ' +
      'Back then one row could hold several addresses of the same company, and the email check saved a ' +
      'single result for the whole group — the best one of them. ' +
      'So we cannot prove that the address left on a row is the one that passed the check, and writing to ' +
      'the wrong one would put bounces on your sending domain. ' +
      'Message Support to have this audience collected again — a new collection keeps one address per row ' +
      'with its own check result.',
    blocklistLoadFailed:
      'Your «Do not contact» list could not be read, so the launch was stopped before any campaign was created. ' +
      'Try again in a minute. If it stops again, open «Do not contact»: a list over 10,000 addresses stops every ' +
      'launch until it is shortened. Otherwise, message Support.',
    allContactsBlocked: 'Every address in this base is on your blocked-contacts list, so there is nobody to write to.',
    tooManyLeads: (count) =>
      `Too many leads for a wizard launch: ${count.toLocaleString('en-US')}. Maximum is ${HE_LAUNCH_MAX_LEADS.toLocaleString('en-US')}.`,
    // Тексты отказов 5xx этого словаря, которые клиенту можно показать как есть
    // (они говорят, что кампания не создана и повтор безопасен), перечислены в
    // HE_LAUNCH_CLIENT_SAFE_SERVER_ERRORS ниже — клиентский роут заменяет
    // остальные 5xx общей константой.
    marketReadFailed:
      'The settings of this project could not be read, so the launch was stopped before any campaign ' +
      'was created. Please try again in a minute.',
    // Шаг 4b′: правда для любого состояния записи соседа — законченный запуск,
    // незаконченный или идущий прямо сейчас («has already been launched» —
    // кампания соседа создана: признак — campaign_id его записи или живая
    // аренда попытки, heTemplateLaunchMarked).
    siblingTemplateLaunched:
      'Another template of this audience has already been launched, so this one was not: launching it ' +
      'too would send the same people a second sequence. No campaign was created for this template.',
    // Шаблон существует только после кластеризации, поэтому любая активная
    // research-стадия у такого проекта — повторное исследование. «When the
    // research completes»: упади оно раньше кластеризации, шаблон уцелеет.
    researchRunning:
      'Research is running again for this project. When it completes, it rebuilds the markets and ' +
      'deletes their audiences and templates, this one included, so the launch was stopped before any ' +
      'campaign was created.',
    launchGuardReadFailed:
      'The state of this project could not be checked, so the launch was stopped before any campaign ' +
      'was created. Please try again in a minute.',
    launchInProgress:
      'A launch of this template is still in progress, or stopped midway less than ' +
      `${LEASE_MINUTES} minutes ago. Wait a few minutes and check this template again: if part of the ` +
      'launch is unfinished, launching again finishes that part instead of starting a second launch.',
    launchStartSaveFailed:
      'The start of this launch could not be recorded, so it was stopped before any campaign was ' +
      'created or changed. Please try again in a minute.',
    resumePresetMissing:
      'This launch is unfinished, and the sending preset it was started with is no longer available, ' +
      'so it cannot be finished from here. Message Support about this launch.',
    resumePresetPinnedNote:
      'This unfinished launch was finished with the sending preset it was started with, not the one ' +
      'picked now, because its campaigns live there.',
    // Обещать «остальное уедет позже» нельзя: добора именно этих строк в
    // движке нет, ночной долив собирает НОВЫЕ компании. Поэтому говорим ровно
    // то, что правда: что уехало, что снято и что снятое не сожжено.
    launchCapTrimmedNote: (
      companiesSent,
      addressesSent,
      addressesHeldBack,
      companiesHeldBack,
      addressesOfHeldBackCompanies,
    ) => {
      const extra = addressesHeldBack - addressesOfHeldBackCompanies;
      const parts: string[] = [];
      if (addressesOfHeldBackCompanies > 0) {
        parts.push(
          `${addressesOfHeldBackCompanies.toLocaleString('en-US')} of them ` +
            `${addressesOfHeldBackCompanies === 1 ? 'belongs' : 'belong'} to ` +
            `${companiesHeldBack.toLocaleString('en-US')} ` +
            `${companiesHeldBack === 1 ? 'company' : 'companies'} that got no address in this launch`,
        );
      }
      if (extra > 0) {
        parts.push(
          `${extra.toLocaleString('en-US')} of them ` +
            `${extra === 1 ? 'is a further address' : 'are further addresses'} of companies that ` +
            'already have one address in it',
        );
      }
      return (
        `One launch carries at most ${HE_LAUNCH_MAX_LEADS.toLocaleString('en-US')} addresses, so not every ` +
        `address of this audience is in it: ${addressesSent.toLocaleString('en-US')} addresses across ` +
        `${companiesSent.toLocaleString('en-US')} companies are being sent — one address per company first, ` +
        'the one whose email check came back strongest, then second addresses while the limit allowed. ' +
        `The limit held back ${addressesHeldBack.toLocaleString('en-US')} addresses: ${parts.join(', and ')}` +
        '. Nothing was marked as contacted and your audience keeps every held-back address.'
      );
    },
    // Без «All campaigns are paused»: кабинет стартует кампании сразу после
    // ядра (engClientLaunch), и рядом с итогом «Sending has started» фраза
    // была бы неправдой; состояние отправки говорит итог старта.
    segmentSplitInfo: (campaignsCount) =>
      `This launch was split into ${campaignsCount} campaigns by audience segment; each segment campaign has its own letter texts.`,
    rowsSkippedNote: (invalid, irrelevant) =>
      `Base rows skipped: ${invalid.toLocaleString('en-US')} with an invalid email (verification) and ${irrelevant.toLocaleString('en-US')} irrelevant to the market.`,
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
    blockedByDomainNote: (blocked) =>
      `Contacts left out because their company's domain is on your Do not contact list: ${blocked.toLocaleString('en-US')}.`,
    instantlyFailedFallback: 'Failed to create the campaign',
    zeroAccepted: 'The mailing system did not accept any contacts. The campaign was left paused.',
    // Вторая ветка называет нашу колонку — клиентский роут заменит её общей
    // формулировкой (INTERNAL_TRACE_RE); первая написана для клиента.
    launchInfoSaveWarning: (intermediateSaved) =>
      intermediateSaved
        ? 'The campaigns were created, but the final record of this launch could not be saved, so the ' +
          'template keeps an earlier record of it. Launching again within the next ' +
          `${LEASE_MINUTES} minutes is refused as still in progress. Before launching it again, message ` +
          'Support so our team can compare the campaigns with that record.'
        : 'The campaign was created, but the launch record was not saved to the template (the he_templates.launch_info migration is probably not applied) — a re-launch will not be blocked.',
    segmentVariantsWarning: (dropped, lettersCount) =>
      `Segment variants (${dropped} across ${lettersCount} letters) were not included in the campaign: ` +
      'the mailing system cannot run conditional blocks — the main letter text was used instead.',
    // Клиенту важно, что остаток НЕ сожжён, и что второй загрузкой мы не рискуем
    // отправить кому-то второе письмо. Действие — Support, как и в других
    // текстах этого файла: кнопки повторной загрузки в кабинете нет.
    partialImportNote: (requested, accepted, alreadyPresent) =>
      `The mailing system confirmed ${accepted.toLocaleString('en-US')} of the ` +
      `${requested.toLocaleString('en-US')} addresses we sent` +
      (alreadyPresent > 0
        ? ` and found ${alreadyPresent.toLocaleString('en-US')} more already in one of your campaigns`
        : '') +
      ', so ' +
      `${(requested - accepted - alreadyPresent).toLocaleString('en-US')} of them did not get into the campaign. ` +
      'Nothing in your audience was marked as contacted, so those addresses can still be used. ' +
      'Message Support about this launch before anyone uploads them a second time — an address ' +
      'that is already in a campaign would get two letters.',
    // Число в фразах ниже бывает и 1: достройка отложенных классификатором
    // адресов (шаг 5c) обычно дозаполняет одну кампанию и оставляет остальные.
    // Фраза говорит только то, что ядро гарантирует на любом пути: кампании не
    // создавались заново и контакты в них не добавлялись. Их окно отправки ядро
    // не трогает, и роут кабинета на достройке тоже (с 12.10.2026 у рынка свои
    // часы — engClientLaunch.heEngLaunchWindowPlan).
    relaunchKeptCampaignsNote: (kept) =>
      `This launch was repeated: ${kept.toLocaleString('en-US')} campaign${kept === 1 ? '' : 's'} of this ` +
      `template already existed from an earlier attempt. ${kept === 1 ? 'It was' : 'They were'} not created ` +
      `again, and no contacts were added to ${kept === 1 ? 'it' : 'them'}.`,
    relaunchRefilledCampaignsNote: (refilled) =>
      `This launch was repeated: ${refilled.toLocaleString('en-US')} campaign${refilled === 1 ? '' : 's'} ` +
      `that an earlier attempt created but did not finish filling ${refilled === 1 ? 'was' : 'were'} ` +
      'completed now, instead of creating a second campaign with the same name. Addresses that are already ' +
      'in a campaign are skipped, so nobody gets two letters.',
    relaunchCreatedCampaignsNote: (created) =>
      `This launch was repeated: ${created.toLocaleString('en-US')} campaign${created === 1 ? '' : 's'} ` +
      `${created === 1 ? 'was' : 'were'} created now, for the part${created === 1 ? '' : 's'} of your ` +
      'audience that had no campaign at all. Addresses that are already in one of your campaigns are ' +
      'skipped there, so such a campaign can end up with fewer contacts than we sent — that way nobody ' +
      'gets two letters.',
    relaunchReplacedCampaignsNote: (replaced) =>
      `This launch was repeated: ${replaced.toLocaleString('en-US')} ` +
      `campaign${replaced === 1 ? '' : 's'} that an earlier attempt created ` +
      `${replaced === 1 ? 'is' : 'are'} no longer in the mailing workspace, so new ` +
      `${replaced === 1 ? 'one was' : 'ones were'} created for the same part of your audience. Addresses ` +
      'that are already in one of your campaigns are skipped there, so nobody gets two letters.',
    resumeAlreadyInCampaignNote: (present) =>
      `This launch was repeated: ${present.toLocaleString('en-US')} ` +
      `address${present === 1 ? ' was' : 'es were'} already in one of your campaigns (most likely the ` +
      'interrupted attempt got them in), so they were not added a second time.',
    owedUnsendableNote: (unsendable) =>
      `This launch was repeated: ${unsendable.toLocaleString('en-US')} ` +
      `address${unsendable === 1 ? '' : 'es'} from its unfinished part ${unsendable === 1 ? 'was' : 'were'} ` +
      'not sent, because since the earlier attempt they were blocked, lost their passing email check or ' +
      'left this audience.',
    // Решение владельца 04.10.2026: про место под контакты, рассыльщика и
    // «освободите место» клиент не читает — только нейтральную фразу
    // HE_TEAM_ON_IT_EN. Её вторая половина («команда уже знает и работает»)
    // правда только при teamAlerted: на этом же отказе ядро позвало алерт
    // команде с рынком 'us' (шаг 6, catch → opsAlert.notifyHeClientStop).
    // Иначе — та же причина без обещания. «more»: сегмент, на котором кончилось
    // место, назван своим предупреждением («Segment campaign failed», роут
    // кабинета), а это число — сегменты ПОСЛЕ него, которые даже не пробовали.
    // «did not go out», а не «were not created»: на достройке у такого сегмента
    // кампания может уже быть — не уехали только его адреса. Факт про повтор
    // оставлен — он правда (незаконченный запуск достраивается, шапка файла),
    // а «Launch now» у рынка на шаге 3 запускает и незаконченный запуск (S3;
    // при «Launch» проекта его достраивает и автозапуск).
    capacityStopNote: (segments, teamAlerted) =>
      `${segments.toLocaleString('en-US')} more segment${segments === 1 ? '' : 's'} of your audience ` +
      'did not go out in this launch. ' +
      (teamAlerted
        ? `${HE_TEAM_ON_IT_EN} Message Support to find out when it is fixed — then launch again with ` +
          '«Launch now»'
        : 'This stopped because of a temporary problem on our side. Message Support to find out when to ' +
          'launch again with «Launch now»') +
      '; repeating this launch does not duplicate the campaigns that were already created.',
    // Правда для всех трёх форм гейта (templateOperatorGate): подстановка без
    // колонки в теме (пусто), без колонки и fallback в теле (пусто), имя
    // человека с fallback («there» — слово-заглушка), битый фрагмент вида
    // «{company}» (сырой шаблон). Сводку для staff клиенту не печатаем: в ней
    // имена операторов и колонок. Действие — «Rewrite letters» у рынка на
    // шаге 3 (S3: новые письма той же базы, бюджет поколения — 3 прогона);
    // исчерпан бюджет — кнопки нет, и тогда Support. Обе ветки в одной фразе:
    // она правда при любом остатке бюджета.
    templateOperatorsUnresolved: () =>
      'These letters contain a placeholder (such as a first name) that cannot be filled in from this ' +
      'audience, so recipients would see a blank, a stand-in word or the raw placeholder in its place. ' +
      'This launch was stopped before anything was sent or changed. Press «Rewrite letters» on this market ' +
      'in step 3 to get new letters; if the button is not there, message Support.',
    // Пресет клиент не правит (его заводит администратор; подключение ящика на
    // странице почты кабинета в пресет его не добавляет), поэтому — Support.
    // «Before anything was sent or changed» — правда и для первого запуска, и
    // для достройки (её кампании уже есть, но эта попытка их не трогала).
    presetNoMailboxes:
      'Your sending preset has no mailboxes connected, so a campaign launched with it could not send a ' +
      'single email. This launch was stopped before anything was sent or changed. Message Support to have ' +
      'your mailboxes connected to the sending preset, then launch again.',
    // Правда при любом исходе: отказ бывает только у попытки без поимённого
    // долга (первый запуск, force), и он до рассыльщика — кампаний этой
    // попытки нет, прежняя запись (у force) возвращена как была.
    segmentClassifyIncomplete: () => SEGMENT_CLASSIFY_INCOMPLETE_EN,
    // «Launch now» у рынка на шаге 3 снова запускает такой шаблон: запуск
    // записан незаконченным (heLaunchIsIncomplete); при «Launch» проекта его
    // повторяет и автозапуск. Повтор шлёт с skip_if_in_campaign и — вторая и
    // последняя попытка — отдаёт неразмеченным основной текст (шаг 5c).
    segmentRowsHeldNote: (held) => {
      const it = held === 1 ? 'it' : 'them';
      return (
        `${held.toLocaleString('en-US')} ${held === 1 ? 'address' : 'addresses'} of this audience did not go ` +
        `out in this launch: we could not yet work out which segment of these letters fits ${it}, so ` +
        `${held === 1 ? 'it waits' : 'they wait'} for one more try instead of getting the main letter text ` +
        `straight away. Nobody was contacted for ${it} and your audience keeps ${it}. Press «Launch now» ` +
        `again to send ${it}: we try once more, and ` +
        (held === 1
          ? 'if we still cannot place it, it gets the main letter text. '
          : 'any we still cannot place get the main letter text. ') +
        'The campaigns already created are reused, so nobody is contacted twice.'
      );
    },
    // «get»: адреса уже отданы основной группе этой попытки; не доехали сейчас
    // — остались её долгом с тем же основным текстом (pending основной кампании).
    segmentRowsMainTextNote: (count, attempt) => {
      const it = count === 1 ? 'it' : 'them';
      return (
        `${count.toLocaleString('en-US')} ${count === 1 ? 'address' : 'addresses'} of this audience ` +
        `${count === 1 ? 'gets' : 'get'} the main letter text instead of a segment version: we tried ` +
        `${attempt === 2 ? 'twice' : `${attempt.toLocaleString('en-US')} times`} and could not work out which ` +
        `segment of these letters fits ${it}.`
      );
    },
    // «sent»: отложенные классификатором адреса (segmentRowsHeldNote рядом)
    // не уехали и основного текста не получили — фраза только про уехавшие.
    // Достройка с адресами без ответа (segmentRowsMainTextNote рядом): они тоже
    // уехали с основным текстом, но не потому, что не подошли, — фраза только
    // про те, что удалось проверить; «this launch» верно и про весь запуск, и
    // про это нажатие. Глагол согласуется с вариантами, а не с письмами
    // («2 segment versions across 1 letter were», а не «… letter was»).
    segmentNoMatchNote: (dropped, lettersCount, unanswered) =>
      (unanswered > 0
        ? 'Of the addresses in this launch we could check, none matched a segment these letters were written ' +
          'for, so the '
        : 'None of the addresses sent in this launch matched a segment these letters were written for, so all of ' +
          'them got the main letter text; the ') +
      `${dropped.toLocaleString('en-US')} segment ` +
      `${dropped === 1 ? 'version' : 'versions'} across ${lettersCount.toLocaleString('en-US')} ` +
      `${lettersCount === 1 ? 'letter' : 'letters'} ${dropped === 1 ? 'was' : 'were'} not used.`,
    // Из кабинета окно приходит явным (роут), и эта фраза не печатается;
    // текст нужен словарю и честен для любого источника.
    launchWindowNote: (window, source) =>
      `New campaigns of this launch use the sending window ${window} — ` +
      (source === 'template'
        ? 'the one picked for this template'
        : source === 'project'
          ? 'the one picked when you launched this project'
          : source === 'client'
            ? 'the one picked most recently for your other campaigns in this project'
            : source === 'suggested'
              ? "the time zone of your project's countries with the default hours"
              : 'the default for US campaigns') +
      '. You can change it in the sending window of this template.',
    launchWindowReadFailedNote:
      'Your saved sending windows could not be read, so the new campaigns of this launch use the window ' +
      'named above. Check the sending window of this template before the campaigns are started.',
  },
};

/**
 * 5xx ядра, которые клиентский ENG-роут отдаёт кабинету КАК ЕСТЬ, а не общей
 * константой «Failed to launch the campaign»: английские константы этого
 * словаря без сырья, и каждая говорит клиенту то, что ему нужно для решения —
 * кампания не создана и повтор безопасен (блоклист, пресет, рынок, начало
 * запуска не записались) либо кампании стоят на паузе и записаны (никто не
 * принял ни одного адреса). Остальные 5xx несут сообщение Postgres или тело
 * ответа рассыльщика и наружу не уходят (api/client/eng/templates/[id]/launch).
 */
const HE_LAUNCH_CLIENT_SAFE_SERVER_ERRORS: ReadonlySet<string> = new Set([
  // 503 классификатора сегментов: ничего не отправлено и не изменено, повтор безопасен.
  SEGMENT_CLASSIFY_INCOMPLETE_EN,
  MESSAGES.en.blocklistLoadFailed,
  MESSAGES.en.presetLoadFailed,
  MESSAGES.en.marketReadFailed,
  MESSAGES.en.launchGuardReadFailed,
  MESSAGES.en.launchStartSaveFailed,
  MESSAGES.en.zeroAccepted,
]);

/** Можно ли показать клиенту текст 5xx ядра как есть (см. набор выше). */
export function isHeLaunchClientSafeServerError(text: unknown): boolean {
  return typeof text === 'string' && HE_LAUNCH_CLIENT_SAFE_SERVER_ERRORS.has(text);
}

/**
 * 5xx ядра (английский словарь), которые случаются ДО классификатора сегментов
 * (шаг 5c) — значит, до любой платной работы запуска: пресет (шаг 3), рынок
 * проекта (4b), защиты аудитории (4b′), чёрный список (5a) и аренда записи
 * (5b′) не прочитались или не записались. Четыре из пяти текстов зовут
 * повторить через минуту. Роут кабинета не считает такие отказы в лимите
 * неудачных запусков шаблона (api/client/eng/templates/[id]/launch): повтор
 * ничего не оплачивает заново, и «через минуту» должно оставаться правдой.
 */
const HE_LAUNCH_UNPAID_SERVER_ERRORS: ReadonlySet<string> = new Set([
  MESSAGES.en.presetLoadFailed,
  MESSAGES.en.marketReadFailed,
  MESSAGES.en.launchGuardReadFailed,
  MESSAGES.en.blocklistLoadFailed,
  MESSAGES.en.launchStartSaveFailed,
]);

/** 5xx ядра до платной части запуска (см. набор выше). */
export function isHeLaunchUnpaidServerError(text: unknown): boolean {
  return typeof text === 'string' && HE_LAUNCH_UNPAID_SERVER_ERRORS.has(text);
}

/* ───────────── «У шаблона есть запуск»: одно определение на всех ───────────── */

/**
 * КАК ЗАПИСЫВАЕТСЯ ЗАПУСК. Запуск живёт в `he_templates.launch_info` (jsonb,
 * 20260730_0002_he_templates_launch_info.sql; NULL — шаблон в запуск не уходил).
 * Ядро ниже пишет её ПО ХОДУ запуска: первая попытка — первой же записью сразу
 * после того, как рассыльщик вернул id первой кампании (до загрузки адресов),
 * с campaign_id, pending, токеном attempt и арендой running_until; потом —
 * после каждого подтверждённого чанка; финальная запись снимает аренду. Повтор
 * над уже существующей записью сначала берёт аренду (шаг 5b′) — к прежней
 * записи добавляются только attempt и running_until. Все читатели записи
 * (parseLaunchInfo) считают запуск состоявшимся по непустому campaign_id.
 *
 * Отсюда признак: непустой campaign_id (кампания создана — запуск законченный
 * или нет) ЛИБО живая аренда (попытка держит запись прямо сейчас). Это то же,
 * что parseLaunchInfo !== null, плюс идущая попытка над записью не нашего
 * формата. Читают его две защиты: «по базе уже запущен другой шаблон» (шаг 4b′
 * ниже) и «повтор research удалил бы запуск» (api/client/eng/projects/[id]/research,
 * а у us-проекта — и staff-роут исследования, и сама кластеризация:
 * stages/clustering.ts, readHeResearchRerunLaunchBlock).
 *
 * Сама запись в выборку не идёт: у незаконченного запуска в ней лежат поимённые
 * адреса долга (launch_info.pending[].emails) — тысячи строк на шаблон, а
 * признаку нужны два скаляра.
 */
export const HE_TEMPLATE_LAUNCH_MARK_COLUMNS =
  'id, base_id, launch_campaign_id:launch_info->>campaign_id, launch_running_until:launch_info->>running_until';

/** Строка выборки HE_TEMPLATE_LAUNCH_MARK_COLUMNS (поля — как пришли из jsonb). */
export interface HeTemplateLaunchMark {
  id?: unknown;
  base_id?: unknown;
  launch_campaign_id?: unknown;
  launch_running_until?: unknown;
}

/** У шаблона есть запуск (см. докблок HE_TEMPLATE_LAUNCH_MARK_COLUMNS). */
export function heTemplateLaunchMarked(row: HeTemplateLaunchMark, nowMs: number = Date.now()): boolean {
  if (typeof row.launch_campaign_id === 'string' && row.launch_campaign_id.length > 0) return true;
  const until =
    typeof row.launch_running_until === 'string' ? Date.parse(row.launch_running_until) : Number.NaN;
  return Number.isFinite(until) && until > nowMs;
}

/**
 * Машинные коды отказов шага 4b′ — тело ответа несёт их рядом с текстом
 * (`code`), чтобы экран и скрипт различали причину не по тексту. Плюс
 * force_relaunch_refused (шаг 4b): force законченного запуска us-шаблона.
 * Кабинет его не встречает — его роут force не принимает (400 до ядра).
 */
export const HE_LAUNCH_REFUSAL_CODES = ['sibling_template_launched', 'research_running', 'force_relaunch_refused'] as const;
export type HeLaunchRefusalCode = (typeof HE_LAUNCH_REFUSAL_CODES)[number];

/**
 * Машинные коды отказов предполёта us-проекта (шаги 4b″, 4b‴ и 5c) — тоже в
 * `code` рядом с текстом. Все — ДО первого вызова рассыльщика:
 *  - template_unresolved_operators (409) — в письмах подстановка, которую база
 *    не наполнит (templateOperatorGate.checkHeTemplateOperators);
 *  - template_brand_leak (409) — письма называют наш бренд или вымышленную
 *    компанию из примера промпта, а клиент проекта не мы
 *    (letterBrandGuard.heTemplateBrandLeaks: английские и польские — всегда,
 *    русские — у проекта клиента ENG-кабинета);
 *  - template_opt_out_lines (409, с 14.10.2026) — в английских письмах
 *    строка отказа от писем или прощания («reply STOP», «I won't reach out
 *    again», «this is my last email»; letterBrandGuard.heTemplateOptOutLines);
 *  - preset_no_mailboxes (409) — в пресете нет ни одного ящика отправки;
 *  - segment_classification_incomplete (503) — классификатор сегментов не
 *    ответил по доле строк выше HE_SEGMENT_HOLD_REFUSE_SHARE. Только у
 *    попытки без поимённого долга (первый запуск, force): достройка
 *    отложенных не отказывает — вторая попытка без ответа отдаёт им основной
 *    текст (шаг 5c).
 * Кабинет различает по коду preset_no_mailboxes и
 * segment_classification_incomplete (api-client.ts, EngStepReview.tsx: пресет
 * и классификатор общие у всей пачки «Launch all», и следующий шаблон получил
 * бы тот же отказ); 503 роут кабинета отдаёт с кодом, читая его
 * heLaunchOutcomeCode (ниже). template_unresolved_operators и
 * template_brand_leak кабинет по коду не различает: такие шаблоны он в «Launch
 * all» не берёт (признак проекции `needs_rewrite` — heTemplateRewriteReasons с
 * причинами 'placeholders' и 'brand'). Автозапуск (engAutoLaunch) держит
 * template_brand_leak общей веткой неизвестного отказа: 'needs_support',
 * письмо клиенту и алерт команде. template_opt_out_lines — так же, но
 * признака проекции у него пока нет (тексты карточки — engText.ts): «Launch
 * all» шаблон берёт и получает этот отказ, клиент читает его текст.
 */
export const HE_LAUNCH_PREFLIGHT_REFUSAL_CODES = [
  'template_unresolved_operators',
  'template_brand_leak',
  'template_opt_out_lines',
  'preset_no_mailboxes',
  'segment_classification_incomplete',
] as const;
export type HeLaunchPreflightRefusalCode = (typeof HE_LAUNCH_PREFLIGHT_REFUSAL_CODES)[number];

/** Любой машинный код отказа ядра — защиты аудитории (4b′) и предполёт us (4b″–5c). */
export type HeLaunchOutcomeCode = HeLaunchRefusalCode | HeLaunchPreflightRefusalCode;

const HE_LAUNCH_OUTCOME_CODES: ReadonlySet<string> = new Set<string>([
  ...HE_LAUNCH_REFUSAL_CODES,
  ...HE_LAUNCH_PREFLIGHT_REFUSAL_CODES,
]);

/**
 * Код отказа из исхода ядра — типизированно, для роутов. Ядро кладёт его в
 * `body.code` рядом с текстом; здесь он сверяется с двумя списками выше, и
 * роут получает только код из словаря ядра. Нет кода (успех, отказ без кода,
 * 5xx с сырьём) — null.
 *
 * Зачем отдельная функция: 5xx ядра роут кабинета отдаёт константой без тела
 * (engServerError), а единственный 5xx с кодом — 503
 * segment_classification_incomplete (refuseSegmentClassification, шаг 5c) —
 * он отдаёт со статусом и кодом. Код роут читает ЭТОЙ функцией, а не разбором
 * текста.
 */
export function heLaunchOutcomeCode(outcome: HeTemplateLaunchOutcome): HeLaunchOutcomeCode | null {
  const code = outcome.body.code;
  return typeof code === 'string' && HE_LAUNCH_OUTCOME_CODES.has(code) ? (code as HeLaunchOutcomeCode) : null;
}

/**
 * Конфликт по САМОМУ шаблону из 409 ядра без машинного кода (шаг 1):
 *  - 'in_progress' — аренда записи жива (запуск идёт или оборвался меньше
 *    HE_LAUNCH_LEASE_MS назад);
 *  - 'already_launched' — законченный запуск (в теле есть `launch`);
 *  - 'not_ready' — шаблон не в статусе 'ready'.
 * Сверка — с текстами словаря ядра обоих языков, а не по разбору текста:
 * автозапуск кабинета (engAutoLaunch.heEngAutoLaunchVerdict) решает по ней,
 * ждать ли аренду или сдаться. Поведение runHeTemplateLaunch не меняется.
 * Иначе — null.
 */
export function heLaunchConflictOf(
  outcome: HeTemplateLaunchOutcome,
): 'in_progress' | 'already_launched' | 'not_ready' | null {
  if (outcome.status !== 409) return null;
  const error = outcome.body.error;
  if (error === MESSAGES.en.launchInProgress || error === MESSAGES.ru.launchInProgress) return 'in_progress';
  if ('launch' in outcome.body) return 'already_launched';
  if (error === MESSAGES.en.templateNotReady || error === MESSAGES.ru.templateNotReady) return 'not_ready';
  return null;
}

/**
 * ПОРОГ ОТКАЗА по классификатору сегментов (us, шаг 5c): запуск не начинается,
 * если строк БЕЗ годного ответа больше этой доли от классифицированных. Ниже
 * порога такие строки откладываются (pending стадии 'classify'), остальные
 * уезжают.
 *
 * Почему не ноль, как у V2 (verticalEngineV2/launchTemplate: любой сбой —
 * отказ): батч — 40 строк, у потолка запуска их 50, и один флап одного батча
 * (429, таймаут, обрезанный ответ) блокировал бы весь запуск, а повтор
 * заплатил бы за ВСЕ батчи заново. Отложенные строки ничего не теряют: они
 * записаны поимённо, повтор классифицирует только их и платит только за них.
 *
 * Почему не «никогда не отказывать»: когда без ответа больше половины, это не
 * флап, а лежащий классификатор (биллинг, ключ, авария — батчи идут волнами по
 * 6 параллельно, и сбой бьёт волну целиком). Запуск меньшей части тогда создаёт
 * кампании всех сегментов почти пустыми и оставляет большую часть аудитории
 * ждать сервис, который не отвечает. Отказ до рассыльщика не создаёт ничего, а
 * цена — повторная оплата батчей ответившего меньшинства мини-модели (центы).
 * При отказе всех батчей запуск отказывает при любом пороге: отправлять нечего.
 */
export const HE_SEGMENT_HOLD_REFUSE_SHARE = 0.5;

/**
 * Две защиты аудитории us-проекта (шаг 4b′): `refusal: null` — запускать можно,
 * код — отказ, `readError` — не прочитали (запуск не состоялся, fail-closed).
 *
 *  - research_running: у проекта активна research-стадия. Шаблон существует
 *    только после кластеризации, значит это ПОВТОРНОЕ исследование, а его
 *    кластеризация (stages/clustering.ts) удаляет he_verticals проекта — и
 *    каскадом базы, шаблоны и записи о запуске. Кампания, созданная сейчас,
 *    осталась бы у рассыльщика без записи: ни достройки, ни долива, ни защиты
 *    от второго запуска по тем же людям. Защиту с другой стороны держат оба
 *    research-роута — кабинета и staff-инструмента (у us-проекта, с
 *    14.10.2026): они не ставят повтор при записанном запуске, — и сама
 *    кластеризация (stages/clustering.ts, readHeResearchRerunLaunchBlock):
 *    при запуске она не сносит вертикали.
 *  - sibling_template_launched: у ДРУГОГО шаблона той же базы есть запуск.
 *    Два готовых шаблона одной базы бывают (пересборка специалиста, шаблоны до
 *    переиспользования в стадии). «Launch all» кабинета берёт один
 *    шаблон на базу (launchableTemplates в EngStepReview.tsx), так что эту
 *    защиту встречают второй таб, запуск специалистом и живая аренда соседа —
 *    вторая кампания написала бы тем же людям вторую цепочку. Свой
 *    собственный запуск этого шаблона сюда не относится — его ведёт шаг 1
 *    (уже запущено / достройка / force).
 *
 * force обе защиты НЕ снимает: force — это «перезапустить ЭТОТ шаблон», а не
 * «написать той же аудитории второй раз» и не «запустить то, что сейчас удалят».
 *
 * Гонку двух ОДНОВРЕМЕННЫХ первых запусков двух шаблонов одной базы (два таба)
 * защита не закрывает: первая попытка пишет запись только после создания
 * первой кампании, и обе могут пройти чтение до этого. «Launch all» берёт один
 * шаблон на базу и запускает их последовательно, поэтому сам эту гонку не
 * создаёт.
 */
async function heUsLaunchAudienceGuard(
  portalDb: SupabaseClient,
  args: { projectId: string; baseId: string; templateId: string },
): Promise<{ refusal: HeLaunchRefusalCode | null } | { readError: unknown }> {
  const { data: research, error: researchErr } = await portalDb
    .from('he_jobs')
    .select('id')
    .eq('project_id', args.projectId)
    .in('stage', HE_RESEARCH_STAGES)
    .in('status', ['pending', 'running'])
    .limit(1);
  if (researchErr) return { readError: researchErr };
  if ((research ?? []).length > 0) return { refusal: 'research_running' };

  const { data: siblings, error: siblingsErr } = await portalDb
    .from('he_templates')
    .select(HE_TEMPLATE_LAUNCH_MARK_COLUMNS)
    .eq('base_id', args.baseId)
    .neq('id', args.templateId);
  if (siblingsErr) return { readError: siblingsErr };
  const now = Date.now();
  const launched = ((siblings ?? []) as HeTemplateLaunchMark[]).some((row) => heTemplateLaunchMarked(row, now));
  return { refusal: launched ? 'sibling_template_launched' : null };
}

/**
 * Загрузка лидов идёт ЧАНКАМИ по столько адресов, сколько рассыльщик берёт
 * одним запросом (createLeads режет так же, LEADS_PER_REQUEST в
 * lib/instantly/client.ts). Сама разбивка трафика не меняет — тот же набор
 * запросов, — но даёт запуску точный подтверждённый счёт после каждого
 * запроса: при ошибке второго чанка первый уже записан как принятый, а не
 * превращается в «ноль» (шаг 6).
 */
const HE_LAUNCH_UPLOAD_CHUNK = 1000;

/**
 * Рынок проекта шаблона для решения по аренде и долгу записи (шаг 1) — до шага
 * 2, тем же путём база → проект, что у шага 4b. null — не прочитался (сбой
 * БД, нет базы или проекта): тогда шаг 1 решает, как раньше. Никогда не
 * бросает. Зовётся только для записи с живой арендой или долгом.
 */
async function readHeLaunchStateMarket(portalDb: SupabaseClient, baseId: string): Promise<HeMarket | null> {
  try {
    const { data: baseRow, error: baseErr } = await portalDb
      .from('he_bases')
      .select('project_id')
      .eq('id', baseId)
      .maybeSingle();
    const projectId = (baseRow as { project_id?: unknown } | null)?.project_id;
    if (baseErr || typeof projectId !== 'string' || !projectId) return null;
    const { data: projectRow, error: projectErr } = await portalDb
      .from('he_projects')
      .select('market')
      .eq('id', projectId)
      .maybeSingle();
    if (projectErr || !projectRow) return null;
    return projectMarket(projectRow as { market?: string | null });
  } catch {
    return null;
  }
}

/**
 * Запись о запуске в форме до порта ENG — для ответа «уже запущено» шаблона
 * RU-проекта: поля, которые пишет только код порта (pending, счётчики
 * leads_requested/leads_attempted/leads_already_present), в ответ не идут.
 * Нужна для записей, которые код порта успел оставить у RU-шаблонов на проде
 * (с 14.10.2026); запись запуска RU-проекта таких полей не несёт.
 */
function heLaunchInfoAsBeforePort(info: HeTemplateLaunchInfo): HeTemplateLaunchInfo {
  const campaigns = (info.campaigns ?? []).map((c) => ({
    campaign_id: c.campaign_id,
    campaign_name: c.campaign_name,
    campaign_url: c.campaign_url,
    segment: c.segment,
    leads_count: c.leads_count,
  }));
  return {
    campaign_id: info.campaign_id,
    campaign_name: info.campaign_name,
    campaign_url: info.campaign_url,
    leads_count: info.leads_count,
    preset_id: info.preset_id,
    created_at: info.created_at,
    ...(campaigns.length > 0 ? { campaigns } : {}),
  };
}

/** Кампании у рассыльщика больше нет (удалена) — 404 на её id. */
function isInstantlyNotFound(err: unknown): boolean {
  return err instanceof InstantlyApiError && err.status === 404;
}

/** Запись о запуске перехватила другая попытка — эта дальше не идёт (шаг 6). */
class HeLaunchTakenOverError extends Error {
  constructor() {
    super('launch record taken over by another attempt');
    this.name = 'HeLaunchTakenOverError';
  }
}

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
  /**
   * Окно отправки, выбранное клиентом (кабинет: тело запроса, иначе дефолт
   * кабинета). Необязательно: staff-роут его не передаёт, и тогда у us-проекта
   * окно выбирает ядро (launchSchedule.ts), а у RU-проекта остаётся окно пресета
   * — ровно как до 09.10.2026. Новые кампании создаются сразу с этим окном.
   */
  sendingWindow?: ClientLaunchScheduleOverride | null;
  /**
   * Настройки кампании поверх пресета (шаг 6): с ними создаётся каждая новая
   * кампания этой попытки — основная, сегментная и замена удалённой у
   * рассыльщика, — и их же получает PATCH пустой кампании прошлой попытки.
   * Передаёт ENG-кабинет (engClientLaunch: настройки ящиков пула,
   * engSendingPreset.HE_ENG_POOL_CAMPAIGN_SETTINGS). Не передано: у
   * us-проекта клиента ENG-кабинета (staff-роут запуска шаблона) ядро берёт
   * те же настройки кабинета само (шаг 4b‴′, с 14.10.2026: без них кампания
   * получала заголовок отписки по дефолту воркспейса — колонки для него у
   * пресета нет); у RU и us-проекта не из кабинета — payload и PATCH
   * прежние, настройки — из пресета.
   */
  campaignSettings?: HeLaunchCampaignSettings;
}

/**
 * Настройки кампании, которые вызывающий ядра может задать поверх пресета.
 * stop_for_company — с 15.10.2026 (решение владельца 14.10.2026, его ставит
 * engSendingPreset.HE_ENG_POOL_CAMPAIGN_SETTINGS): после ответа любого адреса
 * компании её остальные адреса писем больше не получают.
 */
export type HeLaunchCampaignSettings = Pick<
  CampaignCreatePayload,
  'stop_on_reply' | 'stop_for_company' | 'open_tracking' | 'link_tracking' | 'insert_unsubscribe_header'
>;

export interface HeTemplateLaunchOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function runHeTemplateLaunch(input: HeTemplateLaunchInput): Promise<HeTemplateLaunchOutcome> {
  const { portalDb, instantlyDb, templateId, presetId, force, userId, scopeClientUserId, locale, eventPrefix } = input;
  // Шаг 4b‴′ может взять настройки кабинета, если вызывающий их не передал.
  let campaignSettings: HeLaunchCampaignSettings | undefined = input.campaignSettings;
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

  // АРЕНДА (см. шапку): запись держит другая попытка, живая или умершая меньше
  // HE_LAUNCH_LEASE_MS назад. Отказ — раньше всего остального, в том числе
  // раньше «уже запущено»: пока аренда жива, запись может быть промежуточной.
  // Повтор достраивать параллельно с живой попыткой нельзя: обе грузили бы
  // одни и те же адреса.
  //
  // Аренда и долг (pending) — механика ТОЛЬКО market='us'. RU-проект идёт
  // запуском как до порта ENG (развилка шага 4b), а он ни аренды, ни долга не
  // знает: «уже запущено» без force, force — новые кампании в ВЫБРАННОМ пресете.
  // Но код порта работал на проде с 14.10.2026 (~19:13 UTC) и для RU-шаблонов
  // тоже, так что такая запись у RU-шаблона бывает. Поэтому, когда запись несёт
  // живую аренду или долг, рынок проекта читается здесь же, до любого решения
  // по ним (readHeLaunchStateMarket); у RU-проекта оба признака игнорируются.
  // Рынок не прочитался — решают они, как раньше (у 'us' это прежний путь, а
  // RU-шаблон с такой записью во время сбоя БД получит прежний отказ этого
  // кода; см. развилку шага 4b про выбранный пресет). Записи без аренды и без
  // долга — всё, что пишет запуск RU-проекта, — лишнего чтения здесь не
  // получают (только ответ «уже запущено» ниже читает рынок для формы записи).
  const startLease = readHeLaunchLease(template.launch_info);
  const leaseLive = startLease.runningUntilMs !== null && startLease.runningUntilMs > Date.now();
  const existingLaunch = parseLaunchInfo(template.launch_info);
  const launchIncomplete = heLaunchIsIncomplete(existingLaunch);
  // undefined — рынок здесь не читался; null — читался, но не прочитался.
  let stateMarket: HeMarket | null | undefined;
  if (leaseLive || launchIncomplete) stateMarket = await readHeLaunchStateMarket(portalDb, template.base_id);
  const launchStateApplies = stateMarket !== 'ru';
  if (leaseLive && launchStateApplies) {
    return { status: 409, body: { error: t.launchInProgress } };
  }

  // Незакончённый запуск (в записи остались сегменты без кампании или без
  // лидов) повтор НЕ блокирует и force для него не нужен: достраивать нечего
  // прятать, а дублей повтор не создаёт по построению — кампанию, которая уже
  // есть, он переиспользует (шаг 6). Требовать force здесь значило бы
  // заставлять оператора угадывать слово, чтобы дозапустить свой же запуск.
  // У RU-проекта достройки нет (см. выше): его запись — законченный запуск.
  const resumeLaunch = launchIncomplete && launchStateApplies;
  if (existingLaunch && !force && !resumeLaunch) {
    // Ответ RU-проекта — запись в форме до порта ENG (heLaunchInfoAsBeforePort):
    // у записи, оставленной кодом порта, в нём нет его полей. Рынок не
    // прочитался — ответ прежний этого кода.
    if (stateMarket === undefined) stateMarket = await readHeLaunchStateMarket(portalDb, template.base_id);
    return {
      status: 409,
      body: {
        error: t.alreadyLaunched,
        launch: stateMarket === 'ru' ? heLaunchInfoAsBeforePort(existingLaunch) : existingLaunch,
      },
    };
  }
  // Долг незакончённого запуска (шаги 5a′ и 5c). Поимённым он бывает только
  // целиком: если хоть у одного сегмента нет списка адресов (запись до
  // 01.10.2026), повтор идёт прежним путём — через классификатор.
  const owed: HeTemplateLaunchPending[] = resumeLaunch && existingLaunch ? existingLaunch.pending ?? [] : [];
  const owedByEmails = owed.length > 0 && owed.every((entry) => Array.isArray(entry.emails));

  // 2. База шаблона.
  //    project_id нужен, чтобы узнать рынок проекта (имя кампании и гейты, шаг
  //    4b): у he_templates своего project_id нет, а у he_bases он not null.
  //    collect_info — маркеру контракта сборки (шаг 4c); поле маленькое, в
  //    отличие от data.
  const { data: baseRow, error: baseErr } = await portalDb
    .from('he_bases')
    .select('id, project_id, vertical_id, filename, columns, data, source, collect_info')
    .eq('id', template.base_id)
    .single();
  if (baseErr) {
    return {
      status: baseErr.code === 'PGRST116' ? 404 : 500,
      body: { error: baseErr.code === 'PGRST116' ? t.baseNotFound : baseErr.message },
    };
  }
  const base = baseRow as Pick<HeBase, 'id' | 'project_id' | 'filename' | 'columns' | 'data'> & {
    vertical_id?: string;
    source?: string;
    collect_info?: unknown;
  };

  // 3. Пресет — service-level read по id (у staff); в клиентском контуре —
  //    со скоупом владельца (чужой пресет = «не найден»).
  //
  //    ДОСТРОЙКА берёт пресет ЗАПИСИ, а не выбранный сейчас. Пресет задаёт
  //    аккаунт рассыльщика, то есть воркспейс, где лежат кампании запуска:
  //    достройка через другой аккаунт искала бы их не там (PATCH и загрузка в
  //    чужой воркспейс отвечают «не найдено», и повтор не кончался бы никогда),
  //    а skip_if_in_campaign не видит кампаний другого воркспейса — адреса,
  //    уже принятые первой попыткой, ушли бы второй раз. Пресета записи нет
  //    — достроить нечем, это отказ, а не тихий переход в другой воркспейс.
  const resumePresetId = resumeLaunch && existingLaunch?.preset_id ? existingLaunch.preset_id : null;
  const effectivePresetId = resumePresetId ?? presetId;
  const presetPinned = resumePresetId !== null && resumePresetId !== presetId;
  let presetQuery = instantlyDb
    .from('client_campaign_presets')
    .select('*')
    .eq('id', effectivePresetId);
  if (scopeClientUserId) {
    presetQuery = presetQuery.eq('client_user_id', scopeClientUserId);
  }
  const { data: presetRow, error: presetErr } = await presetQuery.maybeSingle();
  if (presetErr) {
    await logError(`${eventPrefix}.preset_failed`, presetErr, { userId });
    return { status: 500, body: { error: t.presetLoadFailed } };
  }
  if (!presetRow) {
    if (resumePresetId) return { status: 409, body: { error: t.resumePresetMissing } };
    return { status: 404, body: { error: t.presetNotFound } };
  }
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
  //
  //     Рынок не прочитался — запуск НЕ СОСТОЯЛСЯ, в обоих контурах (fail-closed,
  //     01.10.2026). Раньше здесь был фолбэк по контуру: 'us' для en, 'ru' для
  //     RU-инструмента. Безопасен он был только для имени кампании: us-проект,
  //     запущенный сотрудником из RU-инструмента во время блипа БД, получал
  //     'ru', то есть мягкую ветку — строки без вердикта уезжали на домены
  //     ENG-клиента, отказ легаси-базы (4c) и отбор по компаниям (5b) не
  //     срабатывали. Различить рынок без этого чтения нечем, поэтому для RU это
  //     тоже новый отказ — но только на сбое БД, до первого вызова рассыльщика,
  //     и повтор безопасен. Строки проекта нет — база ушла вместе с ним
  //     (he_bases.project_id on delete cascade): «база не найдена».
  //     Сайт и бриф — проверке писем на чужую компанию (шаг 4b″): чей это
  //     проект, решают хост сайта и бриф (letterBrandGuard).
  const { data: projectRow, error: projectErr } = await portalDb
    .from('he_projects')
    .select('market, website_url, brief, created_by')
    .eq('id', base.project_id)
    .maybeSingle();
  if (projectErr) {
    await logError(`${eventPrefix}.project_market_failed`, projectErr, { userId, templateId });
    return { status: 500, body: { error: t.marketReadFailed } };
  }
  if (!projectRow) return { status: 404, body: { error: t.baseNotFound } };
  const market: HeMarket = projectMarket(projectRow as { market?: string | null });

  //     RU-ПРОЕКТ (любой рынок, кроме 'us') — ЗАПУСК КАК ДО ПОРТА ENG (решение
  //     владельца 14.10.2026 «Как было», см. runHeTemplateLaunchAsBeforePort
  //     ниже): дальше по этой функции идёт ТОЛЬКО market='us'. Ветки «RU — как
  //     раньше» ниже с этой развилки не достижимы; они оставлены, чтобы путь
  //     'us' оставался тем же кодом, что прошёл аудит 14.10.2026.
  //
  //     Пресет запуска RU — ВЫБРАННЫЙ (как до порта). Пресет записи (шаг 3)
  //     сюда приходит, только если на шаге 1 рынок не прочитался, а запись несёт
  //     долг (код порта, работавший на проде с 14.10.2026): тогда выбранный
  //     читается заново тем же запросом, что у шага 3 до порта.
  if (market !== 'us') {
    let ruPreset = preset;
    if (presetPinned) {
      let ruPresetQuery = instantlyDb.from('client_campaign_presets').select('*').eq('id', presetId);
      if (scopeClientUserId) ruPresetQuery = ruPresetQuery.eq('client_user_id', scopeClientUserId);
      const { data: ruPresetRow, error: ruPresetErr } = await ruPresetQuery.maybeSingle();
      if (ruPresetErr) {
        await logError(`${eventPrefix}.preset_failed`, ruPresetErr, { userId });
        return { status: 500, body: { error: t.presetLoadFailed } };
      }
      if (!ruPresetRow) return { status: 404, body: { error: t.presetNotFound } };
      ruPreset = ruPresetRow as ClientCampaignPreset;
    }
    return runHeTemplateLaunchAsBeforePort({
      input,
      t,
      template,
      existingLaunch,
      base,
      preset: ruPreset,
      templateLetters,
      segmentWhens,
    });
  }
  // Only a confirmed ENG owner permits catch_all. An unreadable owner must
  // stop before any sender call; locale or project market alone is not enough.
  let allowCatchAll: boolean;
  try {
    allowCatchAll = await readHeEngBaseFirst(portalDb, projectRow);
  } catch (err) {
    await logError(`${eventPrefix}.email_policy_failed`, err, { userId, templateId, projectId: base.project_id });
    return { status: 500, body: { error: t.marketReadFailed } };
  }
  // Both client and staff launch routes reach this shared continuation. Only
  // verified ENG-client ownership opens the same persistent budget as collection
  // and letters; the RU return above and US staff projects keep their old path.
  const runUsLaunch = async (): Promise<HeTemplateLaunchOutcome> => {
  let qualificationScope: HeEngQualificationScope | null = null;
  const qualificationBrief = projectRow.brief as Record<string, unknown> | null | undefined;
  if (allowCatchAll && base.source === 'auto') {
    try {
      if (!base.vertical_id || base.vertical_id !== template.vertical_id) {
        throw new Error('ENG company qualification: base vertical does not match the template');
      }
      qualificationScope = await readHeEngQualificationScope(portalDb, {
        project: { id: base.project_id, brief: qualificationBrief },
        verticalId: base.vertical_id,
        collectInfo: base.collect_info as Record<string, unknown> | null,
      });
      // Existing campaigns may contain recipients absent from today's base.
      // A filtered retry must never grant a stamp to their unknown history.
      if (!heEngScopeWithinCurrentCountries(qualificationScope, qualificationBrief) ||
          (existingLaunch && !heEngLaunchQualified(template.launch_info, qualificationScope, base.id))) {
        return { status: 409, body: { error: HE_ENG_COMPANY_QUALIFICATION_REQUIRED } };
      }
    } catch (err) {
      await logError(`${eventPrefix}.company_qualification_failed`, err, { userId, templateId, projectId: base.project_id });
      return { status: 409, body: { error: HE_ENG_COMPANY_QUALIFICATION_REQUIRED } };
    }
  }
  // undefined = дефолты buildLaunchCampaignName, т.е. прежнее имя RU-запуска.
  const campaignNaming = market === 'us' ? HE_ENG_CAMPAIGN_NAMING : undefined;

  //     FORCE ЗАКОНЧЕННОГО ЗАПУСКА us-шаблона — отказ (аудит 14.10.2026). Force
  //     создаёт новые кампании по той же аудитории (skip_if_in_campaign false) и
  //     перезаписывает launch_info, а она — единственный список кампаний для
  //     паузы клиента, «Выключить отправку», блокировки, engBlockedSweep и
  //     he_sending_pool_launched: прежние кампании (возможно, уже отправляющие
  //     из ящиков пула) выпали бы из всех них, а кабинет предложил бы «Start
  //     sending» дублям — вторая цепочка тем же людям. Кабинет force не
  //     принимает (роут, 400), так что дойти сюда может только staff-роут.
  //     Незаконченный запуск (resumeLaunch) идёт достройкой — force ему ничего
  //     не меняет, отказа нет. RU-проекты — как раньше. До шага 4b′ и до
  //     всего платного: ничего не создано и не записано.
  if (market === 'us' && force && existingLaunch && !resumeLaunch) {
    await logAudit(`${eventPrefix}.refused_force_relaunch`, 'Launch refused: force re-launch of a launched us template', {
      userId,
      templateId,
      baseId: template.base_id,
      projectId: base.project_id,
    });
    return {
      status: 409,
      body: {
        error: locale === 'en' ? FORCE_RELAUNCH_US_TEXT.en : FORCE_RELAUNCH_US_TEXT.ru,
        code: 'force_relaunch_refused' satisfies HeLaunchRefusalCode,
      },
    };
  }

  // 4b′. Защиты аудитории (heUsLaunchAudienceGuard): идёт повторное
  //      исследование (оно удалит этот шаблон вместе с записью о запуске) или
  //      у другого шаблона той же базы уже есть запуск (вторая цепочка тем же
  //      людям). До платного классификатора (5c) и до рассыльщика (6).
  //      Скоуп — рынок ПРОЕКТА 'us', как у гейта вердиктов: RU-проекты
  //      ежедневного staff-инструмента запускаются как раньше (пересборка
  //      шаблона и его запуск — привычная работа специалиста), а us-проект
  //      защищён, кто бы ни нажал кнопку.
  if (market === 'us') {
    const guard = await heUsLaunchAudienceGuard(portalDb, {
      projectId: base.project_id,
      baseId: template.base_id,
      templateId,
    });
    if ('readError' in guard) {
      await logError(`${eventPrefix}.audience_guard_failed`, guard.readError, { userId, templateId });
      return { status: 500, body: { error: t.launchGuardReadFailed } };
    }
    const refusal = guard.refusal;
    if (refusal) {
      await logAudit(`${eventPrefix}.refused_${refusal}`, `Launch refused: ${refusal}`, {
        userId,
        templateId,
        baseId: template.base_id,
        projectId: base.project_id,
      });
      return {
        status: 409,
        body: {
          error: refusal === 'research_running' ? t.researchRunning : t.siblingTemplateLaunched,
          code: refusal,
        },
      };
    }
  }

  // Строки базы, её колонки и колонка адреса — ДО предполёта: гейт писем
  // (4b″) проверяет пустые ячейки по тем же строкам с адресом, из которых шаг
  // 5 строит лидов. Всё здесь чистое (без БД и сети) и считалось бы ниже так
  // же — у RU-проекта меняется только место вычисления.
  const allRows = Array.isArray(base.data) ? (base.data as Array<Record<string, unknown>>) : [];
  const columns = Array.isArray(base.columns)
    ? base.columns.filter((c): c is string => typeof c === 'string')
    : [];
  // Колонка адреса ищется ОДИН раз и по ОДНОМУ набору строк — по ПОЛНОЙ базе
  // (allRows), — и это же значение уходит в гейт писем (4b″), гейт вердиктов
  // и маппинг лидов (шаг 5). Гейтам колонка нужна ДО фильтра, маппингу —
  // после, а детекция по содержимому (findEmailColumn: доля похожих значений
  // среди первых непустых) зависит от НАБОРА строк: посчитанная второй раз по
  // остатку, она могла назвать другую колонку или не найти ничего у базы, где
  // гейт снял как раз строки с адресами, — и ответ был бы «в базе не найдена
  // колонка с email» вместо честной причины отсева. Полная база — правильный
  // набор для всех: она не зависит от того, что именно снял гейт.
  const detectedEmailColumn = findEmailColumn(columns, allRows);

  // 4b″. ПИСЬМА, КОТОРЫЕ ПРОЧИТАЮТСЯ НЕВЕРНО (us). Гейт стадии template
  //      (templateOperatorGate.ts) не пускает в 'ready' новые us-шаблоны с
  //      подстановкой, которую база не наполнит, — но шаблоны, записанные до
  //      него, лежат 'ready' по-прежнему, а у одного шаблона один запуск на все
  //      пути. Поэтому тот же гейт стоит здесь, на ВСЕХ путях этого ядра:
  //      кабинет, запуск us-шаблона сотрудником, достройка и force. Считается
  //      от писем шаблона и колонок ЕГО базы, а маппинг читается только затем,
  //      чтобы узнать колонку и fallback, которые возьмёт mapBaseRowsToLeads
  //      ниже, — то есть ровно то, что получит рассыльщик. Бесплатно, до
  //      платного классификатора и до рассыльщика; force не снимает.
  //      RU не трогаем: у специалиста дыра в письме видна в превью шаблона, и
  //      запрещать ему привычный запуск никто не просил.
  //
  //      ПУСТЫЕ ЯЧЕЙКИ — та же функция, что у стадии (withHeEmptyCellFallbacks
  //      + строки с адресом в гейте). У шаблона, записанного после 09.10.2026,
  //      замены уже лежат в маппинге, и вызов ничего не меняет. У записанного
  //      раньше замены кладутся В ПАМЯТИ этого запуска: письма шаблона те же,
  //      меняется только значение переменной у строки с пустой ячейкой
  //      («your website» вместо пустоты). Отказ здесь стоил бы платной
  //      пересборки писем ради того, что детерминированно и бесплатно.
  //      Записанный маппинг такого шаблона не меняется; ночной долив и перенос
  //      кладут ту же замену в памяти (stages/baseCollectRefill,
  //      heRefillOperatorMapping).
  let operatorMapping = template.personalization_plan?.operator_mapping;
  let standInsAddedAtLaunch: Array<{ operator: string; column: string; fallback: string }> = [];
  let standInsUsed: HeTemplateStandInUse[] = [];
  if (market === 'us') {
    const withStandIns = withHeEmptyCellFallbacks(operatorMapping, columns);
    operatorMapping = withStandIns.mapping;
    standInsAddedAtLaunch = withStandIns.added;
    const operatorGate = checkHeTemplateOperators({
      letters: template.letters,
      columns: base.columns,
      operatorMapping,
      rows: allRows,
      emailColumn: detectedEmailColumn,
    });
    standInsUsed = operatorGate.standIns;
    if (!operatorGate.ok) {
      const detail = describeHeTemplateOperatorGate(operatorGate);
      await logAudit(
        `${eventPrefix}.refused_template_unresolved_operators`,
        'Launch refused: template letters use placeholders the base cannot fill',
        {
          userId,
          templateId,
          baseId: base.id,
          projectId: base.project_id,
          subjectUnresolved: operatorGate.subjectUnresolved.length,
          unbacked: operatorGate.unbacked.length,
          malformed: operatorGate.malformed.length,
          emptyCells: operatorGate.emptyCells.length,
          detail,
        },
      );
      return {
        status: 409,
        body: { error: t.templateOperatorsUnresolved(detail), code: 'template_unresolved_operators' satisfies HeLaunchPreflightRefusalCode },
      };
    }

    // ЧУЖАЯ КОМПАНИЯ В ПИСЬМАХ (тот же шаг 4b″): письма называют наш бренд или
    // вымышленную компанию из примера промпта, а клиент проекта не мы
    // (letterBrandGuard: хост сайта и бриф; язык — по самим письмам; русские —
    // только у проекта клиента ENG-кабинета, и его профиль читается, только
    // когда он меняет ответ — heBrandNeedsOwner). Гейт стадии template такие
    // письма в 'ready' не пускает, но шаблоны, записанные до него, лежат
    // 'ready' — поэтому и здесь, на всех путях этого ядра. Бесплатно, до
    // классификатора и рассыльщика; force не снимает.
    const brandRow = projectRow as { website_url?: unknown; brief?: unknown; created_by?: unknown };
    const brandLeaks = heTemplateBrandLeaks(
      market,
      {
        ...brandRow,
        heEngClient: heBrandNeedsOwner(template.letters) ? await readHeBrandEngClient(portalDb, brandRow.created_by) : false,
      },
      template.letters,
    );
    if (brandLeaks.length) {
      const detail = describeHeBrandLeaks(brandLeaks);
      await logAudit(
        `${eventPrefix}.refused_template_brand_leak`,
        'Launch refused: template letters name another company (our brand or a prompt example)',
        { userId, templateId, baseId: base.id, projectId: base.project_id, leaks: brandLeaks.length, detail },
      );
      return {
        status: 409,
        body: {
          error: locale === 'en' ? TEMPLATE_BRAND_LEAK_TEXT.en : TEMPLATE_BRAND_LEAK_TEXT.ru(detail),
          code: 'template_brand_leak' satisfies HeLaunchPreflightRefusalCode,
        },
      };
    }

    // СТРОКИ ОТКАЗА ОТ ПИСЕМ И ПРОЩАНИЯ (тот же шаг 4b″, аудит 14.10.2026):
    // «let me know and I won't reach out again», «reply STOP», «this is my
    // last email» — правило владельца (letterBrandGuard.heTemplateOptOutLines:
    // английские письма us-проекта). Раньше проверка стояла только на старте
    // отправки, то есть ПОСЛЕ этого ядра: ящики пула выданы, классификатор
    // оплачен, кампании созданы и адреса загружены — и лишь потом отказ.
    // Здесь — бесплатно, до классификатора (5c) и рассыльщика (6), на всех
    // путях ядра (кабинет, автозапуск, сотрудник, достройка); force не
    // снимает. Старт отправки проверяет ещё раз — для запусков, сделанных до
    // этой правки. Признак `needs_rewrite` кабинета этой причины пока не
    // знает (тексты карточки — engText.ts), поэтому клиент читает этот отказ
    // при нажатии и зовётся в Support, а автозапуск держит код общей веткой
    // неизвестного отказа ('needs_support', письмо клиенту, алерт команде).
    const optOutLines = heTemplateOptOutLines(market, template.letters);
    if (optOutLines.length) {
      const detail = describeHeOptOutLines(optOutLines);
      await logAudit(
        `${eventPrefix}.refused_template_opt_out_lines`,
        'Launch refused: template letters offer to stop writing or say this is the last email',
        { userId, templateId, baseId: base.id, projectId: base.project_id, lines: optOutLines.length, detail },
      );
      return {
        status: 409,
        body: {
          error: locale === 'en' ? TEMPLATE_OPT_OUT_TEXT.en : TEMPLATE_OPT_OUT_TEXT.ru(detail),
          code: 'template_opt_out_lines' satisfies HeLaunchPreflightRefusalCode,
        },
      };
    }
  }

  // 4b‴. ЯЩИКИ ОТПРАВКИ (us). Пресет без единого ящика создаёт кампанию,
  //      которая не отправит ни письма, а запуск тем не менее грузит в неё
  //      адреса и пишет запись «launched» — ENG-клиент ящики в пресет не
  //      добавляет (их привязывает администратор), то есть узнал бы об этом
  //      никогда. Правило то же, что у RU-клиентского запуска
  //      (lib/clientLaunch/validateLaunchInput.ts: «в пресете нет привязанных
  //      email-аккаунтов»), переписано здесь, а не импортировано: то —
  //      внутренность клиентского контура со своим словарём. Пустые строки в
  //      списке ящиком не считаются. Пресет — тот, с которым кампании реально
  //      создаются (у достройки — пресет записи). RU-инструмент как раньше:
  //      там сотрудник сам проверяет и активирует кампанию в рассыльщике.
  if (market === 'us') {
    const mailboxIds = Array.isArray(preset.email_account_ids)
      ? preset.email_account_ids.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];
    if (mailboxIds.length === 0) {
      await logAudit(`${eventPrefix}.refused_preset_no_mailboxes`, 'Launch refused: sending preset has no mailboxes', {
        userId,
        templateId,
        presetId: effectivePresetId,
        projectId: base.project_id,
      });
      return {
        status: 409,
        body: { error: t.presetNoMailboxes, code: 'preset_no_mailboxes' satisfies HeLaunchPreflightRefusalCode },
      };
    }
  }

  // 4b‴′. НАСТРОЙКИ КАМПАНИЙ ENG-КАБИНЕТА без кабинета (аудит 14.10.2026).
  //       Кабинет передаёт их сам (engClientLaunch → campaignSettings). Staff-роут
  //       запуска шаблона — нет, и кампании us-проекта клиента ENG-кабинета,
  //       запущенные сотрудником (обычно с пресетом из ящиков пула этого
  //       клиента), получали заголовок отписки по дефолту воркспейса —
  //       против правила владельца «ни строк отписки, ни заголовка»: колонки
  //       для заголовка у пресета нет, а клиент потом стартует эти кампании
  //       из кабинета. Поэтому у us-проекта без переданных настроек ядро
  //       читает владельца проекта (letterBrandGuard.readHeProjectOwnerKind):
  //       клиент ENG-кабинета — настройки кабинета
  //       (engSendingPreset.HE_ENG_POOL_CAMPAIGN_SETTINGS: stop on reply,
  //       трекинг выключен, без заголовка отписки), как у запуска из кабинета.
  //       Чтение не удалось — тоже они: из двух ошибок эта лишь выключает
  //       трекинг и заголовок у кампании, а обратная пустила бы письма клиента
  //       ENG-кабинета с заголовком. Владелец не клиент кабинета (us-проект
  //       сотрудника) и RU — как раньше, настройки из пресета, без чтения.
  if (market === 'us' && !campaignSettings) {
    const ownerKind = await readHeProjectOwnerKind(portalDb, (projectRow as { created_by?: unknown }).created_by);
    if (ownerKind !== 'other') campaignSettings = HE_ENG_POOL_CAMPAIGN_SETTINGS;
  }

  // 4b⁗. ОКНО ОТПРАВКИ новых кампаний (launchSchedule.ts). Явное окно (выбор
  //      клиента в кабинете) — как есть; у us-проекта без явного окна (запуск
  //      сотрудником, достройка не из кабинета) — сохранённый выбор клиента,
  //      иначе дефолт кабинета, но НЕ часы пресета; у RU без явного окна —
  //      null, то есть окно пресета, как было (и без лишнего чтения БД).
  const windowPlan = await resolveHeLaunchSendingWindow({
    db: portalDb,
    market,
    templateId,
    clientUserId: typeof preset.client_user_id === 'string' ? preset.client_user_id.trim() : '',
    // Окно «Launch» и выбор клиента — только этого проекта; страны проекта —
    // подсказанному поясу (§1C плана 2026-10-16-eng-countries).
    projectId: typeof base.project_id === 'string' && base.project_id ? base.project_id : null,
    projectCountries: readHeCollectCountries(
      ((projectRow as { brief?: unknown }).brief as { collect_countries?: unknown } | null | undefined)
        ?.collect_countries,
    ).countries,
    explicit: input.sendingWindow ?? null,
  });
  if (windowPlan.readError) {
    await logError(`${eventPrefix}.sending_window_read_failed`, windowPlan.readError, {
      userId,
      templateId,
      source: windowPlan.source,
    });
  }
  const sendingWindow = windowPlan.window;
  // Кампании этой попытки, которые получили окно в момент создания (или
  // PATCH'ем вместе с цепочкой): роут кабинета не переставляет им окно второй
  // раз и не называет их «оставшимися на прежних часах».
  const windowCampaignIds: string[] = [];

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
      (n, r) => n + (heLaunchEmailVerdict(r._email_status, { allowCatchAll }) === 'missing' ? 0 : 1),
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
  //    Колонки базы, её строки (allRows) и колонка адреса (detectedEmailColumn)
  //    посчитаны до шага 4b″ — их читает и гейт писем.
  const isAutoBase = base.source === 'auto';
  const requireEmailVerdict = market === 'us';
  const filterRows = isAutoBase || requireEmailVerdict;
  // Гейту колонка нужна, чтобы не требовать вердикт со строк, где адреса нет
  // вовсе: у автосборки это штатная компания без найденной почты (их бывает
  // большинство), и записать их в «сняты без вердикта» значило бы соврать в
  // отчёте. Такую строку, как и раньше, молча отбросит маппинг.
  const gateEmailColumn = filterRows ? detectedEmailColumn : null;
  let skippedInvalid = 0;
  let skippedUnverified = 0;
  let unverifiedSent = 0;
  let skippedIrrelevant = 0;
  let skippedCompanyQualification = 0;
  const rows = filterRows
    ? allRows.filter((r) => {
        if (qualificationScope && !heEngCompanyQualified(r, qualificationScope)) {
          skippedCompanyQualification += 1;
          return false;
        }
        // Порядок причин прежний: строка и нерелевантная, и невалидная
        // по-прежнему считается нерелевантной (чтобы счётчики RU-запуска
        // автобазы не поехали).
        if (isAutoBase && r._low_relevance === true) {
          skippedIrrelevant += 1;
          return false;
        }
        if (gateEmailColumn && String(r[gateEmailColumn] ?? '').trim() === '') return true;
        const verdict = heLaunchEmailVerdict(r._email_status, { allowCatchAll });
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
  if (skippedCompanyQualification > 0) {
    return { status: 409, body: { error: HE_ENG_COMPANY_QUALIFICATION_REQUIRED } };
  }
  // Sort before address deduplication: if the same address occurs twice,
  // its ok row wins over catch_all. The resulting sender order also puts ok
  // first when the base is below the launch cap. Legacy staff keeps its order.
  if (allowCatchAll) {
    rows.sort((a, b) => heLaunchEmailStrength(b._email_status, { allowCatchAll }) - heLaunchEmailStrength(a._email_status, { allowCatchAll }));
  }
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
    // us — с заменами пустых ячеек (шаг 4b″); RU — записанный маппинг как есть.
    operatorMapping,
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
  // Отказы «отправлять некому» (здесь и после чёрного списка) — у первой
  // попытки. У достройки с поимённым долгом пустой остаток — не отказ, а
  // итог: должное больше нельзя отправить, и запуск закрывается с
  // owedUnsendableNote (шаг 5a′), а не висит «незаконченным» с отказом, который
  // повтор никогда не снимет.
  if (!emailColumn && !owedByEmails) return { status: 400, body: { error: t.noEmailColumn } };
  if (leads.length === 0 && !owedByEmails) {
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
  //     существует. Ошибку getBlockedContactSnapshot не разбираем на виды (она сама
  //     бросает и на сбое БД, и на неполной выдаче) — любая означает «не знаем
  //     список», а значит «не отправляем».
  //
  //     Оба контура запуска us-проекта (кабинет и staff-роут): блок ставит
  //     клиент по негативному ответу, и получателю всё равно, кто нажал запуск.
  //     RU-проект сюда не доходит (развилка шага 4b): у него список best-effort
  //     и без отказов (runHeTemplateLaunchAsBeforePort). Счёт снятых контактов
  //     — в warnings, причина отказа — в тексте ошибки, подробности — в
  //     logError. Ветка пустого client_user_id
  //     оборонительная: в схеме колонка not null
  //     (instantly-migrations/20260429_0001), то есть в норме недостижима.
  const clientUserId =
    typeof preset.client_user_id === 'string' ? preset.client_user_id.trim() : '';
  let blockedContacts = 0;
  // Из них — закрытых доменной записью (адрес, сайт лида или сайт строки).
  let blockedByDomain = 0;
  try {
    if (!clientUserId) {
      throw new Error(`пресет ${effectivePresetId}: пустой client_user_id — чей чёрный список применять, неизвестно`);
    }
    // Снимок списка: адреса И домены компаний (план 2026-10-16-eng-countries,
    // §1B). Доменная запись закрывает домен адреса, lead.website и сайт строки
    // базы — колонку сайта ищет findCompanyKeyColumns, а не жёсткое имя.
    // Ошибка снимка (в том числе список сверх лимита) — тот же отказ ниже.
    const snapshot = await getBlockedContactSnapshot(instantlyDb, clientUserId);
    const websiteColumn = findCompanyKeyColumns(columns).website;
    const rowIndicesBefore = leadRowIndices;
    // filterBlockedContacts — единственный носитель правил совпадения; `kept`
    // — те же объекты в исходном порядке, поэтому параллельность
    // leadRowIndices восстанавливается по ссылке на лида.
    const filtered = filterBlockedContacts(leads, snapshot, (_lead, i) =>
      websiteColumn ? rows[rowIndicesBefore[i]]?.[websiteColumn] : null,
    );
    blockedContacts = filtered.blockedCount;
    blockedByDomain = filtered.blockedByDomain;
    if (blockedContacts > 0) {
      const allowed = new Set<object>(filtered.kept);
      const keptLeads: typeof leads = [];
      const keptRowIndices: number[] = [];
      leads.forEach((lead, i) => {
        if (!allowed.has(lead)) return;
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
      presetId: effectivePresetId,
      clientUserId: clientUserId || null,
    });
    return { status: 500, body: { error: t.blocklistLoadFailed } };
  }
  if (leads.length === 0 && !owedByEmails) {
    // Счёт снятых чёрным списком — в аудит и на этом отказе, а не только в
    // аудите успеха: «запуск не состоялся, потому что все адреса в блоке» без
    // числа по журналу не отличить от пустой базы.
    await logAudit(`${eventPrefix}.refused_all_contacts_blocked`, 'Launch refused: every address is on the client blocklist', {
      userId,
      templateId,
      baseId: base.id,
      presetId: effectivePresetId,
      blockedContacts,
      blockedByDomain,
    });
    return { status: 400, body: { error: t.allContactsBlocked } };
  }

  // 5a′. ДОСТРОЙКА — ТОЛЬКО ДОЛЖНОЕ. Повтор незакончённого запуска с поимённым
  //      долгом шлёт ровно адреса из launch_info.pending, а не всю базу: всё
  //      остальное уже лежит в кампаниях запуска или не должно туда попасть
  //      (строки, добавленные в базу после запуска, возит ночной долив).
  //      Фильтр стоит ПОСЛЕ гейтов и чёрного списка намеренно: адрес из долга,
  //      который с прошлой попытки заблокирован, лишился вердикта или ушёл из
  //      базы, не уедет и сейчас — сколько таких, говорит owedUnsendableNote.
  //      До потолка (5b): долг — подмножество того, что потолок уже выбрал
  //      прошлой попыткой, второй выбор его бы только перекроил.
  let owedUnsendable = 0;
  if (owedByEmails) {
    const owedEmails = new Set<string>();
    for (const entry of owed) for (const email of entry.emails ?? []) owedEmails.add(email);
    const keptLeads: typeof leads = [];
    const keptRowIndices: number[] = [];
    leads.forEach((lead, i) => {
      if (!owedEmails.has(lead.email)) return;
      keptLeads.push(lead);
      keptRowIndices.push(leadRowIndices[i]);
    });
    owedUnsendable = owedEmails.size - keptLeads.length;
    leads = keptLeads;
    leadRowIndices = keptRowIndices;
  }

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
  //     причина — selectLeadsWithinLaunchCap в launchHandoff.ts). У ENG
  //     компании обходятся отдельно внутри ok, затем catch_all: любой ok
  //     имеет приоритет перед catch_all другой компании.
  //     Компании при этом не пропадают молча: сколько компаний и адресов уехало и сколько
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
  let capAddressesSent = 0;
  let capAddressesHeldBack = 0;
  let capCompaniesHeldBack = 0;
  let capAddressesOfHeldBackCompanies = 0;
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
      allowCatchAll,
    });
    // Оба массива переписываются вместе в порядке отбора (ENG: ok первыми): их
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
    capAddressesSent = selection.addressesSent;
    capAddressesHeldBack = selection.addressesHeldBack;
    capCompaniesHeldBack = selection.companiesHeldBack;
    capAddressesOfHeldBackCompanies = selection.addressesOfHeldBackCompanies;
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

  // 5b′. АРЕНДА ЗАПИСИ (см. шапку). Каждая запись этой попытки — условная: по
  //      токену, с которого попытка началась (запись, прочитанная в шаге 1), а
  //      после первой подтверждённой записи — по своему токену. Ноль строк
  //      значит «запись переписал кто-то другой» — дальше эта попытка не идёт.
  //
  //      Попытка, у которой запись УЖЕ есть (достройка, force, мусор в
  //      колонке), берёт аренду ДО первого обращения к рассыльщику и до
  //      платного классификатора: к записи добавляются только токен и
  //      running_until, её содержание остаётся прежним (кабинет, долив и
  //      дашборд видят тот же запуск). Первая попытка (записи нет) аренду
  //      берёт первой же записью — сразу после того, как узнан id первой
  //      кампании, до её загрузки: писать до кампании нечего (запись без
  //      campaign_id все читатели считают «запуска нет»), а гонку двух первых
  //      попыток решает условие «колонка пуста» — проигравшая останавливается
  //      с одной пустой кампанией на паузе (её id уходит в лог) и без загрузки.
  //
  //      Сбой записи аренды — отказ до рассыльщика: без неё повтор во время
  //      запуска нечем остановить. Сбой ПРОМЕЖУТОЧНОЙ записи запуск не роняет
  //      (кампании уже созданы, обрыв был бы хуже) — он идёт в лог, а итог
  //      решает финальная запись, как и до 01.10.2026.
  const attemptToken = randomUUID();
  const attemptStartedAt = new Date().toISOString();
  const startRaw: unknown = template.launch_info;
  const hasStartRecord = startRaw !== null && startRaw !== undefined;
  let ownsRecord = false;
  let lastWriteError: unknown = null;
  let progressSaveFailures = 0;
  const leaseUntil = (): string => new Date(Date.now() + HE_LAUNCH_LEASE_MS).toISOString();

  const writeRecord = async (
    record: unknown,
    mode: 'start' | 'mine',
  ): Promise<{ matched: number; error: unknown }> => {
    let query = portalDb.from('he_templates').update({ launch_info: record }).eq('id', templateId);
    if (mode === 'mine') {
      query = query.eq('launch_info->>attempt', attemptToken);
    } else if (!hasStartRecord) {
      query = query.is('launch_info', null);
    } else if (startLease.attempt) {
      query = query.eq('launch_info->>attempt', startLease.attempt);
    } else if (startLease.createdAt) {
      query = query.eq('launch_info->>created_at', startLease.createdAt);
    }
    // Записи без токена и без created_at (не наш формат) условия не дают — для
    // них запись безусловная, как до 01.10.2026.
    const { data, error } = await query.select('id');
    return { matched: Array.isArray(data) ? data.length : 0, error };
  };

  /**
   * Условная запись. Пока своя запись не подтверждена, пробуем оба условия:
   * «запись та, с которой начали», затем «запись уже наша» — последнее
   * случается, когда предыдущая запись вернула ошибку, но в базу легла.
   */
  const saveRecord = async (record: unknown): Promise<'saved' | 'taken' | 'failed'> => {
    const modes: Array<'start' | 'mine'> = ownsRecord ? ['mine'] : ['start', 'mine'];
    for (const mode of modes) {
      const { matched, error } = await writeRecord(record, mode);
      if (error) {
        lastWriteError = error;
        return 'failed';
      }
      if (matched > 0) {
        ownsRecord = true;
        return 'saved';
      }
    }
    return 'taken';
  };

  /**
   * Снять аренду, когда попытка ничего не создала: вернуть запись, с которой
   * она начала. Нужна только попытке, бравшей аренду до рассыльщика (шаг 5b′);
   * не вышло — аренда истечёт сама.
   */
  const releaseClaim = async (): Promise<void> => {
    if (!hasStartRecord || !ownsRecord) return;
    const { error } = await portalDb
      .from('he_templates')
      .update({ launch_info: startRaw })
      .eq('id', templateId)
      .eq('launch_info->>attempt', attemptToken);
    if (error) await logError(`${eventPrefix}.claim_release_failed`, error, { userId, templateId });
  };

  const startFields =
    startRaw && typeof startRaw === 'object' && !Array.isArray(startRaw)
      ? (startRaw as Record<string, unknown>)
      : {};
  if (hasStartRecord) {
    const claimed = await saveRecord({ ...startFields, attempt: attemptToken, running_until: leaseUntil() });
    if (claimed === 'taken') return { status: 409, body: { error: t.launchInProgress } };
    if (claimed === 'failed') {
      await logError(`${eventPrefix}.claim_failed`, lastWriteError, { userId, templateId });
      return { status: 500, body: { error: t.launchStartSaveFailed } };
    }
  }

  // 5c. Группы запуска.
  //
  //     ДОСТРОЙКА С ПОИМЁННЫМ ДОЛГОМ: группы — это сегменты из
  //     launch_info.pending с их адресами (тем, что от них осталось после
  //     шага 5a′). Классификатор по ним НЕ зовётся: раскладка уже сделана и
  //     оплачена прошлой попыткой, а его повторный ответ мог бы разложить базу
  //     иначе — сегмент без группы молча выпадал из долга, и запуск записывался
  //     законченным с незагруженными адресами. Зовётся он только по адресам
  //     стадии 'classify' — тем, по которым прошлая попытка ответа не получила
  //     (us, см. ниже): их сегмент ещё неизвестен.
  //
  //     ИНАЧЕ — материализация 15%: сплит лидов по сегментам базы.
  //     Классификатор — LLM (мини-модель, батчами). Строка БЕЗ ответа:
  //      - RU (как до 09.10.2026): дефолтный текст; системный сбой (упали все
  //        батчи) → легаси-путь: одна кампания, сегментные варианты выкинуты
  //        с предупреждением;
  //      - us: ОТКЛАДЫВАЕТСЯ — не уходит в этом запуске, а ложится в
  //        launch_info.pending стадией 'classify' поимённо (запуск записан
  //        незаконченным, повтор берёт ровно их; что не разметил и повтор —
  //        основной текст, без третьей платной попытки). Без ответа больше
  //        HE_SEGMENT_HOLD_REFUSE_SHARE строк — отказ до рассыльщика (503
  //        segment_classification_incomplete): кампаний нет, аренда снята.
  //     Расход классификатора — в аудит запуска (успех и отказ): других
  //     записей о расходе у запуска нет, а he_projects.cost_usd пишет воркер
  //     чтением-изменением-записью и параллельной записи из роута не переживёт.
  interface LeadGroup {
    segment: string | null;
    leadIdx: number[];
  }
  let groups: LeadGroup[] = [];
  let segmentsMaterialized = false;
  const classifier = {
    ran: false,
    rows: 0,
    batches: 0,
    failedBatches: 0,
    failureKinds: [] as string[],
    tokensUsed: 0,
    costUsd: 0,
  };
  const noteClassification = (detailed: HeSegmentClassification): void => {
    classifier.batches += detailed.totalBatches;
    classifier.failedBatches += detailed.failedBatches;
    classifier.failureKinds.push(...detailed.failureKinds);
    classifier.tokensUsed += detailed.usage.tokensUsed;
    classifier.costUsd += detailed.usage.costUsd;
  };
  // Адреса, отложенные классификатором (us): в запись — pending стадии 'classify'.
  let heldEmails: string[] = [];
  // Достройка (us): номер попытки классификатора по отложенным адресам и
  // сколько из них и на ней остались без ответа — они уходят с основным текстом.
  let heldAttempt = 0;
  let heldMainText = 0;

  /**
   * us: классифицировать лидов по позициям в `leads`. Ответы — по позиции
   * (условие сегмента или null — «ни одно не подходит»), held — позиции без
   * годного ответа. Непредвиденный бросок самого классификатора (сбои батчей
   * он не бросает, они в failedBatches) — «ответа нет ни по одной строке».
   */
  const classifyUsLeads = async (
    positions: number[],
  ): Promise<{ answers: Map<number, string | null>; held: number[] }> => {
    classifier.ran = true;
    classifier.rows += positions.length;
    try {
      const detailed = await classifyBaseRowsIntoSegmentsDetailed({
        rows: positions.map((pos) => rows[leadRowIndices[pos]] ?? {}),
        segments: segmentWhens,
        language: detectSegmentLanguage(segmentWhens),
        // Рынок уже прочитан (шаг 4b) — учёт расхода в llm.ts по нему, а не по
        // журналу ENG: его у staff-запуска нет, если роут рынок не прочитал.
        market,
      });
      noteClassification(detailed);
      const answers = new Map<number, string | null>();
      detailed.assignments.forEach((segment, idx) => answers.set(positions[idx], segment));
      return { answers, held: detailed.unanswered.map((idx) => positions[idx]) };
    } catch (err) {
      try {
        rethrowHeEngBaseBudgetError(err);
      } catch (budgetError) {
        await releaseClaim();
        throw budgetError;
      }
      await logError(`${eventPrefix}.segment_classify_failed`, err, { userId, templateId });
      classifier.failureKinds.push('unknown');
      return { answers: new Map(), held: [...positions] };
    }
  };

  /** Отказ классификатора (us): ничего не создано и не изменено. */
  const refuseSegmentClassification = async (unanswered: number, total: number): Promise<HeTemplateLaunchOutcome> => {
    await releaseClaim();
    await logAudit(
      `${eventPrefix}.refused_segment_classification_incomplete`,
      'Launch refused: the segment classifier left too many addresses without an answer',
      {
        userId,
        templateId,
        baseId: base.id,
        projectId: base.project_id,
        resumeLaunch,
        unanswered,
        total,
        refuseShare: HE_SEGMENT_HOLD_REFUSE_SHARE,
        classifierBatches: classifier.batches,
        classifierFailedBatches: classifier.failedBatches,
        classifierFailureKinds: classifier.failureKinds,
        classifierTokens: classifier.tokensUsed,
        classifierCostUsd: classifier.costUsd,
      },
    );
    return {
      status: 503,
      body: {
        error: t.segmentClassifyIncomplete(unanswered, total),
        code: 'segment_classification_incomplete' satisfies HeLaunchPreflightRefusalCode,
      },
    };
  };

  if (owedByEmails) {
    const posByEmail = new Map<string, number>();
    leads.forEach((lead, i) => posByEmail.set(lead.email, i));
    const owedGroups = new Map<string, LeadGroup>();
    const taken = new Set<number>();
    const heldPositions: number[] = [];
    // Сколько попыток классификатора уже не дали ответа по отложенным адресам
    // (HeTemplateLaunchPending.classify_attempts; ключа нет — 1).
    let heldFailedBefore = 0;
    for (const entry of owed) {
      // Отложенные классификатором: сегмента у них нет, и по `segment: null`
      // их нельзя класть в основную кампанию — сначала классификация (ниже).
      if (entry.stage === 'classify') {
        heldFailedBefore = Math.max(heldFailedBefore, entry.classify_attempts ?? 1);
        for (const email of entry.emails ?? []) {
          const pos = posByEmail.get(email);
          if (pos === undefined || taken.has(pos)) continue;
          taken.add(pos);
          heldPositions.push(pos);
        }
        continue;
      }
      const key = entry.segment ?? '';
      const group = owedGroups.get(key) ?? { segment: entry.segment, leadIdx: [] };
      for (const email of entry.emails ?? []) {
        const pos = posByEmail.get(email);
        if (pos === undefined || taken.has(pos)) continue;
        taken.add(pos);
        group.leadIdx.push(pos);
      }
      owedGroups.set(key, group);
    }
    if (heldPositions.length > 0) {
      // Условий сегментов у писем нет — дефолтный текст и есть верный ответ
      // для каждого адреса (шаблон неизменен, так что это лишь страховка).
      const { answers, held } =
        segmentWhens.length > 0
          ? await classifyUsLeads(heldPositions)
          : { answers: new Map<number, string | null>(heldPositions.map((pos) => [pos, null])), held: [] };
      for (const [pos, segment] of answers) {
        const key = segment ?? '';
        const group = owedGroups.get(key) ?? { segment, leadIdx: [] };
        group.leadIdx.push(pos);
        owedGroups.set(key, group);
      }
      // ВТОРАЯ попытка без ответа — последняя (HeTemplateLaunchPending.
      // classify_attempts): такие адреса уходят с ОСНОВНЫМ текстом в основную
      // кампанию, а не откладываются снова. Иначе адрес, по которому модель не
      // отвечает никогда, держал бы запуск «незаконченным» вечно, и каждое
      // нажатие заново платило бы за его батч. Основной текст читается верно —
      // он лишь не сегментный (так до 09.10.2026 уходила каждая строка без
      // ответа, только молча); об этих адресах говорит segmentRowsMainTextNote.
      if (segmentWhens.length > 0) heldAttempt = heldFailedBefore + 1;
      if (held.length > 0) {
        const main = owedGroups.get('') ?? { segment: null, leadIdx: [] };
        main.leadIdx.push(...held);
        owedGroups.set('', main);
        heldMainText = held.length;
      }
    }
    // Пустая группа — сегмент, чей долг целиком стал неотправляемым (5a′): его
    // кампания, если есть, переносится как есть, а в долг он не возвращается.
    groups = [...owedGroups.values()]
      .filter((g) => g.leadIdx.length > 0)
      .map((g) => ({ segment: g.segment, leadIdx: [...g.leadIdx].sort((a, b) => a - b) }));
  } else {
    groups = [{ segment: null, leadIdx: leads.map((_, i) => i) }];
    if (segmentWhens.length > 0 && market === 'us') {
      const { answers, held } = await classifyUsLeads(leads.map((_, i) => i));
      if (held.length > 0 && held.length > leads.length * HE_SEGMENT_HOLD_REFUSE_SHARE) {
        return refuseSegmentClassification(held.length, leads.length);
      }
      const defaultIdx: number[] = [];
      const bySegment = new Map<string, number[]>();
      [...answers.keys()]
        .sort((a, b) => a - b)
        .forEach((leadPos) => {
          const seg = answers.get(leadPos);
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
      groups = next;
      heldEmails = held.map((pos) => leads[pos].email);
      segmentsMaterialized = segmentWhens.some((w) => (bySegment.get(w) ?? []).length > 0);
    } else if (segmentWhens.length > 0) {
      // RU — прежний контракт по поведению байт в байт: heLegacySegmentAssignments
      // отдаёт ровно то, что до 09.10.2026 возвращал classifyBaseRowsIntoSegments
      // (тот же промпт, батчи и строки лога); детальный вызов — ради расхода в аудите.
      classifier.ran = true;
      classifier.rows += leads.length;
      let assignments: Map<number, string> | null = null;
      try {
        const detailed = await classifyBaseRowsIntoSegmentsDetailed({
          rows: leadRowIndices.map((ri) => rows[ri] ?? {}),
          segments: segmentWhens,
          language: detectSegmentLanguage(segmentWhens),
          unansweredFate: 'default',
          market,
        });
        noteClassification(detailed);
        assignments = heLegacySegmentAssignments(detailed);
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
  }
  // Отложенные адреса — одной записью pending без сегмента (см.
  // HeTemplateLaunchPending, стадия 'classify'); пустой — ключа нет.
  // Откладывает их только ветка без поимённого долга (первый запуск, force по
  // законченному запуску, запись без адресов) — после ОДНОЙ попытки
  // классификатора по этим адресам: classify_attempts = 1. Достройка их не
  // откладывает (выше), поэтому больше 1 здесь не бывает.
  const heldPending: HeTemplateLaunchPending[] =
    heldEmails.length > 0 ? [{ segment: null, stage: 'classify', emails: heldEmails, classify_attempts: 1 }] : [];

  // Классификатор (LLM, батчами) мог идти минутами — аренду, взятую до него,
  // продлеваем перед первым обращением к рассыльщику, чтобы её срок считался
  // от загрузок, а не от начала попытки. Перехватили, пока шла классификация,
  // — дальше не идём: у рассыльщика эта попытка ещё ничего не сделала.
  if (hasStartRecord && classifier.ran) {
    const renewed = await saveRecord({ ...startFields, attempt: attemptToken, running_until: leaseUntil() });
    if (renewed === 'taken') return { status: 409, body: { error: t.launchInProgress } };
  }

  const instantlyRequestOptions = { accountId: resolveInstantlyAccountId(preset.instantly_account_id) };

  // 6. Instantly: по кампании на группу (НЕ активируем!) + лиды группы. Текст
  //    ошибки идёт без scrubBrand — staff-UI нужна точная формулировка API;
  //    клиентский роут скрабит бренд на своей стороне. Основная кампания
  //    (segment=null) создаётся первой — её id уходит в скалярные поля
  //    launch_info (их читает refill-долив и старый UI).
  //
  //    ЧТО СОЗДАНО — ТО ЗАПИСАНО, И СРАЗУ. Новая кампания попадает в
  //    campaigns[] и в launch_info (persistProgress), как только узнан её id —
  //    ДО досылки цепочки PATCH'ем и до загрузки лидов; после каждого
  //    подтверждённого чанка загрузки запись обновляется снова. До 28.09.2026
  //    запись делалась после загрузки, а до 01.10.2026 — один раз после всего
  //    цикла: кампания, у которой упали PATCH или загрузка, либо весь запуск,
  //    оборванный рестартом посреди цикла, оставались без записи, и повтор
  //    создавал двойников с тем же именем и грузил в них те же адреса.
  //
  //    ДОСТРОЙКА ПОВТОРА (resumeLaunch): что уже создано, берётся из записи
  //    прошлой попытки — по СЕГМЕНТУ. Кампания сегмента без долга не трогается
  //    вовсе (её получатели могут быть в рассылке); кампания сегмента с долгом
  //    дозаполняется его адресами; заново создаются только сегменты, у которых
  //    кампании нет, — или чья кампания у рассыльщика удалена (404 на PATCH или
  //    на первой загрузке): тогда она выпадает из записи, и сегмент получает
  //    новую. Иначе такой повтор падал бы на 404 вечно.
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
  // Сегменты, решённые как недоехавшие в ЭТОЙ попытке (отказ, ёмкость, ноль
  // принятых у свежей кампании) — с адресами, которые они ещё должны.
  const settledPending: HeTemplateLaunchPending[] = [];
  // Отказы сегментов машинно: имя сегмента обязано доехать до предупреждения
  // клиенту, а склеенную строку warnings разобрать обратно нельзя — в условии
  // сегмента бывает ': '. Клиентский роут читает этот список и НЕ отдаёт его
  // наружу (в error лежит сырьё рассыльщика).
  const segmentFailures: Array<{ segment: string | null; error: string }> = [];
  const groupErrors: string[] = [];
  const usedRecords = new Set<string>();
  // Сегменты, чья записанная кампания у рассыльщика удалена: из записи она
  // выпадает, вместо неё создаётся новая.
  const replacedSegments = new Set<string>();
  // id кампаний, созданных ЭТОЙ попыткой: если запись перехватят, они
  // останутся без записи, и лог — единственное место, где их найти.
  const createdCampaignIds: string[] = [];
  let keptInLoop = 0;
  let refilledCampaigns = 0;
  // Кампании, созданные ИМЕННО СЕЙЧАС. На достройке это третье число рядом с
  // «перенесено» и «дозаполнено»: без него ответ про повтор говорит, что
  // сохранено, но молчит про то, что появилось (шаг 7, warnings и аудит).
  let createdCampaigns = 0;
  let replacedCampaigns = 0;
  // Адреса, которые рассыльщик на ЭТОЙ попытке пропустил как уже лежащие в
  // кампаниях воркспейса (загрузки достройки идут с skip_if_in_campaign).
  let alreadyPresentNow = 0;
  let capacityStopped = false;
  let capacitySkippedSegments = 0;
  // Позвало ли ядро алерт команде о месте под контакты с рынком 'us' — условие
  // фразы «команда уже работает» в capacityStopNote (EN).
  let capacityTeamAlerted = false;

  /**
   * Отказ рассыльщика по месту под контакты — команде в health-бот (решение
   * владельца 04.10.2026, opsAlert.ts). ТОЛЬКО из ENG-кабинета (locale 'en'):
   * staff RU-инструмента сам читает про место и сам его освобождает, его
   * запуск не шлёт ничего. Рынок — прочитанный рынок проекта (шаг 4b): не-'us'
   * opsAlert отбрасывает, и тогда EN-текст обещания не даёт.
   *
   * Зовётся там же, где отказ узнан (catch шага 6), — ДО любого ответа и до
   * текста клиенту, при любой форме исхода. После такого отказа ядро больше не
   * создаёт кампаний и не грузит адресов (остальные сегменты уходят в pending,
   * capacityStopped), поэтому вызов один на запуск; повторные нажатия гасит
   * дедупликация opsAlert (проект + вид + провайдер, 6 ч). `void`: веб-сервер
   * долгоживущий, ответ клиенту Telegram не ждёт; функция не бросает.
   */
  const alertTeamOnLaunchCapacity = (reason: string): void => {
    capacityTeamAlerted = market === 'us';
    void notifyHeClientStop({
      projectId: base.project_id,
      market,
      stage: HE_OPS_STAGE_TEMPLATE_LAUNCH,
      kind: 'capacity_pause',
      provider: 'sending',
      reason,
      baseId: base.id,
      templateId,
      // Правда для любой формы исхода: ни одной кампании (общий отказ
      // запуска), отказ последнего сегмента, ноль принятых — причина не
      // названа; остались несозданные сегменты — нейтральная фраза.
      clientSees:
        'отказ запуска без причины; если после него остались несозданные сегменты — «временная проблема ' +
        'на нашей стороне, команда уже работает»',
    });
  };

  const recordFor = (segmentKey: string): HeTemplateLaunchCampaign | undefined =>
    replacedSegments.has(segmentKey) ? undefined : recordedBySegment.get(segmentKey);
  // Старый путь достройки (долг без адресов): кампания, уже принявшая адреса,
  // не трогается — как до 01.10.2026. У поимённого долга такого правила нет:
  // группы там — только должные сегменты, и их кампании дозаполняются.
  const isKeptGroup = (g: LeadGroup): boolean => {
    if (owedByEmails) return false;
    const recorded = recordFor(g.segment ?? '');
    return Boolean(recorded && recorded.leads_count > 0);
  };
  // Старый путь достройки: долг сегмента, который в этой попытке не получил
  // обрабатываемой группы (классификатор вернул null или разложил базу иначе),
  // ПЕРЕНОСИТСЯ в новую запись как был. Терять его нельзя: адреса сегмента не
  // уехали, а запись без pending читается как законченный запуск.
  const carriedOwed: HeTemplateLaunchPending[] =
    resumeLaunch && !owedByEmails
      ? owed.filter(
          (entry) =>
            !groups.some((g) => (g.segment ?? '') === (entry.segment ?? '') && !isKeptGroup(g)),
        )
      : [];
  const carriedRecords = (): HeTemplateLaunchCampaign[] =>
    [...recordedBySegment.entries()]
      .filter(([key]) => !usedRecords.has(key) && !replacedSegments.has(key))
      .map(([, recorded]) => recorded);
  const owedEntryForGroup = (g: LeadGroup): HeTemplateLaunchPending => ({
    segment: g.segment,
    stage: recordFor(g.segment ?? '') ? 'leads' : 'campaign',
    emails: g.leadIdx.map((i) => leads[i].email),
  });

  /**
   * Запись о запуске на текущий момент: кампании этой попытки + перенесённые
   * из прошлой, pending — решённые недоезды, группа «в полёте» с её остатком
   * и все ещё не начатые группы. Скалярные поля — ОСНОВНАЯ кампания
   * (segment=null; её ищет ночной долив, autoPipeline.ts), суммы — по всем.
   */
  const buildLaunchInfo = (
    inFlight: HeTemplateLaunchPending | null,
    nextGroup: number,
  ): HeTemplateLaunchInfo | null => {
    const all = [...campaigns, ...carriedRecords()];
    if (all.length === 0) return null;
    const primary = all.find((c) => c.segment === null) ?? all[0];
    const pendingNow: HeTemplateLaunchPending[] = [
      ...settledPending,
      ...(inFlight ? [inFlight] : []),
      ...groups.slice(nextGroup).filter((g) => !isKeptGroup(g)).map(owedEntryForGroup),
      ...carriedOwed,
      ...heldPending,
    ];
    let leadsCount = 0;
    let leadsRequested = 0;
    let leadsAttempted = 0;
    let leadsAlreadyPresent = 0;
    for (const c of all) {
      leadsCount += c.leads_count;
      leadsRequested += c.leads_requested ?? c.leads_count;
      leadsAttempted += c.leads_attempted ?? c.leads_count;
      leadsAlreadyPresent += c.leads_already_present ?? 0;
    }
    return {
      campaign_id: primary.campaign_id,
      campaign_name: primary.campaign_name,
      campaign_url: primary.campaign_url,
      leads_count: leadsCount,
      preset_id: effectivePresetId,
      created_at: attemptStartedAt,
      campaigns: all,
      ...(qualificationScope
        ? { eng_company_qualification: heEngQualifiedLaunchStamp(qualificationScope, base.id) }
        : {}),
      // Счётчики рассыльщика целиком, а не только принятые: без «сколько
      // запрошено» молчаливая частичная загрузка неотличима от «столько адресов
      // и было» (launchHandoff.ts, HeTemplateLaunchCampaign).
      leads_requested: leadsRequested,
      leads_attempted: leadsAttempted,
      ...(leadsAlreadyPresent > 0 ? { leads_already_present: leadsAlreadyPresent } : {}),
      // Пустого массива не пишем: ключ означает «запуск не закончен», и запись
      // без него читается как законченная — в том числе все записи до 28.09.2026.
      ...(pendingNow.length > 0 ? { pending: pendingNow } : {}),
    };
  };

  /** Промежуточная запись с продлённой арендой. Перехват записи — стоп. */
  const persistProgress = async (inFlight: HeTemplateLaunchPending | null, nextGroup: number): Promise<void> => {
    const info = buildLaunchInfo(inFlight, nextGroup);
    if (!info) return;
    const outcome = await saveRecord({ ...info, attempt: attemptToken, running_until: leaseUntil() });
    if (outcome === 'taken') throw new HeLaunchTakenOverError();
    if (outcome === 'failed') {
      progressSaveFailures += 1;
      if (progressSaveFailures === 1) {
        await logError(`${eventPrefix}.progress_save_failed`, lastWriteError, { userId, templateId });
      }
    }
  };

  const takenOver = async (): Promise<HeTemplateLaunchOutcome> => {
    await logError(`${eventPrefix}.taken_over`, new HeLaunchTakenOverError(), {
      userId,
      templateId,
      createdCampaignIds: [...createdCampaignIds],
    });
    return { status: 409, body: { error: t.launchInProgress } };
  };

  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi];
    const segmentKey = group.segment ?? '';
    const recorded = recordFor(segmentKey);
    const groupLeads = group.leadIdx.map((i) => leads[i]);
    const groupEmails = groupLeads.map((lead) => lead.email);

    // Старый путь достройки: кампания сегмента уже создана И приняла адреса —
    // второй раз не создаём и лидов не досылаем. Запись переносим как есть,
    // вместе с её счётчиками: суммы записи не должны похудеть от повтора.
    if (recorded && isKeptGroup(group)) {
      campaigns.push(recorded);
      usedRecords.add(segmentKey);
      keptInLoop += 1;
      continue;
    }

    // Место под контакты в воркспейсе кончилось: следующий сегмент этого не
    // переживёт, а созданная под него кампания стала бы ещё одной пустой
    // сиротой. Сегмент уходит в pending со всеми адресами — повтор его достроит.
    if (capacityStopped) {
      settledPending.push({
        segment: group.segment,
        stage: recorded ? 'leads' : 'campaign',
        emails: groupEmails,
      });
      capacitySkippedSegments += 1;
      continue;
    }

    const sequence = buildLaunchSequence(templateLetters, { segmentWhen: group.segment });
    if (!sequence) {
      // Недостижимо (пустые письма отсёк шаг 4 на том же наборе), но отказом
      // выходить нельзя: созданные кампании остались бы без итоговой записи.
      // Пока кампаний нет, ответ прежний.
      if (campaigns.length === 0 && !resumeLaunch) {
        await releaseClaim();
        return { status: 400, body: { error: t.noLetters } };
      }
      settledPending.push({
        segment: group.segment,
        stage: recorded ? 'leads' : 'campaign',
        emails: groupEmails,
      });
      groupErrors.push(`${group.segment ?? 'default'}: ${t.noLetters}`);
      segmentFailures.push({ segment: group.segment, error: t.noLetters });
      continue;
    }
    // У переиспользуемой кампании имя остаётся прежним: оно уже стоит у
    // рассыльщика и уже показано клиенту записью о запуске.
    const campaignName =
      recorded?.campaign_name ||
      buildLaunchCampaignName(base.filename, new Date(), group.segment, campaignNaming);
    // Состояние группы — в объекте, а не в let: его меняют вложенные функции, и
    // ветке catch нужно знать, есть ли у сегмента кампания и докуда дошла загрузка.
    const current: {
      campaign: HeTemplateLaunchCampaign | null;
      reused: boolean;
      sentUpTo: number;
      accepted: number;
      netRequested: number;
    } = { campaign: null, reused: false, sentUpTo: 0, accepted: 0, netRequested: 0 };
    try {
      // Окно (шаг 4b⁗) — в момент создания: кампания не существует ни
      // секунды с часами пресета. Нет окна (RU без явного) — вызов прежний.
      const presetPayload = buildCampaignPayloadFromPreset({
        preset,
        sequence: { name: campaignName, steps: sequence.steps },
        ...(sendingWindow ? { scheduleOverride: sendingWindow } : {}),
      });
      // Настройки вызывающего (вход campaignSettings — ENG-кабинет; у
      // us-проекта клиента кабинета без них — настройки кабинета, шаг 4b‴′) —
      // тоже в момент создания, поверх значений пресета. Без них payload — тот
      // же объект, что раньше.
      const payload = campaignSettings ? { ...presetPayload, ...campaignSettings } : presetPayload;

      // Новая кампания: в запись — СРАЗУ, как узнан id, и только потом PATCH
      // цепочки. Иначе отказ PATCH'а оставлял созданную кампанию вне записи, и
      // повтор создавал ей двойника.
      const openFresh = async (): Promise<void> => {
        const created = await createCampaign(payload, instantlyRequestOptions);
        const createdId = (created as { id?: string }).id ?? null;
        if (!createdId) {
          throw new Error('Instantly вернул кампанию без идентификатора');
        }
        createdCampaigns += 1;
        createdCampaignIds.push(createdId);
        if (sendingWindow) windowCampaignIds.push(createdId);
        const fresh: HeTemplateLaunchCampaign = {
          campaign_id: createdId,
          campaign_name: campaignName,
          campaign_url: instantlyCampaignUrl(createdId),
          segment: group.segment,
          leads_count: 0,
          leads_requested: 0,
          leads_attempted: 0,
        };
        campaigns.push(fresh);
        current.campaign = fresh;
        current.reused = false;
        await persistProgress(
          { segment: group.segment, stage: 'leads', emails: groupEmails.slice(current.sentUpTo) },
          gi + 1,
        );
        // Как в клиентском запуске: если Instantly не сохранил sequences при
        // создании — досылаем PATCH'ем.
        if (!hasUsableCampaignSequences(created.sequences)) {
          await updateCampaign(createdId, { sequences: payload.sequences }, instantlyRequestOptions);
        }
      };

      // Записанной кампании сегмента у рассыльщика больше нет: из записи она
      // выпадает (replacedSegments), сегмент получает новую.
      const replaceMissing = async (missing: HeTemplateLaunchCampaign, err: unknown): Promise<void> => {
        replacedSegments.add(segmentKey);
        replacedCampaigns += 1;
        await logError(`${eventPrefix}.recorded_campaign_missing`, err, {
          userId,
          templateId,
          segment: group.segment,
          campaignId: missing.campaign_id,
        });
        await openFresh();
      };

      if (recorded) {
        // Кампания прошлой попытки — копия записи: счётчики дописываются к ней.
        const reuse: HeTemplateLaunchCampaign = { ...recorded };
        let missing = false;
        if (reuse.leads_count === 0) {
          // Ни одного подтверждённого адреса: цепочку досылаем PATCH'ем — той же
          // операцией, что у новой кампании. Кампания на паузе и без лидов,
          // переписать её письма безопасно, а упасть прошлая попытка могла и
          // на самом этом PATCH'е. У кампании с подтверждёнными адресами
          // PATCH'а нет: цепочка в ней уже стоит, и её получатели могут быть в
          // рассылке.
          // Окно — тем же PATCH'ем: пустую кампанию прошлой попытки (у
          // us-проекта до 09.10.2026 — с часами пресета) нечем было бы иначе
          // привести к окну этого запуска на пути без кабинета.
          // Настройки вызывающего (campaignSettings) — тоже здесь: пустую
          // кампанию мог создать путь без них (staff-роут с тем же пресетом).
          // Кампания с подтверждёнными адресами их не получает — остаётся с
          // настройками своего создания.
          try {
            await updateCampaign(
              reuse.campaign_id,
              {
                sequences: payload.sequences,
                ...(sendingWindow ? { campaign_schedule: payload.campaign_schedule } : {}),
                ...(campaignSettings ?? {}),
              },
              instantlyRequestOptions,
            );
            if (sendingWindow) windowCampaignIds.push(reuse.campaign_id);
          } catch (patchErr) {
            if (!isInstantlyNotFound(patchErr)) throw patchErr;
            missing = true;
            await replaceMissing(reuse, patchErr);
          }
        }
        if (!missing) {
          campaigns.push(reuse);
          usedRecords.add(segmentKey);
          refilledCampaigns += 1;
          current.campaign = reuse;
          current.reused = true;
        }
      } else {
        await openFresh();
      }

      // Загрузка ЧАНКАМИ (HE_LAUNCH_UPLOAD_CHUNK): после каждого подтверждённого
      // чанка запись обновляется, и остаток группы в pending — только то, чего
      // рассыльщик ещё не подтвердил.
      while (current.sentUpTo < groupLeads.length) {
        const target = current.campaign;
        if (!target) throw new Error('кампания группы не определена');
        const chunk = groupLeads.slice(current.sentUpTo, current.sentUpTo + HE_LAUNCH_UPLOAD_CHUNK);
        let result: Awaited<ReturnType<typeof createLeads>>;
        try {
          result = await createLeads(
            chunk,
            {
              campaign_id: target.campaign_id,
              skip_if_in_workspace: false,
              // ПЕРВАЯ попытка запуска — три false, как и до 28.09.2026: наш
              // пайплайн сам решает, кому писать.
              //
              // ДОСТРОЙКА переворачивает флаг у ВСЕХ кампаний захода, а не только
              // у переиспользованных. Правило — «может ли этот шаблон УЖЕ держать
              // эти адреса у рассыльщика», и у СВЕЖЕЙ кампании достройки ответ
              // тоже «да»:
              //   - чанк, на котором оборвалась прошлая попытка, мог лечь у
              //     рассыльщика, не подтвердившись нам (ответ потерян): его
              //     адреса остались в долге, хотя уже в кампании;
              //   - кампания прошлой попытки могла быть создана и потеряна
              //     (оборванный ответ createCampaign, смерть процесса между
              //     ответом и записью): сегмент лежит в долге со стадией
              //     'campaign', хотя его адреса, возможно, уже у рассыльщика;
              //   - старый путь достройки (долг без адресов) раскладывает базу
              //     классификатором заново, и лид, уехавший в кампанию сегмента
              //     A, на этом заходе может попасть в сегмент B.
              // Цена флага: он шире имени (отсеивает и по ЧУЖИМ кампаниям
              // воркспейса); такие адреса идут в alreadyPresent, а не в
              // «непринятые» — на повторе «не добавить» безопаснее, чем
              // «отправить дважды». На force-перезапуске ЗАКОНЧЕННОГО запуска
              // флаг остаётся false: там оператор осознанно создаёт новые
              // кампании по той же аудитории, и пропуск оставил бы их пустыми.
              skip_if_in_campaign: resumeLaunch,
              skip_if_in_list: false,
            },
            instantlyRequestOptions,
          );
        } catch (uploadErr) {
          // Переиспользуемая кампания удалена у рассыльщика, и в неё ещё не лёг
          // ни один чанк этой попытки — сегмент получает новую кампанию.
          if (current.reused && current.sentUpTo === 0 && isInstantlyNotFound(uploadErr)) {
            campaigns.splice(campaigns.indexOf(target), 1);
            usedRecords.delete(segmentKey);
            refilledCampaigns -= 1;
            current.campaign = null;
            current.reused = false;
            await replaceMissing(target, uploadErr);
            continue;
          }
          throw uploadErr;
        }
        // Пропущенные как уже лежащие в кампаниях воркспейса — только у
        // загрузки достройки (флаг skip_if_in_campaign). Если рассыльщик не
        // прислал skipped_count, его нормализатор считает пропущенным весь
        // остаток чанка — тогда и настоящие отказы попадут сюда, а не в
        // «непринятые»; в ответе это видно отдельной фразой.
        const present = resumeLaunch
          ? Math.min(result.skipped_count, Math.max(0, result.total_sent - result.leads_uploaded))
          : 0;
        const prevRequested = target.leads_requested ?? target.leads_count;
        const prevAttempted = target.leads_attempted ?? target.leads_count;
        target.leads_requested = prevRequested + chunk.length;
        target.leads_attempted = prevAttempted + result.total_sent;
        target.leads_count += result.leads_uploaded;
        if (present > 0) target.leads_already_present = (target.leads_already_present ?? 0) + present;
        alreadyPresentNow += present;
        current.accepted += result.leads_uploaded;
        current.netRequested += chunk.length - present;
        current.sentUpTo += chunk.length;

        if (current.sentUpTo < groupLeads.length) {
          await persistProgress(
            { segment: group.segment, stage: 'leads', emails: groupEmails.slice(current.sentUpTo) },
            gi + 1,
          );
          continue;
        }
        // Группа загружена. Свежая кампания не приняла ни одного адреса, хотя
        // часть их не лежала в кампаниях воркспейса, — запуск сегмента не
        // состоялся, и повтор обязан о нём знать: иначе он увидит «запуск
        // закончен» и по force создаст одноимённого двойника.
        //
        // Только у СВЕЖЕЙ кампании. У переиспользованной ноль принятых означает,
        // что рассыльщик партию обработал и не взял, и следующий такой же
        // повтор ничего нового не узнает. Пометить её «не поехала» значило бы
        // звать оператора нажимать запуск по кругу; остаток при этом не
        // теряется — он в partialImportNote.
        if (!current.reused && current.accepted === 0 && current.netRequested > 0) {
          settledPending.push({ segment: group.segment, stage: 'leads', emails: groupEmails });
        }
        // Последняя группа — без промежуточной записи: сразу за циклом идёт
        // итоговая, и обращений к рассыльщику между ними нет.
        if (gi < groups.length - 1) await persistProgress(null, gi + 1);
      }
    } catch (err) {
      if (err instanceof HeLaunchTakenOverError) return takenOver();
      // Ни одной кампании нет и это не достройка — как раньше: весь запуск
      // считается failed (создавать было нечего, ретрай безопасен, аренда
      // снимается). Дальше — частичный успех: созданное записано, недоехавшее
      // в pending с адресами, которые ещё не подтверждены.
      const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
      // Место под контакты кончилось — команде (только ENG-кабинет, см.
      // alertTeamOnLaunchCapacity). Раньше ветки «ни одной кампании»: команда
      // узнаёт и тогда, когда клиент читает лишь общий отказ запуска.
      if (locale === 'en' && isInstantlyContactCapacityError(err)) alertTeamOnLaunchCapacity(message);
      if (campaigns.length === 0 && !resumeLaunch) {
        await releaseClaim();
        await logError(`${eventPrefix}.failed`, err, { userId, templateId });
        return { status: 500, body: { error: message.slice(0, 300) } };
      }
      // Кампания у сегмента ЕСТЬ и когда упали PATCH или загрузка новой
      // кампании (она уже в записи), и когда падение случилось на кампании
      // прошлой попытки — стадия обязана это различать, иначе журнал скажет
      // «кампании нет» про существующую.
      const stage = current.campaign || recordFor(segmentKey) ? 'leads' : 'campaign';
      settledPending.push({ segment: group.segment, stage, emails: groupEmails.slice(current.sentUpTo) });
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
      if (gi < groups.length - 1) {
        try {
          await persistProgress(null, gi + 1);
        } catch (persistErr) {
          if (persistErr instanceof HeLaunchTakenOverError) return takenOver();
          throw persistErr;
        }
      }
    }
  }

  // 7. Итоговая запись о запуске — та же сборка, что у промежуточных, без
  //    аренды (запуск закончен этой попыткой) и без групп «в полёте». Кампании
  //    прошлой попытки, которым в ЭТОМ запуске не нашлось группы, переносятся
  //    как есть: у рассыльщика они есть, и потерять их из записи нельзя —
  //    иначе следующий повтор создаст им двойников.
  //
  //    Запись сохраняется ДО решения об ответе — и даже когда рассыльщик не
  //    принял ни одного адреса. Всё, что создано у рассыльщика, обязано быть
  //    записано: именно на этом пути (500 без записи) терялась кампания первой
  //    группы, и повтор плодил ей двойника.
  const launchInfo = buildLaunchInfo(null, groups.length);
  if (!launchInfo) {
    // Кампаний нет ни новых, ни перенесённых: так бывает только у достройки,
    // чья единственная записанная кампания удалена у рассыльщика, а новую
    // создать не вышло. Записывать нечего — возвращаем запись, с которой
    // начали (повтор снова попробует создать кампанию), и отвечаем отказом.
    await releaseClaim();
    return {
      status: 500,
      body: { error: (segmentFailures[0]?.error ?? t.instantlyFailedFallback).slice(0, 300) },
    };
  }
  const finalSave = await saveRecord({ ...launchInfo, attempt: attemptToken });
  if (finalSave === 'taken') return takenOver();
  const updErr = finalSave === 'failed' ? lastWriteError : null;
  if (updErr) {
    // Кампания уже создана — не превращаем ответ в ошибку (иначе слепой
    // ретрай плодит дубли), но честно предупреждаем, что итоговой записи нет.
    await logError(`${eventPrefix}.info_save_failed`, updErr, {
      userId,
      templateId,
      instantlyCampaignId: launchInfo.campaign_id,
    });
  }

  const accepted = launchInfo.leads_count;
  const requested = launchInfo.leads_requested ?? accepted;
  const attempted = launchInfo.leads_attempted ?? accepted;
  const alreadyPresentTotal = launchInfo.leads_already_present ?? 0;
  const pending = launchInfo.pending ?? [];
  const keptCampaigns = keptInLoop + carriedRecords().length;
  if (owedByEmails) {
    segmentsMaterialized =
      (launchInfo.campaigns ?? []).some((c) => c.segment !== null) ||
      pending.some((p) => p.segment !== null);
  }

  // Ни одного принятого адреса — отправлять оказалось некому, и «ok» тут врал
  // бы клиенту про запущенный аутрич. Кампании остались на паузе и ЗАПИСАНЫ
  // выше, поэтому повтор их достроит, а не продублирует. Адреса, которые
  // достройка нашла уже лежащими в кампаниях (их приняла оборванная попытка, не
  // успев записать подтверждение), — не «никто не принят»: они в рассылке.
  if (accepted === 0 && alreadyPresentTotal === 0) {
    return { status: 500, body: { error: t.zeroAccepted, campaign_id: launchInfo.campaign_id } };
  }

  const warnings: string[] = [];
  if (updErr) warnings.push(t.launchInfoSaveWarning(ownsRecord));
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
  // Адреса и домены — двумя фразами: число по адресам без доменных, чтобы
  // сумма двух строк совпадала с blockedContacts аудита.
  if (blockedContacts - blockedByDomain > 0) {
    warnings.push(t.blockedContactsNote(blockedContacts - blockedByDomain));
  }
  if (blockedByDomain > 0) {
    warnings.push(t.blockedByDomainNote(blockedByDomain));
  }
  // Потолок запуска (шаг 5b) — первым делом среди «почему уехало не всё»: он
  // единственный, кто снимает ПРОВЕРЕННЫЕ адреса, и единственный, чьё число
  // клиент может сверить со своим заказом компаний.
  if (capAddressesHeldBack > 0) {
    warnings.push(
      t.launchCapTrimmedNote(
        capCompaniesSent,
        capAddressesSent,
        capAddressesHeldBack,
        capCompaniesHeldBack,
        capAddressesOfHeldBackCompanies,
      ),
    );
  }
  if (segmentWhens.length > 0 && !segmentsMaterialized) {
    const legacy = buildLaunchSequence(templateLetters);
    // us: полного сбоя классификатора здесь уже не бывает (это отказ, шаг
    // 5c), поэтому «варианты не попали» значит одно — ни один адрес этого
    // запуска модель не отнесла к сегменту. Прежняя фраза про условные блоки
    // рассыльщика назвала бы клиенту не ту причину. RU — как было.
    const segWarning =
      market === 'us'
        ? legacy && legacy.droppedSegmentVariants > 0
          ? t.segmentNoMatchNote(legacy.droppedSegmentVariants, legacy.lettersWithSegmentVariants, heldMainText)
          : null
        : locale === 'en'
          ? legacy && legacy.droppedSegmentVariants > 0
            ? t.segmentVariantsWarning(legacy.droppedSegmentVariants, legacy.lettersWithSegmentVariants)
            : null
          : legacy
            ? segmentVariantsWarning(legacy)
            : null;
    if (segWarning) warnings.push(segWarning);
  }
  // Отложенные классификатором (us, шаг 5c) — не уехали, лежат в записи
  // поимённо; повтор возьмёт ровно их.
  if (heldEmails.length > 0) {
    warnings.push(t.segmentRowsHeldNote(heldEmails.length));
  }
  if (heldMainText > 0) {
    warnings.push(t.segmentRowsMainTextNote(heldMainText, heldAttempt));
  }
  // Окно выбрало ядро (не передано явно) — назвать его и источник, и только
  // если хоть одна кампания этой попытки его действительно получила.
  if (
    sendingWindow &&
    windowCampaignIds.length > 0 &&
    (windowPlan.source === 'template' ||
      windowPlan.source === 'project' ||
      windowPlan.source === 'client' ||
      windowPlan.source === 'suggested' ||
      windowPlan.source === 'default')
  ) {
    warnings.push(t.launchWindowNote(describeHeLaunchWindow(sendingWindow), windowPlan.source));
    if (windowPlan.readError) warnings.push(t.launchWindowReadFailedNote);
  }
  if (segmentsMaterialized && (launchInfo.campaigns ?? []).length > 1) {
    warnings.push(t.segmentSplitInfo((launchInfo.campaigns ?? []).length));
  }
  // Частичная загрузка — ПРЕДУПРЕЖДЕНИЕ, а не отказ: кампании созданы, адреса
  // в них лежат, и бросок на accepted < requested сломал бы работающий запуск.
  // Адреса, которые достройка нашла уже лежащими в кампаниях, непринятыми не
  // считаются: они в рассылке.
  if (requested - accepted - alreadyPresentTotal > 0) {
    warnings.push(t.partialImportNote(requested, accepted, alreadyPresentTotal));
  }
  if (alreadyPresentNow > 0) {
    warnings.push(t.resumeAlreadyInCampaignNote(alreadyPresentNow));
  }
  if (owedUnsendable > 0) {
    warnings.push(t.owedUnsendableNote(owedUnsendable));
  }
  if (presetPinned) {
    warnings.push(t.resumePresetPinnedNote);
  }
  if (keptCampaigns > 0) {
    warnings.push(t.relaunchKeptCampaignsNote(keptCampaigns));
  }
  if (refilledCampaigns > 0) {
    warnings.push(t.relaunchRefilledCampaignsNote(refilledCampaigns));
  }
  if (replacedCampaigns > 0) {
    warnings.push(t.relaunchReplacedCampaignsNote(replacedCampaigns));
  }
  // Что СОЗДАНО — только на достройке: у первой попытки «создано N кампаний»
  // ничего не объясняет (создано всё), а у повтора это ровно то, чего в ответе
  // не хватало рядом с «перенесено» и «дозаполнено». Замены удалённых кампаний
  // названы своей фразой выше — «частям, у которых кампании не было вовсе»
  // про них неправда.
  if (resumeLaunch && createdCampaigns - replacedCampaigns > 0) {
    warnings.push(t.relaunchCreatedCampaignsNote(createdCampaigns - replacedCampaigns));
  }
  if (capacitySkippedSegments > 0) {
    warnings.push(t.capacityStopNote(capacitySkippedSegments, capacityTeamAlerted));
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
      presetId: effectivePresetId,
      presetPinned,
      instantlyCampaignId: launchInfo.campaign_id,
      campaigns: (launchInfo.campaigns ?? []).length,
      segmentsMaterialized,
      accepted,
      // Все счётчики рассыльщика: запрошено / признано полученным / принято /
      // уже лежало в кампаниях. Остаток requested-accepted-present ПОВТОРЯЕМ
      // (ни одна строка базы запуском не помечается отправленной), и по
      // журналу видно, часто ли он вообще бывает.
      requested,
      attempted,
      alreadyPresent: alreadyPresentTotal,
      alreadyPresentNow,
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
      blockedByDomain,
      // Потолок запуска: что он оставил и что снял. В аудите, а не только в
      // ответе, чтобы владелец видел по журналу, у каких запусков потолок
      // реально мешает, — это и есть вход в решение «поднимать ли 2000».
      capCompaniesSent,
      capAddressesHeldBack,
      capCompaniesHeldBack,
      capAddressesOfHeldBackCompanies,
      // Стандартные поля лида: сколько раз одноимённая переменная письма
      // запретила заполнить поле. 0 — правило коллизии ни разу не сработало.
      standardFieldsHeldBack,
      // Достройка повтора: что перенесено, что дозаполнено, что заменено, что
      // осталось, и шла ли она по поимённому долгу (без классификатора).
      resumeLaunch,
      owedByEmails,
      owedUnsendable,
      keptCampaigns,
      refilledCampaigns,
      createdCampaigns,
      replacedCampaigns,
      pendingSegments: pending.length,
      capacitySkippedSegments,
      progressSaveFailures,
      force,
      // Классификатор сегментов (шаг 5c): сколько строк размечалось, сколько
      // отложено (us), батчи, классы сбоев и РАСХОД — у запуска другой записи
      // о расходе нет (he_projects.cost_usd ведёт воркер).
      classifierRows: classifier.rows,
      classifierBatches: classifier.batches,
      classifierFailedBatches: classifier.failedBatches,
      classifierFailureKinds: classifier.failureKinds,
      classifierTokens: classifier.tokensUsed,
      classifierCostUsd: classifier.costUsd,
      heldForClassification: heldEmails.length,
      // Достройка: отложенные, что и на этой (последней) попытке остались без
      // ответа и ушли с основным текстом, и номер попытки.
      heldSentMainText: heldMainText,
      heldClassifyAttempt: heldAttempt,
      // Пустые ячейки (шаг 4b″, us): какие операторы части строк дали замену
      // вместо значения, и какие замены положены в памяти этого запуска
      // (шаблон записан до 09.10.2026, в его маппинге их нет).
      emptyCellStandIns: standInsUsed,
      standInsAddedAtLaunch,
      // Окно отправки новых кампаний (шаг 4b⁗): откуда и какое; 'preset' —
      // окно пресета (RU без явного окна).
      sendingWindowSource: windowPlan.source,
      sendingWindow,
      windowCampaigns: windowCampaignIds.length,
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
      // Тоже только для роута кабинета (он ключ удаляет): кампании, которые
      // получили ПЕРЕДАННОЕ им окно (source 'explicit') в момент создания или
      // PATCH'ем цепочки, — ставить им окно второй раз не нужно, и «остались на
      // прежних часах» про них неправда. Окно, выбранное самим ядром, сюда не
      // попадает: роут сверяет кампании со СВОИМ окном. id наружу не уходят.
      ...(windowPlan.source === 'explicit' && windowCampaignIds.length > 0
        ? { window_campaign_ids: [...windowCampaignIds] }
        : {}),
    },
  };
  };
  try {
    return allowCatchAll
      ? await withHeEngBaseBudget(portalDb, base.id, base.project_id, runUsLaunch, 'launch')
      : await runUsLaunch();
  } catch (error) {
    let budgetError: unknown;
    try {
      rethrowHeEngBaseBudgetError(error);
    } catch (stopped) {
      budgetError = stopped;
    }
    if (!budgetError) throw error;
    const failure = getHeClientFailure(budgetError);
    return { status: 409, body: { error: failure.title, code: failure.code } };
  }
}

/* ───────────── RU-проект: запуск как до порта ENG ───────────── */

/**
 * ЗАПУСК ШАБЛОНА RU-ПРОЕКТА (he_projects.market не 'us' — то есть каждый
 * проект staff-инструмента) — РОВНО КАК ДО ПОРТА ENG (решение владельца
 * 14.10.2026 «Как было»). Эталон — runHeTemplateLaunch на 46bd0e82e (ветка
 * Sergey до слияния порта), шаги 4–7: та же фильтрация строк автосборки, тот
 * же маппинг лидов, тот же 413 сверх HE_LAUNCH_MAX_LEADS, тот же классификатор
 * сегментов (прежний контракт: строка без ответа — дефолтный текст, упали все
 * батчи — одна кампания без вариантов), кампании создаются подряд, лиды группы
 * уходят одним вызовом, запись о запуске пишется ОДИН раз в конце — без
 * аренды, без launch_info.pending и без достройки. Поэтому сегментный запуск,
 * упавший на поздней группе, записан законченным, а отказ группы назван в
 * warnings («Кампания сегмента не создана: …») — как было; повтор — force.
 *
 * Отличия от эталона — только эти:
 *  - чёрный список клиента — best-effort (15.10.2026: «как было» у RU не
 *    снимает защиту клиента — фильтр оставлен, новых отказов нет). Прочитался — заблокированные адреса
 *    не уезжают, их число — в warnings (blockedContactsNote). Не прочитался
 *    (или у пресета нет владельца) — запуск идёт без фильтра, как до порта,
 *    причина — в logError. Если фильтр снял ВСЕХ, ответ — прежний отказ
 *    «В базе нет валидных email-адресов» (400 эталона на пустую аудиторию), а
 *    не письма людям из чёрного списка; число снятых — в аудите. Стоит после
 *    413: решение о потолке принимается по той же аудитории, что в эталоне;
 *  - рынок проекта читается до этой функции (шаг 4b): сбой чтения — 500
 *    marketReadFailed и у RU (без рынка нельзя отличить RU от us), строки
 *    проекта нет — 404 «База не найдена»;
 *  - аренду и долг (pending) записи шаблона, которые мог оставить код порта
 *    (он работал на проде с 14.10.2026, ~19:13 UTC, и для RU-шаблонов), шаг 1
 *    у RU-проекта не читает: такой запуск — законченный, «уже запущено» без
 *    force и новые кампании в выбранном пресете с force. Исключение — сбой
 *    БД на чтении рынка шага 1 при такой записи: тогда действует прежний код
 *    шага 1 (409 «запуск ещё идёт» при живой аренде, пресет записи для шагов
 *    2–4 при долге), а выбранный пресет перечитывается на развилке шага 4b;
 *  - campaignSettings и явное окно отправки (sendingWindow) применяются, если
 *    переданы. Staff-роут не передаёт ни то, ни другое — его payload тот же
 *    объект, что в эталоне; передаёт их только ENG-кабинет, у которого проекты
 *    'us', — здесь это страховка, чтобы кампания из ящиков пула не ушла без
 *    его настроек ни при каком рынке.
 * Функции общих модулей — нынешние, с проверенно прежним результатом на
 * RU-строках: mapBaseRowsToLeads без новых опций (очищенное имя компании
 * пишется только у ENG-баз), heLegacySegmentAssignments поверх детального
 * классификатора (прежний контракт), buildLaunchCampaignName без naming
 * (прежнее имя «HE · …»).
 */
async function runHeTemplateLaunchAsBeforePort(args: {
  input: HeTemplateLaunchInput;
  t: HeLaunchMessages;
  template: HeTemplate & { launch_info?: unknown };
  existingLaunch: HeTemplateLaunchInfo | null;
  base: Pick<HeBase, 'id' | 'filename' | 'columns' | 'data'> & { source?: string };
  preset: ClientCampaignPreset;
  templateLetters: HeTemplate['letters'];
  segmentWhens: string[];
}): Promise<HeTemplateLaunchOutcome> {
  const { input, t, template, existingLaunch, base, preset, templateLetters, segmentWhens } = args;
  const { portalDb, instantlyDb, templateId, presetId, force, userId, locale, eventPrefix } = input;

  // 1. Уже запущено — 409 без force, как в эталоне. Запись с долгом (pending)
  //    тоже: эталон её не достраивал (см. докблок).
  if (existingLaunch && !force) {
    return { status: 409, body: { error: t.alreadyLaunched, launch: heLaunchInfoAsBeforePort(existingLaunch) } };
  }

  // 5. Лиды из базы. Все проверки — ДО любого вызова Instantly.
  //    Качественные пометки АВТОсборки (base_collect, source='auto'):
  //    _email_status !== 'ok' (баунс-риск на домен клиента) и _low_relevance
  //    (шум источников вне вертикали) в запуск не идут. Ручные базы (upload)
  //    не фильтруем — там эти ключи, если есть, принадлежат пользователю.
  const allRows = Array.isArray(base.data) ? (base.data as Array<Record<string, unknown>>) : [];
  const isAutoBase = base.source === 'auto';
  let skippedInvalid = 0;
  let skippedIrrelevant = 0;
  const rows = isAutoBase
    ? allRows.filter((r) => {
        if (r._low_relevance === true) {
          skippedIrrelevant += 1;
          return false;
        }
        const status = typeof r._email_status === 'string' ? r._email_status : null;
        if (status && status !== 'ok') {
          skippedInvalid += 1;
          return false;
        }
        return true;
      })
    : allRows;
  const columns = Array.isArray(base.columns)
    ? base.columns.filter((c): c is string => typeof c === 'string')
    : [];
  const mapped = mapBaseRowsToLeads({
    rows,
    columns,
    operatorMapping: template.personalization_plan?.operator_mapping,
  });
  const { emailColumn } = mapped;
  if (!emailColumn) return { status: 400, body: { error: t.noEmailColumn } };
  if (mapped.leads.length === 0) return { status: 400, body: { error: t.noValidEmails } };
  if (mapped.leads.length > HE_LAUNCH_MAX_LEADS) {
    return { status: 413, body: { error: t.tooManyLeads(mapped.leads.length) } };
  }

  // 5a. Чёрный список клиента — best-effort (см. докблок функции). Массивы
  //     лидов и индексов строк режутся вместе: их параллельность держит сплит
  //     по сегментам ниже.
  let leads = mapped.leads;
  let leadRowIndices = mapped.leadRowIndices;
  let blockedContacts = 0;
  const clientUserId = typeof preset.client_user_id === 'string' ? preset.client_user_id.trim() : '';
  try {
    if (!clientUserId) {
      throw new Error(`пресет ${presetId}: пустой client_user_id — чей чёрный список применять, неизвестно`);
    }
    const filtered = filterBlockedLeads(leads, await getBlockedEmailSet(instantlyDb, clientUserId));
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
    // Как до порта: списка в этом запуске не было — запуск идёт без него.
    await logError(`${eventPrefix}.blocklist_failed`, err, {
      userId,
      templateId,
      presetId,
      clientUserId: clientUserId || null,
      launchContinuedWithoutBlocklist: true,
    });
  }
  if (leads.length === 0) {
    await logAudit(
      `${eventPrefix}.refused_all_contacts_blocked`,
      'Launch refused: every address is on the client blocklist',
      { userId, templateId, baseId: base.id, presetId, blockedContacts },
    );
    return { status: 400, body: { error: t.noValidEmails } };
  }

  // 5b. Материализация 15%: сплит лидов по сегментам базы. Классификатор —
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
      assignments = heLegacySegmentAssignments(
        await classifyBaseRowsIntoSegmentsDetailed({
          rows: leadRowIndices.map((ri) => rows[ri] ?? {}),
          segments: segmentWhens,
          language: detectSegmentLanguage(segmentWhens),
          unansweredFate: 'default',
        }),
      );
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
  //    ошибки идёт без scrubBrand — staff-UI нужна точная формулировка API.
  //    Основная кампания (segment=null) создаётся первой — её id уходит в
  //    скалярные поля launch_info (их читает refill-долив и старый UI).
  const campaigns: HeTemplateLaunchCampaign[] = [];
  const groupErrors: string[] = [];
  let accepted = 0;
  for (const group of groups) {
    const sequence = buildLaunchSequence(templateLetters, { segmentWhen: group.segment });
    if (!sequence) return { status: 400, body: { error: t.noLetters } };
    const campaignName = buildLaunchCampaignName(base.filename, new Date(), group.segment);
    try {
      const presetPayload = buildCampaignPayloadFromPreset({
        preset,
        sequence: { name: campaignName, steps: sequence.steps },
        ...(input.sendingWindow ? { scheduleOverride: input.sendingWindow } : {}),
      });
      const payload = input.campaignSettings ? { ...presetPayload, ...input.campaignSettings } : presetPayload;
      const created = await createCampaign(payload, instantlyRequestOptions);
      const campaignId = (created as { id?: string }).id ?? null;
      if (!campaignId) {
        throw new Error('Instantly вернул кампанию без идентификатора');
      }

      // Как в клиентском запуске: если Instantly не сохранил sequences при
      // создании — досылаем PATCH'ем.
      if (!hasUsableCampaignSequences(created.sequences)) {
        await updateCampaign(campaignId, { sequences: payload.sequences }, instantlyRequestOptions);
      }

      const leadResult = await createLeads(
        group.leadIdx.map((i) => leads[i]),
        {
          campaign_id: campaignId,
          skip_if_in_workspace: false,
          skip_if_in_campaign: false,
          skip_if_in_list: false,
        },
        instantlyRequestOptions,
      );
      accepted += leadResult.leads_uploaded;
      campaigns.push({
        campaign_id: campaignId,
        campaign_name: campaignName,
        campaign_url: instantlyCampaignUrl(campaignId),
        segment: group.segment,
        leads_count: leadResult.leads_uploaded,
      });
    } catch (err) {
      // Первая кампания: весь запуск считается failed (ни одной кампании ещё
      // нет, ретрай безопасен). Поздние группы — частичный успех: фиксируем в
      // warnings, созданные кампании не трогаем.
      if (campaigns.length === 0) {
        const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
        await logError(`${eventPrefix}.failed`, err, { userId, templateId });
        return { status: 500, body: { error: message.slice(0, 300) } };
      }
      const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
      groupErrors.push(`${group.segment ?? 'default'}: ${message.slice(0, 200)}`);
      await logError(`${eventPrefix}.group_failed`, err, {
        userId,
        templateId,
        segment: group.segment,
      });
    }
  }

  if (accepted === 0) {
    return { status: 500, body: { error: t.zeroAccepted, campaign_id: campaigns[0]?.campaign_id ?? null } };
  }

  // 7. Запись о запуске в шаблон. Скалярные поля — первая (основная) кампания;
  //    полный список — campaigns[].
  const primary = campaigns[0];
  const launchInfo: HeTemplateLaunchInfo = {
    campaign_id: primary.campaign_id,
    campaign_name: primary.campaign_name,
    campaign_url: primary.campaign_url,
    leads_count: accepted,
    preset_id: presetId,
    created_at: new Date().toISOString(),
    campaigns,
  };
  const warnings: string[] = [];
  if (skippedInvalid > 0 || skippedIrrelevant > 0) {
    warnings.push(t.rowsSkippedNote(skippedInvalid, skippedIrrelevant));
  }
  if (blockedContacts > 0) {
    warnings.push(t.blockedContactsNote(blockedContacts));
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
  for (const ge of groupErrors) {
    warnings.push(
      locale === 'en' ? `Segment campaign failed: ${ge}` : `Кампания сегмента не создана: ${ge}`,
    );
  }

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
    warnings.push(t.launchInfoSaveWarning(false));
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
      totalLeads: leads.length,
      force,
      ...(blockedContacts > 0 ? { blockedContacts } : {}),
    },
  );

  return { status: 200, body: { ok: true, launch: launchInfo, warnings } };
}
