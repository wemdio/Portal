/**
 * Типы общего ИИ-клиента аутричей — без Node-зависимостей.
 *
 * context.ts и client.ts серверные (node:async_hooks, ключи из env, помечены
 * server-only), а экран запуска — клиентский код: ему нужны только формы
 * данных вроде снимка расхода. Отсюда их можно импортировать куда угодно;
 * context.ts и client.ts реэкспортируют их для прежних импортов.
 */

export type OutreachLang = 'ru' | 'en';

/** analysis — дешёвый разбор (сайт, вакансия, новости, сегменты); writer — цепочки писем. */
export type OutreachLlmRole = 'analysis' | 'writer';

export interface OutreachLlmRoleSpend {
  usd: number;
  calls: number;
}

/** Снимок для parser_jobs.progress_detail.llm: экран запуска пишет «ИИ: потрачено $X из $Y». */
export interface OutreachLlmBudgetSnapshot {
  spent_usd: number;
  calls: number;
  limit_usd: number;
  by_role: Record<OutreachLlmRole, OutreachLlmRoleSpend>;
}

/**
 * Почему запуск нельзя продолжать: missing_key — ключ не задан; rejected_key —
 * Requesty ответил 401/403; billing — на ключе кончились деньги; bad_model —
 * Requesty не знает модель из env (каждый вызов упадёт так же).
 */
export type LlmAuthReason = 'missing_key' | 'rejected_key' | 'billing' | 'bad_model';
