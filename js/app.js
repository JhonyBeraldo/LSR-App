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
// Indicador de conectividade
// ------------------------------------------------------------
function atualizarStatusConexao() {
  const badge = document.getElementById('status-conexao');
  if (!badge) return;
  if (navigator.onLine) {
    badge.textContent = 'Online';
    badge.className = 'text-xs px-2 py-1 rounded-full bg-green-900 text-lsr-green';
    badge.style.color = 'var(--lsr-green)';
  } else {
    badge.textContent = 'Offline';
    badge.className = 'text-xs px-2 py-1 rounded-full';
    badge.style.color = 'var(--lsr-text-muted)';
  }
}
window.addEventListener('online', atualizarStatusConexao);
window.addEventListener('offline', atualizarStatusConexao);

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
    document.getElementById('home-email').textContent = perfil.nome || 'Motorista';
    mostrarTela('tela-home');
    await carregarEstadoHome();
  } catch (err) {
    console.error('[App] Erro ao verificar perfil:', err);
    // Sem conexão para checar o perfil: por segurança, não libera acesso.
    await Auth.logout();
    mostrarErro('erro-login', 'Não foi possível verificar seu acesso. Tente novamente com conexão à internet.');
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

    const veiculo = await LSR_DB.veiculos.get(turnoAtivoAtual.veiculo_id);
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

    const veiculo = await LSR_DB.veiculos.get(turnoFechado.veiculo_id);
    const resultado = Turnos.calcular({
      kmInicial: turnoFechado.km_inicial,
      kmFinal: turnoFechado.km_final,
      autonomiaKml: veiculo.autonomia_kml,
      precoCombustivelTurno: turnoFechado.preco_combustivel_turno,
      taxaManutencaoKm: veiculo.taxa_manutencao_km,
      taxaDepreciacaoKm: veiculo.taxa_depreciacao_km,
      faturamentoBruto: turnoFechado.faturamento_bruto,
      tempoInicioISO: turnoFechado.tempo_inicio,
      tempoFimISO: turnoFechado.tempo_fim
    });

    exibirResultadoTurno(resultado);

    // Se o preço digitado ao encerrar for diferente do padrão salvo no perfil,
    // atualiza o padrão — assim, da próxima vez (depois de abastecer com preço
    // novo), o valor sugerido já vem correto. O snapshot histórico deste turno
    // (preco_combustivel_turno) já foi salvo congelado e não é afetado por isso.
    const precoDigitado = dadosEncerramentoPendente.precoCombustivelTurno;
    if (precoDigitado !== perfilAtual?.preco_combustivel_atual) {
      try {
        perfilAtual = await Auth.atualizarPrecoCombustivel(usuarioAtual.id, precoDigitado);
      } catch (err) {
        console.warn('[App] Não foi possível atualizar o preço padrão do combustível:', err);
      }
    }

    document.getElementById('modal-confirmar-encerrar').classList.add('hidden');
    fecharModalEncerrarTurno();
    dadosEncerramentoPendente = null;
    mostrarTela('tela-resultado-turno');
  } catch (err) {
    console.error(err);
    alert('Não foi possível encerrar o turno. Tente novamente.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar';
  }
}

function exibirResultadoTurno(r) {
  const lucroPositivo = r.lucro >= 0;
  const corLucro = lucroPositivo ? 'var(--lsr-green)' : 'var(--lsr-red)';

  document.getElementById('resultado-lucro').textContent = formatarMoeda(r.lucro);
  document.getElementById('resultado-lucro').style.color = corLucro;
  document.getElementById('resultado-lucro-km').textContent = r.lucroPorKm !== null ? formatarMoeda(r.lucroPorKm) : '—';
  document.getElementById('resultado-lucro-hora').textContent = r.lucroPorHora !== null ? formatarMoeda(r.lucroPorHora) : '—';
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
    const btn = document.getElementById('btn-cadastro');

    if (nomeUsuario.length < 3) {
      mostrarErro('erro-cadastro', 'Digite um usuário com no mínimo 3 caracteres.');
      return;
    }
    if (senha.length < 6) {
      mostrarErro('erro-cadastro', 'A senha precisa ter no mínimo 6 caracteres.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Criando conta...';
    try {
      await Auth.cadastrar(nomeUsuario, senha);
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
    mostrarTela('tela-home');
    await carregarEstadoHome();
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
});
