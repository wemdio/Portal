import { z } from 'zod';

/**
 * Границы лимитов ключа — одни и те же при выдаче и при правке выданного
 * ключа: иначе правкой можно было бы поставить то, что выдача не пускает.
 */
export const benchLimitsSchema = z.object({
  rpm_limit: z.number().int().min(1).max(10_000),
  daily_jobs_limit: z.number().int().min(0).max(100_000),
  daily_rows_limit: z.number().int().min(0).max(50_000_000),
  max_active_jobs: z.number().int().min(1).max(50),
});
