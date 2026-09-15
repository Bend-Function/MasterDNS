"use client";

import { ExternalLink, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { RelativeTime } from "../../components/relative-time";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { api, UI_PREVIEW } from "../../lib/api";
import { demoCloudInstances } from "../../lib/cloud-demo";
import type { CloudAccount, CloudInstanceDetail, CloudInstanceRow } from "../../lib/cloud-types";
import { loadVisibleInstanceAddresses } from "../../lib/cloud-ui";
import { createRequestGeneration } from "../../lib/session-state";

export default function CloudInstancesPage() {
  const [rows, setRows] = useState<CloudInstanceRow[]>(UI_PREVIEW ? demoCloudInstances : []);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Record<string, CloudInstanceDetail["addresses"]>>({});
  const [addressErrors, setAddressErrors] = useState<Record<string, string>>({});
  const [addressLoading, setAddressLoading] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const inventoryGeneration = useRef(createRequestGeneration());

  const load = useCallback(async () => {
    const generation = inventoryGeneration.current.invalidate();
    setAddresses({}); setAddressErrors({}); setAddressLoading(null);
    if (UI_PREVIEW) { setRows(demoCloudInstances); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const next = await fetchCloudInstances();
      if (inventoryGeneration.current.isCurrent(generation)) setRows(next);
    } catch (value) { if (inventoryGeneration.current.isCurrent(generation)) setError(value instanceof Error ? value.message : "实例清单加载失败"); }
    finally { if (inventoryGeneration.current.isCurrent(generation)) setLoading(false); }
  }, []);

  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    const generation = inventoryGeneration.current.current();
    fetchCloudInstances().then((value) => { if (active && inventoryGeneration.current.isCurrent(generation)) setRows(value); }).catch((value) => { if (active && inventoryGeneration.current.isCurrent(generation)) setError(value instanceof Error ? value.message : "实例清单加载失败"); }).finally(() => { if (active && inventoryGeneration.current.isCurrent(generation)) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (UI_PREVIEW) return; const refresh = () => void load(); window.addEventListener("masterdns:invalidate", refresh); return () => window.removeEventListener("masterdns:invalidate", refresh); }, [load]);
  const regions = useMemo(() => [...new Set(rows.map((row) => row.instance.region))].sort(), [rows]);
  const visible = useMemo(() => rows.filter(({ instance, account }) => (!region || instance.region === region) && `${instance.name ?? ""} ${instance.externalId} ${instance.service} ${instance.region} ${account?.name ?? ""}`.toLowerCase().includes(search.toLowerCase())), [region, rows, search]);
  const loadAddresses = async (row: CloudInstanceRow) => {
    const generation = inventoryGeneration.current.current();
    setAddressLoading(row.instance.id);
    const result = await loadVisibleInstanceAddresses([row], 1, async (id) => (await api<CloudInstanceDetail>(`/v1/cloud-instances/${id}`)).addresses);
    if (!inventoryGeneration.current.isCurrent(generation)) return;
    setAddresses((current) => ({ ...current, ...result.addresses }));
    setAddressErrors((current) => { const next = { ...current }; delete next[row.instance.id]; return { ...next, ...result.errors }; });
    setAddressLoading(null);
  };

  return <ConsoleLayout><PageHeader title="云实例" description="AWS 实际清单、作用域和显式管理授权" actions={<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>刷新清单</Button>} />
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索云实例" placeholder="名称、实例 ID、服务或区域" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><select aria-label="按区域筛选" value={region} onChange={(event) => setRegion(event.target.value)}><option value="">所有区域</option>{regions.map((value) => <option key={value}>{value}</option>)}</select></div></div>
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={() => void load()} /></div> : visible.length === 0 ? <div className="surface"><EmptyState title="没有匹配的云实例" /></div> : <div className="table-wrap"><table><thead><tr><th>实例</th><th>账号</th><th>服务 / 区域</th><th>实际地址</th><th>远端状态</th><th>清单</th><th>管理授权</th><th>最近发现</th><th aria-label="操作" /></tr></thead><tbody>{visible.map((row) => { const { instance, authorization, inScope, account } = row;
      const present = instance.metadata.present !== false; const available = Boolean(account?.enabled && inScope && present);
      const actual = addresses[instance.id] ?? row.addresses;
      return <tr key={instance.id}><td><Link className="table-primary" href={`/cloud-instances/${instance.id}`}><strong>{instance.name ?? instance.externalId}</strong><small className="mono">{instance.externalId}</small></Link></td><td>{account?.name ?? instance.accountId}</td><td><div className="table-primary"><strong>{instance.service === "ec2" ? "EC2" : "Lightsail"}</strong><small>{instance.region}</small></div></td><td><div className="table-primary">{actual ? actual.filter((address) => address.kind === undefined || address.kind === "host").map((address) => <small className="mono" key={address.id}>{address.address}</small>) : <Button variant="ghost" disabled={addressLoading === instance.id} onClick={() => void loadAddresses(row)}>{addressLoading === instance.id ? "加载中" : "加载实际地址"}</Button>}{addressErrors[instance.id] && <small className="inline-error">{addressErrors[instance.id]}</small>}</div></td><td><StatusBadge value={instance.state ?? "unknown"} /></td><td><StatusBadge value={available ? "active" : present ? "excluded" : "absent"} /></td><td><StatusBadge value={authorization?.managed ? "active" : "disabled"} /></td><td className="muted"><RelativeTime value={instance.lastSeenAt} /></td><td><Link className="icon-button" aria-label="查看实例详情" href={`/cloud-instances/${instance.id}`}><ExternalLink size={15} /></Link></td></tr>;
    })}</tbody></table></div>}
  </ConsoleLayout>;
}

async function fetchCloudInstances() {
  const accounts = await api<CloudAccount[]>("/v1/cloud-accounts");
  const groups = await Promise.all(accounts.map(async (account) => {
    const rows = await api<CloudInstanceRow[]>(`/v1/cloud-accounts/${account.id}/instances`);
    return rows.map((row) => ({ ...row, account }));
  }));
  return groups.flat();
}
