import { Button } from '../components/primitives/button';
import { Input } from '../components/primitives/input';
import { useState } from 'react';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', json: { password } });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground px-4 py-10">
      <form onSubmit={submit} className="anim-sheet w-full max-w-sm rounded-2xl border border-sheetEdge bg-surface p-8">
        <Logo />
        <h1 className="mt-8 text-2xl font-semibold tracking-[-0.01em]">Sign in</h1>
        <p className="mt-1 text-muted">See which post, ad or link brought you customers.</p>
        <label className="label mt-6" htmlFor="pw">
          Password
        </label>
        <Input
          id="pw"
          type="password"
          className="input h-10"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          aria-invalid={!!error}
          aria-describedby={error ? 'pw-error' : undefined}
        />
        {error && (
          <p id="pw-error" className="mt-2 text-sm text-negative" role="alert">
            {error}
          </p>
        )}
        <Button variant="raw" size="raw" className="btn-dark mt-6 h-10 w-full" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="mt-4 text-xs text-muted">The password is the one set as ADMIN_PASSWORD on your Worker.</p>
      </form>
    </div>
  );
}
