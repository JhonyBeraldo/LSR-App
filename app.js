// LSR App - Bootstrap principal

// ------------------------------------------------------------
// Registro do Service Worker (PWA offline-first)
// ------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Caminho RELATIVO (sem "/" na frente) — funciona tanto na raiz
    // do domínio quanto em subpasta (ex: GitHub Pages de projeto,
    // como https://usuario.github.io/LSR-App/).
    navigator.serviceWorker.register('sw.js')
      .then((reg) => console.log('[App] Service Worker registrado:', reg.scope))
      .catch((err) => console.error('[App] Falha ao registrar Service Worker:', err));
  });
}

// ------------------------------------------------------------
// Programa de indicação: captura o ?ref= da URL (se vier de um
// link compartilhado) e guarda pra usar no cadastro.
// ------------------------------------------------------------
const REF_CACHE_KEY = 'lsr_ref_code';

function capturarCodigoIndicacaoDaURL() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if (ref) {
    try { localStorage.setItem(REF_CACHE_KEY, ref); } catch (e) {}
    // Limpa o parâmetro da URL sem recarregar a página
    params.delete('ref');
    const novaUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', novaUrl);
  }
}
capturarCodigoIndicacaoDaURL();

function lerCodigoIndicacaoCache() {
  try { return localStorage.getItem(REF_CACHE_KEY); } catch (e) { return null; }
}

// ------------------------------------------------------------
// Indicador de conectividade + status de sincronização
// ------------------------------------------------------------
async function atualizarStatusConexao() {
  const badge = document.getElementById('status-conexao');
  if (!badge) return;

  const pendentes = await Sync.contarPendentes();

  if (!navigator.onLine) {
    if (pendentes > 0) {
      badge.textContent = `○ Offline · ⏳ ${pendentes} pendente${pendentes > 1 ? 's' : ''}`;
    } else {
      badge.textContent = '○ Offline';
    }
    badge.style.color = 'var(--lsr-text-muted)';
    return;
  }

  if (pendentes > 0) {
    badge.textContent = `⏳ ${pendentes} pendente${pendentes > 1 ? 's' : ''}`;
    badge.style.color = '#ffb74d';
  } else {
    badge.textContent = '✓ Sincronizado';
    badge.style.color = 'var(--lsr-green)';
  }
}

/**
 * Ao reconectar: reconcilia a fila pendente (Last-Write-Wins) e
 * atualiza tanto o indicador quanto as telas visíveis.
 */
async function reconciliarAoReconectar() {
  await atualizarStatusConexao();
  await Sync.processarFila();
  await atualizarStatusConexao();

  // Se a home ou o histórico estiverem visíveis, refletem os dados já sincronizados
  if (usuarioAtual) {
    if (!document.getElementById('tela-home').classList.contains('hidden')) {
      await carregarEstadoHome();
    }
    if (!document.getElementById('tela-historico').classList.contains('hidden')) {
      await carregarHistorico();
    }
  }
}

window.addEventListener('online', reconciliarAoReconectar);
window.addEventListener('offline', atualizarStatusConexao);

// Verificação periódica (cobre o caso de ficar online sem disparar o evento,
// e reforça a sincronização de itens que falharam na primeira tentativa)
setInterval(() => {
  if (navigator.onLine) {
    Sync.processarFila().then(atualizarStatusConexao);
  }
}, 60000);

// ------------------------------------------------------------
// Navegação simples entre telas (login / cadastro / home)
// ------------------------------------------------------------
function mostrarTela(idTela) {
  document.querySelectorAll('.tela').forEach((el) => el.classList.add('hidden'));
  document.getElementById(idTela).classList.remove('hidden');
}

function mostrarErro(elementoId, mensagem) {
  const el = document.getElementById(elementoId);
  el.textContent = mensagem;
  el.classList.remove('hidden');
}

function esconderErro(elementoId) {
  document.getElementById(elementoId).classList.add('hidden');
}

// ------------------------------------------------------------
// Estado local simples
// ------------------------------------------------------------
let usuarioAtual = null;
let perfilAtual = null;
let veiculoEmEdicaoId = null; // null = criando novo
let veiculoParaDesativarId = null;
let turnoAtivoAtual = null;
let veiculosAtivosCache = [];
let dadosEncerramentoPendente = null; // guarda os dados enquanto espera o duplo clique de confirmação

// ------------------------------------------------------------
// Tolerância offline: se o app não conseguir confirmar online que o
// motorista está aprovado, confia na última confirmação bem-sucedida
// por até N dias (configurável pelo master; padrão 3 dias).
// ------------------------------------------------------------
const SESSAO_CACHE_KEY = 'lsr_sessao_cache';
const PRAZO_CACHE_KEY = 'lsr_prazo_offline_dias';
const PRAZO_PADRAO_DIAS = 3;

function salvarSessaoCache(usuario, perfil) {
  try {
    localStorage.setItem(SESSAO_CACHE_KEY, JSON.stringify({
      userId: usuario.id,
      nome: perfil.nome,
      role: perfil.role,
      aprovadoEm: Date.now()
    }));
  } catch (e) { /* localStorage indisponível — segue sem cache */ }
}

