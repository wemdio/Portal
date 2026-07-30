import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import {
  getAllowedCompanyBaseIndustryCategories,
  postprocessCompanyBaseHypotheses,
  renderCompanyBaseFilterContract,
} from '@/lib/projectBriefHypotheses/ourBaseValidation';
import { parseHypotheses } from '@/lib/projectBriefHypotheses/parseHypotheses';

const SOURCE = 'Наша база компаний — отрасли / виды деятельности';

function ownBaseMarkdown(filtersJson: Record<string, unknown>, expected = '500–1000 компаний') {
  return `### Гипотеза 1: Животноводческие хозяйства 01.41
- Источник: ${SOURCE}
- Критерии сбора / как собрать базу: ОКВЭД 01.41; ЦФО; выручка от 10 млн ₽; ССЧ от 10
- Почему подходит брифу: это целевой сегмент 01.41
- Ожидаемый объём: ${expected}
- Риски/нюансы: точная привязка по ОКВЭД
<!-- PORTAL_COMPANY_FILTERS ${JSON.stringify({ sourceId: 'portal_companies', ...filtersJson })} -->`;
}

describe('ourBaseValidation — разрешённые категории', () => {
  it('разрешает только родительские XX и XX.X, но не детальные подкоды', () => {
    const categories = getAllowedCompanyBaseIndustryCategories();
    const codes = new Set(categories.map((item) => item.code));

    expect(codes.has('01')).toBe(true);
    expect(codes.has('01.4')).toBe(true);
    expect(codes.has('01.41')).toBe(false);
    expect(codes.has('01.41.1')).toBe(false);
    expect(categories.every((item) => /^\d{2}(?:\.\d)?$/.test(item.code))).toBe(true);
  });

  it.each([
    'лабораторные услуги для сельхозживотных',
    'ветеринарный сервис для ферм КРС',
  ])('включает 01.4 для исходного животноводческого брифа: %s', (brief) => {
    const contract = renderCompanyBaseFilterContract(brief);

    expect(contract).toContain('01.4 Животноводство');
    expect(contract.length).toBeLessThan(30_000);
  });

  it('ранжирует релевантную позднюю группу, а не обрезает её первыми совпадениями', () => {
    const contract = renderCompanyBaseFilterContract('складская логистика и хранение грузов');

    expect(contract).toMatch(/52\.1\s+.*склад/iu);
    expect(contract.length).toBeLessThan(30_000);
  });

  it('не считает слово «фермы» достаточным сигналом животноводства', () => {
    const contract = renderCompanyBaseFilterContract('серверные фермы для дата-центров');

    expect(contract).not.toContain('01.4 Животноводство');
  });

  it('поднимает явно указанный детальный код до XX.X и не даёт вытеснить его лимитом', () => {
    const allGroupNames = getAllowedCompanyBaseIndustryCategories()
      .filter(({ code }) => /^\d{2}\.\d$/.test(code))
      .map(({ name }) => name)
      .join(' ');
    const contract = renderCompanyBaseFilterContract(`${allGroupNames}\nОКВЭД 73.11`);

    expect(contract).toContain('73.1 Деятельность рекламная');
    expect(contract).not.toMatch(/(?:^|\s)73\.11(?=\s)/m);
  });

  it('детерминирован, ограничен 40 группами и остаётся компактным в худшем случае', () => {
    const worstBrief = getAllowedCompanyBaseIndustryCategories()
      .filter(({ code }) => /^\d{2}\.\d$/.test(code))
      .map(({ name }) => name)
      .join(' ');
    const first = renderCompanyBaseFilterContract(worstBrief);
    const second = renderCompanyBaseFilterContract(worstBrief);
    const selected = first.match(/(?:^|\s)(\d{2}\.\d)(?=\s)/gm)?.map((match) => match.trim()) ?? [];

    expect(first).toBe(second);
    expect(new Set(selected).size).toBe(40);
    expect(first.length).toBeLessThan(30_000);
  });

  it('не заполняет XX.X-группы по одним общим словам', () => {
    const contract = renderCompanyBaseFilterContract(
      'услуги и деятельность для компаний, производство и предоставление услуг',
    );
    const selected = contract.match(/(?:^|\s)(\d{2}\.\d)(?=\s)/gm) ?? [];

    expect(selected).toHaveLength(0);
  });
});

