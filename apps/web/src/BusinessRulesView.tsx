import { useEffect, useState, type FormEvent } from 'react';
import type { BusinessHourRule, BusinessRules } from '@beast/shared';
import { apiRequest } from './api.js';

const weekdayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

export function BusinessRulesView() {
  const [rules, setRules] = useState<BusinessRules | null>(null);
  const [holidayDate, setHolidayDate] = useState('');
  const [holidayName, setHolidayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => setRules(await apiRequest<BusinessRules>('/api/business-rules'));
  useEffect(() => { void load().catch(() => setError('No se pudieron cargar las reglas.')); }, []);

  const updateHour = (weekday: number, changes: Partial<BusinessHourRule>) => {
    setRules((current) => current ? {
      ...current,
      hours: current.hours.map((hour) => hour.weekday === weekday ? { ...hour, ...changes } : hour),
    } : current);
  };

  const saveHours = async () => {
    if (!rules) return;
    try {
      await apiRequest('/api/business-rules/hours', { method: 'PUT', body: JSON.stringify({ hours: rules.hours }) });
      setNotice('Horario comercial actualizado.'); setError(null);
    } catch { setError('El horario no es válido. La apertura debe ser anterior al cierre.'); }
  };

  const saveAutomation = async () => {
    if (!rules) return;
    try {
      await apiRequest('/api/business-rules/automation', {
        method: 'PUT',
        body: JSON.stringify({
          followUpAfterBusinessHours: rules.followUpAfterBusinessHours,
          autoCloseAfterBusinessHours: rules.autoCloseAfterBusinessHours,
        }),
      });
      setNotice('Plazos automáticos actualizados.'); setError(null);
    } catch { setError('El cierre debe ocurrir después del seguimiento.'); }
  };

  const saveHoliday = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await apiRequest('/api/business-rules/holidays', {
        method: 'POST', body: JSON.stringify({ date: holidayDate, name: holidayName }),
      });
      setHolidayDate(''); setHolidayName(''); await load(); setNotice('Feriado guardado.'); setError(null);
    } catch { setError('No se pudo guardar el feriado.'); }
  };

  const removeHoliday = async (date: string) => {
    try {
      await apiRequest(`/api/business-rules/holidays/${date}`, { method: 'DELETE' });
      await load(); setNotice('Feriado eliminado.');
    } catch { setError('No se pudo eliminar el feriado.'); }
  };

  if (!rules) return <p className="empty-state">Cargando reglas comerciales…</p>;

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Calendario</p><h1>Reglas comerciales</h1></div><span className="version-badge">{rules.timezone}</span></header>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="alert">{error}</div>}
      <section className="rules-grid">
        <article className="settings-card wide-card">
          <div className="section-heading"><div><h2>Horario semanal</h2><p>Los cierres y seguimientos cuentan únicamente estas horas.</p></div><button className="primary" onClick={() => void saveHours()}>Guardar horario</button></div>
          <div className="hours-list">
            {rules.hours.map((hour) => <div className="hour-row" key={hour.weekday}>
              <label className="inline-check"><input type="checkbox" checked={hour.enabled} onChange={(event) => updateHour(hour.weekday, { enabled: event.target.checked, opensAt: event.target.checked ? (hour.opensAt ?? '09:00') : null, closesAt: event.target.checked ? (hour.closesAt ?? '18:00') : null })} />{weekdayNames[hour.weekday - 1]}</label>
              <input type="time" value={hour.opensAt ?? ''} disabled={!hour.enabled} onChange={(event) => updateHour(hour.weekday, { opensAt: event.target.value })} />
              <span>a</span>
              <input type="time" value={hour.closesAt ?? ''} disabled={!hour.enabled} onChange={(event) => updateHour(hour.weekday, { closesAt: event.target.value })} />
            </div>)}
          </div>
        </article>
        <article className="settings-card">
          <h2>Automatización</h2>
          <label>Seguimiento después de horas hábiles<input type="number" min="1" value={rules.followUpAfterBusinessHours} onChange={(event) => setRules({ ...rules, followUpAfterBusinessHours: Number(event.target.value) })} /></label>
          <label>Cierre después de horas hábiles<input type="number" min="1" value={rules.autoCloseAfterBusinessHours} onChange={(event) => setRules({ ...rules, autoCloseAfterBusinessHours: Number(event.target.value) })} /></label>
          <button className="primary" onClick={() => void saveAutomation()}>Guardar plazos</button>
        </article>
        <article className="settings-card">
          <h2>Feriados</h2>
          <form className="holiday-form" onSubmit={(event) => void saveHoliday(event)}>
            <input type="date" value={holidayDate} onChange={(event) => setHolidayDate(event.target.value)} required />
            <input value={holidayName} onChange={(event) => setHolidayName(event.target.value)} placeholder="Nombre del feriado" required />
            <button className="secondary">Agregar</button>
          </form>
          <div className="holiday-list">
            {rules.holidays.map((holiday) => <div key={holiday.date}><span><strong>{holiday.name}</strong><small>{holiday.date}</small></span><button onClick={() => void removeHoliday(holiday.date)}>Eliminar</button></div>)}
            {rules.holidays.length === 0 && <p className="empty-state">No hay feriados cargados.</p>}
          </div>
        </article>
      </section>
    </>
  );
}
