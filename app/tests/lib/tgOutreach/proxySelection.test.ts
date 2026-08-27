/** @jest-environment node */

/**
 * Выбор прокси для аккаунта.
 *
 * Для Telegram один адрес прокси — это одно устройство, и два аккаунта на нём
 * читаются как один человек с двух телефонов. Поэтому цена ошибки здесь не
 * «неудобно», а «аккаунт забанят»: занятый прокси не должен попадать в список
 * ни при каких условиях.
 *
 * Тесты повторяют две поломки, найденные на боевых данных 27.08.2026, — обе
 * были невидимы, пока считали по id строки внутри одной кампании.
 */

import {
  proxyUrlKey,
  takenProxyUrls,
  selectableProxies,
  proxyOptionsFor,
} from '@/lib/tgOutreach/proxySelection';

const proxy = (id: string, url: string) => ({ id, url });

describe('proxyUrlKey', () => {
  it('одинаковый адрес в разных написаниях даёт один ключ', () => {
    const expected = 'mobpool.proxy.market:10027';
    expect(proxyUrlKey('http://mobpool.proxy.market:10027')).toBe(expected);
    expect(proxyUrlKey('MOBPOOL.PROXY.MARKET:10027')).toBe(expected);
    expect(proxyUrlKey(' socks5://mobpool.proxy.market:10027/ ')).toBe(expected);
  });

  it('пустой адрес — пустой ключ, а не совпадение со всем подряд', () => {
    expect(proxyUrlKey('')).toBe('');
    expect(proxyUrlKey(null)).toBe('');
  });
});

describe('selectableProxies', () => {
  it('две строки одного адреса схлопываются в одну', () => {
    /**
     * Боевой случай: в кампании Polza_test один и тот же адрес заведён дважды
     * разными строками. Оператор назначал первую, вторая оставалась
     * «свободной» и тут же предлагалась следующему аккаунту — тот же прокси
     * под другим id.
     */
    const list = [
      proxy('p1', 'http://mobpool.proxy.market:10112'),
      proxy('p2', 'http://mobpool.proxy.market:10112'),
      proxy('p3', 'http://mobpool.proxy.market:10113'),
    ];
    expect(selectableProxies(list, new Set()).map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('занятый адрес не предлагается, даже если строка другая', () => {
    const list = [
      proxy('p1', 'http://mobpool.proxy.market:10027'),
      proxy('p2', 'http://mobpool.proxy.market:10028'),
    ];
    const taken = new Set([proxyUrlKey('http://MOBPOOL.proxy.market:10027')]);
    expect(selectableProxies(list, taken).map((p) => p.id)).toEqual(['p2']);
  });

  it('строка без адреса в список не попадает', () => {
    expect(selectableProxies([proxy('p1', '   ')], new Set())).toEqual([]);
  });

  it('порядок сохраняется — он по дате добавления и осмыслен', () => {
    const list = [proxy('a', 'h1'), proxy('b', 'h2'), proxy('c', 'h3')];
    expect(selectableProxies(list, new Set()).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('takenProxyUrls', () => {
  it('учитывает занятость в других кампаниях', () => {
    // 66 адресов заведены сразу в двух кампаниях: занятый в соседней раньше
    // числился здесь свободным.
    const taken = takenProxyUrls({
      serverTakenUrls: ['http://mobpool.proxy.market:10027'],
      accounts: [],
      proxies: [proxy('p1', 'http://mobpool.proxy.market:10027')],
    });
    expect(taken.has(proxyUrlKey('http://mobpool.proxy.market:10027'))).toBe(true);
  });

  it('учитывает то, что назначено прямо сейчас, до перезагрузки списка', () => {
    /**
     * Ровно жалоба оператора: назначил прокси одному аккаунту и сразу открыл
     * следующий — тот же прокси предлагался снова, потому что с сервера список
     * ещё не перечитали.
     */
    const proxies = [
      proxy('p1', 'http://mobpool.proxy.market:10027'),
      proxy('p2', 'http://mobpool.proxy.market:10028'),
    ];
    const taken = takenProxyUrls({
      serverTakenUrls: [],
      accounts: [{ proxy_id: 'p1' }, { proxy_id: null }],
      proxies,
    });
    expect(selectableProxies(proxies, taken).map((p) => p.id)).toEqual(['p2']);
  });

  it('аккаунт без прокси ничего не занимает', () => {
    const taken = takenProxyUrls({
      serverTakenUrls: [],
      accounts: [{ proxy_id: null }, {}],
      proxies: [proxy('p1', 'h1')],
    });
    expect(taken.size).toBe(0);
  });
});

describe('proxyOptionsFor', () => {
  it('свой прокси остаётся в списке, хотя он занят', () => {
    // Иначе открытая выпадашка выглядит как «прокси сбросился».
    const proxies = [proxy('p1', 'h1'), proxy('p2', 'h2')];
    const free = [proxy('p2', 'h2')];
    expect(proxyOptionsFor('p1', proxies, free).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('свой прокси не дублируется, если он и так свободен', () => {
    const proxies = [proxy('p1', 'h1')];
    const free = [proxy('p1', 'h1')];
    expect(proxyOptionsFor('p1', proxies, free).map((p) => p.id)).toEqual(['p1']);
  });

  it('у аккаунта без прокси — только свободные', () => {
    const proxies = [proxy('p1', 'h1')];
    expect(proxyOptionsFor(null, proxies, []).length).toBe(0);
  });
});
