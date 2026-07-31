import ExpensesView from '@/components/expenses/ExpensesView';

export const metadata = { title: 'Расходы' };

/**
 * Дашборд расходов.
 *
 * Данные страница не читает: всё идёт через `/api/expenses/*` под гардом
 * `requireExpensesAccess`. Скрытый пункт меню защитой не считается — сюда
 * можно прийти прямой ссылкой, и тогда пользователь без доступа увидит текст
 * отказа от API вместо цифр.
 */
export default function ExpensesPage() {
  return <ExpensesView />;
}
