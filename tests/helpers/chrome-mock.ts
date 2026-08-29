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
    /** Emit and collect what each listener returned. See `sendToWorker`. */
    emitCollect: (...args: T) => [...listeners].map((fn) => fn(...args) as unknown),
    count: () => listeners.size,
  };
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * A host match pattern, as loosely as `chrome.tabs.query` needs it here.
 *
 * Every character that means something to a regular expression is escaped
 * except `*`, which is then the only wildcard — which is exactly what a match
 * pattern is.
 */
function matchesPattern(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

export interface FakeChrome {
  /** Everything currently in `chrome.storage.local`. */
  store: Map<string, unknown>;
  /**
   * Tabs the browser is showing. Push one to make `chrome.tabs.query` find it —
   * which is how the collector decides whether anyone is watching.
   */
  tabs: { url: string }[];
  /** Cookies keyed by name, as `chrome.cookies.get` would return them. */
  cookies: Map<string, string>;
  /** Every `chrome.action.setIcon` call, in order. */
  iconCalls: unknown[];
  /** Every dynamic `chrome.action.setTitle` call, in order. */
  titleCalls: unknown[];
  /** Every `chrome.notifications.create` call, in order. */
  notifications: unknown[];
  /** Alarms created, by name. */
  alarms: Map<string, chrome.alarms.AlarmCreateInfo>;
  /**
   * Optional host permissions currently granted.
   *
   * Empty by default, which is the state a fresh install is in: every module
   * behind an optional grant must work — by doing nothing — before the user has
   * agreed to anything. Add a pattern to grant it.
   */
  grantedOrigins: Set<string>;
  /**
   * What `chrome.tabs.sendMessage` answers, by message type.
   *
   * Empty by default, which models a tab whose content script has not loaded:
   * chrome resolves `undefined` and the caller has to cope. Set an entry to let
   * the worker get an answer back from a page.
   */
  tabReplies: Map<string, unknown>;
  /** Every `chrome.tabs.sendMessage` call, in order. */
  tabMessages: { tabId: number; message: unknown }[];
  /** Fire the alarm listener for `name`. */
  fireAlarm(name: string): void;
  /** A sender shaped like Wick's own popup extension page. */
  popupSender(): chrome.runtime.MessageSender;
  /** A sender shaped like Wick's isolated main-frame provider content script. */
  contentSender(url?: string, frameId?: number): chrome.runtime.MessageSender;
  /** Deliver a runtime message to registered listeners; resolves with the reply. */
  sendToWorker(message: unknown, sender?: chrome.runtime.MessageSender): Promise<unknown>;
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
  const tabs: { url: string }[] = [];
  const cookies = new Map<string, string>();
  const iconCalls: unknown[] = [];
  const titleCalls: unknown[] = [];
  const notifications: unknown[] = [];
  const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
  const grantedOrigins = new Set<string>();
  const tabReplies = new Map<string, unknown>();
  const tabMessages: { tabId: number; message: unknown }[] = [];

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
      setTitle(details: unknown) {
        titleCalls.push(details);
        return Promise.resolve();
      },
    },
    notifications: {
      create(...args: unknown[]) {
        notifications.push(args.length === 1 ? args[0] : args);
        return Promise.resolve('id');
      },
    },
    permissions: {
      contains: ({ origins = [] }: { origins?: string[] } = {}) =>
        Promise.resolve(origins.every((origin) => grantedOrigins.has(origin))),
      // `request` needs a user gesture in the browser and cannot be reached
      // from a worker at all. Tests that need a grant set `grantedOrigins`
      // directly rather than pretending a click happened.
      request: ({ origins = [] }: { origins?: string[] } = {}) => {
        for (const origin of origins) grantedOrigins.add(origin);
        return Promise.resolve(true);
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
      query: ({ url }: { url?: string | string[] } = {}) => {
        const patterns = url === undefined ? null : Array.isArray(url) ? url : [url];
        const found = patterns === null
          ? [...tabs]
          : tabs.filter((tab) => patterns.some((one) => matchesPattern(one, tab.url)));
        // Chrome gives every tab an id. The fake numbers them by position, so a
        // test that pushes two tabs can tell which one was messaged.
        return Promise.resolve(found.map((tab, index) => ({ ...tab, id: index + 1 })));
      },
      sendMessage: (tabId: number, message: unknown) => {
        tabMessages.push({ tabId, message });
        const type = (message as { type?: unknown } | null)?.type;
        const reply = typeof type === 'string' ? tabReplies.get(type) : undefined;

        // Chrome **rejects** when nothing is listening in the tab — a page whose
        // content script has not run yet, or one loaded before the extension was
        // updated. Resolving undefined instead would let a caller that catches
        // too broadly look correct here and abandon a search in the browser.
        if (reply === undefined) {
          return Promise.reject(
            new Error('Could not establish connection. Receiving end does not exist.'),
          );
        }
        return Promise.resolve(reply);
      },
    },
  };

  // The fake covers only what Wick calls, so it is not assignable to the full
  // `typeof chrome`. The cast is the point of the file, and is confined to it.
  (globalThis as { chrome?: unknown }).chrome = fake;

  return {
    store,
    tabs,
    cookies,
    iconCalls,
    titleCalls,
    notifications,
    alarms,
    grantedOrigins,
    tabReplies,
    tabMessages,
    fireAlarm(name) {
      onAlarm.emit({ name, scheduledTime: Date.now() } as chrome.alarms.Alarm);
    },
    popupSender() {
      return {
        id: 'wick-test',
        url: 'chrome-extension://wick-test/src/popup/index.html',
        origin: 'chrome-extension://wick-test',
      } as chrome.runtime.MessageSender;
    },
    contentSender(url = 'https://claude.ai/chats', frameId = 0) {
      return {
        id: 'wick-test',
        url,
        origin: new URL(url).origin,
        frameId,
        tab: { id: 1, url } as chrome.tabs.Tab,
      } as chrome.runtime.MessageSender;
    },
    async sendToWorker(message, sender) {
      const actualSender = sender ?? {
        id: 'wick-test',
        url: 'chrome-extension://wick-test/src/popup/index.html',
        origin: 'chrome-extension://wick-test',
      } as chrome.runtime.MessageSender;
      return new Promise((resolve) => {
        let replied = false;
        const reply = (response?: unknown) => {
          replied = true;
          resolve(response);
        };

        // A listener that returns `true` is telling Chrome to hold the reply
        // channel open across an await. Honouring that is what makes an
        // asynchronous handler testable through this bus at all: without it,
        // the microtask below resolves `undefined` before the handler has
        // finished, and every async listener looks like it answered nothing.
        const held = onMessage
          .emitCollect(message, actualSender, reply)
          .some((returned) => returned === true);
        if (held) return;

        // Nothing kept the channel open, which is chrome's own behaviour: the
        // caller sees undefined.
        queueMicrotask(() => {
          if (!replied) resolve(undefined);
        });
      });
    },
    storageListenerCount: () => onChanged.count(),
    reset() {
      store.clear();
      cookies.clear();
      tabs.length = 0;
      iconCalls.length = 0;
      titleCalls.length = 0;
      notifications.length = 0;
      alarms.clear();
      grantedOrigins.clear();
      tabReplies.clear();
      tabMessages.length = 0;
    },
  };
}

/** Remove the fake. Call in `afterEach` when a test file installs it. */
export function uninstallChromeMock(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
