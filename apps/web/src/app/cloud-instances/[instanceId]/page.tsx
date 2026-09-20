"use client";

import { ArrowLeft, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../../components/console-layout";
import { ManualRotationButton } from "../../../components/manual-rotation-button";
import { RelativeTime } from "../../../components/relative-time";
import { Button, ErrorState, LoadingState, StatusBadge } from "../../../components/ui";
import { api, ApiError, jsonBody, UI_PREVIEW } from "../../../lib/api";
import { demoCloudAccounts, demoCloudInstanceDetail, demoCloudSlots } from "../../../lib/cloud-demo";
import type { AddressSlot, CloudAccount, CloudAuthorization, CloudInstanceDetail } from "../../../lib/cloud-types";
import { cloudTargetAddresses, authorizationPayload, capabilityReason, cloudProviderLabels, cloudServiceLabel, rotationDowntimeNotice } from "../../../lib/cloud-ui";

export default function CloudInstancePage() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const [detail, setDetail] = useState<CloudInstanceDetail | null>(UI_PREVIEW ? demoCloudInstanceDetail : null);
  const [account, setAccount] = useState<CloudAccount | null>(UI_PREVIEW ? demoCloudAccounts[0]! : null);
  const [slots, setSlots] = useState<AddressSlot[]>(UI_PREVIEW ? demoCloudSlots : []);
  const [draft, setDraft] = useState<CloudAuthorization>(UI_PREVIEW ? demoCloudInstanceDetail.authorization! : initialAuthorization(instanceId));
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = async () => {
    if (UI_PREVIEW) { setDetail(demoCloudInstanceDetail); setAccount(demoCloudAccounts[0]!); setSlots(demoCloudSlots); setDraft(demoCloudInstanceDetail.authorization ?? initialAuthorization(instanceId)); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const next = await api<CloudInstanceDetail>(`/v1/cloud-instances/${instanceId}`);
      const [accounts, nextSlots] = await Promise.all([api<CloudAccount[]>("/v1/cloud-accounts"), api<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(instanceId)}`)]);
      setDetail(next); setAccount(accounts.find((candidate) => candidate.id === next.instance.accountId) ?? null); setSlots(nextSlots); setDraft(next.authorization ?? initialAuthorization(instanceId));
    } catch (value) { setError(value instanceof Error ? value.message : "实例详情加载失败"); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    fetchInstance(instanceId).then(({ detail: next, account: nextAccount, slots: nextSlots }) => {
      if (!active) return;
      setDetail(next); setAccount(nextAccount); setSlots(nextSlots); setDraft(next.authorization ?? initialAuthorization(instanceId));
    }).catch((value) => { if (active) setError(value instanceof Error ? value.message : "实例详情加载失败"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [instanceId]);
  const present = detail?.instance.metadata.present !== false;
  const canManage = Boolean(account?.enabled && detail?.inScope && present);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setActionError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/cloud-instances/${instanceId}/authorization`, { method: "PATCH", ...jsonBody(authorizationPayload(draft)) });
      else setDetail((current) => current ? { ...current, authorization: { ...draft, revision: draft.revision + 1 } } : current);
      await load();
    } catch (value) {
      if (value instanceof ApiError && value.status === 409) { setActionError("授权已被其他操作更新，已重新加载最新状态"); await load(); }
      else setActionError(value instanceof Error ? value.message : "授权更新失败");
    } finally { setSaving(false); }
  };

  if (loading) return <ConsoleLayout><LoadingState /></ConsoleLayout>;
  if (error || !detail) return <ConsoleLayout><ErrorState message={error ?? "云实例不存在"} onRetry={() => void load()} /></ConsoleLayout>;
  const { instance, authorization, interfaces, addresses, inScope } = detail;
  const canRotateIpv4 = slots.some((entry) => entry.slot.family === "4" && entry.capability?.available === true);
  const canRotateIpv6 = slots.some((entry) => entry.slot.family === "6" && entry.capability?.available === true);

  return <ConsoleLayout><div className="detail-header"><div className="detail-title"><Link className="icon-button" href="/cloud-instances" aria-label="返回云实例"><ArrowLeft size={17} /></Link><div><h1>{account?.name ?? instance.accountId} - {instance.name ?? instance.externalId}</h1><p>{cloudServiceLabel(instance.service)} · {instance.region} · <span className="mono">{instance.externalId}</span></p></div></div><div className="detail-actions"><Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void load()}>刷新</Button></div></div>
    {actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <div className="content-grid"><div><section className="surface"><header className="surface-header"><div><h2>实际云资源</h2><p>最近一次完整清单读取结果</p></div><StatusBadge value={instance.state ?? "unknown"} /></header><div className="surface-body field-grid"><Info label="云账号" value={account ? `${account.name} · ${cloudProviderLabels[account.provider]}` : instance.accountId} /><Info label="远端 ID" value={instance.externalId} mono /><Info label="区域 / 可用区" value={`${instance.region}${typeof instance.metadata.availabilityZone === "string" ? ` / ${instance.metadata.availabilityZone}` : ""}`} /><Info label="清单状态" value={!present ? "远端已不存在" : !inScope ? "已排除在区域范围外" : account?.enabled === false ? "账号已停用" : "当前范围内"} /><Info label="最近发现" value={<RelativeTime value={instance.lastSeenAt} />} /><Info label="稳定资源 ID" value={instance.id} mono /></div></section>
      <section className="surface"><header className="surface-header"><div><h2>网卡与实际地址</h2><p>地址仅表示云端观察值，不表示已验证或已发布</p></div></header><div className="table-wrap"><table><thead><tr><th>网卡</th><th>地址</th><th>地址族</th><th>来源</th></tr></thead><tbody>{addresses.map((address) => <tr key={address.id}><td className="mono">{interfaces.find((iface) => iface.id === address.interfaceId)?.externalId ?? address.interfaceId ?? "-"}</td><td className="mono">{address.address}</td><td>IPv{address.family}</td><td>{address.origin ?? "-"}</td></tr>)}</tbody></table></div></section>
      <section className="surface"><header className="surface-header"><div><h2>地址槽位与能力</h2><p>权限状态为静态评估；尚未通过写操作验证云权限；不代表配额充足</p></div></header><div className="table-wrap"><table><thead><tr><th>槽位</th><th>实际地址</th><th>能力</th><th>云权限</th><th>操作</th></tr></thead><tbody>{slots.map((entry) => <tr key={entry.slot.id}><td><div className="table-primary"><strong>{entry.slot.name}</strong><small>IPv{entry.slot.family} · Version {entry.slot.currentVersion}</small></div></td><td className="mono slot-address">{entry.cloudTarget ? cloudTargetAddresses(entry.cloudTarget) : entry.currentAddress?.address ?? "未观察到主机地址"}</td><td>{entry.capability?.available ? <div className="table-primary"><StatusBadge value="available" />{entry.capability.requiresStop && <small>{rotationDowntimeNotice(entry, draft.allowReleaseAddress)}</small>}</div> : <div className="table-primary"><StatusBadge value="limited" /><small>{capabilityReason(entry.capability?.reason)}</small></div>}</td><td><StatusBadge value={entry.capability?.permission ?? "unverified"} /></td><td>{account && <ManualRotationButton account={account} instance={instance} slot={entry} savedAuthorization={authorization} draftAuthorization={draft} />}</td></tr>)}</tbody></table></div></section></div>
      <aside className="surface"><header className="surface-header"><div><h2>管理授权</h2><p>保存时完整替换 Revision {authorization?.revision ?? 0}</p></div><ShieldCheck size={16} /></header><form className="surface-body permission-form" onSubmit={save}><label className="check-row"><input type="checkbox" checked={draft.managed} disabled={!canManage && !draft.managed} onChange={(event) => setDraft({ ...draft, managed: event.target.checked })} /><span><strong>允许 MasterDNS 管理</strong><small>可单独开启以绑定与监控地址，轮换权限可全部关闭</small></span></label><Permission checked={draft.allowIpv4Rotation} disabled={!draft.managed || (!canRotateIpv4 && !draft.allowIpv4Rotation)} label="允许 IPv4 换址" hint={!canRotateIpv4 ? slots.filter((entry) => entry.slot.family === "4").map((entry) => capabilityReason(entry.capability?.reason)).join("；") || "当前没有 IPv4 槽位" : "同时授权手动换址和自动策略执行；自动轮换仍需单独启用策略"} onChange={(checked) => setDraft({ ...draft, allowIpv4Rotation: checked })} /><Permission checked={draft.allowIpv6Rotation} disabled={!draft.managed || (!canRotateIpv6 && !draft.allowIpv6Rotation)} label="允许 IPv6 自动轮换" hint={!canRotateIpv6 ? slots.filter((entry) => entry.slot.family === "6").map((entry) => capabilityReason(entry.capability?.reason)).join("；") || "当前没有 IPv6 槽位" : undefined} onChange={(checked) => setDraft({ ...draft, allowIpv6Rotation: checked })} /><Permission checked={draft.allowStopStart} disabled={!draft.managed} label="允许停止、启动或重启实例" hint={slots.map((entry) => rotationDowntimeNotice(entry, draft.allowReleaseAddress)).find(Boolean) ?? "授权停机操作，可能中断实例服务"} onChange={(checked) => setDraft({ ...draft, allowStopStart: checked })} /><Permission checked={draft.allowReleaseAddress} disabled={!draft.managed} label="允许释放用户原有旧地址" hint="仅控制接管前已存在的用户地址；系统创建的地址仍可自动清理，Linode 在停机授权有效时可能因此多次额外重启" onChange={(checked) => setDraft({ ...draft, allowReleaseAddress: checked })} /><p className="muted">这些开关只授予权限；不会自动启用轮换策略，外部验证仍需单独配置。</p><Button type="submit" disabled={saving || (!canManage && draft.managed)}>{saving ? "保存中" : "保存授权"}</Button></form></aside></div>
  </ConsoleLayout>;
}

function initialAuthorization(instanceId: string): CloudAuthorization { return { instanceId, revision: 0, managed: false, allowIpv4Rotation: false, allowIpv6Rotation: false, allowStopStart: false, allowReleaseAddress: false }; }
function Info({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) { return <div className="info-field"><span>{label}</span><strong className={mono ? "mono" : undefined}>{value}</strong></div>; }
function Permission({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled: boolean; label: string; hint?: string | undefined; onChange: (checked: boolean) => void }) { return <label className="check-row"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span></label>; }
async function fetchInstance(instanceId: string) {
  const detail = await api<CloudInstanceDetail>(`/v1/cloud-instances/${instanceId}`);
  const [accounts, slots] = await Promise.all([api<CloudAccount[]>("/v1/cloud-accounts"), api<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(instanceId)}`)]);
  return { detail, account: accounts.find((candidate) => candidate.id === detail.instance.accountId) ?? null, slots };
}
