-- Task boards (Trello-like)
CREATE TABLE IF NOT EXISTS public.task_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_boards_position ON public.task_boards(position);
ALTER TABLE public.task_boards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "task_boards_all" ON public.task_boards FOR ALL USING (true) WITH CHECK (true);

-- Columns within a board
CREATE TABLE IF NOT EXISTS public.task_board_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES public.task_boards(id) ON DELETE CASCADE,
  title text NOT NULL,
  position int NOT NULL DEFAULT 0,
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_board_columns_board_id ON public.task_board_columns(board_id);
ALTER TABLE public.task_board_columns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "task_board_columns_all" ON public.task_board_columns FOR ALL USING (true) WITH CHECK (true);

-- Link tasks to board/column
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES public.task_boards(id) ON DELETE SET NULL;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS column_id uuid REFERENCES public.task_board_columns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_board_id ON public.tasks(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_column_id ON public.tasks(column_id);

-- Seed default board with three columns (id is PK, so ON CONFLICT (id) works)
INSERT INTO public.task_boards (id, name, is_default, position)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Основная',
  true,
  0
)
ON CONFLICT (id) DO NOTHING;

-- Use fixed UUIDs for default columns so backfill can reference them
INSERT INTO public.task_board_columns (id, board_id, title, position, status) VALUES
  ('00000000-0000-0000-0001-000000000001'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'Ожидает', 0, 'pending'),
  ('00000000-0000-0000-0001-000000000002'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'В работе', 1, 'in_progress'),
  ('00000000-0000-0000-0001-000000000003'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'Завершено', 2, 'done')
ON CONFLICT (id) DO NOTHING;

-- Backfill: set board_id and column_id for existing tasks by status
UPDATE public.tasks t
SET
  board_id = '00000000-0000-0000-0000-000000000001'::uuid,
  column_id = CASE t.status
    WHEN 'pending' THEN '00000000-0000-0000-0001-000000000001'::uuid
    WHEN 'in_progress' THEN '00000000-0000-0000-0001-000000000002'::uuid
    WHEN 'done' THEN '00000000-0000-0000-0001-000000000003'::uuid
    ELSE '00000000-0000-0000-0001-000000000001'::uuid
  END
WHERE t.board_id IS NULL
  AND t.column_id IS NULL;
