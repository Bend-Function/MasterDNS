"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { MonthlyTraffic, MonthlyTrafficResponse } from "@masterdns/contracts";
import { api, UI_PREVIEW } from "../lib/api";
import { Button } from "./ui";

const reasons: Record<Extract<MonthlyTrafficResponse, { status: "unavailable" }>["reason"], string> = {
  account_disabled: "云账号已停用，无法查询流量。",
  out_of_scope: "实例已排除在账号区域范围外。",
  resource_not_found: "云端实例已不存在，无法查询流量。",
  permission_denied: "云账号缺少流量监控读取权限，请补充权限后重试。",
  invalid_credentials: "云账号凭证无效，请更新凭证后重试。",
  credentials_expired: "云账号凭证已过期，请更新凭证后重试。",
  rate_limited: "云厂商请求限流，请稍后重试。",
  remote_identity_changed: "云账号或实例身份已变化，请重新同步云账号。",
  query_failed: "暂时无法获取流量数据，请稍后重试。",
};

function bytes(value: number | null): string {
  if (value === null) return "暂无数据";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const power = Math.max(0, Math.min(Math.floor(Math.log10(value) / 3), units.length - 1));
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value / 1000 ** power)} ${units[power]}`;
}

const utcDate = (value: string) => new Date(value).toISOString().slice(0, 16).replace("T", " ");

export function CloudTrafficSummary({ traffic }: { traffic: MonthlyTraffic }) {
  const publicOnly = traffic.source === "linode";
  return <>
    <div className="metric-strip traffic-metrics">
      <div><span>本月入站{publicOnly ? "（公网）" : ""}</span><strong>{bytes(traffic.incomingBytes)}</strong><small>实例接收</small></div>
      <div><span>本月出站{publicOnly ? "（公网）" : ""}</span><strong>{bytes(traffic.outgoingBytes)}</strong><small>实例发送</small></div>
      <div><span>本月合计</span><strong>{bytes(traffic.totalBytes)}</strong><small>{publicOnly ? "公网入站 + 出站" : "入站 + 出站"}</small></div>
      <div><span>{traffic.allowance?.scope === "account_pool" ? "流量池贡献额度" : "套餐月额度"}</span><strong>{traffic.allowance ? `${new Intl.NumberFormat("zh-CN").format(traffic.allowance.gigabytes)} GB` : "—"}</strong><small>{traffic.allowance?.scope === "region_bundle" ? "同区域同套餐共享" : traffic.allowance?.scope === "account_pool" ? "计入账号共享流量池" : "未提供实例独立额度"}</small></div>
    </div>
    <div className="surface-body" style={{ paddingTop: 0 }}>
      <p className="muted">{publicOnly ? "Linode 公网流量统计；套餐额度计入共享流量池，不能用单台实例用量计算池内剩余额度。" : "统计所有网卡的监控流量（可能含内网），非账单用量。"}{traffic.source === "lightsail" ? " 套餐额度在同区域同套餐实例间共享，不据此推算剩余额度。" : ""}</p>
      <p className="muted">统计范围：{utcDate(traffic.periodStart)} 至 {utcDate(traffic.periodEnd)} UTC。云厂商数据可能延迟。</p>
      <p className="muted">获取时间：{utcDate(traffic.fetchedAt)} UTC · 查询结果最多缓存 5 分钟 · 流量按 1 GB = 1,000,000,000 B 展示，额度沿用厂商 GB 数值。</p>
    </div>
  </>;
}

function previewTraffic(): MonthlyTrafficResponse {
  const now = new Date();
  return { status: "available", traffic: { month: now.toISOString().slice(0, 7), periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), periodEnd: now.toISOString(), fetchedAt: now.toISOString(), source: "cloudwatch", incomingBytes: 38_200_000_000, outgoingBytes: 126_500_000_000, totalBytes: 164_700_000_000, allowance: null } };
}

export function CloudTrafficCard({ instanceId }: { instanceId: string }) {
  const [result, setResult] = useState<MonthlyTrafficResponse | null>(UI_PREVIEW ? previewTraffic : null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (UI_PREVIEW) return;
    const controller = new AbortController();
    api<MonthlyTrafficResponse>(`/v1/cloud-instances/${instanceId}/traffic`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult(value); })
      .catch(() => { if (!controller.signal.aborted) setError("流量查询失败，请重试。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [instanceId, revision]);
  const refresh = () => {
    if (UI_PREVIEW) { setResult(previewTraffic()); return; }
    setLoading(true); setError(null); setResult(null); setRevision(value => value + 1);
  };
  return <section className="surface" aria-label="月度流量" aria-busy={loading}>
    <header className="surface-header"><div><h2>月度流量{result?.status === "available" ? ` · ${result.traffic.month}` : ""}</h2><p>本月月初至今（UTC）{UI_PREVIEW ? " · 示例数据" : ""}</p></div><Button variant="secondary" icon={<RefreshCw size={14} />} disabled={loading} onClick={refresh}>{loading ? "查询中" : "刷新流量"}</Button></header>
    {loading ? <div className="surface-body muted" role="status">正在读取云厂商流量数据…</div> : error ? <div className="surface-body" role="alert">{error}</div> : result?.status === "unavailable" ? <div className="surface-body muted" role="status">{reasons[result.reason]}</div> : result?.status === "available" ? <CloudTrafficSummary traffic={result.traffic} /> : null}
  </section>;
}
