// LSR App - Banco local (IndexedDB via Dexie.js)
// Espelha as tabelas do Supabase: veiculos e turnos.
// Todo registro tem: _synced (boolean) e _dirty (boolean) para controle de fila de sync.

const db = new Dexie('lsr_app_db');

db.version(1).stores({
  // veiculos: mesma estrutura da tabela remota + flags de controle local
  veiculos: 'id, user_id, is_ativo, updated_at, _synced',

  // turnos: id é o UUID gerado no cliente (chave primária compartilhada com o Supabase)
  turnos: 'id, user_id, veiculo_id, data_turno, status, updated_at, _synced',

  // fila de operações pendentes de sincronização (fallback para deletes, etc.)
  sync_queue: '++local_id, tabela, operacao, registro_id, created_at'
});

/**
 * Gera um UUID v4 no cliente.
 * Usado para criar o id de turnos offline, garantindo consistência
 * entre o registro local e o que será sincronizado no Supabase.
 */
function gerarUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Timestamp ISO atual, usado consistentemente para updated_at
 * (base da estratégia de sync Last-Write-Wins).
 */
function agoraISO() {
  return new Date().toISOString();
}

/**
 * Executa uma chamada ao Supabase com um TEMPO LIMITE. Sem isso, numa
 * rede fraca/instável, o app pode ficar esperando a resposta travar por
 * muito tempo antes de desistir e cair no cache local — o motoboy não
 * pode ficar esperando. Se o tempo estourar, trata como se tivesse
 * falhado (cai no fallback offline normalmente).
 */
function comTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo de resposta excedido')), ms))
  ]);
}

window.LSR_DB = db;
window.gerarUUID = gerarUUID;
window.agoraISO = agoraISO;
window.comTimeout = comTimeout;
