import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { RoleProvider, useRole } from "./role";
import CatalogPage from "./pages/CatalogPage";
import DetailPage from "./pages/DetailPage";
import SubmitPage from "./pages/SubmitPage";
import DiscoverPage from "./pages/DiscoverPage";
import SettingsPage from "./pages/SettingsPage";
import AnalysesPage from "./pages/AnalysesPage";
import AnalysisPage from "./pages/AnalysisPage";
import ComparePage from "./pages/ComparePage";
import { QueueNavLink } from "./components/QueuePreview";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/** The role indicator + lens switcher (plan §5): the switcher renders only
 *  for a server-verified admin (locally, the dev shim verifies everyone) and
 *  previews the User lens; the server enforces the role either way. */
function TopBar() {
  const { role, setRole, canAdmin, canDiscover, canSettings } = useRole();
  return (
    <header className="topbar">
      <Link className="brand" to="/">
        Ext<span className="brand-ray">Ray</span>
      </Link>
      {canAdmin ? <span className={`role-pill ${role}`}>{role}</span> : null}
      <nav className="workspace-nav" aria-label="Main navigation">
        <QueueNavLink />
        <NavLink to="/" end>Catalog</NavLink>
      </nav>
      <span className="spacer" />
      {canAdmin ? (
        <label className="role-switch">
          lens
          <select value={role} onChange={(e) => setRole(e.target.value === "user" ? "user" : "admin")}>
            <option value="admin">admin</option>
            <option value="user">user</option>
          </select>
        </label>
      ) : null}
      {canDiscover && role === "admin" ? (
        <Link className="btn secondary" to="/discover">
          Discover
        </Link>
      ) : null}
      {canSettings && role === "admin" ? (
        <Link className="btn secondary" to="/settings">
          Settings
        </Link>
      ) : null}
      <Link className="btn" to="/submit">
        + Analyze
      </Link>
    </header>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RoleProvider>
        <BrowserRouter>
          <div className="app">
            <TopBar />
            <Routes>
              <Route path="/" element={<CatalogPage />} />
              <Route path="/ext/:storeId" element={<DetailPage />} />
              <Route path="/analyses" element={<AnalysesPage />} />
              <Route path="/analyses/:jobId" element={<AnalysisPage />} />
              <Route path="/compare/:storeId" element={<ComparePage />} />
              <Route path="/submit" element={<SubmitPage />} />
              <Route path="/discover" element={<DiscoverPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </div>
        </BrowserRouter>
      </RoleProvider>
    </QueryClientProvider>
  );
}
