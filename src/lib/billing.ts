import { query } from "./db";
import { getPlan, PLANS, type PlanId } from "./plans";

export const PERIOD_DAYS = 30;

export interface Subscription {
  user_id: number;
  plan: string;
  status: string;
  started_at: string;
  expires_at: string | null;
  auto_renew: boolean;
  payment_method_id: string | null;
  price_rub: number | null;
  canceled_at: string | null;
}

export interface PaymentRow {
  id: number;
  plan: string;
  amount_rub: number;
  status: string;
  kind: string;
  created_at: string;
}

export async function getSubscription(userId: number): Promise<Subscription | null> {
  const { rows } = await query<Subscription>(
    `SELECT user_id, plan, status, started_at, expires_at, auto_renew,
            payment_method_id, price_rub, canceled_at
     FROM subscriptions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** Effective plan honoring expiry: an expired paid plan falls back to Starter. */
export function effectivePlanId(sub: Subscription | null): PlanId {
  if (!sub) return "starter";
  const plan = getPlan(sub.plan).id;
  if (plan === "starter") return "starter";
  if (sub.expires_at && new Date(sub.expires_at).getTime() <= Date.now()) return "starter";
  return plan;
}

/** Activate (or extend) a paid plan. Stacks the period if still active. */
export async function activatePaidPlan(
  userId: number,
  plan: PlanId,
  paymentMethodId: string | null,
  autoRenew: boolean
): Promise<void> {
  await query(
    `UPDATE subscriptions
     SET plan = $2,
         status = 'active',
         expires_at = GREATEST(COALESCE(expires_at, now()), now()) + make_interval(days => $3),
         payment_method_id = COALESCE($4, payment_method_id),
         auto_renew = $5,
         price_rub = $6,
         canceled_at = NULL,
         renew_last_attempt = NULL
     WHERE user_id = $1`,
    [userId, plan, PERIOD_DAYS, paymentMethodId, autoRenew, PLANS[plan].priceRub]
  );
}

/** Disable auto-renew; the plan stays until the current period ends. */
export async function cancelAutoRenew(userId: number): Promise<void> {
  await query(
    "UPDATE subscriptions SET auto_renew = false, canceled_at = now() WHERE user_id = $1",
    [userId]
  );
}

/** Record a payment. Returns true only if newly inserted (idempotency guard). */
export async function recordPayment(
  userId: number,
  providerPaymentId: string,
  plan: string,
  amountRub: number,
  status: string,
  kind: "initial" | "recurring"
): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO payments (user_id, provider_payment_id, plan, amount_rub, status, kind)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider_payment_id) DO NOTHING`,
    [userId, providerPaymentId, plan, amountRub, status, kind]
  );
  return (rowCount ?? 0) > 0;
}

export async function listPayments(userId: number): Promise<PaymentRow[]> {
  const { rows } = await query<PaymentRow>(
    `SELECT id, plan, amount_rub, status, kind, created_at
     FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  return rows;
}

/** Subscriptions whose paid period ends soon and that should auto-renew. */
export async function subscriptionsDueForRenewal(): Promise<
  {
    user_id: number;
    plan: string;
    price_rub: number | null;
    payment_method_id: string;
    email: string;
  }[]
> {
  const { rows } = await query<{
    user_id: number;
    plan: string;
    price_rub: number | null;
    payment_method_id: string;
    email: string;
  }>(
    `SELECT s.user_id, s.plan, s.price_rub, s.payment_method_id, u.email
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.auto_renew = true
       AND s.payment_method_id IS NOT NULL
       AND s.plan <> 'starter'
       AND s.status = 'active'
       AND s.expires_at IS NOT NULL
       AND s.expires_at <= now() + interval '1 day'
       AND (s.renew_last_attempt IS NULL OR s.renew_last_attempt < now() - interval '6 hours')
     LIMIT 50`
  );
  return rows;
}

export async function markRenewAttempt(userId: number): Promise<void> {
  await query("UPDATE subscriptions SET renew_last_attempt = now() WHERE user_id = $1", [
    userId,
  ]);
}
