// LSR App - Service Worker
// Cache do app shell para funcionamento 100% offline.
// IMPORTANTE: sempre que publicar mudanças em arquivos estáticos,
// incremente CACHE_VERSION para forçar atualização nos celulares.

const CACHE_VERSION = 'lsr-v48';
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
  'js/despesas.js',
  'js/sync.js',
  'js/admin.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/dexie@4/dist/dexie.js',
  'https://unpkg.com/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Instalação: cacheia o app shell.
// IMPORTANTE: usamos fetch() com { cache: 'reload' } em vez de
// cache.addAll() puro — isso força ignorar o cache HTTP normal do
// navegador (que o GitHub Pages mantém por um tempo) e buscar o
// arquivo de verdade na rede. Sem isso, era possível o Service Worker
// "atualizar" e mesmo assim guardar uma cópia antiga, porque o
// fetch() interno pegava uma resposta já cacheada pelo navegador.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((resposta) => {
              if (resposta.ok) return cache.put(url, resposta);
            })
            .catch((err) => console.warn('[SW] Falha ao cachear', url, err))
        )
      );
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

  // Chamadas à API (Supabase): deixa a rede tentar normalmente, SEM
  // fabricar uma resposta falsa em caso de falha. Uma resposta fake
  // com status 200 engana o cliente Supabase, que interpreta como
  // "sucesso" mesmo a chamada real nunca tendo acontecido — foi
  // exatamente isso que causava turnos "sincronizados" que nunca
  // chegavam no servidor de verdade. Deixando o fetch falhar de
  // verdade, o app sabe honestamente que precisa tentar de novo depois.
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Ignora esquemas que o navegador não deixa cachear (ex: extensões
  // injetando chrome-extension://). Sem isso, cache.put() falha com
  // uma promise rejeitada sem tratamento — sujeira no console, mesmo
  // que não trave o app.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // App shell: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        // Cacheia dinamicamente novos recursos estáticos (só http/https)
        if (event.request.method === 'GET' && response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(event.request, responseClone).catch(() => {
              // Ignora silenciosamente qualquer requisição não-cacheável
              // (ex: geradas por extensões do navegador)
            });
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
