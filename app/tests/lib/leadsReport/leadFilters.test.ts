import { isExcludedLeadName } from '@/lib/leadsReport/leadFilters';

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
