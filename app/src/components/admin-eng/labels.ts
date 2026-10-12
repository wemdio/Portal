/**
 * Раздел «Английские клиенты»: русские подписи для сотрудника.
 *
 * Модуль клиентский — из серверных модулей сюда идут только ТИПЫ
 * (`import type` стирается сборкой). Словари кодов — Record по типу кода:
 * новый код в HE_ENG_AUTO_LAUNCH_CODES (engAutoLaunch.ts) без подписи здесь —
 * ошибка typecheck, а не «код X» на экране. Код, которого нет в словаре
 * (строка из БД новее бандла), печатается как «код X».
 */

import type { HeEngAutoLaunchCode, HeEngAutoLaunchState } from '@/lib/hypothesisEngine/engAutoLaunch';
import type { HeEngSendingState, HeEngStartErrorCode } from '@/lib/hypothesisEngine/engCampaignStatus';
import type { HeEngSendingBefore, HeEngRefillBefore } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import type { HeEngAdminFilter } from './filters';
import type {
  HeEngAdminAttention,
  HeEngAdminLeak,
  HeEngAdminRow,
  HeEngAdminSendingView,
  HeEngAdminSource,
} from '@/lib/hypothesisEngine/engAdminView';
import { CampaignStatusLabels } from '@/lib/instantly/types';

/* ─────────────── Даты и числа ─────────────── */

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtNum(n: number | null | undefined): string {
  return typeof n === 'number' ? n.toLocaleString('ru-RU') : '—';
}

/** Русское склонение по числу: one — 1, few — 2–4, many — 5–20. */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/* ─────────────── Чипы списка ─────────────── */

export const FILTER_LABELS: Record<HeEngAdminFilter, string> = {
  all: 'Все',
  waiting: 'Ждут включения отправки',
  staff_off: 'Отправка выключена сотрудником',
  sending: 'Отправляют',
  attention: 'Нужна помощь',
  unverified: 'Почта не подтверждена',
  blocked: 'Заблокированы',
  ban_no_stop: 'Бан без остановки',
  blocked_leak: 'Заблокирован, но работа идёт',
};

/** Красные чипы — то, что нарушает правило «если бан, то всё останавливать». */
export const RED_FILTERS: ReadonlySet<HeEngAdminFilter> = new Set<HeEngAdminFilter>(['ban_no_stop', 'blocked_leak']);

export const FILTER_HINTS: Partial<Record<HeEngAdminFilter, string>> = {
  waiting:
    'Ждут сотрудника: клиент запускал рынки, а отправка аккаунта не включена, или клиента разблокировали, а отправка, выключенная блокировкой, ещё не включена снова. Включите её в карточке клиента.',
  staff_off:
    'Отправку выключил сотрудник: кнопкой «Выключить отправку», блокировкой клиента, который рынков не запускал, или остановкой «Заблокировать» / «Разблокировать» без записанной отметки блокировки. Это не очередь на включение.',
  ban_no_stop:
    'Вход закрыт баном, а отметки блокировки нет: бан поставлен мимо раздела, или при «Заблокировать» отметка не записалась. Бан мимо раздела не ставит кампании на паузу и не снимает уже поставленные задачи (новые платные шаги, автозапуск, ночной добор и письма клиенту бан держит). Откройте карточку и нажмите «Заблокировать ещё раз / доставить остановку».',
  blocked_leak:
    'Аккаунт заблокирован, а что-то из его работы ещё идёт. Откройте карточку: там видно, что именно, и кнопка «Заблокировать ещё раз / доставить остановку».',
};

export const MISSING_SOURCE_LABELS: Record<HeEngAdminSource, string> = {
  marker: 'отметки блокировки (миграция 20261013_0001)',
  verification: 'подтверждение почты (миграция 20261010_0001)',
  sending_access: 'выключатель отправки (миграция 20261011_0002)',
  campaign_status: 'статусы кампаний (миграция 20261011_0002)',
  launch_intent: 'автозапуск «Launch» (миграция 20261012_0001)',
  auto_launch: 'строки автозапуска (миграция 20261012_0001)',
  pool: 'пул ящиков (миграция 20261011_0001)',
};

/* ─────────────── Автозапуск ─────────────── */

export const AUTO_LAUNCH_STATE_LABELS: Record<HeEngAutoLaunchState, string> = {
  waiting: 'ждёт',
  running: 'идёт',
  done: 'закончен',
  held: 'держится',
  failed: 'остановлен',
};

