import type { ReactNode } from "react";

interface AuthShellProps {
  children: ReactNode;
}

function Star({ className }: { className: string }) {
  return (
    <svg className={`eaos-login-star ${className}`} viewBox="0 0 40 40">
      <path d="M20 2 L23 17 L38 20 L23 23 L20 38 L17 23 L2 20 L17 17 Z" />
    </svg>
  );
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="eaos-login-wrap">
      <section className="eaos-login-left">
        <div className="eaos-login-deco">
          <div className="eaos-login-grid" />
          <div className="eaos-login-orb" />
          <div className="eaos-login-ring eaos-login-ring-a" />
          <div className="eaos-login-ring eaos-login-ring-b" />
          <Star className="eaos-login-star-1" />
          <Star className="eaos-login-star-2" />
          <Star className="eaos-login-star-3" />
          <span className="eaos-login-particle eaos-login-particle-1" />
          <span className="eaos-login-particle eaos-login-particle-2" />
          <span className="eaos-login-particle eaos-login-particle-3" />
        </div>

        <div className="eaos-login-brand">
          <span className="eaos-login-brand-icon">◆</span>
          <span className="eaos-login-brand-word">EAOS</span>
        </div>

        <div className="eaos-login-hero">
          <h1>
            回来啦，
            <br />
            一起把活干漂亮。
          </h1>
          <p>
            EAOS 是企业级 Agent 平台——组织级治理、运行时隔离、全链路可观测，一次建设，全局复用。
          </p>
        </div>

        <div className="eaos-login-chip">
          <span className="eaos-login-dot" />
          <span>平台在线 · 随时待命</span>
        </div>
      </section>

      <section className="eaos-login-right">
        <div className="eaos-login-card">{children}</div>
      </section>
    </div>
  );
}
