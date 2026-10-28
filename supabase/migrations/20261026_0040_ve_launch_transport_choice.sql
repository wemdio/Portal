-- «Рассылка» для Движка вертикалей: специалист выбирает способ отправки при
-- запуске гипотезы (этап 7, решение владельца 26.10.2026).
--
-- Новый режим рынка 'choice': при запуске гипотезы специалист выбирает
-- «Instantly» или «Рассылка», по умолчанию Instantly. Включает его
-- администратор на панели Движка («Разрешить выбор «Рассылки»»), только для
-- РФ; «Новые запуски — только Instantly» его выключает и помнит
-- (mode_before_stop), «Вернуть как было» — возвращает.
-- США — только Instantly: это проверка строки, а не только кода.
--
-- Сама миграция ничего не включает: оба рынка остаются 'instantly'.

set local lock_timeout = '5s';

alter table public.ve_launch_transport_settings
  drop constraint if exists ve_launch_transport_settings_mode_check;
alter table public.ve_launch_transport_settings
  add constraint ve_launch_transport_settings_mode_check
  check (mode in ('instantly', 'pilot', 'sender', 'choice'));

alter table public.ve_launch_transport_settings
  drop constraint if exists ve_launch_transport_settings_mode_before_stop_check;
alter table public.ve_launch_transport_settings
  add constraint ve_launch_transport_settings_mode_before_stop_check
  check (mode_before_stop is null or mode_before_stop in ('pilot', 'sender', 'choice'));

alter table public.ve_launch_transport_settings
  drop constraint if exists ve_launch_transport_settings_us_instantly_check;
alter table public.ve_launch_transport_settings
  add constraint ve_launch_transport_settings_us_instantly_check
  check (market <> 'us' or (mode = 'instantly' and mode_before_stop is null));

-- Проверка с другим именем на mode пропустила бы drop выше, и 'choice' всё равно
-- отклонялся бы — «Разрешить выбор» падал бы позже. Падаем сразу.
do $$
begin
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.ve_launch_transport_settings'::regclass and c.contype = 'c'
       and c.conname not in ('ve_launch_transport_settings_market_check', 've_launch_transport_settings_mode_check',
                             've_launch_transport_settings_mode_before_stop_check', 've_launch_transport_settings_us_instantly_check')
       and pg_get_constraintdef(c.oid) like '%mode%'
  ) then
    raise exception 've_launch_transport_settings has an unexpected check on mode; choice would still be refused';
  end if;
end;
$$;

comment on table public.ve_launch_transport_settings is
  'VE2 launch transport per market: instantly (kill switch: only Instantly), choice (the specialist chooses Instantly or sender at launch, default Instantly), pilot (sender allowed only for projects overridden to sender), sender (sender allowed for all but projects overridden to instantly). US is Instantly only.';
