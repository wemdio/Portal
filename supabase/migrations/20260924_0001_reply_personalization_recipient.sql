-- «Персонализированные ответы»: письмо может уйти не тому, кто ответил.
--
-- Адресат пишет «по этому вопросу — к Екатерине, почта ...»: ответ ему самому
-- ничего не даёт, писать нужно новому контакту. recipient_email — кому
-- адресован черновик и кому ушло письмо. null — тому же, кто ответил
-- (lead_email), как было у всех строк до этой миграции.

alter table public.reply_personalization_drafts
  add column if not exists recipient_email text;

comment on column public.reply_personalization_drafts.recipient_email is
  'Кому адресован ответ, если не lead_email: новый контакт, на которого перенаправил адресат. null — ответ в ту же переписку.';
