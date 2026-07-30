"use client";

import { MoreHorizontal, Pause, Play, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, jsonBody, relativeTime, UI_PREVIEW } from "../../lib/api";
import { demoPools } from "../../lib/demo";
import type { Pool } from "../../lib/types";

const initialPool = { name: "", description: "", strategy: "assignment_pool" as Pool["strategy"], selectionMode: "least_assigned", recoveryMode: "keep_current", failureThreshold: 3, successThreshold: 3, checkIntervalSeconds: 15, checkTimeoutMs: 3000, switchCooldownSeconds: 300, recoveryDelaySeconds: 0, allDownReminderSeconds: 1800 };

export default function PoolsPage() {
  const { data, setData, loading, error, reload } = useResource<Pool[]>("/v1/pools", demoPools);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState(initialPool);
  const [saving, setSaving] = useState(false);
  const rows = useMemo(() => (data ?? []).filter((pool) => pool.name.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const create = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    if (!UI_PREVIEW) { await api("/v1/pools", { method: "POST", ...jsonBody(draft) }); await reload(); }
    else setData([...(data ?? []), { id: `preview-${Date.now()}`, ownerUserId: "demo-admin", ...draft, description: draft.description || null, state: "unknown", policyRevision: 1, enabled: true, lastReconciledAt: null, endpointCount: 0, healthyEndpointCount: 0, bindingCount: 0 }]);
    setSaving(false); setCreateOpen(false); setDraft(initialPool);
  };
  const toggle = async (pool: Pool) => {
    if (!UI_PREVIEW) { await api(`/v1/pools/${pool.id}/${pool.enabled ? "pause" : "resume"}`, { method: "POST" }); await reload(); }
    else setData((data ?? []).map((item) => item.id === pool.id ? { ...item, enabled: !item.enabled } : item));
  };
  return <ConsoleLayout>
    <PageHeader title="IP Pool" description="节点健康、域名分配与自动故障转移策略" actions={<Button icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>新建 Pool</Button>} />
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索 IP Pool" placeholder="搜索 Pool" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><span className="muted">{rows.filter((pool) => pool.enabled).length} 个策略运行中</span></div></div>
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : rows.length === 0 ? <div className="surface"><EmptyState title="尚未创建 IP Pool" action={<Button icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>新建 Pool</Button>} /></div> : <div className="table-wrap"><table><thead><tr><th>Pool</th><th>策略</th><th>健康节点</th><th>域名绑定</th><th>状态</th><th>最近协调</th><th aria-label="操作" /></tr></thead><tbody>
      {rows.map((pool) => <tr key={pool.id}><td><Link className="table-primary" href={`/pools/${pool.id}`}><strong>{pool.name}</strong><small>Revision {pool.policyRevision}</small></Link></td><td>{strategyLabel(pool.strategy)}<div className="muted">{selectionLabel(pool.selectionMode)}</div></td><td><div className="table-primary"><strong>{pool.healthyEndpointCount ?? 0} / {pool.endpointCount ?? 0}</strong><span className="health-meter"><i style={{ width: `${(pool.endpointCount ?? 0) > 0 ? ((pool.healthyEndpointCount ?? 0) / (pool.endpointCount ?? 1)) * 100 : 0}%` }} /></span></div></td><td>{pool.bindingCount ?? 0}</td><td><StatusBadge value={pool.enabled ? pool.state : "disabled"} /></td><td className="muted">{relativeTime(pool.lastReconciledAt)}</td><td><div className="row-actions"><IconButton label={pool.enabled ? "暂停策略" : "恢复策略"} onClick={() => void toggle(pool)}>{pool.enabled ? <Pause size={15} /> : <Play size={15} />}</IconButton><Link className="icon-button" aria-label="打开 Pool" href={`/pools/${pool.id}`}><MoreHorizontal size={16} /></Link></div></td></tr>)}
    </tbody></table></div>}
    <Dialog open={createOpen} title="新建 IP Pool" size="large" onClose={() => setCreateOpen(false)} footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" form="pool-form" disabled={saving}>{saving ? "创建中" : "创建 Pool"}</Button></>}>
      <form id="pool-form" className="field-grid" onSubmit={create}><Field label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></Field><Field label="策略类型"><select value={draft.strategy} onChange={(event) => setDraft({ ...draft, strategy: event.target.value as Pool["strategy"] })}><option value="primary_backup">主备模式</option><option value="healthy_set">健康集合</option><option value="assignment_pool">跨域名分配池</option></select></Field><Field label="说明"><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field><Field label="调度方式"><select value={draft.selectionMode} onChange={(event) => setDraft({ ...draft, selectionMode: event.target.value })}><option value="random">随机</option><option value="ordered">顺序</option><option value="round_robin">轮询</option><option value="least_assigned">最少分配</option></select></Field><Field label="恢复方式"><select value={draft.recoveryMode} onChange={(event) => setDraft({ ...draft, recoveryMode: event.target.value })}><option value="automatic">自动恢复原节点</option><option value="keep_current">保持当前节点</option><option value="manual">手动恢复</option><option value="delayed">延迟恢复</option></select></Field>{draft.recoveryMode === "delayed" && <Field label="恢复等待（秒）"><input type="number" min={0} value={draft.recoveryDelaySeconds} onChange={(event) => setDraft({ ...draft, recoveryDelaySeconds: Number(event.target.value) })} /></Field>}<Field label="检查间隔（秒）"><input type="number" min={5} value={draft.checkIntervalSeconds} onChange={(event) => setDraft({ ...draft, checkIntervalSeconds: Number(event.target.value) })} /></Field><Field label="检查超时（毫秒）"><input type="number" min={100} value={draft.checkTimeoutMs} onChange={(event) => setDraft({ ...draft, checkTimeoutMs: Number(event.target.value) })} /></Field><Field label="失败阈值"><input type="number" min={1} value={draft.failureThreshold} onChange={(event) => setDraft({ ...draft, failureThreshold: Number(event.target.value) })} /></Field><Field label="恢复阈值"><input type="number" min={1} value={draft.successThreshold} onChange={(event) => setDraft({ ...draft, successThreshold: Number(event.target.value) })} /></Field><Field label="切换冷却（秒）"><input type="number" min={0} value={draft.switchCooldownSeconds} onChange={(event) => setDraft({ ...draft, switchCooldownSeconds: Number(event.target.value) })} /></Field><Field label="全池故障提醒（秒）"><input type="number" min={60} value={draft.allDownReminderSeconds} onChange={(event) => setDraft({ ...draft, allDownReminderSeconds: Number(event.target.value) })} /></Field></form>
    </Dialog>
  </ConsoleLayout>;
}

function strategyLabel(value: Pool["strategy"]) { return value === "primary_backup" ? "主备模式" : value === "healthy_set" ? "健康集合" : "跨域名分配"; }
function selectionLabel(value: string) { return ({ random: "随机", ordered: "顺序", round_robin: "轮询", least_assigned: "最少分配" } as Record<string, string>)[value] ?? value; }
