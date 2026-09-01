/** @jest-environment node */

/**
 * Массовая загрузка прокси: дубли и имена.
 *
 * Дубль прокси — это не лишняя строка в таблице. Портал считает занятость по
 * адресу, и вторая строка с тем же адресом числится свободной: её выдают
 * следующему аккаунту, и два аккаунта уходят в Telegram через один канал пула,
 * то есть с одного устройства. Ровно за это Telegram и блокирует. К моменту
 * правки в базе лежало 598 записей на 532 уникальных адреса — накопилось
 * повторными загрузками одного списка.
 */

import { buildProxyImportRows, proxyDisplayName } from '@/lib/tgOutreach/apiHelpers';

const CAMPAIGN = 'camp-1';
const URL_10000 = 'http://user:pass@mobpool.proxy.market:10000';

describe('массовая загрузка прокси', () => {
  it('не заводит адрес, который уже есть в кампании', () => {
    const { rows, skipped } = buildProxyImportRows(
      [URL_10000, 'http://user:pass@mobpool.proxy.market:10001'],
      [URL_10000],
      CAMPAIGN,
    );
    expect(rows.map((r) => r.url)).toEqual(['http://user:pass@mobpool.proxy.market:10001']);
    expect(skipped).toBe(1);
  });

  it('схлопывает повторы внутри самого списка', () => {
    const { rows, skipped } = buildProxyImportRows([URL_10000, URL_10000, URL_10000], [], CAMPAIGN);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it('узнаёт тот же прокси в другом написании провайдера', () => {
    // Провайдер отдаёт `host:port@user:pass`, а в базе лежит обычный URL.
    // Без нормализации перед сравнением это две разные строки — и один канал
    // достаётся двум аккаунтам.
    const { rows, skipped } = buildProxyImportRows(
      ['mobpool.proxy.market:10000@user:pass'],
      [URL_10000],
      CAMPAIGN,
    );
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('подписывает строку хостом и портом, а не порядковым номером', () => {
    const { rows } = buildProxyImportRows([URL_10000], [], CAMPAIGN);
    expect(rows[0].name).toBe('mobpool.proxy.market:10000');
    expect(proxyDisplayName('http://u:p@103.152.136.70:10140')).toBe('103.152.136.70:10140');
  });
});
