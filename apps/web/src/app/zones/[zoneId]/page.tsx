"use client";

import { ArrowLeft, Edit3, LockKeyhole, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../../components/console-layout";
import { CloudSourcePicker } from "../../../components/cloud-source-picker";
import { RelativeTime } from "../../../components/relative-time";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, Switch } from "../../../components/ui";
import { useResource } from "../../../hooks/use-resource";
import { api, jsonBody, UI_PREVIEW } from "../../../lib/api";
import { demoNow, demoZones } from "../../../lib/demo";
import { demoCloudSlots } from "../../../lib/cloud-demo";
import { createIntentKey } from "../../../lib/intent-key";
import { cloudTargetAddresses, cloudTargetLabel, submitCloudIntent } from "../../../lib/cloud-ui";
import type { DnsRecord, ZoneListRow } from "../../../lib/types";
import type { ZoneBinding } from "../../../lib/zone-bindings";

const previewRecords: DnsRecord[] = [
  { id: "rec-1", zoneId: "zone-1", externalId: "cf-001", type: "A", name: "api.edge.example.com", content: "192.0.2.37", ttl: 60, priority: null, providerMetadata: { proxied: false }, management: "managed", managedByPoolId: "pool-1", lastSyncedAt: demoNow, deletedAt: null },
  { id: "rec-2", zoneId: "zone-1", externalId: "cf-002", type: "CNAME", name: "www.edge.example.com", content: "edge.example.com", ttl: 300, priority: null, providerMetadata: { proxied: true }, management: "unmanaged", managedByPoolId: null, lastSyncedAt: demoNow, deletedAt: null },
];

const previewBindings: ZoneBinding[] = [{
  id: "binding-pending", poolId: "pool-1", poolName: "Public edge pool", fqdn: "pending.edge.example.com", recordType: "A",
  state: "healthy", published: false, inProgress: false, cancellationBlocked: false,
  waitingReason: "等待外部 Agent 对当前地址完成连续成功验证",
  cloudSources: demoCloudSlots[0]?.cloudTarget ? [demoCloudSlots[0].cloudTarget] : [],
}];

type RecordDraft = {
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority: number;
  proxied: boolean;
  aliLine: string;
  aliWeight: string;
  aliStatus: "Enable" | "Disable";
};

const initialDraft: RecordDraft = {
  type: "A",
  name: "",
  content: "",
  ttl: 300,
  priority: 10,
  proxied: false,
  aliLine: "default",
  aliWeight: "",
  aliStatus: "Enable",
};

