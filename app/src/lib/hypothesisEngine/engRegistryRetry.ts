/** A free registry/site read will resume later, without repeating paid discovery. */
export class HeEngRegistryRetryError extends Error {
  constructor(readonly delayMs: number) { super('ENG registry free-read retry is pending'); }
}
