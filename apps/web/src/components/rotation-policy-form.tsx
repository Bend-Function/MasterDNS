"use client";

import type { RotationPolicyInput } from "@masterdns/contracts/rotation";
import { useState, type FormEvent } from "react";
import type { AddressSlot, CloudAuthorization } from "../lib/cloud-types";
import { cloudRotationBlock, rotationDowntimeNotice } from "../lib/cloud-ui";
import { parseRotationPolicyInput } from "../lib/rotation-policy";
import type { RotationPolicy } from "../lib/rotation-types";
import { Field, Switch } from "./ui";

export function RotationPolicyForm({ formId, slot, authorization, policy, blockReason, onSubmit }: { formId: string; slot: AddressSlot; authorization: CloudAuthorization | null; policy: RotationPolicy; blockReason?: string | null; onSubmit: (input: RotationPolicyInput) => Promise<void> }) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [maxAttempts, setMaxAttempts] = useState(policy.maxAttempts);
  const [minIntervalSeconds, setMinIntervalSeconds] = useState(policy.minIntervalSeconds);
  const [cloudWaitSeconds, setCloudWaitSeconds] = useState(policy.cloudWaitSeconds);
  const [candidateWindowSeconds, setCandidateWindowSeconds] = useState(policy.candidateWindowSeconds);
  const [error, setError] = useState<string | null>(null);
  const block = blockReason ?? cloudRotationBlock(slot, authorization);
  const downtime = rotationDowntimeNotice(slot, true);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    if (enabled && block) { setError(block); return; }
    try { await onSubmit(parseRotationPolicyInput({ revision: policy.revision, enabled, maxAttempts, minIntervalSeconds, cloudWaitSeconds, candidateWindowSeconds })); }
    catch (value) { setError(value instanceof Error ? value.message : "轮换策略保存失败"); }
  };

  return <form id={formId} className="policy-form" onSubmit={submit}>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="switch-row policy-enable"><span><strong>自动轮换 IPv{slot.slot.family}</strong><small>Revision {policy.revision} · 默认关闭</small></span><Switch checked={enabled} label={`自动轮换 IPv${slot.slot.family}`} disabled={!enabled && block !== null} onCheckedChange={setEnabled} /></div>
    {block && <div className="inline-warning">{block}</div>}
    {downtime && <div className="inline-warning">{downtime}</div>}
    <p>新地址接管并完成 DNS 切换后，系统会等待旧记录缓存期限结束，自动释放可释放的旧云端 IP，不作为备用保留。</p>
    <div className="field-grid"><Field label="每次故障最多换址"><input type="number" min={1} max={20} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} required /></Field><Field label="尝试最小间隔（秒）"><input type="number" min={60} max={86400} value={minIntervalSeconds} onChange={(event) => setMinIntervalSeconds(Number(event.target.value))} required /></Field><Field label="等待云端生效（秒）"><input type="number" min={10} max={3600} value={cloudWaitSeconds} onChange={(event) => setCloudWaitSeconds(Number(event.target.value))} required /></Field><Field label="候选复测窗口（秒）"><input type="number" min={15} max={86400} value={candidateWindowSeconds} onChange={(event) => setCandidateWindowSeconds(Number(event.target.value))} required /></Field></div>
    <p className="muted">次数耗尽后保持锁存；重启、持续失败和恢复执行不会补回本次故障预算。</p>
  </form>;
}
