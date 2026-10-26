/**
 * Выключатели Движка → «Рассылка» (этап 6): кнопки панели над списком
 * проектов Движка. Только admin; состояние для всех сотрудников отдаёт
 * GET /api/tools/vertical-engine-v2/sender-switches.
 *
 * POST { action, market?, enabled?, include_missed?, pause_id?, note? }:
 *   - stop_launches { market }      — новые запуски рынка только в Instantly
 *                                      (что было — запоминается);
 *   - restore_launches { market }   — вернуть, как было до stop_launches;
 *   - allow_choice { market: 'ru' }  — этап 7: специалисты РФ выбирают при
 *                                      запуске Instantly или «Рассылку» (по
 *                                      умолчанию Instantly); США — 400;
 *   - forbid_choice { market: 'ru' } — снять выбор (конец пилота): только
 *                                      Instantly, ничего не запоминается;
 *   - set_uploads { market, enabled } — подача контактов в «Рассылку»;
 *   - stop_sending                  — флаг + пауза идущих кампаний Движка и
 *                                      снятие назначенных запусков (повтор —
 *                                      пауза ещё раз, кто/когда не меняются);
 *   - resume_sending                — разрешить отправку и запустить то, что
 *                                      остановил выключатель (бюджет 45 с,
 *                                      остаток — повторным нажатием);
 *   - keep_paused { pause_id }      — эту остановку «Продолжить» не тронет;
 *   - set_lead_cards { enabled, include_missed? } — карточки лидов; при
 *                                      включении можно прислать пропущенных.
 * note — заметка к действию (до 300 символов), пишется в строку настроек.
 * Ответ: { lines, state } — отчёт строками и свежее состояние панели.
 * Кто/когда — в строках настроек; журнал — logAudit('admin.ve2_sender.<action>').
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, requireAdminAuth } from '@/lib/adminApiHelper';
import { isValidUuid } from '@/lib/apiValidation';
import { logAudit, logError } from '@/lib/loggerServer';
import { SenderOpError } from '@/lib/sender/campaignOps';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  allowVeLaunchChoice,
  cleanVeSenderNote,
  forbidVeLaunchChoice,
  keepVeCampaignPaused,
  readVeSenderSwitchState,
  restoreVeLaunches,
  resumeVeSenderSending,
  setProjectLeadCards,
  setVeSenderUploads,
  stopVeLaunches,
  stopVeSenderSending,
  VE_SENDER_NOTE_MAX,
  type VeSenderMarket,
  type VeSenderSwitchResult,
} from '@/lib/verticalEngineV2/senderTransport/switches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const RESUME_BUDGET_MS = 45_000;
const MARKET_LABELS: Record<VeSenderMarket, string> = { ru: 'РФ', us: 'США' };

type ParsedAction =
  | { action: 'stop_launches' | 'restore_launches' | 'allow_choice' | 'forbid_choice'; market: VeSenderMarket; note: string | null }
  | { action: 'set_uploads'; market: VeSenderMarket; enabled: boolean; note: string | null }
  | { action: 'stop_sending' | 'resume_sending'; note: string | null }
  | { action: 'keep_paused'; pauseId: string; note: string | null }
  | { action: 'set_lead_cards'; enabled: boolean; includeMissed: boolean; note: string | null };

const ACTIONS = new Set<ParsedAction['action']>([
  'stop_launches', 'restore_launches', 'allow_choice', 'forbid_choice', 'set_uploads', 'stop_sending', 'resume_sending', 'keep_paused',
  'set_lead_cards',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Тело запроса → действие; строка — текст отказа 400. */
