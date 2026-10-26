// Role context + the admin lens switcher (plan §5). The real mechanism is
// server-side: every API response is built for the resolved role. This context
// (a) sends the x-explorer-role header — honored by the local dev shim for
// anyone, and by a published deployment only as an ADMIN's downgrade to the
// User lens — and (b) gates admin affordances client-side as defense-in-depth.
//
// Whether the caller really is an admin is probed from the server: /api/meta
// requested under the admin lens includes `roles` only when the server
// resolved the caller as admin. Until that answers, render the safe lens.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";
import type { Meta, Role } from "./types";

interface RoleState {
  role: Role;
  setRole: (r: Role) => void;
  /** Server-verified: the switcher renders only for a real admin. */
  canAdmin: boolean;
  /** Server-advertised: the local-only Discover & Analyze view is available. */
  canDiscover: boolean;
  /** Server-advertised: the local-only Settings view is available. */
  canSettings: boolean;
  /** Server-advertised queue visibility, only active in the admin lens. */
  canAnalyses: boolean;
  canConfigureAnalyses: boolean;
  isRoleLoading: boolean;
}

const RoleContext = createContext<RoleState>({
  role: "user",
  setRole: () => {},
  canAdmin: false,
  canDiscover: false,
  canSettings: false,
  canAnalyses: false,
  canConfigureAnalyses: false,
  isRoleLoading: true,
});

const STORAGE_KEY = "explorer.role";

export function RoleProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Role>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "user" || saved === "admin" ? saved : "admin";
  });
  const { data: probe, isPending: isRoleLoading } = useQuery({
    queryKey: ["role-probe"],
    queryFn: () => apiGet<Meta>("/api/meta", "admin"),
    staleTime: Infinity,
  });
  const canAdmin = Boolean(probe?.roles);
  const canDiscover = Boolean(probe?.discover);
  const canSettings = Boolean(probe?.settings);
  const canAnalyses = canAdmin && chosen === "admin" && Boolean(probe?.analyses);
  const canConfigureAnalyses = canAdmin && chosen === "admin" && Boolean(probe?.analysisConfiguration);
  const value = useMemo<RoleState>(
    () => ({
      // A non-admin's stored lens choice is inert — the server ignores the
      // header anyway; keep the client honest and render the User lens.
      role: canAdmin ? chosen : "user",
      setRole: (r) => {
        localStorage.setItem(STORAGE_KEY, r);
        setChosen(r);
      },
      canAdmin,
      canDiscover,
      canSettings,
      canAnalyses,
      canConfigureAnalyses,
      isRoleLoading,
    }),
    [chosen, canAdmin, canDiscover, canSettings, canAnalyses, canConfigureAnalyses, isRoleLoading],
  );
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleState {
  return useContext(RoleContext);
}

/** Renders children only in the Admin lens — belt-and-suspenders on top of the
 *  server-side redaction, never the mechanism itself. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { role } = useRole();
  return role === "admin" ? <>{children}</> : null;
}
