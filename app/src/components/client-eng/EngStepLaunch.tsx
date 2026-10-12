'use client';

/**
 * Шаг 3 «Launch» клиентского ENG-кабинета — ОДНА кнопка и дальше прогресс.
 *
 * До нажатия: какие рынки запускаются («Change» — на шаг 2), часы отправки
 * (редактор SendingWindowEditor; пояс браузера, если он есть в списке
 * сервера, иначе дефолт сервера), что произойдёт дальше и строка про доступ к
 * отправке (GET /api/client/eng/projects/[id]/launch). «Launch» —
 * POST .../launch {schedule}: записывает желание «запускай сам» и ставит
 * работу тем же реконсилером, что прежняя кнопка автопилота (письма → сборка →
 * анализ → итоговые письма), а готовый рынок запускает автозапуск воркера тем
 * же путём, что кнопка «Launch now» (runHeEngTemplateLaunch: все гейты).
 *
 * После нажатия: по каждому рынку — строка прогресса (Letters · Contacts ·
 * Checked · Final letters · Sending), одна строка состояния и кнопки, которые
 * это состояние требует: «Launch now», «Rewrite letters», «Collect again»,
 * «Resume daily top-up», ссылка Support. У запущенного рынка — блок отправки
 * S2 (статус, отправлено/ответы, Pause / Resume / Start the rest), «Sending
 * hours» и «Preview letters». Итоговые письма можно открыть, как только они
 * написаны; ничего их не ждёт.
 *
 * Состояние рынка (по старшинству): запись о запуске → блок отправки; иначе
 * строка автозапуска (`auto_launch.markets` деталки); иначе стадия подготовки.
 * Автозапуск выключен (не нажат «Launch», отменён «Cancel all jobs», таблиц
 * нет) — у готового рынка «Launch now», и экран не обещает, что рынок
 * запустится сам.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, CircleDashed, Mail, Pencil, Rocket, RotateCcw, Wand2, X } from 'lucide-react';
import type { HeHypothesis, HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { heLaunchIsIncomplete, parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
// Тот же предикат «кнопка поставит анализ заново», что у Command Center
// (чистая функция без серверных зависимостей).
import { engAnalysisRequeues } from '@/lib/hypothesisEngine/engDashboard';
import { heEngMarketStarted, heEngSelectedVerticalIds } from '@/lib/hypothesisEngine/engMarkets';
import {
  EngLaunchServerError,
  EngPaidAccessError,
  collectEngBase,
  engTemplateNeedsRewrite,
  fetchEngProjectLaunch,
  fetchEngTemplateRewriteTries,
  launchEngProject,
  launchEngTemplate,
  rewriteEngTemplateLetters,
  updateEngProjectLaunchSchedule,
  type EngAutoLaunchMarket,
  type EngBaseSummary,
  type EngProjectLaunchInfo,
  type EngProjectLaunchResponse,
  type EngSendingAccessState,
  type EngSendingWindow,
  type EngSendingWindowTimezoneOption,
  type HeChainDto,
  type HeJobSummary,
} from './api-client';
import {
  ENG_NO_REASON_BASE_HEAD_EN,
  engAutopilotHoldText,
  engChainDraftText,
  engEarlierBaseStopText,
  engLaunchSendingText,
  engStageErrorText,
  engTemplateNeedsRewriteText,
} from './engText';
import { EngPaidAccessNotice, EngResendLinkControls, EngSupportText } from './EngPaidAccess';
import { EngSendingBlock } from './EngSending';
import {
  AutopilotDecisions,
  CollectProgress,
  SendVolume,
  analysisCancelled,
  collectAgainBaseId,
  ownAutoBaseState,
  stopTextOffersRestart,
} from './EngStepBases';
import { ChainEditor } from './EngStepLetters';
import {
  BasePreview,
  FinalLetters,
  LaunchedSendingWindow,
  SendingWindowEditor,
  isSendingWindowUsable,
  sendingWindowSummary,
  type FinalLettersState,
  type SendingWindowConfig,
} from './EngStepReview';
import { EngRefillPauseNote } from './EngStepVerticals';
import { EngBadge, EngCard, EngEyebrow, EngSpinner, engBaseAnalysisStopped, fmtDate } from './ui';
import type { EngDetail } from './EngProjectWizard';

/**
 * Через сколько готовый рынок, который автозапуск ещё не взял, получает «Starting
 * is taking longer than usual» и «Launch now». Копия HE_ENG_AUTO_LAUNCH_STALE_MS
 * (engAutoLaunch.ts — серверный модуль, в бандл кабинета не едет).
 */
const ENG_AUTO_LAUNCH_STALE_MS = 20 * 60_000;

/** Коды «эта попытка не вышла, автозапуск попробует снова в next_at». */
const AUTO_RETRY_CODES: ReadonlySet<string> = new Set([
  'server_error',
  'launch_failed',
  'retry_limited',
  'unfinished',
  'start_retry',
]);

/**
 * Коды повтора, при которых «Launch now» прямо сейчас имеет смысл. Не
 * 'retry_limited': до next_at нажатие откажет тот же счётчик неудачных
 * запусков, а в next_at тик повторит сам.
 */
const AUTO_RETRY_LAUNCH_NOW_CODES: ReadonlySet<string> = new Set(['server_error']);

/* ── Пояс браузера в списке сервера ── */

/** Смещение пояса от UTC в минутах на момент `at`; null — пояс не читается. */
function tzOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return Number.isFinite(asUtc) ? Math.round((asUtc - at.getTime()) / 60_000) : null;
  } catch {
    return null;
  }
}

/**
 * Пояс браузера клиента — если он есть в списке сервера: тот же идентификатор
 * или пояс списка с теми же часами и зимой, и летом (America/New_York →
 * America/Detroit). Не нашёлся — null, и редактор открывается с дефолтом
 * сервера.
 */
function browserTimezoneIn(options: readonly EngSendingWindowTimezoneOption[]): string | null {
  let own = '';
  try {
    own = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return null;
  }
  if (!own) return null;
  if (options.some((o) => o.value === own)) return own;
  const year = new Date().getUTCFullYear();
  const probes = [new Date(Date.UTC(year, 0, 15, 12)), new Date(Date.UTC(year, 6, 15, 12))];
  const mine = probes.map((d) => tzOffsetMinutes(own, d));
  if (mine.some((m) => m === null)) return null;
  return options.find((o) => probes.every((d, i) => tzOffsetMinutes(o.value, d) === mine[i]))?.value ?? null;
}

