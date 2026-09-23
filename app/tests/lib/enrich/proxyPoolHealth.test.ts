/** @jest-environment node */

/**
 * Выбывание нод общего пула прокси. 23.09 нода 141.133.56.12 закрывала
 * CONNECT без ответа, а часть нод лежала вместе с сервером 144.31.54.166:
 * такие ноды пул продолжал выдавать по кругу. Теперь нода, трижды подряд не
 * пустившая в туннель по своей вине, пропускается; ответ ноды (даже 502 —
 * это голос сайта за ней) возвращает её в строй.
 */
import {
  getProxyGroups, hasLiveProxy, pickNonPriorityProxyUrl, pickProxyUrl, proxyPoolHealth,
  reportProxyNodeResult, resetProxyGroupsCache, resetProxyNodeHealth,
} from '@/lib/enrich/proxyPool';

// Адреса условные (TEST-NET), логин и пароль — заглушки.
const RU = ['http://user:pass@203.0.113.10:62780', 'http://user:pass@203.0.113.11:62780', 'http://user:pass@203.0.113.12:62780'];
const OTHER = ['http://user:pass@198.51.100.1:8000', 'http://user:pass@198.51.100.2:8000'];
const PROXY_ENV = ['YANDEXMAPS_PROXY_URLS_PRIORITY', 'YANDEXMAPS_PROXY_URLS', 'PROXY_URLS'] as const;
const originalEnv = Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]]));
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  for (const name of PROXY_ENV) delete process.env[name];
  process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify(RU);
  // Как на проде: в общем списке есть и RU-ноды.
  process.env.YANDEXMAPS_PROXY_URLS = JSON.stringify([...RU, ...OTHER]);
  resetProxyGroupsCache();
  resetProxyNodeHealth();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  warn.mockRestore();
  resetProxyNodeHealth();
  for (const name of PROXY_ENV) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  resetProxyGroupsCache();
});

const picks = (n: number, pick = () => pickProxyUrl(true)) => new Set(Array.from({ length: n }, pick));
const down = (url: string, times = 3, code = 'UND_ERR_SOCKET') => {
  for (let i = 0; i < times; i += 1) reportProxyNodeResult(url, 'down', code);
};

