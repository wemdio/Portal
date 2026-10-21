'use client';

/**
 * Шаг 3 «Launch» клиентского ENG-кабинета — ОДНА кнопка и дальше прогресс.
 *
 * До нажатия: какие рынки запускаются («Change» — на шаг 2), часы отправки
 * (редактор SendingWindowEditor; пункты — `timezone_options ?? timezones`
 * ответа, план §1C; стартовый пояс — сохранённый с «Launch», иначе
 * `suggested_timezone` по странам сбора проекта, иначе пояс браузера среди
 * прежних 8 `timezones`, иначе дефолт сервера), что произойдёт дальше и строка
 * про доступ к отправке (GET /api/client/eng/projects/[id]/launch). Страны
 * проекта без США и без подсказки пояса — строка «выберите пояс сами». «Launch» —
 * POST .../launch {schedule}: записывает желание «запускай сам» и ставит
 * работу тем же реконсилером, что прежняя кнопка автопилота (сборка →
 * анализ → письма), а готовый рынок запускает автозапуск воркера тем
 * же путём, что кнопка «Launch now» (runHeEngTemplateLaunch: все гейты).
 *
 * После нажатия: по каждому рынку — строка прогресса (Contacts · Checked ·
 * Letters · Sending), одна строка состояния и кнопки, которые
 * это состояние требует: «Launch now», «Rewrite letters», «Collect again»,
 * «Resume daily top-up», ссылка Support. У запущенного рынка — блок отправки
 * S2 (статус, отправлено/ответы, Pause / Resume / Start the rest), «Sending
 * hours» и «Preview letters». Итоговые письма можно открыть, как только они
 * написаны; ничего их не ждёт.
 *
 * Состояние рынка (по старшинству): запись о запуске → блок отправки; иначе
 * строка автозапуска (`auto_launch.markets` деталки); иначе стадия подготовки.
 * Автозапуск выключен (не нажат «Launch», отменён «Cancel all jobs», таблиц
 * нет, выключатель HE_ENG_AUTO_LAUNCH выключен — тогда available:false) — у
 * готового рынка «Launch now», и экран не обещает, что рынок запустится сам.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, CircleDashed, Mail, Rocket, RotateCcw, Wand2, X } from 'lucide-react';
import type { HeHypothesis, HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { heLaunchIsIncomplete, parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
// Тот же предикат «кнопка поставит анализ заново», что у Command Center
// (чистая функция без серверных зависимостей).
import {
  ENG_TEAM_FIX_STOP_EN,
  engAnalysisRequeues,
  engTeamFixStopOf,
  engTeamFixThenText,
} from '@/lib/hypothesisEngine/engDashboard';
import { heEngMarketPending, heEngMarketStarted, heEngSelectedVerticalIds } from '@/lib/hypothesisEngine/engMarkets';
import {
  EngLaunchServerError,
  EngPaidAccessError,
  collectEngBase,
  engLaunchRunDays,
  engCollectCountriesOf,
  engSendingAccessOf,
  engTemplateNeedsRewrite,
  fetchEngProjectLaunch,
  fetchEngTemplateRewriteTries,
  launchEngProject,
  launchEngProjectMarkets,
  launchEngTemplate,
  rewriteEngTemplateLetters,
  updateEngProjectLaunchSchedule,
  type EngAutoLaunchMarket,
  type EngBaseSummary,
  type EngProjectLaunchInfo,
  type EngProjectLaunchMoreResponse,
  type EngProjectLaunchResponse,
  type EngRefillTotal,
  type EngSendingAccessState,
  type EngSendingWindow,
  type EngSendingWindowTimezoneOption,
  type HeJobSummary,
} from './api-client';
import {
  ENG_NO_REASON_BASE_HEAD_EN,
  ENG_SENDING_OFF_EN,
  engAutopilotHoldText,
  engBaseStopSendingOffText,
  engEarlierBaseStopText,
  engLaunchSendingText,
  engLettersBrandInputText,
  engLettersBrandInputs,
  engStageErrorText,
  engTemplateNeedsRewriteText,
  engTemplateRewriteReasons,
} from './engText';
import { EngPaidAccessNotice, EngResendLinkControls, EngSupportText } from './EngPaidAccess';
import { EngSendingBlock } from './EngSending';
import { EngCollectionTargetSummary, engCollectionTargetView } from './EngCollectionTarget';
import { heProjectAwaitsDescription } from './clientFailureText';
import {
  AutopilotDecisions,
  CollectProgress,
  SendVolume,
  analysisCancelled,
  collectAgainBaseId,
  ownAutoBaseState,
  stopTextOffersRestart,
} from './EngStepBases';
import {
  BasePreview,
  FinalLetters,
  LaunchedSendingWindow,
  SendingWindowEditor,
  engTimezoneFallbackLabel,
  engTimezoneOptionsOf,
  isSendingWindowUsable,
  sendingWindowSummary,
  tzOffsetMinutes,
  type FinalLettersState,
  type SendingWindowConfig,
} from './EngStepReview';
import { EngRefillPauseNote } from './EngStepVerticals';
import { EngBadge, EngCard, EngEyebrow, EngSpinner, engBaseAnalysisStopped, fmtDate } from './ui';
import type { EngDetail } from './EngProjectWizard';
import { ENG_COUNTRY_US } from '@/lib/hypothesisEngine/engCountries';

/** Страны проекта в разных поясах, и сервер пояс не подсказал (план §1C). */
const MULTI_ZONE_HINT = 'Your countries are in different time zones. Choose the time zone your emails should follow.';

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

/**
 * Пояс браузера клиента — если он есть в списке: тот же идентификатор или пояс
 * списка с теми же часами и зимой, и летом (America/New_York →
 * America/Detroit). Список — только прежние 8 `timezones` ответа, НЕ полный
 * `timezone_options` (план §1C): подбор по браузеру остаётся прежним, а
 * европейские часы клиент выбирает сам или их подсказывают страны проекта
 * (`suggested_timezone`). Не нашёлся — null, и редактор открывается с
 * дефолтом сервера.
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

/**
 * Строка про выключатель отправки аккаунта; null — сказать нечего.
 * `autoAvailable` — автозапуск вообще работает (available деталки / GET
 * …/launch не false; при выключенном HE_ENG_AUTO_LAUNCH — false): без него
 * после проверки рынок сам не стартует — «can start», а не «starts».
 */
function accessLine(
  access: EngSendingAccessState | undefined,
  autoAvailable: boolean,
): { text: string; blocks: boolean } | null {
  switch (access) {
    case 'not_enabled':
      return {
        text: autoAvailable
          ? 'Sending starts after a one-time check of your account by our team. We’ll email you when it’s on.'
          : 'Sending can start after a one-time check of your account by our team. We’ll email you when it’s on.',
        blocks: false,
      };
    case 'revoked':
      return { text: 'Sending is turned off for your account, so nothing can be launched. Message Support.', blocks: true };
    default:
      return null;
  }
}

/**
 * Шапка шага 3 у начатого проекта. `blocked` — выключатель отправки держит
 * «Launch» (accessLine 'revoked': кнопка выключена, «Launch N more markets» и
 * «Launch now» скрыты, роут ответил бы 403; так и после разблокировки, пока
 * сотрудник не включит отправку). Тогда в шапке нет ни «Press «Launch»», ни
 * «press «Launch now»», ни обещания «starts sending by itself» — что делать,
 * говорит красная строка доступа ниже.
 */