/** Подпись кода строки he_eng_auto_launch — ключи ровно HE_ENG_AUTO_LAUNCH_CODES. */
export const AUTO_LAUNCH_CODE_LABELS: Record<HeEngAutoLaunchCode, string> = {
  start_retry: 'старт кампаний не удался — повтор',
  start_failed: 'старт кампаний не удался — клиенту нужно нажать «Start sending»',
  client_paused: 'клиент поставил паузу',
  needs_support: 'запуск отказан не по проверке — нужна команда',
  unfinished: 'запуск не закончен — достраивается',
  email_not_verified: 'почта клиента не подтверждена',
  spend_limit: 'упёрся в потолок расхода',
  spend_day_limit: 'упёрся в дневной потолок расхода',
  unavailable: 'проверки не прочитались — повтор',
  sending_not_enabled: 'отправка аккаунта не включена',
  sending_turned_off: 'отправка аккаунта выключена',
  mailboxes_short: 'в пуле не хватает ящиков',
  setup_unavailable: 'пул или пресет не готовы',
  retry_limited: 'много неудачных запусков подряд — пауза',
  research_running: 'идёт исследование',
  launch_running: 'уже идёт другой запуск',
  letters_need_rewrite: 'письма нужно переписать',
  server_error: 'сбой на нашей стороне до платной части',
  launch_failed: 'запуск упал после платной части',
  start_pending: 'решено стартовать кампании',
  abandoned: 'попытка брошена посреди (процесс умер)',
  account_blocked: 'аккаунт заблокирован — запуск и старт не делались',
  cancelled: 'автозапуск отменён посреди попытки — старт не делался',
};

/** Коды алертов и состояния намерения, которых нет среди кодов строки. */
export const AUTO_LAUNCH_EXTRA_LABELS: Record<'scope_refused' | 'settled', string> = {
  scope_refused: 'отказ проверки рынка аккаунта или шаблона',
  settled: 'всё, что можно было запустить, запущено',
};

export function autoLaunchCodeLabel(code: string | null | undefined): string {
  if (!code) return '';
  const known =
    (AUTO_LAUNCH_CODE_LABELS as Record<string, string>)[code] ?? (AUTO_LAUNCH_EXTRA_LABELS as Record<string, string>)[code];
  return known ?? `код ${code}`;
}

export function autoLaunchStateLabel(state: string | null | undefined): string {
  if (!state) return '—';
  return (AUTO_LAUNCH_STATE_LABELS as Record<string, string>)[state] ?? `состояние ${state}`;
}

/* ─────────────── Проект, задачи, кампании ─────────────── */

const PROJECT_STATUS_LABELS: Record<string, string> = {
  draft: 'черновик',
  researching: 'идёт исследование',
  researched: 'исследование готово',
  failed: 'исследование упало',
};

export function projectStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return PROJECT_STATUS_LABELS[status] ?? status;
}

const JOB_STAGE_LABELS: Record<string, string> = {
  site_profile: 'исследование: профиль сайта',
  competitors: 'исследование: конкуренты',
  brand_cloud: 'исследование: облако бренда',
  hypotheses: 'исследование: гипотезы',
  evidence: 'исследование: доказательства',
  clustering: 'исследование: рынки',
  chain: 'письма',
  vocab: 'словарь',
  base_collect: 'сбор контактов',
  base_analyze: 'проверка контактов',
  template: 'итоговые письма',
  dossier: 'досье',
};

export function jobStageLabel(stage: string | null | undefined): string {
  if (!stage) return '—';
  return JOB_STAGE_LABELS[stage] ?? `стадия ${stage}`;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'в очереди',
  running: 'идёт',
  done: 'готово',
  failed: 'упала',
  cancelled: 'отменена',
};

export function jobStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return JOB_STATUS_LABELS[status] ?? status;
}

export function campaignStatusLabel(status: number | null | undefined): string {
  if (typeof status !== 'number') return 'статус не прочитан';
  return CampaignStatusLabels[status] ?? `статус ${status}`;
}

export const SENDING_SUMMARY_LABELS: Record<HeEngSendingState, string> = {
  sending: 'отправляет',
  attention: 'рассыльщик остановил',
  completed: 'отправка закончена',
  pre_self_serve: 'запуск до пула — стартует только команда',
  paused: 'пауза клиента',
  not_sending: 'не отправляет',
  not_started: 'не стартовала',
  unknown: 'статус неизвестен',
  empty: 'адресов нет',
};

export const START_ERROR_LABELS: Record<HeEngStartErrorCode, string> = {
  mailboxes_changed: 'адреса кампании не из ящиков пула проекта',
  needs_attention: 'рассыльщик остановил кампанию',
  not_found: 'кампании нет у рассыльщика',
  read_failed: 'перед стартом кампанию не прочитали',
  start_failed: 'старт не подтвердился',
  start_unconfirmed: 'старт неясен — кампания могла начать отправку',
};

