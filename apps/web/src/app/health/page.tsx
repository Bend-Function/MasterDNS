"use client";

import { Activity, ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, ErrorState, LoadingState, MetricStrip, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { relativeTime } from "../../lib/api";
import { demoPools } from "../../lib/demo";
import type { Pool } from "../../lib/types";

export default function HealthPage() {
  const { data, loading, error, reload } = useResource<Pool[]>("/v1/pools", demoPools);
  const pools = data ?? []; const endpoints = pools.reduce((sum, pool) => sum + (pool.endpointCount ?? 0), 0); const healthy = pools.reduce((sum, pool) => sum + (pool.healthyEndpointCount ?? 0), 0);
  return <ConsoleLayout><PageHeader title="健康检查" description="HTTP、HTTPS 与 TCP Connect 的聚合状态" actions={<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void reload()}>刷新</Button>} />
    <MetricStrip items={[{ label: "受检节点", value: endpoints, detail: `${pools.length} 个 Pool` }, { label: "健康", value: healthy, detail: endpoints ? `${Math.round(healthy / endpoints * 100)}%` : "-" }, { label: "异常", value: Math.max(0, endpoints - healthy), detail: "包含未知、恢复与故障" }, { label: "默认间隔", value: `${pools[0]?.checkIntervalSeconds ?? 15}s`, detail: "可按 Pool 配置" }]} />
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} /></div> : <section className="surface"><header className="surface-header"><div><h2>Pool 检查状态</h2><p>进入 Pool 查看节点级结果与检查配置</p></div><Activity size={16} /></header><div className="table-wrap"><table><thead><tr><th>Pool</th><th>状态</th><th>健康节点</th><th>间隔</th><th>失败 / 恢复阈值</th><th>最近协调</th><th aria-label="操作" /></tr></thead><tbody>{pools.map((pool) => <tr key={pool.id}><td><Link className="table-primary" href={`/pools/${pool.id}`}><strong>{pool.name}</strong><small>{pool.strategy}</small></Link></td><td><StatusBadge value={pool.enabled ? pool.state : "disabled"} /></td><td>{pool.healthyEndpointCount ?? 0} / {pool.endpointCount ?? 0}</td><td>{pool.checkIntervalSeconds}s</td><td>{pool.failureThreshold} / {pool.successThreshold}</td><td className="muted">{relativeTime(pool.lastReconciledAt)}</td><td><Link className="icon-button" href={`/pools/${pool.id}`} aria-label="查看检查结果"><ExternalLink size={15} /></Link></td></tr>)}</tbody></table></div></section>}
  </ConsoleLayout>;
}
