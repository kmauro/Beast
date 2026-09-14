import { useEffect, useState } from 'react';
import { apiRequest } from './api.js';
import { BusinessRulesView } from './BusinessRulesView.js';
import { ConversationsView } from './ConversationsView.js';
import { FormsView } from './FormsView.js';
import { HealthView } from './HealthView.js';
import { Login } from './Login.js';
import { SellersView } from './SellersView.js';

type Section = 'conversations' | 'forms' | 'sellers' | 'rules' | 'health';

export function App() {
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [section, setSection] = useState<Section>('conversations');

  useEffect(() => {
    void apiRequest<{ username: string }>('/api/auth/session')
      .then((session) => setUsername(session.username))
      .catch(() => setUsername(null));
  }, []);

  if (username === undefined) return <main className="loading-screen">Cargando panel…</main>;
  if (username === null) return <Login onAuthenticated={setUsername} />;

  const logout = async () => {
    await apiRequest<null>('/api/auth/logout', { method: 'POST' });
    setUsername(null);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <div><strong>Beast</strong><small>Atención comercial</small></div>
        </div>
        <nav aria-label="Navegación principal">
          <button className={section === 'conversations' ? 'active' : ''} onClick={() => setSection('conversations')}>Conversaciones</button>
          <button className={section === 'forms' ? 'active' : ''} onClick={() => setSection('forms')}>Formularios</button>
          <button className={section === 'sellers' ? 'active' : ''} onClick={() => setSection('sellers')}>Vendedores</button>
          <button className={section === 'rules' ? 'active' : ''} onClick={() => setSection('rules')}>Reglas comerciales</button>
          <button className={section === 'health' ? 'active' : ''} onClick={() => setSection('health')}>Estado</button>
        </nav>
        <div className="sidebar-footer">
          <small>Sesión: {username}</small>
          <button onClick={() => void logout()}>Cerrar sesión</button>
          <p className="risk-note">Integración no oficial de WhatsApp Web. Supervisar el estado de la cuenta.</p>
        </div>
      </aside>
      <main className="content">
        {section === 'conversations' && <ConversationsView />}
        {section === 'forms' && <FormsView />}
        {section === 'sellers' && <SellersView />}
        {section === 'rules' && <BusinessRulesView />}
        {section === 'health' && <HealthView />}
      </main>
    </div>
  );
}