export function startErrorLabel(code: string | null | undefined): string {
  if (!code) return '';
  return (START_ERROR_LABELS as Record<string, string>)[code] ?? `код ${code}`;
}

export function readErrorLabel(code: string | null | undefined): string {
  if (code === 'not_found') return 'кампании нет у рассыльщика';
  if (code === 'failed') return 'последнее чтение не удалось';
  return code ? `код ${code}` : '';
}

/* ─────────────── Выключатель отправки ─────────────── */

export function sendingColumnText(s: HeEngAdminRow['sending']): string {
  switch (s.state) {
    case 'enabled':
      return s.since ? `включена ${fmtDateShort(s.since)}` : 'включена';
    case 'revoked': {
      const off = s.off_by === 'block' ? 'выключена блокировкой' : 'выключена';
      return s.since ? `${off} ${fmtDateShort(s.since)}` : off;
    }
    case 'not_enabled':
      return s.waiting ? (s.since ? `ждёт с ${fmtDateShort(s.since)}` : 'ждёт включения') : 'не включена';
    case 'missing':
      return 'таблица не создана';
  }
}

/** Значок колонки «Внимание» про выключатель: очередь (жёлтый) или выключено сотрудником (серый); null — нечего. */
export function sendingBadge(s: HeEngAdminRow['sending']): { tone: 'amber' | 'grey'; text: string } | null {
  if (s.waiting_reason === 'unblocked') return { tone: 'amber', text: 'Разблокирован — отправка выключена' };
  if (s.waiting_reason === 'launch') return { tone: 'amber', text: 'Ждёт включения отправки' };
  if (s.staff_off) {
    return { tone: 'grey', text: s.off_by === 'block' ? 'Отправку выключила блокировка' : 'Отправка выключена сотрудником' };
  }
  return null;
}

/**
 * Отправка аккаунта сейчас разрешена: включена сотрудником или — при снятом
 * требовании (HE_US_SENDING_REQUIRES_ACTIVATION=0) — не выключена. Тогда
 * кнопка — «Выключить отправку».
 */
export function engSendingAllowed(s: HeEngAdminSendingView): boolean {
  return s.state === 'enabled' || (!s.required && s.state === 'not_enabled');
}

export function engSendingTitle(s: HeEngAdminSendingView): string {
  const parts: string[] = [];
  if (!s.required) {
    parts.push(
      'Требование снято (HE_US_SENDING_REQUIRES_ACTIVATION=0) — включать не нужно; «Выключить отправку» всё равно останавливает отправку аккаунта',
    );
  }
  if (s.state === 'enabled') parts.push(`Включена ${fmtDateTime(s.enabled_at)}`);
  if (s.state === 'revoked') parts.push(`Выключена ${fmtDateTime(s.revoked_at)}`);
  // Клиент ждёт — только пока отправку не включали, и его запрос новее выключения.
  if (
    s.state === 'not_enabled'
    && s.requested_at
    && (!s.revoked_at || Date.parse(s.requested_at) > Date.parse(s.revoked_at))
  ) {
    parts.push(`Клиент упёрся в выключатель ${fmtDateTime(s.requested_at)}`);
  }
  if (s.email_sent_at) parts.push(`Письмо «Sending is on» ушло ${fmtDateTime(s.email_sent_at)}`);
  return parts.join('\n');
}

/** Ответ POST /api/admin/users/[id]/eng-sending. */
export interface EngSendingPostResult extends HeEngAdminSendingView {
  changed: boolean;
  email: 'sent' | 'no_email' | 'failed' | null;
  paused: {
    launches: number;
    paused: number;
    failed: number;
    notAttempted: number;
    unreadLaunches?: number;
    readFailed: boolean;
  } | null;
}

