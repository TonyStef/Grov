/**
 * Billing types - subscriptions, plans, and payments
 * Aligns with Supabase plans, plan_prices, subscriptions, payment_events tables
 */

// Subscription status from Stripe
export type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'trialing'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused';

// Billing interval
export type BillingInterval = 'month' | 'year';

// Plan record
export interface Plan {
  id: string;
  name: string;
  stripe_product_id: string | null;
  display_name: string;
  description: string | null;
  max_users: number;
  has_api_access: boolean;
  has_cloud_sync: boolean;
  has_analytics: boolean;
  has_priority_support: boolean;
  features: string[];
  sort_order: number;
  injection_limit_per_seat: number | null;
  overage_rate_cents: number | null;
  created_at: string;
  updated_at: string;
}

// Plan price record
export interface PlanPrice {
  id: string;
  plan_id: string;
  stripe_price_id: string;
  billing_interval: BillingInterval;
  amount_cents: number;
  currency: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// Plan with prices for display
export interface PlanWithPrices extends Plan {
  prices: PlanPrice[];
}

// Subscription record
export interface Subscription {
  id: string;
  team_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  plan_id: string;
  status: SubscriptionStatus;
  billing_interval: BillingInterval | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

// Subscription with plan details
export interface SubscriptionWithPlan extends Subscription {
  plan: Plan;
}

// Payment event record
export interface PaymentEvent {
  id: string;
  stripe_event_id: string;
  event_type: string;
  subscription_id: string | null;
  team_id: string | null;
  processed_at: string;
}

// Response for plans list
export interface PlansResponse {
  plans: PlanWithPrices[];
}

// Response for subscription status
export interface SubscriptionResponse {
  subscription: SubscriptionWithPlan | null;
  usage: {
    current_users: number;
    max_users: number;
  };
}

// Request for creating checkout session
export interface CreateCheckoutRequest {
  price_id: string;
}

// Response for checkout session
export interface CreateCheckoutResponse {
  checkout_url: string;
}

// Response for customer portal session
export interface CreatePortalResponse {
  portal_url: string;
}

// Invoice summary
export interface Invoice {
  id: string;
  amount_paid: number;
  currency: string;
  status: string;
  created: string;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
}

// Response for invoices list
export interface InvoicesResponse {
  invoices: Invoice[];
  has_more: boolean;
}
