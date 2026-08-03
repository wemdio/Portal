-- TG Outreach: degraded-детектор считает РАЗНЫЕ прокси, а не любые ошибки.
--
-- Инцидент 03.08.2026, кампания TG_VBI. За неделю 11 из 17 аккаунтов получили
-- degraded с текстом «3 разных прокси подряд не помогли», хотя proxy_id у них
-- не менялся ни разу: автосвап заблокирован защитой свежих аккаунтов
-- (ACCOUNT_FRESH_DAYS = 7, все аккаунты созданы ~27.07). Реальная причина —
-- брак пула mobpool.proxy.market: ~30% кругов виснут на getDialogs при живом
-- TCP. При таком фоне три неудачных круга подряд выпадают по теории
-- вероятностей (~2.7% на тройку при ~85 кругах в неделю на аккаунт), то есть
-- degraded ловил почти каждый аккаунт — это лотерея, а не диагноз сессии.
-- Банов Telegram в логе за неделю: 0.
--
-- Фикс: consecutive_proxy_failures инкрементится только когда провалился
-- прокси, ОТЛИЧНЫЙ от прошлого. Для этого нужно помнить, какой прокси упал
-- последним. Побочный эффект (желаемый): пока свап ни разу не состоялся,
-- прокси у аккаунта один и счётчик физически не может дойти до порога —
-- свежие аккаунты больше не получают ложный degraded.

alter table public.tg_outreach_accounts
  add column if not exists last_failed_proxy_id uuid
    references public.tg_outreach_proxies(id) on delete set null;

comment on column public.tg_outreach_accounts.last_failed_proxy_id is
  'Какой прокси провалился последним у этого аккаунта. Нужен чтобы consecutive_proxy_failures считал РАЗНЫЕ прокси: повторный провал того же IP счётчик не двигает. Сбрасывается в NULL на первом успешном круге вместе с consecutive_proxy_failures.';

-- Сбрасываем накопленный мусор: счётчики росли по старой (сломанной) логике,
-- и на живых аккаунтах они сейчас не значат ничего. degraded-флаги, выставленные
-- инцидентом, снимаем — аккаунты целы, банов не было. Ручные degraded
-- (degraded_reason <> 'multiple_proxies_failed') не трогаем.
update public.tg_outreach_accounts
   set consecutive_proxy_failures = 0,
       last_failed_proxy_id = null,
       degraded = false,
       degraded_at = null,
       degraded_reason = null,
       cooldown_until = null
 where degraded = true
   and degraded_reason = 'multiple_proxies_failed';
