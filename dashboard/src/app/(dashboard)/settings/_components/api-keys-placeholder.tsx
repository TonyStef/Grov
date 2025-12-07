export function ApiKeysPlaceholder() {
  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="mb-4 text-lg font-medium">API Keys</h2>
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-2">
          <svg
            className="h-6 w-6 text-text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
          </svg>
        </div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Coming Soon</h3>
        <p className="max-w-sm text-sm text-text-muted">
          API keys will allow you to programmatically access your team&apos;s memories
          through the Grov API.
        </p>
      </div>
    </div>
  );
}
