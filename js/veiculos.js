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
    try {
      // Se já sabemos que está offline, nem tenta a rede — vai direto
      // pro cache local, sem esperar o fetch falhar sozinho.
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');

      const { data, error } = await comTimeout(
        supabaseClient
          .from('veiculos')
          .select('*')
          .eq('user_id', userId)
          .eq('is_ativo', true)
          .order('created_at', { ascending: false })
      );

      if (error) throw error;

      // Cacheia localmente
      if (data && data.length) {
        const comFlags = data.map((v) => ({ ...v, _synced: true }));
        await LSR_DB.veiculos.bulkPut(comFlags);
      }

      return data || [];
    } catch (err) {
      console.warn('[Veiculos] Sem conexão pra listar veículos remotos, usando cache local:', err);
      // Fallback: usa o que já estiver salvo localmente de uma sincronização anterior.
      // Se o app nunca chegou a carregar os veículos online nesse aparelho, a lista
      // vem vazia — mas qualquer uso anterior (iniciar turno, tela de veículos etc.)
      // já deixa esse cache preenchido.
      const locais = await LSR_DB.veiculos
        .where('user_id').equals(userId)
        .and((v) => v.is_ativo === true)
        .toArray();
      return locais;
    }
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
   * Busca um veículo por id — cache local primeiro (Dexie), com fallback
   * remoto. Funciona mesmo para veículos DESATIVADOS (histórico precisa
   * exibir/calcular turnos de veículos que já saíram de uso).
   */
  async obterPorId(id) {
    let v = await LSR_DB.veiculos.get(id);
    if (v) return v;

    // Não está no cache local — só vale a pena tentar a rede se
    // realmente há conexão; senão, falha rápido em vez de esperar
    // o fetch estourar por conta própria.
    if (!navigator.onLine) {
      throw new Error('Veículo não está no cache local e o app está offline.');
    }

    const { data, error } = await comTimeout(
      supabaseClient
        .from('veiculos')
        .select('*')
        .eq('id', id)
        .single()
    );
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
