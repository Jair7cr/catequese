/**
 * pwa-fonte/js/pwa-sessao.js — SÓ do aplicativo instalável ("Lembrar este aparelho", aprovado em 27/10/2026: 30 dias,
 * só perfil Catequista). Não vai para o Apps Script. Carregado só no sistema (app.html), por ÚLTIMO.
 *
 * - Com "Manter conectado" e perfil permitido, pede ao servidor a CHAVE DO APARELHO (apiLembrarAparelho) e a guarda neste
 *   aparelho. Sem "Manter conectado" ou com outro perfil, nada é guardado (e o que houver é cancelado).
 * - Quando uma chamada ao servidor volta com "Sessão inválida/expirada", usa a chave para entrar de novo sem senha
 *   (apiRenovarSessao) e REPETE a mesma chamada com a sessão nova — a pessoa não percebe. Uma renovação por vez.
 *   Se o servidor recusar a chave (venceu, senha trocada, usuário inativado...), apaga a chave e segue o caminho de
 *   sempre: volta ao login com o aviso de sessão expirada.
 * - Sair (e qualquer fim de sessão, via Sessao.encerrar) cancela a chave no servidor (apiEsquecerAparelho) e a apaga daqui.
 * - Avisa a fila de envio quando a sessão foi renovada (evento catequese:sessao-renovada), para ela enviar o pendente.
 */
(function () {
  var CHAVE_LOCAL = 'catequese_aparelho';
  var PERFIS = ['CATEQUISTA']; // o servidor também confere (APARELHO_LEMBRADO_PERFIS)
  var usuario = (typeof USUARIO !== 'undefined' && USUARIO) || null;
  if (!usuario || typeof window.chamarApi !== 'function') return;

  function lerChave() {
    try {
      var g = JSON.parse(localStorage.getItem(CHAVE_LOCAL) || 'null');
      if (!g || !g.chave || g.usuarioId !== usuario.id) return null;
      if (Date.parse(g.expiraEm) <= Date.now()) return null;
      return g;
    } catch (e) { return null; }
  }
  function guardarChave(chave, expiraEm) {
    try { localStorage.setItem(CHAVE_LOCAL, JSON.stringify({ chave: chave, usuarioId: usuario.id, expiraEm: expiraEm })); } catch (e) { /* sem armazenamento */ }
  }
  function apagarChave() { try { localStorage.removeItem(CHAVE_LOCAL); } catch (e) { /* nada */ } }

  /** Cancela no servidor sem esperar resposta (funciona mesmo com a página trocando logo em seguida). */
  function cancelarNoServidor(chave) {
    try {
      fetch(CONFIG_PWA.urlServidor, {
        method: 'POST', mode: 'no-cors', keepalive: true, credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ op: 'apiEsquecerAparelho', args: [chave], v: CONFIG_PWA.versao || '' })
      }).catch(function () {});
    } catch (e) { /* sem rede: a chave vence sozinha em até 30 dias */ }
  }

  function esquecerAparelho() {
    var g = null;
    try { g = JSON.parse(localStorage.getItem(CHAVE_LOCAL) || 'null'); } catch (e) { g = null; }
    if (g && g.chave) cancelarNoServidor(g.chave);
    apagarChave();
  }

  // ---------- Fim de sessão (Sair, sessão sem renovação...): cancela a chave ----------
  var encerrarAnterior = Sessao.encerrar;
  Sessao.encerrar = function () {
    esquecerAparelho();
    return encerrarAnterior.apply(this, arguments);
  };

  var podeLembrar = PERFIS.indexOf(usuario.perfil) !== -1 && Sessao.mantida();
  if (!podeLembrar) {
    esquecerAparelho(); // outro perfil ou sessão só da aba: nenhuma chave neste aparelho
    return;
  }

  // ---------- Renovação ----------
  var chamarApiAnterior = window.chamarApi;
  var renovacaoEmCurso = null;

  /** @return {Promise<?string>} o token novo, ou null se não deu para renovar. */
  function renovar() {
    if (renovacaoEmCurso) return renovacaoEmCurso;
    var g = lerChave();
    if (!g) return Promise.resolve(null);
    renovacaoEmCurso = chamarApiAnterior('apiRenovarSessao', g.chave).then(function (dados) {
      var atual = Sessao.usuario() || {};
      atual.id = dados.usuario.id;
      atual.nome = dados.usuario.nome;
      atual.perfil = dados.usuario.perfil;
      atual.trocaSenhaPendente = false;
      Sessao.iniciar(dados.token, atual, true); // continua "Manter conectado" (não passa por Sessao.encerrar)
      window.TOKEN = dados.token;
      if (typeof USUARIO !== 'undefined' && USUARIO) { USUARIO.nome = atual.nome; USUARIO.perfil = atual.perfil; }
      document.dispatchEvent(new CustomEvent('catequese:sessao-renovada'));
      return dados.token;
    }, function (erro) {
      if (!(erro && erro.semConexao)) apagarChave(); // recusada pelo servidor: não serve mais
      return null;
    }).then(function (token) { renovacaoEmCurso = null; return token; });
    return renovacaoEmCurso;
  }

  function ehErroDeSessao(erro) { return !!(erro && /^Sessão (inválida|expirada)/.test(erro.message || '')); }

  // A camada de sempre (js/core/api.js) chama aoSessaoExpirar ao ver "Sessão expirada" e leva ao login. Com a chave
  // do aparelho, primeiro tenta renovar; só leva ao login se não der.
  var aoSessaoExpirarOriginal = window.aoSessaoExpirar;
  if (typeof aoSessaoExpirarOriginal === 'function') {
    window.aoSessaoExpirar = function () {
      if (!lerChave()) return aoSessaoExpirarOriginal.apply(this, arguments);
      var self = this, args = arguments;
      renovar().then(function (token) { if (!token) aoSessaoExpirarOriginal.apply(self, args); });
    };
  }

  // Toda chamada: se voltar "Sessão expirada" e a renovação der certo, repete a chamada com o token novo.
  window.chamarApi = function (op) {
    var self = this, args = Array.prototype.slice.call(arguments);
    return chamarApiAnterior.apply(self, args).catch(function (erro) {
      if (!ehErroDeSessao(erro) || op === 'apiLogout' || !lerChave() && !renovacaoEmCurso) throw erro;
      var tokenUsado = args[1];
      return renovar().then(function (token) {
        if (!token) throw erro;
        if (tokenUsado && tokenUsado !== token) args[1] = token;
        return chamarApiAnterior.apply(self, args);
      });
    });
  };

  // ---------- Pedir a chave (uma vez por aparelho e login) ----------
  function pedirChaveSeFaltar() {
    if (lerChave() || navigator.onLine === false) return;
    var token = Sessao.token();
    if (!token) return;
    chamarApiAnterior('apiLembrarAparelho', token).then(function (dados) {
      if (dados && dados.chave) guardarChave(dados.chave, dados.expiraEm);
    }, function () { /* sem rede ou servidor antigo: tenta numa próxima abertura */ });
  }
  window.addEventListener('load', function () { setTimeout(pedirChaveSeFaltar, 2000); });
  document.addEventListener('catequese:conexao-voltou', function () { setTimeout(pedirChaveSeFaltar, 1500); });

  window.LembrarAparelho = { renovar: renovar, temChave: function () { return !!lerChave(); } };
})();
