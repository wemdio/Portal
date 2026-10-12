-- ENG («Движок вертикалей», self-serve кабинет app.outreachos.xyz): письма
-- клиенту в ключевые моменты пути — один раз на событие.
--
-- ЗАЧЕМ. После круга S3 клиент нажимает одну кнопку «Launch» и уходит: письма,
-- сбор базы, итоговые письма и запуск идут сами, часами. Без писем он не узнает
-- ни что рынки готовы, ни что отправка началась, ни что что-то ждёт его
-- действия (исследование встало; платная стадия рынка — цепочка писем, проверка
-- контактов, итоговые письма, переписывание писем — упала окончательно; пауза
-- автопилота, которую никто не снял). Решает, КОГДА и КОМУ писать, код
-- app/src/lib/hypothesisEngine/engClientMail.ts (sendHeEngClientNotice — тик
-- автозапуска воркера; runHeEngClientMailScan — проход того же тика раз в
-- минуту); тексты — app/src/lib/email/templates/engClientNotice.ts.
--
-- ЧТО ЗДЕСЬ. he_eng_client_emails — журнал этих писем и их дедуп:
--   dedupe_key      — ключ события (PK): research_ready:<проект>,
--                     research_stopped:<проект>:<последняя research-джоба>,
--                     sending_waiting:<проект>, sending_started:<шаблон>,
--                     action:<код>:<шаблон | база | проект>[:<класс итога>]
--                     (у needs_support классов 'failed' / 'refused' ещё
--                     :<нажатие «Launch», мс> — новое нажатие, новое письмо),
--                     action:autopilot_hold:<проект>:<код паузы>:<номер
--                     эпизода>, action:<код остановки стадии>:<упавшая джоба>;
--   user_id         — получатель (владелец проекта, profiles.id);
--   project_id      — проект события;
--   template_id     — шаблон (рынок) события, если он есть; без FK: шаблон,
--                     снятый «Rewrite letters», остаётся строкой 'failed', а
--                     журнал письма от его судьбы не зависит;
--   ref_id          — второй ориентир события (id базы для collect_stopped,
--                     код паузы кабинета для autopilot_hold, класс итога
--                     автозапуска для needs_support, id research-джобы для
--                     research_stopped, id упавшей джобы для letters_stopped /
--                     final_letters_stopped / check_stopped / rewrite_stopped)
--                     — повтор отправки строит то же письмо;
--   kind / code     — вид письма и код действия (закрытые списки ниже);
--   next_step       — какой следующий шаг называет письмо: 'launch' («Launch»
--                     на шаге 3), 'rewrite' («Rewrite letters»), 'try_again'
--                     («Try again» на шаге 1), 'support', 'team_fix' (отказ,
--                     который чинит команда, — деньги или ключ провайдера:
--                     сначала Support, потом кнопка этой остановки); null —
--                     письмо кнопку не называет. Решается по данным в момент
--                     заявки и читается повтором отправки — повтор называет
--                     ту же кнопку; выключатель отправки аккаунта читается на
--                     каждой попытке, и при выключенной отправке письмо
--                     вместо кнопки, которая откажет, зовёт в Support
--                     (engClientMail, «ВЫКЛЮЧЕННАЯ ОТПРАВКА»);
--   created_at      — когда событие заявлено;
--   last_attempt_at — когда была последняя попытка отправки (она же аренда:
--                     повтор берёт строку условным UPDATE по attempts);
--   sent_at         — когда SMTP-сервер принял письмо; null — ещё нет;
--   attempts        — сколько раз пробовали отправить (не больше 3);
--   closed_at       — только autopilot_hold: когда проход увидел эту паузу
--                     снятой или с другим кодом (эпизод закрыт). Пока null —
--                     пауза того же кода у проекта считается той же, и второго
--                     письма нет; закрыт — следующая такая пауза получает номер
--                     эпизода «закрытых + 1» и своё письмо. Так одна стоящая
--                     пауза, чью метку переписывает каждое «Launch», не даёт
--                     письма после каждого нажатия.
-- Текст ошибки SMTP сюда не пишется — он уходит в лог (application_logs).
--
-- Заблокированному клиенту (отметка he_eng_account_blocks, миграция
-- 20261013_0001, или бан входа) код заявок не создаёт, а неотправленные его
-- строки повтор закрывает без отправки (attempts = 3).
--
-- КАК ЧИТАЕТСЯ. Заявка — insert … on conflict (dedupe_key) do nothing: письмо
-- шлёт только тот, чья вставка прошла; второй вызов того же события получает
-- «дубликат». Удачная отправка ставит sent_at; неудачная оставляет строку, и
-- проход повторяет её (sent_at is null, attempts < 3, последняя попытка
-- старше 10 минут) — частичный индекс ниже держит эту выборку дешёвой.
-- Эпизоды паузы проход читает по project_id (индекс ниже), открытые эпизоды —
-- по code = 'autopilot_hold' и closed_at is null.
--
-- КОД ДО МИГРАЦИИ. Таблицы нет (42P01 / PGRST205) — письма не уходят вовсе
-- (без дедупа не пишем никогда: иначе одно событие — письмо в минуту), одно
-- предупреждение в лог на процесс. Остальной кабинет и автозапуск работают.
--
-- ПРАВА. Только service_role (воркер и роуты Next); anon / authenticated /
-- public отозваны поимённо (линт app/tests/migrations/grants.test.ts). RLS
-- включён без политик.
--
-- ПОРЯДОК ВЫКАТА: миграция до кода или после — без разницы (см. «код до
-- миграции»). Идемпотентна: if not exists, повторяемые revoke / grant /
-- comment. В транзакции.

