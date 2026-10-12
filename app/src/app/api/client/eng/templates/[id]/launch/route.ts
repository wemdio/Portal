import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isValidUuid } from '@/lib/apiValidation';
import { withToolTrace } from '@/lib/toolTrace';
import { loadClientHeTemplate, requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import type { HeLaunchPresetOption } from '@/lib/hypothesisEngine/launchHandoff';
import { ENG_LAUNCH_FORCE_NOT_AVAILABLE_TEXT, runHeEngTemplateLaunch } from '@/lib/hypothesisEngine/engClientLaunch';
import {
  ENG_LAUNCH_BUSY_TEXT,
  claimHeEngAutoLaunch,
  heEngAutoLaunchVerdict,
  heEngStartGate,
  recordHeEngAutoLaunchDecision,
  startHeEngAutoLaunchLeaseHeartbeat,
} from '@/lib/hypothesisEngine/engAutoLaunch';
import { ENG_PAID_UNAVAILABLE_TEXT } from '@/lib/hypothesisEngine/engPaidAccess';
import { logWarn } from '@/lib/loggerServer';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { engServerError } from '../../../_shared';
import { engDefaultSendingWindow, parseEngSendingWindow } from '../../../_launchWindow';

export const dynamic = 'force-dynamic';
// До HE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании
// (окно отправки клиента ядро ставит при создании; короткий PATCH окна — только
// кампаниям прошлой попытки на достройке) и старт созданных кампаний
// (по кампании: чтение, старт, при неясном ответе — проверочное чтение).
export const maxDuration = 120;

// GET — пресеты для селектора «Launch»: ТОЛЬКО свои. С S2 кабинет селектор не
// рисует и этот GET не зовёт (пресет собирается из ящиков пула проекта при
// запуске, а POST поле preset_id игнорирует); ответ остался для вкладок со
// старым бандлом. Имени у пресета нет — подписываем адресом отправителя.
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

// POST — «Launch now» (кнопка у вертикали на шаге 3): сам запуск — общий
// вызов engClientLaunch.runHeEngTemplateLaunch (trigger 'button'), ТОТ ЖЕ,
// которым автозапуск воркера запускает готовый шаблон после «Launch» проекта
// (engAutoLaunch). Здесь — только вход: сессия, рынок, id, тело (force, окно,
// start_sending), скоуп шаблона — и замок шаблона.
//
// ЗАМОК (he_eng_auto_launch_claim, manual): кнопка берёт строку автозапуска
// шаблона, кроме случая, когда её держит другой (тик воркера или вторая
// вкладка) с живой арендой, — тогда 409 ENG_LAUNCH_BUSY_TEXT, ничего не
// начато. Без замка тик и кнопка могли бы одновременно начать ПЕРВЫЙ запуск
// одного шаблона (аренда записи у ядра появляется только после первой
// кампании) — то есть создать кампании дважды. Итог нажатия пишется в ту же
// строку тем же решением (heEngAutoLaunchVerdict), что у тика: счётчики
// платных сбоев общие, а включённый автозапуск подхватывает отложенное
// (например, «отправка аккаунта ещё не включена»). Писем кнопка не шлёт —
// клиент видит итог на экране. Миграции нет (20261012_0001) — замка нет, как
// до S3; сбой чтения замка — 503, ничего не начато.
//
// Пока запуск идёт, кнопка продлевает аренду строки (тем же продлением, что
// тик): standalone-сервер Next maxDuration не обрывает, и медленный
// классификатор пережил бы аренду — тогда тик начал бы второй платный запуск.
// Перед стартом кампаний — та же проверка, что у тика (heEngStartGate):
// аккаунт не заблокирован посреди запуска, решение «стартуем» записано в
// строку (без него брошенная строка ничего не стартует).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'client.eng.launch.post' }, async () => {
    const requestStartedAt = Date.now();
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

    const { userId } = result.auth;
    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const { id } = await params;
    if (!isValidUuid(id)) return jsonError('Invalid id', 400);

    let body: { preset_id?: unknown; force?: unknown; schedule?: unknown; start_sending?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    // `preset_id` тела больше не читается: пресет отправки клиента собирается
    // из ящиков пула его проекта (ensureHeEngPresetForProject в общем вызове),
    // выбирать нечего. Старый бандл кабинета поле присылает — оно игнорируется.
    if (body?.force !== undefined && body.force !== false) return jsonError(ENG_LAUNCH_FORCE_NOT_AVAILABLE_TEXT, 400);
    // Старт кампаний после ядра — только по явному `start_sending: true`: его
    // шлёт кабинет, который говорит клиенту, что запуск начинает отправку
    // (api-client.launchEngTemplate). Вкладка со старым бандлом обещала
    // «Launch all (paused)» — её запуск создаёт кампании на паузе
    // (sending.outcome 'skipped', skip_reason 'not_requested'), и клиент
    // стартует их кнопкой «Start sending», уже зная, что это отправка.
    const startRequested = body?.start_sending === true;

    // Окно отправки выбирает КЛИЕНТ (пояс, часы, дни). Поля нет в теле —
    // ставим английский дефолт, а НЕ окно пресета: пресет заполнял
    // администратор, и для клиента рынка США его часы и пояс случайны. Так
    // запуск мимо кабинета (старый бандл, прямой вызов API) тоже получает
    // осмысленное окно, а не московские часы. Это окно ПЕРВОГО запуска рынка:
    // у шаблона, у которого уже есть запись о запуске (достройка), общий вызов
    // его не берёт — там своё окно рынка, и кампании прошлой попытки не
    // переставляются (engClientLaunch.heEngLaunchWindowPlan).
    const parsedWindow =
      body?.schedule === undefined || body?.schedule === null
        ? ({ ok: true, window: engDefaultSendingWindow() } as const)
        : parseEngSendingWindow(body.schedule);
    if (!parsedWindow.ok) return jsonError(parsedWindow.error, 400);
    const sendingWindow = parsedWindow.window;

    // Скоуп шаблона ДО запуска: чужой — 404, существование не раскрываем.
    const owned = await loadClientHeTemplate(supabaseAdmin, id, userId);
    if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

    const lock = await claimHeEngAutoLaunch(supabaseAdmin, {
      templateId: id,
      projectId: String(owned.project.id),
      manual: true,
    });
    if (lock.kind === 'busy') {
      return NextResponse.json({ error: ENG_LAUNCH_BUSY_TEXT, code: 'launch_running' }, { status: 409 });
    }
    if (lock.kind === 'error') {
      void logWarn('client.eng.template.launch.lock_failed', lock.message, { userId, templateId: id });
      return jsonError(ENG_PAID_UNAVAILABLE_TEXT, 503);
    }

    const claimed = lock.kind === 'claimed' ? lock.row : null;
    const stopHeartbeat = claimed ? startHeEngAutoLaunchLeaseHeartbeat(supabaseAdmin, claimed) : null;
    let launched: Awaited<ReturnType<typeof runHeEngTemplateLaunch>>;
    try {
      launched = await runHeEngTemplateLaunch({
        portalDb: supabaseAdmin,
        instantlyDb: supabaseInstantly,
        userId,
        templateId: id,
        owned: { project: owned.project, template: owned.template },
        sendingWindow,
        startSending: startRequested,
        trigger: 'button',
        requestStartedAt,
        onStartDecided: heEngStartGate(supabaseAdmin, { userId, templateId: id, claimed }),
      });
    } finally {
      stopHeartbeat?.();
    }

    if (lock.kind === 'claimed') {
      await recordHeEngAutoLaunchDecision(
        supabaseAdmin,
        lock.row,
        heEngAutoLaunchVerdict(launched.summary, lock.row, new Date()),
      );
    }

    return NextResponse.json(launched.body, {
      status: launched.status,
      ...(launched.headers ? { headers: launched.headers } : {}),
    });
  });
}
