// LSR App - Ciclo de Turno + Motor de Cálculo
//
// Fonte de verdade IMEDIATA é o Dexie (local), pra funcionar 100% offline.
// Toda escrita tenta espelhar no Supabase em seguida (melhor esforço).
// A fila robusta de sincronização (Last-Write-Wins) vem completa na Etapa 5;
// por enquanto, se a escrita remota falhar, o registro fica marcado
// _synced=false e a operação é anotada em sync_queue para reprocessar depois.

const Turnos = {
  // ------------------------------------------------------------
  // MOTOR DE CÁLCULO (fórmulas da especificação técnica)
  // ------------------------------------------------------------
  calcular({ kmInicial, kmFinal, autonomiaKml, precoCombustivelTurno, taxaManutencaoKm, taxaDepreciacaoKm, faturamentoBruto, tempoInicioISO, tempoFimISO }) {
    const dist = kmFinal - kmInicial;

    const custoCombustivel = autonomiaKml > 0 ? (dist / autonomiaKml) * precoCombustivelTurno : 0;
    const custoManutencao = dist * taxaManutencaoKm;
    const custoDepreciacao = dist * taxaDepreciacaoKm;
    const custoTotal = custoCombustivel + custoManutencao + custoDepreciacao;

    const lucro = faturamentoBruto - custoTotal;
    const lucroPorKm = dist > 0 ? lucro / dist : null;

    let lucroPorHora = null;
    let tempoTotalHoras = null;
    if (tempoInicioISO && tempoFimISO) {
      const ms = new Date(tempoFimISO).getTime() - new Date(tempoInicioISO).getTime();
      tempoTotalHoras = ms / (1000 * 60 * 60);
      if (tempoTotalHoras > 0) {
        lucroPorHora = lucro / tempoTotalHoras;
      }
    }

    return {
      dist,
      custoCombustivel,
      custoManutencao,
      custoDepreciacao,
      custoTotal,
      lucro,
      lucroPorKm,
      lucroPorHora,
      tempoTotalHoras
    };
  },

  // ------------------------------------------------------------
  // CONSULTAS: REMOTO PRIMEIRO (Supabase), Dexie como cache/fallback offline.
  // Isso garante que o histórico apareça igual em qualquer aparelho —
  // inclusive um app recém-instalado, cujo banco local nasce vazio.
  // ------------------------------------------------------------
  async buscarTurnoAtivo(userId) {
    try {
      const { data, error } = await supabaseClient
        .from('turnos')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'ativo')
        .limit(1);
      if (error) throw error;

      if (data && data.length) {
        const turno = { ...data[0], _synced: true };
        await LSR_DB.turnos.put(turno);
        return turno;
      }
    } catch (err) {
      console.warn('[Turnos] Sem conexão pra checar turno ativo remoto, usando cache local:', err);
    }

    // Fallback: cobre modo offline e turnos criados offline ainda não sincronizados
    const locais = await LSR_DB.turnos
      .where('user_id').equals(userId)
      .and((t) => t.status === 'ativo')
      .toArray();
    return locais[0] || null;
  },

  async buscarUltimoTurnoFechado(userId, veiculoId) {
    try {
      const { data, error } = await supabaseClient
        .from('turnos')
        .select('*')
        .eq('user_id', userId)
        .eq('veiculo_id', veiculoId)
        .eq('status', 'fechado')
        .order('tempo_fim', { ascending: false })
        .limit(1);
      if (error) throw error;

      if (data && data.length) {
        await LSR_DB.turnos.put({ ...data[0], _synced: true });
        return data[0];
      }
      return null;
    } catch (err) {
      console.warn('[Turnos] Sem conexão pra checar último turno remoto, usando cache local:', err);
    }

    const locais = await LSR_DB.turnos
      .where('user_id').equals(userId)
      .and((t) => t.veiculo_id === veiculoId && t.status === 'fechado')
      .toArray();
    locais.sort((a, b) => new Date(b.tempo_fim) - new Date(a.tempo_fim));
    return locais[0] || null;
  },

  async listarHistorico(userId, limite = 30) {
    try {
      const { data, error } = await supabaseClient
        .from('turnos')
        .select('*')
        .eq('user_id', userId)
        .neq('status', 'ativo')
        .order('data_turno', { ascending: false })
        .limit(limite);
      if (error) throw error;

      const remotos = (data || []).map((t) => ({ ...t, _synced: true }));
      if (remotos.length) {
        await LSR_DB.turnos.bulkPut(remotos);
      }

      // Inclui turnos criados/editados offline que ainda não chegaram no servidor
      const idsRemotos = new Set(remotos.map((t) => t.id));
      const pendentesLocais = await LSR_DB.turnos
        .where('user_id').equals(userId)
        .and((t) => t.status !== 'ativo' && t._synced === false && !idsRemotos.has(t.id))
        .toArray();

      const combinado = [...remotos, ...pendentesLocais];
      combinado.sort((a, b) => new Date(b.data_turno) - new Date(a.data_turno));
      return combinado.slice(0, limite);
    } catch (err) {
      console.warn('[Turnos] Sem conexão, usando histórico em cache local:', err);
      const turnos = await LSR_DB.turnos
        .where('user_id').equals(userId)
        .and((t) => t.status !== 'ativo')
        .toArray();
      turnos.sort((a, b) => new Date(b.data_turno) - new Date(a.data_turno));
      return turnos.slice(0, limite);
    }
  },

  // ------------------------------------------------------------
  // ESCRITA: helper de sincronização best-effort
  // ------------------------------------------------------------
  async _enfileirarSync(tabela, operacao, registroId) {
    try {
      await LSR_DB.sync_queue.add({
        tabela,
        operacao,
        registro_id: registroId,
        created_at: agoraISO()
      });
    } catch (e) {
      console.warn('[Turnos] Falha ao enfileirar sync:', e);
    }
  },

  // ------------------------------------------------------------
  // INICIAR TURNO
  // ------------------------------------------------------------
  async iniciar({ userId, veiculoId, kmInicial }) {
    const agora = agoraISO();
    const registro = {
      id: gerarUUID(),
      user_id: userId,
      veiculo_id: veiculoId,
      data_turno: agora.slice(0, 10),
      km_inicial: kmInicial,
      km_final: null,
      faturamento_bruto: null,
      preco_combustivel_turno: null,
      tempo_inicio: agora,
      tempo_fim: null,
      status: 'ativo',
      created_at: agora,
      updated_at: agora,
      _synced: false
    };

    await LSR_DB.turnos.put(registro);

    try {
      const { id, _synced, ...payloadRemoto } = registro;
      const { error } = await supabaseClient.from('turnos').insert({ id, ...payloadRemoto });
      if (error) throw error;
      await LSR_DB.turnos.update(registro.id, { _synced: true });
    } catch (err) {
      console.warn('[Turnos] Turno criado offline, será sincronizado depois:', err);
      await this._enfileirarSync('turnos', 'insert', registro.id);
    }

    return registro;
  },

  // ------------------------------------------------------------
  // ENCERRAR TURNO (roda o motor de cálculo e persiste o resultado)
  // ------------------------------------------------------------
  async encerrar({ turnoId, kmFinal, faturamentoBruto, precoCombustivelTurno }) {
    const turno = await LSR_DB.turnos.get(turnoId);
    if (!turno) throw new Error('Turno não encontrado localmente.');

    const agora = agoraISO();
    const atualizacao = {
      km_final: kmFinal,
      faturamento_bruto: faturamentoBruto,
      preco_combustivel_turno: precoCombustivelTurno,
      tempo_fim: agora,
      status: 'fechado',
      updated_at: agora,
      _synced: false
    };

    await LSR_DB.turnos.update(turnoId, atualizacao);
    const turnoAtualizado = await LSR_DB.turnos.get(turnoId);

    try {
      const { error } = await supabaseClient
        .from('turnos')
        .update({
          km_final: kmFinal,
          faturamento_bruto: faturamentoBruto,
          preco_combustivel_turno: precoCombustivelTurno,
          tempo_fim: agora,
          status: 'fechado'
        })
        .eq('id', turnoId);
      if (error) throw error;
      await LSR_DB.turnos.update(turnoId, { _synced: true });
    } catch (err) {
      console.warn('[Turnos] Fechamento salvo offline, será sincronizado depois:', err);
      await this._enfileirarSync('turnos', 'update', turnoId);
    }

    return turnoAtualizado;
  },

  // ------------------------------------------------------------
  // EDIÇÃO RETROATIVA (tela de Histórico)
  // Recalcula tudo automaticamente, pois o motor de cálculo sempre
  // lê os campos brutos (nunca guarda o resultado pronto).
  // ------------------------------------------------------------
  async atualizarRetroativo(turnoId, { kmInicial, kmFinal, faturamentoBruto, precoCombustivelTurno }) {
    const agora = agoraISO();
    const atualizacao = {
      km_inicial: kmInicial,
      km_final: kmFinal,
      faturamento_bruto: faturamentoBruto,
      preco_combustivel_turno: precoCombustivelTurno,
      updated_at: agora,
      _synced: false
    };

    await LSR_DB.turnos.update(turnoId, atualizacao);
    const turnoAtualizado = await LSR_DB.turnos.get(turnoId);

    try {
      const { error } = await supabaseClient
        .from('turnos')
        .update({
          km_inicial: kmInicial,
          km_final: kmFinal,
          faturamento_bruto: faturamentoBruto,
          preco_combustivel_turno: precoCombustivelTurno
        })
        .eq('id', turnoId);
      if (error) throw error;
      await LSR_DB.turnos.update(turnoId, { _synced: true });
    } catch (err) {
      console.warn('[Turnos] Edição retroativa salva offline, será sincronizada depois:', err);
      await this._enfileirarSync('turnos', 'update', turnoId);
    }

    return turnoAtualizado;
  },

  // ------------------------------------------------------------
  // DESCARTAR TURNO (fluxo do "turno esquecido")
  // ------------------------------------------------------------
  async descartar(turnoId) {
    const agora = agoraISO();
    await LSR_DB.turnos.update(turnoId, { status: 'descartado', updated_at: agora, _synced: false });

    try {
      const { error } = await supabaseClient
        .from('turnos')
        .update({ status: 'descartado' })
        .eq('id', turnoId);
      if (error) throw error;
      await LSR_DB.turnos.update(turnoId, { _synced: true });
    } catch (err) {
      console.warn('[Turnos] Descarte salvo offline, será sincronizado depois:', err);
      await this._enfileirarSync('turnos', 'update', turnoId);
    }
  }
};

window.Turnos = Turnos;
