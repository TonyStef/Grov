import type { Metadata } from 'next';
import { LoginForm } from './_components/login-form';

export const metadata: Metadata = {
  title: 'Login',
  description: 'Sign in to your Grov account',
};

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next } = await searchParams;

  return (
    <div className="animate-fade-in space-y-6">
      <div className="text-center">
        <h1 className="font-mono text-3xl font-bold text-accent-400 text-glow">
          grov
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Collective AI Memory for Engineering Teams
        </p>
      </div>

      <div className="rounded-lg border border-border bg-bg-1 p-6 shadow-md">
        <h2 className="mb-4 text-center text-lg font-medium">
          Sign in to continue
        </h2>
        <LoginForm redirectTo={next} />
      </div>

      <p className="text-center text-xs text-text-muted">
        By signing in, you agree to our{' '}
        <a href="https://grov.dev/terms" className="text-accent-400 hover:underline">
          Terms of Service
        </a>{' '}
        and{' '}
        <a href="https://grov.dev/privacy" className="text-accent-400 hover:underline">
          Privacy Policy
        </a>
      </p>
    </div>
  );
}