create table if not exists public.he_eng_client_emails (
  dedupe_key      text primary key check (dedupe_key <> '' and char_length(dedupe_key) <= 300),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  project_id      uuid references public.he_projects(id) on delete cascade,
  template_id     uuid,
  ref_id          text check (ref_id is null or char_length(ref_id) <= 100),
  kind            text not null check (kind in (
                    'research_ready', 'research_stopped', 'sending_waiting', 'sending_started', 'action_needed'
                  )),
  code            text check (code is null or code in (
                    'letters_need_rewrite', 'start_failed', 'needs_support', 'collect_stopped', 'autopilot_hold',
                    'letters_stopped', 'final_letters_stopped', 'check_stopped', 'rewrite_stopped'
                  )),
  next_step       text check (next_step is null or next_step in ('launch', 'rewrite', 'try_again', 'support', 'team_fix')),
  created_at      timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  attempts        integer not null default 0 check (attempts >= 0),
  closed_at       timestamptz,
  constraint he_eng_client_emails_code_shape check ((kind = 'action_needed') = (code is not null)),
  constraint he_eng_client_emails_closed_shape check (closed_at is null or code = 'autopilot_hold')
);

create index if not exists idx_he_eng_client_emails_unsent
  on public.he_eng_client_emails(created_at)
  where sent_at is null;

-- Эпизоды паузы проекта (номер нового эпизода) и каскад удаления проекта.
create index if not exists idx_he_eng_client_emails_project
  on public.he_eng_client_emails(project_id);

comment on table public.he_eng_client_emails is
  'ENG: письма клиенту в ключевые моменты (рынки готовы, отправка началась, исследование или стадия рынка встали, нужно действие) — дедуп по dedupe_key: письмо шлёт только тот, чья вставка прошла; повтор до 3 попыток (engClientMail.ts).';

alter table public.he_eng_client_emails enable row level security;

revoke all privileges on table public.he_eng_client_emails from public, anon, authenticated;
grant all on table public.he_eng_client_emails to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_eng_client_emails to readonly';
  end if;
end $$;
