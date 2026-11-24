import { Logo } from './Logo';

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <Logo />
      <h1 className="mt-8 text-2xl font-semibold tracking-[-0.01em]">Page not found</h1>
      <p className="mt-2 text-muted">This page doesn&apos;t exist or has moved.</p>
      <a href="/" className="btn-dark mt-6">
        Go to DataMonster
      </a>
    </div>
  );
}
