export function parseXlsxInWorker(buffer: ArrayBuffer): Promise<string[][] | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL('./xlsxWorker.worker.ts', import.meta.url),
      );
    } catch {
      resolve(null);
      return;
    }

    const timeout = setTimeout(() => {
      worker.terminate();
      resolve(null);
    }, 120_000);

    worker.onmessage = (e: MessageEvent<{ ok: boolean; rows?: string[][]; error?: string }>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (e.data.ok && e.data.rows) {
        resolve(e.data.rows);
      } else {
        resolve(null);
      }
    };

    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(null);
    };

    worker.postMessage(buffer, [buffer]);
  });
}
