/**
 * hub-navigation.ts — R5c controlled Skill Hub navigation.
 *
 * 铁律: the platform NEVER sends a service token, the platform orgId, or the
 * user's role to the browser. The browser navigates to the Hub base URL and
 * authenticates via the Hub's OWN session (separate auth domain). The Hub
 * determines what the user can see/do based on its own session/permissions.
 *
 * Round-3 (codex #3): the response carries ONLY the R5b-verified Hub base URL
 * for every role. The previously-guessed `/ns/<namespace>` deep-link is NOT
 * R5b-verified-live, so it is removed — R5c prohibits guessing routes. When a
 * namespace deep-link is R5b-verified, it can be added here with exact
 * evidence. No token, no orgId, no role is ever in the response body or URL.
 *
 * If the Hub base URL is unconfigured, the route 503s (controlled — never
 * hand the browser a guessed URL).
 */
import type { RequestContext } from "./request-context.js";

export interface HubLaunchResponse {
  url: string;
}

export interface HubLaunchOptions {
  hubBaseUrl: string;
}

export function buildHubLaunchResponse(_ctx: RequestContext, opts: HubLaunchOptions): HubLaunchResponse {
  const base = (opts.hubBaseUrl ?? "").trim();
  if (!base) throw new Error("hub base URL not configured");
  // Every role gets ONLY the verified Hub base URL. The browser authenticates
  // to the Hub via the Hub's own session; the Hub scopes what the user sees.
  // No deep-link / namespace slug is sent (the /ns/<slug> route is NOT
  // R5b-verified-live — guessing it is prohibited by R5c).
  return { url: base };
}
