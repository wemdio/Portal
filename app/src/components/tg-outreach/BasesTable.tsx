'use client';

import type { BaseStats } from '@/lib/tgOutreach/baseStats';

/**
 * Строка на каждую базу кампании.
 *
 * До этого сводка складывала все базы в одну кучу и показывала «Осталось
 * контактов — 320». На вопрос оператора «это одна база или пять, и какая из них
 * заканчивается» такое число не отвечает: гипотезы живут параллельно, и
 * заканчиваются они по очереди.
 *
 * Порядок колонок повторяет путь контакта: сколько загрузили → сколько ушло →
 * сколько ответили → сколько стали лидами → скольких отдали менеджеру. Так
 * строка читается слева направо как воронка этой конкретной гипотезы, а
 * проценты рядом с числами позволяют сравнить базы разного размера.
 *
 * Прочерк вместо нуля там, где делить не на что: «0 %» и «мы ещё не отправляли»
 * читаются очень по-разному, и это то же правило, что в воронке и в отчёте.
 */
export default function BasesTable({ bases }: { bases: BaseStats[] }) {
  const head = 'px-2 py-1.5 text-left text-[10px] font-medium text-gray-400';
  const cell = 'px-2 py-1.5 text-xs text-gray-700 tabular-nums';

  return (
    <div className="overflow-x-auto rounded-xl bg-gray-50">
      <table className="min-w-full border-collapse">
        <thead>
          <tr>
            <th className={head}>База</th>
            <th className={head} title="Контактов в базе всего, независимо от периода">Всего</th>
            <th className={head} title="Первых сообщений ушло за выбранный период">Отправлено</th>
            <th className={head} title="Ответили хотя бы раз; в скобках — доля от отправленных">Ответы</th>
            <th className={head} title="Диалоги со статусом «Лид»; в скобках — доля от ответивших">Лиды</th>
            <th className={head} title="Ушли менеджеру — и автоматом по триггеру, и вручную кнопкой">Переданы</th>
            <th className={head} title="Человек прочитал и закрыл нам доступ. Растёт — снижайте темп">Блокировки</th>
            <th className={head} title="Контактов, которым ещё ни разу не писали">Осталось</th>
            <th className={head} title="На сколько дней хватит остатка при текущем темпе этой базы">Хватит на</th>
          </tr>
        </thead>
        <tbody>
          {bases.map((b) => (
            <tr key={b.baseId} className="border-t border-gray-200">
              <td className={`${cell} font-medium text-gray-900`}>{b.name}</td>
              <td className={cell}>{b.total}</td>
              <td className={cell}>{b.sent}</td>
              <td className={cell}>
                {b.replies}
                {b.replyRate !== null && (
                  <span className="ml-1 text-[10px] text-gray-400">{b.replyRate}%</span>
                )}
              </td>
              <td className={cell}>
                {b.leads}
                {b.leadRate !== null && (
                  <span className="ml-1 text-[10px] text-gray-400">{b.leadRate}%</span>
                )}
              </td>
              <td className={cell}>{b.forwarded}</td>
              <td className={`${cell} ${b.blocks > 0 ? 'text-amber-600' : ''}`}>{b.blocks}</td>
              <td className={`${cell} ${b.remaining === 0 ? 'text-rose-600 font-medium' : ''}`}>
                {b.remaining}
              </td>
              <td className={cell}>
                {b.remaining === 0 ? (
                  <span className="text-rose-600 font-medium">кончилась</span>
                ) : b.daysLeft === null ? (
                  <span className="text-gray-400" title="За период с этой базы ничего не отправлялось — делить не на что">
                    —
                  </span>
                ) : (
                  <span className={b.daysLeft <= 3 ? 'text-amber-600 font-medium' : ''}>
                    {b.daysLeft} дн.
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
