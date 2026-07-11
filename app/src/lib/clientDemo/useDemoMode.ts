'use client';

import { useEffect, useState } from 'react';
import { clientApiFetch } from '@/lib/clientFetcher';

/**
 * Хук: true, если под порталом залогинен демо-аккаунт (profiles.is_demo).
 * Возвращает null, пока статус грузится — чтобы баннер не мигал.
 *
 * Один лёгкий запрос к /api/client/demo-status на монтирование.
 */
export function useDemoMode(): boolean | null {
  const [isDemo, setIsDemo] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Таймаут обязателен: страницы гейтят контент на isDemo (null = ничего
        // не рендерим), и зависший — не упавший — запрос оставил бы вкладку
        // вечно пустой (класс инцидента «бесконечная загрузка каталога»).
        const res = await Promise.race([
          clientApiFetch<{ isDemo?: boolean }>('/demo-status'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('demo-status timeout')), 10_000),
          ),
        ]);
        if (!cancelled) setIsDemo(res.isDemo === true);
      } catch {
        // Статус демо — не критичная информация: при сбое считаем «не демо».
        if (!cancelled) setIsDemo(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return isDemo;
}
