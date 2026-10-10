import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { scrubBrand } from '@/lib/scrubBrand';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import {
  engPaidAccessResponse,
  loadClientHeTemplate,
  requireEngMarket,
  requireEngPaidAccess,
} from '@/lib/hypothesisEngine/apiGuards';
import {
  heLaunchOutcomeCode,
  isHeLaunchClientSafeServerError,
  isHeLaunchUnpaidServerError,
  runHeTemplateLaunch,
  type HeTemplateLaunchOutcome,
} from '@/lib/hypothesisEngine/launchTemplate';
import {
  HE_ENG_RATE_RULES,
  heEngRetryMinutes,
  hitHeEngRateLimit,
  releaseHeEngRateHit,
} from '@/lib/hypothesisEngine/engRateLimit';
import { toClientEngCampaignName, toClientEngLaunchInfo } from '@/lib/hypothesisEngine/clientEngProjection';
import { openHeProviderJournal, withHeProviderJournal } from '@/lib/hypothesisEngine/costTelemetry';
import { HE_COST_LAUNCH_STAGE } from '@/lib/hypothesisEngine/costReport';
import { projectMarket } from '@/lib/hypothesisEngine/market';
import type { HeJob } from '@/lib/hypothesisEngine/types';
import { getHeClientFailure } from '@/lib/hypothesisEngine/clientErrors';
import { heLaunchIsIncomplete, parseLaunchInfo, type HeLaunchPresetOption } from '@/lib/hypothesisEngine/launchHandoff';
import { notifyHeClientLaunch } from '@/lib/hypothesisEngine/opsAlert';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError, logWarn } from '@/lib/loggerServer';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { engServerError } from '../../../_shared';
import {
  applyEngSendingWindow,
  engDefaultSendingWindow,
  parseEngSendingWindow,
  saveEngSendingWindow,
  toClientEngSendingWindow,
} from '../../../_launchWindow';

export const dynamic = 'force-dynamic';
// До HE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании
// (окно отправки клиента ядро ставит при создании; короткий PATCH окна — только
// кампаниям прошлой попытки на достройке, см. ниже).
export const maxDuration = 60;

const LAUNCH_FAILED = 'Failed to launch the campaign';

/**
 * Повтор ЗАКОНЧЕННОГО запуска (force у ядра: новые кампании для той же
 * аудитории и новая классификация сегментов) кабинету не нужен — «Launch all»
 * его не шлёт никогда, а незаконченный запуск ядро достраивает без force.
 */
const FORCE_NOT_AVAILABLE = 'A finished launch cannot be repeated from your account.';
/**
 * Отказ ядра «уже запущено» (409 с записью о запуске) говорит про force —
 * словарь staff. Клиенту — что произошло, без него.
 */
const ALREADY_LAUNCHED = 'This template has already been launched, so it was not launched again.';

/** Лимит неудачных запусков шаблона (см. POST) — числом в текстах ниже. */
const LAUNCH_FAILED_LIMIT = HE_ENG_RATE_RULES.launch_failed.limit;

/**
 * Отказ классификатора сегментов (503 segment_classification_incomplete,
 * шаг 5c ядра) — текст роута, а не константа ядра: та отправляет клиента к
 * менеджеру, а кабинет self-serve. Ничего не создано и не изменено.
 *
 * Срока повтора («через несколько минут») здесь нет: этот же отказ может
 * оказаться последним местом в лимите неудачных запусков шаблона (см. POST),
 * и тогда следующее нажатие откажет до конца часа. Поэтому фраза называет
 * само правило лимита — она правда и до него, и на нём. Окно лимита — час
 * (HE_ENG_RATE_RULES.launch_failed).
 */
const SEGMENT_CHECK_STOPPED =
  'We could not work out which segment of these letters fits too many of the addresses in this launch, so ' +
  'it was stopped before anything was sent or changed. You can try again later: once launching a template ' +
  `has not gone through ${LAUNCH_FAILED_LIMIT} times within an hour, its next try waits until an hour has ` +
  'passed since the first of them. If it keeps stopping, contact Support.';

/**
 * Запуск НЕ начат: у этого шаблона за час уже LAUNCH_FAILED_LIMIT запусков не
 * прошли после платной части (счётчик 'launch_failed', см. POST) — отказ
 * классификатора или сбой после него. Каждый повтор заново оплачивал бы
 * классификацию всей аудитории. «can check» — у шаблона без сегментных
 * вариантов классификатора нет. Число минут — до освобождения места в окне.
 */
function launchRetryLimitedText(minutes: number): string {
  return (
    `Launching this template has not gone through ${LAUNCH_FAILED_LIMIT} times within the last hour. Each try ` +
    'can check its whole audience again, so this try was not started. Nothing was sent or changed. You can try ' +
    `again in about ${minutes} minute${minutes === 1 ? '' : 's'}; if it keeps stopping, contact Support.`
  );
}