/** Строка итога включения / выключения для сотрудника (перенесена из /admin/users). */
export function engSendingResultText(enabled: boolean, result: EngSendingPostResult): { tone: 'ok' | 'red'; text: string } {
  if (enabled) {
    if (result.email === 'sent') return { tone: 'ok', text: 'Отправка включена, клиенту ушло письмо «Sending is on»' };
    if (result.email === 'no_email') {
      return { tone: 'red', text: 'Отправка включена; адреса в профиле нет — напишите клиенту в чат поддержки' };
    }
    if (result.email === 'failed') {
      return { tone: 'red', text: 'Отправка включена, но письмо клиенту не ушло — напишите ему в чат поддержки' };
    }
    return { tone: 'ok', text: 'Отправка уже была включена' };
  }
  const p = result.paused;
  if (!p) return { tone: 'ok', text: 'Отправка уже была выключена' };
  const head = result.changed ? 'Отправка выключена' : 'Отправка уже была выключена, пауза доставлена ещё раз';
  if (p.readFailed) {
    return { tone: 'red', text: `${head}, но запуски аккаунта не прочитались — поставьте его кампании на паузу у рассыльщика` };
  }
  const unread = p.unreadLaunches ?? 0;
  const notStopped = p.failed + p.notAttempted;
  // Запуски, чья запись не прочиталась, — отдельно от кампаний: сколько в них
  // кампаний, неизвестно (по каждому ушёл алерт с id шаблона).
  const problems = [
    notStopped > 0 ? `не остановлены ${notStopped}` : null,
    unread > 0 ? `${ruPlural(unread, 'не прочитан', 'не прочитаны', 'не прочитаны')} ${unread} ${ruPlural(unread, 'запуск', 'запуска', 'запусков')}` : null,
  ].filter((x): x is string => x !== null);
  if (problems.length > 0) {
    return {
      tone: 'red',
      text: `${head}; на паузе ${p.paused}, ${problems.join(', ')} — поставьте ${unread > 0 ? 'их кампании' : 'их'} на паузу у рассыльщика`,
    };
  }
  return { tone: 'ok', text: `${head}; кампаний на паузе: ${p.paused}` };
}

/* ─────────────── Блокировка ─────────────── */

export const SENDING_BEFORE_LABELS: Record<HeEngSendingBefore, string> = {
  enabled: 'включена',
  not_enabled: 'не включена',
  waiting: 'ждала включения',
  revoked: 'уже выключена',
  not_required: 'не требовалась (требование снято)',
  unknown: 'не прочитана',
};

export const REFILL_BEFORE_LABELS: Record<HeEngRefillBefore, string> = {
  on: 'включён',
  off: 'выключен',
  no_config: 'не настраивался',
  unknown: 'не прочитан',
};

export function leakText(leak: HeEngAdminLeak): string {
  switch (leak.kind) {
    case 'campaigns_sending':
      return `кампании отправляют: ${leak.count}${leak.status_at ? ` (статус от ${fmtDateShort(leak.status_at)})` : ''}`;
    case 'active_jobs':
      return `задачи в работе: ${leak.count}`;
    case 'intent_wanted':
      return 'автозапуск «Launch» включён';
    case 'launch_running':
      return `запуск идёт прямо сейчас: ${leak.count}`;
    case 'auto_launch_waiting':
      return `автозапуск ждёт рынков: ${leak.count}`;
    case 'switch_not_revoked':
      return leak.state === 'missing' ? 'выключатель отправки не создан (миграция 20261011_0002)' : 'отправка аккаунта не выключена';
  }
}

export function attentionText(a: HeEngAdminAttention): string {
  switch (a.kind) {
    case 'project_failed':
      return 'исследование упало';
    case 'auto_launch': {
      const what = a.code ? autoLaunchCodeLabel(a.code) : autoLaunchStateLabel(a.state);
      return `автозапуск ${autoLaunchStateLabel(a.state)}: ${what}${a.count > 1 ? ` (рынков: ${a.count})` : ''}`;
    }
    case 'campaigns_stopped':
      return `рассыльщик остановил кампании: ${a.count}`;
  }
}

/* ─────────────── Письма клиенту ─────────────── */

const CLIENT_EMAIL_KIND_LABELS: Record<string, string> = {
  research_ready: 'рынки готовы',
  research_stopped: 'исследование встало',
  sending_waiting: 'ждём включения отправки',
  sending_started: 'отправка началась',
  action_needed: 'нужно действие',
};

const CLIENT_EMAIL_CODE_LABELS: Record<string, string> = {
  letters_need_rewrite: 'письма нужно переписать',
  start_failed: 'старт не удался',
  needs_support: 'нужна поддержка',
  collect_stopped: 'сбор контактов встал',
  autopilot_hold: 'автопилот на паузе',
  letters_stopped: 'письма встали',
  final_letters_stopped: 'итоговые письма встали',
  check_stopped: 'проверка контактов встала',
  rewrite_stopped: 'переписывание встало',
};

export function clientEmailLabel(kind: string, code: string | null): string {
  const k = CLIENT_EMAIL_KIND_LABELS[kind] ?? kind;
  if (!code) return k;
  return `${k}: ${CLIENT_EMAIL_CODE_LABELS[code] ?? code}`;
}
