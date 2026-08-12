/**
 * Прогрев: настройки нагрузки.
 *
 * Единственное место, где числа превращаются в дневные нормы. Планировщики
 * получают готовые нормы параметром и ничего не знают ни про кривую, ни про
 * ручную таблицу — так вся арифметика фичи живёт и проверяется в одном файле.
 *
 * Константы `types.ts` остаются источником значений по умолчанию: кампания,
 * где оператор ничего не настраивал, ведёт себя ровно как до появления
 * настроек.
 */
import {
  CHATS_PER_ACCOUNT,
  CONVERSATIONS_FIRST_DAY,
  CONVERSATIONS_PEAK,
  MESSAGES_FIRST_DAY,
  MESSAGES_PEAK,
  RAMP_DAYS,
  REACTIONS_FIRST_DAY,
  REACTIONS_PEAK,
  REPLIES_FIRST_DAY,
  REPLIES_PEAK,
} from './types';

export type WarmupSettingsMode = 'curve' | 'manual';

export interface WarmupCurvePoint {
  /** Значение в первый день прогрева. */
  first: number;
  /** Потолок — достигается на дне `ramp_days`. */
  peak: number;
}

/** Нормы одного дня в том виде, в каком их правит оператор в таблице. */
export interface WarmupPerDayRow {
  /** Переписок со своими на аккаунт. */
  conversations: number;
  /** Сообщений в одной переписке. */
  messages: number;
  /** Сообщений в публичных чатах на аккаунт. */
  chat_messages: number;
  /** Реакций в публичных чатах на аккаунт. */
  chat_reactions: number;
}

export type WarmupParamKey = keyof WarmupPerDayRow;

export interface WarmupSettings {
  mode: WarmupSettingsMode;
  /** За сколько дней кривая доходит от первого дня до потолка. */
  ramp_days: number;
  /** Этап активности в публичных чатах включён. */
  public_chats: boolean;
  chats_per_account: number;
  curve: Record<WarmupParamKey, WarmupCurvePoint>;
  /**
   * Ручная таблица. Хранится даже после возврата в простой режим, но не
   * читается: случайное переключение галочки туда-обратно не должно стирать
   * работу оператора.
   */
  per_day: WarmupPerDayRow[];
}

/** Дневные нормы в том виде, в каком их спрашивают планировщики. */
export interface DailyLimits {
  conversations: number;
  messages: number;
  chatMessages: number;
  chatReactions: number;
}

/**
 * Границы полей.
 *
 * Это не рекомендация, а защита от опечатки: лишний ноль в поле реакций
 * отправит партию в бан быстрее, чем оператор успеет заметить. Ноль разрешён
 * везде, кроме длины переписки — переписка из одной реплики не переписка.
 */
export const FIELD_BOUNDS: Record<
  WarmupParamKey | 'chats_per_account' | 'ramp_days',
  { min: number; max: number }
> = {
  conversations: { min: 0, max: 30 },
  messages: { min: 2, max: 40 },
  chat_messages: { min: 0, max: 30 },
  chat_reactions: { min: 0, max: 60 },
  chats_per_account: { min: 1, max: 10 },
  ramp_days: { min: 1, max: 30 },
};

