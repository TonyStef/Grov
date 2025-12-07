export function BillingPlaceholder() {
  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="mb-4 text-lg font-medium">Billing</h2>

      <div className="rounded-md border border-accent-400/30 bg-accent-400/5 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-400/20">
            <svg
              className="h-5 w-5 text-accent-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-text-primary">Free Tier</p>
            <p className="text-sm text-text-muted">You&apos;re on the free plan</p>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">Memories</span>
          <span className="text-text-primary">Unlimited</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">Team members</span>
          <span className="text-text-primary">Unlimited</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">Storage</span>
          <span className="text-text-primary">Unlimited</span>
        </div>
      </div>

      <div className="mt-6 rounded-md bg-bg-2 p-4">
        <p className="text-sm text-text-muted">
          Grov is currently free during beta. Paid plans with additional features
          will be available soon.
        </p>
      </div>
    </div>
  );
}
