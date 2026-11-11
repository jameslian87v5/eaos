import { v4 as uuidv4 } from "uuid";

export interface ApprovalRequest {
  id: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  timestamp: string;
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
  message?: string;
  alwaysAllow?: boolean;
}

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  timer: NodeJS.Timeout | null;
};

// Agent OS M2: a real bounded timeout so a pending approval can never hang the
// runtime indefinitely. Read per-call so deployments/tests can tune it without
// restarting the process. Parsing (codex r2 #4) follows the documented
// contract exactly: unset/empty/invalid/non-finite/negative → default (10 min,
// a safety bound far longer than any normal human approval); 0 → disabled
// (legacy unbounded behaviour); positive integer → that many milliseconds.
// Exported for direct contract testing.
export function resolveApprovalTimeoutMs(): number {
  const DEFAULT = 600000;
  const raw = process.env.APPROVAL_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT; // invalid (NaN/non-numeric) → default
  if (n === 0) return 0; // explicitly disabled
  if (n < 0) return DEFAULT; // negative is nonsensical → default, not a timeout
  return n;
}

// Manages pending approval requests per chat session
export class ApprovalManager {
  private pending: Map<string, PendingApproval> = new Map();
  private onApprovalRequest: ((request: ApprovalRequest) => void) | null = null;

  // Set callback to notify frontend of new approval requests
  setApprovalRequestHandler(handler: (request: ApprovalRequest) => void) {
    this.onApprovalRequest = handler;
  }

  // Called by ai-client's canUseTool callback
  // Returns a Promise that resolves when user responds OR the bounded timeout
  // expires (denied with message "Approval timed out").
  async requestApproval(
    chatId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string
  ): Promise<ApprovalResponse> {
    const request: ApprovalRequest = {
      id: uuidv4(),
      chatId,
      toolName,
      toolInput,
      toolUseId,
      timestamp: new Date().toISOString(),
    };

    return new Promise<ApprovalResponse>((resolve) => {
      // Agent OS M2: bounded timeout — auto-deny on expiry so the runtime never
      // blocks forever on a dropped/stale approval request.
      const timeoutMs = resolveApprovalTimeoutMs();
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.has(request.id)) {
                this.pending.delete(request.id);
                resolve({ id: request.id, approved: false, message: "Approval timed out" });
              }
            }, timeoutMs)
          : null;
      this.pending.set(request.id, { request, resolve, timer });

      // Notify frontend
      if (this.onApprovalRequest) {
        this.onApprovalRequest(request);
      }
    });
  }

  // Called when user responds via WebSocket
  handleResponse(response: ApprovalResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return false;
    }
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(response);
    this.pending.delete(response.id);
    return true;
  }

  // Get all pending approvals for a chat
  getPending(chatId: string): ApprovalRequest[] {
    return Array.from(this.pending.values())
      .filter((p) => p.request.chatId === chatId)
      .map((p) => p.request);
  }

  // Cancel all pending approvals (e.g., on session close)
  cancelAll(chatId: string) {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.request.chatId === chatId) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve({ id, approved: false, message: "Session closed" });
        this.pending.delete(id);
      }
    }
  }
}