/* ── Проекция ответа запуска ── */

/**
 * Отказ отдельной сегментной кампании. Ядро склеивает его из текста ошибки API
 * рассыльщика (launchTemplate.ts, шаг 6) — бренд, коды и тело ответа. Клиенту
 * важен сам факт: часть аудитории не поехала; причину добавляет классификатор,
 * а КАКАЯ именно часть — segmentFailedWarning ниже.
 */
const WARNING_SEGMENT_FAILED = 'One segment of your audience did not launch.';

/** Не поехала ОСНОВНАЯ кампания запуска (сегмент null у ядра). */
const WARNING_MAIN_CAMPAIGN_FAILED =
  'The main campaign of this launch did not go out, so the part of your audience that has no segment of ' +
  'its own was not launched.';

/**
 * Какая именно часть аудитории не поехала. Условие сегмента — текст ИЗ ШАБЛОНА
 * КЛИЕНТА (его же гипотеза), поэтому показать его можно; но правило файла —
 * default-deny, и сырьё здесь тоже проверяется: внутренний след (кириллица
 * staff-фразы, имя подрядчика, наша таблица, ссылка) → безымянная формулировка.
 * Длина режется: «часть аудитории» в предупреждении — подпись, а не абзац.
 *
 * Зачем вообще имя: кампании запуска клиент различает только по сегменту, и
 * «один сегмент не поехал» у шаблона с тремя сегментами не даёт ему ни проверить
 * результат, ни сказать Support, чего не хватает.
 */
function segmentFailedWarning(segment: string | null): string {
  if (segment === null) return WARNING_MAIN_CAMPAIGN_FAILED;
  const named = segment.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!named || INTERNAL_TRACE_RE.test(named)) return WARNING_SEGMENT_FAILED;
  return `One segment of your audience did not launch: “${named}”.`;
}

/**
 * Имена сегментов, не поехавших в этом запуске, в порядке ядра
 * (`segment_failures` его ответа). Сам список наружу не уходит — в его `error`
 * лежит сырьё рассыльщика; наружу идут только тексты, собранные здесь.
 */
function readSegmentFailures(raw: unknown): Array<string | null> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const segment = (item as { segment?: unknown } | null)?.segment;
    return typeof segment === 'string' ? segment : null;
  });
}

/**
 * Общий ответ на предупреждение, в котором остался внутренний след. Сюда
 * попадает, в частности, предупреждение о несохранённой записи о запуске
 * (launchTemplate.ts:445): оно называет колонку `he_templates.launch_info` и
 * миграцию — словарь staff, а не клиента. Смысл для клиента тот же: кампании
 * созданы, но повторный запуск этим текстом не защищён.
 */
const WARNING_NEEDS_ATTENTION =
  'Part of the launch reported a problem on our side. The campaigns that were created stay paused — contact Support to have them checked before launching this template again.';

/** Префикс отказа сегментной группы в английском контуре (launchTemplate.ts:429). */
const SEGMENT_FAILED_PREFIX = 'Segment campaign failed: ';

/**
 * Окно отправки клиента не доехало НИ ДО ОДНОЙ кампании. С 09.10.2026 так
 * бывает только на ДОСТРОЙКЕ, где в этом заходе ни одна кампания не создана:
 * новые ядро создаёт сразу с окном клиента, а здесь остаются кампании прошлой
 * попытки, которые уже держат адреса, — со своими прежними часами. Отказом
 * ответ не делаем — слепой повтор наплодил бы дубли кампаний и лидов, — но
 * клиент обязан узнать, что до старта окно надо переставить.
 *
 * Слово «default» здесь было ложью: в кабинете «default» — это 09:00–17:00
 * Eastern (engDefaultSendingWindow), а у кампаний остались часы пресета.
 * Посмотреть настоящие часы клиент может там же, куда его отправляет фраза:
 * GET .../schedule, не найдя сохранённого выбора новее этого запуска, читает
 * окна кампаний запуска у рассыльщика (разные — говорит и это). «Save the
 * hours you want», а не «save your window again»: форма покажет прочитанные
 * часы кампаний, а не выбор, который до них не доехал.
 */
const WARNING_SCHEDULE_NOT_APPLIED =
  'The campaigns were created, but the sending window you picked did not reach them, so they kept ' +
  'their earlier sending hours. They stay paused — open the sending window of this template to see ' +
  'those hours, and save the hours you want before anyone starts them.';

