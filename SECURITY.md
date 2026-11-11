# Security Policy

## Supported Versions

Only the latest `main` branch receives security fixes.

## Reporting a Vulnerability

Please report vulnerabilities via [GitHub Security Advisories](https://github.com/jameslian87v5/eaos/security/advisories/new) — **do not open public issues for security reports**.

We aim to acknowledge within 3 business days.

## Security Model Summary

EAOS is built fail-closed:

- **Auth**: JWT + bcrypt. The server refuses to boot with the built-in weak JWT secret unless `ALLOW_DEV_JWT_SECRET=1` is explicitly set (local dev only).
- **Container isolation**: each agent session runs in its own Docker container (`eaos-agent-*`); MCP commands inside containers must live under `/opt/agent/mcp/`; path traversal is rejected at multiple layers.
- **Credential custody**: external-system credentials are AES-256-GCM encrypted on the host; agents receive scoped tokens that die with their runtime.
- **Skill supply chain**: imported skill ZIPs are validated (path traversal / size / symlink rejection), quarantined, and disabled by default pending review.
- **Governance guardrails** (deny-by-default, audit logging, strict MCP config) cannot be relaxed by org admins, apps, or hooks.

If you find a bypass of any of the above, we consider it a security bug.
