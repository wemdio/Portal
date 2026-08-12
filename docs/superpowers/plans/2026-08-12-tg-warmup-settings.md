# Настройки прогрева и переезд чатов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести нагрузку прогрева в портал (четыре параметра, простой режим и таблица по дням) и убрать вкладку «Чаты», перенеся её содержимое в блок настроек на вкладке «Прогрев».

**Architecture:** Вся арифметика переезжает в новый модуль `warmup/settings.ts`: он владеет типом настроек, дефолтами из констант, нормализацией сырого JSON из БД и функцией `dailyLimits(settings, day)`. Планировщики `schedule.ts` и `chatSchedule.ts` перестают считать кривую сами и принимают готовые нормы параметром. Настройки хранятся в новой колонке `tg_outreach_campaigns.warmup_settings` и копируются в снимок прогона при старте; воркер перечитывает снимок каждый круг, но план дня строит один раз — поэтому правки вступают со следующего дня.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (Postgres + RLS), Jest, Tailwind.

**Спека:** [2026-08-12-tg-warmup-settings-design.md](../specs/2026-08-12-tg-warmup-settings-design.md)

**Все команды запускаются из каталога `app/`.**

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260812_0001_tg_outreach_warmup_settings.sql` | Колонка `warmup_settings` у кампаний |
| `app/src/lib/tgOutreach/warmup/settings.ts` | **Новый.** Тип настроек, дефолты, нормализация, `dailyLimits`, раскладка по дням |
| `app/src/lib/tgOutreach/warmup/schedule.ts` | `planDay` принимает нормы параметром; кривая уезжает в `settings.ts` |
| `app/src/lib/tgOutreach/warmup/chatSchedule.ts` | `planChatActivities` принимает нормы; кривая уезжает; `assignChats` не меняется |
| `app/src/lib/tgOutreach/warmup/loop.ts` | Читает настройки прогона каждый круг, зовёт `dailyLimits`, передаёт нормы |
| `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/settings/route.ts` | **Новый.** PUT настроек в кампанию и в активный прогон |
| `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/route.ts` | GET отдаёт настройки, POST копирует их в снимок прогона |
| `app/src/components/tg-outreach/WarmupDayTable.tsx` | **Новый.** Таблица «День 1…N × 4 колонки» |
| `app/src/components/tg-outreach/WarmupChatsSection.tsx` | **Новый** (из `WarmupChatsTab.tsx`). Встраиваемая секция списка чатов |
| `app/src/components/tg-outreach/WarmupSettingsPanel.tsx` | **Новый.** Свёртываемый блок настроек с обеими секциями |
| `app/src/components/tg-outreach/WarmupTab.tsx` | Монтирует панель, убирает галочку чатов из полосы управления |
| `app/src/app/tools/tg-outreach/page.tsx` | Убирает вкладку `warmup-chats` |
| `app/src/components/tg-outreach/WarmupChatsTab.tsx` | Удаляется |
| `app/tests/lib/tgOutreach/warmupSettings.test.ts` | **Новый.** Кривая, ручной режим, нормализация |
| `app/tests/lib/tgOutreach/warmupSchedule.test.ts` | Тесты кривой уезжают, планирование получает явные нормы |
| `app/tests/lib/tgOutreach/warmupChatSchedule.test.ts` | То же |

---

### Task 1: Миграция — колонка `warmup_settings`

**Files:**
- Create: `supabase/migrations/20260812_0001_tg_outreach_warmup_settings.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- Настройки нагрузки прогрева: то, что применится к следующему запуску.
--
-- Живут у кампании, а не только в снимке прогона: оператор настраивает партию
-- один раз, а прогревов у неё за жизнь несколько. При старте прогрева объект
-- копируется в tg_outreach_warmup_runs.settings — по нему идёт конкретный
-- прогон, и перезапуск воркера должен видеть то же решение оператора.
--
-- Пустой объект по умолчанию: код добирает недостающие поля дефолтами из
-- констант, поэтому кампании, где никто ничего не настраивал, ведут себя ровно
-- как до релиза.
alter table public.tg_outreach_campaigns
  add column if not exists warmup_settings jsonb not null default '{}'::jsonb;

comment on column public.tg_outreach_campaigns.warmup_settings is
  'Настройки прогрева: mode, ramp_days, public_chats, chats_per_account, curve, per_day';
```

- [ ] **Step 2: Проверить, что миграция синтаксически валидна**

Run: `npx supabase db lint --schema public 2>/dev/null || echo "supabase CLI недоступен — пропускаем"`
Expected: либо чистый вывод, либо сообщение про недоступный CLI. Ошибок синтаксиса быть не должно.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260812_0001_tg_outreach_warmup_settings.sql
git commit -m "feat(tg-outreach): колонка warmup_settings у кампаний"
```

---

### Task 2: Модуль настроек — тесты

Пишем тесты первыми: `settings.ts` — единственное место, где числа превращаются в нагрузку, и главный тест здесь регрессионный (дефолты обязаны давать ровно нынешнюю кривую).

**Files:**
- Test: `app/tests/lib/tgOutreach/warmupSettings.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создать `app/tests/lib/tgOutreach/warmupSettings.test.ts`:

```ts
/** @jest-environment node */

/**
 * Настройки прогрева — единственное место, где числа превращаются в дневные
 * нормы. Главный тест здесь регрессионный: дефолты обязаны давать ровно ту
 * кривую, по которой прогрев шёл до появления настроек. Если релиз тихо
 * изменит нагрузку, это должен заметить тест, а не Telegram.
 */

import {
  curveToPerDay,
  dailyLimits,
  defaultWarmupSettings,
  normalizeWarmupSettings,
  perDayForEditing,
  type WarmupSettings,
} from '@/lib/tgOutreach/warmup/settings';

describe('дефолты повторяют прежнюю кривую', () => {
  const s = defaultWarmupSettings();

  it('переписки идут 2 → 8 за семь дней', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => dailyLimits(s, d).conversations))
      .toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('длина переписки идёт 3 → 10 за те же семь дней', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => dailyLimits(s, d).messages))
      .toEqual([3, 4, 5, 7, 8, 9, 10]);
  });

  it('в чатах: 1 → 5 сообщений и 3 → 12 реакций', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => dailyLimits(s, d).chatMessages))
      .toEqual([1, 2, 2, 3, 4, 4, 5]);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => dailyLimits(s, d).chatReactions))
      .toEqual([3, 5, 6, 8, 9, 11, 12]);
  });

  it('реакций всегда заметно больше сообщений — дешёвый сигнал против дорогого', () => {
    for (const day of [1, 2, 3, 4, 7]) {
      expect(dailyLimits(s, day).chatReactions).toBeGreaterThan(dailyLimits(s, day).chatMessages * 2);
    }
  });

  it('этап публичных чатов по умолчанию выключен', () => {
    expect(s.public_chats).toBe(false);
  });
});

describe('кривая за пределами разгона', () => {
  const s = defaultWarmupSettings();

  it('дни сверх разгона держатся на потолке, а не растут дальше', () => {
    expect(dailyLimits(s, 8).conversations).toBe(8);
    expect(dailyLimits(s, 99).conversations).toBe(8);
    expect(dailyLimits(s, 99).messages).toBe(10);
  });

  it('день вне диапазона зажимается в границы', () => {
    expect(dailyLimits(s, 0).conversations).toBe(2);
    expect(dailyLimits(s, -5).messages).toBe(3);
  });

  /**
   * Главное свойство фичи: короткий прогрев — обрезанное начало длинного, а не
   * тот же подъём на ускоренной перемотке. Оператор, ставящий 3 дня, просит
   * «отправить меньше», а не «разогнаться резче».
   */
  it('день N даёт одну и ту же нагрузку при любой длине прогрева', () => {
    expect(curveToPerDay(s, 3).map((r) => r.conversations)).toEqual([2, 3, 4]);
    expect(curveToPerDay(s, 7).map((r) => r.conversations).slice(0, 3)).toEqual([2, 3, 4]);
  });
});

