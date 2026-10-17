'use client';

/**
 * Command Center (/client/eng/dashboard): общий экран по всем ENG-проектам
 * клиента. IA карточки вертикали — «карта пайплайна»: вертикальный список
 * стадий человеческими именами (Research → Lead base → Email
 * enrichment → Analysis → Letters → Launch, у запущенной вертикали + Daily top-up)
 * с маркерами done/current/future и короткими доказательствами цифрами из
 * агрегата; строка «next: …» внизу — следующий шаг конвейера.
 *
 * Данные — один агрегат GET /api/client/eng/dashboard, опрос раз в 15с
 * (в скрытой вкладке сервер не дёргаем); countdown и анимации — чисто
 * клиентские (CSS keyframes + rAF), realtime-подписок нет. Тексты — английские.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Database,
  LayoutGrid,
  Mail,
  PenLine,
  RefreshCw,
  Rocket,
  UserRound,
  Wand2,
} from 'lucide-react';
import {
  EngPaidAccessError,
  fetchEngDashboard,
  setEngProjectTopUp,
  type EngDashboardActiveJob,
  type EngDashboardEvent,
  type EngDashboardVertical,
  type EngDashboardResponse,
  type EngTopUpSwitchOutcome,
} from './api-client';
import {
  ENG_REFILL_SPEND_PAUSED_SHORT_EN,
  ENG_SENDING_OFF_EN,
  engAutopilotHoldText,
  engDashAttentionText,
  engRefillHoldText,
  engSendingTag,
  engStartButtonOf,
} from './engText';
import { EngPaidAccessNotice, EngSupportText, EngVerifyEmailBanner } from './EngPaidAccess';
import { EngSendingBlock } from './EngSending';
import {
  ENG_NEEDS_DESCRIPTION_SHORT_EN,
  ENG_NEEDS_INPUT_LABEL_EN,
  HE_RESEARCH_NEEDS_DESCRIPTION_CODE,
  HE_TEAM_ON_IT_SHORT_EN,
} from './clientFailureText';
// Только тип — см. пояснение в engText.ts: набор состояний один на оба конца
// провода, а сам модуль проекции в клиентский бандл не уезжает.
import type { HeClientRefillState } from '@/lib/hypothesisEngine/clientEngProjection';
// Тоже только тип, и по той же причине: набор этапов и причин 'attention' —
// один на роут и экран, его знает engDashboard.ts (deriveEngVerticalStage).
import type { EngDashAttentionInfo, EngDashStage } from '@/lib/hypothesisEngine/engDashboard';
import { EngBadge, EngCard, EngSpinner } from './ui';

const POLL_INTERVAL_MS = 15000;

/* ── Статус вертикали: dot + uppercase mono-tag (status-tag из DESIGN.md).
   Цвет — только как данные: amber — работа идёт или нужен шаг клиента,
   grey — этап пройден, конвейер ждёт следующего, или вертикаль не выбрана
   ('not_selected'), red — вертикаль встала на сбое ('attention'). У запущенной
   вертикали тег — статус отправки (сводка `sending`: зелёный «sending» только
   по прочитанному статусу кампаний у рассыльщика, sendingStatusOf ниже). ── */

type StageStatus = { tag: string; dot: string; text: string };

