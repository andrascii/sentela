import { randomUUID } from "node:crypto";

// Minimal YooKassa (ЮKassa) client. Cards are entered on YooKassa's hosted page —
// we never see or store them. For recurring we keep only the saved payment-method id.
const API = "https://api.yookassa.ru/v3";

export function yookassaConfigured(): boolean {
  return Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}

function authHeader(): string {
  const id = process.env.YOOKASSA_SHOP_ID || "";
  const key = process.env.YOOKASSA_SECRET_KEY || "";
  return "Basic " + Buffer.from(`${id}:${key}`).toString("base64");
}

export interface YkPayment {
  id: string;
  status: string; // pending | waiting_for_capture | succeeded | canceled
  paid: boolean;
  confirmationUrl: string | null;
  paymentMethodId: string | null; // saved method id (for recurring)
  metadata: Record<string, string>;
}

interface CreatePaymentInput {
  amountRub: number;
  description: string;
  metadata: Record<string, string>;
  returnUrl?: string; // for the redirect (first, on-session) payment
  savePaymentMethod?: boolean; // ask to remember the card for recurring
  paymentMethodId?: string; // recurring off-session charge
}

function normalize(p: {
  id: string;
  status: string;
  paid?: boolean;
  confirmation?: { confirmation_url?: string };
  payment_method?: { id?: string; saved?: boolean };
  metadata?: Record<string, string>;
}): YkPayment {
  return {
    id: p.id,
    status: p.status,
    paid: Boolean(p.paid),
    confirmationUrl: p.confirmation?.confirmation_url ?? null,
    paymentMethodId: p.payment_method?.saved ? p.payment_method.id ?? null : null,
    metadata: p.metadata ?? {},
  };
}

export async function createPayment(input: CreatePaymentInput): Promise<YkPayment> {
  const body: Record<string, unknown> = {
    amount: { value: input.amountRub.toFixed(2), currency: "RUB" },
    capture: true,
    description: input.description.slice(0, 128),
    metadata: input.metadata,
  };
  if (input.paymentMethodId) {
    // Recurring (off-session): charge the saved method, no user redirect.
    body.payment_method_id = input.paymentMethodId;
  } else {
    body.confirmation = { type: "redirect", return_url: input.returnUrl };
    if (input.savePaymentMethod) body.save_payment_method = true;
  }

  const res = await fetch(`${API}/payments`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Idempotence-Key": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`YooKassa create ${res.status}: ${t.slice(0, 300)}`);
  }
  return normalize(await res.json());
}

/** Re-fetch a payment to verify its real status (used by the webhook). */
export async function getPayment(id: string): Promise<YkPayment> {
  const res = await fetch(`${API}/payments/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`YooKassa get ${res.status}`);
  return normalize(await res.json());
}
