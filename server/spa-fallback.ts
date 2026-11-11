import path from "node:path";
import type { Request, Response, NextFunction } from "express";

// Integrated-walkthrough P2: late SPA catch-all for browser routes. Any
// extension-less GET that no earlier route claimed serves the SPA shell —
// the client router redirects unknown paths to "/" (client/App.tsx).
// Non-HTML namespaces keep their previous fall-through-to-404 behavior:
// /api, /ws, /assets, /embed, /health, /client, and any path that looks
// like a static file (has an extension).
const NON_SPA_PREFIXES = ["/api", "/ws", "/assets", "/embed", "/health", "/client"];

export function shouldServeSpa(pathname: string): boolean {
  if (NON_SPA_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return false;
  return path.extname(pathname) === "";
}

export function createSpaCatchAll(serveIndex: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!shouldServeSpa(req.path)) return next();
    serveIndex(req, res);
  };
}
