-- Пробы на контрольные ящики Яндекса, помеченные «не дошло» до перехода на
-- сверку Message-ID по списку писем (lib/sender/seedBoxes.ts → findProbes):
-- поиск сервера по заголовку у Яндекса не находил ни одной пробы, так что
-- «не дошло» здесь не доказано. Возвращаем на проверку — воркер решит заново.
update public.sender_seed_probes p
   set status = 'sent',
       updated_at = now()
  from public.sender_seed_boxes b
 where b.id = p.seed_box_id
   and b.provider = 'yandex'
   and p.status = 'missing'
   and p.message_id is not null
   and p.sent_at >= now() - interval '7 days';
