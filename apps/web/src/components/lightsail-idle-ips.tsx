"use client";

import { useEffect, useRef, useState } from "react";
import type { IdleIpItem, IdleIpPreview } from "@masterdns/contracts";
import { api, formatDate } from "../lib/api";
import type { CloudAccount } from "../lib/cloud-types";
import { Button, Dialog, EmptyState, LoadingState } from "./ui";

const terminal = (item: IdleIpItem) => ["released", "missing", "skipped", "failed"].includes(item.status);
const statusLabels: Record<IdleIpItem["status"], string> = { ready: "待释放", waiting: "等待额度", in_flight: "正在释放", pending: "待云端确认", released: "已释放", missing: "已不存在", skipped: "已跳过", failed: "失败" };
const reasonLabels: Record<string, string> = {
  managed_dns_reference: "受管 DNS 仍引用此 IP", pending_dns_reference: "待执行 DNS 变更仍引用此 IP",
  rotation_in_progress: "轮换仍使用此 IP，或云操作尚未确认", cleanup_in_progress: "同区域清理尚未确认",
  attached: "已绑定实例", remote_identity_changed: "云端地址身份已变化", invalid_static_ip_identity: "地址身份信息不完整",
  release_pending: "等待云端确认释放结果", rotation_rate_limited: "等待换址额度", rate_limited: "云厂商限流",
  permission_denied: "云账号缺少权限", credentials_expired: "凭证已过期", invalid_credentials: "凭证无效",
  quota_exceeded: "云端配额限制", query_failed: "读取失败，请重试", temporary_cloud_error: "云端请求结果不明，需要复核",
};

export function IdleIpResults({ preview }: { preview: IdleIpPreview }) {
  return <>
    <p>扫描区域：{preview.regions.join("、") || "没有匹配区域"} · {formatDate(preview.createdAt)}</p>
    {preview.scanErrors.map(error => <p className="inline-warning" key={error.region}>{error.region}：扫描失败（{reasonLabels[error.reason] ?? error.reason}），该区域未执行清理。</p>)}
    {preview.items.length === 0 ? <EmptyState title="未发现可识别的未绑定静态 IP" /> : <div className="table-wrap"><table><thead><tr><th>区域 / 名称</th><th>公网 IP</th><th>状态</th><th>说明</th></tr></thead><tbody>{preview.items.map(item => <tr key={item.arn}><td>{item.region}<small className="muted"> · {item.name}</small></td><td className="mono">{item.address}</td><td>{statusLabels[item.status]}</td><td>{item.reason ? reasonLabels[item.reason] ?? item.reason : "—"}{item.retryAt && !terminal(item) && <small> · 可重试 {formatDate(item.retryAt)}</small>}</td></tr>)}</tbody></table></div>}
  </>;
}

export function LightsailIdleIps({ account, onClose }: { account: CloudAccount; onClose: () => void }) {
  const [history, setHistory] = useState<IdleIpPreview[]>([]);
  const [preview, setPreview] = useState<IdleIpPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const base = `/v1/cloud-accounts/${account.id}/lightsail-idle-ips`;
  useEffect(() => {
    const requests = generation;
    const request = ++requests.current;
    api<IdleIpPreview[]>(base).then(rows => { if (generation.current === request) { setHistory(rows); setPreview(rows[0] ?? null); } }).catch(value => { if (generation.current === request) setError(value instanceof Error ? value.message : "记录加载失败"); }).finally(() => { if (generation.current === request) setLoading(false); });
    return () => { requests.current++; };
  }, [base]);
  const close = () => { generation.current++; onClose(); };
  const scan = async () => {
    const request = ++generation.current; setBusy(true); setError(null); setNotice(null);
    try {
      const value = await api<IdleIpPreview>(`${base}/preview`, { method: "POST" });
      if (generation.current !== request) return;
      setPreview(value); setHistory(rows => [value, ...rows].slice(0, 20));
    } catch (value) { if (generation.current === request) setError(value instanceof Error ? value.message : "扫描失败"); }
    finally { if (generation.current === request) setBusy(false); }
  };
  const run = async () => {
    if (!preview || busy) return;
    const request = ++generation.current; setBusy(true); setError(null); setNotice(null);
    try {
      let current = preview.confirmedAt ? await api<IdleIpPreview>(`${base}/${preview.id}`) : await api<IdleIpPreview>(`${base}/${preview.id}/confirm`, { method: "POST" });
      // Each address has a durable claim. Retry requests observe uncertain releases.
      for (let round = 0; round < 3 && generation.current === request; round++) {
        for (let index = 0; index < current.items.length && generation.current === request; index++) {
          const item = current.items[index]!;
          if (terminal(item)) continue;
          if (!account.enabled && item.status !== "pending" && item.status !== "in_flight") continue;
          const wait = item.retryAt ? Date.parse(item.retryAt) - Date.now() : 0;
          if (wait > 30_000) continue;
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
          if (generation.current !== request) return;
          current = await api<IdleIpPreview>(`${base}/${current.id}/items/${index}`, { method: "POST" });
          if (generation.current !== request) return;
          setPreview(current);
        }
        if (current.items.every(terminal)) break;
      }
      if (generation.current === request) {
        setPreview(current); setHistory(rows => rows.map(row => row.id === current.id ? current : row));
        setNotice(current.items.every(terminal) ? "本批次已处理，请查看每个地址的结果。" : "部分地址仍在等待额度或云端确认，可稍后继续处理；不会重复发送结果不明的释放请求。");
      }
    } catch (value) { if (generation.current === request) setError(value instanceof Error ? value.message : "处理未完成，重新打开记录可继续复核"); }
    finally { if (generation.current === request) setBusy(false); }
  };
  return <Dialog open title={`Lightsail 闲置 IP · ${account.name}`} size="large" onClose={close} footer={<><Button variant="secondary" onClick={close}>关闭</Button><Button variant="secondary" disabled={!account.enabled || busy || loading} onClick={() => void scan()}>扫描闲置 IP</Button><Button variant="danger" disabled={busy || !preview || preview.items.every(terminal) || (!account.enabled && !preview.items.some(item => item.status === "pending" || item.status === "in_flight"))} onClick={() => void run()}>{busy ? "处理中…" : preview?.confirmedAt ? "继续处理 / 复核结果" : "确认释放全部可清理 IP"}</Button></>}>
    {!account.enabled && <p className="inline-warning">账号已停用，仅可查看记录和复核已发出的释放请求。</p>}
    <p>仅清理此账号配置区域内、当前未绑定实例的 Lightsail 静态 IP。执行前再次检查绑定、地址身份、轮换和受管 DNS 引用。释放后不能保证找回原 IP。</p>
    {history.length > 0 && <label className="field"><span>扫描与清理记录</span><select value={preview?.id ?? ""} disabled={busy} onChange={event => { setPreview(history.find(row => row.id === event.target.value) ?? null); setNotice(null); }}>{history.map(row => <option key={row.id} value={row.id}>{formatDate(row.createdAt)} · {row.items.length} 个 · {row.confirmedAt ? "已确认" : "预览"}</option>)}</select></label>}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <LoadingState /> : preview ? <IdleIpResults preview={preview} /> : <EmptyState title="点击扫描，预览闲置静态 IP" />}
    {busy && <p role="status">正在逐项核对与处理；关闭窗口会停止提交后续地址，已发出的请求仍会完成。</p>}
  </Dialog>;
}
