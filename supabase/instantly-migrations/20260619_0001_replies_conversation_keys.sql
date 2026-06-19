-- «Отвечено» устойчивое к окну top-100/кампанию.
--
-- Зачем: /replies тянет 100 свежих ВХОДЯЩИХ на кампанию и считал is_answered
-- только по email_id'ам, попавшим в это окно. На объёмной кампании старое
-- отвеченное письмо выпадает из окна → «Отвечено» слетает, хотя строка в
-- client_email_replies есть. Делаем «отвечено» свойством ПЕРЕПИСКИ (лида), как
-- applyLeadMarks считает is_lead по (campaign_id, lead_email): добавляем эти
-- ключи и считаем по ним. Колонки nullable: легаси-строки (в т.ч. бэкофилл,
-- писавший только email_id) остаются NULL и ловятся фолбэком по email_id (они в
-- окне); новые ответы пишут ключи переписки. См. applyRepliedMarks /
-- getAnsweredLeadKeys / recordEmailReplied.

alter table public.client_email_replies add column if not exists campaign_id text;
alter table public.client_email_replies add column if not exists lead_email text;

create index if not exists client_email_replies_conv_idx
  on public.client_email_replies (client_user_id, campaign_id, lead_email);
