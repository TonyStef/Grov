// Billing routes - Stripe integration

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  PlansResponse,
  PlanWithPrices,
  SubscriptionResponse,
  CreateCheckoutRequest,
  CreateCheckoutResponse,
  CreatePortalResponse,
  InvoicesResponse,
} from '@grov/shared';
import { stripe } from '../lib/stripe.js';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember, requireTeamOwner } from '../middleware/team.js';
import type Stripe from 'stripe';

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

/**
 * Handle Stripe API errors and return appropriate user-facing messages.
 * Logs full error details for debugging while returning sanitized messages to users.
 */
function handleStripeError(
  error: unknown,
  logger: { error: (obj: unknown, msg: string) => void },
  context: string
): { status: number; message: string } {
  // Type guard for Stripe errors
  const isStripeError = (err: unknown): err is Stripe.errors.StripeError => {
    return err instanceof Error && 'type' in err;
  };

  if (isStripeError(error)) {
    logger.error({ err: error, code: error.code, type: error.type }, `Stripe error in ${context}`);

    // Map Stripe error codes to user-friendly messages
    switch (error.code) {
      case 'card_declined':
        return { status: 400, message: 'Your card was declined. Please try a different payment method.' };
      case 'expired_card':
        return { status: 400, message: 'Your card has expired. Please use a different card.' };
      case 'incorrect_cvc':
        return { status: 400, message: 'Incorrect security code. Please check and try again.' };
      case 'processing_error':
        return { status: 500, message: 'An error occurred while processing your card. Please try again.' };
      case 'rate_limit':
        return { status: 429, message: 'Too many requests. Please wait a moment and try again.' };
      case 'customer_tax_location_invalid':
        return { status: 400, message: 'Unable to determine your location for tax calculation. Please try again.' };
      case 'resource_missing':
        return { status: 400, message: 'The requested resource could not be found.' };
      default:
        // For unknown Stripe errors, return generic message
        return { status: 500, message: 'An error occurred processing your request. Please try again.' };
    }
  }

  // Non-Stripe errors
  logger.error({ err: error }, `Unexpected error in ${context}`);
  return { status: 500, message: 'An unexpected error occurred. Please try again.' };
}

const billingRateLimits = {
  plans: { max: 100, timeWindow: '1 minute' },
  subscription: { max: 30, timeWindow: '1 minute' },
  checkout: { max: 5, timeWindow: '1 minute' },
  portal: { max: 10, timeWindow: '1 minute' },
  invoices: { max: 30, timeWindow: '1 minute' },
  webhooks: { max: 100, timeWindow: '1 minute' },
};

// Public billing routes (register with '/billing' prefix)
export async function billingPublicRoutes(fastify: FastifyInstance) {
  // List all plans with prices
  fastify.get<{ Reply: PlansResponse }>(
    '/plans',
    { config: { rateLimit: billingRateLimits.plans } },
    async (_request, reply) => {
      const { data: plans, error: plansError } = await supabase
        .from('plans')
        .select('*')
        .order('sort_order');

      if (plansError) {
        fastify.log.error(plansError);
        return sendError(reply, 500, 'Failed to fetch plans');
      }

      const { data: prices, error: pricesError } = await supabase
        .from('plan_prices')
        .select('*')
        .eq('active', true);

      if (pricesError) {
        fastify.log.error(pricesError);
        return sendError(reply, 500, 'Failed to fetch prices');
      }

      const plansWithPrices: PlanWithPrices[] = plans.map((plan) => ({
        ...plan,
        prices: prices.filter((price) => price.plan_id === plan.id),
      }));

      return { plans: plansWithPrices };
    }
  );

  // Webhook endpoint in isolated scope with raw body parsing
  // Using register() creates encapsulated scope so content parser doesn't affect other routes
  await fastify.register(async (webhookScope) => {
    // Parse JSON as buffer for signature verification
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      }
    );

    webhookScope.post(
      '/webhooks',
      { config: { rateLimit: billingRateLimits.webhooks } },
      async (request, reply) => {
        const signature = request.headers['stripe-signature'] as string;
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!signature || !webhookSecret) {
          return sendError(reply, 400, 'Missing signature or webhook secret');
        }

        const rawBody = request.body as Buffer;

        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
        } catch (err) {
          webhookScope.log.error(err, 'Webhook signature verification failed');
          return sendError(reply, 400, 'Invalid signature');
        }

        // Check idempotency
        const { data: existing } = await supabase
          .from('payment_events')
          .select('id')
          .eq('stripe_event_id', event.id)
          .single();

        if (existing) {
          return reply.status(200).send({ received: true });
        }

        // Return 200 immediately, process async
        reply.status(200).send({ received: true });

        processWebhookEvent(event, webhookScope).catch((err) => {
          webhookScope.log.error({ err, eventId: event.id }, 'Webhook processing failed');
        });
      }
    );
  });
}