/**
 * Окно доехало до ЧАСТИ кампаний запуска (сплит по сегментам базы создаёт их
 * несколько; на достройке часть кампаний — от прошлой попытки). Называем
 * именно те, где осталось прежнее окно, — это только кампании, которым окно
 * ставил ЭТОТ роут и рассыльщик его не принял: созданные ядром несут окно с
 * момента создания. Клиент различает
 * кампании запуска только по имени, и «часть» без имён не даёт ему проверить
 * результат повторного сохранения. Имя идёт через тот же проектор, что и
 * launch_info ответа (внутренний префикс и русский фолбэк срезаны), id кампаний
 * наружу не уходят.
 *
 * Выбор при частичной перестановке НЕ сохраняется (см. блок «Окно отправки»
 * ниже), и форма окна на этом шаге показывает часы, прочитанные у кампаний, с
 * пометкой, что они у кампаний разные, — поэтому «save the hours you want», а
 * не «save it again»: выбранного окна в форме может не быть.
 */
function scheduleAppliedPartlyWarning(keptEarlierWindow: string[]): string {
  const named = keptEarlierWindow.filter((name) => name.length > 0).join(', ').slice(0, 300);
  return (
    'The sending window you picked reached only part of this launch. ' +
    (named
      ? `These campaigns kept their earlier sending hours: ${named}. `
      : 'Some campaigns kept their earlier sending hours. ') +
    'They stay paused — open the sending window on this step and save the hours you want before anyone ' +
    'starts them.'
  );
}

/**
 * Окно стоит у ВСЕХ кампаний запуска, а в кабинете не сохранилось (запись
 * выбора). Прежнее «this screen may show the default window» стало неправдой:
 * без сохранённого выбора новее запуска GET .../schedule читает окна кампаний
 * запуска у рассыльщика, то есть показывает то, что там стоит.
 */
const WARNING_SCHEDULE_NOT_SAVED =
  'Your sending window is live on the campaigns but could not be saved in the cabinet, so the ' +
  'sending-window screen reads it back from the campaigns instead.';

/**
 * Внутренний след в строке предупреждения: кириллица (фраза написана для
 * staff), имя подрядчика, имя таблицы движка или ссылка. Нужен именно
 * default-deny: три безопасных предупреждения ядра — готовые английские
 * константы (пропущенные строки базы, сегментные варианты, сплит по
 * сегментам), и новое предупреждение не должно утечь в кабинет только потому,
 * что про него здесь забыли.
 */
const INTERNAL_TRACE_RE = /[Ѐ-ӿ]|\b(?:Requesty|Serper|OpenRouter|instantly)\b|\bhe_[a-z_]+\b|https?:\/\//i;

/**
 * Предупреждения клиенту нужны (сегмент не запустился, строки базы отсеяны),
 * но собраны они для обоих контуров сразу. Безопасные константы ядра проходят
 * как есть, знакомая опасная форма заменяется своей английской, всё остальное
 * с внутренним следом — общей формулировкой. Ни один байт сырья наружу не
 * уходит: тексты собраны только из констант этого файла и клиентского
 * классификатора (clientErrors.ts, тот тоже отвечает только константами).
 */
function toClientLaunchWarnings(raw: unknown, segmentFailures: Array<string | null>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  let failureIndex = 0;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (text.startsWith(SEGMENT_FAILED_PREFIX)) {
      // Классифицируем ИСХОДНУЮ строку: правила опираются на имена подрядчиков
      // и коды их ответов — очищенный текст их бы не содержал.
      const failure = getHeClientFailure(text.slice(SEGMENT_FAILED_PREFIX.length));
      // Ядро складывает эти строки и segment_failures в ОДНОМ порядке, поэтому
      // i-й строке соответствует i-й сегмент. Списка нет (ответ без него) —
      // остаётся прежняя безымянная формулировка, а не догадка по тексту:
      // разобрать склейку «сегмент: ошибка» обратно нельзя, в условии сегмента
      // бывает ': '.
      const named = failureIndex < segmentFailures.length ? segmentFailures[failureIndex] : undefined;
      failureIndex += 1;
      out.push(
        `${named === undefined ? WARNING_SEGMENT_FAILED : segmentFailedWarning(named)} ${failure.title}`,
      );
      continue;
    }
    out.push(INTERNAL_TRACE_RE.test(text) ? WARNING_NEEDS_ATTENTION : text);
  }
  return out;
}

// GET — пресеты для селектора «Launch»: ТОЛЬКО свои (у staff — все, пресет
// выбирает сотрудник). Имени у пресета нет — подписываем адресом отправителя
// (ящик клиента, он же виден ему на /client/eng/mailboxes).
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const gate = await requireEngMarket(supabaseAdmin, userId);
  if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

  // instantly_account_id НЕ выбираем: это id рабочего пространства рассыльщика,
  // а кабинет white-label. Раньше он же был фолбэком подписи — и уезжал в
  // выпадашку «Launch» на любом пресете без ящиков.
  const { data: rows, error } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('id, email_account_ids')
    .eq('client_user_id', userId);
  if (error) {
    return engServerError('client.eng.template.launch.presets_failed', error, 'Failed to load presets', { userId });
  }

  const presets: HeLaunchPresetOption[] = (rows ?? []).map((r) => {
    const row = r as Pick<ClientCampaignPreset, 'id' | 'email_account_ids'>;
    // email_account_ids хранит АДРЕСА ящиков (admin/clients/[id]/preset: a.email),
    // они клиентские и в кабинете уже показаны — подписывать ими можно.
    const sender = Array.isArray(row.email_account_ids) ? row.email_account_ids[0] : null;
    return {
      // Ключ выбора — id пресета: селектор кладёт его в option value и шлёт
      // обратно как preset_id (EngStepReview), поэтому подпись можно менять
      // свободно. Суффикс из того же id ничего нового не раскрывает и, в
      // отличие от индекса в списке, не скачет между запросами (порядок
      // выборки не задан).
      id: row.id,
      name: sender ?? `Sending preset ${row.id.slice(0, 8)}`,
    };
  });

  return NextResponse.json({ presets });
}

