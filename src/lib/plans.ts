export type PlanId = "starter" | "pro" | "business";

export interface Plan {
  id: PlanId;
  name: string;
  priceRub: number;
  /** Monitor cap for the plan. */
  maxMonitors: number;
  /** Smallest allowed check interval, in seconds. */
  minIntervalSeconds: number;
  /** Days of check history retained. */
  historyDays: number;
  features: string[];
  highlight?: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceRub: 299,
    maxMonitors: 10,
    minIntervalSeconds: 300,
    historyDays: 7,
    features: [
      "10 мониторов",
      "Интервал проверки 5 мин",
      "Оповещения в Telegram",
      "История 7 дней",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceRub: 799,
    maxMonitors: 50,
    minIntervalSeconds: 60,
    historyDays: 30,
    highlight: true,
    features: [
      "50 мониторов",
      "Интервал проверки 1 мин",
      "Проверки SSL / DNS",
      "История 30 дней",
      "Региональные проверки",
    ],
  },
  business: {
    id: "business",
    name: "Business",
    priceRub: 1990,
    maxMonitors: 200,
    minIntervalSeconds: 60,
    historyDays: 90,
    features: [
      "200 мониторов",
      "Мониторинг API",
      "Несколько регионов",
      "Командный доступ",
      "История 90 дней",
    ],
  },
};

export const PLAN_LIST: Plan[] = [PLANS.starter, PLANS.pro, PLANS.business];

export function getPlan(id: string | null | undefined): Plan {
  if (id && id in PLANS) return PLANS[id as PlanId];
  return PLANS.starter;
}
