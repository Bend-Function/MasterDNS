"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, UI_PREVIEW } from "../lib/api";
import { demoUser } from "../lib/demo";
import { createSessionManager } from "../lib/session-state";
import type { User } from "../lib/types";

type SessionContextValue = ReturnType<typeof createSessionManager>;
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => createSessionManager(UI_PREVIEW ? demoUser : null, !UI_PREVIEW));
  useEffect(() => { if (!UI_PREVIEW) void session.refresh(() => api<User>("/v1/auth/me")); }, [session]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider");
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...snapshot, refresh: session.refresh, setUser: session.setUser, clear: session.clear };
}
