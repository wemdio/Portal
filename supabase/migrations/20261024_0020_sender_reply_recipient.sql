-- «Кому» в «Письмах» Рассылки, как в «Персонализированных ответах»: адресат
-- пишет «по этому вопросу — к Екатерине, ekaterina@...», и ответ уходит ей
-- новым письмом или лиду с ней в копии.

-- Под кого написан черновик ИИ: после смены адресата экран просит
-- перегенерировать текст. null — ответ лиду в ту же переписку.
alter table public.sender_reply_drafts
  add column if not exists recipient_email text,
  add column if not exists cc_emails text[] not null default '{}';

-- Ответ нового контакта на наше письмо ему приходит с In-Reply-To на ручное
-- письмо, а не на шаг цепочки: по этому ключу воркер ответов находит переписку.
create index if not exists idx_sender_manual_messages_message_id
  on public.sender_manual_messages (message_id);
