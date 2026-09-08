-- Позиция обхода 2GIS для ежедневного OutreachOS. Не меняет target/cap.
CREATE TABLE IF NOT EXISTS public.outreachos_gis_scan_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  snapshot_id bigint,
  rubric_key text,
  after_id text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.outreachos_gis_scan_state (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.outreachos_gis_scan_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreachos_gis_scan_state_service_role ON public.outreachos_gis_scan_state;
CREATE POLICY outreachos_gis_scan_state_service_role ON public.outreachos_gis_scan_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.outreachos_gis_scan_state FROM public, anon, authenticated;
GRANT ALL ON public.outreachos_gis_scan_state TO service_role, postgres;

COMMENT ON TABLE public.outreachos_gis_scan_state IS
  'Singleton-позиция обхода 2GIS OutreachOS. Worker сохраняет после успешного markSeen; measure-only не продвигает. Смена snapshot_id/rubric_key сбрасывает позицию.';
COMMENT ON COLUMN public.outreachos_gis_scan_state.after_id IS
  'ID последней просмотренной карточки, следующий запрос id > after_id. NULL = начало, включая следующий проход после конца выдачи.';
COMMENT ON COLUMN public.outreachos_gis_scan_state.revision IS
  'Сравнение при UPDATE предотвращает перезапись курсора устаревшим прогоном; не является блокировкой рассылок.';

NOTIFY pgrst, 'reload schema';
