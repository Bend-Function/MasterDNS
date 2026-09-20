"use client";

import { useEffect, useMemo, useState } from "react";
import { api, UI_PREVIEW } from "../lib/api";
import { demoCloudAccounts, demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import type { AddressSlot, CloudAccount, CloudInstanceRow } from "../lib/cloud-types";
import { cloudTargetAddresses, cloudTargetLabel, selectableCloudSlots, slotsMatchingExistingRecord } from "../lib/cloud-ui";
import { Field, LoadingState } from "./ui";

export function CloudSourcePicker({ recordType, ownerUserId, existingAddress, value, onChange }: { recordType: "A" | "AAAA"; ownerUserId?: string; existingAddress?: string; value: string; onChange: (slotId: string) => void }) {
  const [accounts, setAccounts] = useState<CloudAccount[]>(UI_PREVIEW ? demoCloudAccounts : []);
  const [accountId, setAccountId] = useState(UI_PREVIEW ? demoCloudAccounts[0]!.id : "");
  const [instances, setInstances] = useState<CloudInstanceRow[]>(UI_PREVIEW ? demoCloudInstances : []);
  const [instanceId, setInstanceId] = useState(UI_PREVIEW ? demoCloudInstances[0]!.instance.id : "");
  const [slots, setSlots] = useState<AddressSlot[]>(UI_PREVIEW ? demoCloudSlots : []);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    api<CloudAccount[]>("/v1/cloud-accounts").then((rows) => {
      if (!active) return;
      const owned = rows.filter((account) => !ownerUserId || account.ownerUserId === ownerUserId);
      setAccounts(owned); setAccountId(owned[0]?.id ?? ""); if (!owned[0]) setLoading(false);
    }).catch((value) => { if (active) { setError(message(value)); setLoading(false); } });
    return () => { active = false; };
  }, [ownerUserId]);

  useEffect(() => {
    if (UI_PREVIEW || !accountId) return;
    let active = true;
    api<CloudInstanceRow[]>(`/v1/cloud-accounts/${accountId}/instances`).then((rows) => {
      if (!active) return;
      setInstances(rows); setInstanceId(rows[0]?.instance.id ?? ""); if (!rows[0]) setLoading(false);
    }).catch((value) => { if (active) { setError(message(value)); setLoading(false); } });
    return () => { active = false; };
  }, [accountId]);

  useEffect(() => {
    if (UI_PREVIEW || !instanceId) return;
    let active = true;
    api<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(instanceId)}`).then((rows) => { if (active) { setSlots(rows); setLoading(false); } }).catch((value) => { if (active) { setError(message(value)); setLoading(false); } });
    return () => { active = false; };
  }, [instanceId]);

  const account = accounts.find((candidate) => candidate.id === accountId);
  const instanceRow = instances.find((candidate) => candidate.instance.id === instanceId);
  const options = useMemo(() => {
    if (!account || !instanceRow) return [];
    const eligible = selectableCloudSlots(recordType, slots, { accountEnabled: account.enabled, instancePresent: instanceRow.instance.metadata.present !== false, managed: instanceRow.authorization?.managed === true });
    return existingAddress ? slotsMatchingExistingRecord(recordType, existingAddress, eligible) : eligible;
  }, [account, existingAddress, instanceRow, recordType, slots]);

  return <div className="span-2 cloud-source-panel">
    <div className="field-grid"><Field label="云计算账号"><select value={accountId} onChange={(event) => { const next = event.target.value; setLoading(Boolean(next)); setError(null); setAccountId(next); setInstances([]); setInstanceId(""); setSlots([]); onChange(""); }}><option value="">选择账号</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="云实例"><select value={instanceId} disabled={!accountId} onChange={(event) => { const next = event.target.value; setLoading(Boolean(next)); setError(null); setInstanceId(next); setSlots([]); onChange(""); }}><option value="">选择实例</option>{instances.map((item) => <option key={item.instance.id} value={item.instance.id}>{item.instance.name ?? item.instance.externalId} / {item.instance.region}</option>)}</select></Field></div>
    {loading ? <LoadingState /> : <Field label="云实例地址槽位" hint={existingAddress ? `接管时仅允许选择当前地址为 ${existingAddress} 的槽位` : "只显示已授权、当前可用且地址族完全匹配的槽位"}><select value={value} onChange={(event) => onChange(event.target.value)} required><option value="">选择地址来源</option>{options.map(({ slot, currentAddress, capability, cloudTarget }) => <option key={slot.id} value={slot.id}>{cloudTarget ? `${cloudTargetLabel(cloudTarget)} · ${cloudTargetAddresses(cloudTarget)}` : `${account?.name ?? ""} - ${instanceRow?.instance.name ?? instanceRow?.instance.externalId ?? ""} · IPv${slot.family} · ${currentAddress?.address ?? "暂无当前地址"}`}{capability?.available === false ? ` / 无法自动换址 (${capability.reason ?? "能力受限"})` : ""}</option>)}</select></Field>}
    {error && <div className="login-error" role="alert">{error}</div>}
    {!loading && !error && options.length === 0 && <p className="muted">没有符合条件的 IPv{recordType === "A" ? "4" : "6"} 地址槽位。</p>}
    {value && <p className="muted">绑定后进入外部验证等待状态；当前观察地址不会因此立即发布。</p>}
  </div>;
}

const message = (value: unknown) => value instanceof Error ? value.message : "云地址来源加载失败";
