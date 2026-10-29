import { expect, it } from "vitest";
import { formatBillingPrice } from "./billing";

it.each([
  [
    { amount: 1200, currency: "usd", interval: "month" as const, intervalCount: 1 },
    "en-US",
    "$12.00 / 1 month",
  ],
  [
    { amount: 1200, currency: "jpy", interval: "year" as const, intervalCount: 2 },
    "en-US",
    "¥1,200 / 2 years",
  ],
  [
    { amount: 1250, currency: "kwd", interval: "day" as const, intervalCount: 3 },
    "en-US",
    "KWD 1.250 / 3 days",
  ],
])("preserves the provider price and interval", (price, locale, expected) => {
  expect(formatBillingPrice(price, locale)).toBe(expected);
});
it("returns unavailable for malformed currency instead of inventing an amount", () => {
  expect(
    formatBillingPrice(
      { amount: 1200, currency: "invalid", interval: "month", intervalCount: 1 },
      "en-US",
    ),
  ).toBeNull();
});
