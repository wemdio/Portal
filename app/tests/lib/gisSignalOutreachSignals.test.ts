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

// Все 8 сигналов на одной странице (LLM при этом вызываться не должна).
const HTML_ALL_SIGNALS = `
<html><body>
  <header>
    <a href="tel:88005550000">8 800 555-00-00</a>
    <button>Заказать звонок</button>
  </header>
  <main>
    <h1>Юридический центр Практика</h1>
    <p>Отдел продаж работает ежедневно с 9 до 21.</p>
    <p>Мы ищем менеджера по продажам в команду.</p>
    <p>Более 5000 клиентов обратились к нам за юридической помощью.</p>
    <p>Наши офисы: ул. Тверская, д. 1 и ул. Арбат, д. 25.</p>
    <p>В работе используем amoCRM и коллтрекинг.</p>
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
    // Все сигналы не закрыты эвристиками — LLM позвали ровно один раз.
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0].needed).toHaveLength(SIGNAL_COLUMNS.length);
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

  it('8 сигналов эвристиками: signalsCount — только 6 core, LLM добирает лишь сегментные', async () => {
    const llm = makeLlm();
    const result = await detectOutreachSignals({
      siteUrl: 'https://praktika.example',
      fetchPage: makeFetchRouter({ 'https://praktika.example/': HTML_ALL_SIGNALS }),
      llmExtract: llm,
    });

    expect(result.ok).toBe(true);
    // Скоринговые сигналы сработали, но в signalsCount входят только 6 core.
    expect(result.signals.legalRelevance.hit).toBe(true);
    expect(result.signals.crmCalltracking.hit).toBe(true);
    expect(result.signalsCount).toBe(6);
    // Фикстура не содержит бух/консалтинг/медицину, калькулятора и форм бизнеса,
    // поэтому эвристики закрыли 8 сигналов, а LLM спросили остальные сегментные.
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0].needed.sort()).toEqual(
      [
        'accountingRelevance', 'clientSegments', 'consultingRelevance',
        'medicineMarketingTeam', 'medicinePremium', 'medicinePromo',
        'medicineRelevance', 'pricingPackages',
      ],
    );
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
      'legalRelevance',
      'crmCalltracking',
      'accountingRelevance',
      'consultingRelevance',
      'pricingPackages',
      'clientSegments',
      'medicineRelevance',
      'medicinePromo',
      'medicinePremium',
      'medicineMarketingTeam',
    ]);
    expect(SIGNAL_COLUMNS.map((c) => c.title)).toEqual([
      'Общий телефон / колл-центр',
      'Форма заявки / обратной связи',
      'Отдел продаж / приемная / call-центр',
      'Вакансии: менеджер продаж или оператор call-центра',
      'Признак большого потока',
      'Несколько офисов / филиалов',
      'Юридическая релевантность сайта',
      'CRM / коллтрекинг / речевая аналитика',
      'Бухгалтерская релевантность сайта',
      'Консалтинговая релевантность сайта',
      'Калькулятор / тарифы / пакеты обслуживания',
      'Работа с ИП / ООО / МСБ',
      'Частная клиника / медцентр / сеть',
      'Акции / посадочные / спецпредложения',
      'Имплантация / хирургия / диагностика',
      'Маркетинговая команда / агентство',
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

describe('onlineFormat (checkOnlineFormat)', () => {
  const run = (html: string, checkOnlineFormat = true) =>
    detectOutreachSignals({
      siteUrl: 'https://fmt.example',
      fetchPage: makeFetchRouter({ 'https://fmt.example/': html }),
      llmExtract: makeLlm(),
      checkOnlineFormat,
    });

  it.each<[string, string]>([
    ['<html><body><main><h1>Онлайн-школа программирования</h1><p>Курсы для детей и взрослых.</p></main></body></html>', 'онлайн-школа'],
    ['<html><body><main><p>Обучение дистанционно, из любого города.</p></main></body></html>', 'дистанционно'],
    ['<html><body><main><p>Регулярные вебинары для учеников.</p></main></body></html>', 'вебинар'],
    ['<html><body><main><p>Занятия проходят в Zoom по расписанию.</p></main></body></html>', 'zoom'],
    ['<html><body><main><p>Онлайн курсы английского языка.</p></main></body></html>', 'онлайн + пробел + курсы'],
  ])('позитив: %s', async (html) => {
    const result = await run(html);
    expect(result.onlineFormat).toBeDefined();
    expect(result.onlineFormat!.hit).toBe(true);
    expect(result.onlineFormat!.evidence.length).toBeGreaterThan(0);
    expect(result.onlineFormat!.evidence.length).toBeLessThanOrEqual(120);
  });

  it.each<[string, string]>([
    ['<html><body><main><p>Онлайн-запись на приём в салон красоты «Лотос».</p></main></body></html>', 'онлайн-запись — booking-CTA офлайн-салона'],
    ['<html><body><main><p>Записаться онлайн на стрижку. Ждём вас по адресу: ул. Ленина, 5.</p></main></body></html>', 'записаться онлайн'],
    ['<html><body><main><p>Оставьте онлайн-заявку на расчёт стоматологии.</p></main></body></html>', 'онлайн-заявка'],
    ['<html><body><main><p>Автошкола «Вперёд». Учебные классы в Москве, вождение на наших автомобилях.</p></main></body></html>', 'просто офлайн-сайт'],
    ['<html><body><main><p>Мы онлайн с 9 до 21.</p></main></body></html>', 'голое «онлайн» без составной формы'],
  ])('негатив: %s', async (html) => {
    const result = await run(html);
    expect(result.onlineFormat).toBeDefined();
    expect(result.onlineFormat!.hit).toBe(false);
    expect(result.onlineFormat!.evidence).toBe('');
  });

  it('флаг выключен → поле onlineFormat отсутствует в результате', async () => {
    const result = await run(
      '<html><body><main><h1>Онлайн-школа программирования</h1></main></body></html>',
      false,
    );
    expect('onlineFormat' in result).toBe(false);
  });

  it('onlineFormat НЕ влияет на signalsCount (это не 7-й сигнал)', async () => {
    const result = await run(
      '<html><body><main><h1>Онлайн-школа программирования</h1><p>Курсы для детей.</p></main></body></html>',
    );
    expect(result.onlineFormat!.hit).toBe(true);
    expect(result.signalsCount).toBe(0); // сигналов S1-S6 на этой странице нет
  });
});

describe('legalRelevance (скоринговый сигнал legal)', () => {
  const run = (html: string) =>
    detectOutreachSignals({
      siteUrl: 'https://legal.example',
      fetchPage: makeFetchRouter({ 'https://legal.example/': html }),
      llmExtract: makeLlm(),
    });

  it.each<[string, RegExp]>([
    ['<html><body><main><h1>Юридические услуги для бизнеса</h1></main></body></html>', /юридическ/i],
    ['<html><body><main><p>Адвокаты коллегии представят ваши интересы.</p></main></body></html>', /адвокат/i],
    ['<html><body><main><p>Помощь в банкротстве физических лиц.</p></main></body></html>', /банкротств/i],
    ['<html><body><main><p>Регистрация ООО и ИП под ключ за 3 дня.</p></main></body></html>', /регистраци[яию]\s+ооо/i],
    ['<html><body><main><p>Ликвидация предприятий и налоговые споры.</p></main></body></html>', /ликвидац|налоговы[ех]\s+спор/i],
    ['<html><body><main><p>Патентные услуги и защита авторских прав.</p></main></body></html>', /патентн|авторски[ех]\s+прав/i],
    ['<html><body><main><p>Представительство в арбитражном суде, судебные споры.</p></main></body></html>', /арбитраж|судебн/i],
  ])('позитив: %s', async (html, expected) => {
    const result = await run(html);
    expect(result.signals.legalRelevance.hit).toBe(true);
    expect(result.signals.legalRelevance.evidence).toMatch(expected);
    expect(result.signals.legalRelevance.evidence.length).toBeLessThanOrEqual(200);
  });

  it.each<[string, string]>([
    ['<html><body><footer><p>Юридический адрес: г. Москва, ул. Ленина, д. 1. ООО «Ромашка».</p></footer></body></html>', 'юридический адрес — реквизиты, не тематика'],
    ['<html><body><footer><p>Правовая информация. Политика конфиденциальности.</p></footer></body></html>', 'правовая информация — подвальный булочкрож'],
    ['<html><body><main><h1>Стоматология Улыбка</h1><p>Лечение зубов.</p></main></body></html>', 'неюридический сайт'],
  ])('негатив: %s', async (html) => {
    const result = await run(html);
    expect(result.signals.legalRelevance.hit).toBe(false);
    expect(result.signals.legalRelevance.evidence).toBe('');
  });

  it('не входит в signalsCount (скоринговый, не core-сигнал)', async () => {
    const result = await run(
      '<html><body><main><h1>Юридические услуги</h1></main></body></html>',
    );
    expect(result.signals.legalRelevance.hit).toBe(true);
    expect(result.signalsCount).toBe(0);
  });
});

describe('crmCalltracking (скоринговый сигнал legal)', () => {
  const run = (html: string) =>
    detectOutreachSignals({
      siteUrl: 'https://crm.example',
      fetchPage: makeFetchRouter({ 'https://crm.example/': html }),
      llmExtract: makeLlm(),
    });

  it('позитив: скрипт Calltouch (виджет call_tracking) без текста', async () => {
    const result = await run(
      '<html><body><main><h1>Юристы</h1></main><script src="//mod.calltouch.ru/init.js?id=1"></script></body></html>',
    );
    expect(result.signals.crmCalltracking.hit).toBe(true);
    expect(result.signals.crmCalltracking.evidence).toContain('Calltouch');
  });

  it('позитив: скрипт amoCRM (виджет crm)', async () => {
    const result = await run(
      '<html><body><main><h1>Юристы</h1></main><script src="https://cdn.amocrm.ru/widget.js"></script></body></html>',
    );
    expect(result.signals.crmCalltracking.hit).toBe(true);
    expect(result.signals.crmCalltracking.evidence).toContain('amoCRM');
  });

  it.each<[string, RegExp]>([
    ['<html><body><main><p>Мы используем коллтрекинг и речевую аналитику.</p></main></body></html>', /коллтрекинг|речев/i],
    ['<html><body><main><p>Отдел работает в Битрикс24, виртуальная АТС подключена.</p></main></body></html>', /битрикс|виртуальн/i],
    ['<html><body><main><p>Внедрили calltracking от CoMagic.</p></main></body></html>', /calltracking|comagic/i],
  ])('позитив текстом: %s', async (html, expected) => {
    const result = await run(html);
    expect(result.signals.crmCalltracking.hit).toBe(true);
    expect(result.signals.crmCalltracking.evidence).toMatch(expected);
  });

  it('негатив: сайт без CRM/коллтрекинга', async () => {
    const result = await run(
      '<html><body><main><h1>Бюро переводов</h1><p>Переводим документы.</p></main></body></html>',
    );
    expect(result.signals.crmCalltracking.hit).toBe(false);
    expect(result.signals.crmCalltracking.evidence).toBe('');
  });

  it('не входит в signalsCount (скоринговый, не core-сигнал)', async () => {
    const result = await run(
      '<html><body><main><p>Мы используем коллтрекинг.</p></main></body></html>',
    );
    expect(result.signals.crmCalltracking.hit).toBe(true);
    expect(result.signalsCount).toBe(0);
  });
});

describe('salesDept: intake-команда (расширение для legal-скоринга)', () => {
  it('«intake-отдел» — срабатывает', async () => {
    const html = `
      <html><body><main>
        <p>Intake-отдел принимает входящие обращения клиентов ежедневно.</p>
      </main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://intake.example',
      fetchPage: makeFetchRouter({ 'https://intake.example/': html }),
      llmExtract: makeLlm(),
    });
    expect(result.signals.salesDept.hit).toBe(true);
    expect(result.signals.salesDept.evidence).toMatch(/intake/i);
  });
});