/* ── Тексты ── */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** «A, B and C». */
function namesList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Типичное время подготовки рынка: < 1 часа — минутами, иначе часами. */
function prepareTimeText(hours: number): string {
  if (hours < 1) return `about ${Math.max(5, Math.round((hours * 60) / 5) * 5)} minutes`;
  const rounded = Math.round(hours * 2) / 2;
  return `about ${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/** Строка про выключатель отправки аккаунта; null — сказать нечего. */
function accessLine(access: EngSendingAccessState | undefined): { text: string; blocks: boolean } | null {
  switch (access) {
    case 'not_enabled':
      return {
        text: 'Sending starts after a one-time check of your account by our team. We’ll email you when it’s on.',
        blocks: false,
      };
    case 'revoked':
      return { text: 'Sending is turned off for your account, so nothing can be launched. Message Support.', blocks: true };
    default:
      return null;
  }
}

/** Итог «Launch» проекта одной-двумя фразами. */
function launchResultText(res: EngProjectLaunchResponse): { text: string; held: boolean } {
  const parts: string[] = [];
  if (res.chains_enqueued) parts.push(`letters for ${plural(res.chains_enqueued, 'market', 'markets')}`);
  if (res.collects_enqueued) parts.push(`collecting contacts for ${plural(res.collects_enqueued, 'market', 'markets')}`);
  if (res.analyses_requeued) parts.push(`checking contacts for ${plural(res.analyses_requeued, 'market', 'markets')}`);
  if (res.templates_enqueued) parts.push(`final letters for ${plural(res.templates_enqueued, 'market', 'markets')}`);
  const again = res.collect_again_verticals ?? 0;
  const againNote =
    again === 0
      ? ''
      : ` ${again === 1 ? '1 market was' : `${again} markets were`} not collected again: ${
          again === 1 ? 'its latest collection' : 'the latest collection of each'
        } stopped for a reason a new collection would most likely repeat. ${
          again === 1 ? 'Its card' : 'Their cards'
        } below show${again === 1 ? 's' : ''} why and offer${again === 1 ? 's' : ''} «Collect again».`;
  // Пауза, которую записало ЭТО нажатие (реконсилер, режим client), — её
  // фразой прямо здесь: карточку паузы над шагами мастер прячет, пока у
  // проекта идут джобы, а после нажатия они обычно идут.
  const holdCode = res.autopilot_hold_code;
  const held = parts.length === 0 && Boolean(holdCode);
  const holdNote = !holdCode
    ? ''
    : holdCode === 'spend_paused'
      ? parts.length > 0
        ? ' Work on this project is now paused on our side, so nothing else was started; our team has been notified.'
        : ` ${engAutopilotHoldText(holdCode)}`
      : ` ${parts.length > 0 ? 'Not everything could be started. ' : ''}${engAutopilotHoldText(holdCode)}`;
  const head =
    parts.length > 0
      ? `Started: ${parts.join(' · ')}.${holdNote}`
      : held
        ? holdCode === 'spend_paused'
          ? holdNote.trim()
          : `Nothing new was started.${holdNote}`
        : 'Nothing new was started — everything «Launch» can start is already in progress or done; each market’s card below says what it is waiting for.';
  // Обещание письма — ровно то, что шлёт engClientMail при включённом
  // автозапуске: старт отправки (и ожидание проверки аккаунта) и остановки,
  // которым нужен клиент (стадии, сборка, пауза, письма на переписку, старт
  // не удался); паузы, которые снимаются сами или командой, писем не шлют.
  const tail =
    res.auto_launch === 'on'
      ? res.sending_access === 'not_enabled'
        ? ' Each market starts sending by itself once its final letters are ready and our team has finished the one-time check of your account. We’ll email you when sending starts, or if something stops and needs you.'
        : ' Each market starts sending by itself once its final letters are ready. We’ll email you when sending starts, or if something stops and needs you.'
      : ' Automatic sending is not available right now, so when a market is ready, press «Launch now» on it to start sending.';
  return { text: `${head}${againNote}${tail}`, held: held || Boolean(holdCode) || (parts.length === 0 && again > 0) };
}

/* ── Рынок: что с ним сейчас ── */

type DotState = 'done' | 'current' | 'waiting' | 'stopped';

interface MarketView {
  vertical: HeVertical;
  selected: boolean;
  chain: HeChainDto | undefined;
  chainJob: boolean;
  /** Последняя джоба писем рынка упала или отменена, а готовых писем нет. */
  chainStopped: boolean;
  ownBases: EngBaseSummary[];
  /** База, по которой идёт или идёт запуск: база шаблона, иначе последняя своя авто-база. */
  base: EngBaseSummary | null;
  template: HeTemplate | undefined;
  templateJob: boolean;
  /** Снятые «Rewrite letters» письма без замены (engRetiredTemplateOf); только без `template` и без идущей генерации. */
  retired: HeTemplate | undefined;
  launch: ReturnType<typeof parseLaunchInfo>;
  row: EngAutoLaunchMarket | null;
}

function payloadOf(job: HeJobSummary): { vertical_id?: string; base_id?: string } {
  const raw = job.payload as unknown;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { vertical_id?: string; base_id?: string }) : {};
}

const isLive = (job: HeJobSummary) => job.status === 'pending' || job.status === 'running';

/**
 * Шаблон рынка: с записью о запуске (одна кампания на рынок), иначе самый
 * новый готовый. Шаблон, который «Rewrite letters» снял ('failed'), и
 * недописанный рынку не показываются: его письма не уйдут никогда.
 */
function marketTemplate(templates: HeTemplate[]): HeTemplate | undefined {
  return (
    templates.find((t) => parseLaunchInfo((t as { launch_info?: unknown }).launch_info) !== null) ??
    templates.find((t) => t.status === 'ready')
  );
}

/**
 * Письма рынка, которые «Rewrite letters» снял, а новые так и не появились:
 * у рынка нет ни запущенного, ни готового шаблона, и самый новый его шаблон —
 * 'failed' (этот статус у he_templates пишет только роут переписки). Реконсилер
 * «Launch» считает такой рынок «шаблон есть» и новых писем не ставит, поэтому
 * путь вперёд один — «Rewrite letters» на этом снятом шаблоне (роут его
 * принимает в пределах бюджета попыток) или Support. Идёт ли генерация по
 * рынку, проверяет вызывающий: пока идёт, рынок не «снят», а «пишется».
 */
export function engRetiredTemplateOf<T extends { status?: unknown; created_at?: unknown; launch_info?: unknown }>(
  templates: readonly T[],
): T | undefined {
  if (templates.some((t) => t.status === 'ready' || parseLaunchInfo(t.launch_info) !== null)) return undefined;
  const at = (t: T) => {
    const ms = typeof t.created_at === 'string' ? Date.parse(t.created_at) : Number.NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  const newest = [...templates].sort((a, b) => at(b) - at(a))[0];
  return newest !== undefined && newest.status === 'failed' ? newest : undefined;
}

function buildMarketView(detail: EngDetail, vertical: HeVertical, selected: boolean): MarketView {
  const jobs = (detail.jobs ?? []) as HeJobSummary[];
  const chains = (detail.chains ?? []) as HeChainDto[];
  const bases = (detail.bases ?? []) as EngBaseSummary[];
  const ownBases = bases.filter((b) => b.vertical_id === vertical.id);
  const baseIds = new Set(ownBases.map((b) => b.id));
  const templates = ((detail.templates ?? []) as HeTemplate[]).filter((t) => t.vertical_id === vertical.id);
  const template = marketTemplate(templates);
  const launch = template ? parseLaunchInfo((template as { launch_info?: unknown }).launch_info) : null;
  const latestChainJob = jobs.find((j) => j.stage === 'chain' && payloadOf(j).vertical_id === vertical.id);
  const chain = chains.find((c) => c.vertical_id === vertical.id && c.status === 'ready');
  const templateJob = jobs.some((j) => {
    if (j.stage !== 'template' || !isLive(j)) return false;
    const p = payloadOf(j);
    return p.vertical_id === vertical.id || (typeof p.base_id === 'string' && baseIds.has(p.base_id));
  });
  const retired = !template && !templateJob ? engRetiredTemplateOf(templates) : undefined;
  const shown = template ?? retired;
  const base =
    (shown ? (bases.find((b) => b.id === shown.base_id) ?? null) : null) ?? ownAutoBaseState(ownBases).latest;
  const row = template
    ? ((detail.auto_launch?.markets ?? []).find((m) => m.template_id === template.id) ?? null)
    : null;
  return {
    vertical,
    selected,
    chain,
    chainJob: latestChainJob !== undefined && isLive(latestChainJob),
    chainStopped: !chain && latestChainJob !== undefined && (latestChainJob.status === 'failed' || latestChainJob.status === 'cancelled'),
    ownBases,
    base,
    template,
    templateJob,
    retired,
    launch,
    row,
  };
}

/** Пять точек прогресса рынка. */
function marketDots(view: MarketView): Array<{ label: string; state: DotState }> {
  const { base, template, launch, row } = view;
  const construct = base?.collect_info?.construct;
  const constructStarted = construct !== undefined && construct !== null;
  const analysisStopped = base ? engBaseAnalysisStopped(base) : false;
  const letters: DotState = view.chain || template ? 'done' : view.chainJob ? 'current' : view.chainStopped ? 'stopped' : 'waiting';
  const contacts: DotState =
    template || base?.status === 'analyzing' || base?.status === 'analyzed' || (base?.status === 'collecting' && constructStarted)
      ? 'done'
      : base?.status === 'collecting'
        ? 'current'
        : base?.status === 'failed' && !constructStarted
          ? 'stopped'
          : 'waiting';
  const checked: DotState =
    template || base?.status === 'analyzed'
      ? 'done'
      : analysisStopped || (base?.status === 'failed' && constructStarted)
        ? 'stopped'
        : (base?.status === 'collecting' && constructStarted) || base?.status === 'analyzing'
          ? 'current'
          : 'waiting';
  const finalLetters: DotState = template ? 'done' : view.templateJob ? 'current' : view.retired ? 'stopped' : 'waiting';
  const sending: DotState = launch
    ? heLaunchIsIncomplete(launch)
      ? 'current'
      : 'done'
    : row?.state === 'running' && row.stale !== true
      ? 'current'
      : row?.state === 'failed'
        ? 'stopped'
        : 'waiting';
  return [
    { label: 'Letters', state: letters },
    { label: 'Contacts', state: contacts },
    { label: 'Checked', state: checked },
    { label: 'Final letters', state: finalLetters },
    { label: 'Sending', state: sending },
  ];
}

function ProgressDots({ dots }: { dots: Array<{ label: string; state: DotState }> }) {
  return (
    <ol className="m-0 mt-2 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0" aria-label="Progress">
      {dots.map((dot) => (
        <li key={dot.label} className="inline-flex items-center gap-1 text-[11px]">
          {dot.state === 'done' ? (
            <Check className="h-3 w-3" style={{ color: 'var(--cp-green)' }} aria-hidden />
          ) : dot.state === 'current' ? (
            <EngSpinner className="h-3 w-3" />
          ) : dot.state === 'stopped' ? (
            <X className="h-3 w-3" style={{ color: 'var(--cp-amber)' }} aria-hidden />
          ) : (
            <CircleDashed className="h-3 w-3" style={{ color: 'var(--cp-text-l)' }} aria-hidden />
          )}
          <span
            style={{
              color:
                dot.state === 'waiting'
                  ? 'var(--cp-text-l)'
                  : dot.state === 'stopped'
                    ? 'var(--cp-amber)'
                    : 'var(--cp-paper-mute)',
            }}
          >
            {dot.label}
            <span className="sr-only">
              {dot.state === 'done' ? ' (done)' : dot.state === 'current' ? ' (in progress)' : dot.state === 'stopped' ? ' (stopped)' : ' (not yet)'}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** «we’ll try again at …» — время следующей попытки, если оно в будущем. */
function nextTryText(nextAt: string | null): string {
  const at = nextAt ? Date.parse(nextAt) : Number.NaN;
  return Number.isFinite(at) && at > Date.now() ? `at ${fmtDate(nextAt)}` : 'shortly';
}

type MarketAction = 'launch_now' | 'rewrite' | 'resend';

interface MarketLine {
  text: string;
  tone: 'muted' | 'amber' | 'red' | 'green';
  spinner?: boolean;
  actions: MarketAction[];
}

/**
 * Строка автозапуска готового рынка (запуска ещё нет или он не закончен) — по
 * строке `auto_launch` деталки; null — строке сказать нечего.
 */
function autoLaunchLine(
  row: EngAutoLaunchMarket,
  launched: boolean,
  access: EngSendingAccessState | undefined,
): MarketLine | null {
  const code = row.code;
  switch (row.state) {
    case 'running':
      // Аренду никто не держит (`stale`: попытка брошена — процесс умер): без
      // автозапуска строку не возьмёт никто, и вечный спиннер был бы тупиком.
      // «Launch now» берёт такую строку; идущую — отказывает «being launched
      // right now».
      if (row.stale === true) {
        return launched
          ? {
              text: 'Part of this market’s audience has not gone out yet. Press «Launch now» to finish it — the campaigns already created are reused, only the addresses that have not gone out are added, and nobody is contacted twice.',
              tone: 'amber',
              actions: ['launch_now'],
            }
          : {
              text: 'Starting this market has not finished. Press «Launch now» to try again; if it does not start, message Support.',
              tone: 'amber',
              actions: ['launch_now'],
            };
      }
      return { text: launched ? 'Finishing the launch…' : 'Starting sending…', tone: 'muted', spinner: true, actions: [] };
    case 'waiting': {
      // До первой попытки автозапуска строка ещё «waiting», а выключатель
      // отправки аккаунта уже известен: обещать «скоро» при нём нельзя.
      // `launched` — запуск не закончен (синтетическая строка кандидата —
      // его шаблон): «Ready» про рынок, часть которого уже в кампаниях,
      // неправда.
      if (code === null && access === 'not_enabled') {
        return {
          text: launched
            ? 'Part of this market’s audience has not gone out yet; the rest is added after a one-time check of your account by our team — we’ll email you when it’s on.'
            : 'Ready. Sending starts after a one-time check of your account by our team — we’ll email you when it’s on.',
          tone: 'muted',
          actions: [],
        };
      }
      if (code === null && access === 'revoked') {
        return { text: 'Sending is turned off for your account. Message Support.', tone: 'red', actions: [] };
      }
      if (code === 'unfinished') {
        // «Launch now» остаётся: замок шаблона (he_eng_auto_launch_claim) не
        // даст ему и тику достраивать одновременно, а заметки ядра у
        // недостроенного запуска сами зовут нажать её ещё раз.
        return {
          text: `Part of this market’s audience has not gone out yet — we’ll try to finish it ${nextTryText(row.next_at)}, or press «Launch now» to finish it now. Nobody is contacted twice.`,
          tone: 'muted',
          actions: ['launch_now'],
        };
      }
      if (code === null) {
        const age = Date.now() - Date.parse(row.created_at);
        const stale = Number.isFinite(age) && age > ENG_AUTO_LAUNCH_STALE_MS;
        if (launched) {
          // Тик берёт незаконченный запуск кандидатом (heEngAutoLaunchCandidates)
          // и достраивает только недоставленных; у синтетической строки дата —
          // шаблона, поэтому она почти всегда «давняя», и кнопка стоит.
          return stale
            ? {
                text: 'Part of this market’s audience has not gone out yet — we finish it automatically shortly, or press «Launch now» to finish it now. Nobody is contacted twice.',
                tone: 'amber',
                actions: ['launch_now'],
              }
            : {
                text: 'Part of this market’s audience has not gone out yet — we finish it automatically shortly. Nobody is contacted twice.',
                tone: 'muted',
                actions: [],
              };
        }
        return stale
          ? {
              text: 'Ready — sending starts automatically shortly. Starting is taking longer than usual; you can press «Launch now» to start it yourself.',
              tone: 'amber',
              actions: ['launch_now'],
            }
          : { text: 'Ready — sending starts automatically shortly.', tone: 'green', actions: [] };
      }
      if (code === 'launch_running') {
        return {
          text: `Another start of this market is in progress — we’ll check it again ${nextTryText(row.next_at)}.`,
          tone: 'muted',
          actions: [],
        };
      }
      if (AUTO_RETRY_CODES.has(code)) {
        return {
          text: `Starting did not work on this try — we’ll try again ${nextTryText(row.next_at)}.`,
          tone: 'amber',
          actions: AUTO_RETRY_LAUNCH_NOW_CODES.has(code) ? ['launch_now'] : [],
        };
      }
      return {
        text: launched
          ? `Part of this market’s audience has not gone out yet — we’ll try to finish it ${nextTryText(row.next_at)}.`
          : `Ready — we’ll try to start sending ${nextTryText(row.next_at)}.`,
        tone: 'muted',
        actions: [],
      };
    }
    case 'held':
      switch (code) {
        case 'sending_not_enabled':
          return {
            text: 'Ready. Sending starts after a one-time check of your account by our team — we’ll email you when it’s on.',
            tone: 'muted',
            actions: [],
          };
        case 'sending_turned_off':
          return { text: 'Sending is turned off for your account. Message Support.', tone: 'red', actions: [] };
        case 'email_not_verified':
          return { text: 'Ready. Sending starts once you confirm your email.', tone: 'amber', actions: ['resend'] };
        case 'spend_limit':
          return {
            text: 'Sending for this market is on hold: your account has reached its usage limit. Contact Support to raise the limit.',
            tone: 'amber',
            actions: [],
          };
        case 'spend_day_limit':
          return {
            text: 'Sending for this market is on hold: your account has reached its usage limit for the last 24 hours. We try again by ourselves, or contact Support to raise the limit.',
            tone: 'amber',
            actions: [],
          };
        case 'unavailable':
          // Код пишут два отказа общего вызова запуска: гейт платных шагов
          // (не прочитались почта или потолки аккаунта) и окно запуска
          // (heEngLaunchWindowPlan: не прочитались запись о запуске или часы
          // рынка) — поэтому без «your account».
          return {
            text: `Ready. We could not finish our checks just now — we’ll try again ${nextTryText(row.next_at)}.`,
            tone: 'muted',
            actions: [],
          };
        case 'setup_unavailable':
        case 'mailboxes_short':
          return {
            text: 'We’re preparing sending for your account; it starts by itself when ready. Our team has been notified.',
            tone: 'muted',
            actions: [],
          };
        case 'research_running':
          return { text: 'Waiting for the research to finish.', tone: 'muted', actions: [] };
        case 'letters_need_rewrite':
          // Пишет карточка своей веткой (признак `needs_rewrite`) — с кнопкой.
          return null;
        default:
          return {
            text: 'Sending could not start for this market. Nothing was sent. Press «Launch now» to see the reason, or message Support.',
            tone: 'amber',
            actions: ['launch_now'],
          };
      }
    case 'failed':
      return {
        text: 'We could not start this market after several tries. Nothing was sent. Press «Launch now» to try once more; if it does not start, message Support.',
        tone: 'red',
        actions: ['launch_now'],
      };
    case 'done':
      return null;
  }
}

/**
 * Рынок, чьи письма «Rewrite letters» снял, а новые не написаны (генерация
 * упала, отменена или не встала): «Launch» здесь ничего не сдвинет (реконсилер
 * считает шаблон рынка существующим), поэтому — «Rewrite letters» на снятом
 * шаблоне, пока у аудитории есть попытки, и Support, когда их 0. «Nothing was
 * sent» — правда: роут переписки не снимает письма с записью о запуске и не
 * трогает рынок, у которого запущены другие письма.
 */
function retiredLine(
  tries: { left: number; max: number } | { error: true } | null,
): MarketLine {
  const head = 'New final letters for this market were not written, so nothing was sent from it.';
  if (tries && 'left' in tries && tries.left <= 0) {
    return {
      text: `${head} All ${tries.max} letter-writing tries for this audience are used — message Support to get new letters.`,
      tone: 'amber',
      actions: [],
    };
  }
  if (tries && 'left' in tries) {
    return {
      text: `${head} Press «Rewrite letters» to try again: ${tries.left} of ${tries.max} tries left for this audience, and a try that fails is retried automatically and uses another one.`,
      tone: 'amber',
      actions: ['rewrite'],
    };
  }
  return { text: `${head} Press «Rewrite letters» to try again.`, tone: 'amber', actions: ['rewrite'] };
}

/** Что сказать про рынок, у которого ещё нет итоговых писем. */
/**
 * Пауза по потолку расхода ('spend_paused', потолок по умолчанию выключен):
 * «Launch» тогда ничего платного не поставит (реконсилер встаёт на потолке), и
 * звать к нему нельзя. Фраза — сама по себе, без ссылки на записку паузы
 * вверху страницы: мастер прячет ту записку, пока у проекта идут джобы
 * (EngProjectWizard), а пауза при этом стоит. «Our team has been notified» —
 * та же правда, что у HE_SPEND_PAUSED_EN (пауза потолка шлёт алерт команде).
 */
const SPEND_PAUSED_NEXT = 'Work on this project is paused on our side; our team has been notified.';

function preparingLine(
  view: MarketView,
  ctx: { autopilotOn: boolean; researched: boolean; spendPaused: boolean },
): MarketLine | null {
  const { base } = view;
  if (view.templateJob) return { text: 'Writing the final letters…', tone: 'muted', spinner: true, actions: [] };
  if (base) {
    // Идущую сборку описывает её собственный прогресс (CollectProgress).
    if (base.status === 'collecting') return null;
    if (base.status === 'analyzing' && !engBaseAnalysisStopped(base)) {
      return { text: 'Checking the contacts…', tone: 'muted', spinner: true, actions: [] };
    }
    if (base.status === 'analyzed') {
      if (base.row_count <= 0) {
        return {
          text: 'The latest collection came back with no contacts, so there is nothing to send from it. Message Support.',
          tone: 'amber',
          actions: [],
        };
      }
      return {
        text: ctx.spendPaused
          ? `The contacts are ready, and the final letters have not been written yet. ${SPEND_PAUSED_NEXT}`
          : 'The contacts are ready, and the final letters have not been written yet. If nothing is running on this project, press «Launch» above to move it on; if that does not help, message Support.',
        tone: 'muted',
        actions: [],
      };
    }
    // 'failed' и остановленный анализ — своими ветками карточки (с кнопками).
    return null;
  }
  if (view.chainJob) return { text: 'Writing the letters…', tone: 'muted', spinner: true, actions: [] };
  if (view.chainStopped) {
    return {
      text: ctx.spendPaused
        ? `Writing the letters stopped before it finished. ${SPEND_PAUSED_NEXT}`
        : 'Writing the letters stopped before it finished. Press «Launch» above to try again; if it stops again, message Support.',
      tone: 'amber',
      actions: [],
    };
  }
  if (view.chain) {
    if (ctx.spendPaused) return { text: `The letters are written. ${SPEND_PAUSED_NEXT}`, tone: 'muted', actions: [] };
    return ctx.autopilotOn
      ? { text: 'The letters are written; collecting contacts comes next.', tone: 'muted', actions: [] }
      : { text: 'The letters are written. Press «Launch» above to collect contacts for this market.', tone: 'muted', actions: [] };
  }
  if (view.selected && ctx.researched) {
    return ctx.spendPaused
      ? { text: `Not started yet. ${SPEND_PAUSED_NEXT}`, tone: 'muted', actions: [] }
      : { text: 'Not started yet — press «Launch» above to start it.', tone: 'muted', actions: [] };
  }
  return null;
}

/* ── Карточка рынка ── */

function MarketCard({
  view,
  detail,
  autoOn,
  sendingAccess,
  launchSchedule,
  onChanged,
}: {
  view: MarketView;
  detail: EngDetail;
  /** Автозапуск этого проекта включён и доступен. */
  autoOn: boolean;
  /** Выключатель отправки аккаунта (GET .../launch); undefined — не прочитан. */
  sendingAccess: EngSendingAccessState | undefined;
  /**
   * Часы отправки для ПЕРВОГО «Launch now» рынка; undefined — сервер подставит
   * свои. Достройка (запись о запуске уже есть) их не шлёт: у запущенного
   * рынка часы свои — «Sending hours» на его карточке.
   */
  launchSchedule: EngSendingWindow | undefined;
  onChanged: () => void;
}) {
  const { vertical, template, launch, row, base, ownBases, retired } = view;
  const [busy, setBusy] = useState<'launch_now' | 'rewrite' | 'collect' | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);
  const [showLetters, setShowLetters] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  /**
   * Попытки писем аудитории снятого шаблона (GET …/rewrite — тот же бюджет,
   * что решает POST). null — ещё не прочитаны; error — не прочитались (кнопка
   * остаётся: бюджет всё равно проверит роут и откажет текстом с Support).
   * Читаются заново каждый раз, когда рынок снова оказывается «снят» (после
   * упавшей переписки — уже с меньшим остатком; до ответа виден прошлый
   * остаток, а не меньший).
   */
  const retiredId = retired?.id ?? null;
  const [tries, setTries] = useState<{ id: string; left: number; max: number } | { id: string; error: true } | null>(null);
  useEffect(() => {
    if (!retiredId) return;
    let cancelled = false;
    void (async () => {
      try {
        const t = await fetchEngTemplateRewriteTries(retiredId);
        if (cancelled) return;
        setTries(
          Number.isFinite(t?.tries_left) && Number.isFinite(t?.tries_max)
            ? { id: retiredId, left: t.tries_left, max: t.tries_max }
            : { id: retiredId, error: true },
        );
      } catch {
        if (!cancelled) setTries({ id: retiredId, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [retiredId]);
  const retiredTries = tries && tries.id === retiredId ? tries : null;
  /** Шаблон, который перепишет «Rewrite letters»: готовый с отказом гейта или снятый. */
  const rewriteTarget = template ?? retired;

  const researched = detail.project.status === 'researched';
  const incomplete = launch !== null && heLaunchIsIncomplete(launch);
  const needsRewrite =
    template !== undefined &&
    template.status === 'ready' &&
    (engTemplateNeedsRewrite(template) || row?.code === 'letters_need_rewrite');
  const dots = marketDots(view);

  // Строка состояния и кнопки — по старшинству: запуск → автозапуск → подготовка.
  let line: MarketLine | null = null;
  const extra: MarketLine[] = [];
  if (launch) {
    if (incomplete) {
      if (needsRewrite) {
        line = { text: engTemplateNeedsRewriteText('unfinished'), tone: 'amber', actions: [] };
      } else if (autoOn && row && (row.state === 'waiting' || row.state === 'running')) {
        line = autoLaunchLine(row, true, sendingAccess);
      } else if (row?.state === 'running') {
        line = autoLaunchLine(row, true, sendingAccess);
      } else {
        line = {
          text: 'Part of this market’s audience has not gone out yet. Press «Launch now» to finish it — the campaigns already created are reused, only the addresses that have not gone out are added, and nobody is contacted twice.',
          tone: 'amber',
          actions: ['launch_now'],
        };
      }
    } else if (autoOn && row?.state === 'waiting' && row.code === 'start_retry') {
      line = {
        text: `Sending did not start on this try — we’ll try again ${nextTryText(row.next_at)}.`,
        tone: 'amber',
        actions: [],
      };
    } else if (row?.state === 'done' && row.code === 'start_failed') {
      line = {
        text: 'Sending did not start after several tries — see the sending status above; if it does not start, message Support.',
        tone: 'amber',
        actions: [],
      };
    } else if (row?.state === 'done' && row.code === 'needs_support') {
      line = {
        // Строку 'done needs_support' пишет и кнопка «Launch now», не только
        // автозапуск, — поэтому без слова «automatic». «Start sending» блока
        // отправки здесь небезопасна (window_not_applied: кампании на прежних
        // часах) — сначала Support, как и письмо об этой строке.
        text: 'Starting this market ran into a problem. If the sending status above does not show it sending, message Support before pressing «Start sending».',
        tone: 'amber',
        actions: [],
      };
    } else if (row?.state === 'done' && row.code === 'cancelled') {
      // Тик создал кампании, а перед стартом увидел, что автозапуск сняли
      // (heEngStartGate → readHeEngLaunchStillWanted: желание снято, автопилот
      // выключен или отмена новее нажатия) — кампании не стартованы. Старт —
      // кнопка блока отправки выше (её текст и наличие решает сводка).
      line = {
        text: 'Sending was not started because automatic launch was turned off while this market was being launched. The sending status above shows how to start it.',
        tone: 'amber',
        actions: [],
      };
    }
  } else if (template) {
    if (needsRewrite) {
      line = { text: engTemplateNeedsRewriteText('none'), tone: 'amber', actions: ['rewrite'] };
    } else if (row?.state === 'done' && row.code === 'needs_support') {
      // Запуск дошёл до ядра, но записи о запуске у шаблона нет (её запись не
      // легла — 'launch_problem'): кампании могли быть созданы и стоят на
      // паузе, старт не делался. «Launch now» создал бы их заново — поэтому
      // Support, как и предупреждение ответа запуска.
      line = {
        text: 'Starting this market ran into a problem, so nothing was started from it. Message Support before you launch it again.',
        tone: 'amber',
        actions: [],
      };
    } else if (row && (autoOn || row.state === 'running')) {
      line = autoLaunchLine(row, false, sendingAccess);
    }
    if (!line && !needsRewrite && !(row && autoOn && row.state === 'done')) {
      line = {
        text: autoOn
          ? 'Ready to send. Press «Launch now» to create the campaigns and start sending.'
          : 'Ready to send. Press «Launch now» to create the campaigns and start sending — automatic launch is not on for this project.',
        tone: 'green',
        actions: ['launch_now'],
      };
    }
  } else if (retired) {
    // Под паузой потолка расхода роут переписки откажет (потолок) — кнопку не
    // зовём, как и письмо об упавшей переписке (engClientMail: Support).
    line =
      detail.project.autopilot_hold?.code === 'spend_paused'
        ? {
            text: `New final letters for this market were not written, so nothing was sent from it. ${SPEND_PAUSED_NEXT}`,
            tone: 'amber',
            actions: [],
          }
        : retiredLine(retiredTries);
  } else {
    line = preparingLine(view, {
      autopilotOn: detail.project.autopilot === true,
      researched,
      spendPaused: detail.project.autopilot_hold?.code === 'spend_paused',
    });
  }

  // Остановленная сборка и остановленный анализ — своим текстом с действием.
  const latest = ownAutoBaseState(ownBases).latest;
  const againBaseId = collectAgainBaseId(ownBases, researched, view.selected);
  let stopText = '';
  if (!template && !view.templateJob && latest && latest.status === 'failed' && base?.id === latest.id) {
    const offersRestart = stopTextOffersRestart(latest, ownBases);
    stopText = latest.error_code
      ? offersRestart
        ? engStageErrorText(latest.error_code, 'collection')
        : engEarlierBaseStopText(latest.error_code)
      : offersRestart
        ? `${ENG_NO_REASON_BASE_HEAD_EN} If you still need this market, press «Launch» above to start a new collection for it; message Support if it keeps stopping.`
        : engEarlierBaseStopText(null);
  }
  if (!template && !view.templateJob && base && engBaseAnalysisStopped(base)) {
    const chains = (detail.chains ?? []) as unknown as Array<Record<string, unknown>>;
    const requeues =
      researched &&
      view.selected &&
      detail.project.autopilot_hold?.code !== 'spend_paused' &&
      engAnalysisRequeues(
        base as unknown as Record<string, unknown>,
        ownBases as unknown as Array<Record<string, unknown>>,
        chains.filter((c) => c.vertical_id === vertical.id),
      );
    extra.push({
      text:
        (analysisCancelled(detail, base.id)
          ? 'Checking the contacts of this market was cancelled before it finished.'
          : 'Checking the contacts of this market stopped before it finished.') +
        // Не ставит «Launch» — ничто из кабинета этот анализ заново не
        // поставит (письмо об этой остановке тоже зовёт в Support).
        (requeues
          ? ' Press «Launch» above to check them again; the contacts already collected are not bought again.'
          : ' Message Support about it.'),
      tone: 'amber',
      actions: [],
    });
  }

  const finalState: FinalLettersState | null = template
    ? launch
      ? incomplete
        ? needsRewrite
          ? 'rewrite_unfinished'
          : 'unfinished'
        : 'launched'
      : needsRewrite
        ? 'rewrite_none'
        : 'next_launch'
    : null;

  const actions = new Set<MarketAction>([...(line?.actions ?? []), ...extra.flatMap((l) => l.actions)]);

  const runLaunchNow = async () => {
    if (!template || busy) return;
    setBusy('launch_now');
    setErrors([]);
    setNotes([]);
    setRefusal(null);
    const nextErrors: string[] = [];
    const nextNotes: string[] = [];
    try {
      // Часы проекта — только первому запуску рынка. У достройки (запись о
      // запуске есть) часы свои: сервер берёт окно рынка и переданное не
      // читает (engClientLaunch.heEngLaunchWindowPlan) — «A market whose
      // campaigns already exist keeps its own hours» над редактором часов.
      const res = await launchEngTemplate(template.id, !launch && launchSchedule ? { schedule: launchSchedule } : {});
      if (res.refusal || !res.ok) nextErrors.push(res.error ?? 'The launch did not go through.');
      for (const warning of res.warnings ?? []) nextNotes.push(warning);
      const sendingText =
        res.ok !== false && res.sending ? engLaunchSendingText(res.sending, res.sending_summary ?? null) : null;
      if (sendingText) nextNotes.push(sendingText);
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else if (e instanceof EngLaunchServerError) nextErrors.push(e.message);
      else nextErrors.push(e instanceof Error ? e.message : 'The launch did not go through.');
    } finally {
      setErrors(nextErrors);
      setNotes(nextNotes);
      setBusy(null);
      onChanged();
    }
  };

  const runRewrite = async () => {
    if (!rewriteTarget || busy) return;
    setBusy('rewrite');
    setErrors([]);
    setNotes([]);
    setRefusal(null);
    try {
      await rewriteEngTemplateLetters(rewriteTarget.id);
      // «By itself» — только при включённом автозапуске проекта; иначе новые
      // письма ждут «Launch now» на этой карточке.
      setNotes([
        autoOn
          ? 'We are writing new final letters for this market. It starts sending by itself when they are ready and pass the check.'
          : 'We are writing new final letters for this market. When they are ready, press «Launch now» on this market to start sending.',
      ]);
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setErrors([e instanceof Error ? e.message : 'The letters could not be rewritten.']);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const runCollectAgain = async () => {
    if (busy) return;
    setBusy('collect');
    setErrors([]);
    setNotes([]);
    setRefusal(null);
    try {
      await collectEngBase(vertical.id);
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setErrors([e instanceof Error ? e.message : 'Failed to start the collection']);
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const toneColor = (tone: MarketLine['tone']) =>
    tone === 'red'
      ? 'var(--cp-red)'
      : tone === 'amber'
        ? 'var(--cp-amber)'
        : tone === 'green'
          ? 'var(--cp-green)'
          : 'var(--cp-text-m)';

  return (
    <EngCard>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-sm font-bold" style={{ color: 'var(--cp-paper)' }}>
          {vertical.name}
        </h4>
        {!view.selected && <EngBadge label="not selected" tone="neutral" />}
      </div>
      <ProgressDots dots={dots} />

      {/* Запущенный рынок: статус отправки и Pause / Start sending / Resume
          (EngSendingBlock читает сводку сам) и часы отправки его кампаний. */}
      {launch && template && (
        <div className="mt-3 flex flex-col gap-1">
          <EngSendingBlock templateId={template.id} poll />
          {/* White-label: кампании — подписями, без ссылок наружу. «Default
              texts» — имя основной кампании разбитого по сегментам запуска
              (его называет и строка ночного добора Command Center). */}
          <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            {launch.leads_count.toLocaleString('en-US')} contacts{incomplete ? ' so far' : ''} · launched{' '}
            {fmtDate(launch.created_at)}
            {Array.isArray(launch.campaigns) && launch.campaigns.length > 1
              ? ` · campaigns: ${launch.campaigns.map((c) => c.segment ?? 'Default texts').join(', ')}`
              : ''}
          </span>
          <LaunchedSendingWindow templateId={template.id} />
        </div>
      )}

      {line && line.text && (
        <p className="mb-0 mt-3 inline-flex items-start gap-1.5 text-xs" style={{ color: toneColor(line.tone) }}>
          {line.spinner && <EngSpinner className="mt-0.5 h-3 w-3 shrink-0" />}
          <span>
            <EngSupportText text={line.text} />
          </span>
        </p>
      )}
      {extra.map((l) => (
        <p key={l.text} className="mb-0 mt-2 text-xs" style={{ color: toneColor(l.tone) }}>
          <EngSupportText text={l.text} />
        </p>
      ))}
      {stopText && (
        <p className="mb-0 mt-2 text-xs" style={{ color: 'var(--cp-red)' }}>
          <EngSupportText text={stopText} />
        </p>
      )}

      {base && base.status === 'collecting' && <CollectProgress base={base} />}
      {base && !template && <SendVolume base={base} />}
      {base && !template && <AutopilotDecisions base={base} />}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions.has('launch_now') && template && (
          <button
            type="button"
            onClick={() => void runLaunchNow()}
            disabled={busy !== null}
            className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
          >
            {busy === 'launch_now' ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
            Launch now
          </button>
        )}
        {actions.has('rewrite') && rewriteTarget && (
          <button
            type="button"
            onClick={() => void runRewrite()}
            disabled={busy !== null}
            className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
          >
            {busy === 'rewrite' ? <EngSpinner className="h-3 w-3" /> : <Wand2 className="h-3 w-3" />}
            Rewrite letters
          </button>
        )}
        {againBaseId !== null && latest?.id === againBaseId && !template && (
          <button
            type="button"
            onClick={() => void runCollectAgain()}
            disabled={busy !== null}
            className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
            title="Start a new collection of this market. It is checked the same way and may stop here again."
          >
            {busy === 'collect' ? <EngSpinner className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
            Collect again
          </button>
        )}
        {template && (
          <button
            type="button"
            onClick={() => setShowLetters((v) => !v)}
            aria-expanded={showLetters}
            className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
          >
            <Mail className="h-3 w-3" />
            {showLetters ? 'Hide letters' : 'Preview letters'}
          </button>
        )}
        {view.chain && !template && (
          <button
            type="button"
            onClick={() => setShowDraft((v) => !v)}
            aria-expanded={showDraft}
            className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
          >
            <Pencil className="h-3 w-3" />
            {showDraft ? 'Hide draft letters' : 'Edit draft letters'}
          </button>
        )}
      </div>

      {actions.has('resend') && (
        <div className="mt-2">
          <EngResendLinkControls />
        </div>
      )}
      {refusal && (
        <div className="mt-2">
          <EngPaidAccessNotice refusal={refusal} />
        </div>
      )}
      {errors.map((err) => (
        <p key={err} className="mb-0 mt-2 text-xs" style={{ color: 'var(--cp-red)' }}>
          <EngSupportText text={err} />
        </p>
      ))}
      {notes.map((note) => (
        <p key={note} className="mb-0 mt-2 text-xs" style={{ color: 'var(--cp-amber)' }}>
          <EngSupportText text={note} />
        </p>
      ))}

      {launch && <EngRefillPauseNote vertical={vertical} onChanged={onChanged} />}

      {showLetters && template && finalState && <FinalLetters template={template} state={finalState} />}
      {showDraft && view.chain && !template && (
        <ChainEditor chain={view.chain} draftNote={engChainDraftText(false, 'letters')} onSaved={onChanged} />
      )}
      {base && (base.status === 'analyzed' || base.status === 'analyzing') && <BasePreview base={base} />}
    </EngCard>
  );
}

/* ── Шаг ── */

export function EngStepLaunch({
  detail,
  onChanged,
  goToStep,
}: {
  detail: EngDetail;
  onChanged: () => void;
  goToStep: (step: number) => void;
}) {
  const projectId = detail.project.id;
  const status = detail.project.status;
  const verticals = useMemo(
    () =>
      [...((detail.verticals ?? []) as HeVertical[])].sort((a, b) => {
        const ra = typeof a.rank === 'number' ? a.rank : Number.POSITIVE_INFINITY;
        const rb = typeof b.rank === 'number' ? b.rank : Number.POSITIVE_INFINITY;
        return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
      }),
    [detail],
  );
  const hypotheses = useMemo(() => (detail.hypotheses ?? []) as HeHypothesis[], [detail]);

  const [info, setInfo] = useState<EngProjectLaunchInfo | null>(null);
  const [infoError, setInfoError] = useState('');
  const [windowDraft, setWindowDraft] = useState<EngSendingWindow | null>(null);
  const [editingWindow, setEditingWindow] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<{ text: string; held: boolean } | null>(null);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);
  const [savingWindow, setSavingWindow] = useState(false);
  const [windowNote, setWindowNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      const next = await fetchEngProjectLaunch(projectId);
      setInfo(next);
      setInfoError('');
    } catch (e) {
      setInfoError(e instanceof Error ? e.message : 'Failed to load the launch settings');
    }
  }, [projectId]);

  // Первое чтение — setState внутри асинхронной функции, а не в теле эффекта
  // (правило react-hooks); после нажатий перечитывает loadInfo.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchEngProjectLaunch(projectId);
        if (cancelled) return;
        setInfo(next);
        setInfoError('');
      } catch (e) {
        if (!cancelled) setInfoError(e instanceof Error ? e.message : 'Failed to load the launch settings');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const timezones = useMemo(() => (info && Array.isArray(info.timezones) ? info.timezones : []), [info]);
  const weekdays = useMemo(() => (info && Array.isArray(info.weekdays) ? info.weekdays : []), [info]);
  /** Часы, с которых открывается редактор: сохранённые с «Launch», иначе дефолт сервера в поясе браузера. */
  const baseWindow = useMemo<EngSendingWindow | null>(() => {
    if (!info) return null;
    if (info.schedule) return { ...info.schedule, days: [...info.schedule.days] };
    if (!info.default) return null;
    const browserTz = browserTimezoneIn(timezones);
    return { ...info.default, days: [...info.default.days], ...(browserTz ? { timezone: browserTz } : {}) };
  }, [info, timezones]);
  const windowValue = windowDraft ?? baseWindow;
  const windowConfig: SendingWindowConfig | null =
    windowValue && timezones.length > 0 && weekdays.length > 0 ? { value: windowValue, timezones, weekdays } : null;
  const windowUsable = isSendingWindowUsable(windowConfig);

  const auto = detail.auto_launch ?? null;
  const available = auto?.available ?? info?.available ?? null;
  const requested = (auto?.requested ?? info?.requested) === true;
  const requestedAt = auto?.requested_at ?? info?.requested_at ?? null;
  const autoOn = requested && available !== false;
  const cancelledAt = !requested ? (auto?.cancelled_at ?? info?.cancelled_at ?? null) : null;
  const access = accessLine(info?.sending_access);

  const selectedIds = useMemo(() => {
    const known = new Set(verticals.map((v) => v.id));
    return heEngSelectedVerticalIds(hypotheses).filter((id) => known.has(id));
  }, [verticals, hypotheses]);
  const startedIds = useMemo(() => {
    const state = {
      chains: detail.chains ?? [],
      bases: detail.bases ?? [],
      templates: detail.templates ?? [],
      activeJobs: (detail.jobs ?? []).filter((j) => j.status === 'pending' || j.status === 'running'),
    };
    return new Set(verticals.filter((v) => heEngMarketStarted(v.id, state)).map((v) => v.id));
  }, [detail, verticals]);
  const selectedSet = new Set(selectedIds);
  /**
   * Выбранные рынки, по которым не было НИЧЕГО (ни писем, ни базы, ни шаблона,
   * ни джобы — даже упавших): их возьмёт «Launch». Рынок с остановленной
   * сборкой сюда не входит — «Launch» его заново не соберёт, у него своя
   * карточка с причиной и «Collect again».
   */
  const pending = verticals.filter((v) => {
    if (!selectedSet.has(v.id) || startedIds.has(v.id)) return false;
    if ((detail.chains ?? []).some((c) => c.vertical_id === v.id)) return false;
    if ((detail.bases ?? []).some((b) => b.vertical_id === v.id)) return false;
    return !(detail.jobs ?? []).some((j) => (j.payload as { vertical_id?: unknown } | null | undefined)?.vertical_id === v.id);
  });
  const selectedNames = verticals.filter((v) => selectedSet.has(v.id)).map((v) => v.name);
  const cardVerticals = verticals.filter((v) => selectedSet.has(v.id) || startedIds.has(v.id));
  const fresh = !requested && startedIds.size === 0;

  const onLaunch = async () => {
    if (launching || access?.blocks || !windowUsable) return;
    setLaunching(true);
    setError('');
    setRefusal(null);
    setResult(null);
    try {
      const res = await launchEngProject(projectId, windowConfig ? { schedule: windowConfig.value } : {});
      setResult(launchResultText(res));
      setWindowDraft(null);
      setEditingWindow(false);
      await loadInfo();
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setError(e instanceof Error ? e.message : 'Failed to launch');
    } finally {
      setLaunching(false);
      onChanged();
    }
  };

  /** Часы для рынков, которые запустятся дальше (после «Launch»). */
  const onSaveWindow = async () => {
    if (!windowConfig || savingWindow || !windowUsable) return;
    setSavingWindow(true);
    setWindowNote(null);
    try {
      await updateEngProjectLaunchSchedule(projectId, windowConfig.value);
      setWindowNote({ tone: 'ok', text: 'Saved.' });
      setWindowDraft(null);
      setEditingWindow(false);
      await loadInfo();
    } catch (e) {
      setWindowNote({ tone: 'error', text: e instanceof Error ? e.message : 'Failed to save the sending hours' });
    } finally {
      setSavingWindow(false);
    }
  };

  // Рынков нет: исследование не закончено или ни один рынок не выбран.
  if (status !== 'researched' && cardVerticals.length === 0) {
    return (
      <EngCard>
        <p className="m-0 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          {status === 'researching'
            ? 'Launch opens as soon as the research of your business finishes and you have chosen your markets — step 1 «Your business» shows how far the research has got.'
            : status === 'failed'
              ? 'Launch opens on a researched project — the research of your business stopped, and step 1 «Your business» shows what happened and whether it can be tried again.'
              : 'Launch opens once the research of your business is finished, and it is not running on this project — step 1 «Your business» says what to do.'}
        </p>
        <button
          type="button"
          onClick={() => goToStep(1)}
          className="ds-btn-secondary mt-3 inline-flex items-center gap-1.5 text-xs"
        >
          <ArrowLeft className="h-3 w-3" /> Your business
        </button>
      </EngCard>
    );
  }
  if (selectedIds.length === 0 && cardVerticals.length === 0) {
    return (
      <EngCard>
        <p className="m-0 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Pick at least one market on step 2 «Choose markets» first.
        </p>
        <button
          type="button"
          onClick={() => goToStep(2)}
          className="ds-btn-secondary mt-3 inline-flex items-center gap-1.5 text-xs"
        >
          <ArrowLeft className="h-3 w-3" /> Choose markets
        </button>
      </EngCard>
    );
  }

  const prepareHours = detail.estimates?.prepare_hours;
  const canLaunch = status === 'researched' && selectedIds.length > 0;
  // Кнопка «Launch» стоит всегда, когда её примет роут: она же «двигает
  // дальше» остановившееся и берёт рынки, выбранные после первого нажатия.
  // Подпись — всегда «Launch»: её по имени зовут тексты пауз, остановок и
  // карточек рынков, и «Launch N more» сделал бы их неправдой.
  const launchPrimary = fresh || !requested || pending.length > 0;

  const windowBlock = (mode: 'before' | 'intent') => (
    <div className="mt-3 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--cp-text-m)' }}>
        <span className="font-semibold" style={{ color: 'var(--cp-paper)' }}>
          Sending hours
        </span>
        {windowConfig ? (
          <>
            <span className="ds-mono">{sendingWindowSummary(windowConfig)}</span>
            <button
              type="button"
              onClick={() => {
                setWindowNote(null);
                setEditingWindow((v) => !v);
              }}
              className="text-xs underline"
              style={{ color: 'var(--cp-text-m)' }}
            >
              {editingWindow ? 'Done' : 'Change'}
            </button>
          </>
        ) : infoError || info ? (
          // Не прочитали или ответ без списков (демо): уедут часы сервера.
          <span>We could not load the sending hours, so the default ones are used; you can change them later.</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <EngSpinner className="h-3 w-3" /> Loading…
          </span>
        )}
      </div>
      {editingWindow && windowConfig && (
        <>
          <SendingWindowEditor
            config={windowConfig}
            onChange={setWindowDraft}
            disabled={launching || savingWindow}
          />
          {mode === 'intent' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void onSaveWindow()}
                disabled={savingWindow || !windowUsable || windowDraft === null}
                className="ds-btn-primary inline-flex items-center gap-1.5 text-[11px]"
              >
                {savingWindow && <EngSpinner className="h-3 w-3" />}
                Save sending hours
              </button>
            </div>
          )}
        </>
      )}
      {/* Часы проекта берёт только ПЕРВЫЙ запуск рынка (кампаний ещё нет);
          достройка и старт уже созданных кампаний идут по часам рынка
          (engClientLaunch.heEngLaunchWindowPlan), а «Launch now» достройки их
          не шлёт. */}
      {mode === 'intent' && (
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          These hours apply to markets whose campaigns are not created yet. A market whose campaigns already exist
          keeps its own hours — change them under «Sending hours» on its card.
        </span>
      )}
      {windowNote && (
        <span className="text-[11px]" style={{ color: windowNote.tone === 'ok' ? 'var(--cp-green)' : 'var(--cp-red)' }}>
          <EngSupportText text={windowNote.text} />
        </span>
      )}
    </div>
  );

  const launchButton = canLaunch ? (
    <button
      type="button"
      onClick={() => void onLaunch()}
      disabled={launching || Boolean(access?.blocks) || !windowUsable}
      className={`${launchPrimary ? 'ds-btn-primary' : 'ds-btn-secondary'} inline-flex items-center gap-1.5 text-xs`}
    >
      {launching ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
      Launch
    </button>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <EngCard>
        <EngEyebrow>Launch</EngEyebrow>
        {fresh ? (
          <>
            <p className="m-0 text-sm" style={{ color: 'var(--cp-paper)' }}>
              You&apos;re launching {plural(selectedNames.length, 'market', 'markets')}: {namesList(selectedNames)}.{' '}
              <button
                type="button"
                onClick={() => goToStep(2)}
                className="text-xs underline"
                style={{ color: 'var(--cp-text-m)' }}
              >
                Change
              </button>
            </p>
            {windowBlock('before')}
            <div className="mt-3 flex flex-col gap-1 text-xs" style={{ color: 'var(--cp-text-m)' }}>
              {available === false ? (
                <span>
                  We write the letters, find and check contacts and write the final letters by ourselves. Automatic
                  sending is not available right now, so when a market is ready, press «Launch now» on it to start
                  sending.
                </span>
              ) : (
                <>
                  <span>
                    We write the letters, find and check contacts, write the final letters and start sending by
                    ourselves.
                    {typeof prepareHours === 'number' && prepareHours > 0
                      ? ` Getting a market ready to send usually takes ${prepareTimeText(prepareHours)} (based on recent projects).`
                      : ''}
                  </span>
                  <span>We&apos;ll email you when sending starts, or if something stops and needs you.</span>
                </>
              )}
              <span style={{ color: 'var(--cp-text-l)' }}>
                Each market&apos;s final letters show up under «Preview letters» as soon as they are written.
              </span>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-xs" style={{ color: 'var(--cp-text-m)' }}>
              {requested && available !== false
                ? `Automatic launch is on${requestedAt ? ` since ${fmtDate(requestedAt)}` : ''}: each market starts sending by itself once its final letters are ready.`
                : requested
                  ? 'Automatic sending is not available right now, so when a market is ready, press «Launch now» on it to start sending.'
                  : cancelledAt
                    ? `Automatic launch is off since you cancelled on ${fmtDate(cancelledAt)}. Press «Launch» to turn it back on.`
                    : available === false
                      ? 'Automatic sending is not available right now, so when a market is ready, press «Launch now» on it to start sending.'
                      : 'Automatic launch is not on for this project. Press «Launch» to turn it on — each market then starts sending by itself once its final letters are ready.'}
            </p>
            {pending.length > 0 && (
              <p className="m-0 mt-2 text-xs" style={{ color: 'var(--cp-paper)' }}>
                {/* Рынки, отмеченные после «Launch», сами не стартуют (решение
                    владельца по умолчанию: ждут нового нажатия) — фраза говорит
                    это прямо. */}
                {/* Под паузой потолка расхода «Launch» их не начнёт
                    (реконсилер встаёт на потолке) — звать к нему нельзя. */}
                {pending.length === 1
                  ? `1 market you chose has not started yet: ${pending[0].name}. ${
                      detail.project.autopilot_hold?.code === 'spend_paused'
                        ? SPEND_PAUSED_NEXT
                        : 'It starts when you press «Launch» again — a market ticked after a launch does not start by itself.'
                    }`
                  : `${pending.length} markets you chose have not started yet: ${namesList(pending.map((v) => v.name))}. ${
                      detail.project.autopilot_hold?.code === 'spend_paused'
                        ? SPEND_PAUSED_NEXT
                        : 'They start when you press «Launch» again — markets ticked after a launch do not start by themselves.'
                    }`}{' '}
                <button
                  type="button"
                  onClick={() => goToStep(2)}
                  className="text-xs underline"
                  style={{ color: 'var(--cp-text-m)' }}
                >
                  Change
                </button>
              </p>
            )}
            {windowBlock(requested && available !== false ? 'intent' : 'before')}
          </>
        )}

        {access && (
          <p className="m-0 mt-3 text-xs" style={{ color: access.blocks ? 'var(--cp-red)' : 'var(--cp-amber)' }}>
            <EngSupportText text={access.text} />
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {launchButton}
          {/* Не «любой остановившийся»: снятые письма, сборку с повторяющейся
              остановкой, анализ без повторной постановки и всё под паузой
              потолка «Launch» не двигает — у них на карточке своя кнопка или
              Support. */}
          {launchButton && !fresh && !launchPrimary && (
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              Moves on a market whose card says to press «Launch» — work already done is not repeated.
            </span>
          )}
          {!canLaunch && status !== 'researched' && (
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              «Launch» opens again once the research of your business is finished — step 1 «Your business» shows it.
            </span>
          )}
        </div>

        {result && (
          <p className="m-0 mt-3 text-xs" style={{ color: result.held ? 'var(--cp-text-m)' : 'var(--cp-green)' }}>
            <EngSupportText text={result.text} />
          </p>
        )}
        {refusal && (
          <div className="mt-3">
            <EngPaidAccessNotice refusal={refusal} />
          </div>
        )}
        {error && (
          <p className="m-0 mt-3 text-xs" style={{ color: 'var(--cp-red)' }}>
            <EngSupportText text={error} />
          </p>
        )}
      </EngCard>

      {!fresh &&
        cardVerticals.map((v) => (
          <MarketCard
            key={v.id}
            view={buildMarketView(detail, v, selectedSet.has(v.id))}
            detail={detail}
            autoOn={autoOn}
            sendingAccess={info?.sending_access}
            launchSchedule={windowConfig && windowUsable ? windowConfig.value : undefined}
            onChanged={onChanged}
          />
        ))}
    </div>
  );
}
