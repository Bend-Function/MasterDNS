"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, UI_PREVIEW } from "../lib/api";
import { demoUser } from "../lib/demo";
import type { User } from "../lib/types";

type SessionState = { user: User | null; checking: boolean };
const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(UI_PREVIEW ? demoUser : null);
  const [checking, setChecking] = useState(!UI_PREVIEW);

  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    api<User>("/v1/auth/me").then((value) => { if (active) setUser(value); }).catch(() => undefined).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  return <SessionContext.Provider value={{ user, checking }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider");
  return session;
}