describe('ручной режим', () => {
  const manual = (): WarmupSettings => ({
    ...defaultWarmupSettings(),
    mode: 'manual',
    per_day: [
      { conversations: 1, messages: 3, chat_messages: 0, chat_reactions: 2 },
      { conversations: 5, messages: 6, chat_messages: 2, chat_reactions: 7 },
    ],
  });

  it('строка таблицы читается как есть, кривая не вмешивается', () => {
    expect(dailyLimits(manual(), 1)).toEqual({
      conversations: 1, messages: 3, chatMessages: 0, chatReactions: 2,
    });
    expect(dailyLimits(manual(), 2).conversations).toBe(5);
  });

  /**
   * Продолжение на достигнутой нагрузке безопаснее возврата к кривой, которую
   * оператор уже отверг.
   */
  it('день за пределами таблицы берёт последнюю строку', () => {
    expect(dailyLimits(manual(), 3).conversations).toBe(5);
    expect(dailyLimits(manual(), 99).chatReactions).toBe(7);
  });

  it('пустая таблица откатывается к кривой, а не даёт нули', () => {
    const s = { ...defaultWarmupSettings(), mode: 'manual' as const, per_day: [] };
    expect(dailyLimits(s, 1).conversations).toBe(2);
  });

  it('нулевая строка допустима: день без активности', () => {
    const s: WarmupSettings = {
      ...defaultWarmupSettings(),
      mode: 'manual',
      per_day: [{ conversations: 0, messages: 3, chat_messages: 0, chat_reactions: 0 }],
    };
    expect(dailyLimits(s, 1).conversations).toBe(0);
    expect(dailyLimits(s, 1).chatReactions).toBe(0);
  });
});

describe('нормализация того, что пришло из БД', () => {
  it('пустой объект и null дают дефолты', () => {
    expect(normalizeWarmupSettings({})).toEqual(defaultWarmupSettings());
    expect(normalizeWarmupSettings(null)).toEqual(defaultWarmupSettings());
    expect(normalizeWarmupSettings('мусор')).toEqual(defaultWarmupSettings());
  });

  /**
   * Прогоны, начатые до релиза, лежат в БД со старым снимком настроек. Такой
   * снимок обязан читаться без ошибок, иначе идущий прогрев упадёт на первом
   * же круге после деплоя.
   */
  it('снимок старого формата читается и сохраняет public_chats', () => {
    const old = {
      default_days: 4, ramp_days: 7, conversations_first_day: 2,
      conversations_peak: 8, messages_first_day: 3, messages_peak: 10,
      public_chats: true,
    };
    const s = normalizeWarmupSettings(old);
    expect(s.public_chats).toBe(true);
    expect(s.mode).toBe('curve');
    expect(dailyLimits(s, 1).conversations).toBe(2);
  });

  it('числа вне границ зажимаются, а не проходят насквозь', () => {
    const s = normalizeWarmupSettings({
      curve: {
        conversations: { first: -5, peak: 9999 },
        messages: { first: 0, peak: 10 },
        chat_reactions: { first: 3, peak: 500 },
      },
      chats_per_account: 99,
    });
    expect(s.curve.conversations.first).toBe(0);
    expect(s.curve.conversations.peak).toBe(30);
    expect(s.curve.messages.first).toBe(2);
    expect(s.curve.chat_reactions.peak).toBe(60);
    expect(s.chats_per_account).toBe(10);
  });

  it('мусор вместо чисел заменяется дефолтом', () => {
    const s = normalizeWarmupSettings({ curve: { conversations: { first: 'ой', peak: null } } });
    expect(s.curve.conversations.first).toBe(2);
    expect(s.curve.conversations.peak).toBe(8);
  });

  it('строки таблицы тоже зажимаются', () => {
    const s = normalizeWarmupSettings({
      mode: 'manual',
      per_day: [{ conversations: 1000, messages: 1, chat_messages: -3, chat_reactions: 4 }],
    });
    expect(s.per_day[0]).toEqual({
      conversations: 30, messages: 2, chat_messages: 0, chat_reactions: 4,
    });
  });

  it('неизвестный mode считается простым режимом', () => {
    expect(normalizeWarmupSettings({ mode: 'что-то' }).mode).toBe('curve');
    expect(normalizeWarmupSettings({ mode: 'manual' }).mode).toBe('manual');
  });
});

