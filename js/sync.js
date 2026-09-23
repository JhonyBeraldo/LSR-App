// LSR App - Motor de Sincronização (Etapa 5)
//
// Estratégia: Last-Write-Wins (LWW) baseado em updated_at.
// A fila (sync_queue) guarda QUAIS registros têm mudanças locais
// pendentes; ao reconectar, cada um é comparado com o servidor:
//   - Se não existe no servidor -> insere.
//   - Se a versão LOCAL é mais nova (updated_at maior) -> local vence,
//     sobrescreve o servidor.
//   - Se a versão do SERVIDOR é mais nova ou igual -> servidor vence,
//     a versão local é substituída pela remota.

const Sync = {
  emProgresso: false,

  async contarPendentes() {
    return LSR_DB.sync_queue.count();
  },

  /**
   * Processa toda a fila pendente. Seguro de chamar várias vezes
   * (ignora se já estiver rodando, ou se estiver offline).
   */
  async processarFila() {
    if (this.emProgresso || !navigator.onLine) return;
    this.emProgresso = true;

    try {
      const itens = await LSR_DB.sync_queue.toArray();
      if (!itens.length) return;

      // Agrupa por registro — se o mesmo turno foi alterado várias vezes
      // offline, só precisamos sincronizar o estado final dele uma vez.
      const registrosUnicos = [...new Set(itens.map((i) => i.registro_id))];

      for (const registroId of registrosUnicos) {
        try {
          await this._sincronizarTurno(registroId);
          const idsDaFila = itens.filter((i) => i.registro_id === registroId).map((i) => i.local_id);
          await LSR_DB.sync_queue.bulkDelete(idsDaFila);
        } catch (err) {
          console.warn('[Sync] Falha ao sincronizar turno', registroId, '— tenta de novo mais tarde:', err);
          // Mantém na fila para a próxima tentativa (próxima reconexão ou próximo ciclo)
        }
      }
    } finally {
      this.emProgresso = false;
    }
  },

  async _sincronizarTurno(turnoId) {
    const local = await LSR_DB.turnos.get(turnoId);
    if (!local) return; // registro pode ter sido removido localmente nesse meio tempo

    const { data: remoto, error: erroSelect } = await supabaseClient
      .from('turnos')
      .select('*')
      .eq('id', turnoId)
      .maybeSingle();
    if (erroSelect) throw erroSelect;

    if (!remoto) {
      // Nunca chegou a existir no servidor -> insere agora
      const { _synced, ...payload } = local;
      const { error } = await supabaseClient.from('turnos').insert(payload);
      if (error) throw error;
      await LSR_DB.turnos.update(turnoId, { _synced: true });
      return;
    }

    const localMaisNovo = new Date(local.updated_at).getTime() > new Date(remoto.updated_at).getTime();

    if (localMaisNovo) {
      // Local vence (Last-Write-Wins): empurra os dados locais
      const { _synced, id, ...payload } = local;
      const { data, error } = await supabaseClient
        .from('turnos')
        .update(payload)
        .eq('id', turnoId)
        .select();
      if (error) throw error;
      // UPDATE que bate 0 linhas (ex: bloqueado pelo RLS) NÃO gera erro
      // sozinho — precisa checar manualmente pra não marcar como sincronizado
      // algo que na verdade nunca chegou no servidor.
      if (!data || data.length === 0) {
        throw new Error('Nenhuma linha atualizada no servidor ao sincronizar (possível bloqueio de permissão).');
      }
      await LSR_DB.turnos.update(turnoId, { _synced: true });
    } else {
      // Servidor vence: adota a versão remota (pode ter sido editada
      // em outro aparelho enquanto este estava offline)
      await LSR_DB.turnos.put({ ...remoto, _synced: true });
    }
  }
};

window.Sync = Sync;
