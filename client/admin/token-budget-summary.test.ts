import assert from "node:assert/strict";
import { summarizeTokenBudgets } from "./token-budget-summary.js";

const summary = summarizeTokenBudgets([
  { maxTokensMonthly: 1000, tokenStatus: "normal", usage: { tokensMonthly: { total: 250 } } },
  { maxTokensMonthly: 500, tokenStatus: "near", usage: { tokensMonthly: { total: 450 } } },
  { maxTokensMonthly: 200, tokenStatus: "over", usage: { tokensMonthly: { total: 250 } } },
  { maxTokensMonthly: 0, tokenStatus: "normal", usage: {} },
]);

assert.deepEqual(summary, {
  budget: 1700,
  consumed: 950,
  remaining: 750,
  near: 1,
  over: 1,
  organizations: 4,
});

console.log("dashboard token budget summary: 1 passed, 0 failed");
