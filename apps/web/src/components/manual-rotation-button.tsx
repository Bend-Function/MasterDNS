"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, jsonBody, UI_PREVIEW } from "../lib/api";
import type { AddressSlot, CloudAccount, CloudAuthorization, CloudInstance } from "../lib/cloud-types";
import { cloudErrorMessage, cloudServiceLabel, manualIpv4RotationEligibility, rotationDowntimeNotice } from "../lib/cloud-ui";
import { createManualRotationSubmission } from "../lib/rotation-action";
import { linodeTemporaryInstanceBlock, resolveManualRotationPolicy } from "../lib/rotation-policy";
import type { RotationIncident, RotationPolicy } from "../lib/rotation-types";
import { Button, Dialog } from "./ui";

type Props = {
  account: CloudAccount;
  instance: CloudInstance;
  slot: AddressSlot;
  savedAuthorization: CloudAuthorization | null;
  draftAuthorization: CloudAuthorization | null;
  savedPolicy?: RotationPolicy;
  blockReason?: string | null;
  disabled?: boolean;
  compact?: boolean;
};

export function ManualRotationButton({ account, instance, slot, savedAuthorization, draftAuthorization, savedPolicy, blockReason, disabled = false, compact = false }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewComplete, setPreviewComplete] = useState(false);
  const [loadedPolicy, setLoadedPolicy] = useState<RotationPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const policyGeneration = useRef(0);
  const mounted = useRef(true);
  const submission = useRef(createManualRotationSubmission());
  const eligibility = manualIpv4RotationEligibility(slot, {
    accountEnabled: account.enabled,
    provider: account.provider,
    service: instance.service,
    instancePresent: instance.metadata.present !== false,
    savedAuthorization,
    draftAuthorization,
  });
  const policy = savedPolicy ?? loadedPolicy;
  const reason = blockReason ?? eligibility.reason ?? (instance.service === "linode" && savedPolicy ? linodeTemporaryInstanceBlock(savedPolicy) : null);
  const confirmationReason = reason ?? (instance.service === "linode" && policy ? linodeTemporaryInstanceBlock(policy) : null);
  const confirmationDisabled = pending || policyLoading || confirmationReason !== null || disabled || (instance.service === "linode" && !policy);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; policyGeneration.current += 1; };
  }, []);

  if (!eligibility.visible) return null;

  const close = () => {
    if (submission.current.isPending()) return;
    submission.current.cancel();
    policyGeneration.current += 1;
    setOpen(false);
    setError(null);
    setPreviewComplete(false);
  };
  const showConfirmation = async () => {
    if (reason || disabled) return;
    setError(null);
    setPreviewComplete(false);
    setLoadedPolicy(null);
    setOpen(true);
    const generation = ++policyGeneration.current;
    setPolicyLoading(instance.service === "linode" && !savedPolicy);
    try {
      const nextPolicy = await resolveManualRotationPolicy(instance.service, slot.slot.id, savedPolicy, UI_PREVIEW, api<RotationPolicy>);
      if (mounted.current && policyGeneration.current === generation) setLoadedPolicy(nextPolicy);
    } catch (value) {
      if (mounted.current && policyGeneration.current === generation) setError(cloudErrorMessage(value, "已保存的换址策略读取失败，请关闭后重试"));
    } finally {
      if (mounted.current && policyGeneration.current === generation) setPolicyLoading(false);
    }
  };
  const submit = async () => {
    if (confirmationDisabled || submission.current.isPending()) return;
    setError(null);
    if (UI_PREVIEW) {
      setPreviewComplete(true);
      return;
    }
    setPending(true);
    let submitted = false;
    try {
      const incident = await submission.current.submit<RotationIncident>(slot.slot.id, (key, payload) => api<RotationIncident>("/v1/rotations/manual", {
        method: "POST",
        headers: { "idempotency-key": key },
        ...jsonBody(payload),
      }));
      if (incident && mounted.current) {
        submitted = true;
        router.push(`/rotations/${incident.id}`);
      }
    } catch (value) {
      if (mounted.current) setError(cloudErrorMessage(value, "手动换址请求失败"));
    } finally {
      if (mounted.current && !submitted) setPending(submission.current.isPending());
    }
  };

  const button = <Button variant="secondary" icon={<RotateCw size={14} />} title={reason ?? undefined} disabled={reason !== null || disabled} onClick={() => void showConfirmation()}>更换 IPv4</Button>;
  return <>
    {compact ? button : <div className="table-primary manual-rotation-action">
      {button}
      {reason && <small>{reason}</small>}
    </div>}
    <Dialog open={open} title={UI_PREVIEW ? "预览更换公网 IPv4" : "确认更换公网 IPv4"} size="small" onClose={close} footer={previewComplete
      ? <Button onClick={close}>完成</Button>
      : <><Button variant="secondary" disabled={pending} onClick={close}>取消</Button><Button variant={UI_PREVIEW ? "primary" : "danger"} icon={<RotateCw size={14} />} disabled={confirmationDisabled} onClick={() => void submit()}>{pending ? "提交中" : UI_PREVIEW ? "确认预览" : "确认更换"}</Button></>}>
      {previewComplete ? <div className="inline-notice" role="status">预览已完成：未发送 API 请求，也未修改云地址或 DNS。</div> : <>
        {policyLoading && <p role="status">正在读取已保存的换址策略…</p>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        {confirmationReason && <div className="inline-warning" role="alert">{confirmationReason}</div>}
        {!policyLoading && (instance.service !== "linode" || policy) && <ManualRotationSummary account={account} instance={instance} slot={slot} policy={policy} preview={UI_PREVIEW} />}
      </>}
    </Dialog>
  </>;
}

