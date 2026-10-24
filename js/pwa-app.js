/**
 * pwa-fonte/js/pwa-app.js — SÓ do aplicativo instalável (PWA — Etapa 3). Não vai para o Apps Script.
 * Carregado no fim do login (index.html) e do sistema (app.html), depois de todos os scripts do sistema.
 *
 * 1. Registra o service worker (sw.js) e avisa quando há versão nova. A troca só acontece quando a pessoa toca
 *    em "Atualizar": nunca recarrega a tela sozinho no meio de um trabalho.
 * 2. Mostra "Sem conexão" quando o aparelho fica sem internet OU quando uma chamada ao servidor falha por falta
 *    de rede. Enquanto isso, testa o servidor (apiPing) em intervalos crescentes — só com o aplicativo na tela —
 *    e avisa "Conexão restabelecida" quando ele volta a responder. Ao voltar, confere a sessão de novo.
 * 3. No login, oferece "Instalar o aplicativo" (Android/computador) ou explica como adicionar à tela de início
 *    (iPhone/iPad).
 * Nada aqui muda regra de negócio nem dado: só avisos e o ciclo de vida do aplicativo.
 */
(function () {
  var INTERVALOS_PING_MS = [5000, 15000, 30000, 60000];
  var INTERVALO_PING_DEPOIS_MS = 120000;
  var VERIFICAR_VERSAO_MS = 30 * 60 * 1000;

  // ---------- Avisos na tela ----------
  function aviso(id, classe) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = classe;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  }

  // ---------- Conexão ----------
  var semConexao = false;
  var tentativa = 0;
  var temporizador = null;
  var pingEmCurso = false;
  var esconderAviso = null;

  function mostrarConexao(texto, voltou) {
    var el = aviso('pwa-aviso-conexao', 'pwa-aviso-conexao');
    el.classList.toggle('pwa-aviso-conexao--voltou', !!voltou);
    el.innerHTML = '<i class="fa-solid ' + (voltou ? 'fa-wifi' : 'fa-plug-circle-xmark') + '" aria-hidden="true"></i> ';
    el.appendChild(document.createTextNode(texto));
    el.hidden = false;
  }

  function marcarSemConexao() {
    if (semConexao) return;
    semConexao = true;
    clearTimeout(esconderAviso);
    mostrarConexao('Sem conexão com a internet', false);
    tentativa = 0;
    agendarPing();
  }

  function marcarConectado() {
    if (!semConexao) return;
    semConexao = false;
    clearTimeout(temporizador);
    mostrarConexao('Conexão restabelecida', true);
    esconderAviso = setTimeout(function () {
      var el = document.getElementById('pwa-aviso-conexao');
      if (el) el.hidden = true;
    }, 3500);
    // A sessão pode ter vencido enquanto estava sem internet: se venceu, chamarApi leva ao login (aoSessaoExpirar).
    if (typeof TOKEN !== 'undefined' && TOKEN && typeof aoSessaoExpirar === 'function') {
      chamarApi('apiValidarSessao', TOKEN).catch(function () { /* o próprio chamarApi cuida da sessão vencida */ });
    }
    // Etapa 7: a fila envia o que estiver pendente e a consulta se atualiza (pwa-fila.js, pwa-dados.js).
    document.dispatchEvent(new CustomEvent('catequese:conexao-voltou'));
  }

  function agendarPing() {
    clearTimeout(temporizador);
    var espera = tentativa < INTERVALOS_PING_MS.length ? INTERVALOS_PING_MS[tentativa] : INTERVALO_PING_DEPOIS_MS;
    temporizador = setTimeout(pingar, espera);
  }

  function pingar() {
    if (!semConexao || pingEmCurso) return;
    if (document.hidden) return; // volta a tentar quando o aplicativo aparecer de novo (visibilitychange)
    pingEmCurso = true;
    tentativa++;
    chamarApi('apiPing').then(function () {
      pingEmCurso = false; // marcarConectado já foi chamado pelo chamarApi abaixo
    }, function () {
      pingEmCurso = false;
      if (semConexao) agendarPing();
    });
  }

  // Toda chamada ao servidor informa o estado da conexão: falha de rede = sem conexão; qualquer resposta = conectado.
  if (typeof window.chamarApi === 'function') {
    var chamarApiOriginal = window.chamarApi;
    window.chamarApi = function () {
      return chamarApiOriginal.apply(this, arguments).then(function (dados) {
        marcarConectado();
        return dados;
      }, function (erro) {
        if (erro && erro.semConexao) marcarSemConexao(); else marcarConectado();
        throw erro;
      });
    };
  }

  // Etapa 4: uma tela recebeu dados guardados no aparelho (pwa-dados.js) — o aviso diz de quando são.
  document.addEventListener('catequese:dados-salvos', function (evento) {
    var d = new Date(evento.detail.salvoEm);
    function dois(n) { return (n < 10 ? '0' : '') + n; }
    var quando = dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ', ' + dois(d.getHours()) + ':' + dois(d.getMinutes());
    if (!semConexao) { semConexao = true; tentativa = 0; agendarPing(); } // servidor lento demais: trata como sem conexão
    clearTimeout(esconderAviso);
    mostrarConexao('Sem conexão · dados de ' + quando, false);
  });

  window.addEventListener('offline', marcarSemConexao);
  window.addEventListener('online', function () { if (semConexao) { tentativa = 0; pingar(); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && semConexao) pingar(); });
  if (navigator.onLine === false) {
    if (document.body) marcarSemConexao(); else document.addEventListener('DOMContentLoaded', marcarSemConexao);
  }

  // ---------- Versão nova ----------
  var atualizacaoPedida = false;

  function avisarNovaVersao(registro) {
    var el = aviso('pwa-aviso-versao', 'pwa-aviso-versao');
    el.innerHTML =
      '<span><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Nova versão do aplicativo disponível.</span>' +
      '<span class="pwa-aviso-versao__acoes">' +
      '<button type="button" class="btn btn-link btn-sm" data-acao="depois">Depois</button>' +
      '<button type="button" class="btn btn-primario btn-sm" data-acao="atualizar">Atualizar</button></span>';
    el.hidden = false;
    el.querySelector('[data-acao="depois"]').addEventListener('click', function () { el.hidden = true; });
    el.querySelector('[data-acao="atualizar"]').addEventListener('click', function () {
      var espera = registro.waiting;
      if (!espera) { window.location.reload(); return; }
      atualizacaoPedida = true;
      this.disabled = true;
      this.textContent = 'Atualizando…';
      espera.postMessage('ATIVAR');
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (atualizacaoPedida) { atualizacaoPedida = false; window.location.reload(); }
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (registro) {
        if (registro.waiting && navigator.serviceWorker.controller) avisarNovaVersao(registro);
        registro.addEventListener('updatefound', function () {
          var nova = registro.installing;
          if (!nova) return;
          nova.addEventListener('statechange', function () {
            // Com um controlador ativo, "installed" = versão nova esperando. Sem controlador é a primeira instalação.
            if (nova.state === 'installed' && navigator.serviceWorker.controller) avisarNovaVersao(registro);
          });
        });
        function verificar() { if (!document.hidden && navigator.onLine !== false) registro.update().catch(function () {}); }
        document.addEventListener('visibilitychange', verificar);
        setInterval(verificar, VERIFICAR_VERSAO_MS);
      }).catch(function () { /* navegador sem suporte ou bloqueado: o aplicativo funciona como site comum */ });
    });
  }

  // ---------- Instalar (só na tela de login) ----------
  var corpoLogin = document.querySelector('.corpo-login');
  var jaInstalado = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (!corpoLogin || jaInstalado) return;

  var area = document.createElement('div');
  area.className = 'pwa-instalar';
  area.hidden = true;
  var rodape = corpoLogin.querySelector('.rodape-sistema');
  corpoLogin.insertBefore(area, rodape);

  var ehAppleMovel = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad se apresenta como Mac
  if (ehAppleMovel) {
    area.innerHTML = '<i class="fa-solid fa-mobile-screen" aria-hidden="true"></i> ' +
      '<span>Para instalar: toque em <strong>Compartilhar</strong> <i class="fa-solid fa-arrow-up-from-bracket" aria-label="(ícone de compartilhar)"></i> ' +
      'e depois em <strong>Adicionar à Tela de Início</strong>.</span>';
    area.hidden = false;
    return;
  }

  var pedidoDeInstalacao = null;
  window.addEventListener('beforeinstallprompt', function (evento) {
    evento.preventDefault();
    pedidoDeInstalacao = evento;
    area.innerHTML = '<button type="button" class="btn btn-outline-primary w-100">' +
      '<i class="fa-solid fa-download" aria-hidden="true"></i> Instalar o aplicativo neste aparelho</button>';
    area.hidden = false;
    area.querySelector('button').addEventListener('click', function () {
      if (!pedidoDeInstalacao) return;
      pedidoDeInstalacao.prompt();
      pedidoDeInstalacao.userChoice.then(function () { pedidoDeInstalacao = null; area.hidden = true; });
    });
  });
  window.addEventListener('appinstalled', function () { area.hidden = true; });
})();
