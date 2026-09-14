import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { FormDetail, FormFieldDefinition, FormFieldType, ServiceForms } from '@beast/shared';
import { apiRequest } from './api.js';

const fieldTypes: Array<{ value: FormFieldType; label: string }> = [
  { value: 'TEXT', label: 'Texto corto' },
  { value: 'LONG_TEXT', label: 'Texto largo' },
  { value: 'INTEGER', label: 'Número entero' },
  { value: 'BOOLEAN', label: 'Sí / No' },
  { value: 'SINGLE_CHOICE', label: 'Una opción' },
  { value: 'MULTIPLE_CHOICE', label: 'Varias opciones' },
];

function emptyField(index: number): FormFieldDefinition {
  return {
    key: `nuevo_campo_${Date.now()}`,
    label: 'Nuevo campo',
    question: 'Escribí la pregunta',
    helpText: null,
    type: 'TEXT',
    required: false,
    essential: false,
    includeInSummary: true,
    options: [],
    displayOrder: (index + 1) * 10,
    visibleWhen: null,
  };
}

export function FormsView() {
  const [catalog, setCatalog] = useState<ServiceForms[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormDetail | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadCatalog = async () => {
    const response = await apiRequest<ServiceForms[]>('/api/forms');
    setCatalog(response);
    setServiceId((current) => current || response[0]?.id || '');
    setSelectedId((current) => current ?? response.flatMap((item) => item.templates)[0]?.id ?? null);
  };

  useEffect(() => { void loadCatalog().catch(() => setError('No se pudo cargar el catálogo.')); }, []);
  useEffect(() => {
    if (!selectedId) { setForm(null); return; }
    void apiRequest<FormDetail>(`/api/forms/${selectedId}`)
      .then((response) => { setForm(response); setError(null); })
      .catch(() => setError('No se pudo abrir el formulario.'));
  }, [selectedId]);

  const templates = useMemo(() => catalog.flatMap((service) => service.templates), [catalog]);

  const createForm = async (event: FormEvent) => {
    event.preventDefault();
    if (!serviceId || !newName.trim()) return;
    setSaving(true);
    try {
      const created = await apiRequest<FormDetail>('/api/forms', {
        method: 'POST',
        body: JSON.stringify({ serviceId, name: newName.trim(), description: null }),
      });
      setNewName('');
      await loadCatalog();
      setSelectedId(created.id);
      setNotice('Formulario creado como borrador.');
      setError(null);
    } catch { setError('No se pudo crear. Verificá que el nombre no esté repetido.'); }
    finally { setSaving(false); }
  };

  const updateField = (index: number, changes: Partial<FormFieldDefinition>) => {
    setForm((current) => {
      if (!current) return current;
      const fields = current.version.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...changes } : field);
      return { ...current, version: { ...current.version, fields } };
    });
  };

  const saveDraft = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const saved = await apiRequest<FormDetail>(`/api/forms/${form.id}/draft`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          fields: form.version.fields.map((field, index) => ({ ...field, displayOrder: (index + 1) * 10 })),
        }),
      });
      setForm(saved);
      await loadCatalog();
      setNotice('Borrador guardado.');
      setError(null);
    } catch { setError('No se pudo guardar. Revisá claves repetidas, campos esenciales y opciones.'); }
    finally { setSaving(false); }
  };

  const publish = async () => {
    if (!form || !window.confirm('¿Publicar este borrador para el bot?')) return;
    setSaving(true);
    try {
      const published = await apiRequest<FormDetail>(`/api/forms/${form.id}/publish`, { method: 'POST' });
      setForm(published);
      await loadCatalog();
      setNotice('Formulario publicado.');
      setError(null);
    } catch { setError('No hay un borrador válido para publicar.'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Configuración comercial</p><h1>Formularios</h1></div></header>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="alert">{error}</div>}
      <section className="forms-layout">
        <aside className="forms-sidebar">
          <form className="create-form" onSubmit={(event) => void createForm(event)}>
            <h2>Nuevo formulario</h2>
            <label>Servicio<select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>{catalog.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
            <label>Nombre<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Formulario inicial" required /></label>
            <button className="primary" disabled={saving}>Crear borrador</button>
          </form>
          <div className="template-list">
            {templates.map((template) => <button className={template.id === selectedId ? 'selected' : ''} key={template.id} onClick={() => setSelectedId(template.id)}><strong>{template.name}</strong><small>{template.draftVersion ? `Borrador v${template.draftVersion}` : template.publishedVersion ? `Publicado v${template.publishedVersion}` : 'Sin versión'}</small></button>)}
          </div>
        </aside>
        <div className="form-editor">
          {!form && <p className="empty-state">Creá o seleccioná un formulario.</p>}
          {form && <>
            <div className="editor-heading"><div><p className="eyebrow">{form.serviceName}</p><input className="title-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div><span className="version-badge">{form.version.status} · v{form.version.versionNumber}</span></div>
            <label>Descripción<textarea rows={2} value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value || null })} /></label>
            <div className="field-list">
              {form.version.fields.map((field, index) => <article className="field-card" key={`${field.key}-${index}`}>
                <div className="field-card-heading"><strong>{field.label}</strong><button className="danger-link" disabled={field.essential} onClick={() => setForm({ ...form, version: { ...form.version, fields: form.version.fields.filter((_, itemIndex) => itemIndex !== index) } })}>{field.essential ? 'Esencial' : 'Eliminar'}</button></div>
                <div className="field-grid">
                  <label>Clave<input value={field.key} disabled={field.essential} onChange={(event) => updateField(index, { key: event.target.value })} /></label>
                  <label>Etiqueta<input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
                  <label className="wide">Pregunta<textarea rows={2} value={field.question} onChange={(event) => updateField(index, { question: event.target.value })} /></label>
                  <label>Tipo<select value={field.type} onChange={(event) => updateField(index, { type: event.target.value as FormFieldType })}>{fieldTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
                  {(field.type === 'SINGLE_CHOICE' || field.type === 'MULTIPLE_CHOICE') && <label>Opciones, una por línea<textarea rows={3} value={field.options.join('\n')} onChange={(event) => updateField(index, { options: event.target.value.split('\n').map((option) => option.trim()).filter(Boolean) })} /></label>}
                </div>
                <div className="checkbox-row"><label><input type="checkbox" checked={field.required} disabled={field.essential} onChange={(event) => updateField(index, { required: event.target.checked })} />Obligatorio</label><label><input type="checkbox" checked={field.includeInSummary} onChange={(event) => updateField(index, { includeInSummary: event.target.checked })} />Incluir en resumen</label></div>
              </article>)}
            </div>
            <button className="secondary add-field" onClick={() => setForm({ ...form, version: { ...form.version, fields: [...form.version.fields, emptyField(form.version.fields.length)] } })}>Agregar campo</button>
            <div className="editor-actions"><button className="secondary" disabled={saving} onClick={() => void saveDraft()}>Guardar borrador</button><button className="primary" disabled={saving || !form.draftVersion} onClick={() => void publish()}>Publicar</button></div>
          </>}
        </div>
      </section>
    </>
  );
}
