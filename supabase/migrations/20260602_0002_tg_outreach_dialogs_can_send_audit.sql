-- TG Outreach: аудит смены `can_send` на диалогах.
--
-- Контекст. `can_send` ставит сразу несколько источников:
--   1) воркер автоматически (USER_DEACTIVATED, PEER_ID_INVALID,
--      BOT_RESPONSES_DISABLED и т.п.) — `disableDialogIfUnreachable()`,
--   2) кнопка «В чёрный список» в UI — `addBlockedUser()` бьёт UPDATE
--      can_send=false по всем диалогам с этим tg_user_id,
--   3) удаление из ЧС — должно возвращать can_send=true (раньше не
--      возвращало — баг, фиксим в этой же серии правок),
--   4) ручной тумблер в UI на конкретном диалоге.
--
-- Когда оператор видит «Не писать», без аудита нельзя понять, поставил он
-- этот флаг сам, поставил коллега, или Telegram прибил автоматом — и
-- безопасно ли разблокировать. Добавляем три поля на сам диалог:
--
--   * can_send_changed_at  — когда последний раз меняли (NULL = ни разу
--                            с момента дефолта при создании диалога).
--   * can_send_changed_by  — uuid пользователя портала, который явно
--                            переключил. NULL когда переключил воркер
--                            автоматически (см. reason ниже).
--   * can_send_changed_reason
--                          — короткий код источника: 'manual',
--                            'blocklist_add', 'blocklist_remove',
--                            'tg_user_deactivated', 'tg_peer_invalid',
--                            'tg_bot_responses_disabled', и т.п.
--
-- История каждого изменения пишется в существующую `tg_outreach_logs`
-- (один INSERT с уровнем 'info'/'warning' и читаемым текстом), отдельную
-- audit-таблицу не плодим — для частых смен значения это перебор.

alter table public.tg_outreach_dialogs
  add column if not exists can_send_changed_at timestamptz,
  add column if not exists can_send_changed_by uuid references public.profiles(id) on delete set null,
  add column if not exists can_send_changed_reason text;

comment on column public.tg_outreach_dialogs.can_send_changed_at is
  'Когда последний раз менялся can_send. NULL = с момента создания диалога не трогали.';
comment on column public.tg_outreach_dialogs.can_send_changed_by is
  'Пользователь портала, явно переключивший can_send. NULL = переключение сделал воркер автоматически (см. can_send_changed_reason).';
comment on column public.tg_outreach_dialogs.can_send_changed_reason is
  'Источник последнего изменения can_send: manual / blocklist_add / blocklist_remove / tg_user_deactivated / tg_peer_invalid / tg_bot_responses_disabled / и т.п.';
