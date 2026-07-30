"use client";

import { Ban, Copy, ExternalLink, RadioTower, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, EmptyState, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { api, jsonBody, relativeTime, UI_PREVIEW } from "../../lib/api";
import { demoPoolDetail } from "../../lib/demo";
import type { DdnsAgent, Endpoint, Pool, PoolDetail } from "../../lib/types";

type DdnsRow = { pool: Pool; endpoint: Endpoint; agent: DdnsAgent };

const previewAgent: DdnsAgent = {
  id: "agent-1",
  endpointId: "ep-2",
  status: "active",
  agentVersion: "1.0.0",
  hostname: "edge-sg-02",
  hasRuntimeToken: true,
  installTokenExpiresAt: null,
  installTokenUsedAt: "2026-07-30T04:00:00.000Z",
  lastSeenAt: "2026-07-30T04:55:00.000Z",
  lastIpChangedAt: "2026-07-29T18:20:00.000Z",
  revokedAt: null,
  createdAt: "2026-07-20T04:00:00.000Z",
};

export default function DdnsPage() {
  const previewRows = demoPoolDetail.endpoints
    .filter((endpoint) => endpoint.addressMode === "ddns")
    .map((endpoint) => ({ pool: demoPoolDetail.pool, endpoint, agent: { ...previewAgent, endpointId: endpoint.id } }));
  const [rows, setRows] = useState<DdnsRow[] | null>(UI_PREVIEW ? previewRows : null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<DdnsRow | null>(null);
  const [busyEndpointId, setBusyEndpointId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (UI_PREVIEW) return;
    setError(null);
    try {
      setRows(await fetchDdnsRows());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "DDNS Agent 加载失败");
    }
  }, []);

  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    fetchDdnsRows().then((loaded) => {
      if (active) setRows(loaded);
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "DDNS Agent 加载失败");
    });
    return () => { active = false; };
  }, []);

  const install = async (row: DdnsRow) => {
    setBusyEndpointId(row.endpoint.id);
    setError(null);
    try {
      if (UI_PREVIEW) {
        setCommand("curl -fsSL 'https://dns.internal/api/v1/ddns/install.sh' | sudo sh -s -- install --url 'https://dns.internal' --token 'one-time-token'");
      } else {
        const result = await api<{ command: string }>(`/v1/pools/${row.pool.id}/endpoints/${row.endpoint.id}/ddns/install-token`, {
          method: "POST",
          ...jsonBody({ expiresInSeconds: 900 }),
        });
        setCommand(result.command);
        await load();
      }
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : "生成安装命令失败");
    } finally {
      setBusyEndpointId(null);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusyEndpointId(revokeTarget.endpoint.id);
    setError(null);
    try {
      if (!UI_PREVIEW) {
        await api(`/v1/pools/${revokeTarget.pool.id}/endpoints/${revokeTarget.endpoint.id}/ddns/revoke`, { method: "POST" });
        await load();
      } else {
        setRows((current) => current?.map((row) => row.endpoint.id === revokeTarget.endpoint.id ? { ...row, agent: { ...row.agent, status: "disabled", hasRuntimeToken: false, revokedAt: new Date().toISOString() } } : row) ?? null);
      }
      setRevokeTarget(null);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "吊销 Agent 失败");
    } finally {
      setBusyEndpointId(null);
    }
  };

  return <ConsoleLayout>
    <PageHeader title="DDNS Agent" description="Agent 绑定节点，候选地址通过健康检查后才发布" actions={<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>刷新</Button>} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!rows ? <div className="surface"><LoadingState /></div> : rows.length === 0 ? <div className="surface"><EmptyState title="没有 DDNS 动态节点" /></div> : <div className="table-wrap"><table>
      <thead><tr><th>Agent 节点</th><th>Pool</th><th>当前地址</th><th>Agent</th><th>最后心跳</th><th>健康</th><th aria-label="操作" /></tr></thead>
      <tbody>{rows.map((row) => {
        const current = row.endpoint.addresses.filter((address) => address.state === "current");
        const candidate = row.endpoint.addresses.filter((address) => address.state === "candidate");
        return <tr key={row.endpoint.id}>
          <td><div className="table-primary"><strong>{row.endpoint.name}</strong><small><RadioTower size={11} /> {row.agent.hostname ?? "尚未上报主机名"}</small></div></td>
          <td><Link href={`/pools/${row.pool.id}`}>{row.pool.name}</Link></td>
          <td><div className="address-stack">{current.map((address) => <span className="mono" key={address.id}>{address.address}</span>)}{candidate.length > 0 && <span className="status status-warning">候选待验证</span>}</div></td>
          <td><div className="table-primary"><StatusBadge value={row.agent.status} /><small>{row.agent.agentVersion ? `v${row.agent.agentVersion}` : row.agent.hasRuntimeToken ? "已兑换 Token" : "待安装"}</small></div></td>
          <td className="muted">{relativeTime(row.agent.lastSeenAt)}</td>
          <td><StatusBadge value={row.endpoint.healthState} /></td>
          <td><div className="row-actions">
            <Button variant="ghost" icon={<RadioTower size={14} />} disabled={busyEndpointId === row.endpoint.id} onClick={() => void install(row)}>{row.agent.hasRuntimeToken ? "重装" : "安装"}</Button>
            {row.agent.status === "active" && <IconButton label="吊销 DDNS Agent" disabled={busyEndpointId === row.endpoint.id} onClick={() => setRevokeTarget(row)}><Ban size={15} /></IconButton>}
            <Link className="icon-button" href={`/pools/${row.pool.id}`} aria-label="打开节点所属 Pool"><ExternalLink size={15} /></Link>
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>}

    <Dialog open={command !== null} title="Linux 一键安装" size="large" onClose={() => setCommand(null)} footer={<><Button variant="secondary" icon={<Copy size={14} />} onClick={() => command && navigator.clipboard.writeText(command)}>复制命令</Button><Button onClick={() => setCommand(null)}>完成</Button></>}><div className="code-box">{command}</div></Dialog>
    <Dialog open={revokeTarget !== null} title="吊销 DDNS Agent" size="small" onClose={() => setRevokeTarget(null)} footer={<><Button variant="secondary" onClick={() => setRevokeTarget(null)}>取消</Button><Button variant="danger" disabled={busyEndpointId !== null} onClick={() => void revoke()}>吊销 Token</Button></>}><p className="confirm-copy">吊销 <strong>{revokeTarget?.endpoint.name}</strong> 的运行 Token。当前 DNS 与节点地址保持不变，服务器下次心跳将被拒绝。</p></Dialog>
  </ConsoleLayout>;
}

async function fetchDdnsRows(): Promise<DdnsRow[]> {
  const pools = await api<Pool[]>("/v1/pools");
  const details = await Promise.all(pools.map((pool) => api<PoolDetail>(`/v1/pools/${pool.id}`)));
  const dynamic = details.flatMap((detail) => detail.endpoints
    .filter((endpoint) => endpoint.addressMode === "ddns")
    .map((endpoint) => ({ pool: detail.pool, endpoint })));
  return Promise.all(dynamic.map(async (row) => ({
    ...row,
    agent: await api<DdnsAgent>(`/v1/pools/${row.pool.id}/endpoints/${row.endpoint.id}/ddns`),
  })));
}