/**
 * Инцидент 12.08.2026: evidence с одиночным (непарным) UTF-16 суррогатом
 * доезжал до upsert'а архива, и Postgres отвергал ВЕСЬ пакет из 2000 строк —
 * «invalid input syntax for type json». Источник — срез сниппета/обрезка по
 * 200 символов ровно посередине surrogate pair эмодзи с сайта.
 */
describe('evidence: битый UTF-16 не выходит наружу', () => {
  const EMOJI = '\u{1F4A1}'; // валидная пара D83D DCA1
  const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  // Две набивки: сдвиг на один символ меняет чётность позиций эмодзи, поэтому
  // хотя бы одна из них гарантированно кладёт границу среза внутрь пары —
  // тест ловит регрессию независимо от точной длины совпадения телефона.
  it.each([0, 1])('сниппет вокруг совпадения не режет эмодзи пополам (набивка %i)', async (pad) => {
    const html = `<html><body><main>8 800 555-06-65 ${'x'.repeat(pad)}${EMOJI.repeat(120)}</main></body></html>`;
    const result = await detectOutreachSignals({
      siteUrl: 'https://emoji.example',
      fetchPage: makeFetchRouter({ 'https://emoji.example/': html }),
      llmExtract: makeLlm(),
    });

    expect(result.signals.generalPhone.hit).toBe(true);
    for (const verdict of Object.values(result.signals)) {
      expect(LONE_SURROGATE_RE.test(verdict.evidence)).toBe(false);
    }
    // Сериализация результата не содержит escape'ов, которые PG не примет.
    expect(/\\u(d[89ab][0-9a-f]{2})/i.test(JSON.stringify(result))).toBe(false);
  });

  it('обрезка длинного evidence по 200 символов не оставляет половинку эмодзи', async () => {
    // 198 символов + эмодзи: обрезка приходится ровно между его половинами.
    const llm = makeLlm({
      salesDept: { hit: true, evidence: `${'а'.repeat(198)}${EMOJI}${'б'.repeat(50)}` },
    });
    const result = await detectOutreachSignals({
      siteUrl: 'https://buro.example',
      fetchPage: makeFetchRouter({ 'https://buro.example/': HTML_CLEAN }),
      llmExtract: llm,
    });

    const { evidence } = result.signals.salesDept;
    expect(result.signals.salesDept.hit).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(200);
    expect(evidence.startsWith('а'.repeat(198))).toBe(true);
    expect(LONE_SURROGATE_RE.test(evidence)).toBe(false);
  });

  it('одиночный суррогат и NUL из ответа LLM вычищаются, текст сохраняется', async () => {
    const llm = makeLlm({
      salesDept: {
        hit: true,
        evidence: `отдел${String.fromCharCode(0xd83d)} продаж${String.fromCharCode(0)}`,
      },
    });
    const result = await detectOutreachSignals({
      siteUrl: 'https://buro.example',
      fetchPage: makeFetchRouter({ 'https://buro.example/': HTML_CLEAN }),
      llmExtract: llm,
    });

    expect(result.signals.salesDept.evidence).toBe('отдел продаж');
  });
});

