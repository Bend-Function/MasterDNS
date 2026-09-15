"use client";

import { useState, type FormEvent } from "react";
import type { AddressSlot, CloudAuthorization } from "../lib/cloud-types";
import { validateRotationPolicy } from "../lib/rotation-policy";
import type { RotationPolicy, RotationPolicyInput } from "../lib/rotation-types";
import { Field, Switch } from "./ui";

export function RotationPolicyForm({ formId, slot, authorization, policy, onSubmit }: { formId: string; slot: AddressSlot; authorization: CloudAuthorization | null; policy: RotationPolicy; onSubmit: (input: RotationPolicyInput) => Promise<void> }) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [maxAttempts, setMaxAttempts] = useState(policy.maxAttempts);
  const [minIntervalSeconds, setMinIntervalSeconds] = useState(policy.minIntervalSeconds);
  const [cloudWaitSeconds, setCloudWaitSeconds] = useState(policy.cloudWaitSeconds);
  const [candidateWindowSeconds, setCandidateWindowSeconds] = useState(policy.candidateWindowSeconds);
  const [error, setError] = useState<string | null>(null);
  const familyAuthorized = slot.slot.family === "4" ? authorization?.allowIpv4Rotation === true : authorization?.allowIpv6Rotation === true;
  const capable = slot.capability?.available === true && slot.inScope;

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    const errors = validateRotationPolicy({ managed: authorization?.managed === true, ipv4Enabled: slot.slot.family === "4" && enabled, ipv6Enabled: slot.slot.family === "6" && enabled, ipv4Authorized: authorization?.allowIpv4Rotation ?? false, ipv6Authorized: authorization?.allowIpv6Rotation ?? false });
    if (enabled && !capable) errors.push("capability_unavailable");
    if (errors.length) { setError(rotationError(errors[0]!, slot)); return; }
    try { await onSubmit({ revision: policy.revision, enabled, maxAttempts, minIntervalSeconds, cloudWaitSeconds, candidateWindowSeconds }); }
    catch (value) { setError(value instanceof Error ? value.message : "轮换策略保存失败"); }
  };

  return <form id={formId} className="policy-form" onSubmit={submit}>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="switch-row policy-enable"><span><strong>自动轮换 IPv{slot.slot.family}</strong><small>Revision {policy.revision} · 默认关闭</small></span><Switch checked={enabled} label={`自动轮换 IPv${slot.slot.family}`} disabled={!enabled && (!familyAuthorized || !capable)} onCheckedChange={setEnabled} /></div>
    {!familyAuthorized && <div className="inline-warning">该地址族尚未取得实例轮换授权。</div>}
    {!capable && <div className="inline-warning">{slot.capability?.reason === "primary_ipv6_immutable" ? "Primary IPv6 地址可绑定，但云平台不允许自动轮换。" : "当前槽位不具备自动轮换能力。"}</div>}
    <div className="field-grid"><Field label="每次故障最多换址"><input type="number" min={1} max={20} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} required /></Field><Field label="尝试最小间隔（秒）"><input type="number" min={60} max={86400} value={minIntervalSeconds} onChange={(event) => setMinIntervalSeconds(Number(event.target.value))} required /></Field><Field label="等待云端生效（秒）"><input type="number" min={10} max={3600} value={cloudWaitSeconds} onChange={(event) => setCloudWaitSeconds(Number(event.target.value))} required /></Field><Field label="候选复测窗口（秒）"><input type="number" min={15} max={86400} value={candidateWindowSeconds} onChange={(event) => setCandidateWindowSeconds(Number(event.target.value))} required /></Field></div>
    <p className="muted">次数耗尽后保持锁存；重启、持续失败和恢复执行不会补回本次故障预算。</p>
  </form>;
}

function rotationError(code: string, slot: AddressSlot) { return ({ instance_not_managed: "实例尚未授权 MasterDNS 管理", ipv4_not_authorized: "IPv4 自动轮换未获授权", ipv6_not_authorized: "IPv6 自动轮换未获授权", capability_unavailable: slot.capability?.reason === "primary_ipv6_immutable" ? "Primary IPv6 不可自动轮换" : "当前槽位无法自动轮换" } as Record<string, string>)[code] ?? "轮换策略配置不合法"; }