function launchHeaderText(s: {
  requested: boolean;
  available: boolean | null;
  requestedAt: string | null;
  cancelledAt: string | null;
  blocked: boolean;
}): string {
  const notAvailable = s.blocked
    ? 'Automatic sending is not available right now.'
    : 'Automatic sending is not available right now, so when a market is ready, press «Launch now» on it to start sending.';
  if (s.requested && s.available !== false) {
    const on = `Automatic launch is on${s.requestedAt ? ` since ${fmtDate(s.requestedAt)}` : ''}`;
    return s.blocked ? `${on}.` : `${on}: each market starts sending by itself once its letters are ready.`;
  }
  if (s.requested) return notAvailable;
  if (s.cancelledAt) {
    // Выключает его и «Cancel all jobs» клиента, и остановка работы командой
    // (и блокировка аккаунта) — фраза верна для всех.
    const off = `Automatic launch has been off since ${fmtDate(s.cancelledAt)}.`;
    return s.blocked ? off : `${off} Press «Launch» to turn it back on.`;
  }
  if (s.available === false) return notAvailable;
  return s.blocked
    ? 'Automatic launch is not on for this project.'
    : 'Automatic launch is not on for this project. Press «Launch» to turn it on — each market then starts sending by itself once its letters are ready.';
}

/**
 * «~N days, approximate» запущенного рынка: срок посчитан при запуске
 * (engClientLaunch.heEngLaunchRunDays) — самая долгая из кампаний запуска,
 * которые шлют параллельно, каждая по своим адресам и своим дневным лимитам,
 * с днями окна отправки и паузами между письмами — фраза называет ровно это.
 */
function runDaysText(days: number): string {
  return (
    `Sending all letters to these contacts takes ~${plural(days, 'day', 'days')}, approximate: estimated at launch ` +
    "from each campaign's contacts and daily sending limits, your sending days and the waits between letters."
  );
}

/**
 * Итог ночного добора рынка (`refill_totals` деталки): адреса, которые
 * прогоны добавили в его кампании, а пока их нет — сколько прогонов
 * доработало. Число прогонов при добавленных адресах не печатается: в
 * `added` входят и упавшие прогоны, успевшие отдать часть строк, а в `runs`
 * — только доработавшие. Упавшие ночи (наш сбой) за «ничего не нашли» не
 * выдаются: в `runs` их нет, а рынок только с ними итога не получает.
 */
function refillTotalText(total: EngRefillTotal): string {
  return total.added > 0
    ? `Daily top-up: ${plural(total.added, 'new contact', 'new contacts')} added so far.`
    : `Daily top-up: ${plural(total.runs, 'top-up', 'top-ups')} so far, no new contacts added yet.`;
}

/**
 * Хвост итога «Launch» / «Launch N more markets», когда автозапуска нет
 * (auto_launch 'unavailable': нет таблиц или выключатель HE_ENG_AUTO_LAUNCH
 * выключен — тик ничего не берёт и писем о старте не шлёт): ни «starts by
 * itself», ни «we’ll email you when sending starts» — только «Launch now».
 * Письмо «it’s on» — это письмо «Sending is on», которое уходит при включении
 * отправки сотрудником (api/admin/users/[id]/eng-sending), а не от тика.
 */
function launchUnavailableTail(sendingAccess: EngSendingAccessState | undefined): string {
  return sendingAccess === 'not_enabled'
    ? ' Automatic sending is not available right now: when a market is ready and our team has finished the one-time check of your account (we’ll email you when it’s on), press «Launch now» on it to start sending.'
    : ' Automatic sending is not available right now, so when a market is ready, press «Launch now» on it to start sending.';
}

/** Итог «Launch» проекта одной-двумя фразами. */
function launchResultText(res: EngProjectLaunchResponse): { text: string; held: boolean } {
  const parts: string[] = [];
  if (res.collects_enqueued) parts.push(`collecting contacts for ${plural(res.collects_enqueued, 'market', 'markets')}`);
  if (res.analyses_requeued) parts.push(`checking contacts for ${plural(res.analyses_requeued, 'market', 'markets')}`);
  if (res.templates_enqueued) parts.push(`letters for ${plural(res.templates_enqueued, 'market', 'markets')}`);
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
  // Рынки, которым письма не поставлены: поле брифа шага 1 называет наш бренд
  // (реконсилер, причина 'brand_input') — поле и что сделать.
  const brandMarkets = res.brand_input_markets ?? 0;
  const brandNote =
    brandMarkets > 0
      ? ` The letters for ${plural(brandMarkets, 'market', 'markets')} were not started. ${engLettersBrandInputText(
          res.brand_inputs ?? [],
          'launch_again',
        )}`
      : '';
  const head =
    parts.length > 0
      ? `Started: ${parts.join(' · ')}.${holdNote}${brandNote}`
      : held || brandMarkets > 0
        ? holdCode === 'spend_paused'
          ? `${holdNote.trim()}${brandNote}`
          : `Nothing new was started.${holdNote}${brandNote}`
        : 'Nothing new was started — everything «Launch» can start is already in progress or done; each market’s card below says what it is waiting for.';
  // Обещание письма — ровно то, что шлёт engClientMail при включённом
  // автозапуске: старт отправки (и ожидание проверки аккаунта) и остановки,
  // которым нужен клиент (стадии, сборка, пауза, письма на переписку, старт
  // не удался); паузы, которые снимаются сами или командой, писем не шлют.
  // 'on' роут отвечает, только когда намерение записано И выключатель
  // HE_ENG_AUTO_LAUNCH включён; иначе — launchUnavailableTail.
  const tail =
    res.auto_launch === 'on'
      ? res.sending_access === 'not_enabled'
        ? ' Each market starts sending by itself once its letters are ready and our team has finished the one-time check of your account. We’ll email you when sending starts, or if something stops and needs you.'
        : ' Each market starts sending by itself once its letters are ready. We’ll email you when sending starts, or if something stops and needs you.'
      : launchUnavailableTail(res.sending_access);
  return {
    text: `${head}${againNote}${tail}`,
    held: held || Boolean(holdCode) || (parts.length === 0 && again > 0) || brandMarkets > 0,
  };
}

/**
 * Итог «Launch N more markets». Обещание письма и старта — то же, что у
 * «Launch» (намерение проекта уже включено, новые рынки ведёт тот же автозапуск);
 * при выключателе аккаунта 'not_enabled' старт ждёт разовой проверки командой.
 * Роут ответил auto_launch 'unavailable' (выключатель HE_ENG_AUTO_LAUNCH
 * выключен) — без «start sending by ourselves» и обещания письма: хвост
 * launchUnavailableTail, как у «Launch».
 * Пауза, записанная этим нажатием (потолок расхода, сбой постановки), — её
 * фразой; рынки, которые к нажатию уже начались, — отдельной фразой.
 */