/**
 * Сегментные сигналы accounting/consulting (ТЗ 15.08.2026). Главная ловушка —
 * соседние рубрики 2GIS: «Бухгалтерские программы» (3784 карточки) и
 * «Бухгалтерские курсы» (694) стоят рядом с «Бухгалтерскими услугами», и без
 * стоп-листа вендор 1С проходил бы как бухгалтерская компания.
 */
describe('сегментные сигналы: accounting / consulting', () => {
  const run = async (html: string, llm = makeLlm()) =>
    detectOutreachSignals({
      siteUrl: 'https://seg.example',
      fetchPage: makeFetchRouter({ 'https://seg.example/': html }),
      llmExtract: llm,
    });

  it('accountingRelevance: бухгалтерское сопровождение и аутсорсинг — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>Компания Актив</h1>
      <p>Бухгалтерское сопровождение бизнеса и аутсорсинг бухгалтерии под ключ.</p>
    </main></body></html>`);
    expect(r.signals.accountingRelevance.hit).toBe(true);
    expect(r.signals.accountingRelevance.evidence).toMatch(/бухгалтерск/i);
  });

  it('accountingRelevance: сдача отчётности и расчёт зарплаты — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <p>Сдача отчётности в ФНС, расчёт заработной платы, кадровый учёт.</p>
    </main></body></html>`);
    expect(r.signals.accountingRelevance.hit).toBe(true);
  });

  it('accountingRelevance: сайт 1С-интегратора — НЕ срабатывает, хотя пишет «бухгалтерский учёт»', async () => {
    // Ровно та формулировка, на которой стоп-лист пробивался до 15.08.2026:
    // позитивный паттерн ловил «бухгалтерского учёта» ВНУТРИ вендорской фразы.
    const r = await run(`<html><body><main>
      <h1>Бухгалтерские программы 1С</h1>
      <p>Автоматизация бухгалтерского учёта, внедрение 1С:Бухгалтерия, продажа программ.</p>
    </main></body></html>`);
    expect(r.signals.accountingRelevance.hit).toBe(false);
  });

  it('accountingRelevance: настоящая бухфирма, работающая в 1С, — срабатывает', async () => {
    // Обратная сторона стоп-листа: упоминание 1С само по себе сигнал не убивает.
    const r = await run(`<html><body><main>
      <p>Ведём бухгалтерский учёт в 1С для ИП и ООО, сдаём отчётность.</p>
    </main></body></html>`);
    expect(r.signals.accountingRelevance.hit).toBe(true);
  });

  it('accountingRelevance: учебный центр с курсами бухгалтеров — НЕ срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>Учебный центр</h1>
      <p>Курсы бухгалтеров и повышение квалификации бухгалтеров с нуля.</p>
    </main></body></html>`);
    expect(r.signals.accountingRelevance.hit).toBe(false);
  });

  it('consultingRelevance: управленческий консалтинг — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>Группа компаний Вектор</h1>
      <p>Управленческий и финансовый консалтинг, оптимизация бизнес-процессов.</p>
    </main></body></html>`);
    expect(r.signals.consultingRelevance.hit).toBe(true);
  });

  it('consultingRelevance: «бесплатная консультация» как CTA — НЕ срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>Стоматология Улыбка</h1>
      <p>Запишитесь на бесплатную консультацию врача. Получить консультацию специалиста.</p>
    </main></body></html>`);
    expect(r.signals.consultingRelevance.hit).toBe(false);
  });

  it('pricingPackages: калькулятор и тарифы — срабатывает; голая цена — нет', async () => {
    const withCalc = await run(`<html><body><main>
      <p>Калькулятор стоимости услуг. Тарифные планы для разных объёмов документов.</p>
    </main></body></html>`);
    expect(withCalc.signals.pricingPackages.hit).toBe(true);

    const bare = await run('<html><body><main><p>Услуга стоит 5000 рублей.</p></main></body></html>');
    expect(bare.signals.pricingPackages.hit).toBe(false);
  });

  it('clientSegments: «для ИП и ООО» / «малый и средний бизнес» — срабатывает', async () => {
    const a = await run('<html><body><main><p>Работаем для ИП и ООО на любой системе налогообложения.</p></main></body></html>');
    expect(a.signals.clientSegments.hit).toBe(true);

    const b = await run('<html><body><main><p>Обслуживаем малый и средний бизнес по всей России.</p></main></body></html>');
    expect(b.signals.clientSegments.hit).toBe(true);
  });

  it('clientSegments: собственная форма в реквизитах — НЕ срабатывает', async () => {
    const r = await run(`<html><body><footer>
      <p>ООО «Ромашка», ИНН 7701234567. Все права защищены.</p>
    </footer></body></html>`);
    expect(r.signals.clientSegments.hit).toBe(false);
  });

  it('salesDept: business development и отдел по работе с обращениями (расширение ТЗ)', async () => {
    const a = await run('<html><body><main><p>Наш business development отвечает на входящие запросы.</p></main></body></html>');
    expect(a.signals.salesDept.hit).toBe(true);

    const b = await run('<html><body><main><p>Отдел по работе с обращениями работает ежедневно.</p></main></body></html>');
    expect(b.signals.salesDept.hit).toBe(true);
  });

  it('targetVacancy: аккаунт-менеджер в вакансиях (расширение ТЗ consulting)', async () => {
    const r = await detectOutreachSignals({
      siteUrl: 'https://cons.example',
      fetchPage: makeFetchRouter({
        'https://cons.example/': `<html><body><main><h1>Консалтинг</h1></main>
          <footer><a href="/vacancies">Вакансии</a></footer></body></html>`,
        'https://cons.example/vacancies': `<html><body><main>
          <h1>Открытые вакансии</h1><div><h3>Аккаунт-менеджер</h3><p>от 120 000 ₽</p></div>
        </main></body></html>`,
      }),
      llmExtract: makeLlm(),
    });
    expect(r.signals.targetVacancy.hit).toBe(true);
  });

  it('highVolume: «300 компаний на обслуживании» — поток; «500 проектов» у ремонта — нет', async () => {
    const acc = await run('<html><body><main><p>Более 300 компаний на обслуживании.</p></main></body></html>');
    expect(acc.signals.highVolume.hit).toBe(true);

    const remont = await run('<html><body><main><p>Мы выполнили более 500 проектов ремонта.</p></main></body></html>');
    expect(remont.signals.highVolume.hit).toBe(false);
  });

  it('новые сигналы не входят в signalsCount — фильтр edu/remont не меняется', async () => {
    const r = await run(`<html><body><main>
      <p>Бухгалтерское обслуживание, тарифы и пакеты услуг для ИП и ООО.</p>
    </main></body></html>`);
    expect(r.signals.accountingRelevance.hit).toBe(true);
    expect(r.signals.pricingPackages.hit).toBe(true);
    expect(r.signals.clientSegments.hit).toBe(true);
    expect(r.signalsCount).toBe(0);
  });
});

describe('сегментные сигналы: medicine (ТЗ 22.08.2026)', () => {
  const run = async (html: string, llm = makeLlm()) =>
    detectOutreachSignals({
      siteUrl: 'https://med.example',
      fetchPage: makeFetchRouter({ 'https://med.example/': html }),
      llmExtract: llm,
    });

  it('medicineRelevance: частная клиника и медицинский центр — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>Сеть клиник «Здоровье»</h1>
      <p>Многопрофильный медицинский центр и частная стоматология.</p>
    </main></body></html>`);
    expect(r.signals.medicineRelevance.hit).toBe(true);
    expect(r.signals.medicineRelevance.evidence).toMatch(/медицинск|клиник|стоматолог/i);
    expect(r.signalsCount).toBe(0);
    expect(r.medicineHardReject?.hit).toBe(false);
  });

  it('medicineRelevance: ГБУЗ / городская больница — НЕ срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>ГБУЗ Городская клиническая больница №1</h1>
      <p>Государственное бюджетное учреждение здравоохранения, поликлиника.</p>
    </main></body></html>`);
    expect(r.signals.medicineRelevance.hit).toBe(false);
    expect(r.medicineHardReject?.hit).toBe(true);
  });

  it('medicineRelevance: продажа медицинского оборудования — НЕ срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>МедТехСнаб</h1>
      <p>Продажа медицинского оборудования и томографов оптом. Поставка в клиники.</p>
    </main></body></html>`);
    expect(r.signals.medicineRelevance.hit).toBe(false);
  });

  it('medicineRelevance: кабинет частного врача без клиники — НЕ срабатывает', async () => {
    const r = await run(`<html><body><main>
      <h1>Кабинет врача Иванова</h1>
      <p>Частная практика. Я врач-терапевт, принимаю по записи.</p>
    </main></body></html>`);
    expect(r.signals.medicineRelevance.hit).toBe(false);
  });

  it('medicinePromo: акции и спецпредложения — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <p>Спецпредложение августа: имплантация со скидкой. Отдельная посадочная страница для рекламы.</p>
    </main></body></html>`);
    expect(r.signals.medicinePromo.hit).toBe(true);
  });

  it('medicinePremium: имплантация, хирургия, стоматология — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <p>Имплантация зубов, пластическая хирургия, программы лечения и косметология.</p>
    </main></body></html>`);
    expect(r.signals.medicinePremium.hit).toBe(true);
  });

  it('medicineMarketingTeam: вакансия маркетолога — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <p>Открыта вакансия маркетолога и performance-специалиста, руководитель отдела маркетинга.</p>
    </main></body></html>`);
    expect(r.signals.medicineMarketingTeam.hit).toBe(true);
  });

  it('contactForm: «Записаться на приём» — срабатывает', async () => {
    const r = await run(`<html><body>
      <button>Записаться на приём</button>
      <main><h1>Клиника</h1></main>
    </body></html>`);
    expect(r.signals.contactForm.hit).toBe(true);
  });

  it('crmCalltracking: МИС и онлайн-запись — срабатывает', async () => {
    const r = await run(`<html><body><main>
      <p>Онлайн-запись через медицинскую информационную систему (МИС).</p>
    </main></body></html>`);
    expect(r.signals.crmCalltracking.hit).toBe(true);
  });

  it('жёсткий стоп-лист: госбольница с акциями и формой всё равно reject', async () => {
    const r = await run(`<html><body>
      <button>Записаться на приём</button>
      <main>
        <h1>ГБУЗ Городская клиническая больница №1</h1>
        <p>Спецпредложение: имплантация со скидкой. Посадочная страница для рекламы.</p>
      </main>
    </body></html>`);
    expect(r.signals.medicinePromo.hit).toBe(true);
    expect(r.signals.contactForm.hit).toBe(true);
    expect(r.medicineHardReject?.hit).toBe(true);
    expect(r.medicineHardReject?.evidence).toMatch(/гбуз|больниц|бюджетн/i);
  });

  it('жёсткий стоп-лист: продажа медоборудования, фармпроизводитель, кабинет врача', async () => {
    const equipment = await run(`<html><body><main>
      <p>Продажа медицинского оборудования и томографов оптом.</p>
    </main></body></html>`);
    expect(equipment.medicineHardReject?.hit).toBe(true);

    const pharma = await run(`<html><body><main>
      <p>Фармацевтическая компания, производитель лекарств.</p>
    </main></body></html>`);
    expect(pharma.medicineHardReject?.hit).toBe(true);

    const solo = await run(`<html><body><main>
      <h1>Кабинет врача Иванова</h1>
      <p>Частная практика. Я врач-терапевт.</p>
    </main></body></html>`);
    expect(solo.medicineHardReject?.hit).toBe(true);
  });

  it('жёсткий стоп-лист: частная клиника не режется; слово «аптека» рядом — не бан', async () => {
    const clinic = await run(`<html><body><main>
      <h1>Сеть клиник «Здоровье»</h1>
      <p>Многопрофильный медицинский центр. Рядом аптека.</p>
    </main></body></html>`);
    expect(clinic.signals.medicineRelevance.hit).toBe(true);
    expect(clinic.medicineHardReject?.hit).toBe(false);
  });
});
