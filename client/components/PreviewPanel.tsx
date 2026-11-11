import { useState, useEffect } from "react";

const API_BASE = "/api";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface PreviewTarget {
  fileId: string;
  filename: string;
}

interface PreviewPanelProps {
  chatId: string;
  target: PreviewTarget;
  onClose: () => void;
}

function getExt(filename: string): string {
  return (filename.split(".").pop() || "").toLowerCase();
}

export function PreviewPanel({ chatId, target, onClose }: PreviewPanelProps) {
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ext = getExt(target.filename);
  const isHtml = ext === "html" || ext === "htm";
  const isPdf = ext === "pdf";

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setHtmlContent(null);
      setBlobUrl(null);
      try {
        const res = await fetch(
          `${API_BASE}/chats/${chatId}/files/${target.fileId}/download`,
          { headers: authHeaders() }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        if (isHtml) {
          const text = await res.text();
          if (!cancelled) setHtmlContent(text);
        } else {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          revoked = url;
          if (!cancelled) setBlobUrl(url);
        }
      } catch (e) {
        if (!cancelled) setError("加载失败，请重试或下载查看");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [chatId, target.fileId, isHtml]);

  const handleDownload = async () => {
    try {
      const res = await fetch(
        `${API_BASE}/chats/${chatId}/files/${target.fileId}/download`,
        { headers: authHeaders() }
      );
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = target.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  return (
    <div className="w-1/2 max-w-[720px] shrink-0 flex flex-col min-h-0 border-l border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-400">{isHtml ? "🌐" : "📄"}</span>
          <span className="text-sm font-medium text-gray-700 truncate" title={target.filename}>
            {target.filename}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleDownload}
            className="text-xs px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600"
            title="下载"
          >
            下载
          </button>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-lg leading-none px-1"
            title="关闭预览"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden bg-gray-100">
        {loading && (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            加载中…
          </div>
        )}
        {!loading && error && (
          <div className="h-full flex items-center justify-center text-sm text-red-500">
            {error}
          </div>
        )}
        {!loading && !error && isHtml && htmlContent !== null && (
          <iframe
            title={target.filename}
            sandbox="allow-scripts"
            srcDoc={htmlContent}
            className="w-full h-full border-none bg-white"
          />
        )}
        {!loading && !error && isPdf && blobUrl && (
          <iframe
            title={target.filename}
            src={blobUrl}
            className="w-full h-full border-none"
          />
        )}
      </div>
    </div>
  );
}
