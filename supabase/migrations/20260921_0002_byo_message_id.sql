-- Свой Message-ID у исходящих BYO-писем.
--
-- До этого заголовок Message-ID проставлял MTA провайдера, и домен в нём не
-- совпадал с доменом в From (например, @checkpolza.online при From: @polzatrust.ru).
-- Для принимающей почты это расхождение — минус к репутации отправителя, а для
-- нас — потерянная связь письма с ответом на него: в client_byo_replies уже
-- лежат message_id и in_reply_to, сопоставлять их было не с чем.
--
-- Теперь идентификатор генерируется порталом ДО отправки и пишется сюда же:
-- если упасть после успешной отправки, письмо уже ушло, и восстановить его
-- идентификатор неоткуда.
alter table public.client_byo_messages
  add column if not exists message_id text;

-- Заголовок письма, на которое отвечаем (для ответов в ту же переписку).
alter table public.client_byo_messages
  add column if not exists in_reply_to text;

-- Поиск письма по идентификатору из входящего ответа.
create index if not exists idx_client_byo_messages_message_id
  on public.client_byo_messages (message_id)
  where message_id is not null;

comment on column public.client_byo_messages.message_id is
  'Message-ID письма, сгенерированный порталом на домене отправителя до отправки. Сопоставляется с client_byo_replies.in_reply_to.';
comment on column public.client_byo_messages.in_reply_to is
  'Message-ID письма, на которое это является ответом, — чтобы письмо уходило в ту же переписку.';
