"use client";

import type { HealthPolicyDeleteInput } from "@masterdns/contracts";
import { useEffect, useRef, useState } from "react";
import { api, jsonBody, UI_PREVIEW } from "../lib/api";
import { cloudTargetAddresses, cloudTargetLabel } from "../lib/cloud-ui";
import type { AddressHealthPolicy } from "../lib/probe-types";
import { createRequestGeneration } from "../lib/session-state";
import { Button, Dialog } from "./ui";

export function HealthPolicyDeleteDialog({ policy, onClose, onDeleted }: {
  policy: AddressHealthPolicy;
  onClose: () => void;
  onDeleted: (policyId: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(createRequestGeneration());
  const pending = useRef(false);
  useEffect(() => { const current = requests.current; return () => { current.invalidate(); }; }, []);
  const label = policy.cloudTarget
    ? `${cloudTargetLabel(policy.cloudTarget)} · ${cloudTargetAddresses(policy.cloudTarget)}`
    : `${policy.slotId ? "云槽位" : "普通节点"} ${policy.slotId ?? policy.endpointId}`;

  const remove = async () => {
    if (pending.current) return;
    const generation = requests.current.current();
    pending.current = true; setSaving(true); setError(null);
    try {
      const input: HealthPolicyDeleteInput = { expectedRevision: policy.revision };
      if (!UI_PREVIEW) await api(`/v1/address-health-policies/${policy.id}`, { method: "DELETE", ...jsonBody(input) });
      if (requests.current.isCurrent(generation)) onDeleted(policy.id);
    } catch (cause) {
      if (requests.current.isCurrent(generation)) setError(cause instanceof Error ? cause.message : "健康策略删除失败");
    } finally {
      pending.current = false;
      if (requests.current.isCurrent(generation)) setSaving(false);
    }
  };

  return <Dialog open title="删除地址健康策略" size="small" onClose={() => { if (!pending.current) onClose(); }} footer={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>取消</Button>
    <Button variant="danger" disabled={saving} onClick={() => void remove()}>{saving ? "删除中" : "确认删除"}</Button>
  </>}>
    <p>删除 <strong>{label} / IPv{policy.family}</strong> 的地址健康策略。检查配置、探测组和历史观测会保留，现有 DNS 记录会保留。</p>
    {policy.slotId
      ? <p>云地址将等待重新配置外部健康策略才能验证和自动发布。请先关闭该地址族的故障自动轮换和定时轮换，并等待未完成的轮换完成收尾。</p>
      : <p>该地址族将恢复使用节点或 Pool 的本地健康检查。</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
  </Dialog>;
}
