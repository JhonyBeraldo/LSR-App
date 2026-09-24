// LSR App - Despesas de Manutenção reais
// Essas despesas abatem do saldo teórico do Cofre de Manutenção
// (que é calculado a partir de manutenção+depreciação acumulada nos turnos).

const Despesas = {
  async listar(userId) {
    const { data, error } = await supabaseClient
      .from('despesas_manutencao')
      .select('*')
      .eq('user_id', userId)
      .order('data_despesa', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async registrar({ userId, veiculoId, valor, descricao, dataDespesa }) {
    const { data, error } = await supabaseClient
      .from('despesas_manutencao')
      .insert({
        user_id: userId,
        veiculo_id: veiculoId,
        valor,
        descricao: descricao || null,
        data_despesa: dataDespesa
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async atualizar(id, { veiculoId, valor, descricao, dataDespesa }) {
    const { data, error } = await supabaseClient
      .from('despesas_manutencao')
      .update({
        veiculo_id: veiculoId,
        valor,
        descricao: descricao || null,
        data_despesa: dataDespesa
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async excluir(id) {
    const { error } = await supabaseClient
      .from('despesas_manutencao')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }
};

window.Despesas = Despesas;
