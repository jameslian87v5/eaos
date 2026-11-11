import { Suspense, lazy } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AdminSidebar, ORG_ADMIN_ALLOWED_PATHS } from "./AdminSidebar";

const OverviewPage = lazy(() => import("./pages/OverviewPage").then(m => ({ default: m.OverviewPage })));
const SessionsPage = lazy(() => import("./pages/SessionsPage").then(m => ({ default: m.SessionsPage })));
const RuntimeSettingsPage = lazy(() => import("./pages/RuntimeSettingsPage").then(m => ({ default: m.RuntimeSettingsPage })));
const PromptSettingsPage = lazy(() => import("./pages/PromptSettingsPage").then(m => ({ default: m.PromptSettingsPage })));
const SkillsPage = lazy(() => import("./pages/SkillsPage").then(m => ({ default: m.SkillsPage })));
const UserSkillsReviewPage = lazy(() => import("./pages/UserSkillsReviewPage").then(m => ({ default: m.UserSkillsReviewPage })));
const McpPage = lazy(() => import("./pages/McpPage").then(m => ({ default: m.McpPage })));
const CapabilitiesPage = lazy(() => import("./pages/CapabilitiesPage").then(m => ({ default: m.CapabilitiesPage })));
const ApplicationsPage = lazy(() => import("./pages/ApplicationsPage").then(m => ({ default: m.ApplicationsPage })));
const ApisPage = lazy(() => import("./pages/ApisPage").then(m => ({ default: m.ApisPage })));
const ConnectorsPage = lazy(() => import("./pages/ConnectorsPage").then(m => ({ default: m.ConnectorsPage })));
const AgentsPage = lazy(() => import("./pages/AgentsPage").then(m => ({ default: m.AgentsPage })));
const ProfilesPage = lazy(() => import("./pages/ProfilesPage").then(m => ({ default: m.ProfilesPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then(m => ({ default: m.UsersPage })));
const OrgsPage = lazy(() => import("./pages/OrgsPage").then(m => ({ default: m.OrgsPage })));
const ResourceRegistrationsPage = lazy(() => import("./pages/ResourceRegistrationsPage").then(m => ({ default: m.ResourceRegistrationsPage })));
const GovernanceAuditPage = lazy(() => import("./pages/GovernanceAuditPage").then(m => ({ default: m.GovernanceAuditPage })));
const AuditPage = lazy(() => import("./pages/AuditPage").then(m => ({ default: m.AuditPage })));
const PolicyPage = lazy(() => import("./pages/PolicyPage").then(m => ({ default: m.PolicyPage })));
const HooksPage = lazy(() => import("./pages/HooksPage").then(m => ({ default: m.HooksPage })));
const PluginsPage = lazy(() => import("./pages/PluginsPage").then(m => ({ default: m.PluginsPage })));
const HubPage = lazy(() => import("./pages/HubPage").then(m => ({ default: m.HubPage })));
// M1 (model management): standalone 模型管理 page — platform catalog (admin)
// + org model policy. NOT part of Runtime Settings by design.
const ModelsPage = lazy(() => import("./pages/ModelsPage").then(m => ({ default: m.ModelsPage })));
// M3 (token dashboard): org-scoped Token usage page (admin cross-org; org_admin own).
const TokenUsagePage = lazy(() => import("./pages/TokenUsagePage").then(m => ({ default: m.TokenUsagePage })));
// M6b: unified security posture center (six tabs; org_admin own-org).
const SecurityCenterPage = lazy(() => import("./pages/SecurityCenterPage").then(m => ({ default: m.SecurityCenterPage })));

export function AdminLayout() {
  // M3: org_admin deep-linking to an admin-only page (e.g. /admin/skills)
  // would render a page whose API 403s. Redirect them to their own-dept
  // Users view instead. The sidebar already hides admin-only links.
  const location = useLocation();
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const role: string = currentUser.role ?? "user";
  const isOrgAdmin = role === "org_admin";
  const pathOk = !isOrgAdmin || ORG_ADMIN_ALLOWED_PATHS.some((p) => location.pathname.startsWith(p));
  // org_admin landing on /admin (no sub-page) → own-dept Users.
  const indexRedirect = isOrgAdmin ? "/admin/users" : "/admin/overview";

  return (
    <div className="flex h-screen overflow-hidden bg-white text-ink-primary">
      <AdminSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-auto p-6">
          <Suspense fallback={<div className="text-sm text-gray-400">加载中…</div>}>
            {!pathOk ? (
              <Navigate to="/admin/users" replace />
            ) : (
              <Routes>
                <Route path="/admin" element={<Navigate to={indexRedirect} replace />} />
                <Route path="/admin/overview" element={<OverviewPage />} />
                <Route path="/admin/sessions" element={<SessionsPage />} />
                <Route path="/admin/runtime" element={<RuntimeSettingsPage />} />
                <Route path="/admin/models" element={<ModelsPage />} />
                <Route path="/admin/token-usage" element={<TokenUsagePage />} />
                <Route path="/admin/security" element={<SecurityCenterPage />} />
                <Route path="/admin/prompt" element={<PromptSettingsPage />} />
                <Route path="/admin/skills" element={<SkillsPage />} />
                {/* M7b: user skill submission review queue (admin reviews;
                    org_admin read-only own-org — the page hides buttons and the
                    server 403s regardless). */}
                <Route path="/admin/user-skills" element={<UserSkillsReviewPage />} />
                <Route path="/admin/mcp" element={<McpPage />} />
                <Route path="/admin/capabilities" element={<CapabilitiesPage />} />
                <Route path="/admin/applications" element={<ApplicationsPage />} />
                <Route path="/admin/hooks" element={<Navigate to="/admin/plugins" replace />} />
                <Route path="/admin/plugins" element={<PluginsPage />} />
                <Route path="/admin/apis" element={<ApisPage />} />
                <Route path="/admin/connectors" element={<ConnectorsPage />} />
                <Route path="/admin/agents" element={<AgentsPage />} />
                <Route path="/admin/profiles" element={<ProfilesPage />} />
                <Route path="/admin/users" element={<UsersPage />} />
                <Route path="/admin/orgs" element={<OrgsPage />} />
                <Route path="/admin/resource-registrations" element={<ResourceRegistrationsPage />} />
                <Route path="/admin/governance-audit" element={<GovernanceAuditPage />} />
                <Route path="/admin/hub" element={<HubPage />} />
                <Route path="/admin/audit" element={<AuditPage />} />
                <Route path="/admin/policy" element={<PolicyPage />} />
              </Routes>
            )}
          </Suspense>
        </div>
      </div>
      <Toaster position="top-right" richColors />
    </div>
  );
}