describe('раскладка для интерфейса', () => {
  const s = defaultWarmupSettings();

  it('предпросмотр даёт ровно столько строк, сколько дней', () => {
    expect(curveToPerDay(s, 4)).toHaveLength(4);
    expect(curveToPerDay(s, 0)).toEqual([]);
  });

  /**
   * Смена «дней» с 4 на 7 не должна стирать работу оператора: заполненные дни
   * остаются, недостающие дозаполняются кривой.
   */
  it('таблица сохраняет заполненные дни и дозаполняет остальные кривой', () => {
    const filled: WarmupSettings = {
      ...s,
      mode: 'manual',
      per_day: [{ conversations: 9, messages: 9, chat_messages: 9, chat_reactions: 9 }],
    };
    const rows = perDayForEditing(filled, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0].conversations).toBe(9);
    expect(rows[1].conversations).toBe(3);
    expect(rows[2].conversations).toBe(4);
  });

  it('лишние строки таблицы не мешают, если дней стало меньше', () => {
    const filled: WarmupSettings = {
      ...s,
      mode: 'manual',
      per_day: curveToPerDay(s, 7),
    };
    expect(perDayForEditing(filled, 2)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest tests/lib/tgOutreach/warmupSettings.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tgOutreach/warmup/settings'`

- [ ] **Step 3: Commit падающего теста**

```bash
git add app/tests/lib/tgOutreach/warmupSettings.test.ts
git commit -m "test(tg-outreach): тесты настроек прогрева до реализации"
```

---

### Task 3: Модуль настроек — реализация

**Files:**
- Create: `app/src/lib/tgOutreach/warmup/settings.ts`
- Test: `app/tests/lib/tgOutreach/warmupSettings.test.ts` (уже написан)

- [ ] **Step 1: Написать модуль**

Создать `app/src/lib/tgOutreach/warmup/settings.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тесты и убедиться, что они проходят**

Run: `npx jest tests/lib/tgOutreach/warmupSettings.test.ts`
Expected: PASS — все describe-блоки зелёные.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/tgOutreach/warmup/settings.ts
git commit -m "feat(tg-outreach): модуль настроек прогрева с дневными нормами"
```

---

### Task 4: `planDay` принимает нормы параметром

Кривая переехала в `settings.ts` — планировщик переписок больше не должен её считать.

**Files:**
- Modify: `app/src/lib/tgOutreach/warmup/schedule.ts`
- Test: `app/tests/lib/tgOutreach/warmupSchedule.test.ts`

- [ ] **Step 1: Переписать тесты под новую сигнатуру**

Заменить в `app/tests/lib/tgOutreach/warmupSchedule.test.ts` шапку файла, импорт и весь блок `describe('warmup schedule — кривая нагрузки', ...)` (строки 1–83) на:

```ts
/**
 * @jest-environment node
 *
 * Планировщик переписок между своими. Кривая нагрузки живёт в `settings.ts` и
 * проверяется в `warmupSettings.test.ts` — сюда нормы приходят готовым числом,
 * поэтому здесь остаётся только подбор пар и раскладка по времени:
 *
 * 1. Каждый аккаунт получает свою дневную норму, пара не повторяется внутри
 *    дня, незнакомые партнёры имеют приоритет.
 * 2. Времена попадают в активное окно суток и идут по возрастанию.
 *
 * Случайность инжектится (`random`), поэтому тесты детерминированы.
 */

import { planDay } from '@/lib/tgOutreach/warmup/schedule';

const WINDOW = {
  start: new Date('2026-08-04T08:00:00Z'),
  end: new Date('2026-08-04T22:00:00Z'),
};

/** Детерминированный «рандом»: крутит переданную последовательность по кругу. */
const seq = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

/** Нормы дня, которые в бою приходят из `dailyLimits`. */
const limits = (conversations: number, messages = 3) => ({
  conversationsPerAccount: conversations,
  messagesPerConversation: messages,
});
```

Затем в блоке `describe('warmup schedule — подбор пар', ...)` заменить каждый вызов `planDay`: убрать `day: N` и `targetOverride: N`, добавить `...limits(...)`. Полный текст блока после правки:

```ts
describe('warmup schedule — подбор пар', () => {
  const ids = ['a', 'b', 'c', 'd'];

  const countPerAccount = (plan: ReturnType<typeof planDay>) => {
    const count = new Map<string, number>();
    for (const c of plan) {
      count.set(c.accountAId, (count.get(c.accountAId) ?? 0) + 1);
      count.set(c.accountBId, (count.get(c.accountBId) ?? 0) + 1);
    }
    return count;
  };

  it('каждый аккаунт получает свою дневную норму переписок', () => {
    const plan = planDay({
      accountIds: ids, ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const count = countPerAccount(plan);
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('одна и та же пара не встречается дважды за день', () => {
    const plan = planDay({
      accountIds: ids, ...limits(5),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const keys = plan.map((c) => `${c.accountAId}|${c.accountBId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('пара нормализована: accountAId всегда меньше accountBId', () => {
    const plan = planDay({
      accountIds: ids, ...limits(3),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId < c.accountBId).toBe(true);
  });

  it('незнакомые партнёры имеют приоритет над уже знакомыми', () => {
    // a уже говорил с b и c; при норме в одну переписку он должен выбрать d.
    const plan = planDay({
      accountIds: ids, ...limits(1),
      previousPairs: [['a', 'b'], ['a', 'c']],
      window: WINDOW, random: seq([0.5]),
    });
    const aPair = plan.find((c) => c.accountAId === 'a' || c.accountBId === 'a');
    expect(aPair).toBeDefined();
    const partner = aPair!.accountAId === 'a' ? aPair!.accountBId : aPair!.accountAId;
    expect(partner).toBe('d');
  });

  it('когда незнакомых не осталось, возвращаемся к знакомым, а не бросаем норму', () => {
    // Все пары уже знакомы — план всё равно должен закрыть дневную норму.
    const previousPairs: Array<[string, string]> = [
      ['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd'], ['c', 'd'],
    ];
    const plan = planDay({
      accountIds: ids, ...limits(2),
      previousPairs, window: WINDOW, random: seq([0.5]),
    });
    const count = countPerAccount(plan);
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('нечётное число аккаунтов не роняет планировщик', () => {
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId).not.toBe(c.accountBId);
  });

  it('меньше двух аккаунтов — пустой план, без исключения', () => {
    expect(planDay({
      accountIds: ['a'], ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
    expect(planDay({
      accountIds: [], ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
  });

  it('нулевая норма даёт пустой план: день без переписок допустим', () => {
    expect(planDay({
      accountIds: ids, ...limits(0),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
  });

  it('норма больше, чем есть партнёров: план конечен, зацикливания нет', () => {
    // Три аккаунта, норма восьми переписок — каждый может поговорить максимум
    // с двумя, значит пар всего три и планировщик обязан на этом остановиться.
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], ...limits(8),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan).toHaveLength(3);
  });

  it('длина переписки в плане берётся из норм дня', () => {
    const plan = planDay({
      accountIds: ids, ...limits(8, 10),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.plannedMessages).toBe(10);
  });

  it('времена попадают в окно и идут по возрастанию', () => {
    const plan = planDay({
      accountIds: ids, ...limits(4),
      previousPairs: [], window: WINDOW,
      random: seq([0.1, 0.4, 0.7, 0.9, 0.2, 0.6, 0.35]),
    });
    const times = plan.map((c) => new Date(c.plannedAt).getTime());
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(WINDOW.start.getTime());
      expect(t).toBeLessThanOrEqual(WINDOW.end.getTime());
    }
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('инициатор — один из участников пары', () => {
    const plan = planDay({
      accountIds: ids, ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.9, 0.1]),
    });
    for (const c of plan) {
      expect([c.accountAId, c.accountBId]).toContain(c.initiatorAccountId);
    }
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest tests/lib/tgOutreach/warmupSchedule.test.ts`
Expected: FAIL — TypeScript ругается на неизвестные поля `conversationsPerAccount` / `messagesPerConversation` в `PlanDayParams`.

- [ ] **Step 3: Переписать `schedule.ts`**

Заменить содержимое `app/src/lib/tgOutreach/warmup/schedule.ts` целиком:

```ts
/**
 * Прогрев: планировщик дня.
 *
 * Всё здесь — чистые функции. Работа с БД, временем и случайностью остаётся
 * снаружи (`random` инжектится), поэтому поведение полностью проверяемо
 * тестами.
 *
 * Дневные нормы приходят параметром из `settings.ts`: планировщик не знает, по
 * кривой их посчитали или взяли из таблицы оператора, и знать не должен.
 */

export interface PlannedConversation {
  /** Меньший из двух id — пара всегда нормализована. */
  accountAId: string;
  accountBId: string;
  initiatorAccountId: string;
  plannedMessages: number;
  plannedAt: string;
}

export interface PlanDayParams {
  accountIds: string[];
  /** Сколько переписок должен провести один аккаунт за этот день. */
  conversationsPerAccount: number;
  /** Сколько сообщений содержит одна переписка в этот день. */
  messagesPerConversation: number;
  /** Пары, уже общавшиеся в этом прогреве (порядок внутри пары не важен). */
  previousPairs: Array<[string, string]>;
  /** Активное окно суток: ночью аккаунты молчат. */
  window: { start: Date; end: Date };
  random: () => number;
}

function pairKey(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Составить план переписок на один день.
 *
 * Жадный подбор: берём аккаунт с наибольшим остатком дневной нормы и ищем ему
 * партнёра — сначала среди тех, с кем он ещё не говорил, потом среди знакомых.
 *
 * Возврат к знакомым — не запасной вариант, а осознанная часть замысла. Если бы
 * рост нагрузки шёл только за счёт новых знакомств, аккаунт никогда не
 * возвращался бы к прежнему собеседнику, а именно возврат к знакомому — самый
 * человеческий сигнал из доступных. Поэтому норма закрывается всегда, даже
 * когда незнакомые кончились.
 */
export function planDay(params: PlanDayParams): PlannedConversation[] {
  const { accountIds, previousPairs, window, random } = params;
  if (accountIds.length < 2) return [];

  const target = Math.max(params.conversationsPerAccount, 0);
  if (target < 1) return [];

  const plannedMessages = params.messagesPerConversation;
  const seen = new Set(previousPairs.map(([x, y]) => pairKey(x, y)));
  const usedToday = new Set<string>();
  const remaining = new Map(accountIds.map((id) => [id, target]));
  const out: Array<Omit<PlannedConversation, 'plannedAt'>> = [];

  for (;;) {
    const candidates = accountIds
      .filter((id) => (remaining.get(id) ?? 0) > 0)
      .sort((x, y) => (remaining.get(y)! - remaining.get(x)!) || (x < y ? -1 : 1));
    if (candidates.length < 2) break;

    const self = candidates[0];
    const partners = candidates.slice(1).filter((id) => !usedToday.has(pairKey(self, id)));
    if (!partners.length) {
      // Со всеми доступными аккаунт сегодня уже переписывался — норму не
      // добираем, иначе получился бы повтор пары внутри одного дня.
      remaining.set(self, 0);
      continue;
    }

    const fresh = partners.filter((id) => !seen.has(pairKey(self, id)));
    const partner = (fresh.length ? fresh : partners)[0];

    const [a, b] = self < partner ? [self, partner] : [partner, self];
    usedToday.add(pairKey(a, b));
    seen.add(pairKey(a, b));
    remaining.set(self, remaining.get(self)! - 1);
    remaining.set(partner, remaining.get(partner)! - 1);
    out.push({
      accountAId: a,
      accountBId: b,
      initiatorAccountId: random() < 0.5 ? a : b,
      plannedMessages,
    });
  }

  const spanMs = Math.max(window.end.getTime() - window.start.getTime(), 1);
  const times = out
    .map(() => window.start.getTime() + Math.floor(random() * spanMs))
    .sort((x, y) => x - y);

  return out.map((c, i) => ({ ...c, plannedAt: new Date(times[i]).toISOString() }));
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest tests/lib/tgOutreach/warmupSchedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tgOutreach/warmup/schedule.ts app/tests/lib/tgOutreach/warmupSchedule.test.ts
git commit -m "refactor(tg-outreach): planDay получает дневные нормы параметром"
```

---

### Task 5: `planChatActivities` принимает нормы параметром

**Files:**
- Modify: `app/src/lib/tgOutreach/warmup/chatSchedule.ts`
- Test: `app/tests/lib/tgOutreach/warmupChatSchedule.test.ts`

- [ ] **Step 1: Переписать тесты под новую сигнатуру**

В `app/tests/lib/tgOutreach/warmupChatSchedule.test.ts`:

1. Из импорта убрать `reactionsPerAccount` и `repliesPerAccount`.
2. Удалить целиком блок `describe('кривая нагрузки в чатах', ...)` — эти проверки переехали в `warmupSettings.test.ts`.
3. Заменить блок `describe('план активностей на день', ...)` — текст ниже.

Итоговая шапка файла:

```ts
/** @jest-environment node */

/**
 * Арифметика этапа публичных чатов.
 *
 * Кривая нагрузки живёт в `settings.ts` и проверяется в
 * `warmupSettings.test.ts` — сюда нормы приходят готовым числом. Здесь
 * остаётся то, из-за чего этап опасен: раскладка аккаунтов по разным чатам и
 * отсев сообщений, отвечать на которые нельзя. Telegram в тестах не участвует.
 */

import {
  assignChats,
  parseChatLink,
  pickReactionTarget,
  pickReplyTarget,
  planChatActivities,
  type ChatMessage,
} from '@/lib/tgOutreach/warmup/chatSchedule';
```

Заменить блок `describe('план активностей на день', ...)` (строки 80–126 исходника) целиком на:

```ts
describe('план активностей на день', () => {
  const assignments = [
    { accountId: 'a1', chatId: 'c1' },
    { accountId: 'a1', chatId: 'c2' },
    { accountId: 'a2', chatId: 'c2' },
  ];

  it('норма считается на аккаунт, а не на чат', () => {
    const plan = planChatActivities({
      assignments, window: WINDOW, random: () => 0.5,
      replies: 2, reactions: 3,
    });
    // У a1 два чата, у a2 один — но нагрузка одинаковая.
    for (const id of ['a1', 'a2']) {
      const mine = plan.filter((p) => p.accountId === id);
      expect(mine.filter((p) => p.kind === 'reply')).toHaveLength(2);
      expect(mine.filter((p) => p.kind === 'reaction')).toHaveLength(3);
    }
  });

  it('активности разложены внутри активного окна и упорядочены по времени', () => {
    const plan = planChatActivities({
      assignments, window: WINDOW, random: Math.random,
      replies: 2, reactions: 6,
    });
    const times = plan.map((p) => new Date(p.plannedAt).getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(WINDOW.start.getTime());
      expect(t).toBeLessThanOrEqual(WINDOW.end.getTime());
    }
  });

  it('аккаунт пишет только в назначенные ему чаты', () => {
    const plan = planChatActivities({
      assignments, window: WINDOW, random: Math.random,
      replies: 1, reactions: 5,
    });
    for (const p of plan.filter((x) => x.accountId === 'a2')) {
      expect(p.chatId).toBe('c2');
    }
  });

  it('без назначенных чатов плана нет', () => {
    expect(planChatActivities({
      assignments: [], window: WINDOW, random: () => 0.5,
      replies: 1, reactions: 3,
    })).toEqual([]);
  });
});
```

И добавить в конец файла тест на нулевую норму:

```ts
describe('нулевые нормы', () => {
  it('ноль ответов и ноль реакций дают пустой план, а не исключение', () => {
    expect(planChatActivities({
      assignments: [{ accountId: 'a1', chatId: 'c1' }],
      replies: 0, reactions: 0,
      window: WINDOW, random: () => 0.5,
    })).toEqual([]);
  });

  it('только реакции без ответов — допустимый день', () => {
    const plan = planChatActivities({
      assignments: [{ accountId: 'a1', chatId: 'c1' }],
      replies: 0, reactions: 3,
      window: WINDOW, random: () => 0.5,
    });
    expect(plan).toHaveLength(3);
    expect(plan.every((p) => p.kind === 'reaction')).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest tests/lib/tgOutreach/warmupChatSchedule.test.ts`
Expected: FAIL — `replies`/`reactions` не существуют в `PlanChatActivitiesParams`.

- [ ] **Step 3: Правка `chatSchedule.ts`**

В `app/src/lib/tgOutreach/warmup/chatSchedule.ts`:

Заменить импорт (строки 8–17) на:

```ts
import {
  CHATS_PER_ACCOUNT,
  REPLY_TARGET_MAX_AGE_MIN,
  type WarmupActivityKind,
} from './types';
```

Удалить функцию `rampValue` и обе функции `repliesPerAccount` / `reactionsPerAccount` (строки 19–39 исходника) вместе с их комментарием-шапкой.

Заменить `PlanChatActivitiesParams` и начало `planChatActivities` на:

```ts
export interface PlanChatActivitiesParams {
  /** Уже отфильтрованные пары: без запрещённых чатов и отвалившихся аккаунтов. */
  assignments: ChatAssignment[];
  /** Сколько ответов должен дать один аккаунт за этот день. */
  replies: number;
  /** Сколько реакций должен поставить один аккаунт за этот день. */
  reactions: number;
  /** Активное окно суток: ночью аккаунты молчат. */
  window: { start: Date; end: Date };
  random: () => number;
}

/**
 * Составить план активностей на день.
 *
 * Норма считается на аккаунт, а не на чат: аккаунт, которому досталось три
 * чата, не должен писать втрое больше того, кому достался один. Чат под каждую
 * активность выбирается случайно из назначенных этому аккаунту — так следы
 * размазываются, а не выстраиваются в ровную очередь по чатам.
 */
export function planChatActivities(params: PlanChatActivitiesParams): PlannedActivity[] {
  const { assignments, window, random } = params;
  if (!assignments.length) return [];

  const replies = Math.max(params.replies, 0);
  const reactions = Math.max(params.reactions, 0);
  if (!replies && !reactions) return [];
```

Остальное тело функции (сборка `chatsByAccount`, циклы, раскладка времён) остаётся без изменений.

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npx jest tests/lib/tgOutreach/warmupChatSchedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tgOutreach/warmup/chatSchedule.ts app/tests/lib/tgOutreach/warmupChatSchedule.test.ts
git commit -m "refactor(tg-outreach): planChatActivities получает дневные нормы параметром"
```

---

### Task 6: Воркер читает настройки прогона

**Files:**
- Modify: `app/src/lib/tgOutreach/warmup/loop.ts`

- [ ] **Step 1: Добавить импорт настроек**

После строки `import { planDay } from './schedule';` (строка 30) добавить:

```ts
import {
  dailyLimits,
  normalizeWarmupSettings,
  type WarmupSettings,
} from './settings';
```

- [ ] **Step 2: Вынести подготовку этапа чатов в отдельную функцию**

Заменить блок строк 308–352 (от комментария `// Необязательный этап: активность в публичных чатах.` до закрывающей скобки `if (publicChatsEnabled) { ... }`) на:

```ts
  const chatsById = new Map<string, WarmupChat>();
  /** Свои tg_user_id: на публике аккаунты не должны отвечать друг другу. */
  const ownUserIds = new Set<number>();
  for (const a of accounts) if (a.tg_user_id) ownUserIds.add(Number(a.tg_user_id));
```

- [ ] **Step 3: Добавить функцию подготовки этапа**

В конец файла `loop.ts` добавить:

```ts
/**
 * Подготовить этап публичных чатов: подтянуть список чатов и разложить по ним
 * аккаунты.
 *
 * Зовётся каждый круг, а не один раз при старте: этап можно включить настройкой
 * посреди прогрева. Раскладка защищена проверкой `hasChatAssignments` — состав
 * чатов у аккаунта должен быть постоянным, иначе он весь прогрев мигрирует по
 * чатам, а это само по себе заметный след.
 */
async function ensureChatStageReady(params: {
  db: SupabaseClient;
  run: WarmupRun;
  campaignId: string;
  accountIds: string[];
  chatsById: Map<string, WarmupChat>;
  settings: WarmupSettings;
  tg: TelegramSettings;
  log: LogFn;
}): Promise<void> {
  const { db, run, campaignId, accountIds, chatsById, settings, tg, log } = params;

  const chats = await cdb.loadUsableChats(db, campaignId);
  chatsById.clear();
  for (const c of chats) chatsById.set(c.id, c);

  if (!chats.length) {
    log('warning', 'Активность в чатах включена, но в списке нет ни одного проверенного чата — этап пропущен.');
    return;
  }

  if (!(await cdb.hasChatAssignments(db, run.id))) {
    const perAccount = Math.min(settings.chats_per_account, chats.length);
    const assignments = assignChats(accountIds, chats.map((c) => c.id), settings.chats_per_account);
    const w = planningWindow(new Date(), tg);
    const span = Math.max(w.end.getTime() - w.start.getTime(), 1);
    const plannedAt = new Map<string, string>(
      assignments.map((a) => [
        `${a.accountId}|${a.chatId}`,
        // Вступления растянуты по окну: шестнадцать аккаунтов, зашедших в один
        // чат за минуту, — очевидный след.
        new Date(w.start.getTime() + Math.floor(Math.random() * span)).toISOString(),
      ]),
    );
    await cdb.saveChatAssignments(db, run, assignments, plannedAt);
    log(
      'info',
      `Активность в чатах: ${chats.length} чатов, каждому аккаунту назначено до ${perAccount}. Вступление растянуто на сегодня.`,
    );
  }

  const requeued = await cdb.requeueStuckActivities(db, run.id);
  if (requeued > 0) {
    log('info', `Активность в чатах: возвращено в очередь ${requeued} действий после перезапуска.`);
  }
}
```

- [ ] **Step 4: Читать настройки в цикле и передавать нормы**

Внутри `while (!shouldStop())`, сразу после `const day = dayNumber(run, now, tg.timezone_offset ?? 3);` (строка 362) вставить:

```ts
      // Настройки перечитываются каждый круг: оператор может понизить нагрузку,
      // не останавливая прогрев. План дня строится один раз, поэтому правки
      // вступают со следующего дня — так и написано в интерфейсе.
      const settings = normalizeWarmupSettings(fresh.settings);
      const publicChatsEnabled = settings.public_chats;
      const limits = dailyLimits(settings, day);
```

Заменить блок планирования дня (строки 401–411) на:

```ts
      if (!(await wdb.isDayPlanned(db, run.id, day))) {
        const plan = planDay({
          accountIds: [...byAccountId.keys()],
          conversationsPerAccount: limits.conversations,
          messagesPerConversation: limits.messages,
          previousPairs: await wdb.loadPreviousPairs(db, run.id),
          window: planningWindow(now, tg),
          random: Math.random,
        });
        await wdb.saveDayPlan(db, run, day, plan);
        log('info', `Прогрев: день ${day} из ${run.days}, запланировано ${plan.length} переписок.`);
      }
```

Заменить вызов этапа чатов (строки 420–426) на:

```ts
      if (publicChatsEnabled) {
        await ensureChatStageReady({
          db, run, campaignId, accountIds: [...byAccountId.keys()],
          chatsById, settings, tg, log,
        });
        if (chatsById.size) {
          await runChatStage({
            db, run, day, now, tg, limits,
            byAccountId, accountNames, chatsById, ownUserIds,
            shouldStop, log, onProgress,
          });
        }
      }
```

- [ ] **Step 5: Прокинуть нормы в `runChatStage`**

В сигнатуре `runChatStage` добавить поле `limits: DailyLimits;` (импортировать тип из `./settings`), и заменить построение плана активностей на:

```ts
  if (!(await cdb.isActivityDayPlanned(db, run.id, day))) {
    const joined = await cdb.loadJoinedAssignments(db, run.id);
    if (joined.length) {
      const plan = planChatActivities({
        assignments: joined,
        replies: limits.chatMessages,
        reactions: limits.chatReactions,
        window: planningWindow(now, tg),
        random: Math.random,
      });
      await cdb.saveActivityPlan(db, run, day, plan);
      const replies = plan.filter((p) => p.kind === 'reply').length;
      log(
        'info',
        `Активность в чатах: день ${day}, запланировано ${replies} ответов и ${plan.length - replies} реакций.`,
      );
    }
  }
```

- [ ] **Step 6: Убедиться, что старых ссылок не осталось**

`publicChatsEnabled` теперь объявляется внутри цикла сразу после `const day = ...`, то есть до блока завершения прогона (`if (day > run.days)`) и до блока смены дня — оба зовут `cdb.skipRemainingActivities` под этим флагом и должны видеть новое объявление.

Run: `grep -n "publicChatsEnabled\|assignChats\|CHATS_PER_ACCOUNT" src/lib/tgOutreach/warmup/loop.ts`
Expected: `publicChatsEnabled` — только одно объявление (внутри цикла) и его использования ниже по циклу; `assignChats` — только внутри `ensureChatStageReady` и вызывается с `settings.chats_per_account`; `CHATS_PER_ACCOUNT` — не встречается вовсе.

- [ ] **Step 7: Проверить типы**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок.

- [ ] **Step 8: Прогнать все тесты прогрева**

Run: `npx jest tests/lib/tgOutreach/`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/tgOutreach/warmup/loop.ts
git commit -m "feat(tg-outreach): воркер берёт нагрузку из настроек прогона"
```

---

### Task 7: API — чтение и сохранение настроек

**Files:**
- Create: `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/settings/route.ts`
- Modify: `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/route.ts`

- [ ] **Step 1: Роут сохранения настроек**

Создать `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/settings/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { normalizeWarmupSettings } from '@/lib/tgOutreach/warmup/settings';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Сохранить настройки прогрева.
 *
 * Пишем в кампанию — это то, что применится к следующему запуску. Если прогрев
 * идёт, пишем и в снимок прогона: воркер перечитывает его каждый круг, но план
 * дня строит один раз, поэтому новые числа вступят со следующего дня. Ответ
 * говорит об этом флагом `applies_next_day`, чтобы интерфейс не гадал.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.settings.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { supabase } = auth;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { settings?: unknown } | null;
      if (!body || typeof body !== 'object') return jsonError('Пустой запрос', 400);

      const settings = normalizeWarmupSettings(body.settings);

      const { error } = await supabase
        .from('tg_outreach_campaigns')
        .update({ warmup_settings: settings, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return jsonError(error.message, 500);

      const { data: active } = await supabase
        .from('tg_outreach_warmup_runs')
        .select('id, settings')
        .eq('campaign_id', id)
        .in('status', ['pending', 'running'])
        .limit(1)
        .maybeSingle();

      if (active) {
        // Старые ключи снимка не выбрасываем: по ним задним числом видно, по
        // какой кривой прогон начинался.
        const current = (active.settings ?? {}) as Record<string, unknown>;
        const { error: runError } = await supabase
          .from('tg_outreach_warmup_runs')
          .update({ settings: { ...current, ...settings } })
          .eq('id', active.id);
        if (runError) return jsonError(runError.message, 500);
      }

      return NextResponse.json({ settings, applies_next_day: Boolean(active) });
    },
  );
}
```

- [ ] **Step 2: GET `/warmup` отдаёт настройки**

В `app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup/route.ts`:

Добавить импорт:

```ts
import { normalizeWarmupSettings } from '@/lib/tgOutreach/warmup/settings';
```

В `GET`, сразу после `const { id } = await ctx.params;`, добавить чтение кампании:

```ts
      const { data: campaignRow } = await supabase
        .from('tg_outreach_campaigns')
        .select('warmup_settings')
        .eq('id', id)
        .maybeSingle();
```

Заменить ранний возврат «прогрева не было» на:

```ts
      if (!run) {
        return NextResponse.json({
          run: null,
          per_account: [],
          today: null,
          settings: normalizeWarmupSettings(campaignRow?.warmup_settings),
          defaults: defaults(),
        });
      }
```

Перед финальным `return NextResponse.json({...})` добавить:

```ts
      // Пока прогрев идёт, показываем снимок прогона: именно по нему он
      // работает. Для завершённого — настройки кампании: это то, что применится
      // к следующему запуску.
      const settings = normalizeWarmupSettings(
        run.status === 'pending' || run.status === 'running'
          ? run.settings
          : campaignRow?.warmup_settings,
      );
```

и добавить `settings,` в объект ответа (рядом с `chat_stage`).

- [ ] **Step 3: POST `/warmup` копирует настройки кампании в снимок прогона**

В том же файле, в `POST`:

Заменить разбор тела:

```ts
      const body = (await req.json().catch(() => ({}))) as { days?: number };
      const days = Math.min(Math.max(Math.round(body.days ?? DEFAULT_WARMUP_DAYS), 1), 14);
```

Заменить чтение кампании (там, где сейчас `select('id, status')`) на:

```ts
      const { data: campaign } = await supabase
        .from('tg_outreach_campaigns')
        .select('id, status, warmup_settings')
        .eq('id', id)
        .single();
      if (!campaign) return jsonError('Кампания не найдена', 404);
```

Заменить создание прогона на:

```ts
      // Настройки кладём в снимок прогона: перезапуск воркера посреди прогрева
      // должен видеть то же решение, что принял оператор при старте.
      const settings = normalizeWarmupSettings(campaign.warmup_settings);
      const { data: run, error: runError } = await supabase
        .from('tg_outreach_warmup_runs')
        .insert({
          campaign_id: id,
          days,
          status: 'pending',
          settings: { ...defaults(), ...settings },
        })
        .select('*')
        .single();
      if (runError) return jsonError(runError.message, 500);
```

- [ ] **Step 4: Проверить типы и линт**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src/app/api/tools/tg-outreach/campaigns src/lib/tgOutreach/warmup`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add "app/src/app/api/tools/tg-outreach/campaigns/[id]/warmup"
git commit -m "feat(tg-outreach): API настроек прогрева"
```

---

### Task 8: Список чатов как встраиваемая секция

**Files:**
- Create: `app/src/components/tg-outreach/WarmupChatsSection.tsx`
- Delete: `app/src/components/tg-outreach/WarmupChatsTab.tsx` (в Task 10, после отключения вкладки)

- [ ] **Step 1: Создать секцию**

Создать `app/src/components/tg-outreach/WarmupChatsSection.tsx` — копия `WarmupChatsTab.tsx` со снятой внешней шапкой и новым пропом `onChanged`:

```tsx
'use client';

/**
 * Список публичных чатов — секция внутри настроек прогрева.
 *
 * Раньше это была отдельная вкладка кампании. Разносить список чатов и числа,
 * управляющие активностью в этих чатах, по разным экранам незачем: оператор
 * настраивает одно и то же.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { AlertCircle, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CampaignStatus } from '@/lib/tgOutreach/types';
import type { WarmupChat } from '@/lib/tgOutreach/warmup/types';

const API_BASE = '/api/tools/tg-outreach';

interface ChatRow extends WarmupChat {
  joined_accounts: number;
  forbidden_accounts: number;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: 'не проверен', cls: 'bg-gray-100 text-gray-500' },
  resolved: { text: 'готов', cls: 'bg-emerald-50 text-emerald-700' },
  unresolvable: { text: 'не подошёл', cls: 'bg-rose-50 text-rose-700' },
};

export default function WarmupChatsSection({
  campaignId,
  campaignStatus,
  onChanged,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
  /** Дёргается после любого изменения списка: снаружи от него зависят счётчики. */
  onChanged?: () => void;
}) {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState('');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Проверка чатов занимает аккаунт кампании, поэтому доступна только на
  // остановленной — то же правило, что у чтения профиля.
  const canCheck = campaignStatus === 'stopped' || campaignStatus === 'error';

  const load = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats`);
    if (!res.ok) return;
    const data = await res.json();
    setChats((data.items ?? []) as ChatRow[]);
  }, [campaignId]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const reload = async () => {
    await load();
    onChanged?.();
  };

  const addChats = async () => {
    const links = bulkText.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!links.length) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats`, {
        method: 'POST',
        body: JSON.stringify({ links }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Не получилось добавить');
        return;
      }
      setBulkText('');
      const rejected = (data.rejected ?? []) as string[];
      setNotice(
        rejected.length
          ? `Добавлено ${data.added}. Не подошли (закрытые чаты и мусор): ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? ` и ещё ${rejected.length - 3}` : ''}`
          : `Добавлено ${data.added}. Нажмите «Проверить», чтобы портал узнал названия.`,
      );
      await reload();
    } finally {
      setAdding(false);
    }
  };

  const checkChats = async () => {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats/check`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Не получилось проверить');
        return;
      }
      setNotice(`Проверено ${data.checked}, подошло ${data.resolved}.`);
      await reload();
    } finally {
      setChecking(false);
    }
  };

  const toggleActive = async (chat: ChatRow) => {
    await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats/${chat.id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !chat.is_active }),
    });
    await reload();
  };

  const removeChat = async (chat: ChatRow) => {
    if (!confirm(`Убрать «${chat.title ?? chat.link}» из списка? Аккаунты из самого чата не выйдут.`)) return;
    await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats/${chat.id}`, {
      method: 'DELETE',
    });
    await reload();
  };

  const usable = chats.filter((c) => c.status === 'resolved' && c.is_active).length;
  const unchecked = chats.filter((c) => c.status === 'pending').length;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-[11px] text-gray-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загружаю чаты…
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-xl bg-gray-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-gray-600">
          Чаты <span className="text-gray-400">
            {usable} готов{usable === 1 ? '' : 'ы'}
            {unchecked > 0 ? ` · ${unchecked} не проверен${unchecked === 1 ? '' : 'о'}` : ''}
          </span>
        </span>
        <button
          type="button"
          disabled={!canCheck || checking || !chats.length}
          onClick={() => { void checkChats(); }}
          title={canCheck ? 'Узнать названия чатов и отсеять неподходящие' : 'Сначала остановите кампанию'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {checking ? 'Проверяю…' : 'Проверить'}
        </button>
      </div>

      {usable === 1 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            В списке один рабочий чат — все аккаунты окажутся в нём. Это заметный след: по одному
            спалившемуся аккаунту находятся остальные. Лучше добавить хотя бы три-четыре.
          </span>
        </div>
      )}

      {chats.length > 0 && (
        <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {chats.map((chat) => {
            const badge = STATUS_LABEL[chat.status] ?? STATUS_LABEL.pending;
            return (
              <div
                key={chat.id}
                className={`grid grid-cols-[1fr_92px_86px_32px] items-center gap-2 px-2.5 py-1.5 ${chat.is_active ? '' : 'opacity-50'}`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[11px] text-gray-800">{chat.title ?? chat.link}</div>
                  <div className="truncate text-[10px] text-gray-400">
                    {chat.link}
                    {chat.participants_count ? ` · ${chat.participants_count.toLocaleString('ru-RU')}` : ''}
                    {chat.error_reason ? ` · ${chat.error_reason}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void toggleActive(chat); }}
                  title={chat.is_active ? 'Выключить чат' : 'Включить чат'}
                  className={`w-fit cursor-pointer rounded px-1.5 py-0.5 text-[10px] transition hover:opacity-80 ${badge.cls}`}
                >
                  {chat.is_active ? badge.text : 'выключен'}
                </button>
                <span className="text-[10px] text-gray-500">
                  {chat.joined_accounts > 0 ? `${chat.joined_accounts} вступило` : '—'}
                  {chat.forbidden_accounts > 0 && (
                    <span className="text-amber-600"> · {chat.forbidden_accounts} запрет</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => { void removeChat(chat); }}
                  title="Убрать из списка"
                  className="cursor-pointer rounded p-1 text-gray-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <textarea
        value={bulkText}
        onChange={(e) => setBulkText(e.target.value)}
        rows={2}
        placeholder={'t.me/chat_name\n@another_chat'}
        className="block w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-indigo-400"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { void addChats(); }}
          disabled={adding || !bulkText.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Добавить
        </button>
        <span className="text-[10px] text-gray-400">Закрытые чаты по приглашениям не поддерживаются</span>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-600">{notice}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок. (Компонент пока никем не используется — это нормально.)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/tg-outreach/WarmupChatsSection.tsx
git commit -m "refactor(tg-outreach): список чатов как встраиваемая секция"
```

---

### Task 9: Таблица настройки по дням

**Files:**
- Create: `app/src/components/tg-outreach/WarmupDayTable.tsx`

- [ ] **Step 1: Создать компонент таблицы**

Создать `app/src/components/tg-outreach/WarmupDayTable.tsx`:

```tsx
'use client';

/**
 * Таблица «День 1…N × четыре нормы».
 *
 * Отдельный файл, потому что это единственная часть настроек с собственной
 * механикой ввода: остальное — пары полей. Строки приходят готовыми
 * (`perDayForEditing` уже дозаполнил недостающие дни кривой), компонент только
 * рисует и сообщает наверх о правках.
 */

import React from 'react';
import { FIELD_BOUNDS, type WarmupParamKey, type WarmupPerDayRow } from '@/lib/tgOutreach/warmup/settings';

const COLUMNS: Array<{ key: WarmupParamKey; label: string }> = [
  { key: 'conversations', label: 'Переписок' },
  { key: 'messages', label: 'Сообщений в переписке' },
  { key: 'chat_messages', label: 'Сообщений в чатах' },
  { key: 'chat_reactions', label: 'Реакций' },
];

export default function WarmupDayTable({
  rows,
  currentDay,
  chatsEnabled,
  disabled,
  onChange,
}: {
  rows: WarmupPerDayRow[];
  /** Идущий день прогрева — подсвечиваем и предупреждаем, что правка опоздала. */
  currentDay: number | null;
  /** Этап чатов выключен — колонки по чатам гасим, но не прячем. */
  chatsEnabled: boolean;
  disabled: boolean;
  onChange: (dayIndex: number, key: WarmupParamKey, value: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-[11px]">
        <thead>
          <tr className="text-gray-400">
            <th className="w-14 py-1 text-left font-normal">День</th>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`py-1 text-center font-normal ${
                  !chatsEnabled && c.key.startsWith('chat_') ? 'text-gray-300' : ''
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const day = i + 1;
            const isCurrent = currentDay === day;
            const isPast = currentDay !== null && day < currentDay;
            return (
              <tr key={day} className={isCurrent ? 'bg-indigo-50' : ''}>
                <td className={`py-1 ${isCurrent ? 'text-indigo-700' : isPast ? 'text-gray-300' : 'text-gray-500'}`}>
                  {day}
                  {isCurrent && <span className="ml-1 text-[10px]">сегодня</span>}
                </td>
                {COLUMNS.map((c) => {
                  const bounds = FIELD_BOUNDS[c.key];
                  const dim = !chatsEnabled && c.key.startsWith('chat_');
                  return (
                    <td key={c.key} className="py-1 text-center">
                      <input
                        type="number"
                        min={bounds.min}
                        max={bounds.max}
                        value={row[c.key]}
                        disabled={disabled || dim}
                        title={
                          isCurrent || isPast
                            ? 'План этого дня уже составлен — правка вступит со следующего'
                            : undefined
                        }
                        onChange={(e) => onChange(i, c.key, Number(e.target.value))}
                        className={`w-14 rounded-lg border px-1.5 py-1 text-center text-[11px] outline-none focus:border-indigo-400 disabled:opacity-40 ${
                          isCurrent ? 'border-indigo-300 bg-white' : 'border-gray-200 bg-gray-50'
                        } ${isPast ? 'text-gray-400' : 'text-gray-800'}`}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/tg-outreach/WarmupDayTable.tsx
git commit -m "feat(tg-outreach): таблица настройки прогрева по дням"
```

---

### Task 10: Блок настроек прогрева

**Files:**
- Create: `app/src/components/tg-outreach/WarmupSettingsPanel.tsx`

- [ ] **Step 1: Создать панель**

Создать `app/src/components/tg-outreach/WarmupSettingsPanel.tsx`:

```tsx
'use client';

/**
 * Блок «Настройки прогрева» на вкладке «Прогрев».
 *
 * Свёрнут по умолчанию, пока прогрев идёт: оператор открывает вкладку, чтобы
 * смотреть, а не настраивать, и экран без того плотный. Внутри две секции —
 * переписка между своими и активность в публичных чатах; список чатов лежит во
 * второй, рядом с числами, которые им управляют.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { ChevronDown, ChevronRight, Loader2, Save } from 'lucide-react';
import type { CampaignStatus } from '@/lib/tgOutreach/types';
import {
  FIELD_BOUNDS,
  curveToPerDay,
  perDayForEditing,
  type WarmupParamKey,
  type WarmupSettings,
} from '@/lib/tgOutreach/warmup/settings';
import WarmupChatsSection from './WarmupChatsSection';
import WarmupDayTable from './WarmupDayTable';

const API_BASE = '/api/tools/tg-outreach';

const PARAM_LABEL: Record<WarmupParamKey, string> = {
  conversations: 'Переписок в день на аккаунт',
  messages: 'Сообщений в одной переписке',
  chat_messages: 'Сообщений в день на аккаунт',
  chat_reactions: 'Реакций в день на аккаунт',
};

/** Пара полей «первый день → потолок» одного параметра. */
function CurveRow({
  paramKey,
  first,
  peak,
  disabled,
  onChange,
}: {
  paramKey: WarmupParamKey;
  first: number;
  peak: number;
  disabled: boolean;
  onChange: (field: 'first' | 'peak', value: number) => void;
}) {
  const bounds = FIELD_BOUNDS[paramKey];
  const input = (field: 'first' | 'peak', value: number) => (
    <input
      type="number"
      min={bounds.min}
      max={bounds.max}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(field, Number(e.target.value))}
      className="w-14 rounded-lg border border-gray-200 bg-gray-50 px-1.5 py-1 text-center text-[11px] text-gray-800 outline-none focus:border-indigo-400 disabled:opacity-40"
    />
  );
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-gray-600">{PARAM_LABEL[paramKey]}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {input('first', first)}
        <span className="text-[11px] text-gray-400">→</span>
        {input('peak', peak)}
      </span>
    </div>
  );
}

export default function WarmupSettingsPanel({
  campaignId,
  campaignStatus,
  settings,
  days,
  currentDay,
  runActive,
  onSaved,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
  settings: WarmupSettings;
  /** Сколько дней выбрано в полосе управления — столько строк в таблице. */
  days: number;
  /** Идущий день прогрева или null. */
  currentDay: number | null;
  runActive: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(!runActive);
  const [draft, setDraft] = useState<WarmupSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  /** Предпросмотр кривой: без него «2 → 8» ничего не говорит про среду. */
  const preview = useMemo(() => curveToPerDay(draft, Math.min(days, 7)), [draft, days]);

  const tableRows = useMemo(() => perDayForEditing(draft, days), [draft, days]);

  const setCurve = (key: WarmupParamKey, field: 'first' | 'peak', value: number) => {
    setDraft((d) => ({
      ...d,
      curve: { ...d.curve, [key]: { ...d.curve[key], [field]: value } },
    }));
  };

  const setCell = (dayIndex: number, key: WarmupParamKey, value: number) => {
    setDraft((d) => {
      const rows = perDayForEditing(d, days);
      rows[dayIndex] = { ...rows[dayIndex], [key]: value };
      return { ...d, per_day: rows };
    });
  };

  /**
   * Включение ручного режима фиксирует текущую кривую в таблице: правят потом
   * пару клеток, а не заполняют двадцать полей с нуля.
   */
  const toggleManual = (manual: boolean) => {
    setDraft((d) => ({
      ...d,
      mode: manual ? 'manual' : 'curve',
      per_day: manual && !d.per_day.length ? perDayForEditing(d, days) : d.per_day,
    }));
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Не получилось сохранить');
        return;
      }
      // Забираем то, что сервер реально записал: он мог зажать число в границы,
      // и без этой строки панель осталась бы «не сохранено» навсегда.
      if (data.settings) setDraft(data.settings as WarmupSettings);
      setNotice(
        data.applies_next_day
          ? 'Сохранено. План сегодняшнего дня уже составлен — новые числа вступят со следующего.'
          : 'Сохранено. Применится при следующем запуске прогрева.',
      );
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [campaignId, draft, onSaved]);

  const chatsEnabled = draft.public_chats;

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Настройки прогрева
          {dirty && <span className="text-[10px] font-normal text-amber-600">не сохранено</span>}
        </span>
        <span className="text-[11px] text-gray-400">
          {draft.mode === 'manual' ? 'по дням вручную' : 'разгон по кривой'} · дней: {days}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">Между своими</p>
            <CurveRow
              paramKey="conversations"
              first={draft.curve.conversations.first}
              peak={draft.curve.conversations.peak}
              disabled={draft.mode === 'manual'}
              onChange={(f, v) => setCurve('conversations', f, v)}
            />
            <CurveRow
              paramKey="messages"
              first={draft.curve.messages.first}
              peak={draft.curve.messages.peak}
              disabled={draft.mode === 'manual'}
              onChange={(f, v) => setCurve('messages', f, v)}
            />
            {draft.mode === 'curve' && (
              <p className="mt-1 text-[10px] text-gray-400">
                {preview
                  .map((r, i) => `день ${i + 1} · ${r.conversations}×${r.messages}`)
                  .join('  →  ')}
              </p>
            )}
          </div>

          <div className="border-t border-gray-100 pt-3">
            <label className="mb-1 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chatsEnabled}
                onChange={(e) => setDraft((d) => ({ ...d, public_chats: e.target.checked }))}
                className="h-3.5 w-3.5 accent-indigo-600"
              />
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                В публичных чатах
              </span>
            </label>

            {chatsEnabled && (
              <>
                <CurveRow
                  paramKey="chat_messages"
                  first={draft.curve.chat_messages.first}
                  peak={draft.curve.chat_messages.peak}
                  disabled={draft.mode === 'manual'}
                  onChange={(f, v) => setCurve('chat_messages', f, v)}
                />
                <CurveRow
                  paramKey="chat_reactions"
                  first={draft.curve.chat_reactions.first}
                  peak={draft.curve.chat_reactions.peak}
                  disabled={draft.mode === 'manual'}
                  onChange={(f, v) => setCurve('chat_reactions', f, v)}
                />
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="text-[11px] text-gray-600">Чатов на аккаунт</span>
                  <input
                    type="number"
                    min={FIELD_BOUNDS.chats_per_account.min}
                    max={FIELD_BOUNDS.chats_per_account.max}
                    value={draft.chats_per_account}
                    onChange={(e) => setDraft((d) => ({ ...d, chats_per_account: Number(e.target.value) }))}
                    className="w-14 rounded-lg border border-gray-200 bg-gray-50 px-1.5 py-1 text-center text-[11px] text-gray-800 outline-none focus:border-indigo-400"
                  />
                </div>
                <div className="mt-2">
                  <WarmupChatsSection
                    campaignId={campaignId}
                    campaignStatus={campaignStatus}
                    onChanged={onSaved}
                  />
                </div>
              </>
            )}
          </div>

          <div className="border-t border-gray-100 pt-3">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-gray-600">
              <input
                type="checkbox"
                checked={draft.mode === 'manual'}
                onChange={(e) => toggleManual(e.target.checked)}
                className="h-3.5 w-3.5 accent-indigo-600"
              />
              Задать по дням вручную
            </label>
            {draft.mode === 'manual' && (
              <div className="mt-2">
                <WarmupDayTable
                  rows={tableRows}
                  currentDay={currentDay}
                  chatsEnabled={chatsEnabled}
                  disabled={false}
                  onChange={setCell}
                />
                <p className="mt-1.5 text-[10px] text-gray-400">
                  Пока галочка стоит, поля выше не действуют. Снимете — вернётся разгон по кривой,
                  а таблица сохранится до следующего включения.
                </p>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">{error}</div>
          )}
          {notice && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-600">{notice}</div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => setDraft(settings)}
              className="rounded-lg px-3 py-1.5 text-[11px] text-gray-500 transition hover:bg-gray-50 disabled:opacity-40"
            >
              Отменить
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Сохранить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Проверить типы и линт**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src/components/tg-outreach`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/tg-outreach/WarmupSettingsPanel.tsx
git commit -m "feat(tg-outreach): блок настроек прогрева с секциями и таблицей"
```

---

### Task 11: Подключить панель и убрать вкладку «Чаты»

**Files:**
- Modify: `app/src/components/tg-outreach/WarmupTab.tsx`
- Modify: `app/src/app/tools/tg-outreach/page.tsx`
- Delete: `app/src/components/tg-outreach/WarmupChatsTab.tsx`

- [ ] **Step 1: Подключить панель в `WarmupTab.tsx`**

Добавить импорты после существующих:

```ts
import WarmupSettingsPanel from './WarmupSettingsPanel';
import {
  defaultWarmupSettings,
  normalizeWarmupSettings,
  type WarmupSettings,
} from '@/lib/tgOutreach/warmup/settings';
```

В интерфейс `WarmupStatus` добавить поле:

```ts
  settings?: WarmupSettings;
```

Заменить состояние `publicChats` на состояние настроек: удалить строку `const [publicChats, setPublicChats] = useState(false);` и добавить

```ts
  const [settings, setSettings] = useState<WarmupSettings>(defaultWarmupSettings());
```

В `loadStatus` после `setStatus(data);` добавить:

```ts
    setSettings(normalizeWarmupSettings(data.settings));
```

В `act` убрать `public_chats` из тела запроса:

```ts
              body: JSON.stringify({ days }),
```

Удалить из полосы управления весь `<label>` с галочкой «Активность в чатах» (блок с комментарием `{/* Необязательный этап. Без проверенных чатов включать нечего ... */}`).

Заменить строку

```ts
  const chatStageVisible = Boolean(chatStage?.enabled) || (!run && usableChats > 0);
```

на

```ts
  // Ленту активностей показываем, если этап включён в прогоне либо включён в
  // настройках — оператор должен видеть, что переключатель живой.
  const chatStageVisible = Boolean(chatStage?.enabled) || settings.public_chats;
```

Сразу после закрывающего тега полосы управления (после блока `{error && ...}` и его `</div>`) вставить панель:

```tsx
      <WarmupSettingsPanel
        campaignId={campaignId}
        campaignStatus={campaignStatus}
        settings={settings}
        days={days}
        currentDay={isRunning && run ? run.current_day : null}
        runActive={isRunning}
        onSaved={() => { void loadStatus(); void loadChats(); }}
      />
```

- [ ] **Step 2: Убрать вкладку из `page.tsx`**

Удалить строку из `TABS`:

```ts
  { id: 'warmup-chats', label: 'Чаты', icon: MessageSquareMore },
```

Удалить ветку отрисовки:

```tsx
        {tab === 'warmup-chats' && (
          <WarmupChatsTab campaignId={campaign.id} campaignStatus={campaign.status} />
        )}
```

Удалить импорт `WarmupChatsTab`. Проверить, используется ли ещё иконка `MessageSquareMore` — если нет, убрать её из импорта `lucide-react`.

Run: `grep -n "MessageSquareMore" src/app/tools/tg-outreach/page.tsx`
Если единственное вхождение — строка импорта, удалить её оттуда.

- [ ] **Step 3: Удалить старый компонент вкладки**

```bash
git rm app/src/components/tg-outreach/WarmupChatsTab.tsx
```

- [ ] **Step 4: Проверить типы и линт**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src`
Expected: без ошибок и без предупреждений о неиспользуемых импортах.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/tg-outreach/WarmupTab.tsx app/src/app/tools/tg-outreach/page.tsx
git commit -m "feat(tg-outreach): настройки прогрева на вкладке, вкладка «Чаты» убрана"
```

---

### Task 12: Финальная проверка

**Files:** нет изменений, только проверки.

- [ ] **Step 1: Прогнать весь набор тестов**

Run: `npx jest`
Expected: PASS. Ни один тест не должен упасть — включая те, что не относятся к прогреву.

- [ ] **Step 2: Проверить типы всего проекта**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок.

- [ ] **Step 3: Линт**

Run: `npx eslint src`
Expected: без ошибок.

- [ ] **Step 4: Сборка**

Run: `npm run build`
Expected: сборка проходит, вкладка `warmup-chats` нигде не упоминается.

- [ ] **Step 5: Проверить, что мёртвых ссылок не осталось**

Run: `grep -rn "WarmupChatsTab\|warmup-chats\|repliesPerAccount\|reactionsPerAccount\|conversationsPerAccount\|messagesPerConversation\|targetOverride\|repliesOverride\|reactionsOverride" src tests`
Expected: пусто.

- [ ] **Step 6: Проверить в браузере**

Запустить дев-сервер, открыть кампанию TG-аутрича:

1. Вкладки «Чаты» нет, вкладка «Прогрев» открывается.
2. Блок «Настройки прогрева» раскрывается, поля заполнены дефолтами (2→8, 3→10).
3. Предпросмотр под полями показывает `день 1 · 2×3 → день 2 · 3×4 → …`.
4. Переключатель «В публичных чатах» раскрывает поля и список чатов; добавление ссылки и «Проверить» работают как на бывшей вкладке.
5. Галочка «задать по дням вручную» раскрывает таблицу, предзаполненную кривой; правка клетки меняет значение.
6. «Сохранить» показывает сообщение, перезагрузка страницы сохраняет значения.

- [ ] **Step 7: Commit (если что-то поправили)**

```bash
git add -A
git commit -m "fix(tg-outreach): правки по итогам проверки настроек прогрева"
```

---

## Порядок и зависимости

Задачи идут строго по порядку: 1 → 2 → 3 (модуль и его тесты) → 4, 5 (планировщики) → 6 (воркер) → 7 (API) → 8, 9 (компоненты-кирпичи) → 10 (панель) → 11 (сборка вкладки) → 12 (проверка).

Задачи 8 и 9 независимы друг от друга — их можно делать в любом порядке, но обе должны быть готовы до задачи 10.
