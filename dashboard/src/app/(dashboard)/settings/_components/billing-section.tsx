'use client';

import { useState, useTransition } from 'react';
import type { PlanWithPrices, SubscriptionResponse } from '@grov/shared';
import type { TeamWithSettings } from '@/lib/queries/settings';
import { createCheckout, createPortalSession } from '../actions';

interface BillingSectionProps {
  team: TeamWithSettings | null;
  plans: PlanWithPrices[];
  subscription: SubscriptionResponse | null;
  isOwner: boolean;
}

export function BillingSection({ team, plans, subscription, isOwner }: BillingSectionProps) {
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
  const usage = subscription?.usage;
  const status = subscription?.subscription?.status;
  const isTrialing = status === 'trialing';
  const isPastDue = status === 'past_due';
  const isFree = !currentPlan || currentPlan.name === 'free';

  const handleCheckout = (priceId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await createCheckout(team.id, priceId);
      if (result.error) {
        setError(result.error);
      } else if (result.checkout_url) {
        window.location.href = result.checkout_url;
      }
    });
  };

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

  const formatPrice = (cents: number) => {
    return (cents / 100).toFixed(0);
  };

  const getPrice = (plan: PlanWithPrices) => {
    const price = plan.prices.find((p) => p.billing_interval === billingInterval);
    return price;
  };

  const paidPlans = plans.filter((p) => p.name !== 'free');

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
              className="mt-4 text-sm font-medium text-warning underline underline-offset-4 transition-colors hover:text-warning/80 disabled:opacity-50"
            >
              Update Payment
            </button>
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
              className="text-xs text-text-quiet underline underline-offset-4 transition-colors hover:text-text-calm disabled:opacity-50"
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

        {/* Usage */}
        {usage && (
          <div className="mt-10">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-widest text-text-quiet">Team Members</span>
              <span className="font-mono text-sm text-text-bright">
                {usage.current_users}<span className="text-text-quiet">/{usage.max_users}</span>
              </span>
            </div>
            <div className="mt-3 h-px bg-bark">
              <div
                className="h-px bg-leaf transition-all duration-500"
                style={{ width: `${Math.min((usage.current_users / usage.max_users) * 100, 100)}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {/* Error */}
      {error && (
        <p className="font-mono text-xs text-error">{error}</p>
      )}

      {/* Plans */}
      {(isFree || isOwner) && paidPlans.length > 0 && (
        <section>
          <div className="flex items-center justify-between border-b border-border pb-4">
            <h2 className="font-display text-xs font-medium uppercase tracking-widest text-text-quiet">
              {isFree ? 'Upgrade' : 'Switch Plan'}
            </h2>
            <div className="flex gap-1 font-mono text-xs">
              <button
                onClick={() => setBillingInterval('month')}
                className={`px-3 py-1.5 transition-colors ${
                  billingInterval === 'month'
                    ? 'bg-bark text-text-bright'
                    : 'text-text-quiet hover:text-text-calm'
                }`}
              >
                Monthly
              </button>
              <button
                onClick={() => setBillingInterval('year')}
                className={`px-3 py-1.5 transition-colors ${
                  billingInterval === 'year'
                    ? 'bg-bark text-text-bright'
                    : 'text-text-quiet hover:text-text-calm'
                }`}
              >
                Yearly
              </button>
            </div>
          </div>

          <div className="mt-8 grid gap-8 lg:grid-cols-2">
            {paidPlans.map((plan) => {
              const price = getPrice(plan);
              const isCurrentPlan = currentPlan?.id === plan.id;

              return (
                <div
                  key={plan.id}
                  className={`group relative ${isCurrentPlan ? 'opacity-60' : ''}`}
                >
                  {isCurrentPlan && (
                    <div className="absolute -left-4 top-0 h-full w-px bg-leaf" />
                  )}

                  <div className="flex items-baseline justify-between">
                    <h3 className="font-display text-lg font-medium text-text-bright">
                      {plan.display_name}
                    </h3>
                    <div className="text-right">
                      <span className="font-mono text-3xl font-light tracking-tight text-text-bright">
                        ${price ? formatPrice(price.amount_cents) : '0'}
                      </span>
                      <span className="ml-1 font-mono text-xs text-text-quiet">
                        /{billingInterval === 'month' ? 'mo' : 'yr'}
                      </span>
                    </div>
                  </div>

                  <ul className="mt-6 space-y-2">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-center gap-3 text-sm text-text-calm">
                        <span className="h-px w-3 bg-text-quiet/50" />
                        {feature}
                      </li>
                    ))}
                  </ul>

                  {isOwner && (
                    <button
                      onClick={() => price && handleCheckout(price.stripe_price_id)}
                      disabled={isPending || isCurrentPlan || !price}
                      className={`mt-8 w-full py-3 font-mono text-xs font-medium uppercase tracking-widest transition-all ${
                        isCurrentPlan
                          ? 'cursor-default text-text-quiet'
                          : 'border border-border bg-transparent text-text-bright hover:border-leaf hover:text-leaf disabled:opacity-50'
                      }`}
                    >
                      {isCurrentPlan ? 'Current' : isFree ? 'Start Trial' : 'Switch'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {!isOwner && (
            <p className="mt-8 text-center font-mono text-xs text-text-quiet">
              Only team owners can manage billing
            </p>
          )}
        </section>
      )}
    </div>
  );
}
