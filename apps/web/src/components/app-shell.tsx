"use client";

import {
  Activity,
  BellRing,
  Boxes,
  ChevronRight,
  Cloud,
  FileClock,
  Gauge,
  LogOut,
  Menu,
  Network,
  RadioTower,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_URL, api, UI_PREVIEW } from "../lib/api";
import { demoUser } from "../lib/demo";
import type { User } from "../lib/types";
import { getFocusWrapIndex, IconButton } from "./ui";

const MOBILE_NAV_QUERY = "(max-width: 760px)";
const MOBILE_NAV_FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function getMobileNavFocusable(sidebar: HTMLElement): HTMLElement[] {
  return Array.from(sidebar.querySelectorAll<HTMLElement>(MOBILE_NAV_FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
}

const navigation = [
  { href: "/", label: "概览", icon: Gauge },
  { href: "/zones", label: "域名与解析", icon: Network },
  { href: "/pools", label: "IP Pool", icon: Boxes },
  { href: "/health", label: "健康检查", icon: Activity },
  { href: "/ddns", label: "DDNS Agent", icon: RadioTower },
  { href: "/accounts", label: "云账号", icon: Cloud },
  { href: "/operations", label: "变更历史", icon: FileClock },
  { href: "/notifications", label: "告警渠道", icon: BellRing },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(UI_PREVIEW ? demoUser : null);
  const [checking, setChecking] = useState(!UI_PREVIEW);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (UI_PREVIEW) return;
    api<User>("/v1/auth/me").then(setUser).catch(() => router.replace("/login")).finally(() => setChecking(false));
  }, [router]);

  useEffect(() => {
    if (UI_PREVIEW || !user) return;
    const events = new EventSource(`${API_URL}/api/v1/events`, { withCredentials: true });
    const invalidate = () => window.dispatchEvent(new Event("masterdns:invalidate"));
    events.addEventListener("invalidate", invalidate);
    return () => {
      events.removeEventListener("invalidate", invalidate);
      events.close();
    };
  }, [user]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_NAV_QUERY);
    const updateViewport = () => {
      setMobileViewport(mediaQuery.matches);
      if (!mediaQuery.matches) setMobileOpen(false);
    };

    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileViewport || !mobileOpen) return;

    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFirst = () => (sidebar.querySelector<HTMLElement>(".mobile-close") ?? getMobileNavFocusable(sidebar)[0] ?? sidebar).focus({ preventScroll: true });
    const focusFrame = window.requestAnimationFrame(focusFirst);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getMobileNavFocusable(sidebar);
      if (focusable.length === 0) {
        event.preventDefault();
        sidebar.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      const wrapIndex = getFocusWrapIndex(focusable.length, activeIndex, event.shiftKey);
      const wrapTarget = wrapIndex === null ? undefined : focusable[wrapIndex];
      if (wrapTarget) {
        event.preventDefault();
        wrapTarget.focus();
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!sidebar.contains(event.target as Node)) focusFirst();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [mobileOpen, mobileViewport]);

  if (checking) return <main className="auth-loading"><span className="spinner" />正在验证会话</main>;
  if (!user) return null;

  const logout = async () => {
    if (!UI_PREVIEW) await api("/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  const mobileMenuActive = mobileViewport && mobileOpen;
  const mobileMenuHidden = mobileViewport && !mobileOpen;

  return <div className="app-frame">
    <aside
      id="app-sidebar"
      ref={sidebarRef}
      className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}
      role={mobileViewport ? "dialog" : undefined}
      aria-modal={mobileMenuActive ? true : undefined}
      aria-label={mobileViewport ? "主菜单" : undefined}
      aria-hidden={mobileMenuHidden ? true : undefined}
      inert={mobileMenuHidden ? true : undefined}
      tabIndex={mobileMenuActive ? -1 : undefined}
    >
      <div className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><div><strong>MasterDNS</strong><small>Control plane</small></div><IconButton label="关闭菜单" className="mobile-close" onClick={() => setMobileOpen(false)}><X size={19} /></IconButton></div>
      <nav aria-label="主导航">
        {navigation.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return <Link href={href} onClick={() => setMobileOpen(false)} className={active ? "active" : ""} key={href}><Icon size={18} /><span>{label}</span>{active && <ChevronRight size={14} />}</Link>;
        })}
        {user.role === "admin" && <Link href="/users" onClick={() => setMobileOpen(false)} className={pathname.startsWith("/users") ? "active" : ""}><Users size={18} /><span>用户管理</span></Link>}
      </nav>
      <div className="sidebar-bottom">
        <Link href="/settings" onClick={() => setMobileOpen(false)} className={pathname.startsWith("/settings") ? "active" : ""}><Settings size={18} /><span>系统设置</span></Link>
        <button onClick={logout}><LogOut size={18} /><span>退出登录</span></button>
        <div className="user-block"><span>{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}</strong><small>{user.role === "admin" ? "管理员" : "普通用户"}</small></div></div>
      </div>
    </aside>
    {mobileMenuActive && <div className="sidebar-scrim" aria-hidden="true" onMouseDown={() => setMobileOpen(false)} />}
    <div className="workspace" inert={mobileMenuActive ? true : undefined}>
      <header className="mobile-bar"><IconButton label="打开菜单" aria-controls="app-sidebar" aria-expanded={mobileMenuActive} onClick={() => setMobileOpen(true)}><Menu size={20} /></IconButton><strong>MasterDNS</strong><span className="system-live"><i />Online</span></header>
      <div className="desktop-system-bar"><span className="system-live"><i />控制面在线</span></div>
      <main className="page-content">{children}</main>
    </div>
  </div>;
}
