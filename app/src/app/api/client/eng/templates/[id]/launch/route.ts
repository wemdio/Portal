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
import { runHeTemplateLaunch } from '@/lib/hypothesisEngine/launchTemplate';
import { toClientEngLaunchInfo } from '@/lib/hypothesisEngine/clientEngProjection';
import { getHeClientFailure } from '@/lib/hypothesisEngine/clientErrors';
import type { HeLaunchPresetOption } from '@/lib/hypothesisEngine/launchHandoff';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { engServerError } from '../../../_shared';

export const dynamic = 'force-dynamic';
// До HE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании.
export const maxDuration = 60;

const LAUNCH_FAILED = 'Failed to launch the campaign';

/* ── Проекция ответа запуска ── */

/**
 * Отказ отдельной сегментной кампании. Ядро склеивает его из текста ошибки API
 * рассыльщика (launchTemplate.ts:383,429) — бренд, коды и тело ответа. Клиенту
 * важен сам факт: часть аудитории не поехала; причину добавляет классификатор.
 */
const WARNING_SEGMENT_FAILED = 'One segment campaign was not created.';

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
function toClientLaunchWarnings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (text.startsWith(SEGMENT_FAILED_PREFIX)) {
      // Классифицируем ИСХОДНУЮ строку: правила опираются на имена подрядчиков
      // и коды их ответов — очищенный текст их бы не содержал.
      const failure = getHeClientFailure(text.slice(SEGMENT_FAILED_PREFIX.length));
      out.push(`${WARNING_SEGMENT_FAILED} ${failure.title}`);
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
// шаблоне, повтор только с force). Отличия клиентского контура: пресет читается
// со скоупом владельца, тексты EN, бренд рассыльщика скрабим из ошибок, а
// ответ ядра не отдаём как есть — сужаем белым списком (см. выше): в нём
// ссылка на панель рассыльщика, id пресета и предупреждения, написанные для
// внутреннего контура.
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

    let body: { preset_id?: unknown; force?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid body', 400);
    }
    const presetId = typeof body?.preset_id === 'string' ? body.preset_id.trim() : '';
    if (!presetId) return jsonError('Provide preset_id', 400);
    const force = body?.force === true;

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

    // 5xx ядра запуска несут сырьё: сообщение Postgres (launchTemplate:153,176)
    // и тело ответа API рассыльщика (:346). Наружу — константа + код причины,
    // настоящий текст уходит в application_logs.
    if (outcome.status >= 500 && typeof outcome.body.error === 'string') {
      return engServerError('client.eng.template.launch_failed', new Error(outcome.body.error), LAUNCH_FAILED, {
        userId,
        templateId: id,
        status: outcome.status,
      });
    }

    // 4xx — это продуктовые причины ядра (нет валидных адресов, лимит лидов,
    // уже запущено): они по-английски и предназначены клиенту. White-label:
    // в тексте всё же может проскочить бренд рассыльщика — скрабим.
    const responseBody = { ...outcome.body };
    if (typeof responseBody.error === 'string') {
      responseBody.error = scrubBrand(responseBody.error);
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
      responseBody.warnings = toClientLaunchWarnings(responseBody.warnings);
    }

    return NextResponse.json(responseBody, { status: outcome.status });
  });
}
