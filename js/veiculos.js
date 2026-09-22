// LSR App - CRUD de Veículos
// Etapa 2: leitura/escrita direta no Supabase (online).
// Cada operação também atualiza o cache local (Dexie) para uso
// posterior offline (Etapa 3 em diante).

const Veiculos = {
  /**
   * Lista os veículos ATIVOS do usuário, ordenados por mais recente.
   * Atualiza o cache local (Dexie) com o resultado.
   */
  async listarAtivos(userId) {
    const { data, error } = await supabaseClient
      .from('veiculos')
      .select('*')
      .eq('user_id', userId)
      .eq('is_ativo', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Cacheia localmente
    if (data && data.length) {
      const comFlags = data.map((v) => ({ ...v, _synced: true }));
      await LSR_DB.veiculos.bulkPut(comFlags);
    }

    return data || [];
  },

  /**
   * Cria um novo veículo.
   */
  async criar({ userId, nomeModelo, tipo, autonomiaKml, taxaManutencaoKm, taxaDepreciacaoKm }) {
    const payload = {
      user_id: userId,
      nome_modelo: nomeModelo,
      tipo,
      autonomia_kml: autonomiaKml,
      taxa_manutencao_km: taxaManutencaoKm,
      taxa_depreciacao_km: taxaDepreciacaoKm,
      is_ativo: true
    };

    const { data, error } = await supabaseClient
      .from('veiculos')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    await LSR_DB.veiculos.put({ ...data, _synced: true });
    return data;
  },

  /**
   * Atualiza um veículo existente.
   */
  async atualizar(id, { nomeModelo, tipo, autonomiaKml, taxaManutencaoKm, taxaDepreciacaoKm }) {
    const payload = {
      nome_modelo: nomeModelo,
      tipo,
      autonomia_kml: autonomiaKml,
      taxa_manutencao_km: taxaManutencaoKm,
      taxa_depreciacao_km: taxaDepreciacaoKm
    };

    const { data, error } = await supabaseClient
      .from('veiculos')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await LSR_DB.veiculos.put({ ...data, _synced: true });
    return data;
  },

  /**
   * Desativa um veículo (soft delete). Turnos históricos permanecem
   * vinculados e intactos — apenas some das opções de novos turnos.
   */
  async desativar(id) {
    const { data, error } = await supabaseClient
      .from('veiculos')
      .update({ is_ativo: false })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await LSR_DB.veiculos.put({ ...data, _synced: true });
    return data;
  }
};

window.Veiculos = Veiculos;
