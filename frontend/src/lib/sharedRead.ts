/**
 * One read shared by everyone who asks within a short window (RW1-P-06: the
 * views reacting to one account action read the entry once). Pure (no
 * Wails), tests in tests/loop2.accounts.test.ts.
 */
export interface SharedReader<T> {
  /** The read of `key`: a read started less than `maxAgeMs` ago is shared; 0 always starts a new one. */
  read(key: string, maxAgeMs?: number): Promise<T>
  /** Seeds `key` with a known result (shared like a finished read). */
  seed(key: string, value: T): void
  /** Forgets `key` (the next read starts anew). */
  forget(key: string): void
}

export function createSharedReader<T>(fetch: (key: string) => Promise<T>, windowMs = 1500, now: () => number = Date.now): SharedReader<T> {
  const reads = new Map<string, { at: number; promise: Promise<T> }>()
  const prune = (t: number) => {
    if (reads.size <= 100) return
    for (const [k, v] of reads) if (t - v.at >= windowMs) reads.delete(k)
  }
  return {
    read(key, maxAgeMs = windowMs) {
      const t = now()
      const hit = reads.get(key)
      if (hit && maxAgeMs > 0 && t - hit.at < maxAgeMs) return hit.promise
      const promise = fetch(key)
      reads.set(key, { at: t, promise })
      // A failed read is not shared.
      promise.catch(() => {
        if (reads.get(key)?.promise === promise) reads.delete(key)
      })
      prune(t)
      return promise
    },
    seed(key, value) {
      reads.set(key, { at: now(), promise: Promise.resolve(value) })
    },
    forget(key) {
      reads.delete(key)
    },
  }
}
