// LSR App - Bootstrap principal

// ------------------------------------------------------------
// Registro do Service Worker (PWA offline-first)
// ------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
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
    document.getElementById('home-email').textContent = emailSinteticoParaUsuario(usuario.email);
    mostrarTela('tela-home');
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
// Handlers de formulário
// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  inicializarApp();

  // Login
  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    esconderErro('erro-login');
    const email = document.getElementById('login-email').value.trim();
    const senha = document.getElementById('login-senha').value;
    const btn = document.getElementById('btn-login');

    btn.disabled = true;
    btn.textContent = 'Entrando...';
    try {
      const usuario = await Auth.login(email, senha);
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
    const nome = document.getElementById('cadastro-nome').value.trim();
    const email = document.getElementById('cadastro-email').value.trim();
    const senha = document.getElementById('cadastro-senha').value;
    const btn = document.getElementById('btn-cadastro');

    if (senha.length < 6) {
      mostrarErro('erro-cadastro', 'A senha precisa ter no mínimo 6 caracteres.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Criando conta...';
    try {
      await Auth.cadastrar(email, senha, nome);
      mostrarErro('erro-cadastro', 'Conta criada! Aguarde a aprovação do administrador para poder entrar.');
      document.getElementById('erro-cadastro').style.color = 'var(--lsr-green)';
    } catch (err) {
      mostrarErro('erro-cadastro', 'Não foi possível criar a conta. ' + (err.message || ''));
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
});
