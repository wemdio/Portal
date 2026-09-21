/** @jest-environment node */

/**
 * Проверка владения сайтом решает, купим ли мы платный поиск. Замер на проде
 * по 15 базам: поиск окупается верным сайтом лишь в 2.9% записей, а 18.5%
 * заканчиваются «личность не подтверждена». Поэтому каждое смягчение здесь
 * стоит денег, а каждое ужесточение — контактов; обе стороны под тестом.
 */
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { veCompanyFactKey, veFactPageKey } from '@/lib/verticalEngineV2/companyFacts';
import { VeOperationTimeoutError } from '@/lib/verticalEngineV2/operationDeadline';
import type { VeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';

const OUR_INN = '7700000001';
const FOREIGN_INN = '7800000002';
const page = (over: Partial<VeEvidencePage> & { url: string }): VeEvidencePage =>
  ({ text: 'Мы производим корпусную мебель на собственной фабрике.', links: [], inns: [], ...over });

const run = (pages: Record<string, VeEvidencePage>, search?: jest.Mock) => fetchVeRelevanceEvidence('https://romashka.ru', {
  companyInn: OUR_INN, companyName: 'Ромашка', companyAddress: 'Казань, ул. Мира, 5', focus: 'мебель',
  fetchPage: async (url) => pages[url] ?? page({ url, text: '' }),
  ...(search ? { search: search as never } : {}),
});

describe('подтверждение владения сайтом', () => {
  it('чужой ИНН в тексте страницы больше не аннулирует сайт', async () => {
    // Отзыв клиента, платёжный виджет, перечень партнёров — всё это приносит
    // чужие ИНН в текст. Раньше любой такой ИНН отменял весь сайт целиком, и
    // компания уходила покупать поиск.
    const search = jest.fn(async () => []);
    const result = await run({
      'https://romashka.ru/': page({ url: 'https://romashka.ru/', inns: [FOREIGN_INN], ownerInns: [OUR_INN] }),
    }, search);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('identity_verified_website');
    expect(search).not.toHaveBeenCalled();
  });

  it('чужой ИНН в реквизитах по-прежнему отменяет сайт', async () => {
    // Владельческие позиции — подвал, реквизиты, юридическая страница. Чужой
    // ИНН там означает, что сайт принадлежит другой компании.
    const result = await run({
      'https://romashka.ru/': page({ url: 'https://romashka.ru/', inns: [FOREIGN_INN], ownerInns: [FOREIGN_INN] }),
    });
    expect(result.status).not.toBe('ok');
    expect(result.text).toBe('');
  });

  it('сайт без единого ИНН остаётся неподтверждённым', async () => {
    // Смягчать это нельзя: именно отсюда берётся право купить поиск.
    const result = await run({
      'https://romashka.ru/': page({ url: 'https://romashka.ru/' }),
    });
    expect(result.status).not.toBe('ok');
  });

  it('чужой владелец остаётся окончательным ответом, даже если страница тормозила', async () => {
    // Ярлык «таймаут» отправляет компанию на повторную проверку, а повтор
    // снова покупает платный поиск. Для сайта с чужим владельцем повторять
    // нечего: ответ уже получен и не изменится.
    const result = await fetchVeRelevanceEvidence('https://slow.test, https://romashka.ru', {
      companyInn: OUR_INN, companyName: 'Ромашка', companyAddress: 'Казань, ул. Мира, 5', focus: 'мебель',
      fetchPage: async (url) => {
        if (url.includes('slow.test')) throw new VeOperationTimeoutError('relevance evidence page', 5000);
        return page({ url, inns: [FOREIGN_INN], ownerInns: [FOREIGN_INN] });
      },
      search: (async () => []) as never,
    });
    expect(result.status).not.toBe('ok');
    expect(result.reason).toBe('website_identity_unverified');
  });

  it('без сайта пробует домен корпоративной почты, а не сразу покупает поиск', async () => {
    // 17.8% строк резерва вообще без сайта — им поиск покупался без единой
    // бесплатной попытки. У трети из них почта на собственном домене.
    const search = jest.fn(async () => []);
    const result = await fetchVeRelevanceEvidence('', {
      companyInn: OUR_INN, companyName: 'Ромашка', companyAddress: 'Казань, ул. Мира, 5', focus: 'мебель',
      companyEmail: 'info@romashka-mebel.ru',
      fetchPage: async (url) => page({ url, inns: [OUR_INN], ownerInns: [OUR_INN] }),
      search: search as never,
    });
    expect(result.status).toBe('ok');
    expect(result.url).toContain('romashka-mebel.ru');
    expect(search).not.toHaveBeenCalled();
  });

  it('личный ящик сайтом компании не считается', async () => {
    // mail.ru и gmail ничего не говорят о компании: такой домен читать нельзя.
    const fetchPage = jest.fn(async (url: string) => page({ url }));
    const result = await fetchVeRelevanceEvidence('', {
      companyInn: OUR_INN, companyName: 'Ромашка', companyAddress: 'Казань, ул. Мира, 5',
      companyEmail: 'romashka2020@mail.ru',
      fetchPage, search: (async () => []) as never,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.status).not.toBe('ok');
  });

  it('подтверждённая страница из памяти фактов проверяется вместо покупки поиска', async () => {
    // Раньше память подключалась только при пустом поле «сайт»: компания с
    // сайтом из реестра, который не печатает ИНН, платила за поиск заново.
    const search = jest.fn(async () => []);
    const remembered = page({ url: 'https://romashka-mebel.ru/', ownerInns: [OUR_INN], inns: [OUR_INN] });
    const result = await fetchVeRelevanceEvidence('https://romashka.ru', {
      companyInn: OUR_INN, companyName: 'Ромашка', companyAddress: 'Казань, ул. Мира, 5', focus: 'мебель',
      fetchPage: async (url) => (url === remembered.url ? remembered : page({ url })),
      companyFacts: {
        read: (async () => [{
          company_key: veCompanyFactKey({ inn: OUR_INN }),
          page_key: veFactPageKey(remembered.url),
          reader_version: 1,
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          page: {
            url: remembered.url, text: remembered.text, inns: remembered.inns, ownerInns: remembered.ownerInns,
            document: { text: remembered.text.repeat(4), links: [] },
          },
        }]) as never,
        write: (async () => undefined) as never,
      },
      search: search as never,
    });
    // Память лишь даёт шанс подтвердиться бесплатно; покупать поиск не пришлось.
    expect(search).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
  });
});
