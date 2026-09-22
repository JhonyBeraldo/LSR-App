// LSR App - Autenticação
// Login, cadastro e verificação de sessão via Supabase Auth.

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

  async login(email, senha) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password: senha
    });
    if (error) throw error;
    return data.user;
  },

  async cadastrar(email, senha, nome) {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password: senha,
      options: {
        data: { nome }
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
