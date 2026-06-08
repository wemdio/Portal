-- Дневной кап по готовым контактам для авто-пайплайна (добора).
--
-- Зачем: добор гнал до daily_target_employers (employer-таргет на enrichment),
-- из-за чего за сутки выдавал больше контактов, чем нужно — особенно при
-- ежедневном редеплое: он прерывает прогон, а resume докручивает таргет заново
-- (перебор). daily_contacts_target — потолок по НОВЫМ контактам (лидам, routed)
-- в сутки: добор суммирует routed_count прогонов за текущее окно и
-- останавливается, как только дневная потребность закрыта. Переживает
-- редеплои/резюмы без перебора. NULL = без капа (старое поведение).

ALTER TABLE public.client_auto_pipeline_configs
  ADD COLUMN IF NOT EXISTS daily_contacts_target integer;

COMMENT ON COLUMN public.client_auto_pipeline_configs.daily_contacts_target IS
  'Потолок новых контактов (лидов, routed) в сутки. Добор стопает enrichment, как только сумма routed за текущее окно достигла этого числа. NULL = без капа.';

-- Включаем кап для текущего активного клиента (Mailganer): 1000 контактов/сутки.
-- Guard IS NULL — идемпотентно, не затирает значения, выставленные вручную позже.
UPDATE public.client_auto_pipeline_configs
  SET daily_contacts_target = 1000
  WHERE enabled = true AND daily_contacts_target IS NULL;
