/**
 * pwa-fonte/js/pwa-inicio.js — SÓ do aplicativo instalável (site próprio). Não vai para o Apps Script.
 *
 * Faz, no aplicativo, o papel da linha <script>var URL_BASE = '<?= ... ?>' ...</script> que o template do
 * Apps Script monta no servidor: define URL_BASE (endereço do servidor, usado no link público de inscrição)
 * e lê da própria URL os mesmos parâmetros que o Router repassa às páginas (s, manter, expirou).
 * Roda logo depois de config.js e antes de todos os outros scripts.
 */
(function () {
  var configurado = typeof CONFIG_PWA !== 'undefined' &&
    /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(CONFIG_PWA.urlServidor || '');

  if (!configurado) {
    // Sem o endereço do servidor o aplicativo não tem com quem falar: explica e para aqui.
    if (typeof CONFIG_PWA !== 'undefined') CONFIG_PWA.urlServidor = '';
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML =
        '<div style="max-width:520px;margin:48px auto;padding:0 16px;font-family:system-ui,sans-serif;text-align:center;">' +
        '<h1 style="font-size:1.25rem;">Aplicativo ainda não configurado</h1>' +
        '<p>Falta informar o endereço do servidor no arquivo <strong>config.js</strong> deste site ' +
        '(a URL do app da Web do Apps Script, terminando em /exec).</p></div>';
    });
    throw new Error('CONFIG_PWA.urlServidor ausente ou inválido.');
  }

  // Versão do site (gerada pelo montador na própria página) — vai em cada chamada ao servidor (campo "v").
  if (typeof VERSAO_APP !== 'undefined') CONFIG_PWA.versao = VERSAO_APP;

  var parametros = new URLSearchParams(window.location.search);
  window.URL_BASE = CONFIG_PWA.urlServidor;
  window.VEIO_DO_LOGIN = parametros.get('s') === '1';
  window.MANTER_PADRAO = parametros.get('manter') === '1';
  window.SESSAO_EXPIROU = parametros.get('expirou') === '1';
})();