// Team billing routes (register with '/teams' prefix)
export async function billingTeamRoutes(fastify: FastifyInstance) {
  // Get subscription status
  fastify.get<{ Params: { id: string }; Reply: SubscriptionResponse }>(
    '/:id/billing/subscription',
    {
      preHandler: [requireAuth, requireTeamMember],
      config: { rateLimit: billingRateLimits.subscription },
    },
    async (request, reply) => {
      const { id: teamId } = request.params;

      const { data: subscription, error: subError } = await supabase
        .from('subscriptions')
        .select(`
          *,
          plan:plans (*)
        `)
        .eq('team_id', teamId)
        .single();

      if (subError && subError.code !== 'PGRST116') {
        fastify.log.error(subError);
        return sendError(reply, 500, 'Failed to fetch subscription');
      }

      // Get member count for usage
      const { count, error: countError } = await supabase
        .from('team_members')
        .select('*', { count: 'exact', head: true })
        .eq('team_id', teamId);

      if (countError) {
        fastify.log.error(countError);
        return sendError(reply, 500, 'Failed to fetch usage');
      }

      const maxUsers = subscription?.plan?.max_users ?? 5;

      return {
        subscription: subscription ?? null,
        usage: {
          current_users: count ?? 0,
          max_users: maxUsers,
        },
      };
    }
  );

  // Create checkout session
  fastify.post<{
    Params: { id: string };
    Body: CreateCheckoutRequest;
    Reply: CreateCheckoutResponse;
  }>(
    '/:id/billing/checkout',
    {
      preHandler: [requireAuth, requireTeamOwner],
      config: { rateLimit: billingRateLimits.checkout },
    },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const { price_id: priceId } = request.body;

      // Validate price_id is provided
      if (!priceId || typeof priceId !== 'string') {
        return sendError(reply, 400, 'Price ID is required');
      }

      // Validate price exists in our database
      const { data: price, error: priceError } = await supabase
        .from('plan_prices')
        .select('stripe_price_id, plan:plans(name)')
        .eq('stripe_price_id', priceId)
        .eq('active', true)
        .single();

      if (priceError || !price) {
        return sendError(reply, 400, 'Invalid price');
      }

      // Get or create Stripe customer
      const customerResult = await getOrCreateStripeCustomer(teamId, fastify.log);
      if (!customerResult.success) {
        return sendError(reply, customerResult.status, customerResult.error);
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

      try {
        const session = await stripe.checkout.sessions.create({
          customer: customerResult.customerId,
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { team_id: teamId },
          subscription_data: {
            trial_period_days: 14,
            metadata: { team_id: teamId },
          },
          success_url: `${dashboardUrl}/settings?tab=billing&success=true`,
          cancel_url: `${dashboardUrl}/settings?tab=billing&canceled=true`,
          // Automatic tax requires customer address - collect during checkout and save to customer
          automatic_tax: { enabled: true },
          customer_update: {
            address: 'auto',
            name: 'auto',
          },
        });

        if (!session.url) {
          fastify.log.error({ sessionId: session.id }, 'Checkout session created without URL');
          return sendError(reply, 500, 'Failed to create checkout session');
        }

        return { checkout_url: session.url };
      } catch (error) {
        const { status, message } = handleStripeError(error, fastify.log, 'checkout.create');
        return sendError(reply, status, message);
      }
    }
  );

  // Create customer portal session
  fastify.post<{ Params: { id: string }; Reply: CreatePortalResponse }>(
    '/:id/billing/portal',
    {
      preHandler: [requireAuth, requireTeamOwner],
      config: { rateLimit: billingRateLimits.portal },
    },
    async (request, reply) => {
      const { id: teamId } = request.params;

      const { data: subscription, error: subError } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('team_id', teamId)
        .single();

      if (subError && subError.code !== 'PGRST116') {
        fastify.log.error(subError, 'Failed to fetch subscription for portal');
        return sendError(reply, 500, 'Failed to load subscription');
      }

      if (!subscription?.stripe_customer_id) {
        return sendError(reply, 400, 'No billing account found. Please subscribe to a plan first.');
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: subscription.stripe_customer_id,
          return_url: `${dashboardUrl}/settings?tab=billing`,
        });

        return { portal_url: session.url };
      } catch (error) {
        const { status, message } = handleStripeError(error, fastify.log, 'portal.create');
        return sendError(reply, status, message);
      }
    }
  );

  // List invoices
  fastify.get<{ Params: { id: string }; Reply: InvoicesResponse }>(
    '/:id/billing/invoices',
    {
      preHandler: [requireAuth, requireTeamOwner],
      config: { rateLimit: billingRateLimits.invoices },
    },
    async (request, reply) => {
      const { id: teamId } = request.params;

      const { data: subscription, error: subError } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('team_id', teamId)
        .single();

      if (subError && subError.code !== 'PGRST116') {
        fastify.log.error(subError, 'Failed to fetch subscription for invoices');
        return sendError(reply, 500, 'Failed to load billing information');
      }

      if (!subscription?.stripe_customer_id) {
        return { invoices: [], has_more: false };
      }

      try {
        const invoices = await stripe.invoices.list({
          customer: subscription.stripe_customer_id,
          limit: 12,
        });

        return {
          invoices: invoices.data.map((inv) => ({
            id: inv.id,
            amount_paid: inv.amount_paid,
            currency: inv.currency,
            status: inv.status ?? 'unknown',
            created: new Date(inv.created * 1000).toISOString(),
            invoice_pdf: inv.invoice_pdf ?? null,
            hosted_invoice_url: inv.hosted_invoice_url ?? null,
          })),
          has_more: invoices.has_more,
        };
      } catch (error) {
        const { status, message } = handleStripeError(error, fastify.log, 'invoices.list');
        return sendError(reply, status, message);
      }
    }
  );
}