describe('postprocessCompanyBaseHypotheses', () => {
  it('поднимает детальный код до доступного родителя и заменяет AI-оценку live-count', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 1473 }));
    const markdown = ownBaseMarkdown({
      industryCodes: ['01.41'],
      federalDistricts: ['Центральный федеральный округ'],
      regionCodes: [],
      revenueFrom: 10_000_000,
      revenueTo: null,
      employeesFrom: 10,
      employeesTo: null,
      legalForms: ['ООО'],
      includeIp: false,
    });

    const result = await postprocessCompanyBaseHypotheses(markdown, {
      countCompanies,
      countScope: 'availableForExport',
    });

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(countCompanies).toHaveBeenCalledWith(expect.objectContaining({
      okvedCodes: ['01.4'],
      revenueFrom: 10_000_000,
      employeesFrom: 10,
      legalForms: ['ООО'],
      includeIp: false,
    }));
    const filters = countCompanies.mock.calls[0][0];
    expect(filters.regionCodes).toHaveLength(18);
    expect(result).toContain(`Источник: ${SOURCE}`);
    expect(result).toContain('01.4');
    expect(result).not.toContain('01.41');
    expect(result).not.toContain('ОКВЭД');
    expect(result).not.toContain('500–1000');
    expect(result).toContain('1 473 компании');
    expect(result).toContain('Доступно к новой выгрузке');
    expect(result).not.toContain('PORTAL_COMPANY_FILTERS');
  });

  it('при нуле расширяет только отрасль до класса, сохраняя остальные критерии', async () => {
    const countCompanies = jest
      .fn<Promise<{ count: number }>, [CompaniesSearchFilters]>()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 326 });
    const markdown = ownBaseMarkdown({
      industryCodes: ['01.4'],
      regionCodes: ['31'],
      revenueFrom: 10_000_000,
      employeesFrom: 10,
      hasPhone: true,
      includeIp: false,
    });

    const result = await postprocessCompanyBaseHypotheses(markdown, {
      countCompanies,
      countScope: 'availableForExport',
    });

    expect(countCompanies).toHaveBeenCalledTimes(2);
    expect(countCompanies.mock.calls[1][0]).toEqual(expect.objectContaining({
      okvedCodes: ['01'],
      regionCodes: ['31'],
      includeIp: false,
      hasPhone: true,
      revenueFrom: 10_000_000,
      employeesFrom: 10,
    }));
    expect(result).toContain('326 компаний');
    expect(result).toContain('исходное сочетание критериев дало 0');
    expect(result).toContain('отраслевая группа расширена до родительского класса');
  });

  it('при полном нуле не сохраняет выдуманный диапазон и предупреждает', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 0 }));
    const markdown = ownBaseMarkdown({
      industryCodes: ['01.4'],
      regionCodes: ['31'],
      includeIp: false,
    });

    const result = await postprocessCompanyBaseHypotheses(markdown, {
      countCompanies,
      countScope: 'availableForExport',
    });

    expect(result).not.toContain('500–1000');
    expect(result).toContain('0 компаний по текущим критериям');
    expect(result).toContain('наша база сейчас не подходит');
    expect(result).toContain('уже выгружены ранее');
  });

  it('ошибка счётчика не превращается в честный ноль и не оставляет AI-оценку', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({
      count: 0,
      error: 'timeout',
    }));
    const markdown = ownBaseMarkdown({
      industryCodes: ['01.4'],
      regionCodes: ['31'],
      includeIp: false,
    });

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(result).not.toContain('500–1000');
    expect(result).not.toContain('0 компаний по текущим критериям');
    expect(result).toContain('объём не удалось проверить');
  });

  it('невалидная категория закрывается без вызова счётчика', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 999 }));
    const markdown = ownBaseMarkdown({
      industryCodes: ['99.9'],
      regionCodes: ['31'],
      includeIp: false,
    });

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).not.toContain('500–1000');
    expect(result).toContain('не прошли проверку по доступному каталогу');
  });

  it('marker-less алиас B2B-поиска не пропускает выдуманный объём', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 999 }));
    const markdown = `### Гипотеза 1: Отраслевой сегмент 01.41
- Источник: B2B-поиск компаний
- Критерии сбора / как собрать базу: ОКВЭД 01.41; Москва
- Почему подходит брифу: целевой сегмент
- Ожидаемый объём: 500–1000 компаний
- Риски/нюансы: нет`;

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).toContain(`Источник: ${SOURCE}`);
    expect(result).not.toContain('500–1000');
    expect(result).not.toContain('01.41');
    expect(result).toContain('объём не проверен');
  });

  it('распознаёт короткое продуктовое название «B2B-поиск»', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 999 }));
    const markdown = `### Гипотеза 1: Отраслевой сегмент 01.41
- Источник: B2B-поиск
- Критерии сбора / как собрать базу: ОКВЭД 01.41; Москва
- Почему подходит брифу: целевой сегмент
- Ожидаемый объём: 500–1000 компаний
- Риски/нюансы: нет`;

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).toContain(`Источник: ${SOURCE}`);
    expect(result).not.toContain('500–1000');
    expect(result).not.toContain('01.41');
  });

  it('не перехватывает отдельный инструмент «Конструктор баз»', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 999 }));
    const markdown = `### Гипотеза 1: Очистить файл клиента
- Источник: Конструктор баз
- Критерии сбора / как собрать базу: загрузить клиентский XLSX, очистить и обогатить строки
- Почему подходит брифу: у клиента уже есть собственный список компаний
- Ожидаемый объём: зависит от числа строк в файле
- Риски/нюансы: исходный файл может содержать дубли`;

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).toBe(markdown);
  });

  it('не меняет внешние источники и валидирует не более одной гипотезы нашей базы', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 25 }));
    const filters = { industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false };
    const external = `### Гипотеза 1: Готовая база
- Источник: export-base.ru
- Ожидаемый объём: 700 компаний
- Риски/нюансы: затем можно проверить отдельные строки через нашу базу компаний`;
    const first = ownBaseMarkdown(filters).replace('Гипотеза 1', 'Гипотеза 2');
    const second = ownBaseMarkdown(filters).replace('Гипотеза 1', 'Гипотеза 3');

    const result = await postprocessCompanyBaseHypotheses(`${external}\n\n${first}\n\n${second}`, { countCompanies });

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(result).toContain('export-base.ru');
    expect(result).toContain('700 компаний');
    expect(result).toContain('затем можно проверить отдельные строки через нашу базу компаний');
    expect(result.match(/25 компаний/g)).toHaveLength(1);
    expect(result).toContain('повторная гипотеза нашей базы не проверялась');
  });

  it('раздельно обрабатывает bold-заголовки и не перехватывает соседний внешний источник', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 25 }));
    const external = `**Гипотеза 1: Клиентский файл**
- Источник: Конструктор баз
- Ожидаемый объём: зависит от файла`;
    const ownBase = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace('### Гипотеза 1: Животноводческие хозяйства 01.41', '**Гипотеза 2: Животноводческие хозяйства 01.41**');

    const result = await postprocessCompanyBaseHypotheses(`${external}\n\n${ownBase}`, { countCompanies });
    const parsed = parseHypotheses(result);

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].fields).toContainEqual({ label: 'Источник', value: 'Конструктор баз' });
    expect(parsed[1].fields).toContainEqual({ label: 'Ожидаемый объём', value: expect.stringContaining('25 компаний') });
  });

  it('удаляет многострочный технический JSON и не показывает его клиенту', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const multiline = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(
        /<!-- PORTAL_COMPANY_FILTERS (\{.*\}) -->/,
        (_match, json: string) => `<!-- PORTAL_COMPANY_FILTERS\n${JSON.stringify(JSON.parse(json), null, 2)}\n-->`,
      );

    const result = await postprocessCompanyBaseHypotheses(multiline, { countCompanies });

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(result).toContain('42 компании');
    expect(result).not.toContain('PORTAL_COMPANY_FILTERS');
    expect(result).not.toContain('sourceId');
  });

  it('удаляет незакрытый технический маркер до конца блока', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const malformed = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(/<!-- PORTAL_COMPANY_FILTERS[\s\S]*$/, '<!-- PORTAL_COMPANY_FILTERS {"sourceId":"portal_companies"');

    const result = await postprocessCompanyBaseHypotheses(malformed, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).not.toContain('PORTAL_COMPANY_FILTERS');
    expect(result).not.toContain('sourceId');
    expect(result).toContain('объём не проверен');
  });

  it.each([
    ['plain', 'PORTAL_COMPANY_FILTERS {"sourceId":"portal_companies"'],
    ['unclosed fence', '```json\nPORTAL_COMPANY_FILTERS {"sourceId":"portal_companies"'],
  ])('не показывает malformed %s marker', async (_label, malformedMarker) => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const malformed = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(/<!-- PORTAL_COMPANY_FILTERS[\s\S]*$/, malformedMarker);

    const result = await postprocessCompanyBaseHypotheses(malformed, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).not.toContain('PORTAL_COMPANY_FILTERS');
    expect(result).not.toContain('sourceId');
  });

  it('отклоняет дробную численность сотрудников до вызова счётчика', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({
      industryCodes: ['01.4'],
      regionCodes: ['31'],
      employeesFrom: 10.5,
      includeIp: false,
    });

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).toContain('employeesFrom должен быть целым числом');
  });

  it('не оставляет неизвестный детальный код в видимом тексте', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({
      industryCodes: ['99.99'],
      regionCodes: ['31'],
      includeIp: false,
    }).replaceAll('01.41', '99.99');

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).not.toHaveBeenCalled();
    expect(result).not.toContain('99.99');
    expect(result).not.toMatch(/(?:^|\s)\d{2}\.\d{2}(?=\s|[;,.])/m);
  });

  it.each([1, 21, 101])('грамотно показывает %i компанию в клиентском count', async (count) => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false });

    const result = await postprocessCompanyBaseHypotheses(markdown, {
      countCompanies,
      countScope: 'availableForExport',
    });

    expect(result).toContain(`Доступно к новой выгрузке на момент генерации: ${count} компания`);
    expect(result).not.toContain('компания доступны');
  });

  it('для внутреннего общего count не ссылается на клиентский seen-журнал', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 0 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false });

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(result).not.toContain('уже выгружены ранее');
    expect(result).toContain('0 компаний по текущим критериям');
  });

  it('при нуле без отраслевого фильтра не утверждает, что проверялись родительские категории', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 0 }));
    const markdown = ownBaseMarkdown({ industryCodes: [], regionCodes: ['31'], includeIp: false });

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(result).not.toContain('родительским отраслевым категориям');
    expect(result).toContain('По текущим критериям в нашей базе сейчас нет компаний');
  });

  it('возвращается по общему deadline, даже если счётчик завис', async () => {
    jest.useFakeTimers();
    try {
      const countCompanies = jest.fn(() => new Promise<{ count: number }>(() => undefined));
      const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false });
      const pending = postprocessCompanyBaseHypotheses(markdown, { countCompanies, timeoutMs: 100 });

      await jest.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(countCompanies).toHaveBeenCalledTimes(1);
      expect(result).toContain('объём не удалось проверить');
      expect(result).not.toContain('0 компаний по текущим критериям');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['обычная строка', (json: string) => `PORTAL_COMPANY_FILTERS ${json}`],
    ['code fence', (json: string) => `\`\`\`json\nPORTAL_COMPANY_FILTERS ${json}\n\`\`\``],
  ])('удаляет технический JSON без HTML-комментария: %s', async (_label, renderMarker) => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(
        /<!-- PORTAL_COMPANY_FILTERS (\{.*\}) -->/,
        (_match, json: string) => renderMarker(json),
      );

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(result).toContain('42 компании');
    expect(result).not.toContain('PORTAL_COMPANY_FILTERS');
    expect(result).not.toContain('sourceId');
  });

  it('удаляет отдельную строку закрытия после plain marker', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(/<!-- (PORTAL_COMPANY_FILTERS \{.*\}) -->/, '$1\n-->');

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(countCompanies).toHaveBeenCalledTimes(1);
    expect(result).not.toContain('-->');
    expect(result).not.toContain('PORTAL_COMPANY_FILTERS');
  });

  it('убирает альтернативное обещание точного официального вида деятельности', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(
        'Животноводческие хозяйства 01.41',
        'Точный официальный основной вид деятельности каждой компании',
      )
      .replace(
        'это целевой сегмент 01.41',
        'гарантирован точный официальный основной вид деятельности каждой компании',
      );

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });

    expect(result).not.toMatch(/точн[а-яё]*\s+официальн[а-яё]*\s+основн[а-яё]*\s+вид[а-яё]*\s+деятельност/iu);
    expect(result).not.toMatch(/официальн[а-яё]*\s+основн[а-яё]*\s+вид[а-яё]*\s+деятельност/iu);
    expect(result).toContain('Отраслевой сегмент по категориям базы');
    expect(result).toContain('приблизительным отраслевым категориям');
    expect(parseHypotheses(result)).toHaveLength(1);
    expect(parseHypotheses(result)[0].fields).toHaveLength(5);
  });

  it.each([
    'точное соответствие официальному ОКВЭД',
    'точно определяет основной вид деятельности',
    'вид деятельности точно совпадает с официальным',
    'гарантированно соответствует основному зарегистрированному ОКВЭД',
    'подтверждено по ЕГРЮЛ и полностью совпадает с официальной классификацией',
  ])('fail-safe заменяет обещание точности в другом порядке слов: %s', async (claim) => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace('Животноводческие хозяйства 01.41', claim)
      .replace('это целевой сегмент 01.41', claim);

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });
    const parsed = parseHypotheses(result)[0];

    expect(parsed.title).toBe('Отраслевой сегмент по категориям базы');
    expect(parsed.fields).toContainEqual({
      label: 'Почему подходит брифу',
      value: 'Сегмент соответствует выбранным приблизительным отраслевым категориям и другим фильтрам из брифа.',
    });
    expect(result).not.toContain(claim);
    expect(result).toContain('являются приблизительными и не подтверждают');
  });

  it('удаляет обещание точности из лишнего bullet и строки-продолжения', async () => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(
        '- Ожидаемый объём:',
        '- Гарантия точности: данные полностью совпадают с ЕГРЮЛ\nОфициальный вид деятельности точно подтверждён реестром\n- Ожидаемый объём:',
      );

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });
    const parsed = parseHypotheses(result)[0];

    expect(result).not.toContain('Гарантия точности');
    expect(result).not.toContain('полностью совпадают с ЕГРЮЛ');
    expect(result).not.toContain('точно подтверждён реестром');
    expect(parsed.fields).toHaveLength(5);
  });

  it.each([
    'Источник',
    'Критерии сбора / как собрать базу',
    'Почему подходит брифу',
    'Ожидаемый объём',
    'Риски/нюансы',
  ])('удаляет дублированное каноническое поле «%s» с обещанием точности', async (label) => {
    const countCompanies = jest.fn(async (_filters: CompaniesSearchFilters) => ({ count: 42 }));
    const markdown = ownBaseMarkdown({ industryCodes: ['01.4'], regionCodes: ['31'], includeIp: false })
      .replace(
        '- Ожидаемый объём:',
        `- ${label}: официальный ОКВЭД полностью подтверждён ЕГРЮЛ\n- Ожидаемый объём:`,
      );

    const result = await postprocessCompanyBaseHypotheses(markdown, { countCompanies });
    const parsed = parseHypotheses(result)[0];

    expect(result).not.toContain('полностью подтверждён ЕГРЮЛ');
    expect(parsed.fields).toHaveLength(5);
    expect(parsed.fields.filter((field) => field.label === label)).toHaveLength(1);
  });
});
