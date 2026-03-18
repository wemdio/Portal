interface PendingAuth {
  phoneCodeHash: string;
  sessionString: string;
  createdAt: number;
}

export const pendingAuths = new Map<string, PendingAuth>();

const TTL_MS = 10 * 60 * 1000; // 10 min

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingAuths) {
    if (now - val.createdAt > TTL_MS) pendingAuths.delete(key);
  }
}, 60_000);
