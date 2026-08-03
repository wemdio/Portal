import { Suspense } from 'react';

import MoneyView from '@/components/expenses/MoneyView';

export const metadata = { title: 'Расходы и доходы' };

/**
 * Дашборд раздела «Деньги»: расходы и доходы под одним переключателем.
 *
 * Данные страница не читает: всё идёт через `/api/expenses/*` под гардом
 * `requireExpensesAccess`. Скрытый пункт меню защитой не считается — сюда
 * можно прийти прямой ссылкой, и тогда пользователь без доступа увидит текст
 * отказа от API вместо цифр.
 *
 * `Suspense` здесь обязателен: `MoneyView` читает режим и период из адреса
 * через `useSearchParams`, а без границы ожидания сборка отказывается
 * пререндерить страницу.
 */
export default function ExpensesPage() {
  return (
    <Suspense fallback={<div className="py-10 text-center text-sm text-zinc-400">Загружаю…</div>}>
      <MoneyView />
    </Suspense>
  );
}
