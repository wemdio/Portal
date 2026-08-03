/** @jest-environment node */

jest.mock('server-only', () => ({}));

import {
  detectOutreachSignals,
  SIGNAL_COLUMNS,
  type OutreachLlmVerdicts,
} from '@/lib/gisSignalOutreach/signals';

/**
 * Роутер страниц для инжектируемого fetchPage: ключ — URL, значение — HTML
 * (null = страница недоступна). Реальной сети в тестах нет.
 */
function makeFetchRouter(pages: Record<string, string | null>) {
  return jest.fn(async (url: string) => {
    const normalized = url.replace(/[#?].*$/, '').replace(/\/+$/, '');
    for (const [key, html] of Object.entries(pages)) {
      if (key.replace(/\/+$/, '') === normalized) {
        return html ? { html, finalUrl: url } : null;
      }
    }
    return null;
  });
}

const makeLlm = (verdicts: OutreachLlmVerdicts | null = null) =>
  jest.fn().mockResolvedValue(verdicts);

// ─── Фикстуры ────────────────────────────────────────────────────────────────

// S1+S2: номер 8-800 в шапке + кнопка обратного звонка.
const HTML_S1_S2 = `
<html><body>
  <header>
    <a href="tel:88005550665">8 800 555-06-65</a>
    <span>звонок бесплатный</span>
    <button class="callback-btn">Заказать звонок</button>
  </header>
  <main><h1>Школа английского языка</h1><p>Курсы для взрослых и детей.</p></main>
</body></html>`;

// S2 через чат-виджет (JivoSite), без формы и без текста CTA.
const HTML_CHAT_WIDGET = `
<html><body>
  <main><h1>Стоматология Улыбка</h1><p>Лечение и протезирование зубов.</p></main>
  <script src="//code.jivosite.com/widget/AbCdEf123" async></script>
</body></html>`;

// S3: упоминание отдела продаж; телефон городской — S1 срабатывать не должен.
const HTML_S3 = `
<html><body>
  <main>
    <h1>Автошкола Драйв</h1>
    <p>Отдел продаж ответит на все вопросы по телефону +7 (495) 123-45-67.</p>
  </main>
</body></html>`;

// S4: на главной ссылка «Вакансии», на /vacancies — целевые роли.
const HTML_HOME_CAREERS_LINK = `
<html><body>
  <main><h1>Федеральная сеть автошкол</h1><p>Обучение на категорию B.</p></main>
  <footer><a href="/vacancies">Вакансии</a></footer>
</body></html>`;

const HTML_VACANCIES_TARGET = `
<html><body>
  <main>
    <h1>Открытые вакансии</h1>
    <div class="vacancy-card"><h3>Менеджер по продажам</h3><p>от 60 000 ₽</p></div>
    <div class="vacancy-card"><h3>Оператор call-центра</h3><p>от 45 000 ₽</p></div>
  </main>
</body></html>`;

const HTML_VACANCIES_NON_TARGET = `
<html><body>
  <main>
    <h1>Открытые вакансии</h1>
    <div class="vacancy-card"><h3>Инженер-конструктор</h3><p>от 90 000 ₽</p></div>
  </main>
</body></html>`;

// S5: «более N студентов» + «24/7».
const HTML_S5 = `
<html><body>
  <main>
    <h1>Онлайн-школа Поток</h1>
    <p>Нас выбрали более 5000 студентов.</p>
    <p>Поддержка работает 24/7.</p>
  </main>
</body></html>`;

// S6: на главной ссылка «Контакты», на /contacts — «Адреса салонов» + 2 адреса.
const HTML_HOME_CONTACTS_LINK = `
<html><body>
  <main><h1>Салоны красоты Лакшми</h1><p>Маникюр и стрижки.</p></main>
  <footer><a href="/contacts">Контакты</a></footer>
</body></html>`;

const HTML_CONTACTS_TWO_ADDRESSES = `
<html><body>
  <main>
    <h1>Адреса салонов</h1>
    <p>г. Москва, ул. Тверская, д. 1</p>
    <p>г. Москва, ул. Арбат, д. 25</p>
  </main>
</body></html>`;

// Чистый лендинг без единого сигнала.
const HTML_CLEAN = `
<html><body>
  <main>
    <h1>Бюро архитектурных проектов</h1>
    <p>Индивидуальное проектирование частных домов под ключ.</p>
  </main>
</body></html>`;

// Все 6 сигналов на одной странице (LLM при этом вызываться не должна).
const HTML_ALL_SIGNALS = `
<html><body>
  <header>
    <a href="tel:88005550000">8 800 555-00-00</a>
    <button>Заказать звонок</button>
  </header>
  <main>
    <h1>Учебный центр Практика</h1>
    <p>Отдел продаж работает ежедневно с 9 до 21.</p>
    <p>Мы ищем менеджера по продажам в команду.</p>
    <p>Более 5000 студентов обучились у нас.</p>
    <p>Наши офисы: ул. Тверская, д. 1 и ул. Арбат, д. 25.</p>
  </main>
</body></html>`;

// Главная со ссылками на все виды подстраниц (проверка потолка ~5 страниц).
const HTML_MANY_LINKS = `
<html><body>
  <nav>
    <a href="/contacts">Контакты</a>
    <a href="/vacancies">Вакансии</a>
    <a href="/about">О нас</a>
    <a href="https://hh.ru/employer/12345">Мы на hh.ru</a>
  </nav>
  <main><h1>Компания</h1><p>Описание.</p></main>
</body></html>`;

const HTML_STUB = '<html><body><main><p>Страница</p></main></body></html>';

describe('detectOutreachSignals', () => {
  it('S1+S2: 8-800 в шапке + кнопка «Заказать звонок»', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://school.example',
      fetchPage: makeFetchRouter({ 'https://school.example/': HTML_S1_S2 }),
      llmExtract: makeLlm(),
    });

    expect(result.ok).toBe(true);
    expect(result.note).toBe('Homepage checked');
    expect(result.signals.generalPhone.hit).toBe(true);
    expect(result.signals.generalPhone.evidence).toContain('8 800');
    expect(result.signals.contactForm.hit).toBe(true);
    expect(result.signals.salesDept.hit).toBe(false);
    expect(result.signalsCount).toBe(2);
  });

  it('S2: чат-виджет JivoSite без формы', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://dental.example',
      fetchPage: makeFetchRouter({ 'https://dental.example/': HTML_CHAT_WIDGET }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.contactForm.hit).toBe(true);
    expect(result.signals.contactForm.evidence).toContain('JivoSite');
    expect(result.signalsCount).toBe(1);
  });

  it('S3: «отдел продаж» в тексте; городской телефон — не S1', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://drive.example',
      fetchPage: makeFetchRouter({ 'https://drive.example/': HTML_S3 }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.salesDept.hit).toBe(true);
    expect(result.signals.salesDept.evidence).toMatch(/отдел продаж/i);
    expect(result.signals.generalPhone.hit).toBe(false);
    expect(result.signalsCount).toBe(1);
  });

  it('S4: careers-страница с «Менеджер по продажам» и «Оператор call-центра»', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://auto.example',
      fetchPage: makeFetchRouter({
        'https://auto.example/': HTML_HOME_CAREERS_LINK,
        'https://auto.example/vacancies': HTML_VACANCIES_TARGET,
      }),
      llmExtract: makeLlm(),
    });

    expect(result.ok).toBe(true);
    expect(result.signals.targetVacancy.hit).toBe(true);
    expect(result.signals.targetVacancy.evidence).toMatch(/менеджер по продажам|оператор call-центра/i);
    // «Оператор call-центра» — это ещё и текстовое упоминание call-центра,
    // поэтому S3 здесь срабатывает вместе с S4 (спековое пересечение маркеров).
    expect(result.signals.salesDept.hit).toBe(true);
    expect(result.signalsCount).toBe(2);
  });

  it('S5: «более 5000 студентов» / «24/7»', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://potok.example',
      fetchPage: makeFetchRouter({ 'https://potok.example/': HTML_S5 }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.highVolume.hit).toBe(true);
    expect(result.signals.highVolume.evidence).toMatch(/5000 студентов|24\/7/);
    expect(result.signalsCount).toBe(1);
  });

  it('S6: «Адреса салонов» + 2 адреса на странице контактов', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://salon.example',
      fetchPage: makeFetchRouter({
        'https://salon.example/': HTML_HOME_CONTACTS_LINK,
        'https://salon.example/contacts': HTML_CONTACTS_TWO_ADDRESSES,
      }),
      llmExtract: makeLlm(),
    });

    expect(result.ok).toBe(true);
    expect(result.signals.multiOffice.hit).toBe(true);
    expect(result.signals.multiOffice.evidence).toMatch(/Тверская/);
    expect(result.signalsCount).toBe(1);
  });

  it('S6 по 2GIS: branchCount >= 2 без сайтовых доказательств', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://clean.example',
      twogisBranchCount: 7,
      fetchPage: makeFetchRouter({ 'https://clean.example/': HTML_CLEAN }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.multiOffice.hit).toBe(true);
    expect(result.signals.multiOffice.evidence).toContain('2GIS');
    expect(result.signalsCount).toBe(1);
  });

  it('S1 по 2GIS: номер 8-800 с карточки компании', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://clean.example',
      twogisPhone: '8 800 700-10-10',
      fetchPage: makeFetchRouter({ 'https://clean.example/': HTML_CLEAN }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.generalPhone.hit).toBe(true);
    expect(result.signals.generalPhone.evidence).toContain('2GIS');
    expect(result.signalsCount).toBe(1);
  });

  it('чистый лендинг: ни одного сигнала', async () => {
    const llm = makeLlm();
    const result = await detectOutreachSignals({
      siteUrl: 'https://buro.example',
      fetchPage: makeFetchRouter({ 'https://buro.example/': HTML_CLEAN }),
      llmExtract: llm,
    });

    expect(result.ok).toBe(true);
    expect(result.note).toBe('Homepage checked');
    expect(result.signalsCount).toBe(0);
    for (const verdict of Object.values(result.signals)) {
      expect(verdict.hit).toBe(false);
      expect(verdict.evidence).toBe('');
    }
    // Все 6 не закрыты эвристиками — LLM позвали ровно один раз.
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0].needed).toHaveLength(6);
  });

  it('сайт недоступен: ok=false, note "Site unreachable", все сигналы false', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://dead.example',
      fetchPage: jest.fn(async () => null),
      llmExtract: makeLlm(),
    });

    expect(result.ok).toBe(false);
    expect(result.note).toBe('Site unreachable');
    expect(result.signalsCount).toBe(0);
    for (const verdict of Object.values(result.signals)) {
      expect(verdict.hit).toBe(false);
      expect(verdict.evidence).toBe('');
    }
  });

  it('LLM-добор: закрывает сигналы, которые эвристики не нашли', async () => {
    const llm = makeLlm({
      salesDept: { hit: true, evidence: 'На сайте указан отдел продаж' },
      highVolume: { hit: false },
    });
    const result = await detectOutreachSignals({
      siteUrl: 'https://buro.example',
      fetchPage: makeFetchRouter({ 'https://buro.example/': HTML_CLEAN }),
      llmExtract: llm,
    });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.signals.salesDept.hit).toBe(true);
    expect(result.signals.salesDept.evidence).toBe('На сайте указан отдел продаж');
    expect(result.signals.highVolume.hit).toBe(false);
    expect(result.signalsCount).toBe(1);
  });

  it('LLM недоступна: fail-open, остаются эвристики + пометка в note', async () => {
    const llm = jest.fn().mockRejectedValue(new Error('router 502'));
    const result = await detectOutreachSignals({
      siteUrl: 'https://school.example',
      fetchPage: makeFetchRouter({ 'https://school.example/': HTML_S1_S2 }),
      llmExtract: llm,
    });

    expect(result.ok).toBe(true);
    expect(result.signalsCount).toBe(2);
    expect(result.signals.generalPhone.hit).toBe(true);
    expect(result.note).toContain('LLM fallback failed');
  });

  it('все 6 сигналов эвристиками: LLM не вызывается', async () => {
    const llm = makeLlm();
    const result = await detectOutreachSignals({
      siteUrl: 'https://praktika.example',
      fetchPage: makeFetchRouter({ 'https://praktika.example/': HTML_ALL_SIGNALS }),
      llmExtract: llm,
    });

    expect(result.ok).toBe(true);
    expect(result.signalsCount).toBe(6);
    expect(llm).not.toHaveBeenCalled();
  });

  it('потолок страниц: главная + максимум 4 подстраницы', async () => {
    const fetchPage = makeFetchRouter({
      'https://net.example/': HTML_MANY_LINKS,
      'https://net.example/contacts': HTML_STUB,
      'https://net.example/vacancies': HTML_STUB,
      'https://net.example/about': HTML_STUB,
      'https://hh.ru/employer/12345': HTML_STUB,
    });
    const result = await detectOutreachSignals({
      siteUrl: 'https://net.example',
      fetchPage,
      llmExtract: makeLlm(),
    });

    expect(result.ok).toBe(true);
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(5);
    expect(result.note).toBe('Homepage + 4 subpages checked');
  });

  it('evidence никогда не длиннее 200 символов', async () => {
    const long = 'Очень длинный маркетинговый текст про компанию. '.repeat(60);
    const html = `<html><body><main><p>${long} Отдел продаж. ${long}</p></main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://long.example',
      fetchPage: makeFetchRouter({ 'https://long.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.salesDept.hit).toBe(true);
    expect(result.signals.salesDept.evidence.length).toBeLessThanOrEqual(200);
    expect(result.signals.salesDept.evidence).toMatch(/отдел продаж/i);
  });

  it('негатив: обычная поисковая форма — не лид-форма (S2)', async () => {
    const html = `
      <html><body><main>
        <form action="/search"><input type="text" name="q" placeholder="Поиск по сайту"><button>Найти</button></form>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://search.example',
      fetchPage: makeFetchRouter({ 'https://search.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.contactForm.hit).toBe(false);
  });

  it('негатив: один адрес — не сеть (S6)', async () => {
    const html = `
      <html><body><main>
        <p>Наш офис: г. Москва, ул. Тверская, д. 1</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://one.example',
      fetchPage: makeFetchRouter({ 'https://one.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.multiOffice.hit).toBe(false);
  });

  it('негатив: вакансия нецелевой роли (S4)', async () => {
    const result = await detectOutreachSignals({
      siteUrl: 'https://zavod.example',
      fetchPage: makeFetchRouter({
        'https://zavod.example/': HTML_HOME_CAREERS_LINK,
        'https://zavod.example/vacancies': HTML_VACANCIES_NON_TARGET,
      }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.targetVacancy.hit).toBe(false);
  });

  it('негатив: «менеджер перезвонит» без контекста найма — не вакансия (S4)', async () => {
    const html = `
      <html><body><main>
        <p>Наш менеджер по продажам перезвонит вам в течение часа.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://cb.example',
      fetchPage: makeFetchRouter({ 'https://cb.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.targetVacancy.hit).toBe(false);
  });
});

describe('SIGNAL_COLUMNS', () => {
  it('точные русские заголовки колонок из референсного CSV', () => {
    expect(SIGNAL_COLUMNS.map((c) => c.key)).toEqual([
      'generalPhone',
      'contactForm',
      'salesDept',
      'targetVacancy',
      'highVolume',
      'multiOffice',
    ]);
    expect(SIGNAL_COLUMNS.map((c) => c.title)).toEqual([
      'Общий телефон / колл-центр',
      'Форма заявки / обратной связи',
      'Отдел продаж / приемная / call-центр',
      'Вакансии: менеджер продаж или оператор call-центра',
      'Признак большого потока',
      'Несколько офисов / филиалов',
    ]);
    for (const col of SIGNAL_COLUMNS) {
      expect(col.clarification).toBe(`${col.title} — уточнение`);
    }
  });
});


describe('тюнинг эвристик 2026-08-03 (регрессии по калибровке)', () => {
  it('S6: один и тот же адрес в разном написании — НЕ сеть', async () => {
    // «д. 1» vs «д.1» vs «улица…дом 1» vs индекс/город — это один адрес.
    const html = `
      <html><body><main>
        <p>Центральный офис: г. Москва, ул. Нижняя Сыромятническая, д. 1</p>
        <p>Склад: Москва, ул. Нижняя Сыромятническая, д.1</p>
        <p>Юр. адрес: 105120, улица Нижняя Сыромятническая, дом 1, оф. 12</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://oneaddr.example',
      fetchPage: makeFetchRouter({ 'https://oneaddr.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.multiOffice.hit).toBe(false);
  });

  it('S6: разные адреса с разными сокращениями — по-прежнему сеть', async () => {
    const html = `
      <html><body><main>
        <p>Наши адреса: улица Тверская, дом 1 и ул. Арбат, д. 25</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://twoaddr.example',
      fetchPage: makeFetchRouter({ 'https://twoaddr.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.multiOffice.hit).toBe(true);
  });

  it('S5: «более N» / «N+» по каталогу и отзывам — НЕ большой поток', async () => {
    const html = `
      <html><body><main>
        <p>В каталоге более 1300 товаров и 500+ моделей.</p>
        <p>У нас более 1000 отзывов и 200+ позиций в наличии.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://catalog.example',
      fetchPage: makeFetchRouter({ 'https://catalog.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.highVolume.hit).toBe(false);
  });

  it('S5: «N+» по бизнес-потоку (клиентов/заявок) — срабатывает', async () => {
    const html = `
      <html><body><main>
        <p>500+ клиентов уже выбрали нас.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://flow.example',
      fetchPage: makeFetchRouter({ 'https://flow.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.highVolume.hit).toBe(true);
    expect(result.signals.highVolume.evidence).toContain('500+ клиентов');
  });

  it('S3: голые «менеджеры» без отдела/центра — НЕ отдел продаж', async () => {
    const html = `
      <html><body><main>
        <p>Наши менеджеры свяжутся с вами в течение часа.</p>
        <p>Цены уточняйте у менеджеров.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://managers.example',
      fetchPage: makeFetchRouter({ 'https://managers.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.salesDept.hit).toBe(false);
  });

  it('S3: «клиентский отдел» и «отдел заявок» — срабатывает', async () => {
    const html = `
      <html><body><main>
        <p>Клиентский отдел работает с 9 до 18 по будням.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://clientdept.example',
      fetchPage: makeFetchRouter({ 'https://clientdept.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.salesDept.hit).toBe(true);
    expect(result.signals.salesDept.evidence).toMatch(/клиентский отдел/i);
  });
});


describe('тюнинг LLM-промпта 2026-08-03 (S5/S6 дефиниции)', () => {
  /**
   * Перехватываем системный промпт дефолтного LLM-добора: llmExtract НЕ
   * инжектируем (работает defaultLlmExtract), сеть режем моком global.fetch —
   * в payload к роутеру попадает реальный промпт, его и проверяем.
   */
  async function captureLlmSystemPrompt(): Promise<string> {
    process.env.OPENROUTER_SIGNALS_API_KEY = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }),
    );
    try {
      await detectOutreachSignals({
        siteUrl: 'https://buro.example',
        fetchPage: makeFetchRouter({ 'https://buro.example/': HTML_CLEAN }),
      });
      const llmCall = fetchSpy.mock.calls.find(([u]) =>
        String(u).includes('chat/completions'),
      );
      expect(llmCall).toBeDefined();
      const body = JSON.parse(String(llmCall![1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      return body.messages[0].content;
    } finally {
      fetchSpy.mockRestore();
      delete process.env.OPENROUTER_SIGNALS_API_KEY;
    }
  }

  it('S5: промпт исключает каталожные числа (товары/модели/отзывы)', async () => {
    const prompt = await captureLlmSystemPrompt();

    // Каталожный объём явно объявлен НЕ-доказательством.
    expect(prompt).toMatch(/НЕ является доказательством/i);
    expect(prompt).toMatch(/товаров/);
    expect(prompt).toMatch(/моделей|позиций|наименований/);
    expect(prompt).toMatch(/отзывов/);
    // Позитивный скоуп (поток клиентов/заявок + режим работы) сохранён.
    expect(prompt).toMatch(/клиентов/);
    expect(prompt).toMatch(/заявок/);
    expect(prompt).toMatch(/без выходных|24\/7|круглосуточно/i);
  });

  it('S6: промпт требует ≥2 разных адресов и отсекает «по всей России»', async () => {
    const prompt = await captureLlmSystemPrompt();

    expect(prompt).toMatch(/два(х)?\s+и\s+более|≥\s*2|нескольких\s+(?:адресов|локаций|городах)/i);
    expect(prompt).toMatch(/один адрес|один офис/i);
    expect(prompt).toMatch(/по всей России/i);
  });

  it('S1: промпт — только телефонные доказательства, колбэк без номера исключён', async () => {
    const prompt = await captureLlmSystemPrompt();
    const line = prompt.split('\n').find((l) => l.startsWith('- generalPhone:')) ?? '';

    expect(line).toContain('8-800');
    expect(line).toMatch(/многоканальн|горяча[яю]\s+лини|единый\s+(?:телефон|номер)/i);
    // Колбэк-кнопка/виджет без номера явно объявлены НЕ-сигналом S1.
    expect(line).toMatch(/Заказать звонок/);
    expect(line).toMatch(/НЕ сигнал/);
  });
});


describe('фиксы ревью 04.08.2026 (S1 телефон-only, S4 окно, S5 порог, S6 города)', () => {
  it('S1: кнопка «Заказать звонок» без номера телефона — НЕ S1 (но S2)', async () => {
    const html = `
      <html><body>
        <main>
          <h1>Школа скорочтения</h1>
          <p>Курсы для детей и взрослых.</p>
          <button>Заказать звонок</button>
        </main>
      </body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://callback-only.example',
      fetchPage: makeFetchRouter({ 'https://callback-only.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.generalPhone.hit).toBe(false);
    expect(result.signals.contactForm.hit).toBe(true);
    expect(result.signalsCount).toBe(1);
  });

  it('S1: «горячая линия» без 8-800 — по-прежнему срабатывает', async () => {
    const html = `
      <html><body><main>
        <p>Горячая линия для клиентов: +7 (495) 111-22-33.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://hotline.example',
      fetchPage: makeFetchRouter({ 'https://hotline.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.generalPhone.hit).toBe(true);
    expect(result.signals.generalPhone.evidence).toMatch(/горяча[яю]\s+лини[яю]/i);
  });

  it('S5: «более 5 клиентов» / «3+ клиентов» — ниже порога величины, НЕ поток', async () => {
    const html = `
      <html><body><main>
        <p>Каждый день мы работаем с более 5 клиентов персонально.</p>
        <p>3+ клиентов уже оценили сервис.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://smallflow.example',
      fetchPage: makeFetchRouter({ 'https://smallflow.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.highVolume.hit).toBe(false);
  });

  it('S5: «более чем 500 клиентов» — срабатывает', async () => {
    const html = `
      <html><body><main>
        <p>Более чем 500 клиентов доверяют нам свои проекты.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://bigflow.example',
      fetchPage: makeFetchRouter({ 'https://bigflow.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.highVolume.hit).toBe(true);
    expect(result.signals.highVolume.evidence).toMatch(/500 клиентов/);
  });

  it('S4: «Вакансии» в меню далеко от «наш менеджер по продажам перезвонит» — НЕ вакансия', async () => {
    const filler = 'Описание услуг компании и её преимуществ. '.repeat(30);
    const html = `
      <html><body>
        <nav><a href="/vacancies">Вакансии</a></nav>
        <main>
          <p>${filler}</p>
          <p>Наш менеджер по продажам перезвонит вам в течение часа.</p>
        </main>
      </body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://nav-vac.example',
      fetchPage: makeFetchRouter({ 'https://nav-vac.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.targetVacancy.hit).toBe(false);
  });

  it('S4: «Вакансия: менеджер по продажам» рядом с контекстом найма — срабатывает', async () => {
    const html = `
      <html><body><main>
        <h1>О компании</h1>
        <p>Вакансия: менеджер по продажам, оклад от 80 000 ₽, полный день.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://near-vac.example',
      fetchPage: makeFetchRouter({ 'https://near-vac.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.targetVacancy.hit).toBe(true);
    expect(result.signals.targetVacancy.evidence).toMatch(/менеджер по продажам/i);
  });

  it('S6: одна и та же улица в разных городах — РАЗНЫЕ адреса (сеть)', async () => {
    const html = `
      <html><body><main>
        <p>Наши адреса: г. Москва, ул. Ленина, д. 1; г. Казань, ул. Ленина, д. 1.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://twocities.example',
      fetchPage: makeFetchRouter({ 'https://twocities.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.multiOffice.hit).toBe(true);
  });

  it('S6: один и тот же адрес дважды в одном городе — НЕ сеть', async () => {
    const html = `
      <html><body><main>
        <p>Офис: г. Москва, ул. Ленина, д. 1</p>
        <p>Как добраться: г. Москва, ул. Ленина, д. 1</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://onecity.example',
      fetchPage: makeFetchRouter({ 'https://onecity.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.multiOffice.hit).toBe(false);
  });
});