// POST — «Launch (paused)»: ДЕЛЕГИРУЕМ в общее ядро runHeTemplateLaunch (та
// же механика, что у staff: PAUSED-кампания, лиды базы, launch_info в
// шаблоне, незаконченный запуск достраивается). Отличия клиентского контура:
// повтора законченного запуска (force) нет — 400 FORCE_NOT_AVAILABLE; пресет читается
// со скоупом владельца, тексты EN, бренд рассыльщика скрабим из ошибок, а
// ответ ядра не отдаём как есть — сужаем белым списком (см. выше): в нём
// ссылка на панель рассыльщика, id пресета и предупреждения, написанные для
// внутреннего контура. Плюс своё, чего у staff-запуска нет: клиент выбирает
// ОКНО ОТПРАВКИ (пояс/часы/дни) — ядро создаёт кампании сразу с ним, см. блок
// «Окно отправки» ниже и `api/client/eng/templates/[id]/schedule` для правки
// уже созданных кампаний.
//
// Гейт платных шагов (requireEngPaidAccess, действие 'launch') — до журнала и
// ядра: подтверждённая почта (письма уходят живым людям) и потолок расхода
// клиента (по умолчанию выключен; таблица действий в engPaidAccess.ts).
// Платная часть самого запуска — классификатор сегментов (шаг 5c ядра). Его
// повтор у законченного запуска закрыт отказом force; а запуск, который НЕ
// ПРОШЁЛ после него, — отказ классификатора (503
// segment_classification_incomplete, без ответа больше половины адресов) или
// сбой после классификации (первая кампания у рассыльщика не создалась —
// 500 без кода; бросок ядра), — записи о запуске не оставляет, и каждое
// следующее нажатие заново оплачивало классификацию всей аудитории. Поэтому
// такие запуски считаются по шаблону: не больше 3 за час (engRateLimit,
// 'launch_failed'), следующее нажатие в окне отвечает 503 без вызова ядра —
// см. блок перед журналом. Не считаются 5xx ядра ДО классификатора
// (isHeLaunchUnpaidServerError: пресет, рынок, защиты, чёрный список, аренда
// не прочитались) — они ничего не оплатили и зовут повторить через минуту.
//
// Отметка «запуск идёт» ('launch_in_flight', engRateLimit) — на всё время
// ядра: первый запуск шаблона пишет he_templates.launch_info только после
// того, как рассыльщик создал первую кампанию, а платный классификатор идёт
// раньше (минуты). Удаление проекта (DELETE api/client/eng/projects/[id])
// читает эту отметку и до конца запуска отвечает «занято».
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.launch.post' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

    const { userId } = result.auth;
    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    let body: { preset_id?: unknown; force?: unknown; schedule?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    const presetId = typeof body?.preset_id === 'string' ? body.preset_id.trim() : '';
    if (!presetId) return jsonError('Provide preset_id', 400);
    if (body?.force !== undefined && body.force !== false) return jsonError(FORCE_NOT_AVAILABLE, 400);

    // Окно отправки выбирает КЛИЕНТ (пояс, часы, дни). Поля нет в теле —
    // ставим английский дефолт, а НЕ окно пресета: пресет заполнял
    // администратор, и для клиента рынка США его часы и пояс случайны. Так
    // запуск мимо кабинета (старый бандл, прямой вызов API) тоже получает
    // осмысленное окно, а не московские часы.
    const parsedWindow =
      body?.schedule === undefined || body?.schedule === null
        ? ({ ok: true, window: engDefaultSendingWindow() } as const)
        : parseEngSendingWindow(body.schedule);
    if (!parsedWindow.ok) return jsonError(parsedWindow.error, 400);
    const sendingWindow = parsedWindow.window;

    // Скоуп шаблона ДО запуска: чужой — 404, существование не раскрываем.
    const owned = await loadClientHeTemplate(supabaseAdmin, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const access = await requireEngPaidAccess(supabaseAdmin, userId, { action: 'launch' });
    if (!access.ok) return engPaidAccessResponse(access.refusal);

    // Неудачные запуски этого шаблона за час. Попадание пишется ДО ядра (два
    // параллельных нажатия не проходят оба последнее место) и остаётся, если
    // запуск не прошёл после платной части: отказ классификатора, любой
    // другой 5xx ядра, кроме отказов до классификатора, или бросок ядра
    // (ниже, finally). Успех, 4xx и 5xx до классификатора его возвращают.
    // Окно полно — запуск не начат, ответ 503 без кода: «Launch all» на 5xx
    // без кода останавливает прогон (EngStepReview), чтобы следующий шаблон не
    // оплатил классификацию ради того же сбоя. Без миграции 20261010_0001
    // счёт — в памяти процесса (engRateLimit), строка warn.
    const failedHit = await hitHeEngRateLimit(supabaseAdmin, 'launch_failed', id);
    if (failedHit.fallbackReason) {
      void logWarn(
        'client.eng.template.launch.failed_limit_fallback',
        `failed-launch count decided in process memory: ${failedHit.fallbackReason}`,
        { userId, templateId: id },
      );
    }
    if (!failedHit.allowed) {
      void logAudit(
        'client.eng.template.launch.retry_limited',
        'ENG launch not started: launches of this template failed after their paid part too often within the hour',
        { userId, templateId: id, retryAfterSeconds: failedHit.retryAfterSeconds },
      );
      return NextResponse.json(
        {
          error: launchRetryLimitedText(heEngRetryMinutes(failedHit.retryAfterSeconds)),
          retry_after_seconds: failedHit.retryAfterSeconds,
        },
        { status: 503, headers: { 'Retry-After': String(failedHit.retryAfterSeconds) } },
      );
    }

    // Отметка «запуск идёт» (см. докблок POST) — до ядра, возвращается в
    // finally при любом исходе. Отказ лимита отметки запуск не останавливает:
    // её лимит — только потолок роста таблицы. Не легла в БД (миграции нет,
    // блип) — удаление проекта её не увидит, строка warn.
    const inFlightHit = await hitHeEngRateLimit(supabaseAdmin, 'launch_in_flight', id);
    if (inFlightHit.fallbackReason) {
      void logWarn(
        'client.eng.template.launch.in_flight_mark_fallback',
        `launch-in-flight mark kept in process memory only (project delete cannot see it): ${inFlightHit.fallbackReason}`,
        { userId, templateId: id },
      );
    }

    // Журнал расхода ENG (costTelemetry.ts) вокруг ядра запуска: классификатор
    // сегментов (шаг 5c ядра) — платный вызов модели из роута, и без журнала
    // он не попадал ни в отчёт себестоимости, ни в потолок расхода. Только у
    // проекта market='us' (рынок — из уже прочитанного скоупа, без запроса);
    // у другого рынка openHeProviderJournal отвечает null, и ядро зовётся как
    // раньше. Запись строк фоновая и не бросает: запуск её не ждёт (settle
    // здесь не зовётся — ожидание до 40 с при лежащей БД вытолкнуло бы ответ
    // за maxDuration), а сбой записи стоит строки журнала, не запуска. Стадия
    // HE_COST_LAUNCH_STAGE не из he_jobs, на месте id джобы — id шаблона
    // (costReport.ts, шапка).
    const journal = openHeProviderJournal(
      supabaseAdmin,
      projectMarket(owned.project as { market?: string | null }),
      {
        id,
        project_id: String(owned.project.id),
        stage: HE_COST_LAUNCH_STAGE as HeJob['stage'],
        payload: {},
      },
      (msg) => console.warn(msg),
    );
    // Сужение `!supabaseAdmin || !supabaseInstantly` выше в замыкание не
    // переходит — клиенты фиксируются здесь.
    const portalDb = supabaseAdmin;
    const instantlyDb = supabaseInstantly;
    // Вернуть попадание 'launch_failed' — только когда исход известен и он не
    // «не прошёл после платной части». Бросок ядра оставляет его.
    let releaseFailedHit = false;
    let outcome: HeTemplateLaunchOutcome;
    try {
      outcome = await withHeProviderJournal(journal, () =>
        runHeTemplateLaunch({
          portalDb,
          instantlyDb,
          templateId: id,
          presetId,
          force: false,
          userId,
          scopeClientUserId: userId,
          locale: 'en',
          eventPrefix: 'client.eng.template.launch',
          // Окно уезжает в ядро: новые кампании создаются СРАЗУ с ним (шаг 4b⁗
          // ядра), а не с часами пресета до второго вызова.
          sendingWindow,
        }),
      );
      releaseFailedHit = outcome.status < 500 || isHeLaunchUnpaidServerError(outcome.body.error);
    } finally {
      // Не вышло вернуть — попадание считается до конца окна, строка warn.
      if (releaseFailedHit) {
        const failure = await releaseHeEngRateHit(portalDb, 'launch_failed', id, failedHit);
        if (failure) {
          void logWarn('client.eng.template.launch.failed_limit_release_failed', `hit kept: ${failure}`, {
            userId,
            templateId: id,
          });
        }
      }
      // Отметка «запуск идёт» — при любом исходе. Не вышло — она гаснет сама
      // через аренду запуска (15 мин), до того удаление проекта отвечает «занято».
      const markFailure = await releaseHeEngRateHit(portalDb, 'launch_in_flight', id, inFlightHit);
      if (markFailure) {
        void logWarn('client.eng.template.launch.in_flight_mark_release_failed', `mark kept: ${markFailure}`, {
          userId,
          templateId: id,
        });
      }
    }

    // 5xx ядра запуска несут сырьё: сообщение Postgres (чтения шаблона и базы)
    // и тело ответа API рассыльщика (отказ первой кампании). Наружу — константа
    // + код причины, настоящий текст уходит в application_logs.
    //
    // Исключение — английские константы ядра, которые клиенту нужны КАК ЕСТЬ
    // (isHeLaunchClientSafeServerError): «чёрный список не прочитался /
    // настройки проекта не прочитались / начало запуска не записалось — кампания
    // не создана, повторите через минуту» и «рассыльщик не принял ни одного
    // адреса, кампании на паузе». Подменённые общей «Failed to launch the
    // campaign», они не давали клиенту отличить безопасный повтор от сбоя
    // посреди запуска. Сырья в них нет, это литералы словаря ядра.
    //
    // Отказ классификатора сегментов (503 segment_classification_incomplete)
    // уходит СО СВОИМ КОДОМ и статусом: «Launch all» останавливает прогон
    // (EngStepReview) — классификатор общий у всех шаблонов, и следующий
    // шаблон с сегментами оплатил бы классификацию всей своей аудитории ради
    // того же отказа. На любом другом 5xx (engServerError, 500 без кода)
    // прогон теперь тоже останавливается — по статусу. Код — из словаря ядра
    // (heLaunchOutcomeCode), текст — свой (SEGMENT_CHECK_STOPPED): он
    // называет правило лимита неудачных запусков, а у ядра — срок повтора,
    // который на последнем месте лимита неправда.
    if (outcome.status >= 500 && typeof outcome.body.error === 'string') {
      const outcomeCode = heLaunchOutcomeCode(outcome);
      if (outcomeCode === 'segment_classification_incomplete') {
        await logError('client.eng.template.launch_failed', new Error(outcome.body.error), {
          userId,
          templateId: id,
          status: outcome.status,
          code: outcomeCode,
        });
        return NextResponse.json({ error: SEGMENT_CHECK_STOPPED, code: outcomeCode }, { status: 503 });
      }
      const outward = isHeLaunchClientSafeServerError(outcome.body.error) ? outcome.body.error : LAUNCH_FAILED;
      return engServerError('client.eng.template.launch_failed', new Error(outcome.body.error), outward, {
        userId,
        templateId: id,
        status: outcome.status,
      });
    }

    // 4xx — это продуктовые причины ядра (нет валидных адресов, лимит лидов,
    // уже запущено): они по-английски и предназначены клиенту. White-label:
    // в тексте всё же может проскочить бренд рассыльщика — скрабим.
    const responseBody = { ...outcome.body };
    // Машинный список отказов сегментов — вход для предупреждений ниже, и
    // наружу он НЕ уходит: в его `error` лежит текст ответа рассыльщика.
    const segmentFailures = readSegmentFailures(responseBody.segment_failures);
    delete responseBody.segment_failures;
    // Кампании, которые получили окно уже в ядре (созданы с ним или
    // переставлены PATCH'ем цепочки), — служебный список ядра: id наружу не
    // уходят, ключ удаляем.
    const windowAppliedInCore = new Set(
      Array.isArray(responseBody.window_campaign_ids)
        ? (responseBody.window_campaign_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    );
    delete responseBody.window_campaign_ids;
    if (typeof responseBody.error === 'string') {
      responseBody.error = scrubBrand(responseBody.error);
    }
    // 409 с записью о запуске у ядра ровно один — «уже запущено».
    if (outcome.status === 409 && 'launch' in responseBody) {
      responseBody.error = ALREADY_LAUNCHED;
    }

    // ── Окно отправки на кампании запуска ──
    //
    // С 09.10.2026 окно ставит ЯДРО: новые кампании создаются сразу с окном
    // клиента, а пустая кампания прошлой попытки получает его тем же PATCH'ем,
    // что и цепочку (`window_campaign_ids` ответа ядра). Здесь остаётся только
    // то, что ядро не трогает: кампании, которые на ДОСТРОЙКЕ уже держат адреса
    // (ядро их не меняет — их получатели могут быть в рассылке), и кампании
    // прошлой попытки, которым в этом заходе не нашлось группы. Окно одно на
    // шаблон, PATCH идемпотентен (в нём только campaign_schedule), кампании на
    // паузе, поэтому переставить им окно безопасно — и пропустить их значило
    // бы оставить часть запуска на часах, которые клиент уже переставил.
    //
    // Только на успешном запуске (200). 409 «уже запущено» не создаёт кампаний, и
    // переставлять окно у чужого прошлого запуска этот ответ не должен — для
    // этого есть PATCH .../schedule.
    const scheduleWarnings: string[] = [];
    if (outcome.status === 200) {
      const launched = parseLaunchInfo(outcome.body.launch);
      // Сегментный сплит делает по кампании на сегмент: окно выбрано одно на
      // шаблон, значит ставим его всем кампаниям запуска. Имя несём рядом с
      // id: если рассыльщик окно не принял, клиенту надо сказать, У КАКОЙ
      // кампании остались прежние часы.
      const launchedCampaigns: Array<{ campaign_id: string; campaign_name: string }> = launched
        ? (launched.campaigns ?? [
            { campaign_id: launched.campaign_id, campaign_name: launched.campaign_name },
          ])
        : [];
      const campaigns = launchedCampaigns
        .filter((c) => typeof c.campaign_id === 'string' && c.campaign_id.length > 0)
        .map((c) => ({ id: c.campaign_id, name: toClientEngCampaignName(c.campaign_name) }));
      // Окно уже стоит (ядро) — второй вызов им не нужен.
      const needWindow = campaigns.filter((c) => !windowAppliedInCore.has(c.id));

      // Сколько кампаний РЕАЛЬНО несут окно: от этого зависит и текст
      // предупреждения, и попадёт ли окно в ответ (см. ниже).
      let scheduleAppliedTo = campaigns.length - needWindow.length;
      // Кампании, у которых окно переставить не вышло: только они «остались на
      // прежних часах» — у созданных ядром окно стоит с первой секунды.
      const keptEarlierWindow: string[] = [];
      let lastError: unknown = null;

      if (needWindow.length > 0) {
        // Аккаунт рассыльщика — тот же, в котором ядро создало кампанию: он задан
        // пресетом ЗАПИСИ о запуске (скоуп владельца, чужой пресет невидим), а не
        // выбранным в запросе — достройку ядро ведёт пресетом, с которым запуск
        // начат (launchTemplate.ts, шаг 3). Промах аккаунтом означал бы PATCH в
        // чужой воркспейс.
        const launchPresetId = launched?.preset_id || presetId;
        const { data: presetAccountRow, error: presetAccountErr } = await supabaseInstantly
          .from('client_campaign_presets')
          .select('instantly_account_id')
          .eq('id', launchPresetId)
          .eq('client_user_id', userId)
          .maybeSingle();
        if (presetAccountErr) {
          await logError('client.eng.template.launch.schedule_preset_failed', presetAccountErr, {
            userId,
            templateId: id,
          });
          lastError = presetAccountErr;
          for (const campaign of needWindow) keptEarlierWindow.push(campaign.name);
        } else {
          const requestOptions = {
            accountId: resolveInstantlyAccountId(
              (presetAccountRow as { instantly_account_id?: string | null } | null)
                ?.instantly_account_id ?? null,
            ),
          };
          // По ОДНОЙ кампании за вызов: applyEngSendingWindow отдаёт только
          // счётчики, а клиенту нужно имя той, у которой окно не переставилось.
          // Вызов идемпотентен — в PATCH уходит только campaign_schedule.
          for (const campaign of needWindow) {
            const one = await applyEngSendingWindow({
              campaignIds: [campaign.id],
              window: sendingWindow,
              requestOptions,
            });
            if (one.updated > 0) {
              scheduleAppliedTo += 1;
              continue;
            }
            keptEarlierWindow.push(campaign.name);
            lastError = one.lastError;
          }
        }
      }

      if (campaigns.length === 0) {
        scheduleWarnings.push(WARNING_SCHEDULE_NOT_APPLIED);
      } else if (keptEarlierWindow.length > 0) {
        // Текст отказа рассыльщика клиенту не показываем (бренд, коды, тело
        // ответа) — он уходит в application_logs; наружу идут константа и
        // очищенные проектором имена кампаний.
        await logError('client.eng.template.launch.schedule_apply_failed', lastError, {
          userId,
          templateId: id,
          campaigns: campaigns.length,
          failed: keptEarlierWindow.length,
        });
        scheduleWarnings.push(
          scheduleAppliedTo > 0
            ? scheduleAppliedPartlyWarning(keptEarlierWindow)
            : WARNING_SCHEDULE_NOT_APPLIED,
        );
      }
      // Окно стоит у ВСЕХ кампаний запуска — только тогда оно правда «окно
      // этого запуска» (и поле `schedule` ниже, и сохранённый выбор).
      const appliedToAll = campaigns.length > 0 && scheduleAppliedTo === campaigns.length;
      if (scheduleAppliedTo > 0) {
        // Выбор сохраняем, только если окно встало у всех кампаний: сохранённую
        // строку новее записи о запуске GET .../schedule печатает окном ВСЕГО
        // запуска, не спрашивая рассыльщика. При частичной перестановке строки
        // новее записи нет (прежняя — старше этой попытки: ядро пишет
        // created_at записи временем её начала), и GET читает окна у самих
        // кампаний — то есть видит, что они разные.
        if (appliedToAll) {
          const saved = await saveEngSendingWindow(supabaseAdmin, {
            templateId: id,
            clientUserId: userId,
            window: sendingWindow,
          });
          if (!saved.ok) {
            // Таблица могла быть не создана (миграция не применена) — окно у
            // рассыльщика уже стоит, поэтому это предупреждение, а не отказ.
            await logError('client.eng.template.launch.schedule_save_failed', saved.error, {
              userId,
              templateId: id,
            });
            scheduleWarnings.push(WARNING_SCHEDULE_NOT_SAVED);
          }
        }
        await logAudit(
          'client.eng.template.launch.schedule_applied',
          'ENG client picked the sending window for a launch',
          {
            userId,
            templateId: id,
            timezone: sendingWindow.timezone,
            from: sendingWindow.from,
            to: sendingWindow.to,
            days: sendingWindow.days,
            campaigns: scheduleAppliedTo,
            atCreation: campaigns.length - needWindow.length,
            failed: keptEarlierWindow.length,
          },
        );
      }

      // Клиенту — ровно четыре поля выбора (проекция), и ТОЛЬКО если окно
      // стоит у ВСЕХ кампаний запуска: поле означает «часы, с которыми
      // кампании уехали». Раньше оно уходило, если окно встало хотя бы у одной,
      // — то есть при частичной перестановке ответ утверждал окно для всего
      // запуска, хотя часть кампаний осталась на прежних часах (их называет
      // предупреждение выше). Нет поля — единственное, что клиент читает про
      // окно, это предупреждение.
      if (appliedToAll) {
        responseBody.schedule = toClientEngSendingWindow(sendingWindow);
      }
    }

    // Запись о запуске уезжает клиенту ДВУМЯ путями: успех (200) и «шаблон уже
    // запущен» (409, launchTemplate.ts:168) — сужаем оба, поле одно и то же.
    //
    // Проектор общий с деталкой проекта (она отдаёт ту же
    // `he_templates.launch_info`): два ответа про один объект обязаны совпадать
    // по составу полей, иначе «скрытое» поле возвращается через второй
    // эндпоинт. Раньше здесь лежала копия тех же двух белых списков — ровно та
    // конструкция, которая расходится. Сужается ТОЛЬКО ответ: в колонке ядро
    // уже записало полную запись (launchTemplate.ts:435), её не трогаем.
    if ('launch' in responseBody) {
      responseBody.launch = toClientEngLaunchInfo(responseBody.launch);
    }
    if ('warnings' in responseBody) {
      responseBody.warnings = toClientLaunchWarnings(responseBody.warnings, segmentFailures);
    }
    // Свои предупреждения дописываем ПОСЛЕ проекции: это готовые английские
    // константы этого файла, прогонять их через фильтр чужого сырья незачем.
    if (scheduleWarnings.length > 0) {
      const existing = Array.isArray(responseBody.warnings) ? (responseBody.warnings as string[]) : [];
      responseBody.warnings = [...existing, ...scheduleWarnings];
    }

    // Команде — что клиент создал кампании и их надо проверить и стартовать:
    // ядро создаёт их на паузе и не активирует никогда (launchHandoff.ts), а
    // кабинет обещает клиенту, что их стартует менеджер. Только успешный
    // запуск (200, запись о запуске в ответе ядра) — и законченный, и
    // незаконченный: созданные кампании ждут сотрудника в обоих случаях. Не
    // ждём (`void`): ответ клиенту от Telegram не зависит, notifyHeClientLaunch
    // не бросает; дедупликация и свёртка «Launch all» — в opsAlert.ts.
    if (outcome.status === 200) {
      const record = parseLaunchInfo(outcome.body.launch);
      if (record) {
        void notifyHeClientLaunch({
          projectId: String(owned.project.id),
          market: projectMarket(owned.project as { market?: string | null }),
          templateId: id,
          verticalId: typeof owned.template.vertical_id === 'string' ? owned.template.vertical_id : null,
          // Все кампании записи; у записи без списка (до сплита) — основная.
          campaignIds: (record.campaigns?.length ? record.campaigns.map((c) => c.campaign_id) : [record.campaign_id])
            .filter((cid) => cid.length > 0),
          leads: record.leads_count,
          unfinished: heLaunchIsIncomplete(record),
          forced: false,
        });
      }
    }

    return NextResponse.json(responseBody, { status: outcome.status });
  });
}
