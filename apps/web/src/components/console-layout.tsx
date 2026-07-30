import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

export function ConsoleLayout({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell>; }