type CustomerResult =
  | { success: true; customerId: string }
  | { success: false; status: number; error: string };

async function getOrCreateStripeCustomer(
  teamId: string,
  logger: { error: (obj: unknown, msg: string) => void }
): Promise<CustomerResult> {
  // Check if customer already exists
  const { data: subscription, error: subError } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('team_id', teamId)
    .single();

  if (subError && subError.code !== 'PGRST116') {
    logger.error(subError, 'Failed to check existing subscription');
    return { success: false, status: 500, error: 'Failed to check billing status' };
  }

  if (subscription?.stripe_customer_id) {
    return { success: true, customerId: subscription.stripe_customer_id };
  }

  // Get team and owner info
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('name, owner_id')
    .eq('id', teamId)
    .single();

  if (teamError || !team) {
    logger.error(teamError ?? { teamId }, 'Team not found');
    return { success: false, status: 404, error: 'Team not found' };
  }

  const { data: owner, error: ownerError } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', team.owner_id)
    .single();

  if (ownerError || !owner) {
    logger.error(ownerError ?? { ownerId: team.owner_id }, 'Team owner not found');
    return { success: false, status: 404, error: 'Team owner not found' };
  }

  // Create Stripe customer
  let customer: Stripe.Customer;
  try {
    customer = await stripe.customers.create({
      email: owner.email,
      name: team.name,
      metadata: { team_id: teamId },
    });
  } catch (error) {
    const { status, message } = handleStripeError(error, logger, 'customers.create');
    return { success: false, status, error: message };
  }

  // Get free plan for initial subscription record
  const { data: freePlan } = await supabase
    .from('plans')
    .select('id')
    .eq('name', 'free')
    .single();

  // Create subscription record linking team to Stripe customer
  const { error: insertError } = await supabase.from('subscriptions').insert({
    team_id: teamId,
    stripe_customer_id: customer.id,
    plan_id: freePlan?.id,
    status: 'active',
  });

  if (insertError) {
    logger.error(insertError, 'Failed to create subscription record');
    // Customer was created in Stripe but we failed to save locally
    // This is a partial failure - customer exists but isn't linked
    return { success: false, status: 500, error: 'Failed to initialize billing' };
  }

  return { success: true, customerId: customer.id };
}

// Webhook event handlers
async function processWebhookEvent(event: Stripe.Event, fastify: FastifyInstance) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event);
      break;
    case 'invoice.created':
      await handleInvoiceCreated(event);
      break;
    case 'invoice.paid':
      await logPaymentEvent(event);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailed(event);
      break;
    case 'customer.subscription.trial_will_end':
      await logPaymentEvent(event);
      break;
    default:
      fastify.log.info({ type: event.type }, 'Unhandled webhook event');
  }
}

async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const teamId = session.metadata?.team_id;
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  if (!teamId) {
    throw new Error('Missing team_id in session metadata');
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0].price.id;

  const { data: planPrice } = await supabase
    .from('plan_prices')
    .select('plan_id')
    .eq('stripe_price_id', priceId)
    .single();

  if (!planPrice) {
    throw new Error(`Plan price not found for ${priceId}`);
  }

  const { error: upsertError } = await supabase.from('subscriptions').upsert(
    {
      team_id: teamId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan_id: planPrice.plan_id,
      status: subscription.status,
      billing_interval: subscription.items.data[0].price.recurring?.interval,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      trial_end: subscription.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
    },
    { onConflict: 'team_id' }
  );

  if (upsertError) {
    throw upsertError;
  }

  await logPaymentEvent(event, teamId);
}

