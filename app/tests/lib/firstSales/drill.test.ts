import { matchesDrill, parseDrillSlice } from '@/lib/firstSales/drill';
import { NO_MANAGER } from '@/lib/firstSales/metrics';
import { NO_SOURCE_KEY } from '@/lib/firstSales/sources';

/** Сделка в том виде, в каком её отдаёт fetchFirstSalesLeads: источник живёт
 *  в `raw` (снимок карточки AMO), ответственный — отдельным полем. */
function lead(responsible: string | null, sourceEnumId: number | null) {
  return {
    responsible_name: responsible,
    raw: {
      custom_fields_values: sourceEnumId === null
        ? []
        : [{ field_name: 'Источник', values: [{ value: 'Аутрич', enum_id: sourceEnumId }] }],
    },
  };
}

const url = (qs: string) => new URL(`https://portal.local/api?${qs}`);

describe('parseDrillSlice', () => {
  it('без параметров — ошибка вызова, а не пустой список', () => {
    expect(parseDrillSlice(url('from=2026-08-01&to=2026-08-30')).error).toBeTruthy();
  });

  it('один source без manager — это срез по источнику', () => {
    expect(parseDrillSlice(url('source=none')).value).toEqual({ source: 'none' });
  });

  it('несколько source без manager — непонятно, какой из них срез', () => {
    expect(parseDrillSlice(url('source=1&source=2')).error).toBeTruthy();
  });

  it('manager рядом с source — срез по менеджеру, source остаётся фильтром', () => {
    // Раньше такой запрос был невозможен: проверка «ровно один параметр»
    // отвергала его, и фильтр источников до drill-down не доезжал вовсе.
    expect(parseDrillSlice(url('manager=Егор&source=none')).value).toEqual({ manager: 'Егор' });
  });

  it('пустое имя менеджера — законное значение, а не отсутствие параметра', () => {
    expect(parseDrillSlice(url('manager=')).value).toEqual({ manager: '' });
  });
});

describe('matchesDrill — срез по источнику', () => {
  it('отбирает сделки этого источника', () => {
    const match = matchesDrill({ source: '42' }, null);
    expect(match(lead('Егор', 42))).toBe(true);
    expect(match(lead('Егор', 7))).toBe(false);
  });

  it('сделки без заполненного «Источник» ловятся ключом none', () => {
    const match = matchesDrill({ source: NO_SOURCE_KEY }, null);
    expect(match(lead('Егор', null))).toBe(true);
    expect(match(lead('Егор', 42))).toBe(false);
  });

  it('фильтр из шапки не сужает срез по источнику', () => {
    // Строка сама и есть источник — второй список поверх неё способен только
    // отнять сделки, которые сводка уже посчитала.
    const match = matchesDrill({ source: '42' }, ['none']);
    expect(match(lead('Егор', 42))).toBe(true);
  });
});

describe('matchesDrill — срез по менеджеру', () => {
  it('без фильтра берёт все сделки менеджера', () => {
    const match = matchesDrill({ manager: 'Егор' }, null);
    expect(match(lead('Егор', 42))).toBe(true);
    expect(match(lead('Егор', null))).toBe(true);
    expect(match(lead('Александр', 42))).toBe(false);
  });

  it('фильтр источников применяется — иначе цифра и список расходятся', () => {
    // Инцидент 30.08.2026: при фильтре «Без источника» у Егора в строке
    // стояло 2, а раскрытие показывало все его сделки за период.
    const match = matchesDrill({ manager: 'Егор' }, [NO_SOURCE_KEY]);
    expect(match(lead('Егор', null))).toBe(true);
    expect(match(lead('Егор', 42))).toBe(false);
  });

  it('фильтр из нескольких источников берёт любой из них', () => {
    const match = matchesDrill({ manager: 'Егор' }, ['42', '7']);
    expect(match(lead('Егор', 42))).toBe(true);
    expect(match(lead('Егор', 7))).toBe(true);
    expect(match(lead('Егор', 9))).toBe(false);
  });

  it('сделки без ответственного лежат под своим литералом', () => {
    const match = matchesDrill({ manager: NO_MANAGER }, null);
    expect(match(lead(null, 42))).toBe(true);
    expect(match(lead('Егор', 42))).toBe(false);
  });
});
