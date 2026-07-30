"use client";

import { X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "primary", icon, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; icon?: ReactNode }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{icon}{children && <span>{children}</span>}</button>;
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
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
  if (!open) return null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`dialog dialog-${size}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>;
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
