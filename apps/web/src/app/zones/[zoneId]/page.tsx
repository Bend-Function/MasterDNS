"use client";

import { ArrowLeft, Edit3, LockKeyhole, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../../components/console-layout";
import { RelativeTime } from "../../../components/relative-time";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState } from "../../../components/ui";
import { useResource } from "../../../hooks/use-resource";
import { api, jsonBody, UI_PREVIEW } from "../../../lib/api";
import { demoNow, demoZones } from "../../../lib/demo";
import type { DnsRecord, ZoneListRow } from "../../../lib/types";

const previewRecords: DnsRecord[] = [
  { id: "rec-1", zoneId: "zone-1", externalId: "cf-001", type: "A", name: "api.edge.example.com", content: "192.0.2.37", ttl: 60, priority: null, providerMetadata: { proxied: false }, management: "managed", managedByPoolId: "pool-1", lastSyncedAt: demoNow, deletedAt: null },
  { id: "rec-2", zoneId: "zone-1", externalId: "cf-002", type: "CNAME", name: "www.edge.example.com", content: "edge.example.com", ttl: 300, priority: null, providerMetadata: { proxied: true }, management: "unmanaged", managedByPoolId: null, lastSyncedAt: demoNow, deletedAt: null },
];

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
  const zones = useResource<ZoneListRow[]>("/v1/zones", demoZones);
  const { data, setData, loading, error, reload } = recordsResource;
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<DnsRecord | "new" | null>(null);
  const [deleting, setDeleting] = useState<DnsRecord | null>(null);
  const [draft, setDraft] = useState<RecordDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const records = useMemo(() => (data ?? []).filter((record) => `${record.name} ${record.type} ${record.content}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const zone = zones.data?.find((row) => row.zone.id === zoneId);

  const openEditor = (record?: DnsRecord) => {
    setActionError(null);
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
          headers: { "idempotency-key": crypto.randomUUID() },
          ...jsonBody(body),
        });
        await reload();
      } else if (editing === "new") {
        setData([...(data ?? []), { id: `preview-${Date.now()}`, zoneId, externalId: "pending", ...body, priority: "priority" in body ? body.priority : null, management: "unmanaged", managedByPoolId: null, lastSyncedAt: new Date().toISOString(), deletedAt: null }]);
      } else if (editing) {
        setData((data ?? []).map((record) => record.id === editing.id ? { ...record, ...body, priority: "priority" in body ? body.priority : null } : record));
      }
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
        await api(`/v1/zones/${zoneId}/records/${deleting.id}`, { method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() } });
        await reload();
      } else {
        setData((data ?? []).filter((record) => record.id !== deleting.id));
      }
      setDeleting(null);
    } catch (deleteError) {
      setActionError(deleteError instanceof Error ? deleteError.message : "删除 DNS 记录失败");
    } finally {
      setSaving(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/zones/${zoneId}/sync`, { method: "POST" });
      await reload();
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
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索 DNS 记录" placeholder="名称、类型或内容" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><span className="muted">受管记录需在 IP Pool 中修改</span></div></div>
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : records.length === 0 ? <div className="surface"><EmptyState title="没有 DNS 记录" action={<Button icon={<Plus size={14} />} onClick={() => openEditor()}>添加记录</Button>} /></div> : <div className="table-wrap"><table>
      <thead><tr><th>名称</th><th>类型</th><th>内容</th><th>TTL</th><th>厂商属性</th><th>管理方式</th><th>同步</th><th aria-label="操作" /></tr></thead>
      <tbody>{records.map((record) => <tr key={record.id}>
        <td><div className="table-primary"><strong>{record.name}</strong><small className="mono">{record.externalId}</small></div></td>
        <td><strong>{record.type}</strong></td>
        <td className="mono">{record.content}</td>
        <td>{record.ttl === 1 ? "自动" : `${record.ttl}s`}</td>
        <td className="muted">{providerMetadataLabel(provider, record.providerMetadata)}</td>
        <td>{record.management === "managed" ? <span className="status status-warning"><LockKeyhole size={11} />Pool 受管</span> : <span className="status status-neutral"><i />手动</span>}</td>
        <td className="muted"><RelativeTime value={record.lastSyncedAt} /></td>
        <td><div className="row-actions"><IconButton label="编辑记录" disabled={record.management === "managed"} onClick={() => openEditor(record)}><Edit3 size={15} /></IconButton><IconButton label="删除记录" disabled={record.management === "managed"} onClick={() => setDeleting(record)}><Trash2 size={15} /></IconButton></div></td>
      </tr>)}</tbody>
    </table></div>}

    <Dialog open={editing !== null} title={editing === "new" ? "添加 DNS 记录" : "编辑 DNS 记录"} onClose={() => setEditing(null)} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button type="submit" form="record-form" disabled={saving}>{saving ? "提交中" : "提交变更"}</Button></>}>
      <form id="record-form" className="field-grid" onSubmit={save}>
        <Field label="记录类型"><select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>{["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "SRV", "NS"].map((type) => <option key={type}>{type}</option>)}</select></Field>
        <Field label="TTL"><input type="number" min={1} max={86400} value={draft.ttl} onChange={(event) => setDraft({ ...draft, ttl: Number(event.target.value) })} /></Field>
        <Field label="名称"><input placeholder="api 或完整域名" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></Field>
        <Field label="内容"><input className="mono" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} required /></Field>
        {["MX", "SRV"].includes(draft.type) && <Field label="优先级"><input type="number" min={0} max={65535} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} /></Field>}
        {provider === "cloudflare" && ["A", "AAAA", "CNAME"].includes(draft.type) && <label className="switch-row"><span>Cloudflare Proxy</span><button type="button" className={`switch ${draft.proxied ? "on" : ""}`} aria-label="切换 Cloudflare Proxy" onClick={() => setDraft({ ...draft, proxied: !draft.proxied })} /></label>}
        {provider === "aliyun" && <><Field label="解析线路"><input value={draft.aliLine} onChange={(event) => setDraft({ ...draft, aliLine: event.target.value })} required /></Field><Field label="权重（可选）"><input type="number" min={1} max={100} value={draft.aliWeight} onChange={(event) => setDraft({ ...draft, aliWeight: event.target.value })} /></Field><Field label="记录状态"><select value={draft.aliStatus} onChange={(event) => setDraft({ ...draft, aliStatus: event.target.value as "Enable" | "Disable" })}><option value="Enable">启用</option><option value="Disable">停用</option></select></Field></>}
        {actionError && <div className="login-error span-2">{actionError}</div>}
      </form>
    </Dialog>
    <Dialog open={deleting !== null} title="删除 DNS 记录" size="small" onClose={() => setDeleting(null)} footer={<><Button variant="secondary" onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={saving} onClick={() => void remove()}>删除</Button></>}><p className="confirm-copy">将从云厂商删除 <strong>{deleting?.name}</strong>，操作会保留历史并可通过回滚重新创建。</p></Dialog>
  </ConsoleLayout>;
}

function providerMetadataLabel(provider: ZoneListRow["provider"] | undefined, metadata: Record<string, unknown>) {
  if (provider === "cloudflare") return metadata.proxied === true ? "Proxy 开启" : "DNS only";
  if (provider === "aliyun") return `${String(metadata.line ?? "default")} · ${String(metadata.status ?? "Enable")}${typeof metadata.weight === "number" ? ` · 权重 ${metadata.weight}` : ""}`;
  return "-";
}
