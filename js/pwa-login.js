/**
 * pwa-fonte/js/pwa-login.js — SÓ do aplicativo instalável. Não vai para o Apps Script.
 *
 * 1. Identidade da paróquia no login. No Apps Script, nome e cores chegam pelo template (Router.gs). No
 *    aplicativo, a página é estática: mostra a última identidade guardada no aparelho (abre na hora, inclusive
 *    sem internet) e pede a atual ao servidor (apiIdentidadePublica — só nome e cores, nada sensível).
 * 2. Quem já tem sessão guardada ("Manter conectado") vai direto para o sistema ao abrir o aplicativo, em vez
 *    de ver o login toda vez. O sistema confere a sessão no servidor e volta ao login se ela não valer mais.
 */
(function () {
  var CHAVE = 'catequese_identidade_v1';
  var COR = /^#[0-9a-f]{6}$/i;
  var COR_SUAVE = /^rgba\(\d{1,3}, ?\d{1,3}, ?\d{1,3}, ?(0|1|0?\.\d+)\)$/;

  function aplicar(id) {
    if (!id) return;
    var raiz = document.documentElement.style;
    if (COR.test(id.cor || '')) raiz.setProperty('--cor-identidade', id.cor);
    if (COR.test(id.destaque || '')) raiz.setProperty('--cor-destaque', id.destaque);
    if (COR.test(id.sobreCor || '')) raiz.setProperty('--cor-sobre-identidade', id.sobreCor);
    if (COR_SUAVE.test(id.sobreCorSuave || '')) raiz.setProperty('--cor-sobre-identidade-suave', id.sobreCorSuave);
    if (typeof id.nome === 'string' && id.nome) {
      document.querySelectorAll('.nome-paroquia').forEach(function (el) { el.textContent = id.nome; });
    }
  }

  function lerGuardada() {
    try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch (e) { return null; }
  }

  function guardar(id) {
    try { localStorage.setItem(CHAVE, JSON.stringify(id)); } catch (e) { /* sem armazenamento: segue sem guardar */ }
  }

  // Sessão guardada e válida no aparelho: abre o sistema direto (o sistema valida no servidor).
  var usuario = Sessao.usuario();
  if (Sessao.token() && usuario && !usuario.trocaSenhaPendente && !SESSAO_EXPIROU && !MANTER_PADRAO) {
    window.location.replace(urlDaPagina('app', Sessao.mantida() ? {} : { s: '1' }));
    return;
  }

  aplicar(lerGuardada());
  chamarApi('apiIdentidadePublica')
    .then(function (id) { aplicar(id); guardar(id); })
    .catch(function () { /* sem internet ou servidor fora: fica a identidade guardada (ou a padrão) */ });
})();
