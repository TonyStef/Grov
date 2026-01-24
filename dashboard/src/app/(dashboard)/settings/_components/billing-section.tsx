'use client';

import { useState, useTransition } from 'react';
import type { SubscriptionResponse, TeamUsageResponse, UsageBreakdownResponse, UsageStatus } from '@grov/shared';
import type { TeamWithSettings } from '@/lib/queries/settings';
import { createPortalSession } from '../actions';

interface BillingSectionProps {
  team: TeamWithSettings | null;
  subscription: SubscriptionResponse | null;
  usage: TeamUsageResponse | null;
  usageBreakdown: UsageBreakdownResponse | null;
  isOwner: boolean;
  isAdmin: boolean;
}

const STATUS_CONFIG: Record<UsageStatus, { color: string; label: string; borderColor: string }> = {
  normal: { color: 'text-leaf', label: 'Normal', borderColor: 'border-leaf' },
  warning_80: { color: 'text-warning', label: 'Approaching Limit', borderColor: 'border-warning' },
  warning_100: { color: 'text-warning', label: 'At Limit', borderColor: 'border-warning' },
  overage: { color: 'text-error', label: 'Over Limit', borderColor: 'border-error' },
};

function getProgressColor(status: UsageStatus): string {
  if (status === 'overage') return 'bg-error';
  if (status === 'warning_80' || status === 'warning_100') return 'bg-warning';
  return 'bg-leaf';
}