function parseAction(raw: unknown): ParsedAction | string {
  if (!isPlainObject(raw)) return 'Неверный запрос: нужен объект с полем action';
  const action = raw.action;
  if (typeof action !== 'string' || !ACTIONS.has(action as ParsedAction['action'])) return 'Неизвестное действие';
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string') return 'Заметка должна быть текстом';
  if (typeof raw.note === 'string' && raw.note.trim().length > VE_SENDER_NOTE_MAX) {
    return `Заметка длиннее ${VE_SENDER_NOTE_MAX} символов`;
  }
  const note = cleanVeSenderNote(raw.note);
  const market = (): VeSenderMarket | string => (raw.market === 'ru' || raw.market === 'us' ? raw.market : 'Рынок — ru или us');
  const enabled = (): boolean | string => (typeof raw.enabled === 'boolean' ? raw.enabled : 'Нужно поле enabled: true или false');

  switch (action as ParsedAction['action']) {
    case 'stop_launches':
    case 'restore_launches': {
      const m = market();
      if (m !== 'ru' && m !== 'us') return m;
      return { action: action as 'stop_launches' | 'restore_launches', market: m, note };
    }
    case 'allow_choice':
    case 'forbid_choice': {
      const m = market();
      if (m !== 'ru' && m !== 'us') return m;
      // США — только Instantly: выбора «Рассылки» там нет ни включить, ни снять.
      if (m !== 'ru') return 'Для США — только Instantly';
      return { action: action as 'allow_choice' | 'forbid_choice', market: m, note };
    }
    case 'set_uploads': {
      const m = market();
      if (m !== 'ru' && m !== 'us') return m;
      const on = enabled();
      if (typeof on !== 'boolean') return on;
      return { action: 'set_uploads', market: m, enabled: on, note };
    }
    case 'stop_sending':
    case 'resume_sending':
      return { action: action as 'stop_sending' | 'resume_sending', note };
    case 'keep_paused': {
      if (typeof raw.pause_id !== 'string' || !isValidUuid(raw.pause_id)) return 'Нужно поле pause_id — id остановки';
      return { action: 'keep_paused', pauseId: raw.pause_id, note };
    }
    case 'set_lead_cards': {
      const on = enabled();
      if (typeof on !== 'boolean') return on;
      if (raw.include_missed !== undefined && typeof raw.include_missed !== 'boolean') {
        return 'Поле include_missed — true или false';
      }
      const includeMissed = raw.include_missed === true;
      if (includeMissed && !on) return 'Прислать пропущенных лидов можно только при включении карточек';
      return { action: 'set_lead_cards', enabled: on, includeMissed, note };
    }
    default:
      return 'Неизвестное действие';
  }
}

/** Короткий текст записи журнала. */
function auditMessage(input: ParsedAction, changed: boolean): string {
  const again = changed ? '' : ' (без изменений)';
  switch (input.action) {
    case 'stop_launches':
      return `Новые запуски ${MARKET_LABELS[input.market]} — только Instantly${again}`;
    case 'restore_launches':
      return `Новые запуски ${MARKET_LABELS[input.market]} — как было до выключения${again}`;
    case 'allow_choice':
      return `Выбор «Рассылки» при запуске ${MARKET_LABELS[input.market]} разрешён${again}`;
    case 'forbid_choice':
      return `Выбор «Рассылки» при запуске ${MARKET_LABELS[input.market]} запрещён${again}`;
    case 'set_uploads':
      return `Подача контактов в «Рассылку» ${MARKET_LABELS[input.market]} ${input.enabled ? 'включена' : 'выключена'}${again}`;
    case 'stop_sending':
      return `Отправка кампаний Движка остановлена${changed ? '' : ' (повтор)'}`;
    case 'resume_sending':
      return 'Отправка кампаний Движка продолжена';
    case 'keep_paused':
      return `Кампания Движка оставлена на паузе${again}`;
    case 'set_lead_cards':
      return input.enabled
        ? `Карточки лидов включены${input.includeMissed ? ' с пропущенными' : ''}${again}`
        : `Карточки лидов выключены${again}`;
  }
}

