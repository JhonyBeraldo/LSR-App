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

      // Turnos com menos de 1 minuto de duração (ex: testes rápidos de
      // abrir/fechar) fariam a extrapolação por hora virar um número sem
      // sentido (ex: R$ 25.000/h). Abaixo desse limiar, não mostra o valor.
      const DURACAO_MINIMA_HORAS = 1 / 60;
      if (tempoTotalHoras >= DURACAO_MINIMA_HORAS) {
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
      // Se o navegador já sabe que está offline, nem tenta a rede —
      // vai direto pro fallback local, sem esperar o fetch falhar.
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');

      const { data, error } = await comTimeout(
        supabaseClient
          .from('turnos')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'ativo')
          .limit(1)
      );
      if (error) throw error;

      if (data && data.length) {
        const remoto = data[0];
        const local = await LSR_DB.turnos.get(remoto.id);

        // REGRA DE DOMÍNIO (mais forte que checar _synced): um turno que já
        // está FECHADO ou DESCARTADO localmente NUNCA pode "voltar a ser
        // ativo" por causa de uma leitura remota desatualizada — não existe
        // reabertura de turno no mundo real. Isso protege mesmo se algum
        // outro bug de sincronização corromper a flag _synced.
        if (local && local.status !== 'ativo') {
          return null;
        }

        const turno = { ...remoto, _synced: true };
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
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');

      const { data, error } = await comTimeout(
        supabaseClient
          .from('turnos')
          .select('*')
          .eq('user_id', userId)
          .eq('veiculo_id', veiculoId)
          .eq('status', 'fechado')
          .order('tempo_fim', { ascending: false })
          .limit(1)
      );
      if (error) throw error;

      if (data && data.length) {
        const remoto = data[0];
        const local = await LSR_DB.turnos.get(remoto.id);

        if (local && local._synced === false) {
          return local;
        }

        await LSR_DB.turnos.put({ ...remoto, _synced: true });
        return remoto;
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
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');

      const { data, error } = await comTimeout(
        supabaseClient
          .from('turnos')
          .select('*')
          .eq('user_id', userId)
          .neq('status', 'ativo')
          .order('data_turno', { ascending: false })
          .limit(limite)
      );
      if (error) throw error;

      const remotos = (data || []).map((t) => ({ ...t, _synced: true }));

      // Mapa de tudo que está pendente LOCALMENTE (criado/editado offline
      // e ainda não confirmado pelo servidor) — nunca deixa isso ser
      // sobrescrito por uma leitura remota desatualizada.
      const todosPendentesLocais = await LSR_DB.turnos
        .where('user_id').equals(userId)
        .and((t) => t.status !== 'ativo' && t._synced === false)
        .toArray();
      const pendentesPorId = {};
      todosPendentesLocais.forEach((t) => { pendentesPorId[t.id] = t; });

      // Só grava no cache local os remotos que NÃO têm pendência local
      const paraGravarNoCache = remotos.filter((r) => !pendentesPorId[r.id]);
      if (paraGravarNoCache.length) {
        await LSR_DB.turnos.bulkPut(paraGravarNoCache);
      }

      // Monta a lista final: pra cada id, prefere a versão local pendente
      // (mais recente) sobre a remota; inclui pendentes que o servidor
      // ainda nem conhece
      const porId = {};
      remotos.forEach((r) => { porId[r.id] = pendentesPorId[r.id] || r; });
      todosPendentesLocais.forEach((l) => { if (!porId[l.id]) porId[l.id] = l; });

      const combinado = Object.values(porId);
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
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');
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
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');
      const { data, error } = await supabaseClient
        .from('turnos')
        .update({
          km_final: kmFinal,
          faturamento_bruto: faturamentoBruto,
          preco_combustivel_turno: precoCombustivelTurno,
          tempo_fim: agora,
          status: 'fechado'
        })
        .eq('id', turnoId)
        .select();
      if (error) throw error;
      // Um UPDATE que não bate com nenhuma linha (ex: bloqueado pelo RLS)
      // NÃO gera erro no Supabase — precisa checar manualmente.
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Nenhuma linha atualizada no servidor (possível bloqueio de permissão).');
      }
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
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');
      const { data, error } = await supabaseClient
        .from('turnos')
        .update({
          km_inicial: kmInicial,
          km_final: kmFinal,
          faturamento_bruto: faturamentoBruto,
          preco_combustivel_turno: precoCombustivelTurno
        })
        .eq('id', turnoId)
        .select();
      if (error) throw error;
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Nenhuma linha atualizada no servidor (possível bloqueio de permissão).');
      }
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
      if (!navigator.onLine) throw new Error('offline (detectado antes de tentar)');
      const { data, error } = await supabaseClient
        .from('turnos')
        .update({ status: 'descartado' })
        .eq('id', turnoId)
        .select();
      if (error) throw error;
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Nenhuma linha atualizada no servidor (possível bloqueio de permissão).');
      }
      await LSR_DB.turnos.update(turnoId, { _synced: true });
    } catch (err) {
      console.warn('[Turnos] Descarte salvo offline, será sincronizado depois:', err);
      await this._enfileirarSync('turnos', 'update', turnoId);
    }
  }
};

window.Turnos = Turnos;
