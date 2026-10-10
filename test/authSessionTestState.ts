import { vi } from "vitest";

/** Transactional storage and startup gates for deterministic AuthSession tests. */
export function authSessionTestState(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  let alarmAt: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let startup: Promise<unknown> = Promise.resolve();
  const storage = {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined),
    put: async (key: string | Record<string, unknown>, value?: unknown): Promise<void> => {
      if (typeof key === "string") {
        values.set(key, value);
      } else {
        for (const [name, entry] of Object.entries(key)) values.set(name, entry);
      }
    },
    delete: vi.fn(async (key: string | string[]): Promise<boolean | number> => {
      if (typeof key === "string") return values.delete(key);
      return key.reduce((count, name) => count + Number(values.delete(name)), 0);
    }),
    getAlarm: async (): Promise<number | null> => alarmAt,
    setAlarm: vi.fn(async (time: number): Promise<void> => { alarmAt = time; }),
    deleteAlarm: vi.fn(async (): Promise<void> => { alarmAt = null; }),
    transaction: <T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> => {
      const result = tail.then(async () => {
        const snapshot = new Map(values);
        const previousAlarm = alarmAt;
        try {
          return await callback(storage as unknown as DurableObjectTransaction);
        } catch (error) {
          values.clear();
          for (const [key, value] of snapshot) values.set(key, value);
          alarmAt = previousAlarm;
          throw error;
        }
      });
      tail = result.catch(() => {});
      return result;
    }
  };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => {
      const result = callback();
      startup = result;
      return result;
    }
  } as unknown as DurableObjectState;
  return { state, storage, values, ready: () => startup };
}
