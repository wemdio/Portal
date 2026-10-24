/**
 * Фоновая дорожка воркера «Рассылки»: работа, которую отправка не ждёт.
 *
 * Раньше планировщик, проверка ящиков и опрос входящих шли в том же цикле, что
 * отправка, и каждый адрес простаивал по 4–11 часов в сутки, пока письма ждали
 * (замер 22.10.2026). Дорожка запускает работу и не ждёт её: проход один за
 * раз — второй, пока идёт первый, не начинается (иначе два планировщика
 * переписали бы лимиты ящиков), — и не чаще интервала.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

/** Больше этого setTimeout в Node не умеет — срабатывает через 1 мс. */
const MAX_TIMER_MS = 2_147_483_647;

export class BackgroundLane {
  private running: Promise<void> | null = null;
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly log: Log,
  ) {}

  /** Запустить проход, если прошлый закончился и интервал вышел. Не ждёт его. */
  kick(job: () => Promise<unknown>, now: number = Date.now()): boolean {
    if (this.running || now - this.lastStartedAt < this.intervalMs) return false;
    this.lastStartedAt = now;
    this.running = (async () => {
      try {
        await job();
      } catch (e) {
        this.log('warn', `${this.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().finally(() => {
      this.running = null;
    });
    return true;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Дождаться идущего прохода перед остановкой воркера, но не дольше timeoutMs:
   * аренду нельзя отдавать, пока планировщик ещё пишет, а контейнер ждут две минуты.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const current = this.running;
    if (!current) return true;
    // Без срока — именно ждать: setTimeout с Infinity (и всем, что больше
    // 2^31−1 мс) Node превращает в 1 мс, и «ждать до конца» не ждало бы вовсе.
    if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_MS) {
      await current;
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([current.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
