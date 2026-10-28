/**
 * pwa-fonte/js/pwa-fila.js — SÓ do aplicativo instalável (PWA — Etapa 6: fila de envio). Não vai para o Apps Script.
 * Carregado só no sistema (app.html), depois de pwa-dados.js.
 *
 * O QUE FAZ: quando o catequista salva a CHAMADA (ou marca o encontro como realizado) sem internet, em vez do erro
 * "Sem conexão", a gravação fica guardada no aparelho, numa fila, e a tela mostra "guardada; será enviada". A chamada
 * guardada aparece na próxima vez que for aberta, mesmo sem internet. Um indicador ("N aguardando envio") abre a lista
 * dos envios, com o botão "Enviar agora". Etapa 7: o envio também é automático — ao abrir o aplicativo, quando a conexão
 * volta e quando o aplicativo volta para a tela (ver "Envio automático", no fim).
 *
 * REGRAS:
 * - Só para quem usa sem internet (perfil CATEQUISTA com "Manter conectado"), como em pwa-dados.js.
 * - Só operações seguras de repetir, que o servidor aceita com chave (core/ApiHttp.gs, OPERACOES_COM_CHAVE).
 * - Cada envio leva uma CHAVE única (o servidor não aplica a mesma duas vezes — Etapa 5) e, na chamada, a
 *   DATA_ALTERACAO de cada registro como estava quando foi aberta (DATA_ALTERACAO_BASE), para o servidor apontar
 *   conflito. Regra aprovada: vale a chamada do catequista; o aplicativo mostra o aviso de conflito que o servidor manda.
 * - Envia na ordem em que foram feitos. Recusado pelo servidor (ex.: fora do prazo, sem permissão): fica marcado com o
 *   motivo, nunca é descartado em silêncio — a pessoa decide descartar. Sessão vencida: a fila fica guardada e é
 *   enviada depois de entrar de novo. Sair com envios pendentes pede confirmação.
 * - Banco próprio (catequese-fila), separado dos dados de consulta: limpar a consulta nunca apaga envios pendentes.
 */
