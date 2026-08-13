/** @jest-environment node */

/**
 * Сообщение, которым лид или партнёр уходит человеку. Оно живёт в чате
 * менеджера и по нему принимают решения, поэтому проверяем состав шапки, а не
 * «функция вернула строку».
 */

import {
  buildLeadMessage,
  splitTelegramMessage,
  TELEGRAM_MESSAGE_LIMIT,
  type LeadMessageInput,
} from '@/lib/tgOutreach/leadMessage';

const input = (over: Partial<LeadMessageInput> = {}): LeadMessageInput => ({
  kind: 'lead',
  campaignName: 'ATOL-1',
  username: '@koraleva_vasilisa_investbuh',
  tgUserId: 777,
  baseName: 'Гипотеза 1',
  sourceChat: 'https://t.me/buhrussia',
  accountLabel: 'Mihail Leshko',
  accountPhone: '998336042756',
  messages: [
    { role: 'assistant', content: 'Иван, добрый день!', timestamp: '2026-08-11T16:25:00.000Z' },
    { role: 'user', content: 'Да, интересно', timestamp: '2026-08-12T09:40:00.000Z' },
  ],
  tzOffsetHours: 3,
  ...over,
});

describe('buildLeadMessage', () => {
  it('шапка отвечает на «кто и откуда»', () => {
    const text = buildLeadMessage(input());

    expect(text).toContain('🔥 Лид · ATOL-1');
    expect(text).toContain('Никнейм: @koraleva_vasilisa_investbuh');
    expect(text).toContain('Профиль: t.me/koraleva_vasilisa_investbuh');
    expect(text).toContain('Оффер: Гипотеза 1');
    expect(text).toContain('Источник: https://t.me/buhrussia');
    expect(text).toContain('Аккаунт: Mihail Leshko (998336042756)');
  });

  /**
   * Времена первого касания и ответа видны в самих репликах, а «кто передал» —
   * след для портала, не для менеджера. В шапке их быть не должно.
   */
  it('в шапке нет ни времён, ни того, кто нажал кнопку', () => {
    const text = buildLeadMessage(input());
    expect(text).not.toContain('Первое касание');
    expect(text).not.toContain('Ответил:');
    expect(text).not.toContain('Передал:');
  });

  it('партнёр отличается заголовком, остальное — то же', () => {
    const text = buildLeadMessage(input({ kind: 'partner' }));
    expect(text).toContain('🤝 Кандидат в партнёры · ATOL-1');
    expect(text).not.toContain('🔥 Лид');
  });

  it('переписка идёт целиком и подписана человеческими ролями', () => {
    const text = buildLeadMessage(input());
    expect(text).toContain('Мы: Иван, добрый день!');
    expect(text).toContain('Клиент: Да, интересно');
    expect(text).not.toContain('assistant');
  });

  it('чего не знаем — прочерк, а не пустое место и не «undefined»', () => {
    const text = buildLeadMessage(input({ baseName: null, sourceChat: null, accountPhone: null }));
    expect(text).toContain('Оффер: —');
    expect(text).toContain('Источник: —');
    // Телефона нет — скобок тоже быть не должно, а не «(null)».
    expect(text).toContain('Аккаунт: Mihail Leshko\n');
    expect(text).not.toContain('undefined');
  });

  it('без юзернейма показываем ID и не рисуем битую ссылку на профиль', () => {
    const text = buildLeadMessage(input({ username: null }));
    expect(text).toContain('Никнейм: ID 777');
    // Строки «Профиль» быть не должно: ссылка на t.me без юзернейма никуда не
    // ведёт. Проверяем именно её, а не подстроку «t.me/» — она законно есть в
    // источнике контакта.
    expect(text).not.toContain('Профиль:');
  });

  it('пустая переписка названа прямо', () => {
    const text = buildLeadMessage(input({ messages: [] }));
    expect(text).toContain('(переписка не сохранилась)');
  });

  it('битую метку времени у реплики просто опускаем', () => {
    const text = buildLeadMessage(input({
      messages: [{ role: 'user', content: 'Да, интересно', timestamp: 'не дата' }],
    }));
    expect(text).toContain('Клиент: Да, интересно');
    expect(text).not.toContain('Invalid');
    expect(text).not.toContain('[]');
  });
});

describe('splitTelegramMessage', () => {
  it('короткое сообщение не режет', () => {
    expect(splitTelegramMessage('привет')).toEqual(['привет']);
  });

  it('режет по границам строк, не рвя реплики', () => {
    const parts = splitTelegramMessage('аааа\nбббб\nвввв', 9);
    expect(parts).toEqual(['аааа\nбббб', 'вввв']);
    expect(parts.every((p) => p.length <= 9)).toBe(true);
  });

  it('строку длиннее предела режет жёстко — иначе она не уйдёт вовсе', () => {
    const parts = splitTelegramMessage('я'.repeat(25), 10);
    expect(parts).toEqual(['я'.repeat(10), 'я'.repeat(10), 'я'.repeat(5)]);
  });

  it('длинная переписка укладывается в предел Telegram', () => {
    const long = buildLeadMessage(input({
      messages: Array.from({ length: 400 }, (_, i) => ({
        role: i % 2 ? 'user' : 'assistant',
        content: `сообщение номер ${i} с текстом подлиннее`,
        timestamp: '2026-08-12T09:40:00.000Z',
      })),
    }));

    const parts = splitTelegramMessage(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true);
    expect(parts.join('\n')).toBe(long);
  });
});
