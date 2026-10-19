-- Каталог Яндекс Карт: запрос по выборке 15%% из ~10 млн строк идёт долго;
-- таймаут функции поднят до 3 часов (15.10.2026). Тело функции не меняется.
alter function public.polza_ru_ymaps_catalog_candidates(text, real, integer) set statement_timeout = '3h';
