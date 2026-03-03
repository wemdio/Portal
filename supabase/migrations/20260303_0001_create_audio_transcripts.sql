-- Создание таблицы для хранения истории расшифровок аудио/видео
-- Последние 10 записей по пользователю выбираются на уровне API

create table if not exists public.audio_transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  filename text not null,
  length integer not null,
  text text not null
);

comment on table public.audio_transcripts is 'История расшифровок аудио/видео по пользователям';
comment on column public.audio_transcripts.user_id is 'ID пользователя (profiles.id)';
comment on column public.audio_transcripts.filename is 'Имя исходного файла';
comment on column public.audio_transcripts.length is 'Длина текста расшифровки в символах';

create index if not exists audio_transcripts_user_created_idx
  on public.audio_transcripts (user_id, created_at desc);

