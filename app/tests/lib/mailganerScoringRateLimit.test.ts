// Предохранители Mailganer rate-limiter'а: он может только ЗАДЕРЖАТЬ/пропустить
// домен, но никогда не должен молча сломать скоринг. Алгоритм бакета
// (refill/waitSeconds/computeSleepMs) покрыт rateLimiterMath.test; здесь —
// fail-open ветки TS-обёртки. supabaseAdmin мокаем как null → детерминированно.
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));

import { acquireMailganerScoreToken } from '@/lib/jobs/mailganerScoringRateLimit';

describe('acquireMailganerScoreToken — предохранители', () => {
  const prev = process.env.MAILGANER_SCORING_RATE_LIMIT_DISABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.MAILGANER_SCORING_RATE_LIMIT_DISABLED;
    else process.env.MAILGANER_SCORING_RATE_LIMIT_DISABLED = prev;
  });

  it('kill-switch MAILGANER_SCORING_RATE_LIMIT_DISABLED=1 → пропускает (true)', async () => {
    process.env.MAILGANER_SCORING_RATE_LIMIT_DISABLED = '1';
    await expect(acquireMailganerScoreToken()).resolves.toBe(true);
  });

  it('нет supabaseAdmin (не сконфигурён / тесты) → fail-open (true)', async () => {
    delete process.env.MAILGANER_SCORING_RATE_LIMIT_DISABLED;
    await expect(acquireMailganerScoreToken()).resolves.toBe(true);
  });
});
