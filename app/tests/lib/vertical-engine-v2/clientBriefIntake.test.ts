/** @jest-environment node */

/**
 * Разбор заполненного клиентом брифа (стандарт агентства — ClientBriefFields).
 *
 * Реальные брифы приходят дырявыми: строку оставляют пустой либо ставят
 * заглушку («-», «в разработке», «под NDA»). Такие ответы обязаны попадать в
 * missing, а не в поля: иначе промпты research'а получают «в разработке» как
 * лид-магнит и строят на этом гипотезы.
 *
 * Второй риск — хвост самой формы: инструкция про social proof с примерами
 * ссылок (youtu.be, kommersant.ru) есть в КАЖДОМ брифе и не является данными
 * клиента. Её режем ДО LLM-вызова, детерминированно.
 */

import { EMPTY_BRIEF_FIELDS } from '@/lib/clientBrief';

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getVeModel: jest.fn(() => 'test-research-model'),
}));

import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';
import {
  isPlaceholderAnswer,
  parseClientBriefText,
  stripBriefTemplateBoilerplate,
} from '@/lib/verticalEngineV2/clientBriefIntake';

const callLLMMock = callLLMWithSchema as unknown as jest.Mock;

const BOILERPLATE = `Инструкция по заполнению социальных доказательств. Что они из себя представляют и зачем нужны.
Представьте, вы прогуливаетесь по улице и внезапно встречаете незнакомца…
Пример отзыва
Пример рейтинга / оценки
https://youtu.be/tc5r9CGB1r8
Пример видео (можно видео про продукт или услугу)
https://www.kommersant.ru/doc/5537557
Пример упоминания в СМИ (можно личные статьи)`;

const BRIEF_WITH_GAPS = `ОПИСАНИЕ КОМПАНИИ -------------------------------------------------------
Ссылка на действующий сайт: в разработке: текстовый прототип лендинга под продажу консалтинга по ВЭД
Краткое описание деятельности: Консалтинговый проект «Фомичева» — настройка «белой» системы ВЭД
Цикл сделки (от первого касания до оплаты): Итого средний цикл сделки: от 3 до 6 недель
АКЦИЯ/СПЕЦИАЛЬНОЕ ПРЕДЛОЖЕНИЕ -----------------------------------
-
КАКИЕ ЛИД МАГНИТЫ У ВАС ЕСТЬ? ----------------------------------------
В разработке
КОМУ ПЕРЕДАЕМ ЛИДОВ? ----------------------------------------------------
ВАШИ ДЕЙСТВУЮЩИЕ КЛИЕНТЫ? ------------------------------------------
под NDA
${BOILERPLATE}`;

/** Ответ LLM: заполненное — как в брифе, дырки — пустыми, плюс мусорный ключ. */
function llmFields(overrides: Record<string, unknown> = {}) {
  return {
    ...EMPTY_BRIEF_FIELDS,
    company_website: 'в разработке: текстовый прототип лендинга под продажу консалтинга по ВЭД',
    company_description: 'Консалтинговый проект «Фомичева» — настройка «белой» системы ВЭД',
    deal_cycle: 'Итого средний цикл сделки: от 3 до 6 недель',
    special_offer: '-',
    lead_magnets: 'В разработке',
    existing_clients: 'под NDA',
    ...overrides,
  };
}

function mockLlmOnce(fields: Record<string, unknown>) {
  callLLMMock.mockResolvedValueOnce({
    data: { fields },
    tokensUsed: 120,
    costUsd: 0.002,
    promptTokens: 100,
    completionTokens: 20,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('stripBriefTemplateBoilerplate', () => {
  it('cuts the social-proof instruction tail that every brief carries', () => {
    const cleaned = stripBriefTemplateBoilerplate(BRIEF_WITH_GAPS);

    expect(cleaned).toContain('Консалтинговый проект');
    expect(cleaned).not.toContain('Инструкция по заполнению');
    expect(cleaned).not.toContain('youtu.be');
    expect(cleaned).not.toContain('kommersant.ru');
    expect(cleaned).not.toContain('Пример отзыва');
  });

  it('leaves a brief without the tail untouched', () => {
    const plain = 'ОПИСАНИЕ КОМПАНИИ\nСсылка на сайт: https://komma.software/';
    expect(stripBriefTemplateBoilerplate(plain)).toBe(plain);
  });
});

describe('isPlaceholderAnswer', () => {
  it.each(['-', '—', 'в разработке', 'В разработке', 'под NDA', 'под NBA', 'n/a', '', '   '])(
    'treats %p as no answer',
    (value) => {
      expect(isPlaceholderAnswer(value)).toBe(true);
    },
  );

  it.each([
    'нет ограничений по объёму',
    'Гарантия возврата 30 дней',
    '1–2 созвона для диагностики',
  ])('keeps real answer %p', (value) => {
    expect(isPlaceholderAnswer(value)).toBe(false);
  });
});

describe('parseClientBriefText', () => {
  it('keeps filled rows and reports placeholders as missing', async () => {
    mockLlmOnce(llmFields());

    const { brief } = await parseClientBriefText(BRIEF_WITH_GAPS, { fileName: 'amb.docx' });

    expect(brief.fields.deal_cycle).toContain('от 3 до 6 недель');
    expect(brief.fields.company_description).toContain('Фомичева');

    // Заглушки не данные: поле пустое, факт отсутствия — в missing.
    expect(brief.fields.special_offer).toBe('');
    expect(brief.fields.lead_magnets).toBe('');
    expect(brief.fields.existing_clients).toBe('');
    expect(brief.missing).toEqual(
      expect.arrayContaining(['special_offer', 'lead_magnets', 'existing_clients']),
    );

    // Незаполненные клиентом строки тоже в missing.
    expect(brief.missing).toEqual(expect.arrayContaining(['lead_recipient_email', 'usp']));

    expect(brief.file_name).toBe('amb.docx');
    expect(brief.uploaded_at).toEqual(expect.any(String));
  });

  it('drops keys outside the agency standard', async () => {
    mockLlmOnce(llmFields({ secret_notes: 'выдумка модели', price_tier: 'business' }));

    const { brief } = await parseClientBriefText(BRIEF_WITH_GAPS, { fileName: null });

    expect(brief.fields).not.toHaveProperty('secret_notes');
    expect(brief.fields.price_tier).toBe('business');
  });

  it('sends the cleaned brief to the model and never the form template', async () => {
    mockLlmOnce(llmFields());

    await parseClientBriefText(BRIEF_WITH_GAPS, { fileName: 'amb.docx' });

    const [messages] = callLLMMock.mock.calls[0] as [Array<{ role: string; content: string }>];
    const sent = messages.map((m) => m.content).join('\n');
    expect(sent).toContain('Консалтинговый проект');
    expect(sent).not.toContain('kommersant.ru');
    expect(sent).not.toContain('Инструкция по заполнению');
  });

  it('reports every field as missing for an empty brief', async () => {
    mockLlmOnce({ ...EMPTY_BRIEF_FIELDS });

    const { brief } = await parseClientBriefText('ОПИСАНИЕ КОМПАНИИ', { fileName: null });

    expect(brief.missing).toContain('company_description');
    expect(brief.missing).toContain('target_audience');
  });
});
