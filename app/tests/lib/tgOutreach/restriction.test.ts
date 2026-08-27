/** @jest-environment node */

/**
 * Разбор ограничений Telegram на «временно» и «навсегда».
 *
 * Цена ошибки несимметрична и велика в обе стороны: назвать спам-блок баном —
 * значит выбросить живой номер, за который заплачено; назвать бан временным —
 * значит месяц ждать, пока «пройдёт само», и держать в пуле мёртвую строку.
 * Поэтому проверяем не «функция что-то вернула», а именно границы между
 * случаями и порядок, в котором они перекрывают друг друга.
 */

import {
  classifyRestriction,
  restrictionFromProfile,
  describeRestriction,
  humanDuration,
} from '@/lib/tgOutreach/restriction';
import {
  parseSpamBotReply,
  parseSpamBotDate,
  describeSpamBotVerdict,
} from '@/lib/tgOutreach/accountCheck';

const NOW = new Date('2026-08-27T12:00:00.000Z').getTime();

describe('classifyRestriction — навсегда', () => {
  it('бан номера за спам', () => {
    const r = classifyRestriction('RPCError 401: USER_DEACTIVATED_BAN (caused by GetDialogs)', NOW)!;
    expect(r.kind).toBe('permanent');
    expect(r.label).toBe('бан навсегда');
    expect(r.detail).toContain('новый номер');
  });

  it('бан при входе по номеру', () => {
    expect(classifyRestriction('PHONE_NUMBER_BANNED', NOW)!.kind).toBe('permanent');
  });

  it('удалённый аккаунт', () => {
    const r = classifyRestriction('USER_DEACTIVATED', NOW)!;
    expect(r.kind).toBe('permanent');
    expect(r.label).toBe('аккаунт удалён');
  });

  it('USER_DEACTIVATED_BAN важнее общего USER_DEACTIVATED', () => {
    // Обе строки содержат USER_DEACTIVATED; порядок веток решает, какую причину
    // прочитает оператор.
    expect(classifyRestriction('USER_DEACTIVATED_BAN', NOW)!.code).toBe('USER_DEACTIVATED_BAN');
  });
});

