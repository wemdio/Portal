-- Ручной скоринг: сырое название, взятое с сайта (og:site_name / <title>) во
-- время скрейпа email. Используется как фоллбек, когда в базе ФНС нет названия
-- для домена. Цепочка резолва имени: ФНС-кэш → scraped_name → из домена →
-- затем AI-чистка (как кнопка «Очистить названия») → company_name.

ALTER TABLE public.client_manual_score_rows
  ADD COLUMN IF NOT EXISTS scraped_name text;

COMMENT ON COLUMN public.client_manual_score_rows.scraped_name IS
  'Сырое название компании, снятое с сайта (og:site_name/<title>) при скрейпе. Фоллбек для company_name, когда домена/имени нет в базе ФНС.';