export function BillingSection({ team, subscription, usage, usageBreakdown, isOwner, isAdmin }: BillingSectionProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);

  if (!team) {
    return (
      <div className="border-l-2 border-text-quiet/30 pl-6">
        <h2 className="font-display text-2xl font-medium tracking-tight">Billing</h2>
        <p className="mt-2 text-sm text-text-calm">
          Join or create a team to manage billing.
        </p>
      </div>
    );
  }

  const currentPlan = subscription?.subscription?.plan;
  const status = subscription?.subscription?.status;
  const isTrialing = status === 'trialing';
  const isPastDue = status === 'past_due';
  const isFree = !currentPlan || currentPlan.name === 'free';

  const injectionStatus = usage?.status ?? 'normal';
  const statusConfig = STATUS_CONFIG[injectionStatus];
  const showUsageWarning = injectionStatus !== 'normal';

  const handleManageSubscription = () => {
    setError(null);
    startTransition(async () => {
      const result = await createPortalSession(team.id);
      if (result.error) {
        setError(result.error);
      } else if (result.portal_url) {
        window.location.href = result.portal_url;
      }
    });
  };

  return (
    <div className="space-y-12">
      {/* Payment Alert */}
      {isPastDue && (
        <div className="border-l-2 border-warning pl-6">
          <p className="text-xs font-medium uppercase tracking-widest text-warning">Payment Failed</p>
          <p className="mt-1 text-sm text-text-calm">Update your payment method to keep your features.</p>
          {isOwner && (
            <button
              onClick={handleManageSubscription}
              disabled={isPending}
              className="mt-4 text-sm font-medium text-warning underline underline-offset-4 transition-colors hover:text-warning/80 focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-root disabled:opacity-50"
            >
              Update Payment
            </button>
          )}
        </div>
      )}

      {/* Usage Warning */}
      {showUsageWarning && usage && (
        <div className={`border-l-2 ${statusConfig.borderColor} pl-6`}>
          <p className={`text-xs font-medium uppercase tracking-widest ${statusConfig.color}`}>
            {statusConfig.label}
          </p>
          <p className="mt-1 text-sm text-text-calm">
            {injectionStatus === 'overage'
              ? `You've exceeded your injection limit. Overage charges will apply at $${(usage.billing.overage_rate_cents / 100).toFixed(2)} per injection.`
              : `Your team has used ${usage.injections.percent.toFixed(0)}% of your monthly injection limit.`
            }
          </p>
          {usage.billing.estimated_overage_cost > 0 && (
            <p className="mt-2 font-mono text-sm text-text-bright">
              Estimated overage: ${(usage.billing.estimated_overage_cost / 100).toFixed(2)}
            </p>
          )}
        </div>
      )}

      {/* Current Plan */}
      <section>
        <div className="flex items-baseline justify-between border-b border-border pb-4">
          <h2 className="font-display text-xs font-medium uppercase tracking-widest text-text-quiet">Current Plan</h2>
          {!isFree && isOwner && (
            <button
              onClick={handleManageSubscription}
              disabled={isPending}
              className="text-xs text-text-quiet underline underline-offset-4 transition-colors hover:text-text-calm focus-visible:ring-2 focus-visible:ring-leaf focus-visible:ring-offset-2 focus-visible:ring-offset-root disabled:opacity-50"
            >
              Manage
            </button>
          )}
        </div>

        <div className="mt-8">
          <div className="flex items-baseline gap-3">
            <h3 className="font-display text-4xl font-semibold tracking-tight text-text-bright">
              {currentPlan?.display_name || 'Free'}
            </h3>
            {isTrialing && (
              <span className="text-xs font-medium uppercase tracking-widest text-leaf">Trial</span>
            )}
          </div>

          {!isFree && subscription?.subscription && (
            <p className="mt-2 font-mono text-xs text-text-quiet">
              {isTrialing && subscription.subscription.trial_end && (
                <>Ends {new Date(subscription.subscription.trial_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>
              )}
              {!isTrialing && subscription.subscription.current_period_end && (
                <>Next billing {new Date(subscription.subscription.current_period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>
              )}
            </p>
          )}
        </div>

        {/* Injection Usage */}
        {usage && (
          <div className="mt-8">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-widest text-text-quiet">Injections This Period</span>
              <span className="font-mono text-sm tabular-nums text-text-bright">
                {usage.injections.used.toLocaleString()}<span className="text-text-quiet">/{usage.injections.quota.toLocaleString()}</span>
              </span>
            </div>
            <div className="mt-3 h-px bg-bark">
              <div
                className={`h-px ${getProgressColor(injectionStatus)} transition-all duration-500`}
                style={{ width: `${Math.min(usage.injections.percent, 100)}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-mono text-[11px] text-text-quiet">
                {usage.seats.limit_per_seat.toLocaleString()} per seat × {usage.seats.count} {usage.seats.count === 1 ? 'seat' : 'seats'}
              </span>
              {usage.injections.overage > 0 && (
                <span className="font-mono text-[11px] text-error">
                  +{usage.injections.overage.toLocaleString()} overage
                </span>
              )}
            </div>
          </div>
        )}

        {/* Usage Breakdown Toggle */}
        {isAdmin && usageBreakdown && usageBreakdown.by_user.length > 0 && (
          <div className="mt-8">
            <button
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="text-xs text-text-calm underline underline-offset-4 transition-colors hover:text-text-bright focus-visible:ring-2 focus-visible:ring-leaf focus-visible:ring-offset-2 focus-visible:ring-offset-root"
              aria-expanded={showBreakdown}
            >
              {showBreakdown ? 'Hide breakdown' : 'View usage breakdown'}
            </button>

            {showBreakdown && (
              <div className="mt-6 rounded-lg border border-border bg-bark p-4">
                <h4 className="mb-4 text-xs font-medium uppercase tracking-widest text-text-quiet">
                  Usage by Team Member
                </h4>

                {usageBreakdown.by_user.length === 0 ? (
                  <p className="text-sm text-text-quiet">No usage data yet</p>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-widest text-text-quiet">
                        <th className="pb-2">Member</th>
                        <th className="pb-2 text-right">Injections</th>
                        <th className="pb-2 text-right">Share</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {usageBreakdown.by_user.map((user) => (
                        <tr key={user.user_id} className="border-b border-border/50 last:border-0">
                          <td className="py-2 text-text-calm">{user.email}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-text-bright">
                            {user.injection_count.toLocaleString()}
                          </td>
                          <td className="py-2 text-right font-mono tabular-nums text-text-quiet">
                            {user.percent_of_team.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {usageBreakdown.by_day.length > 0 && (
                  <>
                    <h4 className="mb-3 mt-6 text-xs font-medium uppercase tracking-widest text-text-quiet">
                      Daily Activity
                    </h4>
                    <div className="flex items-end gap-1" style={{ height: '60px' }}>
                      {usageBreakdown.by_day.slice(-14).map((day) => {
                        const maxCount = Math.max(...usageBreakdown.by_day.map(d => d.injection_count));
                        const height = maxCount > 0 ? (day.injection_count / maxCount) * 100 : 0;
                        return (
                          <div
                            key={day.date}
                            className="flex-1 bg-leaf/60 transition-all hover:bg-leaf"
                            style={{ height: `${Math.max(height, 2)}%` }}
                            title={`${day.date}: ${day.injection_count} injections`}
                          />
                        );
                      })}
                    </div>
                    <p className="mt-2 text-center font-mono text-[10px] text-text-quiet">
                      Last 14 days
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Error */}
      {error && (
        <p className="font-mono text-xs text-error" role="alert">{error}</p>
      )}
    </div>
  );
}
