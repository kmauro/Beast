import { useCallback, useEffect, useState } from 'react';
import type { ConversationDetail, ConversationListItem, ConversationListResponse, ConversationState } from '@beast/shared';
import { apiRequest } from './api.js';

const stateLabels: Record<ConversationState, string> = {
  NEW: 'Nuevo', BOT_QUALIFYING: 'Bot', OUT_OF_HOURS: 'Fuera de horario',
  READY_FOR_HANDOFF: 'Listo para vendedor', SELLER_ASSIGNED: 'Vendedor asignado',
  PENDING_FOLLOW_UP: 'Seguimiento', CLOSED: 'Cerrado',
};
const dateFormatter = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' });

function ConversationRow({ conversation, selected, onSelect }: { conversation: ConversationListItem; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`conversation-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className="row-topline"><strong>{conversation.customer}</strong><time>{dateFormatter.format(new Date(conversation.lastMessageAt))}</time></span>
      <span className="row-meta"><span className={`state-badge state-${conversation.state.toLowerCase()}`}>{stateLabels[conversation.state]}</span><span>{conversation.messageCount} mensajes</span></span>
    </button>
  );
}

export function ConversationsView() {
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (state) query.set('state', state);
      const response = await apiRequest<ConversationListResponse>(`/api/conversations?${query}`);
      setConversations(response.items);
      setTotal(response.total);
      setSelectedId((current) => current && response.items.some((item) => item.id === current) ? current : (response.items[0]?.id ?? null));
      setError(null);
    } catch { setError('No se pudieron cargar las conversaciones.'); }
    finally { setLoading(false); }
  }, [page, state]);

  useEffect(() => void loadList(), [loadList]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true;
    void apiRequest<ConversationDetail>(`/api/conversations/${selectedId}`)
      .then((response) => { if (active) setDetail(response); })
      .catch(() => { if (active) setError('No se pudo abrir la conversación.'); });
    return () => { active = false; };
  }, [selectedId]);

  const transition = async (target: 'NEW' | 'CLOSED') => {
    if (!detail) return;
    try {
      await apiRequest(`/api/conversations/${detail.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ state: target }),
      });
      const updated = await apiRequest<ConversationDetail>(`/api/conversations/${detail.id}`);
      setDetail(updated);
      await loadList();
      setError(null);
    } catch { setError('No se pudo cambiar el estado de la conversación.'); }
  };

  const assignSeller = async () => {
    if (!detail) return;
    try {
      await apiRequest(`/api/conversations/${detail.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'HUMAN_REQUESTED' }),
      });
      const updated = await apiRequest<ConversationDetail>(`/api/conversations/${detail.id}`);
      setDetail(updated);
      await loadList();
      setError(null);
    } catch { setError('No se pudo asignar. Verificá que exista un vendedor activo y que el estado lo permita.'); }
  };

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Bandeja</p><h1>Conversaciones</h1></div><button className="secondary" onClick={() => void loadList()}>Actualizar</button></header>
      <div className="toolbar"><label>Estado<select value={state} onChange={(event) => { setState(event.target.value); setPage(1); }}><option value="">Todos</option>{Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      {error && <div className="alert">{error}</div>}
      <section className="conversation-layout">
        <div className="conversation-list">
          {loading && <p className="empty-state">Cargando…</p>}
          {!loading && conversations.length === 0 && <p className="empty-state">Todavía no hay conversaciones para este filtro.</p>}
          {conversations.map((conversation) => <ConversationRow key={conversation.id} conversation={conversation} selected={conversation.id === selectedId} onSelect={() => setSelectedId(conversation.id)} />)}
          {total > 25 && <div className="pagination"><button disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Anterior</button><span>Página {page} de {Math.ceil(total / 25)}</span><button disabled={page >= Math.ceil(total / 25)} onClick={() => setPage((current) => current + 1)}>Siguiente</button></div>}
        </div>
        <div className="conversation-detail">
          {!detail && <p className="empty-state">Seleccioná una conversación.</p>}
          {detail && <><div className="detail-heading"><div><p className="eyebrow">Cliente</p><h2>{detail.customer}</h2></div><div className="detail-actions"><span className={`state-badge state-${detail.state.toLowerCase()}`}>{stateLabels[detail.state]}</span>{['NEW', 'BOT_QUALIFYING', 'OUT_OF_HOURS', 'READY_FOR_HANDOFF'].includes(detail.state) && <button className="primary" onClick={() => void assignSeller()}>Asignar vendedor</button>}{detail.state === 'CLOSED' ? <button className="secondary" onClick={() => void transition('NEW')}>Reabrir</button> : <button className="secondary" onClick={() => void transition('CLOSED')}>Cerrar</button>}</div></div><p className="detail-meta">{detail.sellerName ? `Asignado a ${detail.sellerName}` : 'Sin vendedor asignado'}</p><div className="message-thread">{detail.messages.map((message) => <article className={`message ${message.direction === 'INBOUND' ? 'incoming' : 'outgoing'}`} key={message.id}><small>{message.senderType}</small><p>{message.body}</p><time>{dateFormatter.format(new Date(message.occurredAt))}</time></article>)}</div></>}
        </div>
      </section>
    </>
  );
}
