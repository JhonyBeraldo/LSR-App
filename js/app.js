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
// Inicialização: verifica sessão e decide qual tela mostrar
// ------------------------------------------------------------
async function inicializarApp() {
  atualizarStatusConexao();

  const usuario = await Auth.getUsuarioAtual();
  if (usuario) {
    document.getElementById('home-email').textContent = usuario.email;
    mostrarTela('tela-home');
  } else {
    mostrarTela('tela-login');
  }
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
      document.getElementById('home-email').textContent = usuario.email;
      mostrarTela('tela-home');
    } catch (err) {
      mostrarErro('erro-login', 'E-mail ou senha inválidos.');
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
      mostrarErro('erro-cadastro', 'Conta criada! Verifique seu e-mail para confirmar (se exigido) e faça login.');
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
    mostrarTela('tela-login');
  });
});
