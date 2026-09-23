"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, jsonBody, UI_PREVIEW } from "../lib/api";
import type { AddressSlot, CloudAccount, CloudAuthorization, CloudInstance } from "../lib/cloud-types";
import { cloudErrorMessage, cloudServiceLabel, manualIpv4RotationEligibility } from "../lib/cloud-ui";
import { createManualRotationSubmission } from "../lib/rotation-action";
import type { RotationIncident } from "../lib/rotation-types";
import { Button, Dialog } from "./ui";

type Props = {
  account: CloudAccount;
  instance: CloudInstance;
  slot: AddressSlot;
  savedAuthorization: CloudAuthorization | null;
  draftAuthorization: CloudAuthorization;
};

export function ManualRotationButton({ account, instance, slot, savedAuthorization, draftAuthorization }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewComplete, setPreviewComplete] = useState(false);
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

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  if (!eligibility.visible) return null;

  const close = () => {
    if (submission.current.isPending()) return;
    submission.current.cancel();
    setOpen(false);
    setError(null);
    setPreviewComplete(false);
  };
  const showConfirmation = () => {
    if (eligibility.reason) return;
    setError(null);
    setPreviewComplete(false);
    setOpen(true);
  };
  const submit = async () => {
    if (eligibility.reason || submission.current.isPending()) return;
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

  return <>
    <div className="table-primary manual-rotation-action">
      <Button variant="secondary" icon={<RotateCw size={14} />} disabled={eligibility.reason !== null} onClick={showConfirmation}>更换 IPv4</Button>
      {eligibility.reason && <small>{eligibility.reason}</small>}
    </div>
    <Dialog open={open} title={UI_PREVIEW ? "预览更换公网 IPv4" : "确认更换公网 IPv4"} size="small" onClose={close} footer={previewComplete
      ? <Button onClick={close}>完成</Button>
      : <><Button variant="secondary" disabled={pending} onClick={close}>取消</Button><Button variant={UI_PREVIEW ? "primary" : "danger"} icon={<RotateCw size={14} />} disabled={pending} onClick={() => void submit()}>{pending ? "提交中" : UI_PREVIEW ? "确认预览" : "确认更换"}</Button></>}>
      {previewComplete ? <div className="inline-notice" role="status">预览已完成：未发送 API 请求，也未修改云地址或 DNS。</div> : <div className="danger-summary">
        {UI_PREVIEW && <div className="inline-notice" role="status">当前为界面预览；确认后不会发送请求，也不会修改云地址或 DNS。</div>}
        <strong>{UI_PREVIEW ? "预览一次公网 IPv4 换址" : "本次操作会发起一次真实公网 IPv4 换址"}</strong>
        <p>{UI_PREVIEW ? "真实操作会更换当前地址一次，并更新绑定到此槽位的 DNS 记录；不会执行外部可达性验证，换址和 DNS 生效期间服务可能短暂中断。" : "系统会更换当前地址一次，并更新绑定到此槽位的 DNS 记录。此次手动操作不执行外部可达性验证，换址和 DNS 生效期间服务可能短暂中断。"}</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <dl>
          <dt>云账号 / 实例</dt><dd>{account.name} - {instance.name ?? instance.externalId}</dd>
          <dt>云服务</dt><dd>{cloudServiceLabel(instance.service)} · {instance.region}</dd>
          <dt>当前公网 IPv4</dt><dd className="mono">{slot.currentAddress?.address ?? "暂无观测数据"}</dd>
          <dt>换址次数</dt><dd>1 次</dd>
          <dt>绑定 DNS</dt><dd>更新到换址后的 IPv4</dd>
          <dt>外部验证</dt><dd>不执行</dd>
          <dt>旧公网 IP</dt><dd>接管完成且旧 DNS 缓存期限结束后自动释放，不保留备用</dd>
        </dl>
      </div>}
    </Dialog>
  </>;
}