(function () {
  var BANCO = 'catequese-fila';
  var BANCO_DADOS = 'catequese-dados';
  var PERFIS_OFFLINE = ['CATEQUISTA'];
  var OPERACOES = {
    apiSalvarFrequencias: true, apiMarcarEncontroRealizado: true,
    apiSalvarAvaliacoes: true, apiDefinirAvaliacaoEsperada: true // avaliação sem internet (27/10/2026)
  };
  var ROTULOS = {
    apiSalvarFrequencias: 'Chamada do ',
    apiMarcarEncontroRealizado: 'Marcar como realizado: ',
    apiSalvarAvaliacoes: 'Avaliação do '
  };
  var MENSAGENS = {
    apiSalvarFrequencias: 'Sem internet: a chamada foi guardada no aparelho e será enviada quando a conexão voltar.',
    apiMarcarEncontroRealizado: 'Sem internet: guardado no aparelho; o encontro será marcado como realizado quando a conexão voltar.',
    apiSalvarAvaliacoes: 'Sem internet: a avaliação foi guardada no aparelho e será enviada quando a conexão voltar.',
    apiDefinirAvaliacaoEsperada: 'Sem internet: guardado no aparelho; a mudança em "avaliação esperada" será enviada quando a conexão voltar.'
  };

  var usuario = (typeof USUARIO !== 'undefined' && USUARIO) || null;
  if (!window.indexedDB || !usuario || !usuario.id) return;
  var podeGuardar = PERFIS_OFFLINE.indexOf(usuario.perfil) !== -1 && Sessao.mantida();

  // ---------- Banco da fila ----------
  var bancoAberto = null;
  function abrir() {
    if (!bancoAberto) {
      bancoAberto = new Promise(function (resolve, reject) {
        var pedido = indexedDB.open(BANCO, 1);
        pedido.onupgradeneeded = function () { pedido.result.createObjectStore('envios', { keyPath: 'chave' }); };
        pedido.onsuccess = function () { resolve(pedido.result); };
        pedido.onerror = function () { reject(pedido.error); };
      });
    }
    return bancoAberto;
  }

  function transacao(modo, acao) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('envios', modo);
        var pedido = acao(tx.objectStore('envios'));
        tx.oncomplete = function () { resolve(pedido ? pedido.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  /** Envios desta pessoa, do mais antigo para o mais novo. */
  function listar() {
    return transacao('readonly', function (s) { return s.getAll(); }).then(function (todos) {
      return (todos || []).filter(function (e) { return e.usuarioId === usuario.id; })
        .sort(function (a, b) { return a.criadoEm - b.criadoEm; });
    });
  }
  function guardar(envio) { return transacao('readwrite', function (s) { return s.put(envio); }); }
  function remover(chave) { return transacao('readwrite', function (s) { return s.delete(chave); }); }

  function novaChave() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  // ---------- Dados de consulta (pwa-dados.js): base da chamada, rótulos e atualização local ----------
  function comDados(modo, acao) {
    return new Promise(function (resolve) {
      var pedido = indexedDB.open(BANCO_DADOS);
      pedido.onupgradeneeded = function () { pedido.transaction.abort(); }; // não existe: não cria
      pedido.onerror = function () { resolve(null); };
      pedido.onsuccess = function () {
        var db = pedido.result;
        if (!db.objectStoreNames.contains('respostas')) { db.close(); resolve(null); return; }
        var tx = db.transaction('respostas', modo);
        var resultado = acao(tx.objectStore('respostas'));
        tx.oncomplete = function () { db.close(); resolve(resultado && 'result' in resultado ? resultado.result : resultado); };
        tx.onerror = tx.onabort = function () { db.close(); resolve(null); };
      };
    }).catch(function () { return null; });
  }

  function chaveDados(op, argsSemToken) { return op + '|' + JSON.stringify(argsSemToken); }

  function chamadaGuardada(encontroId) {
    return comDados('readonly', function (s) { return s.get(chaveDados('apiAbrirChamada', [encontroId])); });
  }

  function avaliacaoGuardada(encontroId) {
    return comDados('readonly', function (s) { return s.get(chaveDados('apiAbrirAvaliacao', [encontroId])); });
  }

  /** Título e data do encontro, procurados nas listas de encontros guardadas. */
  function descreverEncontro(encontroId) {
    return comDados('readonly', function (s) { return s.getAll(); }).then(function (todos) {
      var achado = null;
      (todos || []).forEach(function (r) {
        if (r.op !== 'apiListarEncontros' || !Array.isArray(r.dados)) return;
        r.dados.forEach(function (e) { if (e.ID === encontroId) achado = e; });
      });
      if (!achado) return 'encontro';
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(achado.DATA_ENCONTRO || ''));
      return '“' + (achado.TITULO || 'encontro') + '”' + (m ? ' (' + m[3] + '/' + m[2] + ')' : '');
    });
  }

  /** Atualiza a cópia de consulta para a tela mostrar o que foi feito, mesmo sem internet. */
  function refletirNaConsulta(op, args) {
    return comDados('readwrite', function (s) {
      if (op === 'apiSalvarFrequencias') {
        var chave = chaveDados('apiAbrirChamada', [args[0]]);
        var pedido = s.get(chave);
        pedido.onsuccess = function () {
          var reg = pedido.result;
          if (!reg || !Array.isArray(reg.dados)) return;
          var novos = {};
          args[1].forEach(function (i) { novos[i.CATEQUIZANDO_ID] = i; });
          reg.dados.forEach(function (item) {
            var n = novos[item.CATEQUIZANDO_ID];
            if (n && item.EDITAVEL !== false) { item.SITUACAO = n.SITUACAO; item.JUSTIFICATIVA = n.JUSTIFICATIVA || ''; }
          });
          s.put(reg);
        };
      } else if (op === 'apiSalvarAvaliacoes') {
        var chaveAv = chaveDados('apiAbrirAvaliacao', [args[0]]);
        var pedidoAv = s.get(chaveAv);
        pedidoAv.onsuccess = function () {
          var reg = pedidoAv.result;
          if (!reg || !Array.isArray(reg.dados)) return;
          var novas = {};
          args[1].forEach(function (i) { novas[i.CATEQUIZANDO_ID] = i; });
          reg.dados.forEach(function (item) {
            var n = novas[item.CATEQUIZANDO_ID];
            if (!n) return;
            item.PARTICIPACAO = n.PARTICIPACAO || ''; item.COMPORTAMENTO = n.COMPORTAMENTO || '';
            item.COMPROMISSOS = n.COMPROMISSOS || ''; item.OBSERVACOES = n.OBSERVACOES || '';
          });
          s.put(reg);
        };
      } else if (op === 'apiDefinirAvaliacaoEsperada') {
        var listas = s.getAll();
        listas.onsuccess = function () {
          var valor = args[1] === true || args[1] === 'SIM' ? 'SIM' : 'NAO';
          (listas.result || []).forEach(function (r) {
            if (r.op !== 'apiListarEncontros' || !Array.isArray(r.dados)) return;
            var mudou = false;
            r.dados.forEach(function (e) { if (e.ID === args[0] && e.POSSUI_AVALIACAO !== valor) { e.POSSUI_AVALIACAO = valor; mudou = true; } });
            if (mudou) s.put(r);
          });
        };
      } else if (op === 'apiMarcarEncontroRealizado') {
        var todos = s.getAll();
        todos.onsuccess = function () {
          (todos.result || []).forEach(function (r) {
            if (r.op !== 'apiListarEncontros' || !Array.isArray(r.dados)) return;
            var mudou = false;
            r.dados.forEach(function (e) { if (e.ID === args[0] && e.REALIZADO !== 'SIM') { e.REALIZADO = 'SIM'; mudou = true; } });
            if (mudou) s.put(r);
          });
        };
      }
      return null;
    });
  }

  // ---------- Pôr na fila ----------
  function porNaFila(op, argsSemToken) {
    var encontroId = argsSemToken[0];
    var preparo = Promise.resolve(argsSemToken);
    if (op === 'apiSalvarFrequencias') {
      // Base de cada registro: como estava quando a chamada foi aberta (servidor da Etapa 5 manda DATA_ALTERACAO).
      preparo = chamadaGuardada(encontroId).then(function (reg) {
        var base = {};
        ((reg && reg.dados) || []).forEach(function (i) { if (i.DATA_ALTERACAO !== undefined) base[i.CATEQUIZANDO_ID] = i.DATA_ALTERACAO; });
        var lista = argsSemToken[1].map(function (item) {
          var copia = { CATEQUIZANDO_ID: item.CATEQUIZANDO_ID, SITUACAO: item.SITUACAO, JUSTIFICATIVA: item.JUSTIFICATIVA || '' };
          if (Object.prototype.hasOwnProperty.call(base, item.CATEQUIZANDO_ID)) copia.DATA_ALTERACAO_BASE = base[item.CATEQUIZANDO_ID];
          return copia;
        });
        return [encontroId, lista];
      });
    } else if (op === 'apiSalvarAvaliacoes') {
      // Mesma ideia da chamada: a DATA_ALTERACAO de cada avaliação como estava quando o formulário foi aberto.
      preparo = avaliacaoGuardada(encontroId).then(function (reg) {
        var base = {};
        ((reg && reg.dados) || []).forEach(function (i) { if (i.DATA_ALTERACAO !== undefined) base[i.CATEQUIZANDO_ID] = i.DATA_ALTERACAO; });
        var lista = argsSemToken[1].map(function (item) {
          var copia = {
            CATEQUIZANDO_ID: item.CATEQUIZANDO_ID, PARTICIPACAO: item.PARTICIPACAO || '', COMPORTAMENTO: item.COMPORTAMENTO || '',
            COMPROMISSOS: item.COMPROMISSOS || '', OBSERVACOES: item.OBSERVACOES || ''
          };
          if (Object.prototype.hasOwnProperty.call(base, item.CATEQUIZANDO_ID)) copia.DATA_ALTERACAO_BASE = base[item.CATEQUIZANDO_ID];
          return copia;
        });
        return [encontroId, lista];
      });
    }
    return Promise.all([preparo, descreverEncontro(encontroId)]).then(function (r) {
      var args = r[0];
      var envio = {
        chave: novaChave(),
        usuarioId: usuario.id,
        op: op,
        args: args,
        rotulo: op === 'apiDefinirAvaliacaoEsperada'
          ? (r[0][1] === true || r[0][1] === 'SIM' ? 'Avaliação esperada (ligar): ' : 'Avaliação esperada (desligar): ') + r[1]
          : ROTULOS[op] + r[1],
        criadoEm: Date.now(),
        situacao: 'AGUARDANDO',
        motivo: ''
      };
      return guardar(envio).then(function () { return refletirNaConsulta(op, args); }).then(function () {
        atualizarIndicador();
        return envio;
      });
    });
  }

  if (podeGuardar && typeof window.chamarApi === 'function') {
    var chamarApiAnterior = window.chamarApi;
    window.chamarApi = function (op) {
      if (!OPERACOES[op]) return chamarApiAnterior.apply(this, arguments);
      var argsSemToken = Array.prototype.slice.call(arguments, 2);
      return chamarApiAnterior.apply(this, arguments).catch(function (erro) {
        if (!erro || !erro.semConexao) throw erro;
        return porNaFila(op, argsSemToken).then(function () {
          return {
            naFila: true,
            mensagem: MENSAGENS[op]
          };
        }, function () { throw erro; }); // não conseguiu guardar: mostra o erro de sempre
      });
    };
  }

  // ---------- Enviar ----------
  var enviando = false;

  function enviarUm(envio, token) {
    return fetch(CONFIG_PWA.urlServidor, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ op: envio.op, args: [token].concat(envio.args), v: CONFIG_PWA.versao || '', chave: envio.chave }),
      credentials: 'omit',
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) return { transitorio: true, message: 'O servidor respondeu com erro (' + r.status + ').' };
      return r.json().catch(function () { return { transitorio: true, message: 'Resposta inesperada do servidor.' }; });
    }, function () {
      return { semConexao: true };
    });
  }

  /**
   * Envia os envios desta pessoa, em ordem. Devolve um resumo:
   * { enviados, conflitos: [mensagens], recusados, parouPor: ''|'semConexao'|'sessao' }.
   */
  /** @param {{automatico: boolean}} [opcoes] automático (Etapa 7) não reenvia o que o servidor já recusou. */
  function enviarFila(opcoes) {
    var automatico = !!(opcoes && opcoes.automatico);
    if (enviando) return Promise.resolve(null);
    var token = Sessao.token();
    if (!token) return Promise.resolve({ enviados: 0, conflitos: [], recusados: 0, parouPor: 'sessao' });
    enviando = true;
    var resumo = { enviados: 0, conflitos: [], foraDoPrazo: [], recusados: 0, parouPor: '' };
    return listar().then(function (envios) {
      if (automatico) envios = envios.filter(function (e) { return e.situacao !== 'RECUSADO'; });
      return envios.reduce(function (anterior, envio) {
        return anterior.then(function () {
          if (resumo.parouPor) return;
          return enviarUm(envio, token).then(function (r) {
            if (r.semConexao) { resumo.parouPor = 'semConexao'; return; }
            if (r.transitorio || r.emAndamento) return; // fica para a próxima tentativa
            if (r.success) {
              resumo.enviados++;
              if (r.data && r.data.conflitos && r.data.conflitos.length) resumo.conflitos.push(envio.rotulo + ': ' + r.message);
              // Aceito, mas parte dos registros ficou de fora (prazo de 48 h da chamada): a pessoa PRECISA saber — o que
              // ela lançou sem internet não foi gravado para esses catequizandos (FrequenciasService.salvar).
              if (/fora do prazo/i.test(r.message || '')) resumo.foraDoPrazo.push(envio.rotulo + ': ' + r.message);
              return remover(envio.chave);
            }
            if (/^Sessão (inválida|expirada)/.test(r.message || '') || /nova senha/.test(r.message || '')) {
              resumo.parouPor = 'sessao';
              return;
            }
            resumo.recusados++;
            envio.situacao = 'RECUSADO';
            envio.motivo = r.message || 'O servidor não aceitou este envio.';
            return guardar(envio);
          });
        });
      }, Promise.resolve());
    }).then(function () {
      enviando = false;
      atualizarIndicador();
      if (resumo.enviados) document.dispatchEvent(new CustomEvent('catequese:fila-enviada', { detail: resumo }));
      return resumo;
    }, function (erro) {
      enviando = false;
      throw erro;
    });
  }

  function avisarResumo(resumo, automatico) {
    if (!resumo) return;
    if (automatico && resumo.parouPor === 'semConexao') resumo = Object.assign({}, resumo, { parouPor: '' }); // em silêncio
    if (resumo.enviados) exibirToast(resumo.enviados === 1 ? '1 envio pendente foi concluído.' : resumo.enviados + ' envios pendentes foram concluídos.');
    // Fora do prazo: aviso que fica na tela até ser fechado (há registros que NÃO foram gravados). Se a mesma mensagem
    // também trouxe conflito, aparece uma vez só, neste formato (o mais importante dos dois).
    var foraDoPrazo = resumo.foraDoPrazo || [];
    resumo.conflitos.forEach(function (texto) { if (foraDoPrazo.indexOf(texto) === -1) exibirToast(texto, false, 'aviso'); });
    foraDoPrazo.forEach(function (texto) { exibirToast(texto, true); });
    if (resumo.recusados) exibirToast((resumo.recusados === 1 ? '1 envio não foi aceito' : resumo.recusados + ' envios não foram aceitos') + ' pelo servidor. Veja o motivo em “aguardando envio”.', false, 'aviso'); // o indicador fica em alerta
    if (resumo.parouPor === 'semConexao') exibirToast('Sem conexão com o servidor. Os envios continuam guardados.', false, 'aviso');
    if (resumo.parouPor === 'sessao' && typeof aoSessaoExpirar === 'function') aoSessaoExpirar(); // a fila fica guardada
  }

  // ---------- Indicador e lista ----------
  function quando(ms) {
    var d = new Date(ms);
    function dois(n) { return (n < 10 ? '0' : '') + n; }
    return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ', ' + dois(d.getHours()) + ':' + dois(d.getMinutes());
  }

  function indicador() {
    var el = document.getElementById('pwa-fila-indicador');
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'pwa-fila-indicador';
      el.className = 'pwa-fila-indicador';
      el.hidden = true;
      el.addEventListener('click', abrirLista);
      document.body.appendChild(el);
    }
    return el;
  }

  function atualizarIndicador() {
    return listar().then(function (envios) {
      var el = indicador();
      if (!envios.length) { el.hidden = true; return envios; }
      var recusados = envios.filter(function (e) { return e.situacao === 'RECUSADO'; }).length;
      el.classList.toggle('pwa-fila-indicador--atencao', recusados > 0);
      el.innerHTML = '<i class="fa-solid ' + (recusados ? 'fa-triangle-exclamation' : 'fa-clock-rotate-left') + '" aria-hidden="true"></i> ';
      el.appendChild(document.createTextNode(envios.length === 1 ? '1 aguardando envio' : envios.length + ' aguardando envio'));
      el.setAttribute('aria-label', el.textContent + '. Abrir a lista de envios.');
      el.hidden = false;
      return envios;
    }).catch(function () { return []; });
  }

  var modal = null;
  function abrirLista() {
    if (!modal) {
      var envoltorio = document.createElement('div');
      envoltorio.innerHTML =
        '<div class="modal fade" id="pwa-modal-fila" tabindex="-1" aria-labelledby="pwa-modal-fila-titulo" aria-hidden="true">' +
        '<div class="modal-dialog modal-dialog-scrollable"><div class="modal-content">' +
        '<div class="modal-header"><h5 class="modal-title" id="pwa-modal-fila-titulo">Aguardando envio</h5>' +
        '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button></div>' +
        '<div class="modal-body"><p class="text-muted small mb-3">Gravações feitas sem internet. Ficam guardadas neste aparelho até serem enviadas ao servidor, na ordem em que foram feitas.</p>' +
        '<ul class="pwa-fila-lista" id="pwa-fila-lista"></ul></div>' +
        '<div class="modal-footer"><span class="pwa-fila-sem-rede small text-muted me-auto" id="pwa-fila-sem-rede" hidden>Sem conexão agora.</span>' +
        '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Fechar</button>' +
        '<button type="button" class="btn btn-primario" id="pwa-fila-enviar"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Enviar agora</button>' +
        '</div></div></div></div>';
      document.body.appendChild(envoltorio.firstChild);
      modal = new bootstrap.Modal(document.getElementById('pwa-modal-fila'));
      document.getElementById('pwa-fila-enviar').addEventListener('click', function () {
        var botao = this;
        comBotaoOcupado(botao, function () {
          return enviarFila().then(function (resumo) { avisarResumo(resumo); return desenharLista(); });
        }, 'Enviando…');
      });
    }
    desenharLista().then(function () { modal.show(); });
  }

  function desenharLista() {
    return listar().then(function (envios) {
      var ul = document.getElementById('pwa-fila-lista');
      if (!ul) return;
      document.getElementById('pwa-fila-sem-rede').hidden = navigator.onLine !== false;
      document.getElementById('pwa-fila-enviar').disabled = !envios.length;
      if (!envios.length) {
        ul.innerHTML = '<li class="estado-vazio"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><p class="titulo">Nada aguardando envio</p></li>';
        return;
      }
      ul.innerHTML = envios.map(function (e) {
        var recusado = e.situacao === 'RECUSADO';
        return '<li class="pwa-fila-item' + (recusado ? ' pwa-fila-item--recusado' : '') + '">' +
          '<div class="pwa-fila-item__texto"><strong>' + escapeHtml(e.rotulo) + '</strong>' +
          '<span class="small text-muted">Feito em ' + quando(e.criadoEm) + '</span>' +
          (recusado ? '<span class="small pwa-fila-item__motivo">Não aceito: ' + escapeHtml(e.motivo) + '</span>' : '<span class="small text-muted">Aguardando conexão</span>') +
          '</div>' +
          (recusado ? '<button type="button" class="btn btn-sm btn-outline-danger" data-descartar="' + escapeHtml(e.chave) + '">Descartar</button>' : '') +
          '</li>';
      }).join('');
      ul.querySelectorAll('[data-descartar]').forEach(function (b) {
        b.addEventListener('click', function () {
          var chave = b.getAttribute('data-descartar');
          // Dois modais juntos se atrapalham (a pergunta ficaria atrás da lista): fecha a lista, pergunta, reabre.
          document.getElementById('pwa-modal-fila').addEventListener('hidden.bs.modal', function () {
            confirmarAcao('Descartar este envio? O que foi feito nele não chegará ao servidor.', {
              titulo: 'Descartar envio', textoConfirmar: 'Descartar', textoCancelar: 'Manter'
            }).then(function (sim) {
              return sim ? remover(chave).then(atualizarIndicador) : null;
            }).then(function () {
              document.getElementById('modal-confirmacao').addEventListener('hidden.bs.modal', function () { abrirLista(); }, { once: true });
            });
          }, { once: true });
          modal.hide();
        });
      });
    });
  }

  // ---------- Sair com envios pendentes ----------
  if (typeof window._sair === 'function') {
    var sairOriginal = window._sair;
    window._sair = function () {
      var args = arguments, self = this;
      listar().then(function (envios) {
        if (!envios.length) return sairOriginal.apply(self, args);
        var n = envios.length;
        confirmarAcao((n === 1 ? 'Há 1 gravação' : 'Há ' + n + ' gravações') + ' feita(s) sem internet aguardando envio. ' +
          'Se sair agora, ela(s) será(ão) descartada(s) e não chegará(ão) ao servidor. Para enviar antes, toque em “aguardando envio” com internet.', {
          titulo: 'Envios pendentes', textoConfirmar: 'Sair e descartar', textoCancelar: 'Ficar'
        }).then(function (sim) {
          if (!sim) return;
          Promise.all(envios.map(function (e) { return remover(e.chave); })).then(function () { sairOriginal.apply(self, args); });
        });
      }, function () { sairOriginal.apply(self, args); });
    };
  }

  // ---------- Envio automático (Etapa 7) ----------
  // Quando: ao abrir o aplicativo, quando a conexão volta (pwa-app.js confirma com o servidor) e quando o aplicativo
  // volta para a tela. Só o que está aguardando (o recusado espera a pessoa decidir). Sem conexão: em silêncio, tenta na
  // próxima. O que ficou para trás por resposta lenta ou "em andamento" é tentado de novo em 1 minuto.
  var ultimaTentativa = 0, novaTentativa = null;
  var INTERVALO_MINIMO_MS = 20000, REPETIR_EM_MS = 60000;

  function enviarAutomatico() {
    if (enviando || navigator.onLine === false || !Sessao.token()) return Promise.resolve(null);
    clearTimeout(novaTentativa);
    return listar().then(function (envios) {
      if (!envios.some(function (e) { return e.situacao !== 'RECUSADO'; })) return null;
      ultimaTentativa = Date.now();
      return enviarFila({ automatico: true }).then(function (resumo) {
        avisarResumo(resumo, true);
        var lista = document.getElementById('pwa-modal-fila');
        if (lista && lista.classList.contains('show')) desenharLista();
        if (resumo && !resumo.parouPor) {
          return listar().then(function (restantes) {
            if (restantes.some(function (e) { return e.situacao !== 'RECUSADO'; })) novaTentativa = setTimeout(enviarAutomatico, REPETIR_EM_MS);
          });
        }
        return resumo;
      });
    }).catch(function () { return null; });
  }

  document.addEventListener('catequese:conexao-voltou', function () { setTimeout(enviarAutomatico, 500); });
  // "Lembrar este aparelho" (pwa-sessao.js): a sessão foi renovada sem senha — envia o que parou por sessão vencida.
  document.addEventListener('catequese:sessao-renovada', function () { setTimeout(enviarAutomatico, 300); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - ultimaTentativa > INTERVALO_MINIMO_MS) enviarAutomatico();
  });
  window.addEventListener('load', function () { setTimeout(enviarAutomatico, 3000); });

  // Para testes e uso de outras partes do aplicativo.
  window.FilaDeEnvio = {
    listar: listar, enviar: enviarFila, enviarAutomatico: enviarAutomatico,
    avisarResumo: avisarResumo, atualizarIndicador: atualizarIndicador
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', atualizarIndicador);
  else atualizarIndicador();
})();