describe('classifyRestriction — временно', () => {
  it('FLOOD_WAIT с точным сроком превращается в дату снятия', () => {
    const r = classifyRestriction('FLOOD_WAIT_120', NOW)!;
    expect(r.kind).toBe('temporary');
    expect(r.label).toBe('пауза 2 минуты');
    expect(r.until).toBe(new Date(NOW + 120_000).toISOString());
  });

  it('человеческий текст gramJS без кода тоже распознаётся', () => {
    // gramJS переписывает message типизированных ошибок, и самого кода
    // FLOOD_WAIT в строке нет. Матч только по коду пропускал бы половину.
    const r = classifyRestriction('A wait of 3600 seconds is required (caused by SendMessage)', NOW)!;
    expect(r.kind).toBe('temporary');
    expect(r.label).toBe('пауза 1 час');
    expect(r.until).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  it('спам-блок — временный, но без срока, и срок не выдумывается', () => {
    const r = classifyRestriction('RPCError 420: PEER_FLOOD', NOW)!;
    expect(r.kind).toBe('temporary');
    expect(r.label).toBe('спам-блок');
    expect(r.until).toBeNull();
    expect(r.detail).toContain('@SpamBot');
  });

  it('заморозка — не бан и не проходит сама', () => {
    const r = classifyRestriction('FROZEN_METHOD_INVALID', NOW)!;
    expect(r.kind).toBe('frozen');
    expect(r.detail).toContain('поддержку');
  });
});

describe('classifyRestriction — не ограничение', () => {
  it('отозванная сессия баном не является', () => {
    // Аккаунт цел и чинится перезаливкой. Назвать это баном — отправить
    // рабочий номер в мусор.
    expect(classifyRestriction('SESSION_REVOKED', NOW)).toBeNull();
    expect(classifyRestriction('AUTH_KEY_UNREGISTERED', NOW)).toBeNull();
    expect(classifyRestriction('AUTH_KEY_DUPLICATED', NOW)).toBeNull();
  });

  it('собеседник удалил аккаунт — это про него, а не про нас', () => {
    // INPUT_USER_DEACTIVATED содержит в себе USER_DEACTIVATED: без отдельной
    // проверки каждый удалённый контакт читался бы как бан нашего аккаунта.
    expect(classifyRestriction('INPUT_USER_DEACTIVATED', NOW)).toBeNull();
  });

  it('сетевая ошибка ограничением не считается', () => {
    expect(classifyRestriction('connect timeout (30s)', NOW)).toBeNull();
  });
});

describe('restrictionFromProfile', () => {
  it('текст со словом ban читается как окончательный', () => {
    const r = restrictionFromProfile(['account was banned for spam']);
    expect(r.kind).toBe('permanent');
  });

  it('прочие ограничения профиля — временные', () => {
    const r = restrictionFromProfile(['limited for sending messages to strangers']);
    expect(r.kind).toBe('temporary');
    expect(r.detail).toContain('@SpamBot');
  });

  it('пустая причина не ломает формулировку', () => {
    expect(restrictionFromProfile([]).detail).toContain('Telegram ограничил аккаунт');
  });
});

describe('describeRestriction', () => {
  it('начинается со слова, ради которого строку и читают', () => {
    const perm = describeRestriction(classifyRestriction('USER_DEACTIVATED_BAN', NOW)!);
    expect(perm.startsWith('ПОСТОЯННЫЙ бан')).toBe(true);

    const temp = describeRestriction(classifyRestriction('PEER_FLOOD', NOW)!);
    expect(temp.startsWith('ВРЕМЕННОЕ ограничение')).toBe(true);
  });

  it('точный срок показывает временем по Москве', () => {
    const line = describeRestriction(classifyRestriction('FLOOD_WAIT_3600', NOW)!, 3);
    expect(line).toContain('16:00');
  });
});

describe('humanDuration', () => {
  it('склоняет и укрупняет единицы', () => {
    expect(humanDuration(45)).toBe('45 секунд');
    expect(humanDuration(60)).toBe('1 минуту');
    expect(humanDuration(120)).toBe('2 минуты');
    expect(humanDuration(3600)).toBe('1 час');
    expect(humanDuration(7200)).toBe('2 часа');
    expect(humanDuration(259_200)).toBe('3 дня');
  });
});


describe('parseSpamBotReply', () => {
  it('«свободен» не читается как ограничение, хотя содержит слово limits', () => {
    // Порядок проверок: фраза про отсутствие ограничений содержит то же слово,
    // что и сам запрет. Обратный порядок пометил бы здоровый аккаунт битым.
    const v = parseSpamBotReply(
      "Good news, no limits are currently applied to your account. You're free as a bird!",
    );
    expect(v.kind).toBe('free');
    expect(v.until).toBeNull();
  });

  it('русский ответ без ограничений', () => {
    expect(parseSpamBotReply('Хорошие новости, никаких ограничений на ваш аккаунт не наложено.').kind)
      .toBe('free');
  });

  it('ограничение со сроком отдаёт дату снятия', () => {
    const v = parseSpamBotReply('Your account is limited until 27 September 2026, 12:30 UTC.');
    expect(v.kind).toBe('limited');
    expect(v.until).toBe('2026-09-27T12:30:00.000Z');
  });

  it('ограничение без срока — дату не выдумываем', () => {
    // Бессрочное ограничение бот проговаривает без даты. Подставить сюда
    // «через неделю» значило бы дать обещание за Telegram.
    const v = parseSpamBotReply('Unfortunately, your account will remain limited.');
    expect(v.kind).toBe('limited');
    expect(v.until).toBeNull();
  });

  it('пустой ответ — «непонятно», а не «свободен»', () => {
    expect(parseSpamBotReply('').kind).toBe('unknown');
  });
});

describe('parseSpamBotDate', () => {
  it('понимает написания, которые бот реально использует', () => {
    expect(parseSpamBotDate('until 27.09.2026, 12:30 UTC')).toBe('2026-09-27T12:30:00.000Z');
    expect(parseSpamBotDate('until 27 Sep 2026')).toBe('2026-09-27T00:00:00.000Z');
    expect(parseSpamBotDate('until September 27, 2026 at 09:05 UTC')).toBe('2026-09-27T09:05:00.000Z');
    expect(parseSpamBotDate('до 27 сентября 2026')).toBe('2026-09-27T00:00:00.000Z');
  });

  it('нет даты — null, а не «сегодня»', () => {
    expect(parseSpamBotDate('your account will remain limited')).toBeNull();
  });
});

describe('describeSpamBotVerdict', () => {
  it('срок показывает по Москве', () => {
    const line = describeSpamBotVerdict(
      { text: 'x', kind: 'limited', until: '2026-09-27T12:30:00.000Z' },
      3,
    );
    expect(line).toContain('27.09.2026');
    expect(line).toContain('15:30');
  });

  it('без срока честно говорит, что срока нет', () => {
    const line = describeSpamBotVerdict({ text: 'remains limited', kind: 'limited', until: null }, 3);
    expect(line).toContain('срок не назван');
  });
});
