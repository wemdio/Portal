/** @jest-environment node */

/**
 * Каталоги и агрегаторы вместо официального сайта (аудит 22.09.2026). Карточка
 * компании на справочнике печатает её ИНН и название, поэтому проверка
 * владельца принимала её как «найденный официальный сайт»: 1cont.ru — у 239
 * компаний сразу, hr-vacancycenter.ru — у 106. Из каталога карт так же
 * приходили taplink.cc, vk.link, rusapp.ru и dzen.ru. Хосты и адреса страниц —
 * из памяти фактов прода (ve_company_fact_pages).
 */
import { fetchVeRelevanceEvidence, veOfficialWebsiteCandidates } from '@/lib/verticalEngineV2/relevanceEvidence';
import { normalizeVeSourceContacts } from '@/lib/verticalEngineV2/sourceContacts';
import type { VeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';

const OUR_INN = '3123000001';
const page = (over: Partial<VeEvidencePage> & { url: string }): VeEvidencePage =>
  ({ text: 'Химико-фармацевтическое производство полного цикла.', links: [], inns: [], ...over });
/** Карточка компании на чужом сайте: наш ИНН в реквизитах, наше название в заголовке. */
const card = (url: string) => page({ url, title: 'ООО «Белфарм» — контакты, ИНН ' + OUR_INN,
  text: 'ООО «Белфарм», Белгород. Химико-фармацевтическое производство. ИНН ' + OUR_INN, inns: [OUR_INN], ownerInns: [OUR_INN] });

const AGGREGATORS = [
  'https://1cont.ru/company/belfarm',
  'https://moskva.regtorg.ru/comps/belfarm.htm',
  'https://hr-vacancycenter.ru/company/belfarm',
  'https://kachestvorb.ru/company/belfarm',
  'http://export31.ru/%d1%85%d0%b8%d0%bc%d0%b8%d0%ba%d0%be-%d1%84%d0%b0%d1%80%d0%bc',
  'https://w.minsk.by/articles/85059.html',
];
const LINK_PAGES = ['https://taplink.cc/belfarm', 'https://vk.link/belfarm', 'https://rusapp.ru/app/belfarm', 'https://dzen.ru/belfarm'];

const discover = (results: string[], pages: Record<string, VeEvidencePage>, website = '') => {
  const search = jest.fn(async () => results.map((link) => ({ link, title: '', snippet: '' })));
  const fetchPage = jest.fn(async (url: string) => pages[url] ?? page({ url, text: '' }));
  return { search, fetchPage, result: fetchVeRelevanceEvidence(website, { companyInn: OUR_INN, companyName: 'Белфарм',
    companyAddress: 'Белгород, ул. Победы, 1', focus: 'фармацевтическое производство', fetchPage, search: search as never }) };
};

describe('каталоги и агрегаторы не бывают официальным сайтом', () => {
  it.each(AGGREGATORS)('карточка на %s не принимается как найденный сайт', async (url) => {
    const { result, fetchPage } = discover([url], { [url]: card(url) });
    const evidence = await result;
    expect(evidence.status).not.toBe('ok');
    expect(evidence.reason).toBe('website_search_unverified');
    expect(evidence.text).toBe('');
    // Страницу справочника даже не открываем.
    expect(fetchPage.mock.calls.map(([called]) => called)).not.toContain(url);
  });

  it('настоящий сайт компании в той же выдаче по-прежнему находится', async () => {
    const own = 'https://belfarm-31.ru/';
    const { result } = discover([AGGREGATORS[0], own], { [AGGREGATORS[0]]: card(AGGREGATORS[0]),
      [own]: page({ url: own, title: 'Белфарм', ownerInns: [OUR_INN] }) });
    const evidence = await result;
    expect(evidence).toMatchObject({ status: 'ok', reason: 'discovered_verified_website', url: own });
  });

  it.each(LINK_PAGES)('страница-визитка %s из каталога не считается сайтом компании', async (url) => {
    expect(veOfficialWebsiteCandidates(url)).toEqual([]);
    // Раньше такая страница с брендом и городом давала brand_verified_website без поиска.
    const { result, search, fetchPage } = discover([], { [url]: page({ url, title: 'Белфарм',
      text: 'Белфарм — фармацевтическое производство. Белгород, ул. Победы, 1.' }) }, url);
    const evidence = await result;
    expect(evidence.status).not.toBe('ok');
    expect(fetchPage.mock.calls.map(([called]) => called)).not.toContain(url);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('строка источника хранит такую ссылку в подписи, а не в поле сайта', () => {
    const row = normalizeVeSourceContacts({ company: 'Белфарм', website: 'taplink.cc/belfarm', email: '', inn: OUR_INN,
      address: 'Белгород', source_detail: 'яндекс.карты' });
    expect(row.website).toBe('');
    expect(row.source_detail).toBe('яндекс.карты\nСайт в источнике: taplink.cc/belfarm');
  });

  it('реестровый список запретов (контактная политика) тоже действует', () => {
    for (const url of ['https://www.avito.ru/belgorod/belfarm', 'https://linktr.ee/belfarm', 'https://flamp.ru/firm/belfarm']) {
      expect(veOfficialWebsiteCandidates(url)).toEqual([]);
    }
    expect(veOfficialWebsiteCandidates('belfarm-31.ru').map((url) => url.hostname)).toEqual(['belfarm-31.ru']);
  });
});