export default function ZoneRecordsPage() {
  const { zoneId } = useParams<{ zoneId: string }>();
  const recordsResource = useResource<DnsRecord[]>(`/v1/zones/${zoneId}/records`, previewRecords);
  const bindingsResource = useResource<ZoneBinding[]>(`/v1/zones/${zoneId}/bindings`, previewBindings);
  const zones = useResource<ZoneListRow[]>("/v1/zones", demoZones);
  const { data, setData, loading, error, reload } = recordsResource;
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<DnsRecord | "new" | null>(null);
  const [deleting, setDeleting] = useState<DnsRecord | null>(null);
  const [draft, setDraft] = useState<RecordDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [createdPoolId, setCreatedPoolId] = useState<string | null>(null);
  const [deletingBinding, setDeletingBinding] = useState<ZoneBinding | null>(null);
  const [source, setSource] = useState<"manual" | "cloud">("manual");
  const [cloudSlotId, setCloudSlotId] = useState("");
  const [takeoverConfirmed, setTakeoverConfirmed] = useState(false);
  const saveIntentKey = useRef(createIntentKey());
  const deleteIntentKey = useRef(createIntentKey());
  const records = useMemo(() => (data ?? []).filter((record) => `${record.name} ${record.type} ${record.content}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const zone = zones.data?.find((row) => row.zone.id === zoneId);

  const openEditor = (record?: DnsRecord) => {
    saveIntentKey.current.reset();
    setActionError(null);
    setActionNotice(null);
    setCreatedPoolId(null);
    setSource("manual");
    setCloudSlotId("");
    setTakeoverConfirmed(false);
    setEditing(record ?? "new");
    setDraft(record ? {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority ?? 10,
      proxied: record.providerMetadata.proxied === true,
      aliLine: typeof record.providerMetadata.line === "string" ? record.providerMetadata.line : "default",
      aliWeight: typeof record.providerMetadata.weight === "number" ? String(record.providerMetadata.weight) : "",
      aliStatus: String(record.providerMetadata.status ?? "Enable").toLowerCase().startsWith("dis") ? "Disable" : "Enable",
    } : initialDraft);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      if (source === "cloud") {
        if (!cloudSlotId || !["A", "AAAA"].includes(draft.type)) throw new Error("请选择匹配地址族的云地址槽位");
        if (editing !== "new" && !takeoverConfirmed) throw new Error("请确认将现有记录转换为 Pool 受管记录");
        if (!UI_PREVIEW) {
          const result = await submitCloudIntent(saveIntentKey.current, (key) => api<{ awaitingExternalVerification: boolean; pool: { id: string } }>(`/v1/address-slots/${cloudSlotId}/bindings`, {
            method: "POST",
            headers: { "idempotency-key": key },
            ...jsonBody({ zoneId, fqdn: draft.name, recordType: draft.type, takeoverExisting: editing !== "new" }),
          }));
          setActionNotice(result.awaitingExternalVerification ? "云地址来源已绑定，正在等待外部验证；尚未确认发布。" : "云地址来源已绑定。");
          setCreatedPoolId(result.pool.id);
          await Promise.all([reload(), bindingsResource.reload()]);
        } else {
          setActionNotice("云地址来源已绑定，正在等待外部验证；尚未确认发布。");
        }
        setEditing(null);
        return;
      }
      const metadata: Record<string, unknown> = editing && editing !== "new" ? { ...editing.providerMetadata } : {};
      if (zone?.provider === "cloudflare") {
        if (["A", "AAAA", "CNAME"].includes(draft.type)) metadata.proxied = draft.proxied;
        else delete metadata.proxied;
      }
      if (zone?.provider === "aliyun") {
        metadata.line = draft.aliLine;
        metadata.status = draft.aliStatus;
        if (draft.aliWeight) metadata.weight = Number(draft.aliWeight);
        else delete metadata.weight;
      }
      const body = {
        type: draft.type,
        name: draft.name,
        content: draft.content,
        ttl: draft.ttl,
        ...(["MX", "SRV"].includes(draft.type) ? { priority: draft.priority } : {}),
        providerMetadata: metadata,
      };
      if (!UI_PREVIEW) {
        await api(`/v1/zones/${zoneId}/records${editing !== "new" ? `/${editing?.id}` : ""}`, {
          method: editing === "new" ? "POST" : "PATCH",
          headers: { "idempotency-key": saveIntentKey.current.current() },
          ...jsonBody(body),
        });
        await reload();
      } else if (editing === "new") {
        setData([...(data ?? []), { id: `preview-${Date.now()}`, zoneId, externalId: "pending", ...body, priority: "priority" in body ? body.priority : null, management: "unmanaged", managedByPoolId: null, lastSyncedAt: new Date().toISOString(), deletedAt: null }]);
      } else if (editing) {
        setData((data ?? []).map((record) => record.id === editing.id ? { ...record, ...body, priority: "priority" in body ? body.priority : null } : record));
      }
      saveIntentKey.current.reset();
      setEditing(null);
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : "提交 DNS 变更失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setSaving(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) {
        await api(`/v1/zones/${zoneId}/records/${deleting.id}`, { method: "DELETE", headers: { "idempotency-key": deleteIntentKey.current.current() } });
        await reload();
      } else {
        setData((data ?? []).filter((record) => record.id !== deleting.id));
      }
      deleteIntentKey.current.reset();
      setDeleting(null);
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : "删除 DNS 记录失败");
    } finally {
      setSaving(false);
    }
  };

  const openDelete = (record: DnsRecord) => {
    deleteIntentKey.current.reset();
    setActionError(null);
    setDeleting(record);
  };

  const removeBinding = async () => {
    if (!deletingBinding) return;
    setSaving(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) {
        await api(`/v1/pools/${deletingBinding.poolId}/bindings/${deletingBinding.id}?unpublishedOnly=true`, { method: "DELETE" });
        await Promise.all([reload(), bindingsResource.reload()]);
      }
      setDeletingBinding(null);
      setActionNotice("已取消未发布的域名绑定。");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "取消绑定失败");
      await bindingsResource.reload();
    } finally { setSaving(false); }
  };

  const sync = async () => {
    setSyncing(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/zones/${zoneId}/sync`, { method: "POST" });
      await Promise.all([reload(), bindingsResource.reload()]);
    } catch (syncError) {
      setActionError(syncError instanceof Error ? syncError.message : "同步 Zone 失败");
    } finally {
      setSyncing(false);
    }
  };

  const zoneName = zone?.zone.nameAscii ?? data?.[0]?.name ?? zoneId;
  const provider = zone?.provider;

  return <ConsoleLayout>
    <div className="detail-header">
      <div className="detail-title"><Link className="icon-button" href="/zones" aria-label="返回 Zone"><ArrowLeft size={17} /></Link><div><h1>{zoneName}</h1><p>DNS 记录 · {records.length} 条</p></div></div>
      <div className="detail-actions"><Button variant="secondary" icon={<RefreshCw size={14} />} disabled={syncing} onClick={() => void sync()}>{syncing ? "已入队" : "同步云端"}</Button><Button icon={<Plus size={15} />} onClick={() => openEditor()}>添加记录</Button></div>
    </div>
    {actionError && <div className="inline-error" role="alert">{actionError}</div>}
    {actionNotice && <div className="inline-notice" role="status">{actionNotice}{createdPoolId && <> <Link href={`/pools/${createdPoolId}`}>打开对应 Pool 管理绑定</Link></>}</div>}
    {bindingsResource.error && <div className="surface"><ErrorState message={bindingsResource.error} onRetry={() => void bindingsResource.reload()} /></div>}
    {!!bindingsResource.data?.length && <section className="surface">
      <header className="surface-header"><div><h2>受管域名绑定</h2><p>未发布的绑定仍保留在这里；验证通过后才会出现在下方 DNS 记录中。</p></div><Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void Promise.all([reload(), bindingsResource.reload()])}>刷新状态</Button></header>
      <div className="table-wrap"><table><thead><tr><th>域名</th><th>地址来源</th><th>发布状态</th><th>管理</th></tr></thead><tbody>
        {bindingsResource.data.filter(binding => `${binding.fqdn} ${binding.recordType} ${binding.poolName}`.toLowerCase().includes(search.toLowerCase())).map(binding => <tr key={binding.id}>
          <td><div className="table-primary"><strong>{binding.fqdn}</strong><small>{binding.recordType}</small></div></td>
          <td>{binding.cloudSources.length ? binding.cloudSources.map(source => <div className="table-primary" key={source.slot.id}><strong>{cloudTargetLabel(source)}</strong><small>{cloudTargetAddresses(source)}</small></div>) : binding.poolName}</td>
          <td><div className="table-primary"><strong>{binding.published ? "已发布" : "尚未发布"}</strong><small>{binding.waitingReason ?? (binding.state === "failed" ? "协调失败，请查看 Pool 操作记录" : "由 Pool 管理")}</small></div></td>
          <td><div className="row-actions"><Link href={`/pools/${binding.poolId}`}>管理绑定</Link>{!binding.published && <Button variant="danger" disabled={binding.cancellationBlocked || saving} onClick={() => { setActionError(null); setDeletingBinding(binding); }}>取消绑定</Button>}</div></td>
        </tr>)}
      </tbody></table></div>
    </section>}
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索 DNS 记录" placeholder="名称、类型或内容" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><span className="muted">受管记录需在 IP Pool 中修改</span></div></div>
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : records.length === 0 ? <div className="surface"><EmptyState title="没有 DNS 记录" action={<Button icon={<Plus size={14} />} onClick={() => openEditor()}>添加记录</Button>} /></div> : <div className="table-wrap"><table>
      <thead><tr><th>名称</th><th>类型</th><th>内容</th><th>TTL</th><th>厂商属性</th><th>管理方式</th><th>同步</th><th aria-label="操作" /></tr></thead>
      <tbody>{records.map((record) => <tr key={record.id}>
        <td><div className="table-primary"><strong>{record.name}</strong><small className="mono">{record.externalId}</small></div></td>
        <td><strong>{record.type}</strong></td>
        <td className="mono">{record.content}</td>
        <td>{record.ttl === 1 ? "自动" : `${record.ttl}s`}</td>
        <td className="muted">{providerMetadataLabel(provider, record.providerMetadata)}</td>
        <td>{record.management === "managed" ? <Link href={`/pools/${record.managedByPoolId}`} className="status status-warning"><LockKeyhole size={11} />Pool 受管 · 管理</Link> : <span className="status status-neutral"><i />手动</span>}</td>
        <td className="muted"><RelativeTime value={record.lastSyncedAt} /></td>
        <td><div className="row-actions"><IconButton label="编辑记录" disabled={record.management === "managed"} onClick={() => openEditor(record)}><Edit3 size={15} /></IconButton><IconButton label="删除记录" disabled={record.management === "managed"} onClick={() => openDelete(record)}><Trash2 size={15} /></IconButton></div></td>
      </tr>)}</tbody>
    </table></div>}

    <Dialog open={editing !== null} title={editing === "new" ? "添加 DNS 记录" : "编辑 DNS 记录"} onClose={() => setEditing(null)} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button type="submit" form="record-form" disabled={saving || (source === "cloud" && editing !== "new" && !takeoverConfirmed)}>{saving ? "提交中" : "提交变更"}</Button></>}>
      <form id="record-form" className="field-grid" onSubmit={save}>
        <Field label="记录类型"><select value={draft.type} disabled={source === "cloud" && editing !== "new"} onChange={(event) => { setDraft({ ...draft, type: event.target.value }); setCloudSlotId(""); if (!["A", "AAAA"].includes(event.target.value)) setSource("manual"); }}>{["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "SRV", "NS"].map((type) => <option key={type}>{type}</option>)}</select></Field>
        <Field label={source === "cloud" ? "TTL（由绑定策略管理）" : "TTL"}><input type="number" min={1} max={86400} value={draft.ttl} disabled={source === "cloud"} onChange={(event) => setDraft({ ...draft, ttl: Number(event.target.value) })} /></Field>
        <Field label="名称"><input placeholder="api 或完整域名" value={draft.name} disabled={source === "cloud" && editing !== "new"} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></Field>
        {["A", "AAAA"].includes(draft.type) && <Field label="地址来源"><select value={source} onChange={(event) => { setSource(event.target.value as "manual" | "cloud"); setCloudSlotId(""); setTakeoverConfirmed(false); }}><option value="manual">手工地址</option><option value="cloud">云实例地址槽位</option></select></Field>}
        {source === "cloud" && ["A", "AAAA"].includes(draft.type) ? <CloudSourcePicker recordType={draft.type as "A" | "AAAA"} {...(zone?.ownerUserId ? { ownerUserId: zone.ownerUserId } : {})} {...(editing && editing !== "new" ? { existingAddress: editing.content } : {})} value={cloudSlotId} onChange={setCloudSlotId} /> : <Field label="内容"><input className="mono" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} required /></Field>}
        {source === "cloud" && editing && editing !== "new" && <label className="check-row span-2"><input type="checkbox" checked={takeoverConfirmed} onChange={(event) => setTakeoverConfirmed(event.target.checked)} /><span><strong>确认接管现有记录</strong><small>记录名称和类型保持不变；地址必须与所选槽位一致。接管后该记录转换为 Pool 受管，后续需在 IP Pool 中修改。</small></span></label>}
        {["MX", "SRV"].includes(draft.type) && <Field label="优先级"><input type="number" min={0} max={65535} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} /></Field>}
        {source === "manual" && provider === "cloudflare" && ["A", "AAAA", "CNAME"].includes(draft.type) && <div className="switch-row"><span>Cloudflare Proxy</span><Switch checked={draft.proxied} label="切换 Cloudflare Proxy" onCheckedChange={(proxied) => setDraft({ ...draft, proxied })} /></div>}
        {source === "manual" && provider === "aliyun" && <><Field label="解析线路"><input value={draft.aliLine} onChange={(event) => setDraft({ ...draft, aliLine: event.target.value })} required /></Field><Field label="权重（可选）"><input type="number" min={1} max={100} value={draft.aliWeight} onChange={(event) => setDraft({ ...draft, aliWeight: event.target.value })} /></Field><Field label="记录状态"><select value={draft.aliStatus} onChange={(event) => setDraft({ ...draft, aliStatus: event.target.value as "Enable" | "Disable" })}><option value="Enable">启用</option><option value="Disable">停用</option></select></Field></>}
        {actionError && <div className="login-error span-2" role="alert">{actionError}</div>}
      </form>
    </Dialog>
    <Dialog open={deleting !== null} title="删除 DNS 记录" size="small" onClose={() => setDeleting(null)} footer={<><Button variant="secondary" onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={saving} onClick={() => void remove()}>删除</Button></>}>{actionError && <div className="login-error" role="alert">{actionError}</div>}<p className="confirm-copy">将从云厂商删除 <strong>{deleting?.name}</strong>，操作会保留历史并可通过回滚重新创建。</p></Dialog>
    <Dialog open={deletingBinding !== null} title="取消未发布绑定" size="small" onClose={() => setDeletingBinding(null)} footer={<><Button variant="secondary" onClick={() => setDeletingBinding(null)}>返回</Button><Button variant="danger" disabled={saving} onClick={() => void removeBinding()}>取消绑定</Button></>}>
      {actionError && <div className="login-error" role="alert">{actionError}</div>}<p className="confirm-copy">取消 <strong>{deletingBinding?.fqdn}</strong> 的托管配置。发布正在执行或结果尚未确认时，取消会被阻止，请先处理相关 DNS 操作。</p>
    </Dialog>
  </ConsoleLayout>;
}

function providerMetadataLabel(provider: ZoneListRow["provider"] | undefined, metadata: Record<string, unknown>) {
  if (provider === "cloudflare") return metadata.proxied === true ? "Proxy 开启" : "DNS only";
  if (provider === "aliyun") return `${String(metadata.line ?? "default")} · ${String(metadata.status ?? "Enable")}${typeof metadata.weight === "number" ? ` · 权重 ${metadata.weight}` : ""}`;
  return "-";
}
