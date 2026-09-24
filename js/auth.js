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

/**
 * Gera o e-mail sintético a partir do USUÁRIO digitado.
 * Ex: "Olyel" -> "olyel@lsrapp.internal"
 * Se por hábito a pessoa digitar algo com "@", ignoramos tudo depois dele.
 */
function usuarioParaEmailSintetico(nomeUsuario) {
  let base = nomeUsuario.trim().toLowerCase();
  if (base.includes('@')) {
    base = base.split('@')[0];
  }
  base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
  base = base.replace(/[^a-z0-9._-]/g, '');
  return `${base}@${DOMINIO_SINTETICO}`;
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

  async cadastrar(nomeUsuario, senha, whatsapp) {
    const email = usuarioParaEmailSintetico(nomeUsuario);
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password: senha,
      options: {
        data: { nome: nomeUsuario.trim(), whatsapp: (whatsapp || '').trim() }
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
  },

  /**
   * Lê uma configuração global do sistema (ex: prazo de tolerância
   * offline). Retorna null se não encontrar.
   */
  async getConfig(chave) {
    const { data, error } = await supabaseClient
      .from('config_sistema')
      .select('valor')
      .eq('chave', chave)
      .maybeSingle();
    if (error) throw error;
    return data ? data.valor : null;
  },

  /**
   * Atualiza uma configuração global do sistema. Só funciona pra
   * usuários com role='master' (RLS garante isso no servidor).
   */
  async atualizarConfig(chave, valor) {
    const { data, error } = await supabaseClient
      .from('config_sistema')
      .update({ valor: String(valor) })
      .eq('chave', chave)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Troca a senha do usuário logado (usado tanto na troca obrigatória
   * de senha temporária quanto numa futura tela de "alterar senha").
   */
  async atualizarSenhaPropria(novaSenha) {
    const { error } = await supabaseClient.auth.updateUser({ password: novaSenha });
    if (error) throw error;
  },

  /**
   * Remove a marca de "senha temporária" depois que o usuário já
   * definiu a senha nova dele.
   */
  async limparSenhaTemporaria(userId) {
    const { error } = await supabaseClient
      .from('perfis')
      .update({ senha_temporaria: false })
      .eq('id', userId);
    if (error) throw error;
  },

  /**
   * Atualiza o preço de combustível atual do motorista (usado como
   * valor padrão sugerido ao encerrar um turno — mas é editável na hora).
   */
  async atualizarPrecoCombustivel(userId, preco) {
    const { data, error } = await supabaseClient
      .from('perfis')
      .update({ preco_combustivel_atual: preco })
      .eq('id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
};

window.Auth = Auth;
