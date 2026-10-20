/**
 * Сериализация учёта ENG-проекта внутри одного HE-процесса.
 *
 * Несколько баз одного проекта могут завершить оплаченные этапы одновременно.
 * Их read-modify-write суммы проекта выполняются по очереди, включая доставку
 * ранее сохранённого результата. Разные проекты друг друга не блокируют.
 * Вызывающий выбирает только ENG; RU сохраняет прежний путь. Это не блокировка
 * между контейнерами — для нескольких HE-процессов нужен атомарный DB-инкремент.
 */
const projectUsageTails = new Map<string, Promise<void>>();

export async function withHeEngProjectUsageLock<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = projectUsageTails.get(projectId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  projectUsageTails.set(projectId, current);
  try {
    if (previous) await previous;
    return await work();
  } finally {
    release();
    if (projectUsageTails.get(projectId) === current) projectUsageTails.delete(projectId);
  }
}
