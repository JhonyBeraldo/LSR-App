// LSR App - Painel Master (Etapa 6)
// Todas as operações aqui dependem das políticas RLS que já concedem
// acesso total ao usuário com role='master' (fn_is_master()).

const Admin = {
  /**
   * Lista todos os motoristas (role='motorista'), mais recentes primeiro.
   */
  async listarMotoristas() {
    const { data, error } = await supabaseClient
      .from('perfis')
      .select('*')
      .eq('role', 'motorista')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  /**
   * Aprova (ou reativa) o acesso de um motorista.
   */
  async aprovarMotorista(id) {
    const { data, error } = await supabaseClient
      .from('perfis')
      .update({ is_ativo: true })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Bloqueia o acesso de um motorista já aprovado.
   */
  async bloquearMotorista(id) {
    const { data, error } = await supabaseClient
      .from('perfis')
      .update({ is_ativo: false })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Conta o total de turnos já registrados no sistema (todos os motoristas).
   */
  async contarTurnosTotais() {
    const { count, error } = await supabaseClient
      .from('turnos')
      .select('*', { count: 'exact', head: true })
      .neq('status', 'ativo');
    if (error) throw error;
    return count || 0;
  },

  /**
   * Lê o prazo de tolerância offline configurado (em dias).
   */
  async getPrazoOfflineDias() {
    const valor = await Auth.getConfig('prazo_aprovacao_offline_dias');
    return valor ? parseInt(valor, 10) : 3;
  },

  /**
   * Atualiza o prazo de tolerância offline (em dias).
   */
  async atualizarPrazoOfflineDias(dias) {
    return Auth.atualizarConfig('prazo_aprovacao_offline_dias', dias);
  }
};

window.Admin = Admin;
