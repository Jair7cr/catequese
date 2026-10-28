/**
 * pwa-fonte/js/pwa-dados.js — SÓ do aplicativo instalável (PWA — Etapa 4: leitura sem internet). Não vai para o
 * Apps Script. Carregado só no sistema (app.html), depois de pwa-app.js.
 *
 * DECISÕES APROVADAS (auditoria de PWA):
 * - Uso sem internet só para o perfil CATEQUISTA (não existe perfil "Coordenador" no sistema; o Administrador usa
 *   sempre online; o Catequizando não entra nesta etapa).
 * - No aparelho, só os dados essenciais ao uso sem internet: as MESMAS respostas que o servidor já entrega a esse
 *   catequista (que só vê os próprios grupos) para Início, Avisos, Meus catequizandos, Planejamento (grupos e
 *   encontros) e Chamada. Nada de dados complementares (saúde), arquivos, fórum, biblioteca, galeria ou relatórios.
 * - Só com "Manter conectado neste aparelho" marcado (o aviso do login já diz "Use só em aparelho seu"). Sem isso,
 *   nada é guardado e o que houver é apagado.
 * - Tudo é apagado ao Sair, quando a sessão vence ou quando outra pessoa entra no mesmo aparelho. O que tiver mais
 *   de 30 dias é descartado.
 *
 * COMO FUNCIONA: as chamadas de leitura acima continuam indo ao servidor primeiro. Cada resposta é guardada no
 * banco do navegador (IndexedDB). Se a chamada falhar por falta de conexão, ou o servidor demorar mais de 12 s, a
 * tela recebe a última resposta guardada, e o aviso no alto mostra "Sem conexão · dados de dd/mm, hh:mm". Gravações
 * (salvar chamada, criar aviso...) NÃO passam por aqui: sem internet continuam dando "Sem conexão" (a fila de envio é
 * a Etapa 6).
 * PRÉ-CARGA: com internet, no máximo a cada 6 h, o aplicativo busca em segundo plano o que o catequista consulta em
 * campo — Início, Avisos, Meus catequizandos, seus grupos, os encontros de cada grupo e a chamada dos encontros de
 * 14 dias atrás até 45 dias à frente (no máximo 12) —, para estarem prontos mesmo que a tela não tenha sido aberta.
 */
