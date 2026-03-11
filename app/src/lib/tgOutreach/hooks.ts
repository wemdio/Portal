'use client';

import { useState, useEffect, useCallback } from 'react';
import { tgOutreachFetch } from './fetcher';
import type { TgOutreachAccount, TgOutreachProxy, TgOutreachTag } from './types';

export function useTgOutreachAccounts() {
  const [accounts, setAccounts] = useState<TgOutreachAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await tgOutreachFetch<{ items: TgOutreachAccount[] }>('/accounts');
      setAccounts(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { accounts, loading, error, reload };
}

export function useTgOutreachProxies() {
  const [proxies, setProxies] = useState<TgOutreachProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await tgOutreachFetch<{ items: TgOutreachProxy[] }>('/proxies');
      setProxies(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load proxies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { proxies, loading, error, reload };
}

export function useTgOutreachTags() {
  const [tags, setTags] = useState<TgOutreachTag[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await tgOutreachFetch<{ items: TgOutreachTag[] }>('/tags');
      setTags(data.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { tags, loading, reload };
}
