// The HE worker runs one process. This mutex protects only the final database
// read/recheck/write for ENG collections; paid work must finish before entry.
// It is not a distributed lock and does not make multiple HE workers safe.
const projectCommitTails = new Map<string, Promise<void>>();

export async function withHeEngCollectionCommitLock<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = projectCommitTails.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  // Queue only the non-rejecting gate, never the work promise: a failed write
  // must release the next collection and must not poison the project's queue.
  projectCommitTails.set(projectId, turn);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (projectCommitTails.get(projectId) === turn) projectCommitTails.delete(projectId);
  }
}
