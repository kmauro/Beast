import { useState, type FormEvent } from 'react';
import { apiRequest } from './api.js';

export function Login({ onAuthenticated }: { onAuthenticated: (username: string) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session = await apiRequest<{ username: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onAuthenticated(session.username);
    } catch {
      setError('Usuario o contraseña incorrectos.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand login-brand">
          <span className="brand-mark">B</span>
          <div><strong>Beast</strong><small>Panel interno</small></div>
        </div>
        <p className="eyebrow">Acceso protegido</p>
        <h1>Atención comercial</h1>
        <label>Usuario<input value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="alert">{error}</div>}
        <button className="primary" disabled={submitting} type="submit">{submitting ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
    </main>
  );
}
