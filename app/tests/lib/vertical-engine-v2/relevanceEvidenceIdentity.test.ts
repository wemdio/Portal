/** @jest-environment node */

/**
 * Проверка владения сайтом решает, купим ли мы платный поиск. Замер на проде
 * по 15 базам: поиск окупается верным сайтом лишь в 2.9% записей, а 18.5%
 * заканчиваются «личность не подтверждена». Поэтому каждое смягчение здесь
 * стоит денег, а каждое ужесточение — контактов; обе стороны под тестом.
 */
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { veCompanyFactKey, veFactPageKey } from '@/lib/verticalEngineV2/companyFacts';
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
