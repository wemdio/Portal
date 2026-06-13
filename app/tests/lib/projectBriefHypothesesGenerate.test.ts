import { sanitizeClientHypothesesMarkdown } from '@/lib/projectBriefHypotheses/generateHypotheses';

describe('sanitizeClientHypothesesMarkdown', () => {
  it('removes company-size metrics from client HH hypotheses only', () => {
    const raw = `### Гипотеза 1: HH hiring signal
- Источник: HH (hh.ru, поиск вакансий)
- Критерии сбора / как собрать базу: поиск вакансий «sales manager»; регионы Москва и СПб; затем отфильтровать ССЧ 30–300 через реестры
- Почему подходит брифу: компании активно нанимают sales-команду
- Ожидаемый объём: 300–800 компаний
- Риски/нюансы: без фильтрации по размеру компании в HH могут попасть микро- и крупный бизнес; после сбора рекомендуется верифицировать ССЧ через реестр

### Гипотеза 2: Registry ICP
- Источник: Реестровые базы (Руспрофайл / Селеком / Сбис)
- Критерии сбора / как собрать базу: ОКВЭД 62; ССЧ 30–300; выручка 50–500 млн ₽
- Почему подходит брифу: размер и выручка помогают выделить нужный ICP
- Ожидаемый объём: 500–1500 компаний
- Риски/нюансы: данные нужно обновлять`;

    const sanitized = sanitizeClientHypothesesMarkdown(raw);
    const [hhBlock, registryBlock] = sanitized.split('\n\n### Гипотеза 2:');

    expect(hhBlock).not.toMatch(/ССЧ|выручк|оборот|размер компании|микро/i);
    expect(hhBlock).toContain('HH не даёт все данные о компании');
    expect(registryBlock).toContain('ССЧ 30–300');
    expect(registryBlock).toContain('выручка 50–500 млн ₽');
  });

  it('does not change non-HH blocks', () => {
    const raw = `### Гипотеза 1: Registry ICP
- Источник: Реестровые базы
- Критерии сбора / как собрать базу: ССЧ 30–300; выручка 50–500 млн ₽`;

    expect(sanitizeClientHypothesesMarkdown(raw)).toBe(raw);
  });
});
