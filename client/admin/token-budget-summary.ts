export interface TokenBudgetOrganization {
  maxTokensMonthly?: number;
  tokenStatus?: "normal" | "near" | "over";
  usage?: { tokensMonthly?: { total?: number } };
}

export function summarizeTokenBudgets(orgs: TokenBudgetOrganization[]) {
  const budget = orgs.reduce((sum, org) => sum + Math.max(0, Number(org.maxTokensMonthly) || 0), 0);
  const consumed = orgs.reduce((sum, org) => sum + Math.max(0, Number(org.usage?.tokensMonthly?.total) || 0), 0);
  return {
    budget,
    consumed,
    remaining: Math.max(0, budget - consumed),
    near: orgs.filter((org) => org.tokenStatus === "near").length,
    over: orgs.filter((org) => org.tokenStatus === "over").length,
    organizations: orgs.length,
  };
}
