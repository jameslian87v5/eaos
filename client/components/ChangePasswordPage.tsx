import { useState } from "react";

interface ChangePasswordPageProps {
  onSuccess: () => void;
  onLogout: () => void;
}

// P0-1: forced first-login password change. Shown when login returns
// mustChangePassword, or a protected request / WS gets MUST_CHANGE_PASSWORD /
// close(4003). On success the parent clears the must-change state and reconnects.
export function ChangePasswordPage({ onSuccess, onLogout }: ChangePasswordPageProps) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!oldPassword.trim() || !newPassword.trim() || !confirmPassword.trim()) {
      setError("请填写所有字段");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setIsLoading(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "改密失败");
        return;
      }
      onSuccess();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setIsLoading(false);
    }
  };

  const inputCls =
    "w-full h-11 px-3 border border-line-subtle rounded-lg text-ink-primary bg-white " +
    "focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors";

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-page p-4">
      <div className="w-full max-w-3xl grid grid-cols-1 md:grid-cols-2 bg-surface-panel rounded-2xl shadow-xl overflow-hidden">
        {/* 品牌区（桌面） */}
        <div className="hidden md:flex flex-col items-center justify-center bg-brand-soft p-10 gap-5">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-brand brand-title">EAOS</h1>
            <p className="mt-1 text-sm text-ink-secondary brand-subtitle">Enterprise Agent OS · 企业级 Agent 平台</p>
          </div>
        </div>

        {/* 表单区 */}
        <div className="p-8 md:p-10">
          <div className="md:hidden flex flex-col items-center mb-6 gap-2">
            <h1 className="text-xl font-semibold text-brand brand-title">EAOS</h1>
          </div>

          <h2 className="text-lg font-semibold text-ink-primary mb-1 hidden md:block">
            修改密码
          </h2>
          <p className="text-sm text-ink-secondary mb-6 hidden md:block">
            首次登录后需要修改默认密码
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink-primary mb-1.5">旧密码</label>
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className={inputCls}
                placeholder="输入当前密码"
                autoComplete="current-password"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-primary mb-1.5">新密码</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputCls}
                placeholder="至少 8 位，含字母和数字"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-primary mb-1.5">确认新密码</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputCls}
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
            </div>

            {error && (
              <div className="bg-danger-soft border border-danger-border text-danger-fg text-sm rounded-md px-3 py-2.5">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full h-11 bg-brand hover:bg-brand-hover text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? "提交中…" : "修改密码"}
            </button>
          </form>

          <div className="mt-5 text-center">
            <button
              onClick={onLogout}
              className="text-sm text-ink-secondary hover:text-brand transition-colors"
            >
              退出登录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
