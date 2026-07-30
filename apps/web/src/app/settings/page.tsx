"use client";

import { CheckCircle2, Database, KeyRound, RefreshCw, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, PageHeader, StatusBadge } from "../../components/ui";
import { API_URL } from "../../lib/api";

export default function SettingsPage() {
  const [apiState, setApiState] = useState<"unknown" | "active" | "error">("unknown");
  const check = async () => { try { const response = await fetch(`${API_URL}/api/health`); setApiState(response.ok ? "active" : "error"); } catch { setApiState("error"); } };
  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/api/health`).then((response) => { if (active) setApiState(response.ok ? "active" : "error"); }).catch(() => { if (active) setApiState("error"); });
    return () => { active = false; };
  }, []);
  return <ConsoleLayout><PageHeader title="系统设置" description="部署状态、保留策略与安全边界" actions={<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void check()}>重新检查</Button>} />
    <div className="content-grid"><section className="surface"><header className="surface-header"><div><h2>运行服务</h2><p>Docker Compose 组件</p></div><ServerCog size={16} /></header><ul className="compact-list"><li><div><strong>MasterDNS API</strong><small className="mono">{API_URL}</small></div><StatusBadge value={apiState} /></li><li><div><strong>PostgreSQL</strong><small>持久事实、操作与审计历史</small></div><Database size={16} /></li><li><div><strong>Redis / BullMQ</strong><small>检查、操作与通知队列</small></div><CheckCircle2 size={16} /></li></ul></section><aside className="surface"><header className="surface-header"><div><h2>数据与安全</h2><p>当前部署约束</p></div><KeyRound size={16} /></header><ul className="compact-list"><li><div><strong>云凭证</strong><small>AES-256-GCM 加密</small></div></li><li><div><strong>健康原始结果</strong><small>保留 30 天</small></div></li><li><div><strong>审计与策略版本</strong><small>永久保留</small></div></li><li><div><strong>DDNS Token</strong><small>仅保存 SHA-256 哈希</small></div></li></ul></aside></div>
  </ConsoleLayout>;
}
