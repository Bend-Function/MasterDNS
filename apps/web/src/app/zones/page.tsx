"use client";

import { Cloud, ExternalLink, Plus, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { ZoneCreateDialog } from "../../components/zone-create-dialog";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, UI_PREVIEW } from "../../lib/api";
import { demoAccounts, demoZones } from "../../lib/demo";
import type { ProviderAccount, ZoneListRow } from "../../lib/types";

export default function ZonesPage() {
  const { data, loading, error, reload } = useResource<ZoneListRow[]>("/v1/zones", demoZones);
  const accounts = useResource<ProviderAccount[]>("/v1/provider-accounts", demoAccounts);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const rows = useMemo(() => (data ?? []).filter((row) => `${row.zone.nameAscii} ${row.accountName}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const sync = async (zoneId: string) => {
    setSyncing(zoneId);
    if (!UI_PREVIEW) await api(`/v1/zones/${zoneId}/sync`, { method: "POST" });
    setSyncing(null); void reload();
  };
  return <ConsoleLayout>
    <PageHeader title="域名与解析" description="Cloudflare 与阿里云 Zone 的统一记录清单" actions={<><Link className="button button-secondary" href="/accounts"><Cloud size={15} /><span>接入云账号</span></Link><Button icon={<Plus size={15} />} disabled={accounts.loading || !!accounts.error} onClick={() => setCreating(true)}>新增域名</Button></>} />
    {accounts.error && <div className="surface"><ErrorState message={accounts.error} onRetry={() => void accounts.reload()} /></div>}
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索域名" placeholder="搜索 Zone 或账号" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void reload()}>刷新</Button></div></div>
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : <div className="table-wrap"><table><thead><tr><th>Zone</th><th>云厂商</th><th>账号</th><th>状态</th><th>最近同步</th><th aria-label="操作" /></tr></thead><tbody>
      {rows.map((row) => <tr key={row.zone.id}><td><Link className="table-primary" href={`/zones/${row.zone.id}`}><strong>{row.zone.nameAscii}</strong><small className="mono">{row.zone.id.slice(0, 12)}</small></Link></td><td><span className={`provider-mark ${row.provider === "cloudflare" ? "provider-cf" : "provider-ali"}`}>{row.provider === "cloudflare" ? "CF" : "ALI"}</span></td><td>{row.accountName}</td><td><StatusBadge value={row.zone.status} /></td><td className="muted"><RelativeTime value={row.zone.lastSyncedAt} /></td><td><div className="row-actions"><Button variant="ghost" icon={<RefreshCw size={14} />} disabled={syncing === row.zone.id} onClick={() => void sync(row.zone.id)}>同步</Button><Link className="icon-button" aria-label={`打开 ${row.zone.nameAscii}`} title="打开" href={`/zones/${row.zone.id}`}><ExternalLink size={15} /></Link></div></td></tr>)}
    </tbody></table></div>}
    {!loading && !error && rows.length === 0 && <div className="surface"><EmptyState title={search ? "没有匹配的域名" : "暂无域名，接入账号后同步或添加 Cloudflare 域名"} /></div>}
    {creating && <ZoneCreateDialog accounts={accounts.data ?? []} zones={data ?? []} onClose={() => setCreating(false)} onChanged={() => void reload()} />}
  </ConsoleLayout>;
}
