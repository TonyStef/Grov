/**
 * Usage and injection metering types
 * Aligns with Supabase injection_events, team_usage_periods, overage_charges tables
 */

// Usage status thresholds
export type UsageStatus = 'normal' | 'warning_80' | 'warning_100' | 'overage';

// Injection type
export type InjectionType = 'preview' | 'expand';

// POST /usage/injection request body
export interface RecordInjectionRequest {
  team_id: string;
  user_id: string;
  session_id: string;
  event_id: string;
  injection_type: InjectionType;
  memory_ids: string[];
  timestamp: string;
}

// POST /usage/injection response
export interface RecordInjectionResponse {
  success: boolean;
  current_count: number;
  quota: number;
  status: UsageStatus;
}

// GET /teams/:id/usage response
export interface TeamUsageResponse {
  period: {
    start: string;
    end: string;
  };
  injections: {
    used: number;
    quota: number;
    overage: number;
    percent: number;
  };
  seats: {
    count: number;
    limit_per_seat: number;
  };
  billing: {
    overage_rate_cents: number;
    estimated_overage_cost: number;
  };
  status: UsageStatus;
}

// GET /teams/:id/usage/history query params
export interface UsageHistoryParams {
  periods?: number;
}

// GET /teams/:id/usage/history response
export interface UsageHistoryResponse {
  periods: UsagePeriodSummary[];
}

export interface UsagePeriodSummary {
  start: string;
  end: string;
  injection_count: number;
  quota: number;
  overage: number;
  overage_cost_cents: number;
}

// GET /teams/:id/usage/breakdown response
export interface UsageBreakdownResponse {
  period: {
    start: string;
    end: string;
  };
  by_user: UserUsage[];
  by_day: DailyUsage[];
}

export interface UserUsage {
  user_id: string;
  email: string;
  injection_count: number;
  percent_of_team: number;
}

export interface DailyUsage {
  date: string;
  injection_count: number;
}

// Overage charge status
export type OverageChargeStatus = 'pending' | 'invoiced' | 'paid' | 'failed' | 'waived';

// Overage charge record
export interface OverageCharge {
  id: string;
  team_id: string;
  usage_period_id: string;
  injection_count: number;
  quota: number;
  overage: number;
  rate_cents: number;
  amount_cents: number;
  stripe_invoice_item_id: string | null;
  stripe_invoice_id: string | null;
  status: OverageChargeStatus;
  created_at: string;
  processed_at: string | null;
}
