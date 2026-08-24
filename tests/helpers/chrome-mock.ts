/**
 * An in-memory stand-in for the `chrome.*` APIs Wick uses.
 *
 * Tests run in the `node` environment — there is no extension host, and
 * `chrome` is simply absent. This provides just enough of it to exercise the
 * background modules for real rather than around them: storage that actually
 * stores, `onChanged` that actually fires, and recorders for the calls whose
 * only observable effect is on the browser.
 *
 * Deliberately not a full emulation. If a test needs behaviour this does not
 * model, add it here rather than stubbing it locally — one fake that everyone
 * shares is what keeps the modules honest about what they depend on.
 */

interface Listener<T extends unknown[]> {
  addListener(fn: (...args: T) => void): void;
  removeListener(fn: (...args: T) => void): void;
  hasListener(fn: (...args: T) => void): boolean;
}

function listenerSet<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  const event: Listener<T> = {
    addListener: (fn) => void listeners.add(fn),
    removeListener: (fn) => void listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
  };
  return {
    event,
    emit: (...args: T) => {
      for (const fn of [...listeners]) fn(...args);
    },
    count: () => listeners.size,
  };
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface FakeChrome {
  /** Everything currently in `chrome.storage.local`. */
  store: Map<string, unknown>;
  /** Cookies keyed by name, as `chrome.cookies.get` would return them. */
  cookies: Map<string, string>;
  /** Every `chrome.action.setIcon` call, in order. */
  iconCalls: unknown[];
  /** Every `chrome.notifications.create` call, in order. */
  notifications: unknown[];
  /** Alarms created, by name. */
  alarms: Map<string, chrome.alarms.AlarmCreateInfo>;
  /** Fire the alarm listener for `name`. */
  fireAlarm(name: string): void;
  /** Deliver a runtime message to registered listeners; resolves with the reply. */
  sendToWorker(message: unknown): Promise<unknown>;
  /** Number of registered `storage.onChanged` listeners. */
  storageListenerCount(): number;
  /** Wipe everything, keeping the same installed object. */
  reset(): void;
}

/**
 * Install the fake onto `globalThis.chrome` and return handles for assertions.
 *
 * Call in `beforeEach`. The returned object is stable across `reset()`.
 */
export function installChromeMock(): FakeChrome {
  const store = new Map<string, unknown>();
  const cookies = new Map<string, string>();
  const iconCalls: unknown[] = [];
  const notifications: unknown[] = [];
  const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();

  const onChanged = listenerSet<[Record<string, StorageChange>, string]>();
  const onAlarm = listenerSet<[chrome.alarms.Alarm]>();
  const onMessage =
    listenerSet<
      [unknown, chrome.runtime.MessageSender, (response?: unknown) => void]
    >();
  const onInstalled = listenerSet<[]>();
  const onBeforeRequest = listenerSet<[unknown]>();
  const onCompleted = listenerSet<[unknown]>();

  const local = {
    async get(keys?: string | string[] | null) {
      const wanted =
        keys === undefined || keys === null
          ? [...store.keys()]
          : Array.isArray(keys)
            ? keys
            : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        if (store.has(key)) out[key] = structuredClone(store.get(key));
      }
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store.get(key), newValue: structuredClone(value) };
        store.set(key, structuredClone(value));
      }
      onChanged.emit(changes, 'local');
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, StorageChange> = {};
      for (const key of list) {
        changes[key] = { oldValue: store.get(key), newValue: undefined };
        store.delete(key);
      }
      onChanged.emit(changes, 'local');
    },
    async clear() {
      store.clear();
    },
  };

  const fake = {
    storage: { local, onChanged: onChanged.event },
    cookies: {
      async get({ name }: { url: string; name: string }) {
        const value = cookies.get(name);
        return value === undefined ? null : { name, value };
      },
    },
    alarms: {
      create(name: string, info: chrome.alarms.AlarmCreateInfo) {
        alarms.set(name, info);
      },
      async clear(name: string) {
        return alarms.delete(name);
      },
      async get(name: string) {
        return alarms.has(name) ? { name, scheduledTime: 0, periodInMinutes: 0 } : undefined;
      },
      onAlarm: onAlarm.event,
    },
    action: {
      setIcon(details: unknown) {
        iconCalls.push(details);
        return Promise.resolve();
      },
      setBadgeText: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
    },
    notifications: {
      create(...args: unknown[]) {
        notifications.push(args.length === 1 ? args[0] : args);
        return Promise.resolve('id');
      },
    },
    runtime: {
      id: 'wick-test',
      getURL: (path: string) => `chrome-extension://wick-test/${path}`,
      sendMessage: () => Promise.resolve(undefined),
      onMessage: onMessage.event,
      onInstalled: onInstalled.event,
      lastError: undefined as chrome.runtime.LastError | undefined,
    },
    webRequest: {
      onBeforeRequest: onBeforeRequest.event,
      onCompleted: onCompleted.event,
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(undefined),
    },
  };

  // The fake covers only what Wick calls, so it is not assignable to the full
  // `typeof chrome`. The cast is the point of the file, and is confined to it.
  (globalThis as { chrome?: unknown }).chrome = fake;

  return {
    store,
    cookies,
    iconCalls,
    notifications,
    alarms,
    fireAlarm(name) {
      onAlarm.emit({ name, scheduledTime: Date.now() } as chrome.alarms.Alarm);
    },
    async sendToWorker(message) {
      return new Promise((resolve) => {
        let replied = false;
        const reply = (response?: unknown) => {
          replied = true;
          resolve(response);
        };
        onMessage.emit(message, {} as chrome.runtime.MessageSender, reply);
        // A listener that returns without replying resolves undefined, which is
        // what chrome does when nothing keeps the channel open.
        queueMicrotask(() => {
          if (!replied) resolve(undefined);
        });
      });
    },
    storageListenerCount: () => onChanged.count(),
    reset() {
      store.clear();
      cookies.clear();
      iconCalls.length = 0;
      notifications.length = 0;
      alarms.clear();
    },
  };
}

/** Remove the fake. Call in `afterEach` when a test file installs it. */
export function uninstallChromeMock(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
