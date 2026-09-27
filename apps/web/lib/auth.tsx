"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  api,
  clearToken,
  getToken,
  setToken,
  type LoginResponse,
  type MeResponse,
  type SessionResponse,
  type TenantsResponse,
} from "./api";

interface AuthState {
  token: string | null;
  user: { id: string; email: string; displayName: string | null } | null;
  activeTenantId: string | null;
  tenants: TenantsResponse["memberships"];
  permissions: string[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

async function refreshSession(token: string): Promise<{
  session: SessionResponse;
  me: MeResponse | null;
}> {
  const session = await api.get<SessionResponse>("/v1/auth/session", { token });
  let me: MeResponse | null = null;
  try {
    me = await api.get<MeResponse>("/v1/me", { token });
  } catch {
    me = null;
  }
  return { session, me };
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthState["user"]>(null);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantsResponse["memberships"]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = getToken();
    if (stored === null) {
      setLoading(false);
      return;
    }
    refreshSession(stored)
      .then(({ session, me }) => {
        setTokenState(stored);
        setUser(session.user);
        setActiveTenantId(session.activeTenantId);
        setTenants(session.memberships);
        setPermissions(me?.permissions ?? []);
      })
      .catch(() => {
        clearToken();
        setTokenState(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse>("/v1/auth/login", { email, password });
    setToken(res.token);
    const { session, me } = await refreshSession(res.token);
    setTokenState(res.token);
    setUser(session.user);
    setActiveTenantId(session.activeTenantId);
    setTenants(session.memberships);
    setPermissions(me?.permissions ?? []);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/v1/auth/logout", {});
    } catch {
      // logout best-effort: limpa a sessão local de qualquer forma
    }
    clearToken();
    setTokenState(null);
    setUser(null);
    setActiveTenantId(null);
    setTenants([]);
    setPermissions([]);
  }, []);

  const switchTenant = useCallback(async (tenantId: string) => {
    const res = await api.post<{ activeTenantId: string }>(`/v1/tenants/${tenantId}/switch`, {});
    setActiveTenantId(res.activeTenantId);
    const stored = getToken();
    if (stored !== null) {
      try {
        const me = await api.get<MeResponse>("/v1/me", { token: stored });
        setPermissions(me.permissions);
      } catch {
        setPermissions([]);
      }
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      activeTenantId,
      tenants,
      permissions,
      loading,
      login,
      logout,
      switchTenant,
      hasPermission: (p: string) => permissions.includes(p),
    }),
    [token, user, activeTenantId, tenants, permissions, loading, login, logout, switchTenant],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth deve ser usado dentro de <AuthProvider>");
  return ctx;
}
