-- Hypothesis Engine (Движок вертикалей): антигонка авто-сборки базы —
-- не больше одной собирающейся auto-базы на вертикаль.
--
-- POST /api/tools/hypothesis-engine/verticals/[id]/collect дедупит запуск
-- проверками «уже собирается?» до insert, но два параллельных POST могут
-- оба пройти проверки и вставить две collecting-базы (двойной расход
-- коллекторов). Partial unique index закрывает гонку на уровне БД:
-- проигравший insert получает 23505, а роут мапит его в тот же ответ 200
-- с уже существующей базой, что и обычный дедуп.
--
-- Покрывает только source='auto' и status='collecting': failed/analyzed
-- auto-базы и ручные upload-базы параллельно существовать могут.
-- Grant'ы не нужны — меняется только индекс.

create unique index if not exists he_bases_one_collecting_per_vertical
  on public.he_bases (vertical_id)
  where source = 'auto' and status = 'collecting';
