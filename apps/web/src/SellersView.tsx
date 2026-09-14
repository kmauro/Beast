import { useEffect, useState, type FormEvent } from 'react';
import type { SellerItem } from '@beast/shared';
import { apiRequest } from './api.js';

interface SellerDraft {
  id: string | null;
  name: string;
  whatsappNumber: string;
  whatsappLabel: string;
  active: boolean;
}

const emptySeller = (): SellerDraft => ({
  id: null,
  name: '',
  whatsappNumber: '',
  whatsappLabel: '',
  active: true,
});

export function SellersView() {
  const [sellers, setSellers] = useState<SellerItem[]>([]);
  const [draft, setDraft] = useState<SellerDraft>(emptySeller);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => setSellers(await apiRequest<SellerItem[]>('/api/sellers'));
  useEffect(() => { void load().catch(() => setError('No se pudieron cargar los vendedores.')); }, []);

  const edit = (seller: SellerItem) => setDraft({
    id: seller.id,
    name: seller.name,
    whatsappNumber: seller.whatsappNumber,
    whatsappLabel: seller.whatsappLabel,
    active: seller.active,
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await apiRequest(draft.id ? `/api/sellers/${draft.id}` : '/api/sellers', {
        method: draft.id ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: draft.name,
          whatsappNumber: draft.whatsappNumber,
          ...(draft.whatsappLabel ? { whatsappLabel: draft.whatsappLabel.toUpperCase() } : {}),
          active: draft.active,
        }),
      });
      await load();
      setDraft(emptySeller());
      setNotice(draft.id ? 'Vendedor actualizado.' : 'Vendedor creado.');
      setError(null);
    } catch { setError('No se pudo guardar. Revisá el número, la etiqueta y que quede un vendedor activo.'); }
    finally { setSaving(false); }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (!sellers[nextIndex]) return;
    const reordered = [...sellers];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex]!, reordered[index]!];
    try {
      await apiRequest('/api/sellers/reorder', {
        method: 'POST',
        body: JSON.stringify({ sellerIds: reordered.map((seller) => seller.id) }),
      });
      await load();
      setNotice('Orden de rotación actualizado.');
    } catch { setError('No se pudo cambiar el orden de rotación.'); }
  };

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Equipo comercial</p><h1>Vendedores</h1></div></header>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="alert">{error}</div>}
      <section className="management-layout">
        <div className="management-list">
          {sellers.length === 0 && <p className="empty-state">Todavía no hay vendedores.</p>}
          {sellers.map((seller, index) => (
            <article className="seller-row" key={seller.id}>
              <div className="rotation-index">{index + 1}</div>
              <div><strong>{seller.name}</strong><small>{seller.whatsappLabel} · {seller.active ? 'Activo' : 'Inactivo'}</small></div>
              <div className="row-actions">
                <button disabled={index === 0} onClick={() => void move(index, -1)} aria-label="Subir">↑</button>
                <button disabled={index === sellers.length - 1} onClick={() => void move(index, 1)} aria-label="Bajar">↓</button>
                <button onClick={() => edit(seller)}>Editar</button>
              </div>
            </article>
          ))}
        </div>
        <form className="management-form" onSubmit={(event) => void save(event)}>
          <h2>{draft.id ? 'Editar vendedor' : 'Nuevo vendedor'}</h2>
          <label>Nombre<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
          <label>Número de WhatsApp<input value={draft.whatsappNumber} onChange={(event) => setDraft({ ...draft, whatsappNumber: event.target.value })} placeholder="+54 9 11…" required /></label>
          <label>Etiqueta de WhatsApp<input value={draft.whatsappLabel} onChange={(event) => setDraft({ ...draft, whatsappLabel: event.target.value.toUpperCase() })} placeholder="VENDEDOR_1" /></label>
          <label className="inline-check"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />Activo para nuevas asignaciones</label>
          <div className="form-actions">
            {draft.id && <button type="button" className="secondary" onClick={() => setDraft(emptySeller())}>Cancelar</button>}
            <button className="primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </form>
      </section>
    </>
  );
}
