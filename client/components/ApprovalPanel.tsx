interface ApprovalRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  chatId: string;
}

interface ApprovalPanelProps {
  requests: ApprovalRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string, message?: string) => void;
}

export function ApprovalPanel({ requests, onApprove, onDeny }: ApprovalPanelProps) {
  if (requests.length === 0) return null;

  return (
    <div className="border-t border-yellow-500 bg-yellow-50 p-3 space-y-3">
      <div className="flex items-center gap-2 text-yellow-800 text-sm font-medium">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        Agent 请求执行操作 ({requests.length} 项待审批)
      </div>

      {requests.map((req) => (
        <div key={req.id} className="bg-white rounded-lg border border-yellow-200 p-3 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-sm font-semibold text-gray-800">
              {req.toolName}
            </span>
          </div>

          <div className="bg-gray-50 rounded p-2 mb-3 max-h-32 overflow-y-auto">
            <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all">
              {JSON.stringify(req.toolInput, null, 2)}
            </pre>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => onApprove(req.id)}
              className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
            >
              允许执行
            </button>
            <button
              onClick={() => onDeny(req.id)}
              className="px-3 py-1.5 bg-red-500 text-white text-sm rounded hover:bg-red-600 transition-colors"
            >
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
