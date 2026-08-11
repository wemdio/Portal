/** @jest-environment node */

/**
 * Страж «цикл опроса не залипает на фоновом обходе».
 *
 * `worker/yandexmaps.ts` при импорте запускает воркер, поэтому `pollOnce`
 * не подёргать напрямую — проверяем исходник.
 *
 * Что ловим: обход каталога — это живой поиск по Яндексу, до 250 ссылок выдачи
 * плюс карточки всех новых организаций, то есть минуты. Пока он вызывался под
 * `await` внутри `pollOnce`, цикл на нём стоял, и пользовательская задача,
 * пришедшая секундой позже, ждала окончания обхода: realtime исправно будил
 * цикл, а цикл был занят. 10.08.2026 это дало две минуты ожидания на пустой
 * очереди.
 */

import fs from 'node:fs';
import path from 'node:path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'worker', 'yandexmaps.ts'),
  'utf8',
);

function pollOnceBody(): string {
  const start = SOURCE.indexOf('async function pollOnce(');
  expect(start).toBeGreaterThan(-1);
  const next = SOURCE.indexOf('\nasync function ', start + 1);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe('yandexmaps worker: фоновый обход не блокирует цикл опроса', () => {
  it('pollOnce не ждёт обход каталога', () => {
    const body = pollOnceBody();
    expect(body).not.toMatch(/await\s+runYandexMapsCatalogDiscoveryBatch/);
    expect(body).not.toMatch(/return\s+runYandexMapsCatalogDiscoveryBatch/);
  });

  it('обход запускается в фоне и по одному за раз', () => {
    expect(pollOnceBody()).toContain('startCatalogDiscovery()');
    // Защёлка: без неё каждое пробуждение цикла плодило бы новый обход.
    expect(SOURCE).toMatch(/function startCatalogDiscovery[\s\S]*?if \(discoveryTask\) return;/);
    expect(SOURCE).toMatch(/discoveryTask = null/);
  });

  it('новый обход не начинается, пока идут пользовательские задачи', () => {
    // Приоритет пользовательских задач был и раньше — важно, что он остался
    // после переноса обхода в фон.
    expect(pollOnceBody()).toMatch(/if \(runningJobs\.size === 0\) startCatalogDiscovery\(\);/);
  });
});
