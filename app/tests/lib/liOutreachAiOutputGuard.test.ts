/** @jest-environment node */

/**
 * Инцидент 19.08.2026: GPT сочинил из 300-знакового шаблона деловое письмо и
 * оно ушло человеку из Oracle с незаполненной подписью `[Ваше имя]`.
 * Тесты держат оба конца: реальный текст того письма должен отбиваться, а
 * нормальная персонализация — проходить.
 */

import { findAiOutputProblems, maxAllowedLength } from '@/lib/liOutreach/aiOutputGuard';
import { parseMessageTemplate } from '@/lib/liOutreach/aiService';

/** Лид из инцидента 19.08 — через него шаблоны прогоняются ровно так, как это делает раннер. */
const LEAD = {
  name: 'Ярослав Кметь',
  first_name: 'Ярослав',
  last_name: 'Кметь',
  company: 'Oracle',
  position: 'CTO',
};

const TEMPLATE =
  '{{name}}, живой пример: у клиента было 25+ подрядчиков в 7 странах — договоры, инвойсы и выплаты ' +
  'в трёх разных сервисах, HR жил в таблицах. Свели всё в один YouGo. Тот же объём — без ручного ада ' +
  'и с меньшей комиссией. Показать, как это выглядело до и после?';

/** Ровно то, что ушло Jaroslav Kmeť в 09:38. */
const ROGUE_LETTER = `Здравствуйте, Jaroslav!

Надеюсь, у вас все хорошо. Хочу поделиться примером успешного решения, которое может быть интересно для Oracle Corporation. Один из наших клиентов столкнулся с проблемой управления 25+ подрядчиками в 7 странах, использовал три разных сервиса для договоров, инвойсов и выплат, а HR-отдел вел все на таблицах.

После внедрения YouGo мы смогли свести все процессы в одном месте.

С уважением,
[Ваше имя]
[Ваша должность]
[Контактная информация]`;

describe('findAiOutputProblems — то, что реально ушло людям', () => {
  it('отбивает письмо, ушедшее в Oracle', () => {
    const problem = findAiOutputProblems(TEMPLATE, ROGUE_LETTER);
    expect(problem).not.toBeNull();
    expect(problem!.kind).toBe('placeholder');
    expect(problem!.reason).toContain('[Ваше имя]');
  });

  it('отбивает подпись даже без заглушек', () => {
    const withSignature = 'Иван, показать пример до и после?\n\nС уважением,\nЭльвира';
    expect(findAiOutputProblems(TEMPLATE, withSignature)?.kind).toBe('signature');
  });

  it('отбивает письмо со строкой темы', () => {
    const withSubject = 'Subject: Exploring Opportunities\n\nHi Richard, I hope this message finds you well.';
    expect(findAiOutputProblems(TEMPLATE, withSubject)?.kind).toBe('subject');
  });

  it('отбивает ответ вдвое длиннее шаблона', () => {
    const tooLong = 'а'.repeat(maxAllowedLength(TEMPLATE) + 1);
    expect(findAiOutputProblems(TEMPLATE, tooLong)?.kind).toBe('too_long');
  });

  it('отбивает пустой ответ', () => {
    expect(findAiOutputProblems(TEMPLATE, '   ')).not.toBeNull();
  });
});

describe('findAiOutputProblems — нормальную персонализацию не трогает', () => {
  it('пропускает живой человеческий вариант', () => {
    const good =
      'Ярослав, у клиента было 25+ подрядчиков в 7 странах: договоры, инвойсы и выплаты в трёх сервисах. ' +
      'Свели всё в YouGo — тот же объём без ручного ада. Показать, как выглядело до и после?';
    expect(findAiOutputProblems(TEMPLATE, good)).toBeNull();
  });

  it('пропускает текст чуть длиннее шаблона', () => {
    const slightlyLonger = `${TEMPLATE} Похоже на вашу ситуацию в Oracle?`;
    expect(findAiOutputProblems(TEMPLATE, slightlyLonger)).toBeNull();
  });

  it('не запрещает осмысленную правку очень короткого шаблона', () => {
    // Нижняя граница 400 знаков: иначе «{{name}}, привет!» блокировал бы любую правку.
    const short = '{{name}}, привет!';
    const rewritten = 'Ярослав, привет! Увидел, что вы развиваете направление в Oracle — есть короткий кейс, показать?';
    expect(findAiOutputProblems(short, rewritten)).toBeNull();
    expect(maxAllowedLength(short)).toBe(400);
  });

  it('не считает скобками обычный текст со ссылкой в квадратных скобках markdown-стиля', () => {
    // Одиночный символ в скобках под порог не подпадает — правило требует 2+ знаков,
    // но осмысленную заглушку ловит. Здесь проверяем, что мы не слишком жадные.
    expect(findAiOutputProblems(TEMPLATE, 'Иван, вот кейс: пример [1] из нашей практики. Показать?')).toBeNull();
  });
});

