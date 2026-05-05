-- Таблица для хранения контактных баз компаний,
-- импортированных из xlsx-файлов (папка PortalBazaBaz).

create table if not exists public.company_contacts (
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

create index if not exists idx_company_contacts_inn on public.company_contacts(inn);
create index if not exists idx_company_contacts_ogrn on public.company_contacts(ogrn);
create index if not exists idx_company_contacts_activity on public.company_contacts(activity_type);

alter table public.company_contacts enable row level security;

create policy "service_role_full_access"
  on public.company_contacts
  for all
  using (true)
  with check (true);
