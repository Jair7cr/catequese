/**
 * sw.js — service worker do aplicativo instalável (PWA — Etapa 3). Modelo: pwa-fonte/sw.js; o montador
 * (pwa-fonte/montar.py) troca __VERSAO__ e __ARQUIVOS__ ao gerar o site.
 *
 * O que guarda: SÓ a interface (páginas, scripts, estilos, bibliotecas, fontes, ícones), para o aplicativo abrir
 * na hora e também sem internet. NUNCA guarda dados: as chamadas ao servidor (POST para script.google.com) passam
 * direto, sem nenhuma interferência. Dados no aparelho são assunto da Etapa 4, em banco próprio (IndexedDB).
 *
 * Atualização: cada versão do site gera um sw.js diferente (a versão leva um resumo do conteúdo de todos os
 * arquivos). A versão nova se instala em segundo plano e ESPERA; o aplicativo mostra "Nova versão disponível" e
 * só troca quando a pessoa toca em "Atualizar" (mensagem 'ATIVAR'). Ao ativar, apaga os caches das versões antigas.
 *
 * config.js (endereço do servidor) é o único arquivo buscado primeiro na rede: ele é editado direto no GitHub e
 * não deve ficar preso numa versão antiga.
 */
var VERSAO = '2026.10.23-9a261f19d1';
var CACHE = 'catequese-' + VERSAO;
var ARQUIVOS = [
  "./",
  "app.html",
  "css/pwa.css",
  "icones/apple-touch-icon.png",
  "icones/favicon-32.png",
  "icones/icone-192.png",
  "icones/icone-512.png",
  "icones/icone-maskable-512.png",
  "index.html",
  "js/pwa-app.js",
  "js/pwa-dados.js",
  "js/pwa-fila.js",
  "js/pwa-inicio.js",
  "js/pwa-login.js",
  "manifest.webmanifest",
  "vendor/bootstrap/bootstrap.bundle.min.js",
  "vendor/bootstrap/bootstrap.min.css",
  "vendor/chartjs/chart.umd.js",
  "vendor/fontawesome/css/all.min.css",
  "vendor/fontawesome/webfonts/fa-brands-400.ttf",
  "vendor/fontawesome/webfonts/fa-brands-400.woff2",
  "vendor/fontawesome/webfonts/fa-regular-400.ttf",
  "vendor/fontawesome/webfonts/fa-regular-400.woff2",
  "vendor/fontawesome/webfonts/fa-solid-900.ttf",
  "vendor/fontawesome/webfonts/fa-solid-900.woff2",
  "vendor/fontawesome/webfonts/fa-v4compatibility.ttf",
  "vendor/fontawesome/webfonts/fa-v4compatibility.woff2",
  "vendor/fontes/fontes.css",
  "vendor/fontes/inter-latin-400-normal.woff",
  "vendor/fontes/inter-latin-400-normal.woff2",
  "vendor/fontes/inter-latin-500-normal.woff",
  "vendor/fontes/inter-latin-500-normal.woff2",
  "vendor/fontes/inter-latin-600-normal.woff",
  "vendor/fontes/inter-latin-600-normal.woff2",
  "vendor/fontes/inter-latin-700-normal.woff",
  "vendor/fontes/inter-latin-700-normal.woff2",
  "vendor/fontes/inter-latin-ext-400-normal.woff",
  "vendor/fontes/inter-latin-ext-400-normal.woff2",
  "vendor/fontes/inter-latin-ext-500-normal.woff",
  "vendor/fontes/inter-latin-ext-500-normal.woff2",
  "vendor/fontes/inter-latin-ext-600-normal.woff",
  "vendor/fontes/inter-latin-ext-600-normal.woff2",
  "vendor/fontes/inter-latin-ext-700-normal.woff",
  "vendor/fontes/inter-latin-ext-700-normal.woff2",
  "vendor/fontes/source-serif-4-latin-600-normal.woff",
  "vendor/fontes/source-serif-4-latin-600-normal.woff2",
  "vendor/fontes/source-serif-4-latin-ext-600-normal.woff",
  "vendor/fontes/source-serif-4-latin-ext-600-normal.woff2"
];

self.addEventListener('install', function (evento) {
  evento.waitUntil(caches.open(CACHE).then(function (cache) {
    // cache: 'reload' = baixa do servidor, sem reaproveitar o cache HTTP do navegador (evita misturar versões).
    return cache.addAll(ARQUIVOS.map(function (url) { return new Request(url, { cache: 'reload' }); })).then(function () {
      // config.js também, para a primeira abertura sem internet já saber o endereço do servidor (falha não impede).
      return cache.add(new Request('config.js', { cache: 'reload' })).catch(function () {});
    });
  }));
});

self.addEventListener('activate', function (evento) {
  evento.waitUntil(caches.keys().then(function (nomes) {
    return Promise.all(nomes.filter(function (nome) {
      return nome.indexOf('catequese-') === 0 && nome !== CACHE;
    }).map(function (nome) { return caches.delete(nome); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (evento) {
  if (evento.data === 'ATIVAR') self.skipWaiting();
  if (evento.data === 'VERSAO' && evento.source) evento.source.postMessage({ versao: VERSAO });
});

self.addEventListener('fetch', function (evento) {
  var pedido = evento.request;
  if (pedido.method !== 'GET') return;                       // chamadas ao servidor: direto para a rede
  var url = new URL(pedido.url);
  if (url.origin !== self.location.origin) return;           // nada de outros sites

  if (url.pathname.slice(-10) === '/config.js') {            // rede primeiro, cópia guardada se estiver sem internet
    evento.respondWith(fetch(pedido).then(function (resposta) {
      if (resposta.ok) {
        var copia = resposta.clone();
        caches.open(CACHE).then(function (cache) { cache.put('config.js', copia); });
      }
      return resposta;
    }).catch(function () {
      return caches.match('config.js', { ignoreSearch: true });
    }));
    return;
  }

  // Interface: guardada primeiro (abre na hora e sem internet). Parâmetros (?s=1, ?expirou=1) não mudam o arquivo.
  evento.respondWith(caches.match(pedido, { ignoreSearch: true }).then(function (guardado) {
    if (guardado) return guardado;
    return fetch(pedido).catch(function () {
      if (pedido.mode === 'navigate') return caches.match('index.html');
      throw new Error('Sem conexão e arquivo não guardado: ' + url.pathname);
    });
  }));
});
