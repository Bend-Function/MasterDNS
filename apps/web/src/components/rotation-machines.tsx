"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, RefreshCw, Search, Settings2 } from "lucide-react";
import { api, ApiError, jsonBody, UI_PREVIEW } from "../lib/api";
import { previewRotationMachines } from "../lib/rotation-machines-demo";
import { cloudAddressView, cloudInventoryNotice, cloudErrorMessage, cloudServiceLabel, rotationDowntimeNotice } from "../lib/cloud-ui";
import { createRotationRefreshGate, familyControl, loadRotationMachines, machineMatches, machinePolicySummary, mergeMachinePolicies, policyToggleInput, rotationSlotBlock, updateMachinePolicy, type MachineSlot, type RotationMachine } from "../lib/rotation-machines";
import type { RotationIncident, RotationPolicy } from "../lib/rotation-types";
import { createRequestGeneration } from "../lib/session-state";
import { Button, EmptyState, ErrorState, LoadingState, MetricStrip, Switch, IconButton } from "./ui";

export type RotationSelection = { row: RotationMachine; slot: MachineSlot; policy: RotationPolicy };
const previewRows = previewRotationMachines;
const PAGE_SIZE = 20;

export function RotationMachines({ onSelect, updatedPolicy, editorOpen, incidents, refreshVersion }: { onSelect: (selection: RotationSelection) => void; updatedPolicy: RotationPolicy | null; editorOpen: boolean; incidents: RotationIncident[]; refreshVersion: number }) {
  const [rows, setRows] = useState<RotationMachine[]>(UI_PREVIEW ? previewRows : []);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [filters, setFilters] = useState({ search: "", account: "", region: "", status: "" });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [slotErrors, setSlotErrors] = useState<Record<string, string>>({});
  const generation = useRef(createRequestGeneration());
  const pending = useRef(false);
  const refreshGate = useRef(createRotationRefreshGate());

  const load = useCallback(async () => {
    const token = generation.current.invalidate();
    setLoading(true); setError(null); setWarnings([]); setSlotErrors({});
    try {
      const result = UI_PREVIEW ? { rows: previewRows(), errors: [] } : await loadRotationMachines(api, () => generation.current.isCurrent(token));
      if (generation.current.isCurrent(token)) { setRows(previous => mergeMachinePolicies(result.rows, previous)); setWarnings(result.errors); }
    } catch (value) { if (generation.current.isCurrent(token)) setError(cloudErrorMessage(value, "机器列表加载失败")); }
    finally { if (generation.current.isCurrent(token)) setLoading(false); }
  }, []);

  const requestLoad = useCallback(() => refreshGate.current.request(() => { void load(); }), [load]);

  useEffect(() => {
    let active = true;
    const gate = refreshGate.current;
    const guard = generation.current;
    Promise.resolve().then(() => { if (active && !UI_PREVIEW) requestLoad(); });
    const refresh = () => requestLoad();
    window.addEventListener("masterdns:invalidate", refresh);
    return () => { active = false; gate.cancel(); guard.invalidate(); window.removeEventListener("masterdns:invalidate", refresh); };
  }, [requestLoad]);
  useEffect(() => {
    if (editorOpen) refreshGate.current.hold("editor");
    else refreshGate.current.release("editor");
  }, [editorOpen]);
  useEffect(() => {
    let active = true;
    if (refreshVersion > 0) Promise.resolve().then(() => { if (active) requestLoad(); });
    return () => { active = false; };
  }, [refreshVersion, requestLoad]);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => { if (active && updatedPolicy) setRows(current => updateMachinePolicy(current, updatedPolicy)); });
    return () => { active = false; };
  }, [updatedPolicy]);

  const toggle = async (row: RotationMachine, slot: MachineSlot, enabled: boolean) => {
    if (pending.current || editorOpen || !slot.policy || (enabled && rotationSlotBlock(row, slot))) return;
    pending.current = true; refreshGate.current.hold("save"); setBusy(slot.slot.id);
    setSlotErrors(current => { const next = { ...current }; delete next[slot.slot.id]; return next; });
    const token = generation.current.current();
    try {
      const input = policyToggleInput(slot.policy, enabled);
      const saved = UI_PREVIEW ? { ...slot.policy, ...input, revision: input.revision + 1 } : await api<RotationPolicy>(`/v1/rotation-policies/${slot.slot.id}`, { method: "PATCH", ...jsonBody(input) });
      if (generation.current.isCurrent(token)) setRows(current => updateMachinePolicy(current, saved));
    } catch (value) {
      if (!generation.current.isCurrent(token)) return;
      let message = cloudErrorMessage(value, "保存失败，原开关状态已保留");
      if (value instanceof ApiError && value.status === 409) {
        try {
          const latest = await api<RotationPolicy>(`/v1/rotation-policies?slotId=${encodeURIComponent(slot.slot.id)}`);
          if (!generation.current.isCurrent(token)) return;
          setRows(current => updateMachinePolicy(current, latest));
          message += "；已读取最新策略，请核对后重试";
        } catch { message += "；最新策略读取失败，请刷新后重试"; }
      }
      if (generation.current.isCurrent(token)) setSlotErrors(current => ({ ...current, [slot.slot.id]: message }));
    } finally { pending.current = false; setBusy(null); refreshGate.current.release("save"); }
  };

  const accounts = useMemo(() => [...new Map(rows.filter(row => row.account).map(row => [row.account!.id, row.account!])).values()], [rows]);
  const regions = useMemo(() => [...new Set(rows.map(row => row.instance.region))].sort(), [rows]);
  const filtered = useMemo(() => rows.filter(row => machineMatches(row, filters)), [rows, filters]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const filter = (key: keyof typeof filters, value: string) => { setFilters(current => ({ ...current, [key]: value })); setPage(0); };
  const expand = (id: string) => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const select = (row: RotationMachine, slot: MachineSlot) => { if (slot.policy && !pending.current && !loading) { refreshGate.current.hold("editor"); onSelect({ row, slot, policy: slot.policy }); } };
  const disabled = loading || busy !== null || editorOpen;

  const control = (row: RotationMachine, slot: MachineSlot) => <RotationSlotControl row={row} slot={slot} busy={busy === slot.slot.id} disabled={disabled} error={slotErrors[slot.slot.id]} onToggle={enabled => void toggle(row, slot, enabled)} onSettings={() => select(row, slot)} />;
  const family = (row: RotationMachine, value: "4" | "6") => {
    const state = familyControl(row, value);
    if (state.kind === "empty") return <span className="muted">无 IPv{value} 槽位</span>;
    if (state.kind === "multiple") return <Button variant="ghost" onClick={() => expand(row.instance.id)}>{state.slots.length} 个槽位 · {state.enabled} 已开启{state.slots.some(slot => !slot.policy) ? " · 有读取失败" : ""}</Button>;
    if (!state.slots[0]) return <span className="inline-error">加载失败</span>;
    return control(row, state.slots[0]);
  };

  return <>
    <MetricStrip items={[{ label: "全部机器", value: loading ? "…" : rows.length, detail: warnings.length ? "部分账号加载失败" : "包含未授权与不支持轮换的机器" }, { label: "故障轮换已开启", value: rows.filter(row => row.slots.some(slot => slot.policy?.enabled)).length, detail: "至少一个槽位启用故障触发" }, { label: "轮换未结束", value: rows.filter(row => row.slots.some(slot => slot.blockedRotation)).length, detail: "包括执行中、暂停与待核对" }, { label: "需要关注", value: rows.filter(row => machineMatches(row, { search: "", account: "", region: "", status: "attention" })).length, detail: "授权、能力限制或数据加载失败" }]} />
    <p className="muted rotation-list-note">开关保存后生效；关闭故障自动轮换不会终止已经开始的任务。定时轮换请进入齿轮设置，独立保存。列表来自已保存的清单，不会主动扫描云端。</p>
    <div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索轮换机器" placeholder="机器名称、IP 或账号" value={filters.search} onChange={event => filter("search", event.target.value)} /></label></div><div className="toolbar-right"><select aria-label="按云账号筛选" value={filters.account} onChange={event => filter("account", event.target.value)}><option value="">所有账号</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select aria-label="按区域筛选" value={filters.region} onChange={event => filter("region", event.target.value)}><option value="">所有区域</option>{regions.map(region => <option key={region}>{region}</option>)}</select><select aria-label="按轮换状态筛选" value={filters.status} onChange={event => filter("status", event.target.value)}><option value="">所有状态</option><option value="enabled">故障轮换已开启</option><option value="disabled">故障轮换全部关闭</option><option value="rotating">轮换未结束</option><option value="attention">需要关注</option></select><Button variant="secondary" icon={<RefreshCw size={14} />} disabled={disabled} onClick={requestLoad}>刷新机器</Button></div></div>
    {warnings.length > 0 && <div className="inline-warning" role="alert">以下账号未能加载，当前列表不完整：{warnings.join("；")}</div>}
    {loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} onRetry={requestLoad} /></div> : !visible.length ? <div className="surface"><EmptyState title={rows.length ? "没有匹配的机器" : "尚未发现云机器"} action={<Link href="/cloud-accounts">前往云计算账号</Link>} /></div> : <>
      <div className="table-wrap"><table className="rotation-machines-table"><colgroup><col style={{ width: "17%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /><col style={{ width: "7%" }} /></colgroup><thead><tr><th>机器 / 账号</th><th>服务商 / 区域</th><th>当前 IP</th><th>IPv4 故障轮换</th><th>IPv6 故障轮换</th><th>当前情况</th><th>操作</th></tr></thead><tbody>{visible.map(row => {
        const addressView = cloudAddressView(row.addresses?.length ? row.addresses : row.lastKnownAddresses ?? []);
        const notice = cloudInventoryNotice(row.inventory, addressView.mode);
        const open = expanded.has(row.instance.id);
        const blocking = row.slots.find(slot => slot.blockedRotation)?.blockedRotation;
        const incident = blocking ? incidents.find(item => item.id === blocking.incidentId) : undefined;
        const reasons = [...new Set([!row.account?.enabled ? "云账号已停用" : null, !row.inScope ? "实例已不在管理范围内" : null, ...row.slots.map(slot => rotationSlotBlock(row, slot))].filter(Boolean))];
        return <Fragment key={row.instance.id}><tr><td><div className="table-primary"><Link href={`/cloud-instances/${row.instance.id}`}><strong>{row.instance.name ?? row.instance.externalId}</strong></Link><small>{row.account?.name}</small><small className="mono">{row.instance.externalId}</small></div></td><td><div className="table-primary"><strong>{cloudServiceLabel(row.instance.service)}</strong><small>{row.instance.region}</small></div></td><td><div className="rotation-machine-addresses">{addressView.addresses.length ? addressView.addresses.map(address => <span className="mono" key={address.id}>{address.address}</span>) : <span className="muted">尚无地址</span>}{notice && <small className="muted">{notice}</small>}</div></td><td>{family(row, "4")}</td><td>{family(row, "6")}</td><td><div className="rotation-machine-status">{row.loadError ? <span className="inline-error">{row.loadError}</span> : blocking ? <Link href={`/rotations/${blocking.incidentId}`}>{incident?.status === "paused" ? "已暂停" : incident?.status === "exhausted" ? "次数耗尽" : blocking.reason === "rotation_uncertain" ? "云端结果待确认" : "轮换未结束"} · 查看任务</Link> : <span>{machinePolicySummary(row)}</span>}{reasons.map(reason => <small className="muted" key={reason}>{reason}</small>)}{!row.loadError && !row.slots.length && <small className="muted">尚无可配置的地址槽位</small>}<Link href={`/cloud-instances/${row.instance.id}`}>查看机器 / 管理授权</Link></div></td><td><IconButton label={`${open ? "收起" : "展开"} ${row.instance.name ?? row.instance.externalId} 地址与设置`} aria-expanded={open} aria-controls={`slots-${row.instance.id}`} onClick={() => expand(row.instance.id)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</IconButton></td></tr>
          {open && <tr className="rotation-machine-expanded"><td colSpan={7}><div id={`slots-${row.instance.id}`} className="rotation-slot-list">{!row.slots.length ? <p className="muted">{row.loadError ?? "暂无地址槽位，请在云账号页面同步清单。"}</p> : row.slots.map(slot => <div className="rotation-slot-row" key={slot.slot.id}><div className="table-primary"><strong>{slot.slot.name} · IPv{slot.slot.family}{slot.isCurrent === false ? " · 历史槽位" : ""}</strong><small className="mono">{slot.cloudTarget?.observedAddress?.address ?? slot.currentAddress?.address ?? "尚无观测地址"}</small><small>网卡 {slot.ref?.interfaceId ?? slot.slot.interfaceId}</small></div>{control(row, slot)}<div className="muted">{slot.policy ? <>每个任务最多 {slot.policy.maxAttempts} 次 · 间隔 {slot.policy.minIntervalSeconds} 秒<br />云端等待 {slot.policy.cloudWaitSeconds} 秒 · 复测 {slot.policy.candidateWindowSeconds} 秒</> : "策略读取失败，请刷新重试"}</div></div>)}</div></td></tr>}
        </Fragment>;
      })}</tbody></table></div>
      <div className="rotation-machine-pagination"><span className="muted">共 {filtered.length} 台 · 第 {currentPage + 1} / {lastPage + 1} 页</span><div className="row-actions"><Button variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button variant="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></div>
    </>}
  </>;
}

