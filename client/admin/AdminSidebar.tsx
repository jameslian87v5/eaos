import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Server,
  Settings,
  FileText,
  Database,
  Puzzle,
  Plug,
  ShieldCheck,
  Package,
  Bot,
  UserCircle,
  Users,
  ScrollText,
  Network,
  Code2,
  Boxes,
  Building2,
  FileCheck2,
  PackageCheck,
  Cpu,
  BarChart3,
} from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  // M3: which privileged roles may see this link. Undefined = all privileged
  // roles (admin + org_admin). The /admin shell itself admits admin + org_admin
  // (App.tsx gate); org_admin is scoped to only Orgs + Users (own-dept view).
  roles?: ("admin" | "org_admin")[];
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    title: "总览",
    items: [
      { to: "/admin/overview", label: "Dashboard", icon: LayoutDashboard, roles: ["admin", "org_admin"] },
    ],
  },
  {
    title: "运行时",
    items: [
      { to: "/admin/sessions", label: "Sessions", icon: Server, roles: ["admin"] },
      { to: "/admin/runtime", label: "Settings", icon: Settings, roles: ["admin"] },
      // M1: standalone model management page — platform catalog (admin-only
      // writes) + org model policy (org_admin manages own org). Distinct from
      // Runtime Settings' coarse global default on purpose.
      { to: "/admin/models", label: "模型管理", icon: Cpu, roles: ["admin", "org_admin"] },
      // M3: org-level Token usage dashboard (read-only aggregation, no billing).
      { to: "/admin/token-usage", label: "Token 用量", icon: BarChart3, roles: ["admin", "org_admin"] },
      { to: "/admin/prompt", label: "Prompt", icon: FileText, roles: ["admin"] },
      { to: "/admin/policy", label: "Policy", icon: Network, roles: ["admin"] },
    ],
  },
  {
    title: "能力库",
    items: [
      { to: "/admin/plugins", label: "Plugins", icon: Boxes, roles: ["admin"] },
      // R1: capability consumption + own-org entitlement toggle (global
      // install/import/toggle stays admin-only — those routes gate + audit).
      { to: "/admin/skills", label: "Skills", icon: Puzzle, roles: ["admin", "org_admin"] },
      // M7b: user-submitted skill review queue (admin reviews; org_admin
      // read-only own-org).
      { to: "/admin/user-skills", label: "用户技能审核", icon: PackageCheck, roles: ["admin", "org_admin"] },
      { to: "/admin/mcp", label: "MCP", icon: Plug, roles: ["admin", "org_admin"] },
      { to: "/admin/capabilities", label: "Capabilities", icon: ShieldCheck, roles: ["admin", "org_admin"] },
      { to: "/admin/apis", label: "API 注册", icon: Code2, roles: ["admin"] },
      // M1c: connector instances (admin-only — shared pool writes + secrets).
      { to: "/admin/connectors", label: "Connectors", icon: Plug, roles: ["admin"] },
      // M4: department resource governance — admin reviews + distributes;
      // org_admin submits own-org drafts + sees status.
      { to: "/admin/resource-registrations", label: "资源治理", icon: FileCheck2, roles: ["admin", "org_admin"] },
      // M5: governance audit (governance_audit_log sink — distinct from the
      // /admin/audit agent_events page). org_admin sees own-org only; admin may
      // export + purge. Metadata-only (no body/payload).
      { to: "/admin/governance-audit", label: "治理审计", icon: ScrollText, roles: ["admin", "org_admin"] },
      // R5c: unified Skill Hub management entry (admin + org_admin). Opens the
      // controlled /api/hub/launch URL in a new tab; the browser authenticates
      // to the Hub via its own session. No token/orgId/role is sent to browser.
      { to: "/admin/hub", label: "Skill Hub", icon: Boxes, roles: ["admin", "org_admin"] },
    ],
  },
  {
    title: "应用管理",
    items: [
      // R1: org_admin manages own-org agents/profiles/applications (backend
      // already org-scopes reads + writes via ctxFromReq own-org guard).
      { to: "/admin/applications", label: "Applications", icon: Package, roles: ["admin", "org_admin"] },
      { to: "/admin/agents", label: "Agents", icon: Bot, roles: ["admin", "org_admin"] },
      { to: "/admin/profiles", label: "Profiles", icon: Database, roles: ["admin", "org_admin"] },
    ],
  },
  {
    title: "治理审计",
    items: [
      // M3: org_admin reaches the management shell for own-dept Orgs + Users
      // views only. Audit Log stays admin-only (cross-org).
      // M6b: unified security posture center (six tabs over real governance
      // facts; the only write is editable DB profile toolsConfig).
      { to: "/admin/security", label: "安全防护", icon: ShieldCheck, roles: ["admin", "org_admin"] },
      { to: "/admin/orgs", label: "Orgs", icon: Building2, roles: ["admin", "org_admin"] },
      { to: "/admin/users", label: "Users", icon: Users, roles: ["admin", "org_admin"] },
      { to: "/admin/audit", label: "Audit Log", icon: ScrollText, roles: ["admin"] },
    ],
  },
];

// M3: paths an org_admin may open inside /admin. Used by AdminLayout to
// redirect org_admin away from admin-only pages (deep link / manual URL) to
// their own-dept Users view, so they never land on a page whose API 403s.
export const ORG_ADMIN_ALLOWED_PATHS = ["/admin/overview", "/admin/agents", "/admin/profiles", "/admin/applications", "/admin/skills", "/admin/user-skills", "/admin/mcp", "/admin/capabilities", "/admin/models", "/admin/token-usage", "/admin/users", "/admin/orgs", "/admin/resource-registrations", "/admin/governance-audit", "/admin/hub", "/admin/security"];

export function AdminSidebar() {
  const navigate = useNavigate();
  // M3: filter nav items by the current role. org_admin sees only Orgs + Users.
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const role: string = currentUser.role ?? "user";
  const canSee = (item: NavItem) => !item.roles || item.roles.includes(role as "admin" | "org_admin");

  return (
    <div className="w-56 shrink-0 h-full flex flex-col border-r border-line-subtle bg-surface-page">
      <div className="px-4 py-3 border-b border-line-subtle">
        <h2 className="text-sm font-semibold text-ink-primary">EAOS 管理台</h2>
        <p className="text-xs text-ink-muted">企业 AI 工作台</p>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {groups.map((group) => {
          const visible = group.items.filter(canSee);
          if (visible.length === 0) return null;
          return (
          <div key={group.title} className="mb-3">
            <div className="px-4 py-1 text-xs font-medium text-ink-muted">
              {group.title}
            </div>
            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-4 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-brand-soft text-brand font-medium border-r-2 border-brand"
                      : "text-ink-secondary hover:bg-surface-page"
                  }`
                }
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="ml-auto text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
          );
        })}
      </nav>

      <div className="px-4 py-3 border-t border-line-subtle">
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2 text-xs text-ink-muted hover:text-brand transition-colors"
        >
          <UserCircle className="w-4 h-4" />
          返回工作台
        </button>
      </div>
    </div>
  );
}