function launchMoreResultText(
  res: EngProjectLaunchMoreResponse,
  nameOf: (verticalId: string) => string,
): { text: string; held: boolean } {
  const started = (res.markets_started ?? []).map(nameOf);
  const already = (res.markets_already_started ?? []).map(nameOf);
  const holdCode = res.autopilot_hold_code;
  // Рынки, которым письма не поставлены: поле брифа шага 1 называет наш бренд.
  const brandNote =
    (res.brand_input_markets ?? 0) > 0 ? ` ${engLettersBrandInputText(res.brand_inputs ?? [], 'launch_again')}` : '';
  if (started.length === 0) {
    if (brandNote) {
      return { text: `Nothing new was started.${brandNote}${holdCode ? ` ${engAutopilotHoldText(holdCode)}` : ''}`, held: true };
    }
    if (holdCode) return { text: `Nothing new was started. ${engAutopilotHoldText(holdCode)}`, held: true };
    return {
      text:
        already.length > 0
          ? 'These markets have already started — their cards below show how far they have got.'
          : 'Nothing new was started — each market’s card below says what it is waiting for.',
      held: true,
    };
  }
  const head = `Started ${plural(started.length, 'more market', 'more markets')}: ${namesList(started)}.`;
  const auto = res.auto_launch === 'on';
  const how = auto
    ? ' We find and check contacts, then write their letters and start sending by ourselves, the same way as your other markets.'
    : ' We find and check contacts, then write their letters.';
  const tail = !auto
    ? launchUnavailableTail(res.sending_access)
    : res.sending_access === 'not_enabled'
      ? ' They start sending after our team has finished the one-time check of your account.'
      : ' We’ll email you when sending starts, or if something stops and needs you.';
  const alreadyNote = already.length > 0 ? ` ${namesList(already)} had already started.` : '';
  const holdNote = holdCode ? ` Not everything could be started. ${engAutopilotHoldText(holdCode)}` : '';
  return { text: `${head}${how}${tail}${alreadyNote}${holdNote}${brandNote}`, held: Boolean(holdCode) || brandNote !== '' };
}

/* ── Рынок: что с ним сейчас ── */

type DotState = 'done' | 'current' | 'waiting' | 'stopped';

interface MarketView {
  vertical: HeVertical;
  selected: boolean;
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
  const bases = (detail.bases ?? []) as EngBaseSummary[];
  const ownBases = bases.filter((b) => b.vertical_id === vertical.id);
  const baseIds = new Set(ownBases.map((b) => b.id));
  const templates = ((detail.templates ?? []) as HeTemplate[]).filter((t) => t.vertical_id === vertical.id);
  const template = marketTemplate(templates);
  const launch = template ? parseLaunchInfo((template as { launch_info?: unknown }).launch_info) : null;
  const templateJob = jobs.some((j) => {
    if (j.stage !== 'template' || !isLive(j)) return false;
    const p = payloadOf(j);
    return p.vertical_id === vertical.id || (typeof p.base_id === 'string' && baseIds.has(p.base_id));
  });
  const retired = !template && !templateJob ? engRetiredTemplateOf(templates) : undefined;
  const shown = template ?? retired;
  const shownBase = shown ? bases.find((b) => b.id === shown.base_id) : undefined;
  const base = shownBase ?? ownAutoBaseState(ownBases).latest;
  const row = template
    ? ((detail.auto_launch?.markets ?? []).find((m) => m.template_id === template.id) ?? null)
    : null;
  return {
    vertical,
    selected,
    ownBases,
    base,
    template,
    templateJob,
    retired,
    launch,
    row,
  };
}

