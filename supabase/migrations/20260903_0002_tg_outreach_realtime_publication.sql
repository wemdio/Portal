-- Realtime-публикация для очередей TG-аутрича: прогоны прогрева и команды.
--
-- Что нашлось. Воркер portal-worker-tg-outreach подписывается на
-- tg_outreach_jobs через Realtime с самого своего появления (pollLoop в
-- app/worker/_shared.ts), но НИ ОДНА миграция в дереве не добавляла эту
-- таблицу в публикацию supabase_realtime — в отличие от семи других очередей,
-- которые это делают явно (application_logs, trace_spans, hh_archive_jobs,
-- yandex_direct_jobs, he_jobs, ve_jobs, inn_enrich_jobs, website_inn_lookup_
-- jobs). Значит одно из двух: публикация на этой установке создана FOR ALL
-- TABLES и подписка работает, либо канал давно и молча деградировал до
-- запасного опроса раз в 30 секунд. Проверять это на бою (задача сюда не
-- уполномочена) не требуется: миграция ниже верна в обоих случаях.
--
-- Почему это стало важно именно сейчас. Задача 1 этапа 3 добавила в тот же
-- канал вторую таблицу — tg_outreach_warmup_runs: интерфейс создаёт строку
-- прогона в статусе pending, и опрос должен просыпаться на неё сразу. Канал у
-- реплики один на обе таблицы, и если join по одной из них не проходит, весь
-- канал уходит в CHANNEL_ERROR — вместе с существующим пробуждением по
-- командам оператора «стоп» и «рестарт». Тогда нажатая кнопка «Стоп» ждала бы
-- до 30 секунд вместо мгновенной реакции. Дешевле привести публикацию в
-- заведомо известное состояние, чем полагаться на её текущий вид.
--
-- Форма — как у precedent-миграций (20260824_0001 и соседи): ничего не делаем,
-- если публикации нет вовсе (локальный dev без Realtime) или таблица уже в
-- ней. Второе условие заодно закрывает случай FOR ALL TABLES: такая публикация
-- перечисляет все таблицы в pg_publication_tables, ветка не выполнится, и
-- ошибки «publication is defined as FOR ALL TABLES» не будет.
--
-- Идемпотентно, повторный прогон ничего не меняет.
do $$
declare
  t text;
  tables text[] := array['tg_outreach_warmup_runs', 'tg_outreach_jobs'];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
