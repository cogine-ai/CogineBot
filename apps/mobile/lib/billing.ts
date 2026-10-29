import type { BillingStatus } from "@rakazo/contracts";

type Price = NonNullable<BillingStatus["price"]>;

/** Format the provider's minor units without guessing a missing price or currency. */
export function formatBillingPrice(price: Price, locale: string): string | null {
  try {
    const currency = new Intl.NumberFormat(locale, { style: "currency", currency: price.currency });
    const digits = currency.resolvedOptions().maximumFractionDigits;
    const amount = currency.format(price.amount / 10 ** (digits ?? 2));
    const period = new Intl.NumberFormat(locale, {
      style: "unit",
      unit: price.interval,
      unitDisplay: "long",
    }).format(price.intervalCount);
    return `${amount} / ${period}`;
  } catch {
    return null;
  }
}
