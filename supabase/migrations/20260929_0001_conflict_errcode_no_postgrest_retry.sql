-- Конфликт «запись изменили, обновите» больше не отдаётся кодом 40001.
--
-- 40001 — это serialization_failure, и PostgREST на него сам повторяет
-- транзакцию, без предела. Наши RPC бросают 40001, когда устарел
-- `expected_updated_at` / состояние записи — повтор с теми же аргументами
-- падает снова, и запрос крутится вечно. 28.09.2026 с ~14:40 МСК
-- `decide_email_subscription` из «Календаря оплат» так крутил ~800 откатов
-- в секунду (~30 млн «транзакций» за 10 часов на графике Main DB), а у
-- человека висело «Сохранение…».
--
-- PT409 PostgREST не повторяет и отдаёт как HTTP 409. Экраны и роуты узнают
-- эти конфликты по тексту сообщения — он не меняется; роут конвертации
-- заявок команды смотрел на код и переведён на PT409 вместе с миграцией.
--
-- Тела функций не копируем из старых миграций (денежные функции длинные,
-- копия легко разойдётся с тем, что стоит в базе): берём текущее определение,
-- меняем только код ошибки и пересоздаём. CREATE OR REPLACE сохраняет
-- владельца и права. Повторный прогон ничего не меняет.
--
-- В новых RPC для конфликта используйте errcode 'PT409', не '40001'.
do $$
declare
  v_fn regprocedure;
  v_def text;
begin
  foreach v_fn in array array[
    'public.decide_email_subscription(uuid,text,text,timestamptz)',
    'public.convert_team_review_request(uuid,date,text,timestamptz)',
    'public.transition_payment_request(uuid,text,timestamptz,text,date,text)',
    'public.transition_project_period(uuid,integer,uuid,uuid,uuid,date,boolean,text,boolean,text,boolean,date,boolean,text,boolean,text,boolean,date)',
    'public.renew_tech_subscription_with_budget(uuid,date,numeric,uuid,timestamptz)'
  ]::regprocedure[]
  loop
    v_def := pg_get_functiondef(v_fn);
    if position('errcode = ''40001''' in v_def) = 0 then
      continue;
    end if;

    execute replace(v_def, 'errcode = ''40001''', 'errcode = ''PT409''');

    if position('40001' in pg_get_functiondef(v_fn)) > 0 then
      raise exception '% still raises 40001 after rewrite', v_fn;
    end if;
  end loop;
end;
$$;
