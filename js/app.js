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

    document.getElementById('home-email').textContent = perfil.nome || 'Motorista';
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

        document.getElementById('home-email').textContent = cache.nome || 'Motorista';
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
    const [motoristas, totalTurnos, prazoDias, turnosPorMotorista, diasAviso] = await Promise.all([
      Admin.listarMotoristas(),
      Admin.contarTurnosTotais(),
      Admin.getPrazoOfflineDias(),
      Admin.contarTurnosPorMotorista(),
      Admin.getDiasAvisoVencimento()
    ]);
    document.getElementById('input-dias-aviso').value = diasAviso;

    const ativos = motoristas.filter((m) => m.is_ativo);
    const pendentes = motoristas.filter((m) => !m.is_ativo);

    document.getElementById('admin-total-motoristas').textContent = ativos.length;
    document.getElementById('admin-total-turnos').textContent = totalTurnos;
    document.getElementById('input-prazo-offline').value = prazoDias;

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

    // Todos os motoristas
    const containerTodos = document.getElementById('admin-lista-motoristas');
    containerTodos.innerHTML = '';
    motoristas.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'card-lsr p-3 flex flex-col gap-2';
      const statusCor = m.is_ativo ? 'var(--lsr-green)' : 'var(--lsr-red)';
      const statusTexto = m.is_ativo ? 'Ativo' : 'Bloqueado';
      const venc = formatarVencimento(m.plano_vencimento);
      const totalTurnosMotorista = turnosPorMotorista[m.id] || 0;

      card.innerHTML = `
        <div class="flex items-center justify-between">
          <div>
            <p class="text-white text-sm font-semibold">${m.nome || 'Sem nome'}</p>
            ${m.whatsapp ? `<p class="text-xs" style="color:var(--lsr-text-muted)">${m.whatsapp}</p>` : ''}
          </div>
          <span class="text-xs px-2 py-1 rounded-full" style="color:${statusCor}">${statusTexto}</span>
        </div>
        <div class="flex items-center justify-between text-xs" style="color:var(--lsr-text-muted)">
          <span>${totalTurnosMotorista} turno(s)</span>
          <span style="color:${venc.cor}">${m.plano ? m.plano.charAt(0).toUpperCase() + m.plano.slice(1) + ' · ' : ''}${venc.texto}</span>
        </div>
        <div class="flex gap-2 mt-1">
          <button class="btn-toggle-motorista btn-lsr btn-lsr-outline flex-1 text-xs" style="min-height:38px;" data-id="${m.id}">${m.is_ativo ? 'Bloquear' : 'Liberar'}</button>
          <button class="btn-renovar-motorista btn-lsr btn-lsr-outline flex-1 text-xs" style="min-height:38px;">Renovar</button>
          <button class="btn-resetar-senha-motorista btn-lsr btn-lsr-outline flex-1 text-xs" style="min-height:38px;">🔑 Senha</button>
        </div>
      `;

      card.querySelector('.btn-toggle-motorista').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
          if (m.is_ativo) {
            await Admin.bloquearMotorista(m.id);
          } else {
            await Admin.aprovarMotorista(m.id);
          }
          await carregarPainelAdmin();
        } catch (err) {
          console.error(err);
          alert('Não foi possível atualizar. Verifique sua conexão.');
          btn.disabled = false;
        }
      });

      card.querySelector('.btn-renovar-motorista').addEventListener('click', () => {
        abrirModalPlano(m.id, m.nome, m.plano_vencimento, 'Renovar');
      });

      card.querySelector('.btn-resetar-senha-motorista').addEventListener('click', () => {
        abrirModalResetarSenha(m.id, m.nome);
      });

      containerTodos.appendChild(card);
    });
  } catch (err) {
    console.error('[App] Erro ao carregar painel admin:', err);
    alert('Não foi possível carregar o painel. Verifique sua conexão.');
  }
}

// ------------------------------------------------------------
// Modal: escolher plano (aprovar pendente ou renovar existente)
// ------------------------------------------------------------
function abrirModalPlano(motoristaId, nomeMotorista, vencimentoAtual, tituloAcao) {
  motoristaEmContextoId = motoristaId;
  document.getElementById('modal-plano-titulo').textContent = `${tituloAcao} motorista`;
  document.getElementById('modal-plano-motorista-nome').textContent = nomeMotorista || '';
  document.getElementById('modal-plano-motorista').dataset.vencimentoAtual = vencimentoAtual || '';
  document.getElementById('modal-plano-motorista').classList.remove('hidden');
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
      await Auth.cadastrar(nomeUsuario, senha, whatsapp);
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

  // Modal: escolher plano (aprovar/renovar)
  document.getElementById('btn-cancelar-plano').addEventListener('click', fecharModalPlano);
  document.querySelectorAll('.btn-escolher-plano').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tipoPlano = btn.dataset.plano;
      const vencimentoAtual = document.getElementById('modal-plano-motorista').dataset.vencimentoAtual || null;
      const id = motoristaEmContextoId;
      if (!id) return;

      document.querySelectorAll('.btn-escolher-plano').forEach((b) => { b.disabled = true; });
      try {
        await Admin.aprovarComPlano(id, tipoPlano, vencimentoAtual);
        fecharModalPlano();
        await carregarPainelAdmin();
      } catch (err) {
        console.error(err);
        alert('Não foi possível salvar o plano. Verifique sua conexão.');
      } finally {
        document.querySelectorAll('.btn-escolher-plano').forEach((b) => { b.disabled = false; });
      }
    });
  });

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
