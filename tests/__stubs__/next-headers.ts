/**
 * Test stub for next/headers: lets tests drive `cookies()` outside a request
 * scope (workspace switcher, layout reads). Values are per-process; tests set
 * them explicitly before each assertion.
 */
type CookieLike = { name: string; value: string };

const store = new Map<string, string>();

export function cookies(): Promise<{
  get(name: string): CookieLike | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
}> {
  return Promise.resolve({
    get(name: string) {
      const value = store.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name: string, value: string, _options?: Record<string, unknown>) {
      void _options;
      store.set(name, value);
    },
    delete(name: string) {
      store.delete(name);
    },
  });
}

export function headers(): Promise<Record<string, string>> {
  return Promise.resolve({});
}

/** Test helper: prime or clear the stubbed cookie jar. */
export function __setTestCookie(name: string, value: string | null): void {
  if (value === null) store.delete(name);
  else store.set(name, value);
}
