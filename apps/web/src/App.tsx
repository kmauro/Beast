import { useEffect, useState } from 'react';
import type { SystemHealth } from '@beast/shared';

const labels: Record<string, string> = {
  mysql: 'Base de datos',
  ollama: 'Modelo local',
  whatsapp: 'WhatsApp',
};

export function App() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const response = await fetch('/api/health');
        const body = (await response.json()) as SystemHealth;
        if (active) {
          setHealth(body);
          setError(null);
        }
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar el sistema');
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <div>
            <strong>Beast</strong>
            <small>Atención comercial</small>
          </div>
        </div>
        <nav aria-label="Navegación principal">
          <a className="active" href="#estado">Estado</a>
          <a href="#conversaciones">Conversaciones</a>
          <a href="#formularios">Formularios</a>
          <a href="#vendedores">Vendedores</a>
          <a href="#configuracion">Configuración</a>
        </nav>
        <p className="risk-note">Integración no oficial de WhatsApp Web. Supervisar el estado de la cuenta.</p>
      </aside>

      <main>
        <header>
          <div>
            <p className="eyebrow">Panel interno</p>
            <h1>Estado del sistema</h1>
          </div>
          <span className={`overall ${health?.status.toLowerCase() ?? 'unknown'}`}>
            {health?.status ?? 'CARGANDO'}
          </span>
        </header>

        {error && <div className="alert">{error}</div>}

        <section className="health-grid" id="estado">
          {(health?.components ?? []).map((component) => (
            <article className="card" key={component.component}>
              <div className="card-heading">
                <span className={`dot ${component.status.toLowerCase()}`} />
                <span>{labels[component.component] ?? component.component}</span>
              </div>
              <strong>{component.status}</strong>
              <p>{component.detail ?? 'Funcionando correctamente'}</p>
            </article>
          ))}
          {!health && !error && <article className="card skeleton">Consultando componentes…</article>}
        </section>

        <section className="placeholder" id="conversaciones">
          <p className="eyebrow">Primera etapa</p>
          <h2>La infraestructura está preparada</h2>
          <p>Las próximas iteraciones incorporarán autenticación, conversaciones pendientes, formularios editables y rotación de vendedores.</p>
        </section>
      </main>
    </div>
  );
}

