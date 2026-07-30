"use client";

import { Cloud, ExternalLink, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { Button, ErrorState, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, UI_PREVIEW } from "../../lib/api";
import { demoZones } from "../../lib/demo";
import type { ZoneListRow } from "../../lib/types";

export default function ZonesPage() {
  const { data, loading, error, reload } = useResource<ZoneListRow[]>("/v1/zones", demoZones);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const rows = useMemo(() => (data ?? []).filter((row) => `${row.zone.nameAscii} ${row.accountName}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const sync = async (zoneId: string) => {
    setSyncing(zoneId);
    if (!UI_PREVIEW) await api(`/v1/zones/${zoneId}/sync`, { method: "POST" });
    setSyncing(null); void reload();
  };
  return <ConsoleLayout>
    <PageHeader title="域名与解析" description="Cloudflare 与阿里云 Zone 的统一记录清单" actions={<Link className="button button-primary" href="/accounts"><Cloud size={15} /><span>接入云账号</span></Link>} />
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索域名" placeholder="搜索 Zone 或账号" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void reload()}>刷新</Button></div></div>
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void reload()} /></div> : <div className="table-wrap"><table><thead><tr><th>Zone</th><th>云厂商</th><th>账号</th><th>状态</th><th>最近同步</th><th aria-label="操作" /></tr></thead><tbody>
      {rows.map((row) => <tr key={row.zone.id}><td><Link className="table-primary" href={`/zones/${row.zone.id}`}><strong>{row.zone.nameAscii}</strong><small className="mono">{row.zone.id.slice(0, 12)}</small></Link></td><td><span className={`provider-mark ${row.provider === "cloudflare" ? "provider-cf" : "provider-ali"}`}>{row.provider === "cloudflare" ? "CF" : "ALI"}</span></td><td>{row.accountName}</td><td><StatusBadge value={row.zone.status} /></td><td className="muted"><RelativeTime value={row.zone.lastSyncedAt} /></td><td><div className="row-actions"><Button variant="ghost" icon={<RefreshCw size={14} />} disabled={syncing === row.zone.id} onClick={() => void sync(row.zone.id)}>同步</Button><Link className="icon-button" aria-label={`打开 ${row.zone.nameAscii}`} title="打开" href={`/zones/${row.zone.id}`}><ExternalLink size={15} /></Link></div></td></tr>)}
    </tbody></table></div>}
  </ConsoleLayout>;
}