/** Сбор, проверка, единственное написание писем и отправка. */
function marketDots(view: MarketView): Array<{ label: string; state: DotState }> {
  const { base, template, launch, row } = view;
  const construct = base?.collect_info?.construct;
  const constructStarted = construct !== undefined && construct !== null;
  const analysisStopped = base ? engBaseAnalysisStopped(base) : false;
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
  const letters: DotState = template ? 'done' : view.templateJob ? 'current' : view.retired ? 'stopped' : 'waiting';
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
    { label: 'Contacts', state: contacts },
    { label: 'Checked', state: checked },
    { label: 'Letters', state: letters },
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
        return { text: ENG_SENDING_OFF_EN, tone: 'red', actions: [] };
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
    case 'held': {
      // `launched` — запуск не закончен (часть аудитории уже в кампаниях):
      // «Ready» и «starts» про такой рынок неправда — говорим «the rest».
      const rest = 'Part of this market’s audience has not gone out yet';
      switch (code) {
        case 'sending_not_enabled':
          return {
            text: launched
              ? `${rest}; the rest is added after a one-time check of your account by our team — we’ll email you when it’s on.`
              : 'Ready. Sending starts after a one-time check of your account by our team — we’ll email you when it’s on.',
            tone: 'muted',
            actions: [],
          };
        case 'sending_turned_off':
          return { text: ENG_SENDING_OFF_EN, tone: 'red', actions: [] };
        case 'email_not_verified':
          return {
            text: launched ? `${rest}; the rest is added once you confirm your email.` : 'Ready. Sending starts once you confirm your email.',
            tone: 'amber',
            actions: ['resend'],
          };
        // Потолки — нейтрально («a usage limit»), как у manualHeldLine:
        // spend_limit пишут потолок клиента и потолок проекта, spend_day_limit —
        // ещё и общий потолок ENG, которого аккаунт клиента не достигал.
        case 'spend_limit':
          return {
            text: launched
              ? `${rest}: adding the rest is on hold because a usage limit was reached. Contact Support to raise the limit.`
              : 'Sending for this market is on hold because a usage limit was reached. Contact Support to raise the limit.',
            tone: 'amber',
            actions: [],
          };
        case 'spend_day_limit':
          return {
            text: launched
              ? `${rest}: adding the rest is on hold because a usage limit for the last 24 hours was reached. We try again by ourselves, or message Support.`
              : 'Sending for this market is on hold because a usage limit for the last 24 hours was reached. We try again by ourselves, or message Support.',
            tone: 'amber',
            actions: [],
          };
        case 'unavailable':
          // Код пишут два отказа общего вызова запуска: гейт платных шагов
          // (не прочитались почта или потолки аккаунта) и окно запуска
          // (heEngLaunchWindowPlan: не прочитались запись о запуске или часы
          // рынка) — поэтому без «your account».
          return {
            text: launched
              ? `${rest}. We could not finish our checks just now — we’ll try again ${nextTryText(row.next_at)}.`
              : `Ready. We could not finish our checks just now — we’ll try again ${nextTryText(row.next_at)}.`,
            tone: 'muted',
            actions: [],
          };
        case 'setup_unavailable':
        case 'mailboxes_short':
          return {
            text: launched
              ? `${rest}; we’re preparing sending for your account and add the rest by ourselves when it’s ready. Our team has been notified.`
              : 'We’re preparing sending for your account; it starts by itself when ready. Our team has been notified.',
            tone: 'muted',
            actions: [],
          };
        case 'research_running':
          return { text: 'Waiting for the research to finish.', tone: 'muted', actions: [] };
        case 'letters_need_rewrite':
          // Пишет карточка своей веткой (признак `needs_rewrite`) — с кнопкой.
          return null;
        case 'account_blocked':
          // Строку автозапуск сам не перепроверяет (срок — через годы, его не
          // печатаем): поднимает её только новое «Launch» проекта. Отправка
          // аккаунта выключена ('revoked') — «Launch» выключена, к ней не зовём.
          if (access === 'revoked') return { text: ENG_SENDING_OFF_EN, tone: 'red', actions: [] };
          return {
            text: launched
              ? `${rest}. Press «Launch» above to finish it.`
              : 'Sending for this market has not started yet. Press «Launch» above to start it.',
            tone: 'amber',
            actions: [],
          };
        case 'needs_support':
          // Отказ запуска, который не снимается сам (алерт команде и письмо
          // ушли при входе в код). Незаконченному запуску «Launch now»
          // упрётся в тот же отказ — Support.
          if (launched) {
            return { text: `${rest}: finishing it ran into a problem. Message Support.`, tone: 'amber', actions: [] };
          }
          return {
            text: 'Sending could not start for this market. Nothing was sent. Press «Launch now» to see the reason, or message Support.',
            tone: 'amber',
            actions: ['launch_now'],
          };
        default:
          return {
            text: launched
              ? `${rest}. Press «Launch now» to see the reason, or message Support.`
              : 'Sending could not start for this market. Nothing was sent. Press «Launch now» to see the reason, or message Support.',
            tone: 'amber',
            actions: ['launch_now'],
          };
      }
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
 * Строка 'held' рынка, когда автозапуска у проекта нет (`autoOn` false:
 * «Launch» не нажат или отменён, таблиц нет, выключатель HE_ENG_AUTO_LAUNCH
 * выключен). Такую строку пишет сама кнопка «Launch now» (тем же решением
 * heEngAutoLaunchVerdict, что у тика), а тика, который её перепроверит, нет:
 * фразы autoLaunchLine «starts by itself», «we try again by ourselves», «we’ll
 * try again at …» здесь неправда, а прежний откат на зелёное «Ready to send»
 * прятал причину — и каждое нажатие повторяло тот же отказ (аудит 14.10.2026).
 * Здесь — причина последней попытки без обещания автоматического старта.
 * «Launch now» остаётся: только её нажатие перепроверит строку (тупик без
 * кнопки, когда команда уже всё поправила, хуже повторного отказа).
 * Потолки — нейтрально («a usage limit»): spend_day_limit пишут и потолок
 * клиента, и потолок проекта, и общий потолок ENG.
 * null — строке сказать нечего: решает нынешний выключатель отправки
 * аккаунта (launchNowAccessLine у общей строки «Ready»), а у писем —
 * ветка переписки карточки (`needsRewrite`).
 */
function manualHeldLine(
  row: EngAutoLaunchMarket,
  launched: boolean,
  access: EngSendingAccessState | undefined,
): MarketLine | null {
  const rest = 'Part of this market’s audience has not gone out yet';
  switch (row.code) {
    case 'sending_not_enabled':
    case 'sending_turned_off':
    case 'letters_need_rewrite':
      return null;
    case 'setup_unavailable':
    case 'mailboxes_short':
      return {
        text: launched
          ? `${rest}: the mailboxes your campaigns send from are not set up for your account yet. Message Support, and press «Launch now» once they are ready.`
          : 'Sending can’t start yet: the mailboxes your campaigns send from are not set up for your account. Message Support, and press «Launch now» once they are ready.',
        tone: 'amber',
        actions: ['launch_now'],
      };
    case 'spend_limit':
      return {
        text: launched
          ? `${rest}: adding the rest is on hold because a usage limit was reached. Message Support to raise the limit, then press «Launch now».`
          : 'Sending for this market is on hold because a usage limit was reached. Message Support to raise the limit, then press «Launch now».',
        tone: 'amber',
        actions: ['launch_now'],
      };
    case 'spend_day_limit':
      return {
        text: launched
          ? `${rest}: adding the rest is on hold because a usage limit for the last 24 hours was reached. Press «Launch now» again later, or message Support.`
          : 'Sending for this market is on hold because a usage limit for the last 24 hours was reached. Press «Launch now» again later, or message Support.',
        tone: 'amber',
        actions: ['launch_now'],
      };
    case 'email_not_verified':
      return {
        text: launched
          ? `${rest}: the rest can be added once you confirm your email. Confirm it, then press «Launch now».`
          : 'Sending can’t start until you confirm your email. Confirm it, then press «Launch now».',
        tone: 'amber',
        actions: ['resend', 'launch_now'],
      };
    case 'unavailable':
      return {
        text: launched
          ? `${rest}. We could not finish our checks on the last try. Press «Launch now» to try again.`
          : 'Sending has not started: we could not finish our checks on the last try. Press «Launch now» to try again.',
        tone: 'muted',
        actions: ['launch_now'],
      };
    case 'research_running':
      return {
        text: launched
          ? `${rest}. Waiting for the research to finish; then press «Launch now» to add the rest.`
          : 'Waiting for the research to finish; then press «Launch now» to start sending.',
        tone: 'muted',
        actions: ['launch_now'],
      };
    default:
      // account_blocked, needs_support и прочие: фразы autoLaunchLine
      // автоматического старта не обещают.
      return autoLaunchLine(row, launched, access);
  }
}

/**
 * Рынок, чьи письма «Rewrite letters» снял, а новые не написаны (генерация
 * упала, отменена или не встала): «Launch» здесь ничего не сдвинет (реконсилер
 * считает шаблон рынка существующим), поэтому — «Rewrite letters» на снятом
 * шаблоне, пока у аудитории есть попытки, и Support, когда их 0. «Nothing was
 * sent» — правда: роут переписки не снимает письма с записью о запуске и не
 * трогает рынок, у которого запущены другие письма.
 *
 * `sendingOff` — выключатель отправки аккаунта 'revoked' (так и после
 * разблокировки, пока сотрудник не включит отправку): «Rewrite letters» тогда
 * откажет 403 sending_turned_off — кнопки нет, вместо «Press» строка доступа.
 * Попытки, которые кончились, — прежняя фраза: она зовёт в Support и кнопку не
 * называет.
 */
function retiredLine(
  tries: { left: number; max: number } | { error: true } | null,
  teamFix: boolean,
  sendingOff: boolean,
  /**
   * Наш бренд в полях брифа шага 1 (`letters_brand_inputs`): роут переписки
   * откажет 409 brand_input, пока поле его называет, — фраза сначала зовёт
   * поправить поле, потом «Rewrite letters».
   */
  brandInputs: ReturnType<typeof engLettersBrandInputs> = [],
): MarketLine {
  const head = 'New letters for this market were not written, so nothing was sent from it.';
  if (tries && 'left' in tries && tries.left <= 0) {
    return {
      text: `${head} All ${tries.max} letter-writing tries for this audience are used — message Support to get new letters.`,
      tone: 'amber',
      actions: [],
    };
  }
  if (sendingOff) {
    return {
      text: teamFix ? `${head} ${ENG_TEAM_FIX_STOP_EN} ${ENG_SENDING_OFF_EN}` : `${head} ${ENG_SENDING_OFF_EN}`,
      tone: 'red',
      actions: [],
    };
  }
  // Новые письма не написал отказ, который чинит команда: нажатие до починки
  // упрётся в тот же отказ и съест попытку — сначала Support (кнопка остаётся
  // вторым шагом, вторичной).
  if (teamFix) {
    return {
      text: `${head} ${ENG_TEAM_FIX_STOP_EN} ${engTeamFixThenText('Rewrite letters')}`,
      tone: 'amber',
      actions: ['rewrite'],
    };
  }
  if (brandInputs.length > 0) {
    return { text: `${head} ${engLettersBrandInputText(brandInputs, 'rewrite')}`, tone: 'amber', actions: ['rewrite'] };
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

/**
 * Остановку стадии рынка чинит только команда (EngTeamFixStop деталки,
 * engDashboard.ts): проверка контактов ('check' — только
 * когда «Launch» её заново ставит, иначе карточка и так зовёт в Support),
 * итоговые письма ('final_letters') или новые письма «Rewrite letters»
 * ('rewrite'). Кнопка до починки упрётся в тот же отказ, поэтому карточка
 * зовёт сначала в Support, как письмо об этой остановке. Решает ТЕКУЩАЯ
 * остановка карточки: идущая работа, готовые письма или другая база — не она.
 */
export type EngMarketTeamFix = 'check' | 'final_letters' | 'rewrite';

function marketTeamFixOf(view: MarketView, detail: EngDetail): EngMarketTeamFix | null {
  const stops = detail.team_fix_stops;
  if (!stops || stops.length === 0 || view.template || view.templateJob) return null;
  if (view.retired) return engTeamFixStopOf(stops, 'template', view.retired.base_id) ? 'rewrite' : null;
  const { base } = view;
  if (base) {
    if (base.status === 'analyzed' && base.row_count > 0) {
      return engTeamFixStopOf(stops, 'template', base.id) ? 'final_letters' : null;
    }
    if (base.status === 'analyzing' && engBaseAnalysisStopped(base) && engTeamFixStopOf(stops, 'base_analyze', base.id)) {
      const chains = (detail.chains ?? []) as unknown as Array<Record<string, unknown>>;
      const requeues =
        detail.project.status === 'researched' &&
        view.selected &&
        detail.project.autopilot_hold?.code !== 'spend_paused' &&
        engAnalysisRequeues(
          base as unknown as Record<string, unknown>,
          view.ownBases as unknown as Array<Record<string, unknown>>,
          chains.filter((c) => c.vertical_id === view.vertical.id),
        );
      return requeues ? 'check' : null;
    }
    return null;
  }
  return null;
}

/**
 * Выбранные рынки, чью текущую остановку чинит только команда
 * (marketTeamFixOf) — для шапки мастера (EngProjectWizard): «Launch» их до
 * починки не сдвинет, и общая фраза «press «Launch»» про них неправда.
 */
export function engTeamFixMarkets(detail: EngDetail): Array<{ id: string; name: string; fix: EngMarketTeamFix }> {
  if (!detail.team_fix_stops || detail.team_fix_stops.length === 0) return [];
  const selected = new Set(heEngSelectedVerticalIds((detail.hypotheses ?? []) as HeHypothesis[]));
  const out: Array<{ id: string; name: string; fix: EngMarketTeamFix }> = [];
  for (const vertical of (detail.verticals ?? []) as HeVertical[]) {
    if (!selected.has(vertical.id)) continue;
    const fix = marketTeamFixOf(buildMarketView(detail, vertical, true), detail);
    if (fix) out.push({ id: vertical.id, name: vertical.name, fix });
  }
  return out;
}

/** «A problem on our side stopped it; … then press «Launch».» — как письмо (совет 'team_fix'). */
const TEAM_FIX_LAUNCH_NEXT = `${ENG_TEAM_FIX_STOP_EN} ${engTeamFixThenText('Launch')}`;

/**
 * Готовый к «Launch now» рынок, которому кнопку откажет выключатель отправки
 * аккаунта (GET …/launch): 'revoked' — выключен сотрудником, 'not_enabled' —
 * ждёт разовой проверки командой (тогда письмо «Sending is on» зовёт нажать
 * «Launch now» там, где кнопка есть). Строка без кнопки; иначе — как была.
 */
function launchNowAccessLine(
  line: MarketLine | null,
  access: EngSendingAccessState | undefined,
  launched: boolean,
): MarketLine | null {
  if (!line || !line.actions.includes('launch_now')) return line;
  const actions = line.actions.filter((a) => a !== 'launch_now');
  if (access === 'revoked') {
    return { text: ENG_SENDING_OFF_EN, tone: 'red', actions };
  }
  if (access === 'not_enabled') {
    return {
      text: launched
        ? 'Part of this market’s audience has not gone out yet. The rest can be added after a one-time check of your account by our team — we’ll email you when it’s on; then press «Launch now» here.'
        : 'Ready. Sending can start after a one-time check of your account by our team — we’ll email you when it’s on; then press «Launch now» here.',
      tone: 'muted',
      actions,
    };
  }
  return line;
}

function preparingLine(
  view: MarketView,
  ctx: {
    researched: boolean;
    spendPaused: boolean;
    teamFix: EngMarketTeamFix | null;
    /** Подпись «Launch N more markets», если рынок начинает она; иначе null. */
    moreLabel: string | null;
    /**
     * Выключатель отправки аккаунта 'revoked' (так и после разблокировки, пока
     * сотрудник не включит отправку): «Launch» вверху выключена, роут ответил
     * бы 403 — к ней не зовём; что делать, говорит красная строка доступа
     * вверху шага.
     */
    launchBlocked: boolean;
    /**
     * Наш бренд в полях брифа шага 1 (`letters_brand_inputs` проекта): пока
     * это так, письма рынка не пишутся (стадии отказывают до платных вызовов),
     * и «Launch» без правки поля их не напишет — остановка писем говорит, что
     * поправить.
     */
    brandInputs: ReturnType<typeof engLettersBrandInputs>;
  },
): MarketLine | null {
  const { base } = view;
  const teamFixNext = ctx.launchBlocked ? ENG_TEAM_FIX_STOP_EN : TEAM_FIX_LAUNCH_NEXT;
  const brandInputLine: MarketLine | null =
    ctx.brandInputs.length > 0 && !ctx.spendPaused
      ? { text: engLettersBrandInputText(ctx.brandInputs, ctx.launchBlocked ? 'none' : 'launch'), tone: 'amber', actions: [] }
      : null;
  if (view.templateJob) return { text: 'Writing the letters…', tone: 'muted', spinner: true, actions: [] };
  if (base) {
    // Идущую сборку описывает её собственный прогресс (CollectProgress).
    if (base.status === 'collecting') return null;
    if (base.status === 'analyzing' && !engBaseAnalysisStopped(base)) {
      return { text: 'Checking the contacts…', tone: 'muted', spinner: true, actions: [] };
    }
    if (base.status === 'analyzed') {
      const collectionTarget = engCollectionTargetView(base);
      if (collectionTarget?.shortfall) {
        return {
          text: base.row_count > 0
            ? 'The collection ended below its target. Review the saved contacts before writing letters.'
            : 'The collection ended below its target. No contacts are ready in the first batch.',
          tone: 'amber',
          actions: [],
        };
      }
      if (base.row_count <= 0) {
        return {
          text: 'The latest collection came back with no contacts, so there is nothing to send from it. Message Support.',
          tone: 'amber',
          actions: [],
        };
      }
      // Итоговые письма «Launch» ставит, только пока бюджет писем не исчерпан —
      // фраза с запасным Support, как у строки ниже.
      if (brandInputLine && ctx.teamFix !== 'final_letters') {
        return ctx.launchBlocked
          ? brandInputLine
          : { ...brandInputLine, text: engLettersBrandInputText(ctx.brandInputs, 'launch_or_support') };
      }
      return {
        text: ctx.spendPaused
          ? `The contacts are ready, and the letters have not been written yet. ${SPEND_PAUSED_NEXT}`
          : ctx.teamFix === 'final_letters'
            ? `The contacts are ready, and writing the letters stopped. ${teamFixNext}`
            : ctx.launchBlocked
              ? 'The contacts are ready, and the letters have not been written yet.'
              : 'The contacts are ready, and the letters have not been written yet. If nothing is running on this project, press «Launch» above to move it on; if that does not help, message Support.',
        tone: ctx.teamFix === 'final_letters' && !ctx.spendPaused ? 'amber' : 'muted',
        actions: [],
      };
    }
    // 'failed' и остановленный анализ — своими ветками карточки (с кнопками).
    return null;
  }
  if (view.selected && ctx.researched) {
    // Старые черновики и их ошибки не мешают начать сбор базы.
    return ctx.spendPaused
      ? { text: `Contact collection has not started yet. ${SPEND_PAUSED_NEXT}`, tone: 'muted', actions: [] }
      : ctx.launchBlocked
        ? { text: 'Contact collection has not started yet.', tone: 'muted', actions: [] }
        : ctx.moreLabel
        ? { text: `Contact collection has not started yet — press «${ctx.moreLabel}» above to start it.`, tone: 'muted', actions: [] }
        : { text: 'Contact collection has not started yet — press «Launch» above to start it.', tone: 'muted', actions: [] };
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
  moreLabel,
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
  /** Подпись «Launch N more markets», если этот рынок начинает она; иначе null. */
  moreLabel: string | null;
  onChanged: () => void;
}) {
  const { vertical, template, launch, row, base, ownBases, retired } = view;
  const teamFix = marketTeamFixOf(view, detail);
  const [busy, setBusy] = useState<'launch_now' | 'rewrite' | 'collect' | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);
  const [showLetters, setShowLetters] = useState(false);
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
  /** Причины `needs_rewrite` (подстановки / чужая компания) и наш бренд в полях брифа шага 1. */
  const rewriteReasons = template ? engTemplateRewriteReasons(template) : null;
  const brandInputs = engLettersBrandInputs(detail.project);
  const dots = marketDots(view);
  const runDays = template ? engLaunchRunDays(template as { launch_info?: unknown }) : null;
  const refillTotal = (detail.refill_totals ?? []).find((r) => r.vertical_id === vertical.id) ?? null;
  /**
   * Отправка аккаунта выключена сотрудником ('revoked'; так и после
   * разблокировки, пока сотрудник не включит отправку). Тогда откажут 403
   * sending_turned_off «Launch» вверху (она выключена), «Launch now»,
   * «Rewrite letters» и «Collect again» карточки, а старт блока отправки не
   * рисует сводка: ни одна строка карточки к ним не зовёт, а кнопки карточки
   * не рисуются — вместо «нажмите» строка доступа (ENG_SENDING_OFF_EN).
   */
  const launchBlocked = sendingAccess === 'revoked';

  // Строка состояния и кнопки — по старшинству: запуск → автозапуск → подготовка.
  let line: MarketLine | null = null;
  const extra: MarketLine[] = [];
  if (launch) {
    if (incomplete) {
      if (needsRewrite) {
        line = { text: engTemplateNeedsRewriteText('unfinished', false, rewriteReasons), tone: 'amber', actions: [] };
      } else if (autoOn && row && (row.state === 'waiting' || row.state === 'running')) {
        line = autoLaunchLine(row, true, sendingAccess);
      } else if (row?.state === 'running') {
        line = autoLaunchLine(row, true, sendingAccess);
      } else if (row?.state === 'held') {
        // Строку держит гейт (лимиты, ящики, настройка, проверки, отказ
        // запуска, блокировка) — его фраза, а не «Press «Launch now»». Без
        // автозапуска её написала сама «Launch now» — причина без обещания
        // старта «by itself» (manualHeldLine).
        line = autoOn ? autoLaunchLine(row, true, sendingAccess) : manualHeldLine(row, true, sendingAccess);
      }
      if (!line && !needsRewrite) {
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
        // часах) — сначала Support: тот же шаг и те же слова, что у заметки
        // запуска и письма об этой строке (engClientLaunch,
        // ENG_SUPPORT_BEFORE_START_TEXT).
        // Под выключенной отправкой аккаунта кнопки старта у блока нет (его
        // пояснение говорит, что отправка выключена) — без ««Start sending»».
        text: launchBlocked
          ? 'Starting this market ran into a problem. Message Support.'
          : 'Starting this market ran into a problem. Message Support before pressing «Start sending».',
        tone: 'amber',
        actions: [],
      };
    } else if (row?.state === 'done' && row.code === 'cancelled') {
      // Тик создал кампании, а перед стартом увидел, что автозапуск сняли
      // (heEngStartGate → readHeEngLaunchStillWanted: желание снято, автопилот
      // выключен или отмена новее нажатия) — кампании не стартованы. Старт —
      // кнопка блока отправки выше (её текст и наличие решает сводка).
      line = {
        // Под выключенной отправкой аккаунта старта у блока нет — без «shows
        // how to start it» (пояснение блока говорит, что отправка выключена).
        text: launchBlocked
          ? 'Sending was not started because automatic launch was turned off while this market was being launched.'
          : 'Sending was not started because automatic launch was turned off while this market was being launched. The sending status above shows how to start it.',
        tone: 'amber',
        actions: [],
      };
    }
  } else if (template) {
    if (needsRewrite) {
      // «Rewrite letters» под выключенной отправкой аккаунта откажет — без кнопки.
      line = launchBlocked
        ? { text: engTemplateNeedsRewriteText('none', true, rewriteReasons), tone: 'red', actions: [] }
        : { text: engTemplateNeedsRewriteText('none', false, rewriteReasons, brandInputs), tone: 'amber', actions: ['rewrite'] };
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
    } else if (row?.state === 'held') {
      // Автозапуска нет, а строку 'held' написала «Launch now» (ящики,
      // настройка, потолки, почта, проверки): её причина, а не зелёное
      // «Ready to send» — иначе каждое нажатие молча повторяет отказ.
      line = manualHeldLine(row, false, sendingAccess);
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
            text: `New letters for this market were not written, so nothing was sent from it. ${SPEND_PAUSED_NEXT}`,
            tone: 'amber',
            actions: [],
          }
        : retiredLine(retiredTries, teamFix === 'rewrite', launchBlocked, brandInputs);
  } else {
    line = preparingLine(view, {
      researched,
      spendPaused: detail.project.autopilot_hold?.code === 'spend_paused',
      teamFix,
      moreLabel,
      launchBlocked,
      brandInputs,
    });
  }
  // «Launch now» откажет выключатель отправки аккаунта — строка без кнопки.
  line = launchNowAccessLine(line, sendingAccess, incomplete);

  // Остановленная сборка и остановленный анализ — своим текстом с действием.
  // Отправка аккаунта выключена ('revoked'): новую сборку ставят только
  // «Launch» вверху (выключена) и «Collect again» (откажет 403, кнопки нет) —
  // вместо «что делать» строка доступа (engBaseStopSendingOffText).
  const latest = ownAutoBaseState(ownBases).latest;
  const againBaseId = collectAgainBaseId(ownBases, researched, view.selected);
  let stopText = '';
  if (!template && !view.templateJob && latest && latest.status === 'failed' && base?.id === latest.id) {
    const offersRestart = stopTextOffersRestart(latest, ownBases);
    stopText = !offersRestart
      ? engEarlierBaseStopText(latest.error_code ?? null)
      : launchBlocked
        ? engBaseStopSendingOffText(latest.error_code ?? null)
        : latest.error_code
          ? engStageErrorText(latest.error_code, 'collection')
          : `${ENG_NO_REASON_BASE_HEAD_EN} If you still need this market, press «Launch» above to start a new collection for it; message Support if it keeps stopping.`;
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
        // поставит (письмо об этой остановке тоже зовёт в Support). Анализ
        // остановил отказ, который чинит команда, — сначала Support, как в
        // письме (совет 'team_fix'). «Launch» выключена (launchBlocked) — к
        // ней не зовём.
        (requeues && !launchBlocked
          ? teamFix === 'check'
            ? ` ${TEAM_FIX_LAUNCH_NEXT} The contacts already collected are not bought again.`
            : ' Press «Launch» above to check them again; the contacts already collected are not bought again.'
          : teamFix === 'check'
            ? ` ${ENG_TEAM_FIX_STOP_EN}`
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
          ? 'We are writing new letters for this market. It starts sending by itself when they are ready and pass the check.'
          : 'We are writing new letters for this market. When they are ready, press «Launch now» on this market to start sending.',
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
          {/* Примерный срок отправки (engClientLaunch.heEngLaunchRunDays, записан при
              запуске) — только у законченного запуска: у незаконченного часть
              аудитории ещё не в кампаниях. */}
          {!incomplete && runDays !== null && (
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              {runDaysText(runDays)}
            </span>
          )}
          {/* Ночной добор рынка одним итогом: его прогоны базами не приходят
              (роут деталки, foldFinishedRefillBases). */}
          {refillTotal && (
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              {refillTotalText(refillTotal)}
            </span>
          )}
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
      {base && base.status !== 'collecting' && <EngCollectionTargetSummary base={base} />}
      {/* Объём «к отправке» — до запуска рынка, в том числе у готовых
          итоговых писем, которые ждут автозапуска или «Launch now»; после
          запуска строка выше печатает факт (`leads_count`). */}
      {base && !launch && <SendVolume base={base} />}
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
          // Остановку чинит команда — кнопка второй шаг после Support, не первый.
          <button
            type="button"
            onClick={() => void runRewrite()}
            disabled={busy !== null}
            className={`${teamFix === 'rewrite' ? 'ds-btn-secondary' : 'ds-btn-primary'} inline-flex items-center gap-1.5 text-xs`}
          >
            {busy === 'rewrite' ? <EngSpinner className="h-3 w-3" /> : <Wand2 className="h-3 w-3" />}
            Rewrite letters
          </button>
        )}
        {againBaseId !== null && latest?.id === againBaseId && !template && !launchBlocked && (
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

  // Прежние 8 — только для подбора по браузеру; в выпадашке — полный список, если он пришёл.
  const timezones = useMemo(() => (info && Array.isArray(info.timezones) ? info.timezones : []), [info]);
  /**
   * Пояс по странам проекта. Сервер отдаёт его под тем же выключателем, что и
   * полный список (HE_ENG_TIMEZONES_ALL), и отправляет в нём (launchSchedule,
   * источник 'suggested'), когда клиент пояс не выбрал, — значит, и редактор
   * обязан открыться на нём. Если пояса среди пунктов всё же нет, дописываем
   * его в конец пунктом с понятной подписью (смещения из Intl, а не название
   * из идентификатора: Arctic/Longyearbyen стоит здесь за Амстердам и Берлин).
   */
  const suggestedTz =
    info && typeof info.suggested_timezone === 'string' && info.suggested_timezone ? info.suggested_timezone : null;
  const timezoneOptions = useMemo(() => {
    const list = info ? engTimezoneOptionsOf(info) : [];
    if (!suggestedTz || list.length === 0 || list.some((o) => o.value === suggestedTz)) return list;
    return [...list, { value: suggestedTz, label: engTimezoneFallbackLabel(suggestedTz, { suggested: true }) }];
  }, [info, suggestedTz]);
  const weekdays = useMemo(() => (info && Array.isArray(info.weekdays) ? info.weekdays : []), [info]);
  /**
   * Часы, с которых открывается редактор: сохранённые с «Launch»; иначе дефолт
   * сервера в поясе по странам проекта (`suggested_timezone`), иначе в поясе
   * браузера среди прежних 8, иначе как есть.
   */
  const baseWindow = useMemo<EngSendingWindow | null>(() => {
    if (!info) return null;
    if (info.schedule) return { ...info.schedule, days: [...info.schedule.days] };
    if (!info.default) return null;
    const startTz = suggestedTz ?? browserTimezoneIn(timezones);
    return { ...info.default, days: [...info.default.days], ...(startTz ? { timezone: startTz } : {}) };
  }, [info, timezones, suggestedTz]);
  const windowValue = windowDraft ?? baseWindow;
  const windowConfig: SendingWindowConfig | null =
    windowValue && timezoneOptions.length > 0 && weekdays.length > 0
      ? { value: windowValue, timezones: timezoneOptions, weekdays }
      : null;
  // Страны сбора без США, и сервер общий пояс не подсказал — просим выбрать.
  // Только при полном списке поясов: без него сервер подсказку не считает
  // вовсе, и фраза «страны в разных поясах» могла бы оказаться неправдой.
  const projectCountries = engCollectCountriesOf(detail.project.brief).countries;
  const fullTimezoneList = Array.isArray(info?.timezone_options) && (info?.timezone_options?.length ?? 0) > 0;
  const tzHint =
    info && fullTimezoneList && projectCountries.length > 0 && !projectCountries.includes(ENG_COUNTRY_US) && !suggestedTz
      ? MULTI_ZONE_HINT
      : undefined;
  const windowUsable = isSendingWindowUsable(windowConfig);

  const auto = detail.auto_launch ?? null;
  const available = auto?.available ?? info?.available ?? null;
  const requested = (auto?.requested ?? info?.requested) === true;
  const requestedAt = auto?.requested_at ?? info?.requested_at ?? null;
  const autoOn = requested && available !== false;
  const cancelledAt = !requested ? (auto?.cancelled_at ?? info?.cancelled_at ?? null) : null;
  // Выключатель отправки аккаунта: свежий из деталки (опрос мастера), иначе GET …/launch.
  const sendingAccess = engSendingAccessOf(detail.account_access, info?.sending_access);
  const access = accessLine(sendingAccess, available !== false);

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
   * ни джобы — даже упавших): их возьмёт «Launch» или «Launch N more markets».
   * Рынок с остановленной сборкой сюда не входит — «Launch» его заново не
   * соберёт, у него своя карточка с причиной и «Collect again». Правило одно
   * с роутом (heEngMarketPending); список джоб деталки капнут, и решает роут
   * по своему свежему чтению.
   */
  const pendingState = {
    chains: detail.chains ?? [],
    bases: detail.bases ?? [],
    templates: detail.templates ?? [],
    jobs: detail.jobs ?? [],
  };
  const pending = verticals.filter((v) => selectedSet.has(v.id) && heEngMarketPending(v.id, pendingState));
  const selectedNames = verticals.filter((v) => selectedSet.has(v.id)).map((v) => v.name);
  const cardVerticals = verticals.filter((v) => selectedSet.has(v.id) || startedIds.has(v.id));
  const fresh = !requested && startedIds.size === 0;
  const spendPaused = detail.project.autopilot_hold?.code === 'spend_paused';
  /**
   * «Launch N more markets» (решение владельца 12.10.2026: отмеченный после
   * «Launch» рынок стартует только явным нажатием): автозапуск проекта включён
   * (намерение и автопилот — то же условие, что у роута), есть нетронутые
   * выбранные рынки, нет паузы потолка расхода (реконсилер встал бы на
   * потолке) и отправка аккаунта не выключена (роут ответил бы 403).
   */
  const showMore =
    status === 'researched' &&
    autoOn &&
    detail.project.autopilot === true &&
    pending.length > 0 &&
    !spendPaused &&
    !access?.blocks;
  const moreLabel = showMore
    ? pending.length === 1
      ? 'Launch 1 more market'
      : `Launch ${pending.length} more markets`
    : null;
  const pendingIds = new Set(pending.map((v) => v.id));

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

  /** «Launch N more markets»: только нетронутые выбранные рынки, намерение не переписывается. */
  const onLaunchMore = async () => {
    if (launching || !showMore) return;
    setLaunching(true);
    setError('');
    setRefusal(null);
    setResult(null);
    const names = new Map(verticals.map((v) => [v.id, v.name]));
    try {
      const res = await launchEngProjectMarkets(
        projectId,
        pending.map((v) => v.id),
      );
      setResult(launchMoreResultText(res, (id) => names.get(id) ?? 'a market'));
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
  // Research, ждущий описания бизнеса (heProjectAwaitsDescription), — пауза до
  // ответа клиента, как в шапке мастера над карточкой, а не «stopped … tried
  // again»: повтора у этого кода нет, шаг 1 просит 2–3 предложения.
  if (status !== 'researched' && cardVerticals.length === 0) {
    return (
      <EngCard>
        <p className="m-0 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          {status === 'researching'
            ? 'Launch opens as soon as the research of your business finishes and you have chosen your markets — step 1 «Your business» shows how far the research has got.'
            : heProjectAwaitsDescription(status, detail.project.error_code)
              ? 'Launch opens once you describe your business in 2–3 sentences on step 1 «Your business», the research finishes and you have chosen your markets on step 2.'
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
  // карточек рынков. Нетронутые рынки при включённом автозапуске начинает
  // отдельная главная кнопка «Launch N more markets» (showMore), и тогда
  // «Launch» — вторичная.
  const launchPrimary = fresh || !requested || (pending.length > 0 && !showMore);

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
      {/* Подсказка про пояса стран — и у свёрнутой сводки: иначе клиент с
          европейским списком запустил бы рынок по часам Детройта, не открыв
          редактор. В открытом редакторе она стоит под выпадашкой поясов. */}
      {tzHint && windowConfig && !editingWindow && (
        <span className="text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          {tzHint}
        </span>
      )}
      {editingWindow && windowConfig && (
        <>
          <SendingWindowEditor
            config={windowConfig}
            onChange={setWindowDraft}
            disabled={launching || savingWindow}
            hint={tzHint}
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
                  {/* При выключенной отправке аккаунта «Launch now» на
                      карточках нет (launchNowAccessLine) — не зовём. */}
                  {access?.blocks
                    ? 'We find and check contacts, then write the letters. Automatic sending is not available right now.'
                    : 'We find and check contacts, then write the letters. Automatic sending is not available right now, so when a market is ready, press «Launch now» on it to start sending.'}
                </span>
              ) : (
                <>
                  <span>
                    We find and check contacts, then write the letters and start sending by ourselves.
                    {typeof prepareHours === 'number' && prepareHours > 0
                      ? ` Getting a market ready to send usually takes ${prepareTimeText(prepareHours)} (based on recent projects).`
                      : ''}
                  </span>
                  <span>We&apos;ll email you when sending starts, or if something stops and needs you.</span>
                </>
              )}
              <span style={{ color: 'var(--cp-text-l)' }}>
                Each market&apos;s letters show up under «Preview letters» as soon as they are written.
              </span>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-xs" style={{ color: 'var(--cp-text-m)' }}>
              {launchHeaderText({ requested, available, requestedAt, cancelledAt, blocked: Boolean(access?.blocks) })}
            </p>
            {pending.length > 0 && (
              <p className="m-0 mt-2 text-xs" style={{ color: 'var(--cp-paper)' }}>
                {/* Рынки, отмеченные после «Launch», сами не стартуют (решение
                    владельца по умолчанию: ждут нового нажатия) — фраза говорит
                    это прямо. */}
                {/* Под паузой потолка расхода «Launch» их не начнёт
                    (реконсилер встаёт на потолке) — звать к нему нельзя. При
                    выключенной отправке аккаунта (access.blocks) «Launch»
                    выключена, а «Launch N more markets» скрыта — тоже не
                    зовём: что делать, говорит красная строка доступа ниже. */}
                {[
                  pending.length === 1
                    ? `1 market you chose has not started yet: ${pending[0].name}.`
                    : `${pending.length} markets you chose have not started yet: ${namesList(pending.map((v) => v.name))}.`,
                  spendPaused
                    ? SPEND_PAUSED_NEXT
                    : access?.blocks
                      ? ''
                      : moreLabel
                        ? `Ticking a market starts nothing by itself — press «${moreLabel}» to start ${pending.length === 1 ? 'it' : 'them'}.`
                        : pending.length === 1
                          ? 'It starts when you press «Launch» again — a market ticked after a launch does not start by itself.'
                          : 'They start when you press «Launch» again — markets ticked after a launch do not start by themselves.',
                ]
                  .filter(Boolean)
                  .join(' ')}{' '}
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
          {showMore && moreLabel && (
            <button
              type="button"
              onClick={() => void onLaunchMore()}
              disabled={launching}
              className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
            >
              {launching ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
              {moreLabel}
            </button>
          )}
          {launchButton}
          {/* Не «любой остановившийся»: снятые письма, сборку с повторяющейся
              остановкой, анализ без повторной постановки и всё под паузой
              потолка «Launch» не двигает — у них на карточке своя кнопка или
              Support. При выключенной отправке аккаунта кнопка выключена —
              подсказки про неё нет. */}
          {launchButton && !fresh && !launchPrimary && !access?.blocks && (
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
            sendingAccess={sendingAccess}
            launchSchedule={windowConfig && windowUsable ? windowConfig.value : undefined}
            moreLabel={pendingIds.has(v.id) ? moreLabel : null}
            onChanged={onChanged}
          />
        ))}
    </div>
  );
}