(function () {
  var BANCO = 'catequese-dados';
  var PERFIS_OFFLINE = ['CATEQUISTA'];
  var OPERACOES = {
    apiObterResumoDashboard: true, apiObterConfigParoquia: true, apiListarAvisos: true,
    apiListarParaCompletarCadastro: true, apiListarGrupos: true, apiListarEncontros: true, apiAbrirChamada: true
  };
  var VALIDADE_MS = 30 * 24 * 3600 * 1000;
  var ESPERA_MAXIMA_MS = 12000;
  var INTERVALO_PRECARGA_MS = 3600 * 1000; // Etapa 7: no máximo de hora em hora (ao abrir e ao voltar a conexão)
  var JANELA_PASSADO_DIAS = 14, JANELA_FUTURO_DIAS = 45, MAX_CHAMADAS = 12;

  if (!window.indexedDB) return;

  // ---------- Banco ----------
  var bancoAberto = null;
  function abrir() {
    if (bancoAberto) return bancoAberto;
    bancoAberto = new Promise(function (resolve, reject) {
      var pedido = indexedDB.open(BANCO, 1);
      pedido.onupgradeneeded = function () {
        var db = pedido.result;
        if (!db.objectStoreNames.contains('respostas')) db.createObjectStore('respostas', { keyPath: 'chave' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'chave' });
      };
      pedido.onsuccess = function () { resolve(pedido.result); };
      pedido.onerror = function () { reject(pedido.error); };
    });
    return bancoAberto;
  }

  function operar(loja, modo, acao) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(loja, modo);
        var pedido = acao(tx.objectStore(loja));
        tx.oncomplete = function () { resolve(pedido ? pedido.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function ler(loja, chave) { return operar(loja, 'readonly', function (s) { return s.get(chave); }); }
  function gravar(loja, registro) { return operar(loja, 'readwrite', function (s) { return s.put(registro); }); }

  function apagarTudo() {
    if (!bancoAberto) { // nunca aberto nesta página: apaga o banco inteiro, sem criá-lo
      try { indexedDB.deleteDatabase(BANCO); } catch (e) { /* nada a apagar */ }
      return Promise.resolve();
    }
    return abrir().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(['respostas', 'meta'], 'readwrite');
        tx.objectStore('respostas').clear();
        tx.objectStore('meta').clear();
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    }).catch(function () {});
  }

  function descartarVencidos() {
    var limite = Date.now() - VALIDADE_MS;
    return operar('respostas', 'readwrite', function (s) {
      var cursor = s.openCursor();
      cursor.onsuccess = function () {
        var c = cursor.result;
        if (!c) return;
        if (!(c.value.salvoEm > limite)) c.delete();
        c.continue();
      };
      return null;
    }).catch(function () {});
  }

  // ---------- Quem pode guardar ----------
  var usuario = (typeof USUARIO !== 'undefined' && USUARIO) || null;
  var podeGuardar = !!(usuario && usuario.id && PERFIS_OFFLINE.indexOf(usuario.perfil) !== -1 && Sessao.mantida());

  // Sair / sessão vencida: Sessao.encerrar é chamado em todos esses caminhos (js/core/auth.js) — apaga junto.
  var encerrarOriginal = Sessao.encerrar;
  Sessao.encerrar = function () {
    encerrarOriginal.apply(this, arguments);
    apagarTudo();
  };

  if (!podeGuardar) { apagarTudo(); return; } // Administrador, Catequizando ou sessão só da aba: nada no aparelho

  // Outra pessoa entrou neste aparelho: nada do usuário anterior fica disponível.
  var pronto = ler('meta', 'dono').then(function (dono) {
    if (dono && dono.usuarioId !== usuario.id) return apagarTudo();
  }).then(function () {
    return gravar('meta', { chave: 'dono', usuarioId: usuario.id });
  }).then(descartarVencidos).catch(function () {});

  // ---------- Leitura com reserva no aparelho ----------
  function chaveDe(op, args) { return op + '|' + JSON.stringify(args.slice(1)); } // sem o token

  function guardar(chave, op, dados) {
    return pronto.then(function () {
      return gravar('respostas', { chave: chave, op: op, dados: dados, salvoEm: Date.now() });
    }).catch(function () { /* cota cheia ou banco indisponível: segue sem guardar */ });
  }

  function lerGuardado(chave) {
    return pronto.then(function () { return ler('respostas', chave); }).then(function (reg) {
      return reg && reg.salvoEm > Date.now() - VALIDADE_MS ? reg : null;
    }).catch(function () { return null; });
  }

  function avisar(reg) {
    document.dispatchEvent(new CustomEvent('catequese:dados-salvos', { detail: { salvoEm: reg.salvoEm } }));
  }

  var chamarApiAnterior = window.chamarApi;
  window.chamarApi = function (op) {
    if (!OPERACOES[op]) return chamarApiAnterior.apply(this, arguments);
    var args = Array.prototype.slice.call(arguments, 1);
    var chave = chaveDe(op, args);
    var daRede = chamarApiAnterior.apply(this, arguments);
    var respondeu = false;

    daRede.then(function (dados) {
      guardar(chave, op, dados);
      // Item 1 (27/10): a lista de encontros chegou do servidor — baixa já a chamada dos encontros novos da janela.
      if (op === 'apiListarEncontros') completarChamadas(dados);
    }, function () {});

    return new Promise(function (resolve, reject) {
      // Servidor muito lento (sinal fraco): se houver dado guardado, mostra-o; a resposta da rede ainda atualiza o banco.
      var relogio = setTimeout(function () {
        lerGuardado(chave).then(function (reg) {
          if (reg && !respondeu) { respondeu = true; avisar(reg); resolve(reg.dados); }
        });
      }, ESPERA_MAXIMA_MS);

      daRede.then(function (dados) {
        clearTimeout(relogio);
        if (!respondeu) { respondeu = true; resolve(dados); }
      }, function (erro) {
        clearTimeout(relogio);
        if (respondeu) return;
        if (!erro || !erro.semConexao) { respondeu = true; reject(erro); return; }
        lerGuardado(chave).then(function (reg) {
          if (reg || op !== 'apiAbrirChamada') return reg;
          return montarChamadaNoAparelho(args[1]); // item 1 (27/10): chamada nunca baixada
        }).then(function (reg) {
          if (respondeu) return;
          respondeu = true;
          if (reg) { avisar(reg); resolve(reg.dados); } else reject(erro);
        });
      });
    });
  };

  /**
   * Busca em SEGUNDO PLANO (pré-carga, completar chamadas): vai ao servidor e guarda a resposta, sem a reserva do
   * aparelho e sem montar chamada — esses recursos são só para a tela que a pessoa abriu.
   */
  function buscarEGuardar(op) {
    var args = Array.prototype.slice.call(arguments, 1);
    return chamarApiAnterior.apply(null, arguments).then(function (dados) {
      guardar(chaveDe(op, args), op, dados);
      return dados;
    });
  }

  // ---------- Chamada de encontro novo (item 1, 27/10/2026) ----------
  // Antes, só a pré-carga (ao abrir / ao voltar a conexão, no máximo de hora em hora) baixava as chamadas: um encontro
  // criado com internet não tinha chamada guardada e, sem internet, ela não abria.

  /** Com internet: baixa em segundo plano a chamada dos encontros da janela que ainda não estão guardados. */
  var completando = false;
  function completarChamadas(encontros) {
    if (completando || precarregando || !Array.isArray(encontros)) return;
    var token = Sessao.token();
    if (!token) return;
    var hoje = Date.now();
    var candidatos = encontros.filter(dentroDaJanela).sort(function (a, b) {
      return Math.abs(new Date(a.DATA_ENCONTRO) - hoje) - Math.abs(new Date(b.DATA_ENCONTRO) - hoje);
    }).slice(0, MAX_CHAMADAS);
    if (!candidatos.length) return;
    completando = true;
    candidatos.reduce(function (anterior, e) {
      return anterior.then(function (parar) {
        if (parar) return true;
        return lerGuardado(chaveDe('apiAbrirChamada', [token, e.ID])).then(function (reg) {
          if (reg && !reg.montadaNoAparelho) return false; // já guardada (a montada no aparelho é trocada pela do servidor)
          return buscarEGuardar('apiAbrirChamada', token, e.ID).then(function () { return false; }, function (erro) {
            return !!(erro && erro.semConexao); // sem rede: para; outro erro (ex.: sem acesso): segue para o próximo
          });
        });
      });
    }, Promise.resolve(false)).then(function () { completando = false; }, function () { completando = false; });
  }

  function listarGuardados() {
    return pronto.then(function () { return operar('respostas', 'readonly', function (s) { return s.getAll(); }); })
      .then(function (todos) { return todos || []; }).catch(function () { return []; });
  }

  /**
   * Sem internet e sem a chamada guardada: monta a lista a partir da chamada mais recente guardada de OUTRO encontro do
   * MESMO grupo — todos como Presente (padrão do sistema, RN-014), sem data de alteração (o servidor aponta conflito se
   * alguém já tiver lançado). Quem foi matriculado depois dessa chamada guardada não aparece; ao enviar, o servidor o
   * considera presente, como já faz para quem não tem registro. Fica guardada marcada como "montada no aparelho" (para
   * reabrir mostrando o que foi lançado) e é trocada pela do servidor assim que houver internet.
   * @return {Promise<?Object>} registro no formato guardado, ou null se não houver como montar.
   */
  function montarChamadaNoAparelho(encontroId) {
    return listarGuardados().then(function (todos) {
      var grupoId = null;
      var encontrosDoGrupo = {};
      todos.forEach(function (r) {
        if (r.op !== 'apiListarEncontros' || !Array.isArray(r.dados)) return;
        if (!r.dados.some(function (e) { return e.ID === encontroId; })) return;
        try { grupoId = JSON.parse(r.chave.slice(r.chave.indexOf('|') + 1))[0]; } catch (e) { grupoId = null; }
        r.dados.forEach(function (e) { encontrosDoGrupo[e.ID] = true; });
      });
      if (!grupoId) return null;
      var base = null;
      todos.forEach(function (r) {
        if (r.op !== 'apiAbrirChamada' || r.montadaNoAparelho || !Array.isArray(r.dados) || !r.dados.length) return;
        var id = null;
        try { id = JSON.parse(r.chave.slice(r.chave.indexOf('|') + 1))[0]; } catch (e) { return; }
        if (id === encontroId || !encontrosDoGrupo[id]) return;
        if (!base || r.salvoEm > base.salvoEm) base = r;
      });
      if (!base) return null;
      var registro = {
        chave: 'apiAbrirChamada|' + JSON.stringify([encontroId]),
        op: 'apiAbrirChamada',
        montadaNoAparelho: true,
        salvoEm: base.salvoEm,
        dados: base.dados.map(function (i) {
          return { CATEQUIZANDO_ID: i.CATEQUIZANDO_ID, NOME: i.NOME, SITUACAO: 'PRESENTE', JUSTIFICATIVA: '', EDITAVEL: true, DATA_ALTERACAO: '' };
        })
      };
      return gravar('respostas', registro).catch(function () {}).then(function () {
        if (typeof exibirToast === 'function') {
          exibirToast('Sem internet: chamada montada no aparelho com a lista do grupo, todos como Presente. ' +
            'Quem foi matriculado há pouco pode não aparecer.', false, 'info');
        }
        return registro;
      });
    });
  }

  // ---------- Pré-carga em segundo plano ----------
  function dentroDaJanela(encontro) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(encontro.DATA_ENCONTRO || ''));
    if (!m) return false;
    var dia = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return dia >= hoje.getTime() - JANELA_PASSADO_DIAS * 864e5 && dia <= hoje.getTime() + JANELA_FUTURO_DIAS * 864e5;
  }

  var precarregando = false, pedirDeNovo = false;

  function preCarregar() {
    var token = Sessao.token();
    if (!token || navigator.onLine === false) return;
    // Etapa 7: uma pré-carga por vez; se pedirem outra no meio (ex.: a fila acabou de enviar), roda de novo no fim.
    if (precarregando) { pedirDeNovo = true; return; }
    precarregando = true;
    var chamar = buscarEGuardar; // guarda cada resposta; em segundo plano nunca usa a reserva nem monta chamada
    var parar = false;
    function passo(op) {
      var args = Array.prototype.slice.call(arguments);
      return function () {
        if (parar) return null;
        return chamar.apply(null, [op, token].concat(args.slice(1))).catch(function (erro) {
          if (erro && erro.semConexao) parar = true; // sem rede: tenta de novo numa próxima abertura
          return null;
        });
      };
    }
    var fila = Promise.resolve()
      .then(passo('apiObterResumoDashboard'))
      .then(passo('apiListarAvisos'))
      .then(passo('apiListarParaCompletarCadastro', { grupoId: '', modo: 'TODOS' }))
      .then(passo('apiListarGrupos'))
      .then(function (grupos) {
        var encontros = [];
        return (grupos || []).reduce(function (anterior, g) {
          return anterior.then(passo('apiListarEncontros', g.ID)).then(function (lista) {
            (lista || []).filter(dentroDaJanela).forEach(function (e) {
              if (!encontros.some(function (x) { return x.ID === e.ID; })) encontros.push(e);
            });
          });
        }, Promise.resolve()).then(function () { return encontros; });
      })
      .then(function (encontros) {
        var hoje = Date.now();
        encontros.sort(function (a, b) { // os mais próximos de hoje primeiro
          return Math.abs(new Date(a.DATA_ENCONTRO) - hoje) - Math.abs(new Date(b.DATA_ENCONTRO) - hoje);
        });
        return encontros.slice(0, MAX_CHAMADAS).reduce(function (anterior, e) {
          return anterior.then(passo('apiAbrirChamada', e.ID));
        }, Promise.resolve());
      });
    return fila.then(function () {
      if (!parar) return gravar('meta', { chave: 'preCarga', em: Date.now() });
    }).catch(function () {}).then(function () {
      precarregando = false;
      if (pedirDeNovo) { pedirDeNovo = false; preCarregar(); }
    });
  }

  function preCarregarSeVencida() {
    return pronto.then(function () { return ler('meta', 'preCarga'); }).then(function (ultima) {
      if (!ultima || Date.now() - ultima.em > INTERVALO_PRECARGA_MS) preCarregar();
    }).catch(function () {});
  }

  // Etapa 7 — atualização automática da consulta:
  // - conexão de volta: atualiza se a última pré-carga passou do intervalo;
  // - a fila acabou de enviar: atualiza já, para o aparelho mostrar o que o servidor tem agora.
  document.addEventListener('catequese:conexao-voltou', function () { setTimeout(preCarregarSeVencida, 2000); });
  document.addEventListener('catequese:fila-enviada', function () { setTimeout(preCarregar, 1000); });
  window.DadosOffline = { atualizar: preCarregar };

  window.addEventListener('load', function () {
    setTimeout(preCarregarSeVencida, 4000); // depois que a tela inicial já carregou
  });
})();
