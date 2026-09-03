-- Уборка ручного скоринга не должна удалять прогон из-под живого исполнителя.
--
-- cleanup_expired_manual_score_runs (миграция 20260526_0013) удаляет прогоны с
-- истёкшим 30-дневным сроком хранения. До переезда очереди на единый жизненный
-- цикл это было безопасно только по стечению обстоятельств: чистка звалась один
-- раз при старте воркера, когда он ещё ничего не держал.
--
-- Теперь чистка идёт периодически, рядом с опросом очереди
-- (app/worker/manualScoringWorker.ts, maybeCleanupExpiredRuns), то есть при
-- живом исполнителе. Прогон, который висит в работе дольше тридцати дней, —
-- случай редкий, но именно такой прогон и удалялся бы: DELETE не смотрел ни на
-- статус, ни на владельца, а каскад по client_manual_score_rows унёс бы вместе
-- со строкой и все результаты, за которые уже заплачено. Владелец при этом
-- продолжал бы работать: ограждение жетоном ловит перехват, а не исчезновение
-- строки.
--
-- Условие «аренды нет ИЛИ она истекла», а не просто «аренды нет»: строка, у
-- которой терминальная запись не легла (сеть моргнула ровно на ней), остаётся с
-- непустым lease_until навсегда, и предикат по одному только is null исключил
-- бы её из уборки уже насовсем. Истёкшую аренду никто не держит по определению
-- — библиотека судит о брошенности ровно по этому признаку.
--
-- Остальное поведение прежнее: возвращает число удалённых строк, SECURITY
-- DEFINER, права те же (CREATE OR REPLACE их не сбрасывает).
CREATE OR REPLACE FUNCTION public.cleanup_expired_manual_score_runs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.client_manual_score_runs
   WHERE expires_at < now()
     AND (lease_until IS NULL OR lease_until < now());
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_manual_score_runs() TO service_role;
