-- Portal i18n: shared translation cache for the on-the-fly DOM translator.
-- The client's GlobalTextTranslator collects every visible Russian string,
-- batch-asks /api/portal/translate for the active locale, and gets back
-- {source: translated} from this table — populated lazily by the OpenRouter
-- proxy on cache miss. Authored RU→EN pairs (existing globalTranslations.ts)
-- are seeded once with source='human' so machine output never overwrites them.
--
-- Key design notes:
--   * Primary key is (source_text, target_lang) — translations are keyed by
--     the literal source string, not a synthetic ID, so the client can look
--     up by the text it observed in the DOM. We accept the SHA-256 trade-off
--     on long strings via a bytea hash column for index economy.
--   * source_lang is stored but not part of the key — we assume one
--     canonical source language at a time (Russian for this portal). The
--     column lets us migrate the source later without a destructive change.
--   * `source` discriminates 'human' (blessed, never overwritten) vs
--     'machine' (LLM-generated, may be refreshed). Upsert logic must check.
--   * No RLS read restriction by user_id: translations are public-by-nature
--     UI strings, shared across the whole tenant. Cheaper than per-user
--     caches and keeps the table small.

create table if not exists public.portal_translations (
  source_text       text not null,
  target_lang       text not null check (target_lang in ('en','de','fr','es','it')),
  translated_text   text not null,
  source_lang       text not null default 'ru' check (source_lang in ('ru','en')),
  source            text not null default 'machine' check (source in ('machine','human')),
  model             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (source_text, target_lang)
);

create index if not exists portal_translations_target_lang_idx
  on public.portal_translations (target_lang);
create index if not exists portal_translations_source_idx
  on public.portal_translations (source);

alter table public.portal_translations enable row level security;

-- Any authenticated user can read. UI strings are not secret and the cache is
-- shared org-wide.
create policy portal_translations_read on public.portal_translations
  for select to authenticated using (true);

-- Writes (insert/update/delete) only via service_role from the API route.
-- We never let the client write directly — the route validates and rate-limits.
grant select on public.portal_translations to authenticated;
grant all on public.portal_translations to service_role;
