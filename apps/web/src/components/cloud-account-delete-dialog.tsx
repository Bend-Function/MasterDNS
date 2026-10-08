"use client";

import { useEffect, useRef, useState } from "react";
import { api, UI_PREVIEW } from "../lib/api";
import type { CloudAccount } from "../lib/cloud-types";
import { cloudErrorMessage } from "../lib/cloud-ui";
import { createRequestGeneration } from "../lib/session-state";
import { Button, Dialog, Field } from "./ui";

export function CloudAccountDeleteDialog({ account, onClose, onDeleted }: {
  account: CloudAccount;
  onClose: () => void;
  onDeleted: (accountId: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(createRequestGeneration());
  const pending = useRef(false);
  useEffect(() => { const current = requests.current; return () => { current.invalidate(); }; }, []);

  const remove = async () => {
    if (pending.current || confirmation !== account.name) return;
    const token = requests.current.current();
    pending.current = true; setSaving(true); setError(null);
    try {
      if (!UI_PREVIEW) await api(`/v1/cloud-accounts/${account.id}`, { method: "DELETE" });
      if (requests.current.isCurrent(token)) onDeleted(account.id);
    } catch (cause) {
      if (requests.current.isCurrent(token)) setError(cloudErrorMessage(cause, "云账号删除失败"));
    } finally {
      pending.current = false;
      if (requests.current.isCurrent(token)) setSaving(false);
    }
  };

  return <Dialog open title="删除云账号" size="small" onClose={() => { if (!pending.current) onClose(); }} footer={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>取消</Button>
    <Button variant="danger" disabled={saving || confirmation !== account.name} onClick={() => void remove()}>删除账号及实例记录</Button>
  </>}>
    <p>将从 MasterDNS 删除云账号 <strong>{account.name}</strong> 及其全部实例、地址、授权和自动化任务记录。此操作无法撤销。</p>
    <p>不会销毁云厂商上的实际实例。关联的 Pool 节点保留现有 IP 并解除云关联，现有 DNS 记录保留。</p>
    <Field label={`输入账号名称「${account.name}」确认删除`}><input value={confirmation} disabled={saving} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></Field>
    {error && <div className="inline-error" role="alert">{error}</div>}
  </Dialog>;
}
