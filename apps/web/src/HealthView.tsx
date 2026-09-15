import { useEffect, useState } from 'react';
import type { FailedJobItem, SystemHealth } from '@beast/shared';
import { ApiError, apiRequest } from './api.js';

const labels: Record<string, string> = {
  mysql: 'Base de datos',
  ollama: 'Modelo local',
  whatsapp: 'WhatsApp',
  job_queue: 'Cola de trabajos',
};

export function HealthView() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedJobs, setFailedJobs] = useState<FailedJobItem[]>([]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const body = await apiRequest<SystemHealth>('/api/health');
        if (active) { setHealth(body); setError(null); }
      } catch (requestError) {
        if (!active) return;
        if (
          requestError instanceof ApiError &&
          requestError.payload &&
          typeof requestError.payload === 'object' &&
          'components' in requestError.payload
        ) {
          setHealth(requestError.payload as SystemHealth);
          setError(null);
        } else {
          setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar');
        }
      }
      try {
        const jobs = await apiRequest<FailedJobItem[]>('/api/jobs/failed');
        if (active) setFailedJobs(jobs);
      } catch {
        if (active) setError('No se pudieron consultar los trabajos fallidos.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const retry = async (jobId: string) => {
    try {
      await apiRequest(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      setFailedJobs((current) => current.filter((job) => job.id !== jobId));
      setError(null);
    } catch {
      setError('No se pudo reintentar el trabajo.');
    }
  };

  return (
    <>
      <header className="page-header">
        <div><p className="eyebrow">Panel interno</p><h1>Estado del sistema</h1></div>
        <span className={`overall ${health?.status.toLowerCase() ?? 'unknown'}`}>{health?.status ?? 'CARGANDO'}</span>
      </header>
      {error && <div className="alert">{error}</div>}
      <section className="health-grid">
        {(health?.components ?? []).map((component) => (
          <article className="card" key={component.component}>
            <div className="card-heading"><span className={`dot ${component.status.toLowerCase()}`} /><span>{labels[component.component] ?? component.component}</span></div>
            <strong>{component.status}</strong><p>{component.detail ?? 'Funcionando correctamente'}</p>
          </article>
        ))}
      </section>
      {failedJobs.length > 0 && <section className="failed-jobs">
        <h2>Trabajos que requieren intervención</h2>
        {failedJobs.map((job) => <article key={job.id}>
          <div><strong>{job.jobType}</strong><small>{job.attempts}/{job.maxAttempts} intentos · {new Date(job.createdAt).toLocaleString('es-AR')}</small><p>{job.lastError ?? 'Sin detalle'}</p></div>
          <button className="secondary" onClick={() => void retry(job.id)}>Reintentar</button>
        </article>)}
      </section>}
    </>
  );
}
