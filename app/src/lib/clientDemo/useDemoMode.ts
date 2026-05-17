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
        const res = await clientApiFetch<{ isDemo?: boolean }>('/demo-status');
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
