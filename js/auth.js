// LSR App - Autenticação
// Login, cadastro e verificação de sessão via Supabase Auth.
//
// O usuário nunca digita um e-mail: apenas um "nome de usuário".
// Por trás, montamos um e-mail sintético (usuario@DOMINIO_SINTETICO)
// porque o Supabase Auth exige o formato de e-mail — mesmo padrão
// usado no Evvo (login simples mapeado para um e-mail real por trás).
//
// IMPORTANTE: como esse domínio não recebe e-mails de verdade,
// é preciso DESATIVAR a confirmação por e-mail no projeto Supabase
// (Authentication > Providers > Email > "Confirm email" = OFF),
// senão o cadastro fica preso aguardando confirmação que nunca chega.

const DOMINIO_SINTETICO = 'lsrapp.internal';

function usuarioParaEmailSintetico(nomeUsuario) {
  const limpo = nomeUsuario.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${limpo}@${DOMINIO_SINTETICO}`;
}

function emailSinteticoParaUsuario(email) {
  return (email || '').split('@')[0];
}

const Auth = {
  /**
   * Verifica se há sessão ativa. Retorna o usuário ou null.
   * Se estiver offline, tenta recuperar sessão persistida localmente
   * (o Supabase client já cuida disso via persistSession).
   */
  async getUsuarioAtual() {
    try {
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      return data.session?.user || null;
    } catch (err) {
      console.warn('[Auth] Não foi possível verificar sessão (possivelmente offline):', err);
      return null;
    }
  },

  async login(nomeUsuario, senha) {
    const email = usuarioParaEmailSintetico(nomeUsuario);
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password: senha
    });
    if (error) throw error;
    return data.user;
  },

  async cadastrar(nomeUsuario, senha, nome) {
    const email = usuarioParaEmailSintetico(nomeUsuario);
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password: senha,
      options: {
        data: { nome, nome_usuario: nomeUsuario.trim().toLowerCase() }
      }
    });
    if (error) throw error;
    return data.user;
  },

  async logout() {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  },

  /**
   * Busca o perfil (incluindo role: motorista | master) do usuário logado.
   */
  async getPerfil(userId) {
    const { data, error } = await supabaseClient
      .from('perfis')
      .select('*')
      .eq('id', userId)
      .single();
    if (error) throw error;
    return data;
  }
};

window.Auth = Auth;
window.emailSinteticoParaUsuario = emailSinteticoParaUsuario;
