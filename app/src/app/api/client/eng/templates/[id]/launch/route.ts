import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { scrubBrand } from '@/lib/scrubBrand';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeTemplate, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { isHeLaunchClientSafeServerError, runHeTemplateLaunch } from '@/lib/hypothesisEngine/launchTemplate';
import { toClientEngCampaignName, toClientEngLaunchInfo } from '@/lib/hypothesisEngine/clientEngProjection';
import { getHeClientFailure } from '@/lib/hypothesisEngine/clientErrors';
import { parseLaunchInfo, type HeLaunchPresetOption } from '@/lib/hypothesisEngine/launchHandoff';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError } from '@/lib/loggerServer';
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
// (+ по одному короткому PATCH на кампанию — окно отправки клиента, см. ниже).
export const maxDuration = 60;

const LAUNCH_FAILED = 'Failed to launch the campaign';

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
 * результат, ни назвать менеджеру, чего не хватает.
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
  'Part of the launch reported a problem on our side. The campaigns that were created stay paused — ask your manager to check them before launching this template again.';

/** Префикс отказа сегментной группы в английском контуре (launchTemplate.ts:429). */
const SEGMENT_FAILED_PREFIX = 'Segment campaign failed: ';

/**
 * Окно отправки клиента не доехало НИ ДО ОДНОЙ кампании. Кампании при этом
 * СОЗДАНЫ и стоят на паузе со своими прежними часами: новая — с часами пресета
 * (их заполнял администратор), кампания прошлой попытки на достройке — с теми,
 * что стояли у неё раньше. Поэтому отказом ответ не делаем — слепой повтор
 * наплодил бы дубли кампаний и лидов, — но клиент обязан узнать, что до старта
 * окно надо переставить.
 *
 * Слово «default» здесь было ложью: в кабинете «default» — это 09:00–17:00
 * Eastern (engDefaultSendingWindow), а у кампаний остались часы пресета.
 * Посмотреть настоящие часы клиент может там же, куда его отправляет фраза:
 * GET .../schedule, не найдя сохранённого выбора новее этого запуска, читает
 * окно основной кампании у рассыльщика.
 */
const WARNING_SCHEDULE_NOT_APPLIED =
  'The campaigns were created, but the sending window you picked did not reach them, so they kept ' +
  'their earlier sending hours. They stay paused — open the sending window of this template to see ' +
  'those hours, and save your window again before anyone starts them.';

/**
 * Окно доехало до ЧАСТИ кампаний запуска (сплит по сегментам базы создаёт их
 * несколько). Называем именно те, где осталось прежнее окно: клиент различает
 * кампании запуска только по имени, и «часть» без имён не даёт ему проверить
 * результат повторного сохранения. Имя идёт через тот же проектор, что и
 * launch_info ответа (внутренний префикс и русский фолбэк срезаны), id кампаний
 * наружу не уходят.
 */
function scheduleAppliedPartlyWarning(keptDefaultWindow: string[]): string {
  const named = keptDefaultWindow.filter((name) => name.length > 0).join(', ').slice(0, 300);
  return (
    'The sending window you picked reached only part of this launch. ' +
    (named
      ? `These campaigns kept their earlier sending hours: ${named}. `
      : 'Some campaigns kept their earlier sending hours. ') +
    'They stay paused — open the sending window on this step and save it again before anyone starts them.'
  );
}