describe('findAiOutputProblems — претензия только к тому, что модель добавила', () => {
  // Аудит 19.08: правило судило текст само по себе, поэтому шаблон оператора со
  // скобками или подписью навсегда выключал персонализацию у всей кампании,
  // при этом лог уверял, что «модель написала письмо».
  it('не ругается на скобки, которые оператор написал сам', () => {
    const tpl = 'Иван, [кейс по вашей отрасли] — показать?';
    const gen = 'Ярослав, [кейс по вашей отрасли] — показать, как это выглядело?';
    expect(findAiOutputProblems(tpl, gen)).toBeNull();
  });

  it('не ругается на подпись, если она была в шаблоне', () => {
    // Шаблон приходит в гард ПОСЛЕ parseMessageTemplate, который схлопывает
    // его в одну строку (aiService.ts) — многострочного шаблона на реальном
    // пути не бывает. Подаём именно то, что видит раннер: до фикса подпись
    // оператора в таком виде никогда не совпадала с якорной регуляркой, и
    // персонализация молча отключалась у всей кампании.
    const tpl = parseMessageTemplate('{{firstName}}, показать пример?\n\nС уважением, Эльвира', LEAD);
    const gen = 'Ярослав, показать пример до и после?\n\nС уважением, Эльвира';
    expect(findAiOutputProblems(tpl, gen)).toBeNull();
  });

  it('всё равно ловит подпись, которой в шаблоне не было', () => {
    const tpl = 'Иван, показать пример?';
    expect(findAiOutputProblems(tpl, 'Иван, показать пример?\n\nС уважением,\nЭльвира')?.kind)
      .toBe('signature');
  });
});

describe('findAiOutputProblems — потолок длины для инвайта', () => {
  // Инвайт принимает 300 знаков. Без явного потолка правило длины на этом пути
  // недостижимо: общая формула даёт минимум 400.
  it('режет письмо на 301 знаке, когда задан потолок инвайта', () => {
    const tpl = 'Здравствуйте, {{name}}! Обратил внимание на {{company}}.';
    const long = 'а'.repeat(301);
    expect(findAiOutputProblems(tpl, long, { maxChars: 300 })?.kind).toBe('too_long');
    // Без потолка тот же текст прошёл бы: 301 < max(2*55, 400).
    expect(findAiOutputProblems(tpl, long)).toBeNull();
  });

  it('нормальный инвайт в 280 знаков проходит', () => {
    const tpl = 'Здравствуйте, {{name}}!';
    expect(findAiOutputProblems(tpl, 'Здравствуйте, Ярослав! '.padEnd(280, 'x'), { maxChars: 300 }))
      .toBeNull();
  });
});

describe('findAiOutputProblems — сравнение конкретных токенов, а не классов', () => {
  // Аудит 20.08: условие вида `placeholder && !PLACEHOLDER_RE.test(source)`
  // спрашивало «есть ли в шаблоне ХОТЬ ОДНА скобка», а не «эта ли скобка была
  // в шаблоне». Одна своя заглушка оператора выключала правило целиком, и
  // добавленные моделью [Ваше имя] снова уходили лиду — ровно инцидент 19.08.
  it('своя скобка в шаблоне не выключает правило для чужих заглушек модели', () => {
    const tpl = 'Иван, [кейс по вашей отрасли] — показать?';
    const gen =
      'Ярослав, [кейс по вашей отрасли] — показать, как это выглядело?\n\n[Ваше имя]\n[Ваша должность]';
    const problem = findAiOutputProblems(tpl, gen);
    expect(problem?.kind).toBe('placeholder');
    expect(problem?.reason).toContain('[Ваше имя]');
  });

  it('из двух скобок в ответе ругается только на ту, которой не было в шаблоне', () => {
    const tpl = 'Иван, [кейс по вашей отрасли] — показать?';
    const gen = 'Ярослав, [кейс по вашей отрасли] показать? Пришлю [контакт коллеги].';
    const problem = findAiOutputProblems(tpl, gen);
    expect(problem?.kind).toBe('placeholder');
    expect(problem?.reason).toContain('[контакт коллеги]');
  });

  it('своя «С уважением» в шаблоне не спасает чужую «Best regards» от модели', () => {
    const tpl = parseMessageTemplate('{{firstName}}, показать пример?\n\nС уважением, Эльвира', LEAD);
    const gen = 'Ярослав, показать пример?\n\nBest regards,\nElvira';
    expect(findAiOutputProblems(tpl, gen)?.kind).toBe('signature');
  });
});

describe('findAiOutputProblems — потолок инвайта и длинный шаблон', () => {
  // Аудит 20.08: `limit = opts.maxChars ?? maxAllowedLength(source)` выбрасывал
  // нижнюю границу от размера шаблона. Шаблон длиннее 300 знаков штатно
  // существует (длина инвайта при сохранении ничем не ограничена), и для него
  // правило срабатывало на ЛЮБОЙ ответ — включая сам шаблон, который
  // personalizeInviteMessage возвращает при падении API. Гард обвинял модель
  // в ответе, которого не было.
  it('ответ, равный шаблону длиннее потолка, — не too_long: модель ничего не добавила', () => {
    const tpl = `Здравствуйте, {{name}}! ${'Обратил внимание на вашу компанию. '.repeat(10)}`.trim();
    expect(tpl.length).toBeGreaterThan(300);
    expect(findAiOutputProblems(tpl, tpl, { maxChars: 300 })).toBeNull();
  });

  it('но ответ ДЛИННЕЕ такого шаблона — по-прежнему too_long', () => {
    const tpl = 'а'.repeat(320);
    const gen = 'а'.repeat(321);
    expect(findAiOutputProblems(tpl, gen, { maxChars: 300 })?.kind).toBe('too_long');
  });
});
