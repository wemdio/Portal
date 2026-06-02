-- Large-file scoring, part 2: resumable parse cursor.
--
-- parse_offset — сколько строк файла уже прочитано и поставлено в очередь
-- large_score_domains. Если воркер убили посреди парсинга 6 млн строк, при
-- старте он перечитывает файл из S3, пропускает первые parse_offset строк и
-- продолжает. Дедуп всё равно страхует (uq_large_score_domains_job_domain +
-- ON CONFLICT DO NOTHING), offset просто экономит повторную вставку.

ALTER TABLE public.large_score_jobs
  ADD COLUMN IF NOT EXISTS parse_offset bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.large_score_jobs.parse_offset IS
  'Сколько строк файла уже обработано парсером (resumable-курсор стрим-парсинга из S3).';