function auditFields(input: ParsedAction): Record<string, unknown> {
  return {
    ...('market' in input ? { market: input.market } : {}),
    ...('enabled' in input ? { enabled: input.enabled } : {}),
    ...('includeMissed' in input ? { include_missed: input.includeMissed } : {}),
    ...('pauseId' in input ? { pause_id: input.pauseId } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

type ActionOutcome = VeSenderSwitchResult & { extra?: Record<string, unknown> };

async function runAction(db: SupabaseClient, input: ParsedAction, userId: string): Promise<ActionOutcome> {
  switch (input.action) {
    case 'stop_launches':
      return stopVeLaunches(db, { market: input.market, userId, note: input.note });
    case 'restore_launches':
      return restoreVeLaunches(db, { market: input.market, userId, note: input.note });
    case 'allow_choice':
      return allowVeLaunchChoice(db, { market: input.market, userId, note: input.note });
    case 'forbid_choice':
      return forbidVeLaunchChoice(db, { market: input.market, userId, note: input.note });
    case 'set_uploads':
      return setVeSenderUploads(db, { market: input.market, enabled: input.enabled, userId, note: input.note });
    case 'stop_sending': {
      const result = await stopVeSenderSending(db, { userId, note: input.note });
      return { changed: result.changed, lines: result.lines, extra: { still_running: result.still_running } };
    }
    case 'resume_sending': {
      const report = await resumeVeSenderSending(db, supabaseInstantly, { userId, note: input.note, budgetMs: RESUME_BUDGET_MS });
      return {
        changed: report.changed,
        lines: report.lines,
        extra: {
          resumed: report.resumed,
          rescheduled: report.rescheduled,
          left_open: report.left_open,
          stopped_again: report.stopped_again,
          // Сырые ошибки — только в журнал, на панель не идут.
          ...(report.diagnostics.length ? { diagnostics: report.diagnostics.slice(0, 20).map((line) => line.slice(0, 500)) } : {}),
        },
      };
    }
    case 'keep_paused':
      return keepVeCampaignPaused(db, { pauseId: input.pauseId, userId });
    case 'set_lead_cards':
      return setProjectLeadCards(db, { enabled: input.enabled, includeMissed: input.includeMissed, userId, note: input.note });
  }
}

/**
 * Текст отказа библиотеки для панели. 4xx — человеческие тексты как есть; в 5xx
 * библиотека дописывает сырую ошибку базы после «: » — на панель только
 * человеческая часть, целиком — в logError.
 */
function refusalText(error: SenderOpError): string {
  if (error.status < 500) return error.message;
  const cut = error.message.indexOf(': ');
  return cut > 0 ? `${error.message.slice(0, cut)} — повторите` : 'Не удалось — повторите';
}

/** Строки отчёта для панели: строки с сырой причиной сбоя («Причина: …») — только в журнал. */
function panelLines(lines: string[]): string[] {
  return lines.filter((line) => !line.startsWith('Причина:'));
}

/** Свежее состояние для ответа; не прочиталось целиком — без него (панель перечитает сама). */
async function freshState(db: SupabaseClient) {
  try {
    return { state: await readVeSenderSwitchState(db, process.env) };
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  const authed = await requireAdminAuth(req);
  if ('error' in authed) return authed.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const db = supabaseAdmin;
  const userId = authed.auth.user.id;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError('Неверный запрос: нужен JSON', 400);
  }
  const input = parseAction(raw);
  if (typeof input === 'string') return jsonError(input, 400);

  let outcome: ActionOutcome;
  try {
    outcome = await runAction(db, input, userId);
  } catch (error) {
    if (error instanceof SenderOpError) {
      if (error.status >= 500) {
        void logError(`admin.ve2_sender.${input.action}.failed`, error, auditFields(input), { userId });
      }
      return NextResponse.json({ error: refusalText(error), ...(await freshState(db)) }, { status: error.status });
    }
    void logError(`admin.ve2_sender.${input.action}.failed`, error, auditFields(input), { userId });
    return NextResponse.json({ error: 'Не удалось — повторите', ...(await freshState(db)) }, { status: 500 });
  }

  await logAudit(`admin.ve2_sender.${input.action}`, auditMessage(input, outcome.changed), {
    ...auditFields(input),
    changed: outcome.changed,
    lines: outcome.lines.slice(0, 20).map((line) => line.slice(0, 500)),
    ...(outcome.extra ?? {}),
  }, { userId });

  return NextResponse.json({ lines: panelLines(outcome.lines), ...(await freshState(db)) });
}
