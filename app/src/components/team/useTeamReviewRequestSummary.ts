'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeReviewRequestSummary,
  teamApiFetch,
} from './teamApi';

const SUMMARY_POLL_MS = 60_000;

export function useTeamReviewRequestSummary(enabled: boolean) {
  const [newCount, setNewCount] = useState(0);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++requestSequence.current;
    try {
      const payload = await teamApiFetch('/api/team/review-requests/summary');
      if (requestId !== requestSequence.current) return;
      setNewCount(normalizeReviewRequestSummary(payload).newCount);
    } catch {
      // Keep the last confirmed count on a transient refresh failure.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      requestSequence.current += 1;
      // A private count must disappear as soon as the capability is gone.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNewCount(0);
      return;
    }

    void refresh();
    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const pollId = window.setInterval(() => void refresh(), SUMMARY_POLL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      requestSequence.current += 1;
      window.clearInterval(pollId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, refresh]);

  return { newCount, refresh };
}
