import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Settings',
};

export default function SettingsPage() {
  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-text-secondary">
          Manage your account and preferences
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Navigation */}
        <nav className="space-y-1">
          <NavItem href="/settings" active>
            Profile
          </NavItem>
          <NavItem href="/settings/team">Team Settings</NavItem>
          <NavItem href="/settings/notifications">Notifications</NavItem>
          <NavItem href="/settings/api">API Keys</NavItem>
          <NavItem href="/settings/billing">Billing</NavItem>
        </nav>

        {/* Content */}
        <div className="lg:col-span-2">
          <div className="rounded-lg border border-border bg-bg-1 p-6">
            <h2 className="mb-6 text-lg font-medium">Profile</h2>

            <form className="space-y-4">
              <div>
                <label className="mb-2 block text-sm text-text-secondary">
                  Full Name
                </label>
                <input
                  type="text"
                  placeholder="Your name"
                  className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm text-text-secondary">
                  Email
                </label>
                <input
                  type="email"
                  placeholder="your@email.com"
                  disabled
                  className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-muted"
                />
                <p className="mt-1 text-xs text-text-muted">
                  Email cannot be changed
                </p>
              </div>

              <div className="pt-4">
                <button
                  type="submit"
                  className="rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>

          {/* Danger Zone */}
          <div className="mt-6 rounded-lg border border-error/50 bg-error/5 p-6">
            <h2 className="mb-2 text-lg font-medium text-error">Danger Zone</h2>
            <p className="mb-4 text-sm text-text-secondary">
              Once you delete your account, there is no going back.
            </p>
            <button className="rounded-md border border-error px-4 py-2 text-sm font-medium text-error transition-colors hover:bg-error hover:text-white">
              Delete Account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={`block rounded-md px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'bg-accent-400/10 text-accent-400'
          : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      }`}
    >
      {children}
    </a>
  );
}