const STAGE_STATUS: Record<EngDashStage, StageStatus> = {
  research: { tag: 'research', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  letters: { tag: 'letters', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  collecting: { tag: 'collecting', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  construct: { tag: 'enrichment', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  analyzing: { tag: 'analysis', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  analyzed: { tag: 'analyzed', dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
  template: { tag: 'ready to launch', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  // Запуск записан, но не закончен — его достраивает шаг 3 (автозапуск или
  // «Launch now»), поэтому amber.
  launch_unfinished: { tag: 'launch unfinished', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  // Сводки отправки нет (ответ старше S2) — «launched»: верно при любом
  // статусе кампаний. Со сводкой тег — её статус (sendingStatusOf).
  launched: { tag: 'launched', dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
  // Умолчание этапа; подпись по причине — attentionStatus ниже.
  attention: { tag: 'needs attention', dot: 'var(--cp-red)', text: 'var(--cp-red)' },
  // Решение клиента, а не сбой и не работа: серый, без пульса и без «next».
  not_selected: { tag: 'not selected', dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
};

const TONE_STATUS: Record<'green' | 'amber' | 'red' | 'neutral', { dot: string; text: string }> = {
  green: { dot: 'var(--cp-green)', text: 'var(--cp-green)' },
  amber: { dot: 'var(--cp-amber)', text: 'var(--cp-amber)' },
  red: { dot: 'var(--cp-red)', text: 'var(--cp-red)' },
  neutral: { dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' },
};

/** Тег запущенной вертикали по сводке отправки (engSendingTag). */
function sendingStatusOf(vertical: EngDashboardVertical): StageStatus | null {
  if (vertical.stage !== 'launched' || !vertical.sending) return null;
  const tag = engSendingTag(vertical.sending);
  return { tag: tag.label, ...TONE_STATUS[tag.tone] };
}

/**
 * Research ждёт описания бизнеса (код website_thin у 'project_failed'): не сбой,
 * а шаг клиента — янтарь легенды выше, без «needs attention» красным.
 */
function attentionAwaitsDescription(attention: EngDashAttentionInfo | null | undefined): boolean {
  return attention?.reason === 'project_failed' && attention.code === HE_RESEARCH_NEEDS_DESCRIPTION_CODE;
}

/**
 * Тег этапа 'attention' по причине. Красный — сбой (упавшая база, упавший
 * research); янтарь — тупик без сбоя (база вернулась пустой: решает команда через Support)
 * и research, ждущий описания бизнеса (шаг клиента);
 * серый — отмена, это решение человека, а не поломка.
 */
function attentionStatus(attention: EngDashAttentionInfo | null | undefined): StageStatus {
  if (!attention) return STAGE_STATUS.attention;
  if (attention.code === 'cancelled') {
    return { tag: 'cancelled', dot: 'var(--cp-grey)', text: 'var(--cp-paper-mute)' };
  }
  if (attentionAwaitsDescription(attention)) {
    return { tag: ENG_NEEDS_INPUT_LABEL_EN, dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
  }
  if (attention.reason === 'base_empty') {
    return { tag: 'needs attention', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
  }
  return STAGE_STATUS.attention;
}

/**
 * Следующий шаг вертикали в 'attention' — туда, где полный текст причины и
 * действия, а не пересказ его здесь:
 *  - база (сбой или отмена) — карточка рынка шага 3 печатает у упавшей базы
 *    объяснение по коду причины вместе с «что делать» (engStageErrorText) и
 *    «Collect again», а без причины — свою фразу с действием;
 *  - пустая база — у клиента хода нет: автопилот считает 'analyzed'-базу
 *    готовой и новую сборку не ставит, а шаблон по пустой базе не строится —
 *    поэтому Support (чат кабинета, отвечает команда);
 *  - research — шаг 1: «Try again» там есть только после технического сбоя
 *    (решение владельца 10.10.2026), иначе шаг говорит, почему повтора нет
 *    (там же «Last error» шапки проекта, если причина записана);
 *  - остановленный анализ — «Launch» шага 3: при `requeues` кнопка
 *    ставит базе base_analyze заново, строки не покупаются второй раз
 *    (autopilotReconcile.ts, ремонт осиротевшей базы); иначе результат нажатия
 *    зависит от формы (цепочка, новая сборка, пауза по потолку расхода — под
 *    ней `requeues` ложно), и строка называет только саму кнопку — что ещё
 *    нужно (выбрать рынок, перезапустить research), пишет шаг 3.
 */
function attentionNextLine(attention: EngDashAttentionInfo | null | undefined): string {
  switch (attention?.reason) {
    case 'base_empty':
      return 'next: message Support about this market';
    case 'project_failed':
      return attentionAwaitsDescription(attention)
        ? 'next: open step 1 «Your business» and describe your business in 2–3 sentences'
        : 'next: open step 1 «Your business» — it shows whether the research can be tried again';
    case 'analysis_stopped':
      // Без `requeues` «Launch» этот анализ заново не ставит — тот же Support,
      // что у карточки рынка на шаге 3 и в письме об этой остановке. Анализ
      // остановил отказ, который чинит команда (`teamFix`), — «Launch» до
      // починки упрётся в него же: сначала Support, как в письме.
      return attention.requeues
        ? attention.teamFix === true
          ? TEAM_FIX_LAUNCH_NEXT_LINE
          : 'next: «Launch» on step 3 checks the contacts again'
        : 'next: message Support about this market';
    default:
      return 'next: step 3 «Launch» says what to do';
  }
}

/**
 * Почему анализ базы не идёт — одна фраза под картой пайплайна. Причины в
 * колонке у такой базы нет (финальный фейл анализа базу не пишет), поэтому
 * текст свой: отмена — отменой, остальное (упал, не был поставлен, исход не
 * прочитан) — «остановился, не закончив».
 */
function analysisStoppedText(code: 'cancelled' | null): string {
  return code === 'cancelled'
    ? 'Analyzing the latest base of this market was cancelled before it finished.'
    : 'Analyzing the latest base of this market stopped before it finished.';
}

/**
 * Письма шаблона этапа запуск откажет (`letters_need_rewrite` агрегата: роут
 * считает признак проекции `needs_rewrite`, heTemplateNeedsRewrite, для
 * шаблона этапа 'template' или 'launch_unfinished'). Нет поля (ответ старше)
 * — false, подписи прежние.
 */
function lettersNeedRewrite(vertical: EngDashboardVertical): boolean {
  return vertical.letters_need_rewrite === true;
}

/** Тег вместо «ready to launch»: шаблон есть, но запуск его письма откажет. */
const LETTERS_REWRITE_STATUS: StageStatus = {
  tag: 'letters need rewriting',
  dot: 'var(--cp-amber)',
  text: 'var(--cp-amber)',
};
/**
 * Следующий шаг такой вертикали — «Rewrite letters» на карточке рынка шага 3
 * (новые итоговые письма в пределах бюджета генераций; исчерпан — отказ
 * кнопки ведёт в Support). Незаконченный запуск кнопка не переписывает —
 * у него Support (LETTERS_REWRITE_UNFINISHED_NEXT_LINE).
 */
const LETTERS_REWRITE_NEXT_LINE = 'next: press «Rewrite letters» on step 3 «Launch»';
const LETTERS_REWRITE_UNFINISHED_NEXT_LINE = 'next: message Support to have the letters rewritten';

/**
 * Письма сняты «Rewrite letters», а новые не написаны (`letters_retired`
 * агрегата): «Launch» рынок не двигает. На шаге 3 у карточки рынка — «Rewrite
 * letters», пока у аудитории есть попытки, иначе Support; сколько попыток
 * осталось, знает только шаг 3 (GET …/rewrite), поэтому кнопку здесь не
 * называем.
 */
const LETTERS_RETIRED_STATUS: StageStatus = {
  tag: 'letters not written',
  dot: 'var(--cp-amber)',
  text: 'var(--cp-amber)',
};
const LETTERS_RETIRED_NEXT_LINE = 'next: step 3 «Launch» shows how to get new letters';

/**
 * Остановку этапа чинит только команда (`team_fix` агрегата, EngDashTeamFix;
 * у остановленного анализа — `attention.teamFix`): кнопка до починки упрётся в
 * тот же отказ, поэтому сначала Support, потом кнопка — как письмо об этой
 * остановке (engClientMail, совет 'team_fix') и карточка рынка шага 3.
 */
const TEAM_FIX_LAUNCH_NEXT_LINE = 'next: message Support to find out when it is fixed, then press «Launch» on step 3';
const TEAM_FIX_REWRITE_NEXT_LINE =
  'next: message Support to find out when it is fixed, then press «Rewrite letters» on step 3';

/**
 * «Launch now» откажет выключатель отправки аккаунта (`account_access`
 * агрегата): выключен — Support; ждёт разовой проверки командой — после неё
 * (письмо «Sending is on» зовёт нажать «Launch now» там, где кнопка есть).
 */
function launchNowBlockedLine(access: 'not_enabled' | 'revoked' | null | undefined): string | null {
  if (access === 'revoked') return 'next: message Support — sending is turned off for your account';
  if (access === 'not_enabled') {
    return 'next: after a one-time check of your account by our team, press «Launch now» on step 3 «Launch»';
  }
  return null;
}

const JOB_STAGE_LABELS: Record<string, string> = {
  site_profile: 'profiling the site',
  competitors: 'mapping competitors',
  brand_cloud: 'building brand cloud',
  hypotheses: 'drafting hypotheses',
  evidence: 'collecting evidence',
  clustering: 'grouping ideas into markets',
  chain: 'writing letters',
  vocab: 'building vocabulary',
  base_collect: 'collecting the base',
  base_analyze: 'analyzing the base',
  template: 'building the template',
  dossier: 'writing the dossier',
};

/**
 * Шаг мастера проекта, куда ведёт кнопка вертикали (мастер из трёх шагов):
 *  - шаг 1 «Your business» — пока идёт research и когда он встал («Try
 *    again» или почему его нет);
 *  - шаг 2 «Choose markets» — рынок не выбран: там его отмечают;
 *  - шаг 3 «Launch» — всё от писем и дальше: прогресс рынка, его кнопки
 *    («Launch now», «Collect again», «Rewrite letters», «Resume daily
 *    top-up») и блок отправки.
 */
function wizardStepFor(vertical: EngDashboardVertical): number {
  switch (vertical.stage) {
    case 'research':
      return 1;
    case 'not_selected':
      return 2;
    case 'attention':
      return vertical.attention?.reason === 'project_failed' ? 1 : 3;
    default:
      return 3;
  }
}

/**
 * Готовый рынок и его автозапуск (`auto_launch` агрегата): тег карточки и
 * строка «next». Нет автозапуска — ждёт «Launch now» на шаге 3.
 */
function autoLaunchStatus(vertical: EngDashboardVertical): StageStatus | null {
  const auto = vertical.auto_launch;
  if (vertical.stage !== 'template' || !auto) return null;
  switch (auto.state) {
    case 'waiting':
      // Не пробованный тиком рынок при выключателе аккаунта держится им —
      // тот же тег, что у строки 'held' с этой причиной.
      if (auto.code === null && auto.access) return { tag: 'on hold', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
      return { tag: 'starting', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
    case 'running':
      return { tag: 'starting', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
    case 'held':
      return { tag: 'on hold', dot: 'var(--cp-amber)', text: 'var(--cp-amber)' };
    case 'failed':
      return { tag: 'not started', dot: 'var(--cp-red)', text: 'var(--cp-red)' };
    case 'done':
      // У шаблона без записи о запуске 'done' — только 'needs_support' (запись
      // не легла): не «ready to launch», шаг 3 зовёт в Support.
      return auto.code === 'needs_support' ? { tag: 'not started', dot: 'var(--cp-red)', text: 'var(--cp-red)' } : null;
  }
}

function templateNextLine(vertical: EngDashboardVertical, access: 'not_enabled' | 'revoked' | null | undefined): string {
  const auto = vertical.auto_launch;
  if (!auto) return launchNowBlockedLine(access) ?? 'next: press «Launch now» on step 3 «Launch» to start sending';
  switch (auto.state) {
    case 'waiting':
      // 'waiting' без кода — то же правило, что у строки рынка на шаге 3:
      // выключатель аккаунта держит старт, а ожидание дольше обычного даёт там
      // «Launch now».
      if (auto.code !== null) return 'next: we try to start sending again — step 3 «Launch» shows when';
      if (auto.access === 'not_enabled') return 'next: sending starts after a one-time check of your account by our team';
      if (auto.access === 'revoked') return 'next: message Support — sending is turned off for your account';
      if (auto.stale === true) {
        return launchNowBlockedLine(access) ?? 'next: press «Launch now» on step 3 «Launch» to start it yourself';
      }
      return 'next: sending starts automatically';
    case 'running':
      // Брошенная попытка (`stale`): на шаге 3 у рынка «Launch now».
      return auto.stale === true
        ? (launchNowBlockedLine(access) ?? 'next: press «Launch now» on step 3 «Launch» to try again')
        : 'next: starting sending…';
    case 'held':
    case 'failed':
      return 'next: step 3 «Launch» says what is needed';
    case 'done':
      // 'done' у шаблона без записи о запуске — только 'needs_support'
      // (запись не легла): отправки нет, шаг 3 зовёт в Support.
      return auto.code === 'needs_support' ? 'next: step 3 «Launch» says what is needed' : 'next: step 3 «Launch» shows its sending';
  }
}

/* ── Анимированный счётчик (ease-out нарастание при изменении значения) ── */

function CountUp({ value, style }: { value: number; style?: React.CSSProperties }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    // prefers-reduced-motion: без нарастания — сразу финальное значение
    // (matchMedia может отсутствовать в jsdom — тогда анимируем как обычно).
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (from === to || reduceMotion) {
      setDisplay(to);
      fromRef.current = to;
      return;
    }
    let raf = 0;
    const started = performance.now();
    const DURATION = 700;
    const tick = (t: number) => {
      const p = Math.min(1, (t - started) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span className="ds-mono" style={style}>
      {display.toLocaleString('en-US')}
    </span>
  );
}

/* ── Countdown до следующего авто-добора (тикает локально, без запросов) ── */

function RefillCountdown({ nextRunAt }: { nextRunAt: string }) {
  const target = Date.parse(nextRunAt);
  // Текущее время — состояние, тикает раз в секунду; остаток выводится на
  // рендере (setState только в callback интервала, без sync-стейта в effect).
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const leftMs = Math.max(0, target - nowTs);
  if (leftMs <= 0) {
    return (
      <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-amber)' }}>
        starting…
      </span>
    );
  }
  const totalSec = Math.floor(leftMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="ds-mono text-base font-medium tabular-nums" style={{ color: 'var(--cp-paper)' }}>
      {pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

/* ── Карта пайплайна вертикали ── */

/** Человеческие имена стадий конвейера (без внутреннего жаргона этапов). */
interface PipeRow {
  key: string;
  label: string;
  state: 'done' | 'current' | 'future';
  /**
   * Маркер текущей строки: amber — работа идёт (точка пульсирует), held —
   * остановлено и само не возобновится (точка янтарная, неподвижная),
   * green — идущий ночной добор (точка зелёная, неподвижная), red — вертикаль
   * встала на сбое, quiet — остановлена отменой или выключена клиентом (обе
   * неподвижные).
   */
  marker?: 'amber' | 'green' | 'held' | 'red' | 'quiet';
  /** Короткое доказательство цифрами; только то, что есть в агрегате. */
  evidence?: React.ReactNode;
}

/** Индекс текущей стадии в пайплайне (0 Research … 5 Launch). */
function currentIndexFor(vertical: EngDashboardVertical): number {
  switch (vertical.stage) {
    case 'research':
      return 0;
    case 'attention':
      return vertical.attention?.reason === 'project_failed'
        ? 0
        : vertical.attention?.reason === 'analysis_stopped'
          ? 3
          : 1;
    case 'not_selected':
      return -1;
    case 'collecting':
      return 1;
    case 'construct':
      return 2;
    case 'analyzing':
      return 3;
    case 'analyzed':
    case 'letters':
      return 4;
    case 'template':
    case 'launch_unfinished':
    case 'launched':
      return 5;
  }
}

/**
 * Что кабинет говорит про ночной добор («daily top-up» — тем же словом, что
 * переключатель проекта ниже) одной строкой — по ВСЕМ пяти состояниям
 * проекта, без шестого «наверное».
 *
 * `paused` НЕ схлопывается в `not configured`: добор настроен и нужен, просто
 * сегодня его некуда грузить, и обещать «next run 03:20 UTC» проекту, который
 * ночь пропустит, нельзя (эта фраза и была ложью до правки). Срок здесь не
 * называется намеренно: возвращает проект в добор сотрудник, руками, и когда
 * освободится место — кабинет не знает. Причину не называем (решение владельца
 * 04.10.2026): короткая общая фраза справочника, правдивая потому, что пауза по
 * ёмкости шлёт алерт команде (см. HE_TEAM_ON_IT_EN в clientFailureText.ts).
 *
 * `spend_paused` — та же колонка, записанная потолком расхода проекта: алерт
 * у неё есть, но это не сбой, и «временная проблема» про неё неправда —
 * короткая фраза в духе HE_SPEND_PAUSED_EN (ENG_REFILL_SPEND_PAUSED_SHORT_EN).
 *
 * `stopped` — та же колонка паузы, но записанная отменой проекта («Cancel all
 * jobs»): алерта у неё нет, проблемы на нашей стороне нет, и снимает её сам
 * клиент переключателем «Daily top-up» (S2, switchHeUsRefill в autoPipeline.ts).
 *
 * `off` — конфига нет (запуска не было или он старше S2) ИЛИ клиент выключил
 * добор переключателем: фраза верна для обоих — переключатель «on» заводит
 * конфиг, если его нет, и включает выключенный. У запущенной вертикали
 * переключатель её проекта всегда виден (DailyTopUpRow, блок «Daily top-up»).
 */
const REFILL_NEXT_LINE: Record<HeClientRefillState, string> = {
  running: 'next: daily top-up 03:20 UTC',
  paused: `next: daily top-up on hold — ${HE_TEAM_ON_IT_SHORT_EN}`,
  spend_paused: `next: daily top-up on hold — ${ENG_REFILL_SPEND_PAUSED_SHORT_EN}`,
  stopped: 'next: daily top-up is off since the project was cancelled — press «Turn on» under «Daily top-up»',
  off: 'next: daily top-up is off — press «Turn on» under «Daily top-up»',
};

/** То же коротко — в строку «Daily top-up» карты пайплайна. */
const REFILL_PIPE_EVIDENCE: Record<HeClientRefillState, string> = {
  running: 'next 03:20 UTC',
  paused: `on hold — ${HE_TEAM_ON_IT_SHORT_EN}`,
  spend_paused: 'on hold — paused on our side',
  stopped: 'off — project cancelled',
  off: 'off',
};

/**
 * Ночной добор ПРОЕКТА идёт, но ЭТУ вертикаль правило сухой вертикали с него
 * сняло (`refill_dry`). Только для `running`: у `paused`, `spend_paused`,
 * `stopped` и `off` своя, более общая правда — добора нет у всего проекта.
 */
const REFILL_DRY_NEXT_LINE = 'next: daily top-up paused for this market — press «Resume daily top-up» on step 3 «Launch»';
const REFILL_DRY_PIPE_EVIDENCE = 'paused for this market';

/**
 * Ночной добор ПРОЕКТА идёт (`running`), а ЭТУ вертикаль ночь пропустит. Решает
 * не сводка отправки (`sending.state === 'sending'` — «отправляет хоть одна
 * кампания»), а ОСНОВНАЯ кампания запуска, как у гейта ночи: при живой
 * сегментной и стоящей основной ночь вертикаль пропускает. Вердикт считает роут
 * (`top_up`, deriveEngTopUpVerdict в engDashboard.ts — порядок гейта
 * autoPipeline.ts, блок «КАМПАНИИ ЗАПУСКА ОТПРАВЛЯЮТ?»); что ночь
 * действительно пропустила, пишет лента («daily top-up skipped — …»).
 *
 * Действие — только то, что на карточке ЕСТЬ: кнопка старта блока отправки
 * (engStartButtonOf — «Start sending», «Start the rest» или «Resume»), а без
 * неё — Support. Основная кампания у запуска, разбитого по сегментам, —
 * «Default texts» (так её подписывает кабинет), у неразбитого — единственная.
 *
 * null — ночь вертикаль берёт (основная отправляет) или вердикта нет (запуска
 * нет, ответ старше этой правки). 'unknown' — статус основной не читался
 * полчаса: тик перед решением читает его сам, поэтому фраза условная и точка не
 * «held».
 */
function topUpSkipFor(vertical: EngDashboardVertical): { line: string; evidence: string; held: boolean } | null {
  const topUp = vertical.top_up;
  if (!topUp) return null;
  const s = vertical.sending ?? null;
  const campaign = topUp.split ? 'its «Default texts» campaign' : 'its campaign';
  const skip = (line: string, evidence: string) => ({ line: `next: daily top-up ${line}`, evidence, held: true });
  // Кампании без адресов кабинет не стартует вовсе (старт берёт только кампании
  // с адресами) — кнопки нет, и кабинет статус такой кампании не читает, так
  // что 'unknown' у неё не «прочитаем перед ночью», а тот же пропуск.
  const empty = s?.state === 'empty';
  switch (topUp.verdict) {
    case 'sending':
      return null;
    case 'access_not_enabled':
      return skip('waits until sending is on for your account', 'waits for sending to be on');
    case 'access_turned_off':
      return skip('skips this market — sending is turned off for your account; message Support', 'skipped — sending is off');
    case 'unavailable':
      return skip(
        'skips this market while we cannot check its campaigns — message Support if this stays',
        'skipped — campaigns not checked',
      );
    case 'client_paused':
      // Пауза клиента, а часть кампаний ещё отправляет (пауза не дошла до
      // рассыльщика) — кнопка на карточке «Pause», не «Resume». Запуск до
      // self-serve отправки кабинет не стартует вовсе: «Resume» у него нет, и
      // фраза не обещает, что клиент вернёт его сам. Сводки нет — не знаем,
      // какой это запуск: без обещания.
      return skip(
        s?.action === 'resume'
          ? 'skips this market while you keep it paused — press «Resume» to include it'
          : s?.pre_self_serve
            ? 'skips this market while it is paused — it was created before sending was set up for your project, ' +
              'so only Support can start it again'
            : s
              ? 'skips this market while you keep it paused'
              : 'skips this market while it is paused',
        'skipped — paused by you',
      );
    case 'pre_self_serve':
      return skip(
        'skips this market — its campaigns were created before sending was set up for your project; message Support',
        'skipped — created before self-serve sending',
      );
    case 'no_main':
      return skip(
        'skips this market — its launch has no «Default texts» campaign; message Support',
        'skipped — no «Default texts» campaign',
      );
    case 'campaign_completed':
      return skip(`skips this market — ${campaign} has completed; message Support to continue it`, 'skipped — campaign completed');
    case 'campaign_stopped':
      return skip(`skips this market until ${campaign} is sending again — message Support`, 'skipped — campaign stopped');
    case 'campaign_not_sending': {
      if (empty) {
        return skip(
          'skips this market — its campaigns have no contacts and were not started; message Support',
          'skipped — campaigns not started',
        );
      }
      const button = s ? engStartButtonOf(s) : null;
      return skip(
        `skips this market until ${campaign} is sending — ${button ? `press «${button}»` : 'message Support'}`,
        'skipped — campaign not sending',
      );
    }
    case 'unknown':
      if (empty) {
        return skip(
          'skips this market — its campaigns have no contacts and were not started; message Support',
          'skipped — campaigns not started',
        );
      }
      return {
        line: `next: daily top-up 03:20 UTC — it first checks that ${campaign} is sending`,
        evidence: 'next 03:20 UTC, if sending',
        held: false,
      };
  }
}

/**
 * Возьмёт ли ближайшая ночь вертикаль — для счёта идущих проектов в карточке
 * «Daily top-up» блока Today: у неё запись о запуске (этап 'launched' или
 * 'launch_unfinished' — тик берёт любую запись с основной кампанией), проект
 * идёт, правило сухой вертикали её не сняло, и пропуска нет либо он условный
 * ('unknown': статус прочитают перед решением).
 */
function topUpTakesVertical(vertical: EngDashboardVertical, refill: HeClientRefillState): boolean {
  if (vertical.stage !== 'launched' && vertical.stage !== 'launch_unfinished') return false;
  if (refill !== 'running' || vertical.refill_dry === true) return false;
  const skip = topUpSkipFor(vertical);
  return skip === null || !skip.held;
}

/** Строка «next: …» — следующий шаг конвейера из текущей стадии. */
function nextLineFor(
  vertical: EngDashboardVertical,
  refill: HeClientRefillState,
  dry: boolean,
  rewrite: boolean,
  access: 'not_enabled' | 'revoked' | null | undefined,
): string {
  const stage = vertical.stage;
  // Отправка аккаунта выключена ('revoked'; так и после разблокировки, пока
  // сотрудник не включит отправку): «Launch» шага 3 выключена, а «Launch now»,
  // «Rewrite letters» и «Collect again» откажут 403 sending_turned_off, и шаг 3
  // их не рисует — к ним не зовём, а ведём в Support.
  const launchOff = access === 'revoked' ? launchNowBlockedLine(access) : null;
  // Шаблон этапа запуск откажет: ни «launch», ни «finish the launch» не сработают.
  if (rewrite && stage === 'template') return launchOff ?? LETTERS_REWRITE_NEXT_LINE;
  if (rewrite && stage === 'launch_unfinished') return LETTERS_REWRITE_UNFINISHED_NEXT_LINE;
  // Пауза по потолку расхода: ни автопилот, ни «Launch» следующую платную
  // стадию не поставят (реконсилер встаёт на потолке) — к кнопке не зовём.
  const spendHeld = `next: on hold — ${ENG_REFILL_SPEND_PAUSED_SHORT_EN}`;
  // Остановку чинит команда: сначала Support, потом кнопка (не под паузой
  // потолка расхода — там кнопку не зовут вовсе: у снятых писем карточка
  // шага 3 тогда без «Rewrite letters», а роут переписки откажет потолком).
  if (vertical.team_fix === 'rewrite' && vertical.spend_paused !== true) return launchOff ?? TEAM_FIX_REWRITE_NEXT_LINE;
  if (vertical.letters_retired === true) {
    return vertical.spend_paused === true ? spendHeld : (launchOff ?? LETTERS_RETIRED_NEXT_LINE);
  }
  if ((vertical.team_fix === 'letters' || vertical.team_fix === 'final_letters') && vertical.spend_paused !== true) {
    return launchOff ?? TEAM_FIX_LAUNCH_NEXT_LINE;
  }
  // Письма после проверки базы ставит только автопилот
  // (autopilotNext.ts). Выключен — никто не поставит, пока клиент не нажмёт
  // «Launch» шага 3 (реконсилер включает автопилот и ставит недостающее); не
  // прочитан — ни того, ни другого не обещаем.
  const autopilot = vertical.autopilot;
  switch (stage) {
    case 'research':
      return 'next: choose your markets';
    case 'letters':
      return 'next: review the letters on step 3 «Launch»';
    case 'collecting':
      return 'next: email enrichment (after collection)';
    case 'construct':
      return 'next: analysis (after enrichment)';
    case 'analyzing':
    case 'analyzed':
      // Без внутреннего «85/15» — это доля текста шаблона, а не шаг клиента.
      if (vertical.spend_paused === true) return spendHeld;
      return autopilot === true
        ? 'next: writing letters for the checked contacts'
        : autopilot === false
          ? (launchOff ?? 'next: press «Launch» on step 3 «Launch» to have the letters written')
          : 'next: step 3 «Launch» shows what comes next';
    case 'template':
      return templateNextLine(vertical, access);
    case 'launch_unfinished':
      // «Само» — только пока строка ждёт следующей попытки или идёт: 'done'
      // (сдался после трёх достроек) и 'held' тик сам не достроит — тогда
      // кнопка, как у карточки рынка на шаге 3.
      // Брошенная попытка ('running' со `stale`) сама не достроится, если
      // автозапуск проекта выключен, — тогда кнопка, как на шаге 3.
      // Строку держит выключатель аккаунта при включённом автозапуске — тик
      // достроит сам после проверки (строка 'held' перепроверяется).
      if (vertical.auto_launch?.state === 'held' && vertical.auto_launch.code === 'sending_not_enabled') {
        return 'next: we finish the launch after a one-time check of your account by our team';
      }
      return vertical.auto_launch?.state === 'waiting' ||
        (vertical.auto_launch?.state === 'running' && vertical.auto_launch.stale !== true)
        ? 'next: we finish the launch automatically — step 3 «Launch» shows it'
        : (launchNowBlockedLine(access) ?? 'next: press «Launch now» on step 3 «Launch» to finish the launch');
    case 'launched':
      if (refill === 'running' && dry) return REFILL_DRY_NEXT_LINE;
      if (refill === 'running') return topUpSkipFor(vertical)?.line ?? REFILL_NEXT_LINE.running;
      return REFILL_NEXT_LINE[refill];
    case 'attention':
      // Повтор анализа ставит только «Launch» (`requeues`), новую сборку
      // остановленной базы — «Launch» или «Collect again» шага 3: при
      // выключенной отправке аккаунта обе откажут — Support.
      return launchOff &&
        ((vertical.attention?.reason === 'analysis_stopped' && vertical.attention.requeues) ||
          vertical.attention?.reason === 'base_stopped')
        ? launchOff
        : attentionNextLine(vertical.attention);
    case 'not_selected':
      // Не «next: …»: шага конвейера нет, есть только выбор клиента — фраза
      // роута (engDashboard.ts), верная и для «гипотез нет вовсе».
      return vertical.stageDetail;
  }
}

function buildPipelineRows(
  vertical: EngDashboardVertical,
  job: EngDashboardActiveJob | undefined,
  refill: HeClientRefillState,
): PipeRow[] {
  const s = vertical.stats;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const launched = vertical.stage === 'launched';
  const launchUnfinished = vertical.stage === 'launch_unfinished';
  const attention = vertical.stage === 'attention';
  const notSelected = vertical.stage === 'not_selected';
  // Маркер строки, на которой вертикаль встала: тот же цвет, что у тега
  // (attentionStatus) — отмена серая, пустая база и research, ждущий описания
  // бизнеса, янтарные, сбой красный.
  const attentionMarker: PipeRow['marker'] =
    vertical.attention?.code === 'cancelled'
      ? 'quiet'
      : vertical.attention?.reason === 'base_empty' || attentionAwaitsDescription(vertical.attention)
        ? 'held'
        : 'red';
  // Признак ставится только шаблону этапа 'template' / 'launch_unfinished'.
  const rewrite = lettersNeedRewrite(vertical) && (vertical.stage === 'template' || launchUnfinished);
  // Письма сняты, новых нет (этап 'analyzed'): строка Letters — текущая и
  // неподвижная, сама не сдвинется.
  const retired = vertical.letters_retired === true;
  const dryHere = refill === 'running' && vertical.refill_dry === true;
  const cur = currentIndexFor(vertical);
  // У невыбранного рынка отмечаем только реально завершённые этапы.
  const notSelectedDone = (i: number): boolean =>
    i === 0 ? vertical.dots[0] === true
      : i === 1 ? vertical.dots[1] === true
        : i <= 3 ? vertical.dots[2] === true
          : i === 4 ? vertical.dots[3] === true : false;
  const stateOf = (i: number): PipeRow['state'] =>
    notSelected
      ? notSelectedDone(i)
        ? 'done'
        : 'future'
      : launched || i < cur
        ? 'done'
        : i === cur
          ? 'current'
          : 'future';

  // ETA — только из данных: done/total активной джобы → «~N% done». Если
  // stageDetail уже несёт дробь («task 1/2», «87/147 valid»), не дублируем.
  const pct =
    job?.progress && (job.progress.total ?? 0) > 0
      ? Math.round(((job.progress.done ?? 0) / (job.progress.total ?? 1)) * 100)
      : null;
  const withEta = (text: string): string =>
    pct !== null && !text.includes('/') ? `${text} · ~${pct}% done` : text;

  // «Сколько собрано»: компании, если стадия их посчитала, иначе строки — и
  // тогда под своим именем. `stats.companies` (companies_total) у баз старше
  // 26.09.2026 нет, роут отдаёт 0; строки известны всегда, но строка ≠ компания
  // (ENG разносит один адрес на строку), поэтому делить их на кап и называть
  // компаниями нельзя — печатаем «rows». Обе цифры пусты → подписи нет.
  const collected = (prefix: string): string =>
    s.companies > 0
      ? `${prefix}${fmt(s.companies)} companies`
      : s.rows > 0
        ? `${prefix}${fmt(s.rows)} rows`
        : '';

  const rows: PipeRow[] = [
    {
      key: 'research',
      label: 'Research',
      state: stateOf(0),
      ...(attention && cur === 0 ? { marker: attentionMarker } : {}),
      // У research почти нет своих цифр — done-строка честно остаётся пустой.
      evidence:
        vertical.stage === 'research'
          ? withEta(vertical.stageDetail)
          : attention && cur === 0
            ? vertical.stageDetail
            : '',
    },
    {
      key: 'lead-base',
      label: 'Lead base',
      state: stateOf(1),
      ...(attention && cur === 1 ? { marker: attentionMarker } : {}),
      evidence:
        vertical.stage === 'collecting'
          ? withEta(vertical.stageDetail)
          : attention && cur === 1
            ? vertical.stageDetail
            : stateOf(1) === 'done'
              ? collected('')
              : '',
    },
    {
      key: 'enrichment',
      label: 'Email enrichment',
      state: stateOf(2),
      evidence:
        stateOf(2) !== 'future' && s.emails_found > 0
          ? `${fmt(s.valid_count)} / ${fmt(s.emails_found)} valid`
          : vertical.stage === 'construct'
            ? 'finding & validating emails…'
            : '',
    },
    {
      key: 'analysis',
      label: 'Analysis',
      state: stateOf(3),
      ...(attention && cur === 3 ? { marker: attentionMarker } : {}),
      evidence:
        vertical.stage === 'analyzing'
          ? withEta(vertical.stageDetail)
          : attention && cur === 3
            ? vertical.stageDetail
            : stateOf(3) === 'done'
              ? collected('analyzed ')
              : '',
    },
    {
      key: 'letters',
      label: 'Letters',
      state: stateOf(4),
      ...(retired ? { marker: 'held' as const } : {}),
      evidence: retired
        ? 'new letters not written'
        : stateOf(4) === 'done'
          ? rewrite
            ? 'letters need rewriting'
            : 'letters ready'
          : vertical.stage === 'letters' || (vertical.stage === 'analyzed' && job?.stage === 'template')
            ? withEta('writing letters…')
            : '',
    },
    {
      key: 'launch',
      label: 'Launch',
      state: stateOf(5),
      // Незаконченный запуск сам не достроится — точка неподвижная (held), а
      // не «идёт работа». Так же у шаблона, чьи письма запуск откажет: до
      // переписки писем запуска не будет.
      ...(launchUnfinished || rewrite ? { marker: 'held' as const } : {}),
      // White-label: имя кампании — подпись, а не ссылка. Наружу вести некуда:
      // у клиента нет своего входа в рассыльщик, а сама ссылка светила бы бренд.
      evidence: launchUnfinished ? (
        rewrite ? 'unfinished — these letters cannot finish it' : 'unfinished — step 3 finishes it'
      ) : launched ? (
        <>
          {s.leads_launched > 0 ? `${fmt(s.leads_launched)} leads` : ''}
          {s.leads_launched > 0 && vertical.launch?.campaign_name ? ' · ' : ''}
          {vertical.launch?.campaign_name && (
            <span style={{ color: 'var(--cp-paper)' }}>{vertical.launch.campaign_name}</span>
          )}
        </>
      ) : (
        ''
      ),
    },
  ];

  if (launched) {
    const refillRunning = job?.stage === 'base_collect';
    // Проект идёт, а кампании этой вертикали контакты не берут (topUpSkipFor):
    // ночь её пропустит — точка неподвижная, как у паузы.
    const skip = refill === 'running' && !dryHere ? topUpSkipFor(vertical) : null;
    rows.push({
      key: 'refill',
      label: 'Daily top-up',
      state: 'current',
      // Маркер — тоже утверждение, и под паузой оба прежних врали: зелёная
      // точка значит «живой цикл», пульсирующая янтарная — «прямо сейчас
      // работает». Остановленный добор не то и не другое, поэтому у него своя
      // точка: янтарная, но неподвижная — у пауз (ёмкость, потолок расхода).
      // Сухая вертикаль и вертикаль, чьи кампании контакты не берут, — тот же
      // «held»: проект идёт, а её ночь не берёт. Выключенный добор (`off` —
      // переключатель или конфига нет, `stopped` — отмена проекта) — решение
      // клиента, а не тревога: серая точка.
      marker: refillRunning
        ? 'amber'
        : refill === 'off' || refill === 'stopped'
          ? 'quiet'
          : refill === 'paused' || refill === 'spend_paused' || dryHere || skip?.held === true
            ? 'held'
            : 'green',
      evidence: refillRunning
        ? withEta('collecting new contacts…')
        : `${s.appended_today > 0 ? `+${fmt(s.appended_today)} today · ` : ''}${
            dryHere ? REFILL_DRY_PIPE_EVIDENCE : (skip?.evidence ?? REFILL_PIPE_EVIDENCE[refill])
          }`,
    });
  }

  return rows;
}

function PipelineRows({ rows }: { rows: PipeRow[] }) {
  return (
    <ol className="flex flex-col">
      {rows.map((row, i) => (
        <li key={row.key} className="flex items-stretch gap-2.5">
          {/* Маркер стадии + hairline-коннектор к следующей строке */}
          <span className="flex w-3 shrink-0 flex-col items-center">
            <span className="mt-[4px] flex h-3 w-3 items-center justify-center">
              {row.state === 'done' ? (
                <Check className="h-3 w-3" style={{ color: 'var(--cp-paper-mute)' }} aria-hidden />
              ) : row.state === 'current' ? (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    background:
                      row.marker === 'green'
                        ? 'var(--cp-green)'
                        : row.marker === 'red'
                          ? 'var(--cp-red)'
                          : row.marker === 'quiet'
                            ? 'var(--cp-grey)'
                            : 'var(--cp-amber)',
                    // Пульсирует только идущая работа (amber и строка без
                    // маркера); остальные маркеры — неподвижные.
                    animation:
                      row.marker === undefined || row.marker === 'amber'
                        ? 'eng-dash-pulse 1.6s ease-in-out infinite'
                        : undefined,
                  }}
                />
              ) : (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ border: '1px solid var(--cp-divider-strong)' }}
                />
              )}
            </span>
            {i < rows.length - 1 && (
              <span className="w-px flex-1" style={{ background: 'var(--cp-divider)' }} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 pb-2">
            <span
              className={`text-xs ${row.state === 'current' ? 'font-medium' : ''}`}
              style={{
                color:
                  row.state === 'done'
                    ? 'var(--cp-paper-mute)'
                    : row.state === 'current'
                      ? 'var(--cp-paper)'
                      : 'var(--cp-paper-faint)',
              }}
            >
              {row.label}
            </span>
            {row.evidence ? (
              <span
                className="ds-mono text-right text-[11px]"
                style={{
                  color: row.state === 'current' ? 'var(--cp-paper-mute)' : 'var(--cp-paper-faint)',
                }}
              >
                {row.evidence}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ── Лента событий ── */

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* Иконки ленты — lucide фиксированного размера; цвет только со смыслом:
   green — запуск/долив (заработанный плюс), red — сбой, amber — нужен шаг
   клиента (незаконченный запуск, как и у статуса вертикали), остальное —
   спокойный paper-faint. Никакой «радуги» по типам событий. */
const EVENT_ICON: Record<EngDashboardEvent['type'], { Icon: typeof Mail; color: string }> = {
  letters_ready: { Icon: Mail, color: 'var(--cp-paper-faint)' },
  base_collected: { Icon: Database, color: 'var(--cp-paper-faint)' },
  base_analyzed: { Icon: CheckCircle2, color: 'var(--cp-paper-faint)' },
  template_ready: { Icon: Wand2, color: 'var(--cp-paper-faint)' },
  launched: { Icon: Rocket, color: 'var(--cp-green)' },
  launch_unfinished: { Icon: Rocket, color: 'var(--cp-amber)' },
  refill_appended: { Icon: RefreshCw, color: 'var(--cp-green)' },
  refill_empty: { Icon: RefreshCw, color: 'var(--cp-paper-faint)' },
  // Research ждёт описания бизнеса — шаг клиента, не сбой: янтарь, как у
  // незаконченного запуска.
  needs_input: { Icon: PenLine, color: 'var(--cp-amber)' },
  failed: { Icon: AlertTriangle, color: 'var(--cp-red)' },
};

function EventRow({ event, withBorder }: { event: EngDashboardEvent; withBorder: boolean }) {
  const { Icon, color } = EVENT_ICON[event.type] ?? EVENT_ICON.refill_empty;
  return (
    <li
      className="flex items-center gap-2.5 py-1.5"
      style={withBorder ? { borderTop: '1px solid var(--cp-divider)' } : undefined}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
        <EngSupportText text={event.text} />
      </span>
      <span className="shrink-0 text-[10px] ds-mono" style={{ color: 'var(--cp-paper-faint)' }}>
        {relTime(event.at)}
      </span>
    </li>
  );
}

/* ── «Right now»: активные джобы строками в ds-card ── */

function ActiveJobsCard({
  jobs,
  verticalNames,
}: {
  jobs: EngDashboardActiveJob[];
  verticalNames: Map<string, string>;
}) {
  return (
    <section aria-label="Right now">
      <div className="ds-card px-4 py-3" style={{ animation: 'eng-dash-in 0.5s ease-out both' }}>
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: 'var(--cp-amber)', animation: 'eng-dash-pulse 1.2s ease-in-out infinite' }}
          />
          <span className="ds-eyebrow" style={{ color: 'var(--cp-amber)' }}>
            Right now
          </span>
        </div>
        <ul className="mt-1 flex flex-col">
          {jobs.map((job, i) => {
            // Незнакомая стадия — общее слово, а не сырое имя стадии из he_jobs.
            const label = JOB_STAGE_LABELS[job.stage] ?? 'working on your project';
            const verticalName = job.vertical_id ? (verticalNames.get(job.vertical_id) ?? '') : '';
            const progress =
              job.progress && (job.progress.total ?? 0) > 0
                ? `${job.progress.done ?? 0}/${job.progress.total}${job.progress.label ? ` · ${job.progress.label}` : ''}`
                : (job.progress?.label ?? '');
            return (
              <li
                key={job.id}
                className="flex items-baseline gap-3 py-1.5"
                style={i > 0 ? { borderTop: '1px solid var(--cp-divider)' } : undefined}
              >
                <span className="min-w-0 truncate text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
                  {label}
                  {verticalName ? ` · ${verticalName}` : ''}
                </span>
                {progress && (
                  <span
                    className="ml-auto shrink-0 ds-mono text-[11px]"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    {progress}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/* ── Карточка вертикали: заголовок + карта пайплайна + next + действия ── */

function VerticalCard({
  vertical,
  index,
  showProject,
  projectName,
  activeJob,
  refill,
  accountAccess,
  onSendingChanged,
}: {
  vertical: EngDashboardVertical;
  index: number;
  showProject: boolean;
  projectName: string;
  activeJob: EngDashboardActiveJob | undefined;
  /** Состояние ночного добора ПРОЕКТА этой вертикали, а не аккаунта. */
  refill: HeClientRefillState;
  /** Выключатель отправки аккаунта, когда он держит «Launch now» (`account_access`). */
  accountAccess: 'not_enabled' | 'revoked' | null | undefined;
  /** После Pause / Start sending / Resume — перечитать агрегат. */
  onSendingChanged: () => void;
}) {
  const step = wizardStepFor(vertical);
  const launched = vertical.stage === 'launched';
  const rewrite = lettersNeedRewrite(vertical);
  // Незаконченный запуск остаётся «launch unfinished» (это правда и с
  // признаком) — меняются его строка Launch и «next»; готовый шаблон теряет
  // «ready to launch».
  const status =
    vertical.stage === 'attention'
      ? attentionStatus(vertical.attention)
      : rewrite && vertical.stage === 'template'
        ? LETTERS_REWRITE_STATUS
        : vertical.letters_retired === true
          ? LETTERS_RETIRED_STATUS
          : (sendingStatusOf(vertical) ?? autoLaunchStatus(vertical) ?? STAGE_STATUS[vertical.stage]);
  const rows = buildPipelineRows(vertical, activeJob, refill);
  // Одна фраза под картой пайплайна — только там, где строке карты её не
  // вместить: почему вертикаль встала (engDashAttentionText). У запущенной
  // вертикали вместо фразы — блок отправки (статус, счётчики, кнопка).
  const note =
    vertical.stage === 'attention' && vertical.attention
      ? {
          text:
            vertical.attention.reason === 'analysis_stopped'
              ? analysisStoppedText(vertical.attention.code)
              : engDashAttentionText(vertical.attention),
          color: status.text,
        }
      : null;
  // Блок отправки — у любого записанного запуска, и у незаконченного тоже: его
  // уже созданные кампании стартуют и ставятся на паузу так же.
  const sendingTemplateId =
    (launched || vertical.stage === 'launch_unfinished') && vertical.sending
      ? (vertical.sending_template_id ?? null)
      : null;
  // Ночная сверка с датасетом (actualsReconcile) отстаёт от живых счётчиков
  // блока отправки на сутки: два разных «sent» на одной карточке читались бы
  // как противоречие. Есть живые счётчики — печатаем только их.
  const actual = vertical.sending && vertical.sending.sent !== null ? null : vertical.actual;

  return (
    <div
      data-testid="vertical-card"
      className="ds-card p-4 sm:p-5 flex flex-col gap-3"
      style={{ animation: `eng-dash-in 0.5s ease-out ${index * 70}ms both` }}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
          {vertical.name}
        </span>
        <span className="ds-status-tag ml-auto shrink-0" style={{ color: status.text }}>
          <span className="ds-status-dot" style={{ background: status.dot }} />
          {status.tag}
        </span>
      </div>
      {showProject && <div className="ds-eyebrow truncate">{projectName}</div>}

      <PipelineRows rows={rows} />

      {note && note.text && (
        <p className="text-xs m-0" style={{ color: note.color }}>
          <EngSupportText text={note.text} />
        </p>
      )}

      {sendingTemplateId && vertical.sending && (
        <EngSendingBlock
          templateId={sendingTemplateId}
          summary={vertical.sending}
          onChanged={onSendingChanged}
        />
      )}

      {(vertical.forecast || actual) && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] ds-mono"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {/* `forecast.pct` — potential_pct, ОЦЕНКА модели 0–100 (насколько
              вертикаль подходит рынку), а не прогноз доли ответов. Рядом с
              «actual N% replies» подпись «forecast N%» читалась как обещанная
              доля ответов — поэтому другое имя, без «%», и прямая оговорка.
              Сверка с фактом (actualsReconcile) не меняется: «actual» — та же
              строка рядом. */}
          {vertical.forecast && (
            <span>
              market fit <b style={{ color: 'var(--cp-paper-mute)' }}>{vertical.forecast.pct}</b>/100 — a model
              score, not a predicted reply rate
            </span>
          )}
          {actual && (
            <span>
              actual{' '}
              <b
                style={{
                  color: actual.reply_pct > 0 ? 'var(--cp-green)' : 'var(--cp-paper-mute)',
                }}
              >
                {actual.reply_pct}%
              </b>{' '}
              replies · {actual.sent.toLocaleString('en-US')} sent
            </span>
          )}
        </div>
      )}

      <div className="pt-2.5" style={{ borderTop: '1px solid var(--cp-divider)' }}>
        <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
          <EngSupportText text={nextLineFor(vertical, refill, vertical.refill_dry === true, rewrite, accountAccess)} />
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2">
        <Link
          href={`/client/eng/projects/${vertical.project_id}?step=${step}` as Route}
          prefetch={false}
          className="ds-btn-secondary ml-auto inline-flex items-center gap-1.5"
        >
          {launched ? 'View' : 'Continue'}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

/* ── Переключатель «Daily top-up» проекта ── */

/**
 * Состояние переключателя по состоянию ночного добора проекта
 * (`projects[].refill`, HeClientRefillState) — ВЕСЬ набор:
 *  - `running` — включён и идёт;
 *  - `paused` / `spend_paused` — включён, но стоит на паузе команды (ёмкость
 *    рассыльщика / потолок расхода): переключатель её не снимает, текст —
 *    тот же, что у блока паузы (engRefillHoldText);
 *  - `stopped` — выключен отменой проекта («Cancel all jobs»): «on» её снимает;
 *  - `off` — выключен клиентом или конфига нет (запуск до S2): «on» включает
 *    или заводит его.
 */
const TOP_UP_TAG: Record<HeClientRefillState, { label: string; tone: 'green' | 'amber' | 'neutral' }> = {
  running: { label: 'on', tone: 'green' },
  paused: { label: 'on hold', tone: 'amber' },
  spend_paused: { label: 'on hold', tone: 'amber' },
  stopped: { label: 'off', tone: 'neutral' },
  off: { label: 'off', tone: 'neutral' },
};

/**
 * Фраза состояния. `running` и `off` — свои; паузы и отмена — справочник
 * кабинета (engRefillHoldText), тот же, что был у блока объяснений: правда
 * про паузы у них одна. Каждая фраза верна при любом статусе кампаний: что
 * ночь пропускает вертикаль, чья основная кампания контакты не берёт (не
 * отправляет — кроме завершённой, которую ночь стартует снова: блок
 * «ЗАВЕРШЁННАЯ ОСНОВНАЯ» в autoPipeline.ts), говорит строка «next» её карточки
 * (topUpSkipFor), и `running` на неё ссылается.
 */
function topUpStateText(state: HeClientRefillState): string {
  switch (state) {
    case 'running':
      return 'On — each night from 03:20 UTC we look for new contacts and add them to the campaigns of this project; a market whose campaigns cannot take new contacts is skipped, and its «next» line says why.';
    case 'off':
      return 'Off — no new contacts are added to the campaigns of this project. Turn it on to look for new contacts each night (from 03:20 UTC) and add them to the campaigns that can take them.';
    default:
      return engRefillHoldText(state);
  }
}

/** Итог нажатия: исход роута и состояние добора после него. */
function topUpResultText(outcome: EngTopUpSwitchOutcome, refill: HeClientRefillState): string {
  if (outcome === 'turned_off') return 'The daily top-up is off.';
  if (outcome === 'already_off') return 'The daily top-up is already off.';
  if (refill === 'paused' || refill === 'spend_paused') {
    return 'The daily top-up is on, but it is on hold on our side — see the note above.';
  }
  if (refill !== 'running') return 'The daily top-up did not turn on. Try again in a moment.';
  return outcome === 'already_on'
    ? 'The daily top-up is already on.'
    : 'The daily top-up is on — the next one starts at 03:20 UTC.';
}

function DailyTopUpRow({
  projectId,
  projectName,
  showName,
  state,
  onChanged,
}: {
  projectId: string;
  projectName: string;
  showName: boolean;
  state: HeClientRefillState;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);
  // Включён — всё, что ночь читает как enabled (в том числе на паузе команды);
  // выключенный и отменённый включаются одной кнопкой.
  const on = state === 'running' || state === 'paused' || state === 'spend_paused';
  const tag = TOP_UP_TAG[state];

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setRefusal(null);
    try {
      const res = await setEngProjectTopUp(projectId, !on);
      const text = topUpResultText(res.outcome, res.refill);
      setResult({ tone: res.refill === 'running' || res.outcome === 'turned_off' || res.outcome === 'already_off' ? 'ok' : 'error', text });
      onChanged();
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setResult({ tone: 'error', text: e instanceof Error ? e.message : 'The request did not go through.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {showName && (
          <span className="truncate text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
            {projectName}
          </span>
        )}
        <EngBadge label={tag.label} tone={tag.tone} />
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          className={`${on ? 'ds-btn-secondary' : 'ds-btn-primary'} ml-auto inline-flex items-center gap-1.5 text-xs`}
        >
          {busy ? <EngSpinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
          {on ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <p className="text-[11px] m-0" style={{ color: state === 'paused' || state === 'spend_paused' ? 'var(--cp-amber)' : 'var(--cp-paper-mute)' }}>
        <EngSupportText text={topUpStateText(state)} />
      </p>
      {result && (
        <p className="text-[11px] m-0" style={{ color: result.tone === 'ok' ? 'var(--cp-paper-mute)' : 'var(--cp-amber)' }}>
          <EngSupportText text={result.text} />
        </p>
      )}
      {refusal && <EngPaidAccessNotice refusal={refusal} />}
    </div>
  );
}

/* ── Дашборд ── */

export function EngDashboard() {
  const [data, setData] = useState<EngDashboardResponse | null>(null);
  const [error, setError] = useState('');
  const loadingRef = useRef(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    // Тихий полл не плодит параллельные запросы при медленной БД.
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setData(await fetchEngDashboard());
      setError('');
    } catch (e) {
      if (!opts.silent) {
        setError(e instanceof Error ? e.message : 'Failed to load the Command Center');
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Один запрос агрегата раз в 15с; в фоновой вкладке сервер не дёргаем.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const projects = data?.projects ?? [];
  // Один аккаунт — один сайт: единственный проект, чей research ждёт описания
  // бизнеса, — пустая карточка рынков просит описание (рынков у него ещё нет).
  const awaitingProject = projects.length === 1 && projects[0].awaits_description === true ? projects[0] : null;
  const verticals: EngDashboardVertical[] = data?.verticals ?? [];
  const events = data?.events ?? [];
  const activeJobs = data?.activeJobs ?? [];
  const today = data?.today ?? { appended: 0, valid: 0, collected: 0 };
  /*
   * «Collected today» — КОМПАНИИ, когда роут их знает, иначе СТРОКИ под своим
   * именем (то же правило, что у карточки вертикали). Строки — не адреса: у
   * компании без найденного адреса одна пустая строка, и таких часто
   * большинство, поэтому подпись «address rows» над этим числом врала.
   * `collected_companies` = 0 при ненулевых строках значит «не знаем» (база без
   * счётчика компаний) — тогда печатаем строки.
   */
  const collectedCompanies = today.collected_companies ?? 0;
  const collectedTile =
    collectedCompanies > 0 || today.collected === 0
      ? { value: collectedCompanies, hint: 'companies collected' }
      : { value: today.collected, hint: 'rows collected, incl. companies with no address found' };
  const autoRefill = data?.autoRefill;
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  /**
   * Состояние ночного добора — ПО ПРОЕКТАМ, и весь набор целиком.
   *
   * Карточка «Daily top-up» одна на аккаунт, а пауза ставится проекту, поэтому
   * карточка печатает не одно состояние, а СОСТАВ: сколько проектов идёт,
   * сколько на паузе (по ёмкости — `paused`, по потолку расхода —
   * `spend_paused`; «on hold» правда про обе) и сколько остановлено отменой
   * (`stopped`); `off` в состав не входит — добора у него нет. Ветки карточки
   * ниже перебирают всё: есть идущие — обратный отсчёт и рядом счётчики
   * стоящих; идущих нет, но есть на паузе — «on hold» с фразой своего повода
   * (есть по ёмкости — её фраза и счётчик пауз по потолку рядом; только по
   * потолку — его фраза) и счётчик отменённых, если они тоже есть; только
   * отменённые — «stopped»; иначе — «off». Смешанный случай и есть тот, из-за
   * которого одного булева флага мало: обратный отсчёт для идущих правдив, но
   * умолчать про стоящие рядом с ним было бы тем же обещанием добора, которого
   * не будет.
   *
   * Поля может не быть (ответ старше этой волны) — читаем как `off`: до
   * механизма паузы кабинет ровно так и считал проект без конфига.
   */
  const refillByProject = new Map<string, HeClientRefillState>(
    projects.map((p) => [p.id, p.refill ?? 'off']),
  );
  const refillCapacityHeldCount = projects.filter((p) => p.refill === 'paused').length;
  const refillSpendHeldCount = projects.filter((p) => p.refill === 'spend_paused').length;
  const refillHeldCount = refillCapacityHeldCount + refillSpendHeldCount;
  const refillStoppedProjects = projects.filter((p) => p.refill === 'stopped');
  /*
   * «Идёт» — проект, который ближайшая ночь действительно обойдёт: добор
   * включён И хоть одну его запущенную вертикаль ночь возьмёт
   * (topUpTakesVertical — основная кампания отправляет или её статус прочитают
   * перед решением, вертикаль не сухая). Включённый проект, у которого ночь
   * пропустит каждую вертикаль, — `skipped`: обратный отсчёт для него обещал бы
   * добор, которого не будет; почему пропуск, говорит строка «next» вертикали.
   */
  const refillRunningProjects = projects.filter((p) => p.refill === 'running');
  const refillRunningCount = refillRunningProjects.filter((p) =>
    verticals.some((v) => v.project_id === p.id && topUpTakesVertical(v, 'running')),
  ).length;
  const refillSkippedCount = refillRunningProjects.length - refillRunningCount;
  /**
   * Переключатели «Daily top-up» (DailyTopUpRow) — у проекта, которому есть
   * что доливать: у него есть запуск (вертикаль 'launched' или
   * 'launch_unfinished' — запись о запуске с кампаниями) или у его добора уже
   * есть состояние кроме `off`. Проекту без запуска «on» ответил бы отказом
   * (роут: 'no_launch'), а `off` у него — правда без кнопки.
   */
  const launchedProjectIds = new Set(
    verticals.filter((v) => v.stage === 'launched' || v.stage === 'launch_unfinished').map((v) => v.project_id),
  );
  const topUpProjects = projects.flatMap((p) => {
    const state = p.refill ?? 'off';
    return state !== 'off' || launchedProjectIds.has(p.id) ? [{ id: p.id, name: p.name, state }] : [];
  });
  const projectsWord = (n: number) => `${n} project${n === 1 ? '' : 's'}`;
  // Хвост подписи про стоящие проекты — только ненулевые части.
  const stoppedSuffix = refillStoppedProjects.length > 0 ? ` · ${projectsWord(refillStoppedProjects.length)} stopped` : '';
  const skippedSuffix = refillSkippedCount > 0 ? ` · ${projectsWord(refillSkippedCount)} skipped` : '';
  // Паузы по потолку рядом с фразой паузы по ёмкости: у них своя правда.
  const spendHeldSuffix =
    refillSpendHeldCount > 0 ? ` · ${projectsWord(refillSpendHeldCount)} paused on our side` : '';
  // Проекты, которые автопилот не продвинул на последней сверке. Роут отдаёт
  // сюда только код причины и только по проектам без активных джоб, поэтому
  // здесь остаётся отобрать непустые — и сразу с СУЖЕННЫМ кодом, чтобы экран
  // не подпирал его восклицательным знаком.
  const heldProjects = projects.flatMap((p) =>
    p.autopilot_hold ? [{ id: p.id, name: p.name, hold: p.autopilot_hold }] : [],
  );
  const verticalNames = new Map(verticals.map((v) => [v.id, v.name]));
  // Джоба вертикали для ETA/живых подписей (свежие первыми — берём первую).
  const jobByVertical = new Map<string, EngDashboardActiveJob>();
  for (const job of activeJobs) {
    if (job.vertical_id && !jobByVertical.has(job.vertical_id)) {
      jobByVertical.set(job.vertical_id, job);
    }
  }

  return (
    <div className="eng-dash flex flex-col gap-5">
      <style>{`
        @keyframes eng-dash-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes eng-dash-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @media (prefers-reduced-motion: reduce) {
          .eng-dash, .eng-dash * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
            Command Center
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Live view across all your markets — refreshed every 15s.
          </p>
        </div>
        <Link
          href={'/client/eng/replies' as Route}
          prefetch={false}
          className="ds-btn-ghost ml-auto inline-flex items-center gap-1.5"
        >
          <Mail className="h-3.5 w-3.5" />
          Replies
        </Link>
        <Link
          href={'/client/eng?list=1' as Route}
          prefetch={false}
          className="ds-btn-ghost inline-flex items-center gap-1.5"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          All projects
        </Link>
        {/* Аккаунт (адрес входа, смена пароля) — ссылкой здесь, а не пунктом
            меню: набор пунктов меню закреплён (tests/lib/clientNav.test.ts). */}
        <Link
          href={'/client/eng/account' as Route}
          prefetch={false}
          className="ds-btn-ghost inline-flex items-center gap-1.5"
        >
          <UserRound className="h-3.5 w-3.5" />
          Account
        </Link>
      </header>

      <EngVerifyEmailBanner />

      {error && !data ? (
        <div className="ds-card p-5 text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          <EngSpinner /> Loading the command center…
        </div>
      ) : (
        <>
          {/* 01 → Today: три тихих счётчика + авто-добор */}
          <section aria-label="Today">
            <h2 className="ds-eyebrow mb-2">01 → Today</h2>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {(
                [
                  // Счётчики — тихие mono-числа + label, без hero-метрик;
                  // цвет только paper, статусной окраски у агрегатов дня нет.
                  // Единица «Collected today» выбрана выше (collectedTile).
                  { label: 'Collected today', value: collectedTile.value, hint: collectedTile.hint },
                  { label: 'Valid today', value: today.valid, hint: 'emails passed validation' },
                  { label: 'Appended today', value: today.appended, hint: 'leads added to campaigns' },
                ] as const
              ).map((card, i) => (
                <div
                  key={card.label}
                  className="ds-card p-4 flex flex-col gap-1"
                  style={{ animation: `eng-dash-in 0.5s ease-out ${i * 70}ms both` }}
                >
                  <span className="ds-eyebrow">{card.label}</span>
                  <CountUp
                    value={card.value}
                    style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--cp-paper)' }}
                  />
                  <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                    {card.hint}
                  </span>
                </div>
              ))}
              <div
                className="ds-card p-4 flex flex-col gap-1"
                style={{ animation: 'eng-dash-in 0.5s ease-out 210ms both' }}
              >
                <span className="ds-eyebrow">Daily top-up</span>
                {/* Обратный отсчёт показываем ровно тогда, когда в ближайшую
                    ночь реально пойдёт хотя бы один проект; если при этом
                    другие стоят, подпись их называет. Ни одного идущего —
                    отсчёта нет вовсе: тикать до ночи, которая проекту ничего
                    не поставит, и есть то самое обещание. */}
                {autoRefill && refillRunningCount > 0 ? (
                  <>
                    <RefillCountdown nextRunAt={autoRefill.next_run_at} />
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      next run 03:20 UTC · daily cap {autoRefill.daily_cap.toLocaleString('en-US')}
                      {refillHeldCount > 0 ? ` · ${projectsWord(refillHeldCount)} on hold` : ''}
                      {skippedSuffix}
                      {stoppedSuffix}
                    </span>
                  </>
                ) : refillHeldCount > 0 ? (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-amber)' }}>
                      on hold
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      {refillCapacityHeldCount > 0
                        ? `${HE_TEAM_ON_IT_SHORT_EN}${spendHeldSuffix}`
                        : ENG_REFILL_SPEND_PAUSED_SHORT_EN}
                      {skippedSuffix}
                      {stoppedSuffix}
                    </span>
                  </>
                ) : refillSkippedCount > 0 ? (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-amber)' }}>
                      skipped
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      as things stand, the next run skips{' '}
                      {projects.length === 1 ? 'your project' : projectsWord(refillSkippedCount)} — see the markets
                      below
                      {stoppedSuffix}
                    </span>
                  </>
                ) : refillStoppedProjects.length > 0 ? (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-paper-mute)' }}>
                      stopped
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      {refillStoppedProjects.length === 1 ? 'project' : 'projects'} cancelled — press «Turn on» under
                      «Daily top-up» below
                    </span>
                  </>
                ) : (
                  <>
                    <span className="ds-mono text-base font-medium" style={{ color: 'var(--cp-paper-faint)' }}>
                      off
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--cp-paper-faint)' }}>
                      {topUpProjects.length > 0
                        ? 'daily top-up is off — press «Turn on» under «Daily top-up» below'
                        : 'starts after your first launch'}
                    </span>
                  </>
                )}
              </div>
            </div>
          </section>

          {activeJobs.length > 0 && <ActiveJobsCard jobs={activeJobs} verticalNames={verticalNames} />}

          {/* Проект, который автопилот не продвинул. Место выбрано по вопросу,
              с которым клиент сюда и приходит: «почему ничего не происходит?» —
              поэтому блок стоит сразу под «Right now», где идущих стадий как
              раз нет. Ссылка ведёт в мастер проекта: там та же фраза и шаг 3 с
              «Launch»; собственной кнопки здесь нет намеренно —
              дашборд ничего не запускает. */}
          {heldProjects.length > 0 && (
            <EngCard className="flex flex-col gap-2">
              <span className="ds-eyebrow">Autopilot</span>
              {heldProjects.map((p) => (
                <Link
                  key={p.id}
                  href={`/client/eng/projects/${p.id}` as Route}
                  prefetch={false}
                  className="text-xs hover:underline"
                  style={{ color: 'var(--cp-amber)' }}
                >
                  <span className="font-semibold">{p.name}</span> —{' '}
                  {engAutopilotHoldText(p.hold.code, data?.account_access === 'revoked')}
                </Link>
              ))}
            </EngCard>
          )}

          {/* Переключатель «Daily top-up» каждого проекта с запуском (S2,
              решение владельца 10–11.10.2026: добор настраивается сам после
              первого запуска, включает и выключает его клиент). Состояние —
              весь набор HeClientRefillState (TOP_UP_TAG): у пауз команды
              (ёмкость — `paused`, потолок расхода — `spend_paused`) кнопка
              только выключает, а снимает их по-прежнему сотрудник — фраза
              паузы говорит это сама (engRefillHoldText); отмену проекта
              (`stopped`) и выключенный добор (`off`) кнопка включает
              (POST /eng/projects/[id]/refill, switchHeUsRefill). Отдельный
              блок, а не строка карточки «Daily top-up» выше: та отвечает
              «когда следующая ночь», здесь — что с добором и что с ним
              сделать. */}
          {topUpProjects.length > 0 && (
            <EngCard className="flex flex-col gap-3">
              <span className="ds-eyebrow">Daily top-up</span>
              {topUpProjects.map((p) => (
                <DailyTopUpRow
                  key={p.id}
                  projectId={p.id}
                  projectName={p.name}
                  showName={projects.length > 1}
                  state={p.state}
                  onChanged={() => void load({ silent: true })}
                />
              ))}
            </EngCard>
          )}

          {/* 02 → Verticals */}
          {verticals.length === 0 ? (
            <EngCard className="flex flex-col items-center gap-3 py-10 text-center">
              <Rocket className="h-8 w-8" style={{ color: 'var(--cp-paper-faint)' }} />
              {/* Один аккаунт — один сайт: «создать проект» — только когда
                  проектов нет; есть — путь в него (несколько — у аккаунта,
                  создавшего их до этого правила, — в список). */}
              <p className="text-sm font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
                {projects.length === 0
                  ? 'No project yet'
                  : awaitingProject
                    ? 'We need a short description of your business'
                    : 'No markets yet'}
              </p>
              {/* Письма, базу, итоговые письма и запуск после «Launch» шага 3
                  ведут автопилот и автозапуск — и только по выбранным рынкам.
                  Отправка аккаунта выключена ('revoked'; так и после
                  разблокировки, пока сотрудник не включит её): «Launch»
                  откажет 403 sending_turned_off — вместо неё строка доступа,
                  как у карточек рынков. Исследование выключатель не
                  спрашивает, кнопка ниже работает. */}
              <p className="text-xs m-0 max-w-md" style={{ color: 'var(--cp-paper-mute)' }}>
                {awaitingProject ? (
                  <>
                    {ENG_NEEDS_DESCRIPTION_SHORT_EN} Describe in 2–3 sentences what you sell and to whom on step 1
                    «Your business» — the research then goes on and finds the markets that could buy from you.
                  </>
                ) : data?.account_access === 'revoked' ? (
                  <EngSupportText
                    text={`We research your business and find the markets that could buy from you. ${ENG_SENDING_OFF_EN}`}
                  />
                ) : (
                  <>
                    We research your business and find the markets that could buy from you. Choose the ones you want
                    on step 2 and press «Launch» on step 3 — we collect and check contacts, then write
                    the letters and start sending for each market you chose. Every market shows up here.
                  </>
                )}
              </p>
              <Link
                href={
                  (projects.length === 0
                    ? '/client/eng'
                    : awaitingProject
                      ? `/client/eng/projects/${awaitingProject.id}?step=1`
                      : projects.length === 1
                        ? `/client/eng/projects/${projects[0].id}`
                        : '/client/eng?list=1') as Route
                }
                prefetch={false}
                className="ds-btn-primary inline-flex items-center gap-2"
              >
                {projects.length === 0
                  ? 'Create your project'
                  : awaitingProject
                    ? 'Describe your business'
                    : projects.length === 1
                      ? 'Open your project'
                      : 'Open your projects'}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </EngCard>
          ) : (
            <section aria-label="Markets" className="flex flex-col gap-4">
              <h2 className="ds-eyebrow">02 → Markets</h2>
              {(projects.length > 1 ? projects : [{ id: '', name: '' }]).map((p) => {
                const list = projects.length > 1 ? verticals.filter((v) => v.project_id === p.id) : verticals;
                if (list.length === 0) return null;
                return (
                  <div key={p.id || 'all'} className="flex flex-col gap-2.5">
                    {projects.length > 1 && <h3 className="ds-eyebrow">{projectNames.get(p.id) ?? p.name}</h3>}
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {list.map((v, i) => (
                        <VerticalCard
                          key={v.id}
                          vertical={v}
                          index={i}
                          showProject={projects.length > 1}
                          projectName={projectNames.get(v.project_id) ?? ''}
                          activeJob={v.id ? jobByVertical.get(v.id) : undefined}
                          refill={refillByProject.get(v.project_id) ?? 'off'}
                          accountAccess={data?.account_access}
                          onSendingChanged={() => void load({ silent: true })}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* 03 → Recent activity */}
          {events.length > 0 && (
            <section aria-label="Recent activity">
              <h2 className="ds-eyebrow mb-2">03 → Recent activity</h2>
              <EngCard>
                <ul className="flex flex-col">
                  {events.map((e, i) => (
                    <EventRow key={`${e.at}-${i}`} event={e} withBorder={i > 0} />
                  ))}
                </ul>
              </EngCard>
            </section>
          )}
        </>
      )}
    </div>
  );
}
