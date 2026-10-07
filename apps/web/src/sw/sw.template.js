// Service worker do LouvorVisual. A constante BUILD recebe de
// scripts/generate-sw.mjs, depois do `next build`, o objeto
//   { version, shells: [caminhos], entries: [{ url, sha256 }] }
const BUILD = __LV_BUILD__;
const CACHE_PREFIX = 'lv-precache-';
const CACHE = CACHE_PREFIX + BUILD.version;
const SESSION_LOCK = 'lv-presentation-session';
const SHELLS = new Set(BUILD.shells);
const PRECACHED = new Set(BUILD.entries.map((entry) => entry.url));

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Cada recurso só entra no cache se os bytes recebidos forem os do build.
async function fetchVerified(cache, entry) {
  const response = await fetch(entry.url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error(`${entry.url}: HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', body)) !== entry.sha256) throw new Error(`${entry.url}: conteúdo diferente do build`);
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  await cache.put(entry.url, new Response(body, { status: 200, headers }));
}

// Instala a versão em cache próprio. Se qualquer recurso falhar, o cache novo
// é descartado e a versão anterior continua intacta.
async function precache() {
  const cache = await caches.open(CACHE);
  try {
    const queue = [...BUILD.entries];
    const workers = Array.from({ length: 6 }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) await fetchVerified(cache, entry);
    });
    await Promise.all(workers);
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener('install', (event) => {
  // Sem skipWaiting: uma versão nova espera até o operador aceitar.
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

async function fromCache(url, request) {
  const cached = await (await caches.open(CACHE)).match(url);
  return cached ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // A query é estado local do shell; o documento em cache é o mesmo.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    if (SHELLS.has(path)) event.respondWith(fromCache(path, request));
    return;
  }
  // API, RSC e qualquer outro recurso seguem para a rede sem interferência.
  if (PRECACHED.has(url.pathname)) event.respondWith(fromCache(url.pathname, request));
});

async function status() {
  const keys = (await caches.has(CACHE)) ? await (await caches.open(CACHE)).keys() : [];
  return { version: BUILD.version, expected: BUILD.entries.length, cached: keys.length };
}

// A troca de versão só acontece a pedido e nunca com uma apresentação aberta:
// a janela de projeção mantém SESSION_LOCK enquanto existir.
async function activateIfIdle() {
  if (!self.navigator.locks) return { activated: false, reason: 'locks-unsupported' };
  return self.navigator.locks.request(SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return { activated: false, reason: 'session-active' };
    await self.skipWaiting();
    return { activated: true, reason: null };
  });
}

self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port || !event.data) return;
  if (event.data.type === 'STATUS') event.waitUntil(status().then((reply) => port.postMessage(reply)));
  if (event.data.type === 'ACTIVATE') event.waitUntil(activateIfIdle().then((reply) => port.postMessage(reply)));
});
