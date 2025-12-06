import type { Metadata } from 'next';
import { DeviceAuthForm } from './_components/device-auth-form';

export const metadata: Metadata = {
  title: 'Authorize Device',
  description: 'Authorize your CLI to access Grov',
};

interface DevicePageProps {
  searchParams: Promise<{ code?: string }>;
}

export default async function DevicePage({ searchParams }: DevicePageProps) {
  const { code } = await searchParams;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Logo */}
      <div className="text-center">
        <h1 className="font-mono text-3xl font-bold text-accent-400 text-glow">
          grov
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Authorize CLI Access
        </p>
      </div>

      {/* Device Auth Card */}
      <div className="rounded-lg border border-border bg-bg-1 p-6 shadow-md">
        <h2 className="mb-4 text-center text-lg font-medium">
          Enter the code shown in your terminal
        </h2>
        <DeviceAuthForm initialCode={code} />
      </div>

      {/* Instructions */}
      <div className="rounded-md border border-border bg-bg-1/50 p-4 text-sm text-text-secondary">
        <p className="mb-2 font-medium text-text-primary">How it works:</p>
        <ol className="list-inside list-decimal space-y-1">
          <li>Run <code className="rounded bg-bg-2 px-1 font-mono text-accent-400">grov login</code> in your terminal</li>
          <li>Enter the code shown above</li>
          <li>Your CLI will be authenticated automatically</li>
        </ol>
      </div>
    </div>
  );
}
