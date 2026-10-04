"use client";

import type { RotationPolicyInput } from "@masterdns/contracts/rotation";
import { useState, type FormEvent } from "react";
import type { AddressSlot, CloudAuthorization } from "../lib/cloud-types";
import { cloudRotationBlock, rotationDowntimeNotice } from "../lib/cloud-ui";
import { linodeTemporaryInstanceBlock, parseRotationPolicyInput } from "../lib/rotation-policy";
import type { RotationPolicy } from "../lib/rotation-types";
import { Field, Switch } from "./ui";

export function RotationPolicyForm({ formId, slot, authorization, policy, blockReason, onSubmit }: { formId: string; slot: AddressSlot; authorization: CloudAuthorization | null; policy: RotationPolicy; blockReason?: string | null; onSubmit: (input: RotationPolicyInput) => Promise<void> }) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [maxAttempts, setMaxAttempts] = useState(policy.maxAttempts);
  const [minIntervalSeconds, setMinIntervalSeconds] = useState(policy.minIntervalSeconds);
  const [cloudWaitSeconds, setCloudWaitSeconds] = useState(policy.cloudWaitSeconds);
  const [candidateWindowSeconds, setCandidateWindowSeconds] = useState(policy.candidateWindowSeconds);
  const [linodeRestartMode, setLinodeRestartMode] = useState(policy.linodeRestartMode);
  const [linodeIpv4Strategy, setLinodeIpv4Strategy] = useState(policy.linodeIpv4Strategy);
  const [linodeSwapPlan, setLinodeSwapPlan] = useState(policy.linodeSwapPlan);
  const [linodeAllowTemporaryInstance, setLinodeAllowTemporaryInstance] = useState(policy.linodeAllowTemporaryInstance);
  const [error, setError] = useState<string | null>(null);
  const linode = slot.ref?.service === "linode";
  const swap = linode && linodeIpv4Strategy === "instance_swap";
  const authorizationBlock = blockReason ?? cloudRotationBlock(slot, authorization);
  const block = authorizationBlock ?? (linode ? linodeTemporaryInstanceBlock({ linodeIpv4Strategy, linodeAllowTemporaryInstance }) : null);
  const downtime = rotationDowntimeNotice(slot, true, linodeRestartMode, linodeIpv4Strategy);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    try { await onSubmit(parseRotationPolicyInput({ revision: policy.revision, enabled, maxAttempts, minIntervalSeconds, cloudWaitSeconds, candidateWindowSeconds, linodeRestartMode, linodeIpv4Strategy, linodeSwapPlan, linodeAllowTemporaryInstance }, { savedPolicy: policy, blockReason: authorizationBlock })); }
    catch (value) { setError(value instanceof Error ? value.message : "轮换策略保存失败"); }
  };

  return <form id={formId} className="policy-form" onSubmit={submit}>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="switch-row policy-enable"><span><strong>故障自动轮换 IPv{slot.slot.family}</strong><small>仅在确认故障后启动 · 与定时开关独立</small></span><Switch checked={enabled} label={`故障自动轮换 IPv${slot.slot.family}`} disabled={!enabled && block !== null} onCheckedChange={setEnabled} /></div>
    {block && <div className="inline-warning">{block}</div>}
    {downtime && <div className="inline-warning">{downtime}</div>}
    {linode && <>
      <Field label="Linode IPv4 换址策略"><select value={linodeIpv4Strategy} onChange={event => setLinodeIpv4Strategy(event.target.value as RotationPolicyInput["linodeIpv4Strategy"])}><option value="additional_ipv4">申请额外 IPv4（默认）</option><option value="instance_swap">临时实例交换 IPv4</option></select></Field>
      {swap && <>
        <Field label="临时实例套餐 ID" hint="在生产实例所在区域创建空磁盘、关机的临时实例；账户须允许新建旧版接口实例。费用取决于套餐和保留时间，账户默认备份可能增加费用。交换 IPv4 要求 Linode API Token 具有 ips:read_write 权限。"><input value={linodeSwapPlan} onChange={event => setLinodeSwapPlan(event.target.value)} placeholder="g6-nanode-1" required /></Field>
        <label className="check-row"><input type="checkbox" checked={linodeAllowTemporaryInstance} onChange={event => setLinodeAllowTemporaryInstance(event.target.checked)} /><span><strong>允许创建并删除本次换址的临时实例</strong><small>授权仅限本次换址创建的临时实例；生产实例及其磁盘保留。临时实例从创建起计费，任务失败或终止后可能需要人工处理。</small></span></label>
      </>}
      <Field label="换址时实例重启方式"><select value={linodeRestartMode} onChange={event => setLinodeRestartMode(event.target.value as RotationPolicyInput["linodeRestartMode"])}><option value="reboot">重启</option><option value="stop_start">关机后开机</option></select></Field>
    </>}
    <p>新地址接管并完成 DNS 切换后，系统会等待旧记录缓存期限结束，自动释放可释放的旧云端 IP，不作为备用保留。</p>
    <div className="field-grid"><Field label="每个任务最多换址"><input type="number" min={1} max={20} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} required /></Field><Field label="尝试最小间隔（秒）"><input type="number" min={60} max={86400} value={minIntervalSeconds} onChange={(event) => setMinIntervalSeconds(Number(event.target.value))} required /></Field><Field label="等待云端生效（秒）"><input type="number" min={10} max={3600} value={cloudWaitSeconds} onChange={(event) => setCloudWaitSeconds(Number(event.target.value))} required /></Field><Field label="候选复测窗口（秒）"><input type="number" min={15} max={86400} value={candidateWindowSeconds} onChange={(event) => setCandidateWindowSeconds(Number(event.target.value))} required /></Field></div>
    <p className="muted">次数耗尽后保持锁存；重启、持续失败和恢复执行不会补回本次任务预算。</p>
  </form>;
}
