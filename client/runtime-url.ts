// Task 1 (P0.1): same-origin WebSocket URL for the workbench.
//
// The legacy getWsUrl() hardcoded `ws://<hostname>:3001/ws`, which breaks under
// an HTTPS reverse proxy (mixed content) and bypasses Nginx entirely. The
// production rule is same-origin: the page protocol decides ws/wss and the
// page host (including any non-default port) is reused as-is. In dev, Vite
// already proxies /ws to the backend (vite.config.ts), so the same rule works
// for `http://localhost:5173`.
//
// Token goes through URLSearchParams — never raw concatenation — so JWTs with
// `&`/`=`/space/`+` cannot corrupt the query string.

export interface BrowserLocationLike {
  protocol: string;
  host: string;
}

export function buildWebSocketUrl(location: BrowserLocationLike, token?: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
