// @ts-check
/** @param {unknown} actual @param {unknown} expected */
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** @param {string|null} failure */
async function lifecycle(failure) {
  const source = await Deno.readTextFile(new URL('../service-worker.js', import.meta.url));
  /** @type {unknown[]} */ const messages = [];
  /** @type {string[]} */ const actions = [];
  const fault = (/** @type {string} */ stage) => { if (failure === stage) throw new Error(`Injected:${stage}`); };
  const cache = {
    async addAll(/** @type {string[]} */ urls) { fault('assets'); equal(urls.includes('./asset-manifest.json'), true); actions.push('cached'); },
    async match() { return undefined; },
    async put() { fault('write'); },
  };
  const caches = {
    async open() { fault('cache'); return cache; },
    async keys() { fault('upgrade'); return ['resonance-shell-old', 'unrelated']; },
    async delete(/** @type {string} */ key) { actions.push(`delete:${key}`); },
  };
  const self = {
    addEventListener() {},
    async skipWaiting() { actions.push('skip'); },
    clients: {
      async matchAll() { return [{ postMessage: (/** @type {unknown} */ message) => messages.push(message) }]; },
      async claim() { actions.push('claim'); },
    },
  };
  const fetch = async (/** @type {string|Request} */ url) => {
    if (url === './asset-manifest.json') {
      if (failure === 'manifest-missing') return new Response('', {status: 404});
      return new Response(failure === 'manifest-invalid' ? '{}' : '["./chunk.js"]');
    }
    fault('network'); return new Response('online');
  };
  const api = new Function('self', 'caches', 'fetch', `${source}\nreturn {installShell, upgradeShell, resolveFreshRequest};`)(self, caches, fetch);
  return { api, messages, actions };
}
Deno.test('offline install caches shell before activation and upgrade preserves unrelated caches', async () => {
  const h = await lifecycle(null);
  await h.api.installShell(); await h.api.upgradeShell();
  equal(h.actions, ['cached', 'skip', 'delete:resonance-shell-old', 'claim']); equal(h.messages, []);
});
Deno.test('offline install and upgrade reject with named visible-message contracts', async () => {
  for (const failure of ['cache', 'manifest-missing', 'manifest-invalid', 'assets', 'upgrade']) {
    const h = await lifecycle(failure);
    const kind = failure === 'upgrade' ? 'OfflineUpgradeFailed' : 'OfflineCacheInstallFailed';
    let rejected = false;
    try { await (failure === 'upgrade' ? h.api.upgradeShell() : h.api.installShell()); }
    catch (error) { if (!(error instanceof Error)) throw error; equal(error.message, kind); rejected = true; }
    equal(rejected, true); equal(h.messages, [{type:'resonance-offline-failure', kind}]);
    equal(h.actions.includes('skip') || h.actions.includes('claim'), false);
  }
});
Deno.test('offline cache miss and write failure report failure without inventing cached content', async () => {
  for (const failure of ['network', 'write', 'cache']) {
    const h = await lifecycle(failure);
    const response = await h.api.resolveFreshRequest(new Request('http://localhost/'));
    equal(response.type === 'error', failure === 'network');
    equal(h.messages, [{type:'resonance-offline-failure', kind:'OfflineCacheMiss'}]);
  }
});

Deno.test('browser registration success, rejection and unsupported API retain existing failure contracts', async () => {
  const source = await Deno.readTextFile(new URL('../src/app.js', import.meta.url));
  const start = source.indexOf('function registerOfflineSupport() {');
  const end = source.indexOf('\nasync function syncReminderTimeZone()', start);
  for (const mode of ['success', 'rejected', 'unsupported']) {
    /** @type {string[]} */ const notices = [];
    let registered = 0, watched = 0;
    const serviceWorker = Object.assign(new EventTarget(), {
      register: async () => { registered++; if (mode === 'rejected') throw new DOMException('Synthetic denial', 'SecurityError'); return {}; },
    });
    const bindings = {
      addEventListener() {}, document: new EventTarget(), systemThemeQuery: new EventTarget(),
      navigator: mode === 'unsupported' ? {} : {serviceWorker},
      watchServiceWorkerInstall() { watched++; },
      showOfflineFailure: (/** @type {string} */ kind) => notices.push(kind),
    };
    new Function(...Object.keys(bindings), `${source.slice(start, end)}\nregisterOfflineSupport();`)(...Object.values(bindings));
    await new Promise(resolve => setTimeout(resolve, 0));
    equal(registered, mode === 'unsupported' ? 0 : 1);
    equal(watched, mode === 'success' ? 1 : 0);
    equal(notices, mode === 'rejected' ? ['OfflineRegistrationFailed'] : []);
  }
});
Deno.test('blocked Playwright registration result causes the caught watcher TypeError', async () => {
  const source = await Deno.readTextFile(new URL('../src/app.js', import.meta.url));
  const start = source.indexOf('function watchServiceWorkerInstall(registration) {');
  const end = source.indexOf('\n/** @param {ServiceWorker | null}', start);
  const watch = new Function('observeInstallingWorker', 'navigator', `${source.slice(start, end)}\nreturn watchServiceWorkerInstall;`)(() => {}, {serviceWorker: {controller: null}});
  let rejected = false;
  try { watch(undefined); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    equal(error.message.includes('installing'), true); rejected = true;
  }
  equal(rejected, true);
});
