"use client";

import { useEffect, useState } from "react";
import { api, UI_PREVIEW } from "../lib/api";
import { demoCloudAccounts, demoCloudInstances, demoCloudSlots } from "../lib/cloud-demo";
import type { AddressSlot, CloudAccount, CloudInstanceRow } from "../lib/cloud-types";
import { selectableCloudSlots } from "../lib/cloud-ui";
import { Field, LoadingState } from "./ui";

type CloudOption = { slot: AddressSlot; account: CloudAccount; instance: CloudInstanceRow["instance"] };

export function CloudSourcePicker({ recordType, ownerUserId, value, onChange }: { recordType: "A" | "AAAA"; ownerUserId?: string; value: string; onChange: (slotId: string) => void }) {
  const [options, setOptions] = useState<CloudOption[]>([]);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true); setError(null);
      try {
        const accounts = (UI_PREVIEW ? demoCloudAccounts : await api<CloudAccount[]>("/v1/cloud-accounts")).filter((account) => !ownerUserId || account.ownerUserId === ownerUserId);
        const groups = await Promise.all(accounts.map(async (account) => {
          const instances = UI_PREVIEW ? demoCloudInstances.filter((row) => row.instance.accountId === account.id) : await api<CloudInstanceRow[]>(`/v1/cloud-accounts/${account.id}/instances`);
          return Promise.all(instances.map(async (row) => {
            const slots = UI_PREVIEW ? demoCloudSlots : await api<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(row.instance.id)}`);
            return selectableCloudSlots(recordType, slots, { accountEnabled: account.enabled, instancePresent: row.instance.metadata.present !== false, managed: row.authorization?.managed === true }).map((slot) => ({ slot, account, instance: row.instance }));
          }));
        }));
        if (active) setOptions(groups.flat(2));
      } catch (value) { if (active) setError(value instanceof Error ? value.message : "云地址来源加载失败"); }
      finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [ownerUserId, recordType]);

  useEffect(() => { if (value && !options.some((option) => option.slot.slot.id === value)) onChange(""); }, [onChange, options, value]);

  if (loading) return <div className="span-2"><LoadingState /></div>;
  return <div className="span-2 cloud-source-panel">
    <Field label="云实例地址槽位" hint="只显示已授权、当前可用且地址族完全匹配的槽位"><select value={value} onChange={(event) => onChange(event.target.value)} required><option value="">选择地址来源</option>{options.map(({ slot, account, instance }) => <option key={slot.slot.id} value={slot.slot.id}>{account.name} / {instance.name ?? instance.externalId} / {instance.region} / {slot.slot.name} / {slot.currentAddress?.address}</option>)}</select></Field>
    {error && <div className="login-error" role="alert">{error}</div>}
    {!error && options.length === 0 && <p className="muted">没有符合条件的 IPv{recordType === "A" ? "4" : "6"} 地址槽位。请先在云实例页启用管理授权。</p>}
    {value && <p className="muted">绑定后进入外部验证等待状态；当前观察地址不会因此立即发布。</p>}
  </div>;
}
