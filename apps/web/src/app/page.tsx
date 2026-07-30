"use client";

import { Activity, ArrowRight, Boxes, Cloud, FileClock, Network, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ConsoleLayout } from "../components/console-layout";
import { RelativeTime } from "../components/relative-time";
import { ErrorState, LoadingState, MetricStrip, PageHeader, StatusBadge } from "../components/ui";
import { api, formatDate, UI_PREVIEW } from "../lib/api";
import { demoAccounts, demoOperations, demoPools, demoZones } from "../lib/demo";
import type { Operation, Pool, ProviderAccount, ZoneListRow } from "../lib/types";

type DashboardData = { pools: Pool[]; zones: ZoneListRow[]; operations: Operation[]; accounts: ProviderAccount[] };

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(UI_PREVIEW ? { pools: demoPools, zones: demoZones, operations: demoOperations, accounts: demoAccounts } : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (UI_PREVIEW) return;
    Promise.all([
      api<Pool[]>("/v1/pools"),
      api<ZoneListRow[]>("/v1/zones"),
      api<Operation[]>("/v1/operations?limit=8"),
      api<ProviderAccount[]>("/v1/provider-accounts"),
    ]).then(([pools, zones, operations, accounts]) => setData({ pools, zones, operations, accounts })).catch((value) => setError(value instanceof Error ? value.message : "概览加载失败"));
  }, []);

  return <ConsoleLayout>
    <PageHeader title="运行概览" description="多云 DNS、健康检查和自动化状态" actions={<Link className="button button-primary" href="/pools"><Boxes size={15} /><span>管理 IP Pool</span></Link>} />
    {error ? <ErrorState message={error} /> : !data ? <LoadingState /> : <Dashboard data={data} />}
  </ConsoleLayout>;
}

function Dashboard({ data }: { data: DashboardData }) {
  const unhealthyPools = data.pools.filter((pool) => ["unhealthy", "degraded"].includes(pool.state));
  const running = data.operations.filter((operation) => ["pending", "running"].includes(operation.status)).length;
  const activeZones = data.zones.filter((row) => row.zone.status === "active").length;
  return <>
    <MetricStrip items={[
      { label: "受管 Zone", value: data.zones.length, detail: `${activeZones} 个状态正常` },
      { label: "IP Pool", value: data.pools.length, detail: `${unhealthyPools.length} 个需要关注` },
      { label: "健康节点", value: data.pools.reduce((sum, pool) => sum + (pool.healthyEndpointCount ?? 0), 0), detail: `${data.pools.reduce((sum, pool) => sum + (pool.endpointCount ?? 0), 0)} 个节点` },
      { label: "执行中操作", value: running, detail: `${data.operations.length} 条最近变更` },
    ]} />
    <div className="content-grid">
      <div>
        <section className="surface">
          <header className="surface-header"><div><h2>IP Pool 状态</h2><p>当前自动化与分配概况</p></div><Link className="button button-ghost" href="/pools">查看全部 <ArrowRight size={14} /></Link></header>
          <div className="table-wrap"><table><thead><tr><th>Pool</th><th>策略</th><th>节点</th><th>域名</th><th>状态</th><th>最近协调</th></tr></thead><tbody>
            {data.pools.map((pool) => <tr key={pool.id}><td><Link className="table-primary" href={`/pools/${pool.id}`}><strong>{pool.name}</strong><small>Revision {pool.policyRevision}</small></Link></td><td>{strategyLabel(pool.strategy)}</td><td>{pool.healthyEndpointCount ?? 0} / {pool.endpointCount ?? 0}</td><td>{pool.bindingCount ?? 0}</td><td><StatusBadge value={pool.enabled ? pool.state : "disabled"} /></td><td className="muted"><RelativeTime value={pool.lastReconciledAt} /></td></tr>)}
          </tbody></table></div>
        </section>
        <section className="surface">
          <header className="surface-header"><div><h2>最近变更</h2><p>人工与自动 DNS Operation</p></div><Link className="button button-ghost" href="/operations">查看历史 <ArrowRight size={14} /></Link></header>
          <div className="table-wrap"><table><thead><tr><th>来源</th><th>资源</th><th>状态</th><th>开始时间</th></tr></thead><tbody>
            {data.operations.map((operation) => <tr key={operation.id}><td><span className="mono">{sourceLabel(operation.source)}</span></td><td><Link className="table-primary" href={`/operations?id=${operation.id}`}><strong>{resourceLabel(operation.resourceType)}</strong><small>{operation.id.slice(0, 12)}</small></Link></td><td><StatusBadge value={operation.status} /></td><td className="muted">{formatDate(operation.createdAt)}</td></tr>)}
          </tbody></table></div>
        </section>
      </div>
      <aside>
        <section className="surface">
          <header className="surface-header"><div><h2>需要关注</h2><p>故障、降级与账号异常</p></div><ShieldAlert size={17} color="#b23838" /></header>
          {unhealthyPools.length === 0 && data.accounts.every((account) => account.status === "active")
            ? <div className="empty-state"><Activity size={22} /><strong>当前没有活动故障</strong></div>
            : <ul className="event-list">
              {unhealthyPools.map((pool) => <li key={pool.id}><strong>{pool.name}</strong><span>{pool.state === "unhealthy" ? "没有健康节点，DNS 保持当前值" : "部分节点异常，Pool 正在降级运行"}</span></li>)}
              {data.accounts.filter((account) => account.status !== "active").map((account) => <li key={account.id}><strong>{account.name}</strong><span>云账号需要重新验证：{account.errorCode ?? "未知错误"}</span></li>)}
            </ul>}
        </section>
        <section className="surface">
          <header className="surface-header"><div><h2>资源</h2><p>云厂商连接和 Zone</p></div><Cloud size={17} /></header>
          <ul className="compact-list">
            {data.accounts.map((account) => <li key={account.id}><div><strong>{account.name}</strong><small>{account.provider === "cloudflare" ? "Cloudflare" : "阿里云 DNS"}</small></div><StatusBadge value={account.status} /></li>)}
            <li><div><strong>DNS Zones</strong><small>{activeZones} 个已同步</small></div><Network size={16} color="#68736f" /></li>
            <li><div><strong>Operation 队列</strong><small>{running} 个进行中</small></div><FileClock size={16} color="#68736f" /></li>
          </ul>
        </section>
      </aside>
    </div>
  </>;
}

function strategyLabel(value: Pool["strategy"]) { return value === "primary_backup" ? "主备" : value === "healthy_set" ? "健康集合" : "跨域名分配"; }
function sourceLabel(value: string) { return ({ user: "人工", failover: "故障转移", recovery: "自动恢复", ddns: "DDNS", drift: "漂移修复", rollback: "回滚" } as Record<string, string>)[value] ?? value; }
function resourceLabel(value: string) { return ({ endpoint_pool: "IP Pool", dns_record: "DNS 记录", domain_binding: "域名绑定" } as Record<string, string>)[value] ?? value; }
