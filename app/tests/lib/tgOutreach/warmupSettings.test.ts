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
