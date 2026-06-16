create index if not exists idx_eng_hiring_cache_source_country_published
  on public.eng_hiring_cache(source, country_code, published_at desc);
