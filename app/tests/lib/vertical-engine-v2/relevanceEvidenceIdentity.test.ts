/** @jest-environment node */

/**
 * Проверка владения сайтом решает, купим ли мы платный поиск. Замер на проде
 * по 15 базам: поиск окупается верным сайтом лишь в 2.9% записей, а 18.5%
 * заканчиваются «личность не подтверждена». Поэтому каждое смягчение здесь
 * стоит денег, а каждое ужесточение — контактов; обе стороны под тестом.
 */
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { normalizeVeSourceContacts, recoverVeSourceContacts, VE_CONFIRMED_WEBSITE_MARK } from '@/lib/verticalEngineV2/sourceContacts';
import { veCompanyFactKey, veFactPageKey } from '@/lib/verticalEngineV2/companyFacts';
import { vePaymentCompanyHint } from '@/lib/verticalEngineV2/paymentCompanyDirectory';
import { VeOperationTimeoutError } from '@/lib/verticalEngineV2/operationDeadline';
import { parseVeEvidencePage, type VeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';

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

  it('сайт без единого ИНН принимается по бренду и городу вместо покупки поиска', async () => {
    // 20.7% компаний заканчивали на «владение не подтверждено»: сайт открылся,
    // но ИНН в подвале нет. Такие уходили покупать поиск, который приносит
    // подтверждённый сайт в 2.7% записей. Для компании БЕЗ ИНН этот же сайт
    // принимался — наличие ИНН в реестре делало требование строже.
    const search = jest.fn(async () => []);
    const result = await run({
      'https://romashka.ru/': page({
        url: 'https://romashka.ru/',
        title: 'Ромашка — мебельная фабрика',
        text: 'Производим корпусную мебель. Казань, ул. Мира, 5.',
      }),
    }, search);
    expect(result.status).toBe('ok');
    // Допуск по бренду отделён от допуска по ИНН: основания разной надёжности.
    expect(result.reason).toBe('brand_verified_website');
    expect(search).not.toHaveBeenCalled();
  });

  it('сайт без ИНН и без совпадения бренда остаётся неподтверждённым', async () => {
    // Порог не «любой открывшийся сайт»: нужен полный бренд в заголовке и
    // география из реестра в тексте. Иначе допуск стал бы бесполезным.
    const result = await run({
      'https://romashka.ru/': page({
        url: 'https://romashka.ru/', title: 'Мебельный склад №1', text: 'Казань, ул. Мира, 5.',
      }),
    }, jest.fn(async () => []));
    expect(result.status).not.toBe('ok');
    expect(result.reason).toBe('website_identity_unverified');
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

  it('бесплатные источники сайта проверяются по владельцу вместо покупки поиска', async () => {
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

    // A reviewed URL repairs a wrong registry URL without buying search. Two
    // own legal entities are allowed only on their reviewed official host.
    const ownInn = '5047186409';
    const hint = vePaymentCompanyHint(ownInn)!;
    const hintHost = new URL(hint.website).hostname;
    const legalHtml = '<html><head><title>Реквизиты компании ООО ПЭЙКИПЕР ПРОЦЕССИНГ</title></head>'
      + '<body><h1>Реквизиты компании</h1><p>ООО ПЭЙКИПЕР ПРОЦЕССИНГ. ИНН 5047186409</p>'
      + '<p>ООО ПЭЙКИПЕР. ИНН 5008053934</p></body></html>';
    expect(parseVeEvidencePage(Buffer.from(legalHtml), hint.website, 'text/html').ownerInns).toEqual([...hint.inns]);
    const merchantCredits = legalHtml.replaceAll('Реквизиты компании', 'Оплата покупок');
    expect(parseVeEvidencePage(Buffer.from(merchantCredits), 'https://merchant.test/credits', 'text/html').ownerInns).toEqual([]);
    const partnerCredits = legalHtml.replaceAll('Реквизиты компании', 'Реквизиты платёжного партнёра');
    expect(parseVeEvidencePage(Buffer.from(partnerCredits), 'https://merchant.test/credits', 'text/html').ownerInns).toEqual([]);
    for (const [owners, expected] of [
      [[...hint.inns], 'ok'], [[ownInn, FOREIGN_INN], 'unavailable'],
      [[hint.inns[1]], 'unavailable'], [[], 'unavailable'],
    ] as const) {
      const paidSearch = jest.fn(async () => []);
      const read = jest.fn(async (url: string) => page({ url,
        // Brand/location cannot replace the required catalogue owner INN.
        title: 'ПЭЙКИПЕР-ПРОЦЕССИНГ', text: 'ПЭЙКИПЕР-ПРОЦЕССИНГ. Москва. Приём онлайн-платежей.',
        ownerInns: new URL(url).hostname === hintHost ? [...owners] : [FOREIGN_INN],
      }));
      const checked = await fetchVeRelevanceEvidence('https://wrong-owner.test/', {
        companyInn: ownInn, companyName: 'ПЭЙКИПЕР-ПРОЦЕССИНГ', companyAddress: 'Москва',
        fetchPage: read, search: paidSearch as never, allowPaidSearch: false, searchCache: async () => [],
      });
      expect(checked.status).toBe(expected);
      expect(paidSearch).not.toHaveBeenCalled();
      expect(checked.pages).toBeLessThanOrEqual(10);
      if (expected === 'ok') expect(new URL(checked.url).hostname).toBe(hintHost);
    }
  });
});

describe('проход добора сайтов', () => {
  it('передаёт почту компании, чтобы её домен попробовали до покупки поиска', async () => {
    // Этот проход работает ровно со строками БЕЗ сайта — и покупал поиск, не
    // попробовав домен их же корпоративной почты.
    const seen: Array<Record<string, unknown>> = [];
    const fetchEvidence = (async (_website: string, options: Record<string, unknown>) => {
      seen.push(options);
      return { status: 'ok' as const, text: 'текст', url: 'https://romashka-mebel.ru/', reason: 'identity_verified_website' };
    }) as unknown as typeof fetchVeRelevanceEvidence;
    const rows = [{ company: 'Ромашка', inn: OUR_INN, address: 'Казань, ул. Мира, 5',
      email: 'info@romashka-mebel.ru', website: '', source_detail: 'реестр' }];
    await recoverVeSourceContacts({ rows, fetchEvidence, save: async () => undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.objectContaining({ companyEmail: 'info@romashka-mebel.ru' }));

    const stale = { ...rows[0], inn: '5047186409', website: 'https://wrong-owner.test/',
      email: 'contact@wrong-owner.test' };
    const repaired = normalizeVeSourceContacts(stale);
    expect(new URL(repaired.website).hostname).toBe('paykeeper.ru');
    expect(repaired.email).toBe('');
    expect(repaired.source_detail).toContain(stale.website);
    expect(repaired.source_detail).toContain(stale.email);
    expect(normalizeVeSourceContacts(repaired)).toEqual(repaired);
    // A payment-service email on a merchant row never identifies the service.
    const merchant = { ...rows[0], inn: '7705401519', email: 'support@mixplat.ru', website: 'https://merchant.test/' };
    expect(normalizeVeSourceContacts(merchant)).toEqual(merchant);
    const fresherFact = { ...repaired, website: 'https://new-official.test/',
      source_detail: `${repaired.source_detail}\n${VE_CONFIRMED_WEBSITE_MARK} https://new-official.test/` };
    expect(normalizeVeSourceContacts(fresherFact)).toEqual(fresherFact);
    expect(stale.email).toBe('contact@wrong-owner.test');
  });
});