export function RotationSlotControl({ row, slot, disabled, busy, error, onToggle, onSettings }: { row: RotationMachine; slot: MachineSlot; disabled: boolean; busy: boolean; error?: string | undefined; onToggle: (enabled: boolean) => void; onSettings: () => void }) {
  const block = rotationSlotBlock(row, slot);
  const policy = slot.policy;
  return <div className="rotation-slot-control"><div className="rotation-slot-switch"><Switch checked={policy?.enabled ?? false} label={`${row.instance.name ?? row.instance.externalId} ${slot.slot.name} IPv${slot.slot.family} 故障自动轮换`} disabled={disabled || !policy || (!policy.enabled && block !== null)} onCheckedChange={onToggle} /><span>{busy ? "保存中…" : !policy ? "读取失败" : policy.enabled ? "已开启" : "已关闭"}</span><IconButton disabled={disabled || !policy} label={`设置 ${row.instance.name ?? row.instance.externalId} ${slot.slot.name} IPv${slot.slot.family}`} onClick={onSettings}><Settings2 size={14} /></IconButton></div>{block && <small className="muted">{block}</small>}{rotationDowntimeNotice(slot, true) && <small className="muted">{rotationDowntimeNotice(slot, true)}</small>}{(error || slot.policyError) && <small className="inline-error" role="alert">{error ?? slot.policyError}</small>}</div>;
}