describe('выбывание ноды', () => {
  it('три отказа подряд: нода выбывает на 60 с, пул обходит её, потом возвращает', () => {
    expect(picks(6)).toEqual(new Set(RU));
    down(RU[1], 2);
    expect(picks(6)).toEqual(new Set(RU));
    down(RU[1], 1);
    expect(picks(9)).toEqual(new Set([RU[0], RU[2]]));
    expect(proxyPoolHealth()).toEqual({ priorityOut: [2] });
    // Одна строка в журнал: номер ноды, срок и причина, без адреса и пароля.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[proxyPool] RU-прокси №2 выбыл на 60 с: 3 отказа соединения подряд (UND_ERR_SOCKET)');
    jest.advanceTimersByTime(59_000);
    expect(picks(6)).not.toContain(RU[1]);
    jest.advanceTimersByTime(1_001);
    expect(picks(6)).toContain(RU[1]);
    expect(proxyPoolHealth()).toEqual({ priorityOut: [] });
  });

  it('отказ сразу после возврата выводит ноду снова на вдвое больший срок, до 15 мин', () => {
    down(RU[0]);
    const expected = [120, 240, 480, 900, 900];
    for (const seconds of expected) {
      jest.advanceTimersByTime(15 * 60_000);
      expect(proxyPoolHealth().priorityOut).toEqual([]);
      down(RU[0], 1);
      expect(proxyPoolHealth().priorityOut).toEqual([1]);
      expect(warn.mock.calls.at(-1)?.[0]).toContain(`выбыл на ${seconds} с`);
      jest.advanceTimersByTime(seconds * 1_000 - 1);
      expect(proxyPoolHealth().priorityOut).toEqual([1]);
      jest.advanceTimersByTime(1);
    }
  });

  it('любой ответ ноды обнуляет счёт и удвоение, в том числе 502', () => {
    down(RU[2], 2);
    reportProxyNodeResult(RU[2], 'answered', '502');
    down(RU[2], 2);
    expect(proxyPoolHealth().priorityOut).toEqual([]);
    down(RU[2], 1);
    expect(proxyPoolHealth().priorityOut).toEqual([3]);
    jest.advanceTimersByTime(60_000);
    reportProxyNodeResult(RU[2], 'answered', '200');
    // После ответа одного отказа мало: снова нужны три подряд.
    down(RU[2], 2);
    expect(proxyPoolHealth().priorityOut).toEqual([]);
  });

  it('ответ ноды, пока она выбыла, возвращает её сразу', () => {
    down(RU[0]);
    expect(proxyPoolHealth().priorityOut).toEqual([1]);
    reportProxyNodeResult(RU[0], 'answered', '200');
    expect(proxyPoolHealth().priorityOut).toEqual([]);
  });

  it('поздние отказы соединений, начатых до выбывания, срок не продлевают', () => {
    down(RU[0]);
    jest.advanceTimersByTime(30_000);
    down(RU[0], 5);
    jest.advanceTimersByTime(30_000);
    expect(proxyPoolHealth().priorityOut).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('407: нода сразу выбывает на 15 мин', () => {
    // Шесть параллельных CONNECT получили 407 — одна строка в журнал.
    for (let i = 0; i < 6; i += 1) reportProxyNodeResult(RU[1], 'auth', '407');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(proxyPoolHealth().priorityOut).toEqual([2]);
    expect(warn.mock.calls[0][0]).toBe('[proxyPool] RU-прокси №2 выбыл на 900 с: не принял логин и пароль (407)');
    jest.advanceTimersByTime(15 * 60_000 - 1);
    expect(proxyPoolHealth().priorityOut).toEqual([2]);
    jest.advanceTimersByTime(1);
    expect(proxyPoolHealth().priorityOut).toEqual([]);
  });
});

describe('все RU-ноды выбыли', () => {
  it('pickProxyUrl(true) отдаёт пустую строку, hasLiveProxy — false; запасная группа работает', () => {
    for (const url of RU) down(url);
    expect(pickProxyUrl(true)).toBe('');
    expect(hasLiveProxy(true)).toBe(false);
    expect(proxyPoolHealth()).toEqual({ priorityOut: [1, 2, 3] });
    // Запасная группа (YANDEXMAPS_PROXY_URLS) тоже без выбывших RU-нод.
    expect(picks(8, () => pickProxyUrl(false))).toEqual(new Set(OTHER));
    expect(hasLiveProxy(false)).toBe(true);
  });

  it('без запасной группы повтор тоже не идёт на выбывшие ноды', () => {
    delete process.env.YANDEXMAPS_PROXY_URLS;
    resetProxyGroupsCache();
    down(RU[0]);
    expect(picks(6, () => pickProxyUrl(false))).toEqual(new Set([RU[1], RU[2]]));
    down(RU[1]);
    down(RU[2]);
    expect(pickProxyUrl(false)).toBe('');
    expect(hasLiveProxy(false)).toBe(false);
  });
});

describe('нода из другой подсети', () => {
  it('pickNonPriorityProxyUrl пропускает выбывшие', () => {
    down(OTHER[0]);
    expect(picks(4, pickNonPriorityProxyUrl)).toEqual(new Set([OTHER[1]]));
    expect(warn.mock.calls[0][0]).toBe('[proxyPool] Прокси №4 запасной группы выбыл на 60 с: 3 отказа соединения подряд (UND_ERR_SOCKET)');
    down(OTHER[1]);
    expect(pickNonPriorityProxyUrl()).toBe('');
  });
});

describe('снимок здоровья', () => {
  it('без логинов, паролей и адресов', () => {
    down(RU[1]);
    down(OTHER[0]);
    const snapshot = JSON.stringify(proxyPoolHealth());
    expect(snapshot).toBe('{"priorityOut":[2]}');
    for (const call of warn.mock.calls) expect(String(call[0])).not.toMatch(/user|pass|203\.0\.113|198\.51\.100|:\d{4,5}/);
    expect(getProxyGroups().priority).toEqual(RU);
  });
});
