import { describe, expect, it } from "vitest";
import { formatMoney, formatPercent, sumMoney } from "../src/money";

describe("money", () => {
  it("formats minor units without float drift", () => {
    expect(formatMoney({ minor: 18400, currency: "USD" })).toBe("$184");
    expect(formatMoney({ minor: 1850, currency: "USD" })).toBe("$18.50");
    expect(formatMoney({ minor: 18400, currency: "USD" }, { signed: true })).toBe("+$184");
    expect(formatMoney({ minor: -500, currency: "USD" })).toBe("−$5");
  });

  it("renders null percentages as an em dash, never as 0%", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0.574)).toBe("57%");
  });

  it("sums money in minor units and refuses mixed currencies", () => {
    expect(sumMoney([{ minor: 100, currency: "USD" }, { minor: 250, currency: "USD" }])).toEqual({
      minor: 350,
      currency: "USD"
    });
    expect(sumMoney([{ minor: 100, currency: "USD" }, { minor: 100, currency: "EUR" }]).minor).toBeNaN();
  });
});