async function handleSubscriptionUpdated(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const previousAttributes = (event.data as { previous_attributes?: Record<string, unknown> })
    .previous_attributes;

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, team_id')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (!sub) return;

  const updates: Record<string, unknown> = {
    status: subscription.status,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
  };

  // Check if plan changed
  if (previousAttributes?.items) {
    const newPriceId = subscription.items.data[0].price.id;
    const { data: planPrice } = await supabase
      .from('plan_prices')
      .select('plan_id')
      .eq('stripe_price_id', newPriceId)
      .single();

    if (planPrice) {
      updates.plan_id = planPrice.plan_id;
      updates.billing_interval = subscription.items.data[0].price.recurring?.interval;
    }
  }

  await supabase.from('subscriptions').update(updates).eq('id', sub.id);
  await logPaymentEvent(event, sub.team_id);
}

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, team_id')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  if (!sub) return;

  const { data: freePlan } = await supabase.from('plans').select('id').eq('name', 'free').single();

  await supabase
    .from('subscriptions')
    .update({
      plan_id: freePlan?.id,
      status: 'canceled',
      stripe_subscription_id: null,
      billing_interval: null,
      current_period_start: null,
      current_period_end: null,
    })
    .eq('id', sub.id);

  await logPaymentEvent(event, sub.team_id);
}

async function handlePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = invoice.subscription as string;

  if (!subscriptionId) return;

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, team_id')
    .eq('stripe_subscription_id', subscriptionId)
    .single();

  if (!sub) return;

  await supabase.from('subscriptions').update({ status: 'past_due' }).eq('id', sub.id);
  await logPaymentEvent(event, sub.team_id);
}

async function handleInvoiceCreated(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = invoice.subscription as string;

  if (!subscriptionId) return;

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('team_id, plan:plans(injection_limit_per_seat, overage_rate_cents)')
    .eq('stripe_subscription_id', subscriptionId)
    .single();

  if (!sub) return;

  const teamId = sub.team_id;
  const plan = sub.plan as unknown as { injection_limit_per_seat: number; overage_rate_cents: number } | null;

  const periodStart = new Date(invoice.period_start * 1000);
  const previousPeriodStart = new Date(periodStart.getFullYear(), periodStart.getMonth() - 1, 1);

  const { data: usagePeriod } = await supabase
    .from('team_usage_periods')
    .select('id, injection_count')
    .eq('team_id', teamId)
    .eq('period_start', previousPeriodStart.toISOString())
    .single();

  if (!usagePeriod) return;

  const { count: memberCount } = await supabase
    .from('team_members')
    .select('*', { count: 'exact', head: true })
    .eq('team_id', teamId);

  const limitPerSeat = plan?.injection_limit_per_seat ?? 150;
  const quota = (memberCount || 1) * limitPerSeat;
  const overage = Math.max(0, usagePeriod.injection_count - quota);

  if (overage === 0) return;

  const rateCents = plan?.overage_rate_cents ?? 2;
  const amountCents = overage * rateCents;

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('team_id', teamId)
    .single();

  if (!subscription?.stripe_customer_id) return;

  const invoiceItem = await stripe.invoiceItems.create({
    customer: subscription.stripe_customer_id,
    invoice: invoice.id,
    amount: amountCents,
    currency: 'usd',
    description: `Injection overage: ${overage} × $${(rateCents / 100).toFixed(2)}`,
  });

  await supabase.from('overage_charges').insert({
    team_id: teamId,
    usage_period_id: usagePeriod.id,
    injection_count: usagePeriod.injection_count,
    quota,
    overage,
    rate_cents: rateCents,
    amount_cents: amountCents,
    stripe_invoice_item_id: invoiceItem.id,
    stripe_invoice_id: invoice.id,
    status: 'invoiced',
    processed_at: new Date().toISOString(),
  });

  await logPaymentEvent(event, teamId);
}

async function logPaymentEvent(event: Stripe.Event, teamId?: string) {
  // Extract team_id from event if not provided
  let resolvedTeamId = teamId;
  if (!resolvedTeamId) {
    const obj = event.data.object as { metadata?: { team_id?: string } };
    resolvedTeamId = obj.metadata?.team_id;
  }

  await supabase.from('payment_events').insert({
    stripe_event_id: event.id,
    event_type: event.type,
    team_id: resolvedTeamId,
    payload: JSON.parse(JSON.stringify(event.data.object)),
  });
}
