-- Справочник компаний из xlsx-файлов (папка PortalBazaBaz).
-- Имя companies_directory выбрано чтобы не конфликтовать с
-- существующей public.company_contacts из CIS Lead Finder.

create table if not exists public.companies_directory (
  id bigint generated always as identity primary key,

  name             text,              -- Название
  inn              text,              -- ИНН
  kpp              text,              -- КПП
  address          text,              -- Адрес
  director_last_name   text,          -- Фамилия руководителя
  director_first_name  text,          -- Имя руководителя
  director_middle_name text,          -- Отчество руководителя
  activity_type    text,              -- Вид деятельности
  employees_count  integer,           -- Количество сотрудников
  phones           text,              -- Телефоны
  email            text,              -- email
  revenue          bigint,            -- Выручка
  cost             bigint,            -- Стоимость
  edo_id           text,              -- Идентификатор ЭДО
  okpo             text,              -- ОКПО
  pf_reg_number    text,              -- Рег. номер ПФ
  branch_code      text,              -- Код филиала
  website          text,              -- Сайт
  egais            text,              -- ЕГАИС
  gln              text,              -- GLN
  ogrn             text,              -- ОГРН

  source_file      text,              -- имя файла-источника
  created_at       timestamptz not null default now()
);

create index if not exists idx_companies_directory_inn on public.companies_directory(inn);
create index if not exists idx_companies_directory_ogrn on public.companies_directory(ogrn);
create index if not exists idx_companies_directory_activity on public.companies_directory(activity_type);

alter table public.companies_directory enable row level security;

create policy "service_role_full_access"
  on public.companies_directory
  for all
  using (true)
  with check (true);

create policy "authenticated_read_access"
  on public.companies_directory
  for select
  to authenticated
  using (true);

create policy "anon_read_access"
  on public.companies_directory
  for select
  to anon
  using (true);
