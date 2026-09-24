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
   * Retorna um mapa { user_id: quantidade de turnos } — pra mostrar
   * o total de cada motorista individualmente, não só o geral.
   */
  async contarTurnosPorMotorista() {
    const { data, error } = await supabaseClient
      .from('turnos')
      .select('user_id')
      .neq('status', 'ativo');
    if (error) throw error;

    const contagem = {};
    (data || []).forEach((t) => {
      contagem[t.user_id] = (contagem[t.user_id] || 0) + 1;
    });
    return contagem;
  },

  // ------------------------------------------------------------
  // PLANOS DE ASSINATURA
  // is_ativo continua controlando o acesso (pausar/liberar).
  // plano_vencimento é só informativo — usado pro aviso ao motorista,
  // NUNCA bloqueia sozinho.
  // ------------------------------------------------------------

  /**
   * Calcula a nova data de vencimento. Se o plano atual ainda não
   * venceu, soma a partir do vencimento atual (renovação antecipada
   * não "perde" tempo já pago); senão, soma a partir de hoje.
   */
  calcularNovoVencimento(vencimentoAtual, tipoPlano) {
    const hoje = new Date();
    let base = hoje;
    if (vencimentoAtual) {
      const atual = new Date(vencimentoAtual + 'T00:00:00');
      if (atual > hoje) base = atual;
    }
    const meses = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[tipoPlano] || 1;
    const novo = new Date(base);
    novo.setMonth(novo.getMonth() + meses);
    return novo.toISOString().slice(0, 10);
  },

  /**
   * Aprova (ou renova) um motorista com um plano específico —
   * já calcula e grava a nova data de vencimento.
   */
  async aprovarComPlano(id, tipoPlano, vencimentoAtual) {
    const novoVencimento = this.calcularNovoVencimento(vencimentoAtual, tipoPlano);
    const { data, error } = await supabaseClient
      .from('perfis')
      .update({ is_ativo: true, plano: tipoPlano, plano_vencimento: novoVencimento })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Lê a quantidade de dias de antecedência configurada pro aviso
   * de vencimento (padrão 3).
   */
  async getDiasAvisoVencimento() {
    const valor = await Auth.getConfig('dias_aviso_vencimento');
    return valor ? parseInt(valor, 10) : 3;
  },

  async atualizarDiasAvisoVencimento(dias) {
    return Auth.atualizarConfig('dias_aviso_vencimento', dias);
  },

  // ------------------------------------------------------------
  // RESET DE SENHA (via Edge Function — precisa de deploy separado,
  // veja as instruções que acompanham este arquivo)
  // ------------------------------------------------------------
  async resetarSenha(motoristaId, novaSenha) {
    const { data, error } = await supabaseClient.functions.invoke('admin-reset-senha', {
      body: { motorista_id: motoristaId, nova_senha: novaSenha }
    });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    return data;
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
