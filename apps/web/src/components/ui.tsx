"use client";

import { X } from "lucide-react";
import { createElement, useEffect, useId, useRef, useSyncExternalStore, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const dialogStack: HTMLElement[] = [];
const suppressedElements = new WeakMap<HTMLElement, { count: number; ariaHidden: string | null; hadInert: boolean }>();
let bodyLockCount = 0;
let previousBodyOverflow = "";

const subscribeToMount = () => () => undefined;
const getClientMountSnapshot = () => true;
const getServerMountSnapshot = () => false;

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => (
    element.getClientRects().length > 0
    && !element.closest("[inert], [aria-hidden='true']")
  ));
}

export function getFocusWrapIndex(itemCount: number, activeIndex: number, reverse: boolean): number | null {
  if (itemCount <= 0) return null;
  if (reverse && activeIndex <= 0) return itemCount - 1;
  if (!reverse && (activeIndex < 0 || activeIndex === itemCount - 1)) return 0;
  return null;
}

function suppressPageBehind(backdrop: HTMLElement): () => void {
  const elements = Array.from(document.body.children).filter((element): element is HTMLElement => (
    element instanceof HTMLElement && element !== backdrop
  ));

  for (const element of elements) {
    const existing = suppressedElements.get(element);
    if (existing) {
      existing.count += 1;
      continue;
    }

    suppressedElements.set(element, {
      count: 1,
      ariaHidden: element.getAttribute("aria-hidden"),
      hadInert: element.hasAttribute("inert"),
    });
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("inert", "");
  }

  if (bodyLockCount === 0) previousBodyOverflow = document.body.style.overflow;
  bodyLockCount += 1;
  document.body.style.overflow = "hidden";

  return () => {
    for (const element of elements) {
      const state = suppressedElements.get(element);
      if (!state) continue;

      state.count -= 1;
      if (state.count > 0) continue;

      if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", state.ariaHidden);
      if (!state.hadInert) element.removeAttribute("inert");
      suppressedElements.delete(element);
    }

    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) document.body.style.overflow = previousBodyOverflow;
  };
}

export function Button({ variant = "primary", icon, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; icon?: ReactNode }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{icon}{children && <span>{children}</span>}</button>;
}

export function IconButton({ label, children, className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className={`icon-button ${className}`} type={type} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Switch({ checked, label, onCheckedChange, onClick, className = "", type = "button", ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { checked: boolean; label: string; onCheckedChange?: (checked: boolean) => void }) {
  return createElement("button", {
    ...props,
    className: `switch ${checked ? "on" : ""} ${className}`,
    type,
    role: "switch",
    "aria-checked": checked,
    "aria-label": label,
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (!event.defaultPrevented) onCheckedChange?.(!checked);
    },
  });
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = ["healthy", "active", "succeeded", "delivered", "applied"].includes(normalized) ? "success"
    : ["unhealthy", "failed", "error", "disabled", "drifted"].includes(normalized) ? "danger"
      : ["degraded", "recovering", "running", "retrying", "switching", "partial"].includes(normalized) ? "warning" : "neutral";
  return <span className={`status status-${tone}`}><i />{statusLabel(value)}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function LoadingState() { return <div className="loading-state"><span className="spinner" />正在加载</div>; }
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="error-state"><strong>加载失败</strong><span>{message}</span>{onRetry && <Button variant="secondary" onClick={onRetry}>重试</Button>}</div>; }
export function EmptyState({ title, action }: { title: string; action?: ReactNode }) { return <div className="empty-state"><strong>{title}</strong>{action}</div>; }

export function Dialog({ open, title, onClose, children, footer, size = "medium" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "small" | "medium" | "large" }) {
  const mounted = useSyncExternalStore(subscribeToMount, getClientMountSnapshot, getServerMountSnapshot);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!mounted || !open) return;

    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFirst = () => {
      const preferred = dialog.querySelector<HTMLElement>("[data-autofocus], [autofocus]");
      const target = preferred && preferred.getClientRects().length > 0
        ? preferred
        : getFocusableElements(dialog)[0] ?? dialog;
      target.focus({ preventScroll: true });
    };

    dialogStack.push(dialog);
    focusFirst();
    const releaseBackground = suppressPageBehind(backdrop);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
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
      if (dialogStack[dialogStack.length - 1] === dialog && !dialog.contains(event.target as Node)) focusFirst();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      const stackIndex = dialogStack.lastIndexOf(dialog);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      releaseBackground();

      const topDialog = dialogStack[dialogStack.length - 1];
      if (previouslyFocused?.isConnected && (!topDialog || topDialog.contains(previouslyFocused))) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [mounted, open]);

  if (!mounted || !open) return null;
  return createPortal(<div ref={backdropRef} className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className={`dialog dialog-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>, document.body);
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function MetricStrip({ items }: { items: Array<{ label: string; value: ReactNode; detail?: string }> }) {
  return <section className="metric-strip">{items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</div>)}</section>;
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = { healthy: "健康", unhealthy: "故障", degraded: "降级", recovering: "恢复中", unknown: "未知", active: "正常", disabled: "已停用", error: "异常", pending: "等待中", running: "执行中", succeeded: "成功", partial: "部分成功", failed: "失败", superseded: "已过期", delivered: "已送达", retrying: "重试中", switching: "切换中", drifted: "已漂移", maintenance: "维护", enabled: "启用", draining: "排空中" };
  return labels[value.toLowerCase()] ?? value;
}
