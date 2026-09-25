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
   * Calcula a nova data de vencimento a partir da duração (em dias) do
   * plano. Se o plano atual ainda não venceu, soma a partir do
   * vencimento atual (renovação antecipada não "perde" tempo já
   * pago); senão, soma a partir de hoje.
   */
  calcularNovoVencimento(vencimentoAtual, diasDuracao) {
    const hoje = new Date();
    let base = hoje;
    if (vencimentoAtual) {
      const atual = new Date(vencimentoAtual + 'T00:00:00');
      if (atual > hoje) base = atual;
    }
    const novo = new Date(base);
    novo.setDate(novo.getDate() + diasDuracao);
    return novo.toISOString().slice(0, 10);
  },

  /**
   * Aprova (ou renova) um motorista com um plano específico (por id).
   * Congela nome e valor do plano NESSE momento — não muda sozinho se
   * o plano for editado ou apagado depois; só na próxima renovação,
   * que busca os dados atualizados de novo.
   */
  async aprovarComPlano(motoristaId, planoId, vencimentoAtual) {
    const { data: plano, error: erroPlano } = await supabaseClient
      .from('planos_precos')
      .select('*')
      .eq('id', planoId)
      .single();
    if (erroPlano) throw erroPlano;

    const novoVencimento = this.calcularNovoVencimento(vencimentoAtual, plano.dias_duracao);

    const { data, error } = await supabaseClient
      .from('perfis')
      .update({
        is_ativo: true,
        plano_id: planoId,
        plano_nome: plano.nome,
        plano_valor: plano.valor,
        plano_vencimento: novoVencimento
      })
      .eq('id', motoristaId)
      .select()
      .single();
    if (error) throw error;

    // Programa de indicação: se esse motorista foi indicado por
    // alguém e esse plano qualifica (dias >= mínimo configurado),
    // recompensa o indicador automaticamente — só uma vez por indicado.
    try {
      await this._processarRecompensaIndicacao(data, plano);
    } catch (e) {
      console.warn('[Admin] Falha ao processar recompensa de indicação (não bloqueia a aprovação):', e);
    }

    return data;
  },

  async _processarRecompensaIndicacao(motoristaAtualizado, plano) {
    if (!motoristaAtualizado.indicado_por) return; // não foi indicado por ninguém

    const diasMinimo = parseInt(await Auth.getConfig('indicacao_dias_minimo_plano'), 10) || 30;
    if (plano.dias_duracao < diasMinimo) return; // plano curto demais, não qualifica

    // Já foi recompensado antes por esse mesmo indicado? (bônus é único, não repete a cada renovação)
    const { data: jaExiste, error: erroCheck } = await supabaseClient
      .from('indicacoes_log')
      .select('id')
      .eq('indicado_id', motoristaAtualizado.id)
      .limit(1);
    if (erroCheck) throw erroCheck;
    if (jaExiste && jaExiste.length) return;

    const diasBonus = parseInt(await Auth.getConfig('indicacao_dias_bonus'), 10) || 30;

    // Busca o vencimento atual do indicador pra somar o bônus corretamente
    const { data: indicador, error: erroIndicador } = await supabaseClient
      .from('perfis')
      .select('id, plano_vencimento')
      .eq('id', motoristaAtualizado.indicado_por)
      .single();
    if (erroIndicador) throw erroIndicador;

    const novoVencimentoIndicador = this.calcularNovoVencimento(indicador.plano_vencimento, diasBonus);

    const { error: erroUpdate } = await supabaseClient
      .from('perfis')
      .update({ plano_vencimento: novoVencimentoIndicador })
      .eq('id', indicador.id);
    if (erroUpdate) throw erroUpdate;

    await supabaseClient.from('indicacoes_log').insert({
      indicador_id: indicador.id,
      indicado_id: motoristaAtualizado.id,
      plano_nome: plano.nome,
      dias_bonus_concedidos: diasBonus
    });
  },

  // ------------------------------------------------------------
  // PROGRAMA DE INDICAÇÃO — configurações e histórico
  // ------------------------------------------------------------
  async getConfigIndicacao() {
    const [dias_bonus, dias_minimo] = await Promise.all([
      Auth.getConfig('indicacao_dias_bonus'),
      Auth.getConfig('indicacao_dias_minimo_plano')
    ]);
    return {
      diasBonus: dias_bonus ? parseInt(dias_bonus, 10) : 30,
      diasMinimo: dias_minimo ? parseInt(dias_minimo, 10) : 30
    };
  },

  async atualizarConfigIndicacao(diasBonus, diasMinimo) {
    await Promise.all([
      Auth.atualizarConfig('indicacao_dias_bonus', diasBonus),
      Auth.atualizarConfig('indicacao_dias_minimo_plano', diasMinimo)
    ]);
  },

  async listarIndicacoesRecentes(limite) {
    const { data, error } = await supabaseClient
      .from('indicacoes_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limite || 20);
    if (error) throw error;

    const registros = data || [];
    if (!registros.length) return [];

    const ids = [...new Set(registros.flatMap((r) => [r.indicador_id, r.indicado_id]))];
    const { data: perfis, error: erroPerfis } = await supabaseClient
      .from('perfis')
      .select('id, nome')
      .in('id', ids);
    if (erroPerfis) throw erroPerfis;

    const nomesPorId = {};
    (perfis || []).forEach((p) => { nomesPorId[p.id] = p.nome; });

    return registros.map((r) => ({
      ...r,
      indicadorNome: nomesPorId[r.indicador_id] || 'Motorista',
      indicadoNome: nomesPorId[r.indicado_id] || 'Motorista'
    }));
  },

  // ------------------------------------------------------------
  // CADASTRO DE PLANOS (o master cria/edita livremente)
  // ------------------------------------------------------------
  async listarPlanos(incluirInativos) {
    let query = supabaseClient.from('planos_precos').select('*').order('dias_duracao', { ascending: true });
    if (!incluirInativos) query = query.eq('is_ativo', true);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async criarPlano({ nome, diasDuracao, valor }) {
    const { data, error } = await supabaseClient
      .from('planos_precos')
      .insert({ nome, dias_duracao: diasDuracao, valor })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async atualizarPlano(id, { nome, diasDuracao, valor }) {
    const { data, error } = await supabaseClient
      .from('planos_precos')
      .update({ nome, dias_duracao: diasDuracao, valor })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async alternarAtivoPlano(id, ativo) {
    const { data, error } = await supabaseClient
      .from('planos_precos')
      .update({ is_ativo: ativo })
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
  // GUIA DE AJUDA (editável pelo master, lido pelo motorista)
  // ------------------------------------------------------------
  async listarConteudoAjuda() {
    const { data, error } = await supabaseClient
      .from('conteudo_ajuda')
      .select('*')
      .order('ordem', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async criarConteudoAjuda({ titulo, corpo, ordem }) {
    const { data, error } = await supabaseClient
      .from('conteudo_ajuda')
      .insert({ titulo, corpo, ordem })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async atualizarConteudoAjuda(id, { titulo, corpo, ordem }) {
    const { data, error } = await supabaseClient
      .from('conteudo_ajuda')
      .update({ titulo, corpo, ordem })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async excluirConteudoAjuda(id) {
    const { error } = await supabaseClient.from('conteudo_ajuda').delete().eq('id', id);
    if (error) throw error;
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
