import {
  dedupeLeadMagnets,
  isExcludedLeadName,
  isLeadMagnet,
} from '@/lib/leadsReport/leadFilters';

describe('isExcludedLeadName', () => {
  it('ловит сотрудников, тестирующих бота, в любом написании', () => {
    expect(isExcludedLeadName('Бот: Юлия Миронова')).toBe(true);
    expect(isExcludedLeadName('бот: юлия миронова')).toBe(true);
    expect(isExcludedLeadName('Егор Каныгин')).toBe(true);
    expect(isExcludedLeadName('Бот: Саша')).toBe(true);
  });

  it('ловит тестовые заявки', () => {
    expect(isExcludedLeadName('Бот: ТЕСТ атрибуции 2026-07-23')).toBe(true);
    expect(isExcludedLeadName('Заявка: test-direct-site.polzaagency.ru')).toBe(true);
    expect(isExcludedLeadName('Заявка: test.ru')).toBe(true);
  });

  it('не ловит живых людей и компании по подстроке', () => {
    // «Саша» не должна поймать фамилию, «тест» — причастие.
    expect(isExcludedLeadName('Бот: Сашанина Ольга')).toBe(false);
    expect(isExcludedLeadName('Заявка: протестирован.рф')).toBe(false);
    expect(isExcludedLeadName('Бот: Александр')).toBe(false);
    expect(isExcludedLeadName('Дмитрий')).toBe(false);
    expect(isExcludedLeadName(null)).toBe(false);
    // «тесть» — это не «тест»: реальная сделка с таким именем в базе есть.
    expect(isExcludedLeadName('Бот: тесть')).toBe(false);
    expect(isExcludedLeadName('')).toBe(false);
  });

  it('ловит имя, склеенное с цифрами', () => {
    expect(isExcludedLeadName('Бот: ТЕСТ2026')).toBe(true);
    expect(isExcludedLeadName('Заявка: test123.ru')).toBe(true);
  });

  it('ловит составное имя при неровных пробелах', () => {
    expect(isExcludedLeadName('Бот: Юлия  Миронова')).toBe(true);
    expect(isExcludedLeadName('Бот: Юлия\tМиронова')).toBe(true);
  });
});

describe('isLeadMagnet', () => {
  it('лид-магнит — это заявка бота по префиксу имени', () => {
    expect(isLeadMagnet('Бот: Third Child')).toBe(true);
    expect(isLeadMagnet('  Бот: Third Child')).toBe(true);
    expect(isLeadMagnet('Заявка: onelabgames.ru')).toBe(false);
    expect(isLeadMagnet(null)).toBe(false);
  });
});

describe('dedupeLeadMagnets', () => {
  const candidate = (
    amoId: number,
    name: string,
    peak: number,
    channel = 'smm',
    createdAt = '2026-08-03T10:00:00.000Z',
    identity: string | null = null,
  ) => ({ amoId, name, peak, channel, createdAt, identity });

  it('из двух заявок бота с одним именем оставляет дошедшую дальше', () => {
    const result = dedupeLeadMagnets([
      candidate(34518579, 'Бот: Aleksei Brazhnikov', 30),
      candidate(34518593, 'Бот: Aleksei Brazhnikov', 70),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([34518593]);
  });

  it('при равном этапе оставляет самую раннюю заявку', () => {
    const result = dedupeLeadMagnets([
      candidate(34550051, 'Бот: Михаил Маркетолог', 20, 'marketing', '2026-08-05T08:38:39.000Z'),
      candidate(34549993, 'Бот: Михаил Маркетолог', 20, 'marketing', '2026-08-05T08:35:06.000Z'),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([34549993]);
  });

  it('не трогает не-лид-магниты: два разных «Дмитрия» остаются двумя', () => {
    const result = dedupeLeadMagnets([
      candidate(34510495, 'Дмитрий', 30, 'outreach'),
      candidate(34512057, 'Дмитрий', 80, 'outreach'),
    ]);

    expect(result).toHaveLength(2);
  });

  it('дедуп идёт внутри канала: одно имя в разных каналах — разные заявки', () => {
    const result = dedupeLeadMagnets([
      candidate(1, 'Бот: Евгения', 30, 'marketing'),
      candidate(2, 'Бот: Евгения', 30, 'smm'),
    ]);

    expect(result).toHaveLength(2);
  });

  it('сохраняет исходный порядок оставшихся заявок', () => {
    const result = dedupeLeadMagnets([
      candidate(10, 'Бот: Первый', 30),
      candidate(20, 'Бот: Дубль', 30),
      candidate(30, 'Бот: Дубль', 30),
      candidate(40, 'Бот: Третий', 30),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([10, 20, 40]);
  });

  it('разные телеграм-аккаунты под одним именем — разные люди', () => {
    const result = dedupeLeadMagnets([
      candidate(34334595, 'Бот: Георгий', 30, 'marketing', '2026-07-23T11:50:28.000Z', '623731424'),
      candidate(34345909, 'Бот: Георгий', 30, 'marketing', '2026-07-24T06:25:30.000Z', '182456774'),
    ]);

    expect(result).toHaveLength(2);
  });

  it('один телеграм-аккаунт — одна заявка, даже если имена написаны по-разному', () => {
    const result = dedupeLeadMagnets([
      candidate(1, 'Бот: Евгения', 30, 'marketing', '2026-08-04T18:10:46.000Z', '5091587914'),
      candidate(2, 'Бот: Евгения ', 70, 'marketing', '2026-08-04T18:18:38.000Z', '5091587914'),
    ]);

    expect(result.map((item) => item.amoId)).toEqual([2]);
  });

  it('при равном этапе и времени порядок строк из БД ничего не решает', () => {
    const rows = [candidate(99, 'Бот: X', 30), candidate(11, 'Бот: X', 30)];
    expect(dedupeLeadMagnets(rows).map((i) => i.amoId)).toEqual([11]);
    expect(dedupeLeadMagnets([...rows].reverse()).map((i) => i.amoId)).toEqual([11]);
  });
});
