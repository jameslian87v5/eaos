import { useState } from "react";
import { AuthShell } from "./AuthShell";

interface LoginPageProps {
  onLogin: (token: string, user: { username: string; role: string }, mustChangePassword?: boolean) => void;
}

function LoginIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;

    setIsLoading(true);
    setError("");

    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "登录失败，请重试");
        return;
      }

      if (isRegister) {
        const loginRes = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const loginData = await loginRes.json();
        if (loginRes.ok) {
          onLogin(loginData.token, loginData.user, loginData.mustChangePassword);
        }
      } else {
        onLogin(data.token, data.user, data.mustChangePassword);
      }
    } catch {
      setError("网络错误，请检查连接后重试");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className="eaos-login-brand-sm">
        <span className="eaos-login-brand-sm-icon">◆</span>
        <span>EAOS</span>
      </div>
      <h2 className="eaos-login-title">{isRegister ? "创建账号" : "欢迎回来"}</h2>

      <form onSubmit={handleSubmit}>
        <div className="eaos-login-field">
          <label className="eaos-login-label">用户名</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="eaos-login-input"
            placeholder="请输入用户名"
            autoComplete="username"
            autoFocus
          />
        </div>

        <div className="eaos-login-field">
          <label className="eaos-login-label">密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="eaos-login-input"
            placeholder="请输入密码"
            autoComplete={isRegister ? "new-password" : "current-password"}
          />
        </div>

        {error && <div className="eaos-login-error">{error}</div>}

        <button
          type="submit"
          disabled={isLoading || !username.trim() || !password.trim()}
          className="eaos-login-btn eaos-login-btn-primary"
        >
          <LoginIcon />
          {isLoading ? "正在验证…" : isRegister ? "注册并登录" : "登录"}
        </button>

        <button
          type="button"
          onClick={() => {
            setIsRegister(!isRegister);
            setError("");
          }}
          className="eaos-login-btn eaos-login-btn-secondary"
        >
          <KeyIcon />
          {isRegister ? "已有账号，返回登录" : "创建一个新账号"}
        </button>
      </form>

      <div className="eaos-login-divider">或</div>
      <div className="eaos-login-foot">
        还没有账号？<a href="#" onClick={(e) => e.preventDefault()}>联系管理员开通</a>
      </div>
    </AuthShell>
  );
}