export const PARAM_KEYS: WarmupParamKey[] = [
  'conversations',
  'messages',
  'chat_messages',
  'chat_reactions',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Число из сырого JSON или из поля формы.
 *
 * Проверка типа до `Number()` не лишняя: `Number(null)` и `Number('')` дают 0,
 * то есть «пусто» тихо обнулило бы параметр вместо отката к дефолту. Ноль —
 * допустимое значение, и отличить осознанный ноль от пропущенного поля потом
 * уже нельзя.
 */
function num(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Значения по умолчанию — нынешние константы с env-override. */
export function defaultWarmupSettings(): WarmupSettings {
  return {
    mode: 'curve',
    ramp_days: RAMP_DAYS,
    public_chats: false,
    chats_per_account: CHATS_PER_ACCOUNT,
    curve: {
      conversations: { first: CONVERSATIONS_FIRST_DAY, peak: CONVERSATIONS_PEAK },
      messages: { first: MESSAGES_FIRST_DAY, peak: MESSAGES_PEAK },
      chat_messages: { first: REPLIES_FIRST_DAY, peak: REPLIES_PEAK },
      chat_reactions: { first: REACTIONS_FIRST_DAY, peak: REACTIONS_PEAK },
    },
    per_day: [],
  };
}

function normalizeRow(raw: unknown, base: WarmupSettings): WarmupPerDayRow {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as WarmupPerDayRow;
  for (const key of PARAM_KEYS) {
    const bounds = FIELD_BOUNDS[key];
    out[key] = clamp(num(src[key], base.curve[key].first), bounds.min, bounds.max);
  }
  return out;
}

/**
 * Привести что угодно из БД к рабочим настройкам.
 *
 * Прогон, начатый до релиза, не имеет ни одного из новых полей — и обязан
 * читаться без ошибок, иначе идущий прогрев упадёт на первом круге после
 * деплоя. Поэтому недостающее добирается дефолтами, а числа зажимаются.
 */
export function normalizeWarmupSettings(raw: unknown): WarmupSettings {
  const base = defaultWarmupSettings();
  if (!raw || typeof raw !== 'object') return base;
  const src = raw as Record<string, unknown>;

  const curveSrc = (src.curve && typeof src.curve === 'object' ? src.curve : {}) as Record<string, unknown>;
  const curve = { ...base.curve };
  for (const key of PARAM_KEYS) {
    const point = (curveSrc[key] && typeof curveSrc[key] === 'object'
      ? curveSrc[key]
      : {}) as Record<string, unknown>;
    const bounds = FIELD_BOUNDS[key];
    curve[key] = {
      first: clamp(num(point.first, base.curve[key].first), bounds.min, bounds.max),
      peak: clamp(num(point.peak, base.curve[key].peak), bounds.min, bounds.max),
    };
  }

  return {
    mode: src.mode === 'manual' ? 'manual' : 'curve',
    ramp_days: clamp(
      num(src.ramp_days, base.ramp_days),
      FIELD_BOUNDS.ramp_days.min,
      FIELD_BOUNDS.ramp_days.max,
    ),
    public_chats: Boolean(src.public_chats),
    chats_per_account: clamp(
      num(src.chats_per_account, base.chats_per_account),
      FIELD_BOUNDS.chats_per_account.min,
      FIELD_BOUNDS.chats_per_account.max,
    ),
    curve,
    per_day: (Array.isArray(src.per_day) ? src.per_day : []).map((row) => normalizeRow(row, base)),
  };
}

/**
 * Значение кривой на дне `day`.
 *
 * Разгон считается от `ramp_days`, а не от выбранной длины прогрева: день N
 * даёт одну и ту же нагрузку и в трёхдневном прогреве, и в недельном. Короткий
 * прогрев обрывается раньше и суммарно отправляет меньше — он не разгоняется
 * резче. Дни за пределами разгона держатся на потолке.
 */
function rampValue(day: number, point: WarmupCurvePoint, rampDays: number): number {
  if (rampDays <= 1) return point.peak;
  const clamped = Math.min(Math.max(day, 1), rampDays);
  const t = (clamped - 1) / (rampDays - 1);
  return Math.round(point.first + (point.peak - point.first) * t);
}

function curveRow(settings: WarmupSettings, day: number): WarmupPerDayRow {
  const out = {} as WarmupPerDayRow;
  for (const key of PARAM_KEYS) {
    out[key] = rampValue(day, settings.curve[key], settings.ramp_days);
  }
  return out;
}

/**
 * Нормы на день `day` — единственное, что спрашивают планировщики.
 *
 * В ручном режиме день за пределами таблицы берёт последнюю строку:
 * продолжение на достигнутой нагрузке безопаснее возврата к кривой, которую
 * оператор уже отверг.
 */
export function dailyLimits(settings: WarmupSettings, day: number): DailyLimits {
  const row =
    settings.mode === 'manual' && settings.per_day.length
      ? settings.per_day[Math.min(Math.max(day, 1), settings.per_day.length) - 1]
      : curveRow(settings, day);

  return {
    conversations: row.conversations,
    messages: row.messages,
    chatMessages: row.chat_messages,
    chatReactions: row.chat_reactions,
  };
}

/** Кривая, разложенная по дням: предпросмотр под полями простого режима. */
export function curveToPerDay(settings: WarmupSettings, days: number): WarmupPerDayRow[] {
  return Array.from({ length: Math.max(days, 0) }, (_, i) => curveRow(settings, i + 1));
}

/**
 * Строки для таблицы ручного режима.
 *
 * Уже заполненные дни сохраняются, недостающие дозаполняются кривой: смена
 * «дней» с 4 на 7 не должна стирать работу оператора.
 */
export function perDayForEditing(settings: WarmupSettings, days: number): WarmupPerDayRow[] {
  return Array.from(
    { length: Math.max(days, 0) },
    (_, i) => settings.per_day[i] ?? curveRow(settings, i + 1),
  );
}