function lerSessaoCache() {
  try {
    const raw = localStorage.getItem(SESSAO_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function salvarPrazoCache(dias) {
  try { localStorage.setItem(PRAZO_CACHE_KEY, String(dias)); } catch (e) {}
}

function lerPrazoDiasCache() {
  const valor = parseInt(localStorage.getItem(PRAZO_CACHE_KEY), 10);
  return isNaN(valor) || valor <= 0 ? PRAZO_PADRAO_DIAS : valor;
}
let origemTelaResultado = 'fechamento'; // 'fechamento' ou 'historico' — controla os botões da tela de detalhe
let turnoDetalheAtual = null; // { turno, veiculo } exibido na tela de detalhe (quando vindo do histórico)

/**
 * Após login (ou ao reabrir o app com sessão salva), confere se o
 * perfil já foi aprovado pelo master. Se não, desloga e mostra
 * a tela de "aguardando aprovação".
 */
async function verificarAcessoEDirecionar(usuario) {
  try {
    const perfil = await Auth.getPerfil(usuario.id);
    perfilAtual = perfil;

    if (!perfil.is_ativo) {
      await Auth.logout();
      mostrarTela('tela-aguardando-aprovacao');
      return;
    }

    usuarioAtual = usuario;
    salvarSessaoCache(usuario, perfil);

    // Senha temporária (definida pelo master via reset): obriga a
    // trocar antes de liberar qualquer outra tela, seja motorista ou master.
    if (perfil.senha_temporaria) {
      mostrarTela('tela-trocar-senha');
      return;
    }

    // Atualiza o prazo de tolerância offline em cache (melhor esforço, não bloqueia)
    Auth.getConfig('prazo_aprovacao_offline_dias')
      .then((v) => { if (v) salvarPrazoCache(parseInt(v, 10)); })
      .catch(() => {});

    // Master vai pro painel administrativo, não pra home do motorista
    if (perfil.role === 'master') {
      document.getElementById('admin-nome').textContent = perfil.nome || 'Master';
      mostrarTela('tela-admin');
      await carregarPainelAdmin();
      return;
    }

    document.getElementById('home-email').textContent = 'Bem-vindo, ' + (perfil.nome || 'Motorista');
    mostrarTela('tela-home');
    await carregarEstadoHome();

    // Reconcilia qualquer coisa que tenha ficado pendente de uma sessão offline anterior
    if (navigator.onLine) {
      Sync.processarFila().then(async () => {
        await atualizarStatusConexao();
        if (!document.getElementById('tela-home').classList.contains('hidden')) {
          await carregarEstadoHome();
        }
      });
    }
  } catch (err) {
    console.error('[App] Não foi possível confirmar o acesso online:', err);

    // Sem conexão pra checar o perfil: confia na última confirmação
    // bem-sucedida, DENTRO do prazo de tolerância configurado.
    const cache = lerSessaoCache();
    if (cache && cache.userId === usuario.id) {
      const prazoDias = lerPrazoDiasCache();
      const horasDesdeAprovado = (Date.now() - cache.aprovadoEm) / (1000 * 60 * 60);

      if (horasDesdeAprovado <= prazoDias * 24) {
        usuarioAtual = usuario;
        perfilAtual = { nome: cache.nome, role: cache.role, is_ativo: true };

        if (cache.role === 'master') {
          // Painel master exige dados atualizados (aprovações, estatísticas);
          // não faz sentido operar offline nesse caso específico.
          mostrarErro('erro-login', 'O painel administrativo requer conexão com a internet.');
          mostrarTela('tela-login');
          return;
        }

        document.getElementById('home-email').textContent = 'Bem-vindo, ' + (cache.nome || 'Motorista');
        mostrarTela('tela-home');
        await carregarEstadoHome();
        return;
      }
    }

    // Sem cache válido ou prazo expirado: não dá pra confirmar o acesso com segurança.
    try { await Auth.logout(); } catch (e) { /* já estamos offline, ignora */ }
    mostrarErro('erro-login', 'Não foi possível confirmar seu acesso. Conecte-se à internet para continuar.');
    mostrarTela('tela-login');
  }
}

// ------------------------------------------------------------
// Inicialização: verifica sessão e decide qual tela mostrar
// ------------------------------------------------------------
async function inicializarApp() {
  atualizarStatusConexao();

  const usuario = await Auth.getUsuarioAtual();
  if (usuario) {
    await verificarAcessoEDirecionar(usuario);
  } else {
    mostrarTela('tela-login');
  }
}

// ------------------------------------------------------------
// TELA DE VEÍCULOS: renderização da lista
// ------------------------------------------------------------
function iconeTipoVeiculo(tipo) {
  return tipo === 'moto' ? '🏍️' : '🚗';
}

async function carregarListaVeiculos() {
  const container = document.getElementById('lista-veiculos');
  const vazio = document.getElementById('veiculos-vazio');
  container.innerHTML = '<p class="text-sm text-center py-4" style="color:var(--lsr-text-muted)">Carregando...</p>';

  try {
    const veiculos = await Veiculos.listarAtivos(usuarioAtual.id);
    container.innerHTML = '';

    if (!veiculos.length) {
      vazio.classList.remove('hidden');
      return;
    }
    vazio.classList.add('hidden');

    veiculos.forEach((v) => {
      const card = document.createElement('div');
      card.className = 'card-lsr p-4 flex items-center justify-between';
      card.innerHTML = `
        <div class="flex items-center gap-3">
          <span class="text-2xl">${iconeTipoVeiculo(v.tipo)}</span>
          <div>
            <p class="text-white font-semibold">${v.nome_modelo}</p>
            <p class="text-xs" style="color:var(--lsr-text-muted)">
              ${v.autonomia_kml} km/l · Manut. R$ ${Number(v.taxa_manutencao_km).toFixed(4)}/km · Depr. R$ ${Number(v.taxa_depreciacao_km).toFixed(4)}/km
            </p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="btn-editar-veiculo text-sm font-semibold" style="color:var(--lsr-green)" data-id="${v.id}">Editar</button>
          <button class="btn-desativar-veiculo text-sm font-semibold" style="color:var(--lsr-red)" data-id="${v.id}">Desativar</button>
        </div>
      `;
      container.appendChild(card);

      card.querySelector('.btn-editar-veiculo').addEventListener('click', () => abrirModalVeiculo(v));
      card.querySelector('.btn-desativar-veiculo').addEventListener('click', () => abrirConfirmarDesativar(v.id));
    });
  } catch (err) {
    container.innerHTML = `<p class="text-sm text-center py-4" style="color:var(--lsr-red)">Erro ao carregar veículos. Verifique sua conexão.</p>`;
    console.error(err);
  }
}

function abrirModalVeiculo(veiculo) {
  const modal = document.getElementById('modal-veiculo');
  const titulo = document.getElementById('modal-veiculo-titulo');
  esconderErro('erro-veiculo');

  if (veiculo) {
    veiculoEmEdicaoId = veiculo.id;
    titulo.textContent = 'Editar veículo';
    document.getElementById('veiculo-id').value = veiculo.id;
    document.getElementById('veiculo-nome').value = veiculo.nome_modelo;
    document.getElementById('veiculo-tipo').value = veiculo.tipo;
    document.getElementById('veiculo-autonomia').value = veiculo.autonomia_kml;
    document.getElementById('veiculo-manutencao').value = veiculo.taxa_manutencao_km;
    document.getElementById('veiculo-depreciacao').value = veiculo.taxa_depreciacao_km;
  } else {
    veiculoEmEdicaoId = null;
    titulo.textContent = 'Novo veículo';
    document.getElementById('form-veiculo').reset();
    document.getElementById('veiculo-manutencao').value = '0.08';
    document.getElementById('veiculo-depreciacao').value = '0.04';
  }

  modal.classList.remove('hidden');
}

function fecharModalVeiculo() {
  document.getElementById('modal-veiculo').classList.add('hidden');
  veiculoEmEdicaoId = null;
}

function abrirConfirmarDesativar(id) {
  veiculoParaDesativarId = id;
  document.getElementById('modal-confirmar-desativar').classList.remove('hidden');
}

function fecharConfirmarDesativar() {
  document.getElementById('modal-confirmar-desativar').classList.add('hidden');
  veiculoParaDesativarId = null;
}

// ------------------------------------------------------------
// FORMATAÇÃO
// ------------------------------------------------------------
function formatarMoeda(valor) {
  if (valor === null || valor === undefined || isNaN(valor)) return '—';
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarHorario(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Formata horas decimais em algo legível: "6h30" ou "3h" (sem minutos
 * quando for redondo).
 */
function formatarDuracao(horasDecimais) {
  if (horasDecimais === null || horasDecimais === undefined || isNaN(horasDecimais)) return '';
  const totalMin = Math.round(horasDecimais * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function formatarDataBR(dataISO) {
  // dataISO no formato "AAAA-MM-DD"
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

/**
 * Roda o motor de cálculo pra um turno FECHADO, usando os dados
 * do veículo (cache local, com fallback remoto via Veiculos.obterPorId).
 */
function calcularTurno(turno, veiculo) {
  return Turnos.calcular({
    kmInicial: turno.km_inicial,
    kmFinal: turno.km_final,
    autonomiaKml: veiculo ? veiculo.autonomia_kml : 0,
    precoCombustivelTurno: turno.preco_combustivel_turno,
    taxaManutencaoKm: veiculo ? veiculo.taxa_manutencao_km : 0,
    taxaDepreciacaoKm: veiculo ? veiculo.taxa_depreciacao_km : 0,
    faturamentoBruto: turno.faturamento_bruto,
    tempoInicioISO: turno.tempo_inicio,
    tempoFimISO: turno.tempo_fim
  });
}

// ------------------------------------------------------------
// HOME: preço de combustível + estado do turno (ativo ou não)
// ------------------------------------------------------------
async function carregarEstadoHome() {
  // Cofre de Manutenção: calcula em segundo plano, sem travar o resto da home
  atualizarSaldoCofre();

  // Preço de combustível
  const precoAtual = perfilAtual?.preco_combustivel_atual;
  document.getElementById('preco-combustivel-display').textContent =
    precoAtual ? `${formatarMoeda(precoAtual)} / L` : 'Não definido';

  // Turno ativo?
  turnoAtivoAtual = await Turnos.buscarTurnoAtivo(usuarioAtual.id);

  if (turnoAtivoAtual) {
    document.getElementById('bloco-sem-turno').classList.add('hidden');
    document.getElementById('bloco-turno-ativo').classList.remove('hidden');

    let veiculo = null;
    try {
      veiculo = await Veiculos.obterPorId(turnoAtivoAtual.veiculo_id);
    } catch (err) {
      console.warn('[App] Veículo do turno ativo não disponível offline:', err);
    }
    document.getElementById('turno-ativo-veiculo').textContent = veiculo
      ? `${iconeTipoVeiculo(veiculo.tipo)} ${veiculo.nome_modelo}`
      : 'Veículo';
    document.getElementById('turno-ativo-info').textContent =
      `Iniciado às ${formatarHorario(turnoAtivoAtual.tempo_inicio)} · KM inicial ${turnoAtivoAtual.km_inicial}`;

    verificarTurnoEsquecido();
  } else {
    document.getElementById('bloco-turno-ativo').classList.add('hidden');
    document.getElementById('bloco-sem-turno').classList.remove('hidden');
  }

  await atualizarStatusConexao();
  await atualizarAvisoVencimento();
}

// ------------------------------------------------------------
// Indicar amigo
// ------------------------------------------------------------
function gerarLinkIndicacao() {
  return `${window.location.origin}${window.location.pathname}?ref=${usuarioAtual.id}`;
}

function abrirModalIndicarAmigo() {
  document.getElementById('texto-link-indicacao').textContent = gerarLinkIndicacao();
  document.getElementById('modal-indicar-amigo').classList.remove('hidden');
}

function fecharModalIndicarAmigo() {
  document.getElementById('modal-indicar-amigo').classList.add('hidden');
}

/**
 * Soma manutenção + depreciação de TODOS os turnos fechados do motorista —
 * o "Cofre de Manutenção": quanto já foi hipoteticamente reservado pro
 * desgaste do veículo, ao longo de toda a história de turnos.
 */
async function atualizarSaldoCofre() {
  try {
    const [turnos, despesas] = await Promise.all([
      Turnos.listarHistorico(usuarioAtual.id, 100000),
      Despesas.listar(usuarioAtual.id)
    ]);
    const fechados = turnos.filter((t) => t.status === 'fechado');

    const idsVeiculos = [...new Set(fechados.map((t) => t.veiculo_id))];
    const veiculosMap = {};
    await Promise.all(idsVeiculos.map(async (id) => {
      try {
        veiculosMap[id] = await Veiculos.obterPorId(id);
      } catch (err) {
        veiculosMap[id] = null;
      }
    }));

    let acumulado = 0;
    fechados.forEach((t) => {
      const v = veiculosMap[t.veiculo_id];
      const dist = (t.km_final || 0) - (t.km_inicial || 0);
      const taxaManutencao = v ? v.taxa_manutencao_km : 0;
      const taxaDepreciacao = v ? v.taxa_depreciacao_km : 0;
      acumulado += dist * (taxaManutencao + taxaDepreciacao);
    });

    const totalGasto = despesas.reduce((soma, d) => soma + Number(d.valor), 0);
    const saldo = acumulado - totalGasto;

    const elSaldo = document.getElementById('saldo-cofre-manutencao');
    elSaldo.textContent = formatarMoeda(saldo);
    elSaldo.style.color = saldo < 0 ? 'var(--lsr-red)' : '#ffb74d';
  } catch (err) {
    console.error('[App] Erro ao calcular saldo do cofre de manutenção:', err);
  }
}

// ------------------------------------------------------------
// Despesas de manutenção (histórico + cadastro)
// ------------------------------------------------------------
async function carregarDespesas() {
  const container = document.getElementById('lista-despesas');
  const vazio = document.getElementById('despesas-vazio');
  container.innerHTML = '<p class="text-sm text-center py-4" style="color:var(--lsr-text-muted)">Carregando...</p>';

  try {
    const despesas = await Despesas.listar(usuarioAtual.id);
    container.innerHTML = '';

    if (!despesas.length) {
      vazio.classList.remove('hidden');
      return;
    }
    vazio.classList.add('hidden');

    const idsVeiculos = [...new Set(despesas.map((d) => d.veiculo_id))];
    const veiculosMap = {};
    await Promise.all(idsVeiculos.map(async (id) => {
      try { veiculosMap[id] = await Veiculos.obterPorId(id); } catch (e) { veiculosMap[id] = null; }
    }));

    despesas.forEach((d) => {
      const v = veiculosMap[d.veiculo_id];
      const item = document.createElement('div');
      item.className = 'card-lsr p-3 flex items-center justify-between';
      item.innerHTML = `
        <div>
          <p class="text-white text-sm font-semibold">${d.descricao || 'Despesa de manutenção'}</p>
          <p class="text-xs" style="color:var(--lsr-text-muted)">${v ? v.nome_modelo : 'Veículo'} · ${formatarDataBR(d.data_despesa)}</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="font-bold" style="color:var(--lsr-red)">${formatarMoeda(d.valor)}</span>
          <button class="btn-editar-despesa text-lg" style="color:var(--lsr-text-muted)">✏️</button>
          <button class="btn-excluir-despesa text-lg" style="color:var(--lsr-text-muted)" data-id="${d.id}">🗑️</button>
        </div>
      `;
      item.querySelector('.btn-editar-despesa').addEventListener('click', () => {
        abrirModalNovaDespesa(d, v);
      });
      item.querySelector('.btn-excluir-despesa').addEventListener('click', async () => {
        if (!confirm('Excluir essa despesa?')) return;
        try {
          await Despesas.excluir(d.id);
          await carregarDespesas();
          await atualizarSaldoCofre();
        } catch (err) {
          console.error(err);
          alert('Não foi possível excluir. Verifique sua conexão.');
        }
      });
      container.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p class="text-sm text-center py-4" style="color:var(--lsr-red)">Erro ao carregar despesas.</p>';
  }
}

let despesaEmEdicaoId = null;

/**
 * Abre o modal pra criar uma despesa nova, ou (se despesaExistente for
 * passada) pra editar uma já cadastrada — mesmo formulário nos dois casos.
 */
async function abrirModalNovaDespesa(despesaExistente, veiculoDaDespesa) {
  esconderErro('erro-nova-despesa');
  despesaEmEdicaoId = despesaExistente ? despesaExistente.id : null;

  document.getElementById('modal-nova-despesa').querySelector('h2').textContent =
    despesaExistente ? 'Editar despesa' : 'Nova despesa';
  document.querySelector('#form-nova-despesa button[type="submit"]').textContent =
    despesaExistente ? 'Salvar alterações' : 'Salvar despesa';

  document.getElementById('input-valor-despesa').value = despesaExistente ? despesaExistente.valor : '';
  document.getElementById('input-descricao-despesa').value = despesaExistente ? (despesaExistente.descricao || '') : '';
  document.getElementById('input-data-despesa').value = despesaExistente ? despesaExistente.data_despesa : new Date().toISOString().slice(0, 10);

  const select = document.getElementById('select-veiculo-despesa');
  select.innerHTML = '<option value="">Carregando...</option>';
  document.getElementById('modal-nova-despesa').classList.remove('hidden');

  try {
    // Ao editar, inclui o veículo atual mesmo que já tenha sido desativado
    // desde então — senão a edição "perderia" o veículo original.
    let veiculosParaListar = await Veiculos.listarAtivos(usuarioAtual.id);
    if (despesaExistente && veiculoDaDespesa && !veiculosParaListar.some((v) => v.id === veiculoDaDespesa.id)) {
      veiculosParaListar = [veiculoDaDespesa, ...veiculosParaListar];
    }

    select.innerHTML = '';
    if (!veiculosParaListar.length) {
      select.innerHTML = '<option value="">Nenhum veículo cadastrado</option>';
      return;
    }
    veiculosParaListar.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${iconeTipoVeiculo(v.tipo)} ${v.nome_modelo}`;
      select.appendChild(opt);
    });

    if (despesaExistente) select.value = despesaExistente.veiculo_id;
  } catch (err) {
    select.innerHTML = '<option value="">Erro ao carregar veículos</option>';
  }
}

// ------------------------------------------------------------
// RELATÓRIO FINANCEIRO
// ------------------------------------------------------------
let ultimoRelatorioGerado = null; // guarda o resultado calculado, pra gerar o PDF sem recalcular

function definirPeriodoPreset(periodo) {
  const hoje = new Date();
  let inicio;
  const fim = hoje.toISOString().slice(0, 10);

  if (periodo === '7dias') {
    const d = new Date(hoje);
    d.setDate(d.getDate() - 6);
    inicio = d.toISOString().slice(0, 10);
  } else if (periodo === 'mes') {
    inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  } else if (periodo === 'ano') {
    inicio = new Date(hoje.getFullYear(), 0, 1).toISOString().slice(0, 10);
  }

  document.getElementById('relatorio-data-inicio').value = inicio;
  document.getElementById('relatorio-data-fim').value = fim;
}

async function calcularRelatorio(userId, dataInicio, dataFim) {
  const [turnos, despesas] = await Promise.all([
    Turnos.listarHistorico(userId, 100000),
    Despesas.listar(userId)
  ]);

  const fechados = turnos.filter((t) => t.status === 'fechado' && t.data_turno >= dataInicio && t.data_turno <= dataFim);

  const idsVeiculos = [...new Set(fechados.map((t) => t.veiculo_id))];
  const veiculosMap = {};
  await Promise.all(idsVeiculos.map(async (id) => {
    try { veiculosMap[id] = await Veiculos.obterPorId(id); } catch (e) { veiculosMap[id] = null; }
  }));

  let faturamentoTotal = 0, custoCombustivel = 0, custoManutencao = 0, custoDepreciacao = 0, distTotal = 0, lucroTotal = 0;
  fechados.forEach((t) => {
    const r = calcularTurno(t, veiculosMap[t.veiculo_id]);
    faturamentoTotal += Number(t.faturamento_bruto) || 0;
    custoCombustivel += r.custoCombustivel;
    custoManutencao += r.custoManutencao;
    custoDepreciacao += r.custoDepreciacao;
    distTotal += r.dist;
    lucroTotal += r.lucro;
  });

  const despesasPeriodo = despesas.filter((d) => d.data_despesa >= dataInicio && d.data_despesa <= dataFim);
  const totalDespesasReais = despesasPeriodo.reduce((soma, d) => soma + Number(d.valor), 0);

  return {
    dataInicio,
    dataFim,
    quantidadeTurnos: fechados.length,
    distanciaTotal: distTotal,
    faturamentoTotal,
    custoCombustivel,
    custoManutencao,
    custoDepreciacao,
    custoTotal: custoCombustivel + custoManutencao + custoDepreciacao,
    lucroTotal,
    lucroMedioPorTurno: fechados.length ? lucroTotal / fechados.length : 0,
    lucroMedioPorKm: distTotal > 0 ? lucroTotal / distTotal : null,
    totalDespesasReais,
    quantidadeDespesas: despesasPeriodo.length,
    // Saldo do Cofre relativo SÓ a este período (reservado no período − gasto real no período).
    // Não confundir com o card da home, que é o saldo acumulado desde sempre.
    saldoCofrePeriodo: (custoManutencao + custoDepreciacao) - totalDespesasReais
  };
}

function exibirRelatorio(r) {
  const resultado = document.getElementById('resultado-relatorio');
  const vazio = document.getElementById('relatorio-vazio');

  if (!r.quantidadeTurnos) {
    resultado.classList.add('hidden');
    vazio.classList.remove('hidden');
    return;
  }
  vazio.classList.add('hidden');
  resultado.classList.remove('hidden');

  const corLucro = r.lucroTotal >= 0 ? 'var(--lsr-green)' : 'var(--lsr-red)';
  document.getElementById('relatorio-lucro-liquido').textContent = formatarMoeda(r.lucroTotal);
  document.getElementById('relatorio-lucro-liquido').style.color = corLucro;
  document.getElementById('relatorio-qtd-turnos').textContent = r.quantidadeTurnos;
  document.getElementById('relatorio-distancia').textContent = `${r.distanciaTotal.toFixed(1)} km`;
  document.getElementById('relatorio-faturamento').textContent = formatarMoeda(r.faturamentoTotal);
  document.getElementById('relatorio-custo-combustivel').textContent = formatarMoeda(r.custoCombustivel);
  document.getElementById('relatorio-custo-manutencao').textContent = formatarMoeda(r.custoManutencao);
  document.getElementById('relatorio-custo-depreciacao').textContent = formatarMoeda(r.custoDepreciacao);
  document.getElementById('relatorio-custo-total').textContent = formatarMoeda(r.custoTotal);
  document.getElementById('relatorio-lucro-medio-turno').textContent = formatarMoeda(r.lucroMedioPorTurno);
  document.getElementById('relatorio-lucro-medio-km').textContent = r.lucroMedioPorKm !== null ? formatarMoeda(r.lucroMedioPorKm) : '—';
  document.getElementById('relatorio-despesas-reais').textContent = formatarMoeda(r.totalDespesasReais);
  document.getElementById('relatorio-despesas-qtd').textContent = `${r.quantidadeDespesas} despesa(s) registrada(s) no período`;
  const elSaldoCofre = document.getElementById('relatorio-saldo-cofre');
  elSaldoCofre.textContent = formatarMoeda(r.saldoCofrePeriodo);
  elSaldoCofre.style.color = r.saldoCofrePeriodo < 0 ? 'var(--lsr-red)' : '#ffb74d';
}

function baixarPdfRelatorio() {
  if (!ultimoRelatorioGerado || !window.jspdf) {
    alert('Gere o relatório antes de baixar o PDF.');
    return;
  }
  const r = ultimoRelatorioGerado;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  // Paleta (versão print-safe da identidade do app)
  const COR_ESCURA = [18, 18, 18];
  const COR_VERDE = [0, 168, 89];
  const COR_VERMELHA = [211, 47, 47];
  const COR_CINZA_TEXTO = [110, 110, 110];
  const COR_CINZA_CLARO_BG = [244, 244, 244];
  const COR_CINZA_MEDIO_BG = [232, 232, 232];

  const LARGURA_PAGINA = 210;
  const MARGEM = 14;
  const LARGURA_UTIL = LARGURA_PAGINA - MARGEM * 2;
  const lucroPositivo = r.lucroTotal >= 0;
  const corLucro = lucroPositivo ? COR_VERDE : COR_VERMELHA;

  // ------------------------------------------------------------
  // Cabeçalho: faixa escura com o nome do app
  // ------------------------------------------------------------
  doc.setFillColor(...COR_ESCURA);
  doc.rect(0, 0, LARGURA_PAGINA, 32, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(20);
  doc.text('LSR App', MARGEM, 16);

  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...COR_VERDE);
  doc.text('Lucro Sobre Rodas', MARGEM, 23);

  doc.setFontSize(9);
  doc.setTextColor(200, 200, 200);
  doc.text('Relatório Financeiro', LARGURA_PAGINA - MARGEM, 16, { align: 'right' });
  doc.text(`${formatarDataBR(r.dataInicio)}  a  ${formatarDataBR(r.dataFim)}`, LARGURA_PAGINA - MARGEM, 23, { align: 'right' });

  // ------------------------------------------------------------
  // Info do motorista
  // ------------------------------------------------------------
  let y = 42;
  doc.setTextColor(60, 60, 60);
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text(`Motorista: ${perfilAtual?.nome || '—'}`, MARGEM, y);

  // ------------------------------------------------------------
  // Card de destaque: LUCRO LÍQUIDO
  // ------------------------------------------------------------
  y += 8;
  const alturaCardLucro = 28;
  doc.setFillColor(...COR_CINZA_CLARO_BG);
  doc.roundedRect(MARGEM, y, LARGURA_UTIL, alturaCardLucro, 3, 3, 'F');
  doc.setDrawColor(...corLucro);
  doc.setLineWidth(0.8);
  doc.roundedRect(MARGEM, y, LARGURA_UTIL, alturaCardLucro, 3, 3, 'S');

  doc.setTextColor(...COR_CINZA_TEXTO);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.text('LUCRO LÍQUIDO DO PERÍODO', LARGURA_PAGINA / 2, y + 9, { align: 'center' });

  doc.setTextColor(...corLucro);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(22);
  doc.text(formatarMoeda(r.lucroTotal), LARGURA_PAGINA / 2, y + 21, { align: 'center' });

  y += alturaCardLucro + 12;

  // ------------------------------------------------------------
  // Helper: seção com título + linhas em "tabela" com zebra striping
  // ------------------------------------------------------------
  let primeiraSecao = true;
  function tituloSecao(texto) {
    if (!primeiraSecao) {
      // Linha divisória fina separando da seção anterior
      doc.setDrawColor(225, 225, 225);
      doc.setLineWidth(0.2);
      doc.line(MARGEM, y - 3, LARGURA_PAGINA - MARGEM, y - 3);
    }
    primeiraSecao = false;

    doc.setFillColor(...COR_ESCURA);
    doc.rect(MARGEM, y, 3, 5, 'F');
    doc.setTextColor(30, 30, 30);
    doc.setFont(undefined, 'bold');
    doc.setFontSize(11);
    doc.text(texto, MARGEM + 6, y + 4.5);
    y += 12; // espaço generoso — evita a faixa da primeira linha invadir o título
  }

  function linhaTabela(rotulo, valor, corValor, destaque) {
    const alturaLinha = 9;
    if (destaque) {
      doc.setFillColor(...COR_CINZA_MEDIO_BG);
      doc.rect(MARGEM, y - 6, LARGURA_UTIL, alturaLinha, 'F');
    }
    doc.setFont(undefined, destaque ? 'bold' : 'normal');
    doc.setFontSize(10);
    doc.setTextColor(70, 70, 70);
    doc.text(rotulo, MARGEM + 3, y);
    doc.setTextColor(...(corValor || [40, 40, 40]));
    doc.text(String(valor), LARGURA_PAGINA - MARGEM - 3, y, { align: 'right' });
    y += alturaLinha;
  }

  // ------------------------------------------------------------
  // Resumo operacional
  // ------------------------------------------------------------
  tituloSecao('Resumo Operacional');
  linhaTabela('Turnos fechados', r.quantidadeTurnos);
  linhaTabela('Distância total', `${r.distanciaTotal.toFixed(1)} km`);
  linhaTabela('Faturamento bruto', formatarMoeda(r.faturamentoTotal), COR_VERDE, true);

  y += 6;

  // ------------------------------------------------------------
  // Custos operacionais
  // ------------------------------------------------------------
  tituloSecao('Custos Operacionais');
  linhaTabela('Combustível', formatarMoeda(r.custoCombustivel), COR_VERMELHA);
  linhaTabela('Manutenção', formatarMoeda(r.custoManutencao), COR_VERMELHA);
  linhaTabela('Depreciação', formatarMoeda(r.custoDepreciacao), COR_VERMELHA);
  linhaTabela('Custo total operacional', formatarMoeda(r.custoTotal), COR_VERMELHA, true);

  y += 6;

  // ------------------------------------------------------------
  // Indicadores de performance
  // ------------------------------------------------------------
  tituloSecao('Indicadores');
  linhaTabela('Lucro médio por turno', formatarMoeda(r.lucroMedioPorTurno), corLucro);
  linhaTabela('Lucro médio por km', r.lucroMedioPorKm !== null ? formatarMoeda(r.lucroMedioPorKm) : '—', corLucro);

  y += 6;

  // ------------------------------------------------------------
  // Despesas reais de manutenção
  // ------------------------------------------------------------
  tituloSecao('Cofre de Manutenção (neste período)');
  linhaTabela('Reservado (manutenção + depreciação)', formatarMoeda(r.custoManutencao + r.custoDepreciacao));
  linhaTabela('Gasto real registrado', formatarMoeda(r.totalDespesasReais), COR_VERMELHA);
  linhaTabela('Quantidade de despesas', r.quantidadeDespesas);
  linhaTabela(
    'Saldo do Cofre no período',
    formatarMoeda(r.saldoCofrePeriodo),
    r.saldoCofrePeriodo < 0 ? COR_VERMELHA : [204, 130, 0],
    true
  );

  // ------------------------------------------------------------
  // Rodapé
  // ------------------------------------------------------------
  const alturaPagina = doc.internal.pageSize.getHeight();
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.3);
  doc.line(MARGEM, alturaPagina - 18, LARGURA_PAGINA - MARGEM, alturaPagina - 18);

  doc.setFont(undefined, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COR_CINZA_TEXTO);
  doc.text('Desenvolvido por Jhony Beraldo', MARGEM, alturaPagina - 12);
  doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')}`, LARGURA_PAGINA - MARGEM, alturaPagina - 12, { align: 'right' });

  doc.save(`relatorio-lsr-${r.dataInicio}-a-${r.dataFim}.pdf`);
}

function fecharModalNovaDespesa() {
  document.getElementById('modal-nova-despesa').classList.add('hidden');
  despesaEmEdicaoId = null;
}

function verificarTurnoEsquecido() {
  if (!turnoAtivoAtual) return;
  const horasDesdeInicio = (Date.now() - new Date(turnoAtivoAtual.tempo_inicio).getTime()) / (1000 * 60 * 60);
  if (horasDesdeInicio >= 16) {
    document.getElementById('modal-turno-esquecido').classList.remove('hidden');
  }
}

// ------------------------------------------------------------
// PREÇO DO COMBUSTÍVEL
// ------------------------------------------------------------
function abrirModalPreco() {
  esconderErro('erro-preco-combustivel');
  document.getElementById('input-preco-combustivel').value = perfilAtual?.preco_combustivel_atual || '';
  document.getElementById('modal-preco-combustivel').classList.remove('hidden');
}

function fecharModalPreco() {
  document.getElementById('modal-preco-combustivel').classList.add('hidden');
}

// ------------------------------------------------------------
// INICIAR TURNO
// ------------------------------------------------------------
async function abrirModalIniciarTurno() {
  esconderErro('erro-iniciar-turno');
  document.getElementById('aviso-km-inicial').classList.add('hidden');
  document.getElementById('input-km-inicial').value = '';

  veiculosAtivosCache = await Veiculos.listarAtivos(usuarioAtual.id);
  const select = document.getElementById('select-veiculo-turno');
  select.innerHTML = '';

  if (!veiculosAtivosCache.length) {
    select.innerHTML = '<option value="">Nenhum veículo cadastrado</option>';
  } else {
    veiculosAtivosCache.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${iconeTipoVeiculo(v.tipo)} ${v.nome_modelo}`;
      select.appendChild(opt);
    });
  }

  document.getElementById('modal-iniciar-turno').classList.remove('hidden');
}

function fecharModalIniciarTurno() {
  document.getElementById('modal-iniciar-turno').classList.add('hidden');
}

// ------------------------------------------------------------
// ENCERRAR TURNO
// ------------------------------------------------------------
function abrirModalEncerrarTurno() {
  esconderErro('erro-encerrar-turno');
  document.getElementById('input-km-final').value = '';
  document.getElementById('input-faturamento').value = '';
  document.getElementById('input-preco-combustivel-turno').value = perfilAtual?.preco_combustivel_atual || '';
  document.getElementById('modal-turno-esquecido').classList.add('hidden');
  document.getElementById('modal-encerrar-turno').classList.remove('hidden');
}

function fecharModalEncerrarTurno() {
  document.getElementById('modal-encerrar-turno').classList.add('hidden');
}

async function processarEncerramentoFinal() {
  const btn = document.getElementById('btn-confirmar-encerrar-final');
  btn.disabled = true;
  btn.textContent = 'Encerrando...';

  try {
    const turnoFechado = await Turnos.encerrar({
      turnoId: turnoAtivoAtual.id,
      kmFinal: dadosEncerramentoPendente.kmFinal,
      faturamentoBruto: dadosEncerramentoPendente.faturamentoBruto,
      precoCombustivelTurno: dadosEncerramentoPendente.precoCombustivelTurno
    });

    let veiculo = null;
    try {
      veiculo = await Veiculos.obterPorId(turnoFechado.veiculo_id);
    } catch (err) {
      console.warn('[App] Veículo não disponível offline pro cálculo do resultado:', err);
    }
    const resultado = calcularTurno(turnoFechado, veiculo);

    exibirResultadoTurno(resultado);

    // Se o preço digitado ao encerrar for diferente do padrão salvo no perfil,
    // atualiza o padrão — assim, da próxima vez (depois de abastecer com preço
    // novo), o valor sugerido já vem correto. O snapshot histórico deste turno
    // (preco_combustivel_turno) já foi salvo congelado e não é afetado por isso.
    const precoDigitado = dadosEncerramentoPendente.precoCombustivelTurno;
    if (navigator.onLine && precoDigitado !== perfilAtual?.preco_combustivel_atual) {
      try {
        perfilAtual = await Auth.atualizarPrecoCombustivel(usuarioAtual.id, precoDigitado);
      } catch (err) {
        console.warn('[App] Não foi possível atualizar o preço padrão do combustível:', err);
      }
    }

    document.getElementById('modal-confirmar-encerrar').classList.add('hidden');
    fecharModalEncerrarTurno();
    dadosEncerramentoPendente = null;
    await atualizarStatusConexao();

    origemTelaResultado = 'fechamento';
    turnoDetalheAtual = null;
    document.getElementById('btn-editar-detalhe').classList.add('hidden');
    document.getElementById('btn-voltar-resultado').textContent = 'Voltar à home';
    mostrarTela('tela-resultado-turno');
  } catch (err) {
    console.error(err);
    alert('Não foi possível encerrar o turno. Tente novamente.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar';
  }
}

// ------------------------------------------------------------
// PAINEL MASTER
// ------------------------------------------------------------
let motoristaEmContextoId = null; // usado pelos modais de plano/reset de senha
let motoristasCache = [];
let turnosPorMotoristaCache = {};
let diasAvisoCache = 3;
let filtroTextoMotorista = '';
let filtroApenasVencendo = false;
let planoEmEdicaoId = null; // usado no cadastro/edição de planos (tela de config)

/**
 * Dias restantes até o vencimento (negativo = já venceu). null se sem plano.
 */
function diasAteVencimento(dataISO) {
  if (!dataISO) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const venc = new Date(dataISO + 'T00:00:00');
  return Math.round((venc - hoje) / (1000 * 60 * 60 * 24));
}

/**
 * Abre o WhatsApp com uma mensagem de lembrete pré-preenchida.
 */
const WHATSAPP_SUPORTE_PADRAO = '44984373004';

/**
 * Abre o WhatsApp de suporte (número configurável pelo master).
 * Funciona mesmo na tela de login, sem estar autenticado.
 */
async function abrirWhatsAppSuporte() {
  let numero = WHATSAPP_SUPORTE_PADRAO;
  try {
    const valor = await Auth.getConfig('whatsapp_suporte');
    if (valor) numero = valor;
  } catch (e) {
    // Offline ou falha — usa o padrão mesmo, não trava o botão
  }
  numero = numero.replace(/\D/g, '');
  if (numero.length <= 11) numero = '55' + numero;
  window.open(`https://wa.me/${numero}`, '_blank');
}

function abrirWhatsAppLembrete(whatsapp, nome, dias) {
  let numero = (whatsapp || '').replace(/\D/g, '');
  if (!numero) return;
  if (numero.length <= 11) numero = '55' + numero; // adiciona código do Brasil se não tiver

  let mensagem;
  if (dias === null) {
    mensagem = `Olá ${nome}! Tudo bem? Aqui é sobre o seu acesso ao LSR App.`;
  } else if (dias < 0) {
    mensagem = `Olá ${nome}! Seu plano do LSR App venceu há ${Math.abs(dias)} dia(s). Vamos renovar pra você continuar usando sem interrupções?`;
  } else if (dias === 0) {
    mensagem = `Olá ${nome}! Seu plano do LSR App vence hoje. Vamos renovar pra você continuar usando sem interrupções?`;
  } else {
    mensagem = `Olá ${nome}! Seu plano do LSR App vence em ${dias} dia(s). Vamos renovar pra você continuar usando sem interrupções?`;
  }

  window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`, '_blank');
}

function formatarVencimento(dataISO) {
  if (!dataISO) return { texto: 'Sem plano definido', cor: 'var(--lsr-text-muted)' };
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const venc = new Date(dataISO + 'T00:00:00');
  const dias = Math.round((venc - hoje) / (1000 * 60 * 60 * 24));

  if (dias < 0) {
    return { texto: `Vencido há ${Math.abs(dias)} dia(s)`, cor: 'var(--lsr-red)' };
  }
  if (dias === 0) {
    return { texto: 'Vence hoje', cor: 'var(--lsr-red)' };
  }
  if (dias <= 7) {
    return { texto: `Vence em ${dias} dia(s)`, cor: '#ffb74d' };
  }
  return { texto: `Vence em ${formatarDataBR(dataISO)}`, cor: 'var(--lsr-text-muted)' };
}

async function carregarPainelAdmin() {
  try {
    const [motoristas, totalTurnos, turnosPorMotorista, diasAviso] = await Promise.all([
      Admin.listarMotoristas(),
      Admin.contarTurnosTotais(),
      Admin.contarTurnosPorMotorista(),
      Admin.getDiasAvisoVencimento()
    ]);

    const ativos = motoristas.filter((m) => m.is_ativo);
    const pendentes = motoristas.filter((m) => !m.is_ativo);

    document.getElementById('admin-total-motoristas').textContent = ativos.length;
    document.getElementById('admin-total-turnos').textContent = totalTurnos;

    motoristasCache = motoristas;
    turnosPorMotoristaCache = turnosPorMotorista;
    diasAvisoCache = diasAviso;

    // Pendentes
    const containerPendentes = document.getElementById('admin-lista-pendentes');
    const pendentesVazio = document.getElementById('admin-pendentes-vazio');
    containerPendentes.innerHTML = '';

    if (!pendentes.length) {
      pendentesVazio.classList.remove('hidden');
    } else {
      pendentesVazio.classList.add('hidden');
      pendentes.forEach((m) => {
        const card = document.createElement('div');
        card.className = 'card-lsr p-3 flex items-center justify-between';
        card.innerHTML = `
          <div>
            <p class="text-white text-sm">${m.nome || 'Sem nome'}</p>
            ${m.whatsapp ? `<p class="text-xs" style="color:var(--lsr-text-muted)">${m.whatsapp}</p>` : ''}
          </div>
          <button class="btn-aprovar-pendente text-sm font-semibold px-3 py-1 rounded-full" style="background-color:var(--lsr-green); color:#0a0a0a;" data-id="${m.id}">Aprovar</button>
        `;
        card.querySelector('.btn-aprovar-pendente').addEventListener('click', () => {
          abrirModalPlano(m.id, m.nome, null, 'Aprovar');
        });
        containerPendentes.appendChild(card);
      });
    }

    renderizarListaMotoristas();
  } catch (err) {
    console.error('[App] Erro ao carregar painel admin:', err);
    alert('Não foi possível carregar o painel. Verifique sua conexão.');
  }
}

/**
 * Renderiza a lista de motoristas como cards COMPACTOS (só nome + status),
 * já filtrados pela busca e pelo toggle "só vencidos/vencendo". Clicar
 * num card abre o modal de detalhe com tudo (WhatsApp, plano, ações).
 * Usa o cache em memória — não refaz a consulta ao servidor.
 */
function renderizarListaMotoristas() {
  const container = document.getElementById('admin-lista-motoristas');
  const vazio = document.getElementById('admin-lista-motoristas-vazio');
  container.innerHTML = '';

  const textoBusca = filtroTextoMotorista.trim().toLowerCase();

  const filtrados = motoristasCache.filter((m) => {
    if (textoBusca && !(m.nome || '').toLowerCase().includes(textoBusca)) return false;
    if (filtroApenasVencendo) {
      const dias = diasAteVencimento(m.plano_vencimento);
      if (dias === null || dias > diasAvisoCache) return false;
    }
    return true;
  });

  if (!filtrados.length) {
    vazio.classList.remove('hidden');
    return;
  }
  vazio.classList.add('hidden');

  filtrados.forEach((m) => {
    const dias = diasAteVencimento(m.plano_vencimento);
    let corBorda = 'transparent';
    if (dias !== null) {
      if (dias < 0) corBorda = 'var(--lsr-red)';
      else if (dias <= diasAvisoCache) corBorda = '#ffb74d';
    }
    const statusCor = m.is_ativo ? 'var(--lsr-green)' : 'var(--lsr-red)';
    const statusTexto = m.is_ativo ? 'Ativo' : 'Bloqueado';

    const card = document.createElement('div');
    card.className = 'card-lsr p-3 flex items-center justify-between cursor-pointer';
    card.style.borderLeft = `4px solid ${corBorda}`;
    card.innerHTML = `
      <div>
        <p class="text-white text-sm font-semibold">${m.nome || 'Sem nome'}</p>
        <p class="text-xs" style="color:${statusCor}">${statusTexto}</p>
      </div>
      <span class="text-lg" style="color:var(--lsr-text-muted)">›</span>
    `;
    card.addEventListener('click', () => abrirDetalheMotorista(m.id));
    container.appendChild(card);
  });
}

// ------------------------------------------------------------
// Modal: detalhe do motorista (aberto ao clicar no card compacto)
// ------------------------------------------------------------
function abrirDetalheMotorista(motoristaId) {
  const m = motoristasCache.find((x) => x.id === motoristaId);
  if (!m) return;

  motoristaEmContextoId = motoristaId;
  const dias = diasAteVencimento(m.plano_vencimento);
  const venc = formatarVencimento(m.plano_vencimento);
  const totalTurnosMotorista = turnosPorMotoristaCache[m.id] || 0;

  document.getElementById('detalhe-motorista-nome').textContent = m.nome || 'Sem nome';
  document.getElementById('detalhe-motorista-whatsapp').textContent = m.whatsapp || '—';
  document.getElementById('detalhe-motorista-status').textContent = m.is_ativo ? 'Ativo' : 'Bloqueado';
  document.getElementById('detalhe-motorista-status').style.color = m.is_ativo ? 'var(--lsr-green)' : 'var(--lsr-red)';
  const textoPlano = m.plano_nome ? m.plano_nome + (m.plano_valor ? ` · ${formatarMoeda(m.plano_valor)}` : '') : 'Sem plano definido';
  document.getElementById('detalhe-motorista-plano').textContent = textoPlano;
  document.getElementById('detalhe-motorista-vencimento').textContent = venc.texto;
  document.getElementById('detalhe-motorista-vencimento').style.color = venc.cor;
  document.getElementById('detalhe-motorista-turnos').textContent = totalTurnosMotorista;

  const btnWhats = document.getElementById('btn-detalhe-whatsapp');
  btnWhats.style.display = m.whatsapp ? 'flex' : 'none';
  btnWhats.onclick = () => abrirWhatsAppLembrete(m.whatsapp, m.nome, dias);

  document.getElementById('btn-detalhe-renovar').onclick = () => {
    fecharModalDetalheMotorista();
    abrirModalPlano(m.id, m.nome, m.plano_vencimento, 'Renovar');
  };

  document.getElementById('btn-detalhe-senha').onclick = () => {
    fecharModalDetalheMotorista();
    abrirModalResetarSenha(m.id, m.nome);
  };

  const btnToggle = document.getElementById('btn-detalhe-toggle');
  btnToggle.textContent = m.is_ativo ? 'Bloquear acesso' : 'Liberar acesso';
  btnToggle.onclick = async () => {
    btnToggle.disabled = true;
    try {
      if (m.is_ativo) {
        await Admin.bloquearMotorista(m.id);
      } else {
        await Admin.aprovarMotorista(m.id);
      }
      fecharModalDetalheMotorista();
      await carregarPainelAdmin();
    } catch (err) {
      console.error(err);
      alert('Não foi possível atualizar. Verifique sua conexão.');
      btnToggle.disabled = false;
    }
  };

  document.getElementById('modal-detalhe-motorista').classList.remove('hidden');
}

function fecharModalDetalheMotorista() {
  document.getElementById('modal-detalhe-motorista').classList.add('hidden');
  motoristaEmContextoId = null;
}

// ------------------------------------------------------------
// TELA DE CONFIGURAÇÕES (tolerância offline, aviso, planos)
// ------------------------------------------------------------
async function carregarConfigPlanos() {
  try {
    const planos = await Admin.listarPlanos(true);
    const container = document.getElementById('lista-planos-config');
    const vazio = document.getElementById('planos-config-vazio');
    container.innerHTML = '';

    if (!planos.length) {
      vazio.classList.remove('hidden');
      return;
    }
    vazio.classList.add('hidden');

    planos.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'card-lsr p-3 flex items-center justify-between cursor-pointer';
      card.style.opacity = p.is_ativo ? '1' : '0.5';
      card.innerHTML = `
        <div>
          <p class="text-white text-sm font-semibold">${p.nome}</p>
          <p class="text-xs" style="color:var(--lsr-text-muted)">${p.dias_duracao} dias · ${p.valor > 0 ? formatarMoeda(p.valor) : 'Grátis'}${!p.is_ativo ? ' · Inativo' : ''}</p>
        </div>
        <span class="text-lg" style="color:var(--lsr-text-muted)">›</span>
      `;
      card.addEventListener('click', () => abrirModalCadastrarPlano(p));
      container.appendChild(card);
    });
  } catch (err) {
    console.error('[App] Erro ao carregar planos:', err);
    alert('Não foi possível carregar os planos. Verifique sua conexão.');
  }
}

async function carregarConfigTolerancia() {
  try {
    document.getElementById('input-prazo-offline').value = await Admin.getPrazoOfflineDias();
  } catch (err) {
    console.error('[App] Erro ao carregar tolerância offline:', err);
  }
}

async function carregarConfigAviso() {
  try {
    document.getElementById('input-dias-aviso').value = await Admin.getDiasAvisoVencimento();
  } catch (err) {
    console.error('[App] Erro ao carregar aviso de vencimento:', err);
  }
}

async function carregarConfigWhatsapp() {
  try {
    const valor = await Auth.getConfig('whatsapp_suporte');
    document.getElementById('input-whatsapp-suporte').value = valor || WHATSAPP_SUPORTE_PADRAO;
  } catch (err) {
    console.error('[App] Erro ao carregar WhatsApp de suporte:', err);
  }
}

async function carregarConfigIndicacao() {
  try {
    const [configIndicacao, indicacoes] = await Promise.all([
      Admin.getConfigIndicacao(),
      Admin.listarIndicacoesRecentes(20)
    ]);
    document.getElementById('input-indicacao-dias-bonus').value = configIndicacao.diasBonus;
    document.getElementById('input-indicacao-dias-minimo').value = configIndicacao.diasMinimo;

    const container = document.getElementById('lista-indicacoes');
    const vazio = document.getElementById('indicacoes-vazio');
    container.innerHTML = '';

    if (!indicacoes.length) {
      vazio.classList.remove('hidden');
      return;
    }
    vazio.classList.add('hidden');

    indicacoes.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'card-lsr p-3';
      item.innerHTML = `
        <p class="text-sm text-white"><strong>${r.indicadorNome}</strong> indicou <strong>${r.indicadoNome}</strong></p>
        <p class="text-xs" style="color:var(--lsr-green)">+${r.dias_bonus_concedidos} dias de bônus · ${formatarDataBR(r.created_at.slice(0, 10))}</p>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    console.error('[App] Erro ao carregar programa de indicação:', err);
    alert('Não foi possível carregar. Verifique sua conexão.');
  }
}

function abrirModalCadastrarPlano(planoExistente) {
  esconderErro('erro-cadastrar-plano');
  planoEmEdicaoId = planoExistente ? planoExistente.id : null;
  document.getElementById('modal-cadastrar-plano-titulo').textContent = planoExistente ? 'Editar plano' : 'Novo plano';
  document.getElementById('plano-cadastro-id').value = planoExistente ? planoExistente.id : '';
  document.getElementById('plano-cadastro-nome').value = planoExistente ? planoExistente.nome : '';
  document.getElementById('plano-cadastro-dias').value = planoExistente ? planoExistente.dias_duracao : '';
  document.getElementById('plano-cadastro-valor').value = planoExistente ? planoExistente.valor : '';

  const btnToggle = document.getElementById('btn-alternar-ativo-plano');
  if (planoExistente) {
    btnToggle.classList.remove('hidden');
    btnToggle.textContent = planoExistente.is_ativo ? 'Desativar plano' : 'Ativar plano';
    btnToggle.onclick = async () => {
      btnToggle.disabled = true;
      try {
        await Admin.alternarAtivoPlano(planoExistente.id, !planoExistente.is_ativo);
        fecharModalCadastrarPlano();
        await carregarConfigPlanos();
      } catch (err) {
        console.error(err);
        alert('Não foi possível atualizar. Verifique sua conexão.');
        btnToggle.disabled = false;
      }
    };
  } else {
    btnToggle.classList.add('hidden');
  }

  document.getElementById('modal-cadastrar-plano').classList.remove('hidden');
}

function fecharModalCadastrarPlano() {
  document.getElementById('modal-cadastrar-plano').classList.add('hidden');
  planoEmEdicaoId = null;
}

// ------------------------------------------------------------
// Modal: escolher plano (aprovar pendente ou renovar existente)
// Busca os planos ATIVOS na hora, sempre atualizados.
// ------------------------------------------------------------
async function abrirModalPlano(motoristaId, nomeMotorista, vencimentoAtual, tituloAcao) {
  motoristaEmContextoId = motoristaId;
  document.getElementById('modal-plano-titulo').textContent = `${tituloAcao} motorista`;
  document.getElementById('modal-plano-motorista-nome').textContent = nomeMotorista || '';
  document.getElementById('modal-plano-motorista').dataset.vencimentoAtual = vencimentoAtual || '';

  const container = document.getElementById('lista-planos-selecao');
  const vazio = document.getElementById('planos-selecao-vazio');
  container.innerHTML = '<p class="text-sm text-center py-2" style="color:var(--lsr-text-muted)">Carregando...</p>';
  document.getElementById('modal-plano-motorista').classList.remove('hidden');

  try {
    const planos = await Admin.listarPlanos(false);
    container.innerHTML = '';

    if (!planos.length) {
      vazio.classList.remove('hidden');
      return;
    }
    vazio.classList.add('hidden');

    planos.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-lsr btn-lsr-outline w-full justify-between px-4';
      btn.innerHTML = `<span>${p.nome}</span><span style="color:var(--lsr-text-muted)">${p.valor > 0 ? formatarMoeda(p.valor) : 'Grátis'} · ${p.dias_duracao}d</span>`;
      btn.addEventListener('click', async () => {
        container.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          await Admin.aprovarComPlano(motoristaId, p.id, vencimentoAtual);
          fecharModalPlano();
          await carregarPainelAdmin();
        } catch (err) {
          console.error(err);
          alert('Não foi possível salvar o plano. Verifique sua conexão.');
          container.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
      });
      container.appendChild(btn);
    });
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p class="text-sm text-center py-2" style="color:var(--lsr-red)">Erro ao carregar planos.</p>';
  }
}

function fecharModalPlano() {
  document.getElementById('modal-plano-motorista').classList.add('hidden');
  motoristaEmContextoId = null;
}

// ------------------------------------------------------------
// Modal: resetar senha
// ------------------------------------------------------------
function abrirModalResetarSenha(motoristaId, nomeMotorista) {
  motoristaEmContextoId = motoristaId;
  document.getElementById('modal-resetar-senha-nome').textContent = nomeMotorista || '';
  document.getElementById('input-nova-senha').value = '';
  esconderErro('erro-resetar-senha');
  document.getElementById('modal-resetar-senha').classList.remove('hidden');
}

function fecharModalResetarSenha() {
  document.getElementById('modal-resetar-senha').classList.add('hidden');
  motoristaEmContextoId = null;
}

// ------------------------------------------------------------
// Aviso de vencimento (lado do motorista, na home)
// ------------------------------------------------------------
async function atualizarAvisoVencimento() {
  const banner = document.getElementById('aviso-vencimento');
  const venc = perfilAtual?.plano_vencimento;

  if (!venc) {
    banner.classList.add('hidden');
    return;
  }

  let diasAviso = 3;
  try {
    diasAviso = await Admin.getDiasAvisoVencimento();
  } catch (err) {
    // offline ou sem acesso — usa o padrão, não impede nada
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dataVenc = new Date(venc + 'T00:00:00');
  const diasRestantes = Math.round((dataVenc - hoje) / (1000 * 60 * 60 * 24));

  if (diasRestantes > diasAviso) {
    banner.classList.add('hidden');
    return;
  }

  const texto = diasRestantes < 0
    ? `⚠️ Seu plano venceu há ${Math.abs(diasRestantes)} dia(s). Entre em contato para renovar.`
    : diasRestantes === 0
      ? '⚠️ Seu plano vence hoje. Entre em contato para renovar.'
      : `⚠️ Seu plano vence em ${diasRestantes} dia(s). Entre em contato para renovar.`;

  document.getElementById('aviso-vencimento-texto').textContent = texto;
  banner.classList.remove('hidden');
}

// ------------------------------------------------------------
// HISTÓRICO
// ------------------------------------------------------------
async function carregarHistorico() {
  const container = document.getElementById('lista-historico');
  const vazio = document.getElementById('historico-vazio');
  container.innerHTML = '<p class="text-sm text-center py-4" style="color:var(--lsr-text-muted)">Carregando...</p>';

  const turnos = await Turnos.listarHistorico(usuarioAtual.id, 200);

  if (!turnos.length) {
    container.innerHTML = '';
    vazio.classList.remove('hidden');
    atualizarResumoHistorico([], {});
    return;
  }
  vazio.classList.add('hidden');

  // Monta um mapa de veículos (cache-first, com fallback remoto).
  // Busca todos os veículos distintos EM PARALELO (não um de cada vez),
  // já que isso não tinha dependência entre si e só deixava tudo mais lento.
  const idsVeiculosUnicos = [...new Set(turnos.map((t) => t.veiculo_id))];
  const veiculosMap = {};
  await Promise.all(idsVeiculosUnicos.map(async (veiculoId) => {
    try {
      veiculosMap[veiculoId] = await Veiculos.obterPorId(veiculoId);
    } catch (err) {
      veiculosMap[veiculoId] = null;
    }
  }));

  atualizarResumoHistorico(turnos.filter((t) => t.status === 'fechado'), veiculosMap);

  container.innerHTML = '';
  turnos.forEach((t) => {
    const veiculo = veiculosMap[t.veiculo_id];
    const nomeVeiculo = veiculo ? `${iconeTipoVeiculo(veiculo.tipo)} ${veiculo.nome_modelo}` : 'Veículo';
    const card = document.createElement('div');

    if (t.status === 'fechado') {
      const r = calcularTurno(t, veiculo);
      const corLucro = r.lucro >= 0 ? 'var(--lsr-green)' : 'var(--lsr-red)';
      card.className = 'card-lsr p-4 flex items-center justify-between cursor-pointer';
      card.innerHTML = `
        <div>
          <p class="text-white font-semibold">${formatarDataBR(t.data_turno)}</p>
          <p class="text-xs" style="color:var(--lsr-text-muted)">${nomeVeiculo} · ${r.dist.toFixed(1)} km</p>
        </div>
        <div class="text-right">
          <p class="font-bold" style="color:${corLucro}">${formatarMoeda(r.lucro)}</p>
          <p class="text-xs" style="color:var(--lsr-text-muted)">${r.lucroPorKm !== null ? formatarMoeda(r.lucroPorKm) + '/km' : ''}</p>
        </div>
      `;
      card.addEventListener('click', () => abrirDetalheTurno(t, veiculo));
    } else {
      card.className = 'card-lsr p-4 flex items-center justify-between opacity-50';
      card.innerHTML = `
        <div>
          <p class="text-white font-semibold">${formatarDataBR(t.data_turno)}</p>
          <p class="text-xs" style="color:var(--lsr-text-muted)">${nomeVeiculo}</p>
        </div>
        <p class="text-xs" style="color:var(--lsr-text-muted)">Descartado</p>
      `;
    }

    container.appendChild(card);
  });

  await atualizarStatusConexao();
}

function atualizarResumoHistorico(turnosFechados, veiculosMap) {
  const hoje = new Date();
  const seteDiasAtras = new Date(hoje);
  seteDiasAtras.setDate(hoje.getDate() - 6);
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  function resumoDoPeriodo(dataMinima) {
    let lucro = 0;
    let qtd = 0;
    turnosFechados.forEach((t) => {
      if (new Date(t.data_turno) >= dataMinima) {
        const r = calcularTurno(t, veiculosMap[t.veiculo_id]);
        lucro += r.lucro;
        qtd += 1;
      }
    });
    return { lucro, qtd };
  }

  const semana = resumoDoPeriodo(seteDiasAtras);
  const mes = resumoDoPeriodo(inicioMes);

  document.getElementById('resumo-semana-lucro').textContent = formatarMoeda(semana.lucro);
  document.getElementById('resumo-semana-turnos').textContent = `${semana.qtd} turno(s)`;
  document.getElementById('resumo-mes-lucro').textContent = formatarMoeda(mes.lucro);
  document.getElementById('resumo-mes-turnos').textContent = `${mes.qtd} turno(s)`;
}

/**
 * Mostra a tela de detalhe/resultado de um turno JÁ FECHADO,
 * vindo do Histórico — com botão de Editar visível.
 */
function abrirDetalheTurno(turno, veiculo) {
  origemTelaResultado = 'historico';
  turnoDetalheAtual = { turno, veiculo };

  const r = calcularTurno(turno, veiculo);
  exibirResultadoTurno(r);

  document.getElementById('btn-editar-detalhe').classList.remove('hidden');
  document.getElementById('btn-voltar-resultado').textContent = 'Voltar ao Histórico';
  mostrarTela('tela-resultado-turno');
}

function abrirModalEditarTurno(turno, veiculo) {
  esconderErro('erro-editar-turno');
  document.getElementById('editar-turno-id').value = turno.id;
  document.getElementById('editar-turno-veiculo-nome').textContent = veiculo ? veiculo.nome_modelo : 'Veículo';
  document.getElementById('editar-turno-data').textContent = formatarDataBR(turno.data_turno);
  document.getElementById('input-editar-km-inicial').value = turno.km_inicial;
  document.getElementById('input-editar-km-final').value = turno.km_final;
  document.getElementById('input-editar-faturamento').value = turno.faturamento_bruto;
  document.getElementById('input-editar-preco-combustivel').value = turno.preco_combustivel_turno;
  document.getElementById('modal-editar-turno').classList.remove('hidden');
}

function fecharModalEditarTurno() {
  document.getElementById('modal-editar-turno').classList.add('hidden');
}

function exibirResultadoTurno(r) {
  const lucroPositivo = r.lucro >= 0;
  const corLucro = lucroPositivo ? 'var(--lsr-green)' : 'var(--lsr-red)';

  document.getElementById('resultado-lucro').textContent = formatarMoeda(r.lucro);
  document.getElementById('resultado-lucro').style.color = corLucro;
  document.getElementById('resultado-lucro-km').textContent = r.lucroPorKm !== null ? formatarMoeda(r.lucroPorKm) : '—';
  document.getElementById('resultado-dist').textContent = `${r.dist.toFixed(1)} km`;
  document.getElementById('resultado-faturamento').textContent = formatarMoeda(r.dist >= 0 ? (r.lucro + r.custoTotal) : null);
  document.getElementById('resultado-custo-combustivel').textContent = formatarMoeda(r.custoCombustivel);
  document.getElementById('resultado-custo-manutencao').textContent = formatarMoeda(r.custoManutencao);
  document.getElementById('resultado-custo-depreciacao').textContent = formatarMoeda(r.custoDepreciacao);
  document.getElementById('resultado-custo-total').textContent = formatarMoeda(r.custoTotal);
}

// ------------------------------------------------------------
// Handlers de formulário
// ------------------------------------------------------------
/**
 * Impede, em tempo real, que o campo de usuário vire um "e-mail colado":
 * corta tudo a partir do primeiro "@" digitado (proteção extra, caso
 * alguém digite por hábito).
 */
function sanitizarCampoUsuario(inputEl) {
  inputEl.addEventListener('input', () => {
    if (inputEl.value.includes('@')) {
      inputEl.value = inputEl.value.split('@')[0];
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  inicializarApp();

  sanitizarCampoUsuario(document.getElementById('login-email'));
  sanitizarCampoUsuario(document.getElementById('cadastro-usuario'));

  // Login
  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-login');
    const nomeUsuario = document.getElementById('login-email').value.trim();
    const senha = document.getElementById('login-senha').value;
    const btn = document.getElementById('btn-login');

    btn.disabled = true;
    btn.textContent = 'Entrando...';
    try {
      const usuario = await Auth.login(nomeUsuario, senha);
      await verificarAcessoEDirecionar(usuario);
    } catch (err) {
      mostrarErro('erro-login', 'Usuário ou senha inválidos.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });

  // Cadastro
  document.getElementById('form-cadastro').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-cadastro');
    const nomeUsuario = document.getElementById('cadastro-usuario').value.trim();
    const senha = document.getElementById('cadastro-senha').value;
    const whatsapp = document.getElementById('cadastro-whatsapp').value.trim();
    const btn = document.getElementById('btn-cadastro');

    if (nomeUsuario.length < 3) {
      mostrarErro('erro-cadastro', 'Digite um usuário com no mínimo 3 caracteres.');
      return;
    }
    if (senha.length < 6) {
      mostrarErro('erro-cadastro', 'A senha precisa ter no mínimo 6 caracteres.');
      return;
    }
    if (whatsapp.length < 8) {
      mostrarErro('erro-cadastro', 'Digite um número de WhatsApp válido.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Criando conta...';
    try {
      await Auth.cadastrar(nomeUsuario, senha, whatsapp, lerCodigoIndicacaoCache());
      try { localStorage.removeItem(REF_CACHE_KEY); } catch (e) {}
      mostrarErro('erro-cadastro', 'Conta criada! Aguarde a aprovação do administrador para poder entrar.');
      document.getElementById('erro-cadastro').style.color = 'var(--lsr-green)';
    } catch (err) {
      const jaExiste = (err.message || '').toLowerCase().includes('already') || (err.message || '').toLowerCase().includes('registered');
      if (jaExiste) {
        mostrarErro('erro-cadastro', 'Esse usuário já existe. Escolha outro.');
      } else {
        mostrarErro('erro-cadastro', 'Não foi possível criar a conta. ' + (err.message || ''));
      }
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Criar conta';
    }
  });

  // Alternar entre telas de login e cadastro
  document.getElementById('link-ir-cadastro').addEventListener('click', (e) => {
    e.preventDefault();
    mostrarTela('tela-cadastro');
  });
  document.getElementById('link-ir-login').addEventListener('click', (e) => {
    e.preventDefault();
    mostrarTela('tela-login');
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await Auth.logout();
    try { localStorage.removeItem(SESSAO_CACHE_KEY); } catch (e) {}
    usuarioAtual = null;
    perfilAtual = null;
    turnoAtivoAtual = null;
    mostrarTela('tela-login');
  });

  // Tela de aguardando aprovação -> voltar ao login
  document.getElementById('btn-voltar-login-aguardando').addEventListener('click', () => {
    mostrarTela('tela-login');
  });

  // Relatório Financeiro
  document.getElementById('btn-ir-relatorio').addEventListener('click', () => {
    mostrarTela('tela-relatorio');
    definirPeriodoPreset('mes');
    document.getElementById('resultado-relatorio').classList.add('hidden');
    document.getElementById('relatorio-vazio').classList.add('hidden');
  });
  document.getElementById('btn-voltar-config-relatorio').addEventListener('click', () => {
    mostrarTela('tela-config-motorista');
  });

  document.querySelectorAll('.btn-periodo-relatorio').forEach((btn) => {
    btn.addEventListener('click', () => definirPeriodoPreset(btn.dataset.periodo));
  });

  document.getElementById('btn-gerar-relatorio').addEventListener('click', async () => {
    const dataInicio = document.getElementById('relatorio-data-inicio').value;
    const dataFim = document.getElementById('relatorio-data-fim').value;
    if (!dataInicio || !dataFim) {
      alert('Selecione o período (de/até).');
      return;
    }

    const btn = document.getElementById('btn-gerar-relatorio');
    btn.disabled = true;
    btn.textContent = 'Gerando...';
    try {
      const r = await calcularRelatorio(usuarioAtual.id, dataInicio, dataFim);
      ultimoRelatorioGerado = r;
      exibirRelatorio(r);
    } catch (err) {
      console.error(err);
      alert('Não foi possível gerar o relatório. Verifique sua conexão.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Gerar relatório';
    }
  });

  document.getElementById('btn-baixar-pdf-relatorio').addEventListener('click', baixarPdfRelatorio);

  // Despesas de manutenção
  document.getElementById('btn-ver-despesas').addEventListener('click', () => {
    mostrarTela('tela-despesas');
    carregarDespesas();
  });
  document.getElementById('btn-voltar-home-despesas').addEventListener('click', () => {
    mostrarTela('tela-home');
  });
  document.getElementById('btn-registrar-despesa').addEventListener('click', abrirModalNovaDespesa);
  document.getElementById('btn-nova-despesa').addEventListener('click', abrirModalNovaDespesa);
  document.getElementById('btn-fechar-modal-despesa').addEventListener('click', fecharModalNovaDespesa);

  document.getElementById('form-nova-despesa').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-nova-despesa');

    const veiculoId = document.getElementById('select-veiculo-despesa').value;
    const valor = parseFloat(document.getElementById('input-valor-despesa').value);
    const descricao = document.getElementById('input-descricao-despesa').value.trim();
    const dataDespesa = document.getElementById('input-data-despesa').value;

    if (!veiculoId) {
      mostrarErro('erro-nova-despesa', 'Selecione um veículo.');
      return;
    }
    if (!valor || valor <= 0) {
      mostrarErro('erro-nova-despesa', 'Digite um valor válido.');
      return;
    }
    if (!dataDespesa) {
      mostrarErro('erro-nova-despesa', 'Selecione uma data.');
      return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      if (despesaEmEdicaoId) {
        await Despesas.atualizar(despesaEmEdicaoId, { veiculoId, valor, descricao, dataDespesa });
      } else {
        await Despesas.registrar({ userId: usuarioAtual.id, veiculoId, valor, descricao, dataDespesa });
      }
      fecharModalNovaDespesa();
      await atualizarSaldoCofre();
      // Se a tela de despesas estiver visível, atualiza a lista também
      if (!document.getElementById('tela-despesas').classList.contains('hidden')) {
        await carregarDespesas();
      }
    } catch (err) {
      mostrarErro('erro-nova-despesa', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = despesaEmEdicaoId ? 'Salvar alterações' : 'Salvar despesa';
    }
  });

  // WhatsApp de suporte
  document.getElementById('btn-whatsapp-suporte-login').addEventListener('click', abrirWhatsAppSuporte);
  document.getElementById('btn-whatsapp-suporte-motorista').addEventListener('click', abrirWhatsAppSuporte);

  // Navegação: Home <-> Configurações do motorista
  document.getElementById('btn-abrir-config-motorista').addEventListener('click', () => {
    mostrarTela('tela-config-motorista');
  });
  document.getElementById('btn-voltar-home-config').addEventListener('click', () => {
    mostrarTela('tela-home');
  });

  // Indicar amigo
  document.getElementById('btn-indicar-amigo').addEventListener('click', abrirModalIndicarAmigo);
  document.getElementById('btn-fechar-indicar-amigo').addEventListener('click', fecharModalIndicarAmigo);
  document.getElementById('btn-copiar-indicacao').addEventListener('click', async () => {
    const btn = document.getElementById('btn-copiar-indicacao');
    try {
      await navigator.clipboard.writeText(gerarLinkIndicacao());
      const textoOriginal = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = textoOriginal; }, 2000);
    } catch (e) {
      alert('Não foi possível copiar. Selecione o link manualmente.');
    }
  });
  document.getElementById('btn-compartilhar-indicacao').addEventListener('click', async () => {
    const link = gerarLinkIndicacao();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'LSR App', text: 'Baixa o LSR App pra controlar seu lucro real como motorista de app!', url: link });
      } catch (e) { /* usuário cancelou o compartilhamento — tudo bem */ }
    } else {
      try {
        await navigator.clipboard.writeText(link);
        alert('Link copiado! Cole numa conversa pra compartilhar.');
      } catch (e) {
        alert('Não foi possível compartilhar. Selecione o link manualmente.');
      }
    }
  });

  // Navegação: Home <-> Veículos
  document.getElementById('btn-ir-veiculos').addEventListener('click', () => {
    mostrarTela('tela-veiculos');
    carregarListaVeiculos();
  });
  document.getElementById('btn-voltar-home').addEventListener('click', () => {
    mostrarTela('tela-home');
  });

  // Abrir modal: novo veículo
  document.getElementById('btn-novo-veiculo').addEventListener('click', () => {
    abrirModalVeiculo(null);
  });
  document.getElementById('btn-fechar-modal-veiculo').addEventListener('click', fecharModalVeiculo);

  // Submeter formulário de veículo (criar ou editar)
  document.getElementById('form-veiculo').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-veiculo');

    const dados = {
      userId: usuarioAtual.id,
      nomeModelo: document.getElementById('veiculo-nome').value.trim(),
      tipo: document.getElementById('veiculo-tipo').value,
      autonomiaKml: parseFloat(document.getElementById('veiculo-autonomia').value),
      taxaManutencaoKm: parseFloat(document.getElementById('veiculo-manutencao').value),
      taxaDepreciacaoKm: parseFloat(document.getElementById('veiculo-depreciacao').value)
    };

    if (!dados.autonomiaKml || dados.autonomiaKml <= 0) {
      mostrarErro('erro-veiculo', 'Autonomia precisa ser maior que zero.');
      return;
    }

    const btn = document.getElementById('btn-salvar-veiculo');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    try {
      if (veiculoEmEdicaoId) {
        await Veiculos.atualizar(veiculoEmEdicaoId, dados);
      } else {
        await Veiculos.criar(dados);
      }
      fecharModalVeiculo();
      await carregarListaVeiculos();
    } catch (err) {
      mostrarErro('erro-veiculo', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });

  // Confirmação de desativação
  document.getElementById('btn-cancelar-desativar').addEventListener('click', fecharConfirmarDesativar);
  document.getElementById('btn-confirmar-desativar').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirmar-desativar');
    btn.disabled = true;
    btn.textContent = 'Desativando...';
    try {
      await Veiculos.desativar(veiculoParaDesativarId);
      fecharConfirmarDesativar();
      await carregarListaVeiculos();
    } catch (err) {
      console.error(err);
      alert('Não foi possível desativar o veículo. Verifique sua conexão.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Desativar';
    }
  });

  // ------------------------------------------------------------
  // Preço do combustível
  // ------------------------------------------------------------
  document.getElementById('btn-editar-preco').addEventListener('click', abrirModalPreco);
  document.getElementById('btn-cancelar-preco').addEventListener('click', fecharModalPreco);

  document.getElementById('form-preco-combustivel').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-preco-combustivel');
    const preco = parseFloat(document.getElementById('input-preco-combustivel').value);

    if (!preco || preco <= 0) {
      mostrarErro('erro-preco-combustivel', 'Digite um valor maior que zero.');
      return;
    }

    try {
      perfilAtual = await Auth.atualizarPrecoCombustivel(usuarioAtual.id, preco);
      fecharModalPreco();
      await carregarEstadoHome();
    } catch (err) {
      mostrarErro('erro-preco-combustivel', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    }
  });

  // ------------------------------------------------------------
  // Iniciar turno
  // ------------------------------------------------------------
  document.getElementById('btn-iniciar-turno').addEventListener('click', abrirModalIniciarTurno);
  document.getElementById('btn-fechar-modal-iniciar').addEventListener('click', fecharModalIniciarTurno);

  document.getElementById('form-iniciar-turno').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-iniciar-turno');

    const veiculoId = document.getElementById('select-veiculo-turno').value;
    const kmInicial = parseFloat(document.getElementById('input-km-inicial').value);

    if (!veiculoId) {
      mostrarErro('erro-iniciar-turno', 'Cadastre um veículo antes de iniciar um turno.');
      return;
    }
    if (isNaN(kmInicial) || kmInicial < 0) {
      mostrarErro('erro-iniciar-turno', 'Digite um KM inicial válido.');
      return;
    }

    // Alerta (não bloqueio) comparando com o último turno fechado desse veículo
    const ultimoTurno = await Turnos.buscarUltimoTurnoFechado(usuarioAtual.id, veiculoId);
    if (ultimoTurno && kmInicial > ultimoTurno.km_final) {
      const confirmar = confirm(
        `Seu KM inicial (${kmInicial}) é maior que o último registrado (${ultimoTurno.km_final}). Confirmar início?`
      );
      if (!confirmar) return;
    } else if (ultimoTurno && kmInicial < ultimoTurno.km_final) {
      const confirmar = confirm(
        `Seu KM inicial (${kmInicial}) é MENOR que o último registrado (${ultimoTurno.km_final}). Confirmar início?`
      );
      if (!confirmar) return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Iniciando...';

    try {
      await Turnos.iniciar({ userId: usuarioAtual.id, veiculoId, kmInicial });
      fecharModalIniciarTurno();
      await carregarEstadoHome();
    } catch (err) {
      mostrarErro('erro-iniciar-turno', 'Não foi possível iniciar o turno.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '■ Iniciar';
    }
  });

  // ------------------------------------------------------------
  // Encerrar turno
  // ------------------------------------------------------------
  document.getElementById('btn-encerrar-turno').addEventListener('click', abrirModalEncerrarTurno);
  document.getElementById('btn-fechar-modal-encerrar').addEventListener('click', fecharModalEncerrarTurno);

  document.getElementById('form-encerrar-turno').addEventListener('submit', (e) => {
    e.preventDefault();
    esconderErro('erro-encerrar-turno');

    const kmFinal = parseFloat(document.getElementById('input-km-final').value);
    const faturamentoBruto = parseFloat(document.getElementById('input-faturamento').value);
    const precoCombustivelTurno = parseFloat(document.getElementById('input-preco-combustivel-turno').value);

    if (isNaN(kmFinal) || kmFinal < turnoAtivoAtual.km_inicial) {
      mostrarErro('erro-encerrar-turno', `O KM final não pode ser menor que o KM inicial (${turnoAtivoAtual.km_inicial}).`);
      return;
    }
    if (isNaN(faturamentoBruto) || faturamentoBruto < 0) {
      mostrarErro('erro-encerrar-turno', 'Digite um faturamento válido.');
      return;
    }
    if (isNaN(precoCombustivelTurno) || precoCombustivelTurno < 0) {
      mostrarErro('erro-encerrar-turno', 'Digite um preço de combustível válido.');
      return;
    }

    // Guarda os dados e pede confirmação de duplo clique antes de computar
    dadosEncerramentoPendente = { kmFinal, faturamentoBruto, precoCombustivelTurno };
    document.getElementById('modal-confirmar-encerrar').classList.remove('hidden');
  });

  document.getElementById('btn-cancelar-confirmar-encerrar').addEventListener('click', () => {
    document.getElementById('modal-confirmar-encerrar').classList.add('hidden');
    dadosEncerramentoPendente = null;
  });
  document.getElementById('btn-confirmar-encerrar-final').addEventListener('click', processarEncerramentoFinal);

  document.getElementById('btn-voltar-resultado').addEventListener('click', async () => {
    if (origemTelaResultado === 'historico') {
      mostrarTela('tela-historico');
      await carregarHistorico();
    } else {
      mostrarTela('tela-home');
      await carregarEstadoHome();
    }
  });

  document.getElementById('btn-editar-detalhe').addEventListener('click', () => {
    if (!turnoDetalheAtual) return;
    abrirModalEditarTurno(turnoDetalheAtual.turno, turnoDetalheAtual.veiculo);
  });

  // ------------------------------------------------------------
  // Turno esquecido
  // ------------------------------------------------------------
  document.getElementById('btn-esquecido-preencher').addEventListener('click', () => {
    abrirModalEncerrarTurno();
  });
  document.getElementById('btn-esquecido-descartar').addEventListener('click', async () => {
    try {
      await Turnos.descartar(turnoAtivoAtual.id);
      document.getElementById('modal-turno-esquecido').classList.add('hidden');
      await carregarEstadoHome();
    } catch (err) {
      console.error(err);
      alert('Não foi possível descartar o turno.');
    }
  });

  // ------------------------------------------------------------
  // Histórico
  // ------------------------------------------------------------
  document.getElementById('btn-ir-historico').addEventListener('click', () => {
    mostrarTela('tela-historico');
    carregarHistorico();
  });
  document.getElementById('btn-voltar-home-historico').addEventListener('click', () => {
    mostrarTela('tela-home');
  });

  document.getElementById('btn-fechar-modal-editar').addEventListener('click', fecharModalEditarTurno);

  // ------------------------------------------------------------
  // Painel Master
  // ------------------------------------------------------------
  document.getElementById('btn-logout-admin').addEventListener('click', async () => {
    await Auth.logout();
    try { localStorage.removeItem(SESSAO_CACHE_KEY); } catch (e) {}
    usuarioAtual = null;
    perfilAtual = null;
    mostrarTela('tela-login');
  });

  document.getElementById('btn-fechar-detalhe-motorista').addEventListener('click', fecharModalDetalheMotorista);

  // Navegação pra tela de configurações (agora um menu, com subtelas)
  document.getElementById('btn-abrir-config-admin').addEventListener('click', () => {
    mostrarTela('tela-config-admin');
  });
  document.getElementById('btn-voltar-admin-config').addEventListener('click', () => {
    mostrarTela('tela-admin');
  });

  document.getElementById('btn-menu-planos').addEventListener('click', () => {
    mostrarTela('tela-config-planos');
    carregarConfigPlanos();
  });
  document.getElementById('btn-menu-tolerancia').addEventListener('click', () => {
    mostrarTela('tela-config-tolerancia');
    carregarConfigTolerancia();
  });
  document.getElementById('btn-menu-aviso').addEventListener('click', () => {
    mostrarTela('tela-config-aviso');
    carregarConfigAviso();
  });
  document.getElementById('btn-menu-indicacao').addEventListener('click', () => {
    mostrarTela('tela-config-indicacao');
    carregarConfigIndicacao();
  });
  document.getElementById('btn-menu-whatsapp-suporte').addEventListener('click', () => {
    mostrarTela('tela-config-whatsapp');
    carregarConfigWhatsapp();
  });

  document.querySelectorAll('.btn-voltar-config-menu').forEach((btn) => {
    btn.addEventListener('click', () => mostrarTela('tela-config-admin'));
  });

  // Cadastro/edição de planos
  document.getElementById('btn-novo-plano').addEventListener('click', () => {
    abrirModalCadastrarPlano(null);
  });
  document.getElementById('btn-fechar-modal-plano-cadastro').addEventListener('click', fecharModalCadastrarPlano);

  document.getElementById('form-cadastrar-plano').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-cadastrar-plano');

    const nome = document.getElementById('plano-cadastro-nome').value.trim();
    const dias = parseInt(document.getElementById('plano-cadastro-dias').value, 10);
    const valor = parseFloat(document.getElementById('plano-cadastro-valor').value);

    if (!nome) {
      mostrarErro('erro-cadastrar-plano', 'Digite um nome pro plano.');
      return;
    }
    if (!dias || dias <= 0) {
      mostrarErro('erro-cadastrar-plano', 'A duração precisa ser maior que zero.');
      return;
    }
    if (isNaN(valor) || valor < 0) {
      mostrarErro('erro-cadastrar-plano', 'Digite um valor válido.');
      return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      if (planoEmEdicaoId) {
        await Admin.atualizarPlano(planoEmEdicaoId, { nome, diasDuracao: dias, valor });
      } else {
        await Admin.criarPlano({ nome, diasDuracao: dias, valor });
      }
      fecharModalCadastrarPlano();
      await carregarConfigPlanos();
    } catch (err) {
      mostrarErro('erro-cadastrar-plano', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar plano';
    }
  });

  // Troca obrigatória de senha (após reset pelo master)
  document.getElementById('form-trocar-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-trocar-senha');

    const novaSenha = document.getElementById('trocar-senha-nova').value;
    const confirmar = document.getElementById('trocar-senha-confirmar').value;

    if (novaSenha.length < 6) {
      mostrarErro('erro-trocar-senha', 'A senha precisa ter no mínimo 6 caracteres.');
      return;
    }
    if (novaSenha !== confirmar) {
      mostrarErro('erro-trocar-senha', 'As senhas não coincidem.');
      return;
    }

    const btn = document.getElementById('btn-trocar-senha');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      await Auth.atualizarSenhaPropria(novaSenha);
      await Auth.limparSenhaTemporaria(usuarioAtual.id);
      perfilAtual.senha_temporaria = false;
      // Continua o roteamento normal (home ou painel, conforme o role)
      await verificarAcessoEDirecionar(usuarioAtual);
    } catch (err) {
      mostrarErro('erro-trocar-senha', 'Não foi possível salvar a nova senha. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar nova senha';
    }
  });

  document.getElementById('input-busca-motorista').addEventListener('input', (e) => {
    filtroTextoMotorista = e.target.value;
    renderizarListaMotoristas();
  });

  document.getElementById('btn-filtro-vencendo').addEventListener('click', () => {
    filtroApenasVencendo = !filtroApenasVencendo;
    const btn = document.getElementById('btn-filtro-vencendo');
    if (filtroApenasVencendo) {
      btn.style.backgroundColor = '#ffb74d';
      btn.style.color = '#0a0a0a';
      btn.style.borderColor = '#ffb74d';
    } else {
      btn.style.backgroundColor = 'transparent';
      btn.style.color = 'var(--lsr-text-muted)';
      btn.style.borderColor = 'var(--lsr-text-muted)';
    }
    renderizarListaMotoristas();
  });

  document.getElementById('btn-salvar-prazo-offline').addEventListener('click', async () => {
    esconderErro('erro-prazo-offline');
    const dias = parseInt(document.getElementById('input-prazo-offline').value, 10);

    if (!dias || dias <= 0) {
      mostrarErro('erro-prazo-offline', 'Digite um número de dias maior que zero.');
      return;
    }

    const btn = document.getElementById('btn-salvar-prazo-offline');
    btn.disabled = true;
    try {
      await Admin.atualizarPrazoOfflineDias(dias);
      salvarPrazoCache(dias);
    } catch (err) {
      mostrarErro('erro-prazo-offline', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-salvar-config-indicacao').addEventListener('click', async () => {
    esconderErro('erro-config-indicacao');
    const diasBonus = parseInt(document.getElementById('input-indicacao-dias-bonus').value, 10);
    const diasMinimo = parseInt(document.getElementById('input-indicacao-dias-minimo').value, 10);

    if (!diasBonus || diasBonus <= 0 || !diasMinimo || diasMinimo <= 0) {
      mostrarErro('erro-config-indicacao', 'Digite valores maiores que zero nos dois campos.');
      return;
    }

    const btn = document.getElementById('btn-salvar-config-indicacao');
    btn.disabled = true;
    try {
      await Admin.atualizarConfigIndicacao(diasBonus, diasMinimo);
    } catch (err) {
      mostrarErro('erro-config-indicacao', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-salvar-whatsapp-suporte').addEventListener('click', async () => {
    esconderErro('erro-whatsapp-suporte');
    const numero = document.getElementById('input-whatsapp-suporte').value.trim().replace(/\D/g, '');

    if (numero.length < 10) {
      mostrarErro('erro-whatsapp-suporte', 'Digite um número válido, com DDD.');
      return;
    }

    const btn = document.getElementById('btn-salvar-whatsapp-suporte');
    btn.disabled = true;
    try {
      await Auth.atualizarConfig('whatsapp_suporte', numero);
    } catch (err) {
      mostrarErro('erro-whatsapp-suporte', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-salvar-dias-aviso').addEventListener('click', async () => {
    esconderErro('erro-dias-aviso');
    const dias = parseInt(document.getElementById('input-dias-aviso').value, 10);

    if (!dias || dias <= 0) {
      mostrarErro('erro-dias-aviso', 'Digite um número de dias maior que zero.');
      return;
    }

    const btn = document.getElementById('btn-salvar-dias-aviso');
    btn.disabled = true;
    try {
      await Admin.atualizarDiasAvisoVencimento(dias);
    } catch (err) {
      mostrarErro('erro-dias-aviso', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  // Modal: escolher plano (aprovar/renovar) — os botões são criados
  // dinamicamente em abrirModalPlano(), cada um já com seu próprio listener.
  document.getElementById('btn-cancelar-plano').addEventListener('click', fecharModalPlano);

  // Modal: resetar senha
  document.getElementById('btn-cancelar-resetar-senha').addEventListener('click', fecharModalResetarSenha);
  document.getElementById('form-resetar-senha').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-resetar-senha');
    const novaSenha = document.getElementById('input-nova-senha').value;
    const id = motoristaEmContextoId;

    if (novaSenha.length < 6) {
      mostrarErro('erro-resetar-senha', 'A senha precisa ter no mínimo 6 caracteres.');
      return;
    }
    if (!id) return;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Resetando...';
    try {
      await Admin.resetarSenha(id, novaSenha);
      fecharModalResetarSenha();
      alert('Senha resetada com sucesso. Informe a nova senha ao motorista.');
    } catch (err) {
      console.error(err);
      mostrarErro('erro-resetar-senha', err.message || 'Não foi possível resetar a senha.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Resetar';
    }
  });

  document.getElementById('form-editar-turno').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-editar-turno');

    const turnoId = document.getElementById('editar-turno-id').value;
    const kmInicial = parseFloat(document.getElementById('input-editar-km-inicial').value);
    const kmFinal = parseFloat(document.getElementById('input-editar-km-final').value);
    const faturamentoBruto = parseFloat(document.getElementById('input-editar-faturamento').value);
    const precoCombustivelTurno = parseFloat(document.getElementById('input-editar-preco-combustivel').value);

    if (isNaN(kmInicial) || kmInicial < 0) {
      mostrarErro('erro-editar-turno', 'Digite um KM inicial válido.');
      return;
    }
    if (isNaN(kmFinal) || kmFinal < kmInicial) {
      mostrarErro('erro-editar-turno', 'O KM final não pode ser menor que o KM inicial.');
      return;
    }
    if (isNaN(faturamentoBruto) || faturamentoBruto < 0) {
      mostrarErro('erro-editar-turno', 'Digite um faturamento válido.');
      return;
    }
    if (isNaN(precoCombustivelTurno) || precoCombustivelTurno < 0) {
      mostrarErro('erro-editar-turno', 'Digite um preço de combustível válido.');
      return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    try {
      const turnoAtualizado = await Turnos.atualizarRetroativo(turnoId, { kmInicial, kmFinal, faturamentoBruto, precoCombustivelTurno });
      fecharModalEditarTurno();

      // Se a edição partiu da tela de detalhe, volta pra ela já atualizada
      if (turnoDetalheAtual && turnoDetalheAtual.turno.id === turnoId) {
        abrirDetalheTurno(turnoAtualizado, turnoDetalheAtual.veiculo);
      } else {
        await carregarHistorico();
      }
    } catch (err) {
      mostrarErro('erro-editar-turno', 'Não foi possível salvar. Verifique sua conexão.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar e recalcular';
    }
  });
});
