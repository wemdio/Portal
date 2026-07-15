import {
  sanitizeClientHypothesesMarkdown,
  generateLeadSourceHypotheses,
} from '@/lib/projectBriefHypotheses/generateHypotheses';

// Мок fetchImpl без глобалов (jsdom не даёт fetch/Response): callOpenRouterChat
// читает только .ok/.status/.text(). Считаем вызовы, чтобы проверить число шагов.
function mockFetch(content: string) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

describe('generateLeadSourceHypotheses — двухшаговый разбор ЦА', () => {
  const HYP = '### Гипотеза 1: x\n- Источник: HH (HeadHunter)';
  it('internal делает 2 вызова (разбор ЦА + гипотезы), client — 1', async () => {
    const a = mockFetch(HYP);
    await generateLeadSourceHypotheses({
      apiKey: 'k', briefText: 'продаём CRM медицинским клиникам', audience: 'internal',
      fetchImpl: a.fn, maxRetries: 0,
    });
    expect(a.calls()).toBe(2);

    const b = mockFetch(HYP);
    await generateLeadSourceHypotheses({
      apiKey: 'k', briefText: 'продаём CRM медицинским клиникам', audience: 'client',
      fetchImpl: b.fn, maxRetries: 0,
    });
    expect(b.calls()).toBe(1);
  });
});

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
    expect(hhBlock).toContain('поиск по вакансиям не даёт все данные о компании');
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
