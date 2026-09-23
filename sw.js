// LSR App - Service Worker
// Cache do app shell para funcionamento 100% offline.
// IMPORTANTE: sempre que publicar mudanças em arquivos estáticos,
// incremente CACHE_VERSION para forçar atualização nos celulares.

const CACHE_VERSION = 'lsr-v9';
// Caminhos RELATIVOS (sem "/" na frente) — essencial para funcionar
// em subpasta (ex: GitHub Pages de projeto: usuario.github.io/LSR-App/).
const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/styles.css',
  'js/app.js',
  'js/db.js',
  'js/auth.js',
  'js/supabase-client.js',
  'js/veiculos.js',
  'js/turnos.js',
  'js/sync.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/dexie@4/dist/dexie.js',
  'https://unpkg.com/@supabase/supabase-js@2'
];

// Instalação: cacheia o app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('[SW] Falha ao cachear algum recurso do app shell:', err);
      });
    })
  );
  self.skipWaiting();
});

// Ativação: limpa caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first para app shell, network-first para chamadas à API do Supabase
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Chamadas à API (Supabase) sempre tentam rede primeiro
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'offline' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // App shell: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        // Cacheia dinamicamente novos recursos estáticos
        if (event.request.method === 'GET' && response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      });
    }).catch(() => {
      // Fallback offline para navegação
      if (event.request.mode === 'navigate') {
        return caches.match('index.html');
      }
    })
  );
});
