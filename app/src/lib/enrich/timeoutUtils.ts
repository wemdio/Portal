type TimeoutOptions = {
  timeoutMs: number;
  timeoutMessage: string;
  onTimeout?: () => void;
};

export function runWithTimeout<T>(operation: Promise<T>, options: TimeoutOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        options.onTimeout?.();
      } catch {
        // Ignore timeout callback errors, original timeout error is more important.
      }
      reject(new Error(options.timeoutMessage));
    }, options.timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