/**
 * Окно у рассыльщика стоит, а в кабинете не сохранилось (запись выбора).
 * Прежнее «this screen may show the default window» стало неправдой: без
 * сохранённого выбора новее запуска GET .../schedule читает окно основной
 * кампании у рассыльщика, то есть показывает то, что там стоит.
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
// шаблоне, повтор законченного запуска только с force, незаконченный —
// достраивается). Отличия клиентского контура: пресет читается
// со скоупом владельца, тексты EN, бренд рассыльщика скрабим из ошибок, а
// ответ ядра не отдаём как есть — сужаем белым списком (см. выше): в нём
// ссылка на панель рассыльщика, id пресета и предупреждения, написанные для
// внутреннего контура. Плюс своё, чего у staff-запуска нет: клиент выбирает
// ОКНО ОТПРАВКИ (пояс/часы/дни) — см. блок «Окно отправки» ниже и
// `api/client/eng/templates/[id]/schedule` для правки уже созданных кампаний.
// TODO(tariffs): гейт запуска по тарифу — пока доступен любому клиенту.
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
    const force = body?.force === true;

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

    const outcome = await runHeTemplateLaunch({
      portalDb: supabaseAdmin,
      instantlyDb: supabaseInstantly,
      templateId: id,
      presetId,
      force,
      userId,
      scopeClientUserId: userId,
      locale: 'en',
      eventPrefix: 'client.eng.template.launch',
    });

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
    if (outcome.status >= 500 && typeof outcome.body.error === 'string') {
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
    if (typeof responseBody.error === 'string') {
      responseBody.error = scrubBrand(responseBody.error);
    }

    // ── Окно отправки на созданные кампании ──
    //
    // Ядро запуска общее со staff-инструментом и расписания не знает: кампания
    // создаётся с окном ПРЕСЕТА. Поэтому сразу после создания переставляем
    // расписание выбором клиента — тем же `campaign_schedule`, которым его
    // правит остальной портал (`lib/clientLaunch/scheduleMapping`).
    //
    // Почему безопасно делать это ВТОРЫМ вызовом, а не в момент создания:
    // кампании создаются НА ПАУЗЕ и автоматически не активируются никогда
    // (launchTemplate.ts), то есть между созданием и правкой окна ни одно письмо
    // по чужим часам уйти не может.
    //
    // Только на успешном запуске (200). 409 «уже запущено» не создаёт кампаний, и
    // переставлять окно у чужого прошлого запуска этот ответ не должен — для
    // этого есть PATCH .../schedule.
    //
    // ДОСТРОЙКА незакончённого запуска отвечает тем же 200, и окно уезжает во
    // ВСЕ кампании записи — не только в созданные этим заходом. Так и надо:
    // окно одно на шаблон, PATCH идемпотентен (в нём только campaign_schedule),
    // а кампании стоят на паузе; пропустить перенесённые значило бы оставить
    // половину запуска на часах, которые клиент уже переставил.
    const scheduleWarnings: string[] = [];
    if (outcome.status === 200) {
      const launched = parseLaunchInfo(outcome.body.launch);
      // Сегментный сплит делает по кампании на сегмент: окно выбрано одно на
      // шаблон, значит ставим его всем созданным кампаниям. Имя несём рядом с
      // id: если рассыльщик окно не принял, клиенту надо сказать, У КАКОЙ
      // кампании остались чужие часы.
      const launchedCampaigns: Array<{ campaign_id: string; campaign_name: string }> = launched
        ? (launched.campaigns ?? [
            { campaign_id: launched.campaign_id, campaign_name: launched.campaign_name },
          ])
        : [];
      const campaigns = launchedCampaigns
        .filter((c) => typeof c.campaign_id === 'string' && c.campaign_id.length > 0)
        .map((c) => ({ id: c.campaign_id, name: toClientEngCampaignName(c.campaign_name) }));

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
      }

      // Сколько кампаний РЕАЛЬНО приняли окно: от этого зависит и текст
      // предупреждения, и попадёт ли окно в ответ (см. ниже).
      let scheduleAppliedTo = 0;
      if (campaigns.length === 0 || presetAccountErr) {
        scheduleWarnings.push(WARNING_SCHEDULE_NOT_APPLIED);
      } else {
        const requestOptions = {
          accountId: resolveInstantlyAccountId(
            (presetAccountRow as { instantly_account_id?: string | null } | null)
              ?.instantly_account_id ?? null,
          ),
        };
        // По ОДНОЙ кампании за вызов: applyEngSendingWindow отдаёт только
        // счётчики, а клиенту нужно имя той, у которой окно не переставилось.
        // Число обращений к рассыльщику то же (внутри был такой же цикл), а сам
        // вызов идемпотентен — в PATCH уходит только campaign_schedule.
        const keptDefaultWindow: string[] = [];
        let lastError: unknown = null;
        for (const campaign of campaigns) {
          const one = await applyEngSendingWindow({
            campaignIds: [campaign.id],
            window: sendingWindow,
            requestOptions,
          });
          if (one.updated > 0) {
            scheduleAppliedTo += 1;
            continue;
          }
          keptDefaultWindow.push(campaign.name);
          lastError = one.lastError;
        }
        if (keptDefaultWindow.length > 0) {
          // Текст отказа рассыльщика клиенту не показываем (бренд, коды, тело
          // ответа) — он уходит в application_logs; наружу идут константа и
          // очищенные проектором имена кампаний.
          await logError('client.eng.template.launch.schedule_apply_failed', lastError, {
            userId,
            templateId: id,
            campaigns: campaigns.length,
            failed: keptDefaultWindow.length,
          });
          scheduleWarnings.push(
            scheduleAppliedTo > 0
              ? scheduleAppliedPartlyWarning(keptDefaultWindow)
              : WARNING_SCHEDULE_NOT_APPLIED,
          );
        }
        if (scheduleAppliedTo > 0) {
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
            },
          );
        }
      }

      // Клиенту — ровно четыре поля выбора (проекция), и ТОЛЬКО если окно
      // действительно стоит хотя бы у одной кампании: поле означает «часы, с
      // которыми кампании уехали», а до этой правки оно повторяло запрос даже
      // когда PATCH рассыльщика не удался — кабинет показывал часы, по которым
      // письма не поедут. Ни одной переставленной кампании — поля нет (оно
      // необязательное), и единственное, что клиент читает про окно, это
      // предупреждение выше.
      if (scheduleAppliedTo > 0) {
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

    return NextResponse.json(responseBody, { status: outcome.status });
  });
}