export function ManualRotationSummary({ account, instance, slot, policy, preview }: Pick<Props, "account" | "instance" | "slot"> & { policy: RotationPolicy | null; preview: boolean }) {
  const swap = instance.service === "linode" && policy?.linodeIpv4Strategy === "instance_swap";
  const downtimeNotice = rotationDowntimeNotice(slot, true, policy?.linodeRestartMode, policy?.linodeIpv4Strategy);
  return <div className="danger-summary">
        {preview && <div className="inline-notice" role="status">当前为界面预览；确认后不会发送请求，也不会修改云地址或 DNS。</div>}
        <strong>{preview ? "预览一次公网 IPv4 换址" : "本次操作会发起一次真实公网 IPv4 换址"}</strong>
        <p>{preview ? "真实操作会更换当前地址一次，并更新绑定到此槽位的 DNS 记录；不会执行外部可达性验证，换址和 DNS 生效期间服务可能短暂中断。" : "系统会更换当前地址一次，并更新绑定到此槽位的 DNS 记录。此次手动操作不执行外部可达性验证，换址和 DNS 生效期间服务可能短暂中断。"}</p>
        {downtimeNotice && <p>{downtimeNotice}</p>}
        <dl>
          <dt>云账号 / 实例</dt><dd>{account.name} - {instance.name ?? instance.externalId}</dd>
          <dt>云服务</dt><dd>{cloudServiceLabel(instance.service)} · {instance.region}</dd>
          <dt>当前公网 IPv4</dt><dd className="mono">{slot.currentAddress?.address ?? "暂无观测数据"}</dd>
          <dt>换址次数</dt><dd>1 次</dd>
          {instance.service === "linode" && policy && <>
            <dt>已保存的换址策略</dt><dd>{swap ? "临时实例交换 IPv4" : "申请额外 IPv4"}</dd>
            <dt>实例重启方式</dt><dd>{policy.linodeRestartMode === "stop_start" ? "关机后开机" : "重启"}</dd>
            {swap && <><dt>临时实例套餐</dt><dd>{policy.linodeSwapPlan}</dd><dt>创建与删除临时实例</dt><dd>{policy.linodeAllowTemporaryInstance ? "已授权，仅限本次临时实例" : "未授权"}</dd></>}
          </>}
          <dt>绑定 DNS</dt><dd>更新到换址后的 IPv4</dd>
          <dt>外部验证</dt><dd>不执行</dd>
          <dt>旧公网 IP</dt><dd>{swap ? "交换至临时实例；DNS 发布且缓存期限结束后删除临时实例并释放" : "接管完成且旧 DNS 缓存期限结束后自动释放，不保留备用"}</dd>
        </dl>
      </div>;
}
