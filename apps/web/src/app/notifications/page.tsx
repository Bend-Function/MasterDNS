"use client";

import { BellRing, Edit3, Link2, Plus, Send, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge, Switch } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, formatDate, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoDeliveries, demoNow, demoPools } from "../../lib/demo";
import type { Delivery, NotificationChannel, Pool } from "../../lib/types";

type ChannelDraft = {
  type: "webhook" | "telegram";
  name: string;
  endpoint: string;
  secret: string;
  enabled: boolean;
  isDefault: boolean;
};

const initialDraft: ChannelDraft = {
  type: "webhook",
  name: "",
  endpoint: "",
  secret: "",
  enabled: true,
  isDefault: true,
};

const eventOptions = [
  ["endpoint.unhealthy", "节点故障"],
  ["endpoint.recovered", "节点恢复"],
  ["pool.no_healthy_endpoint", "全池故障"],
  ["pool.no_healthy_endpoint_reminder", "全池故障提醒"],
  ["binding.no_healthy_endpoint", "单个域名无可用节点"],
  ["dns.automatic_change_succeeded", "DNS 自动切换成功"],
  ["dns.automatic_change_failed", "DNS 自动切换失败"],
  ["pool.automation_paused", "自动化暂停"],
  ["pool.reconciled", "手动协调"],
] as const;

const previewChannels: NotificationChannel[] = [{
  id: "channel-1",
  ownerUserId: "demo-admin",
  type: "webhook",
  name: "Ops webhook",
  endpoint: "https://hooks.example.internal/masterdns",
  enabled: true,
  isDefault: true,
  createdAt: demoNow,
  poolLinks: [{ poolId: "pool-1", channelId: "channel-1", eventFilter: ["endpoint.unhealthy", "endpoint.recovered"], overridesDefaults: false }],
}];

export default function NotificationsPage() {
  const channels = useResource<NotificationChannel[]>("/v1/notifications/channels", previewChannels);
  const deliveries = useResource<Delivery[]>("/v1/notifications/deliveries?limit=50", demoDeliveries);
  const pools = useResource<Pool[]>("/v1/pools", demoPools);
  const [editor, setEditor] = useState<NotificationChannel | "new" | null>(null);
  const [draft, setDraft] = useState<ChannelDraft>(initialDraft);
  const [linking, setLinking] = useState<NotificationChannel | null>(null);
  const [linkPoolId, setLinkPoolId] = useState("");
  const [eventFilter, setEventFilter] = useState<string[]>([]);
  const [overridesDefaults, setOverridesDefaults] = useState(false);
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      if (!UI_PREVIEW) await action();
      await Promise.all([channels.reload(), deliveries.reload()]);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (channel?: NotificationChannel) => {
    setActionError(null);
    setEditor(channel ?? "new");
    setDraft(channel ? {
      type: channel.type,
      name: channel.name,
      endpoint: channel.type === "webhook" ? channel.endpoint ?? "" : "",
      secret: "",
      enabled: channel.enabled,
      isDefault: channel.isDefault,
    } : initialDraft);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const common = { name: draft.name, enabled: draft.enabled, isDefault: draft.isDefault };
    const success = editor === "new"
      ? await run(async () => {
        const body = draft.type === "webhook"
          ? { ...common, type: "webhook", url: draft.endpoint, secret: draft.secret }
          : { ...common, type: "telegram", chatId: draft.endpoint, botToken: draft.secret };
        await api("/v1/notifications/channels", { method: "POST", ...jsonBody(body) });
      })
      : editor
        ? await run(async () => {
          const body = draft.type === "webhook" ? {
            ...common,
            ...(draft.endpoint ? { url: draft.endpoint } : {}),
            ...(draft.secret ? { secret: draft.secret } : {}),
          } : {
            ...common,
            ...(draft.endpoint ? { chatId: draft.endpoint } : {}),
            ...(draft.secret ? { botToken: draft.secret } : {}),
          };
          await api(`/v1/notifications/channels/${editor.id}`, { method: "PATCH", ...jsonBody(body) });
        })
        : false;
    if (success) setEditor(null);
  };

  const openLinks = (channel: NotificationChannel) => {
    setLinking(channel);
    setLinkPoolId("");
    setEventFilter([]);
    setOverridesDefaults(false);
    setActionError(null);
  };

  const editLink = (link: NonNullable<NotificationChannel["poolLinks"]>[number]) => {
    setLinkPoolId(link.poolId);
    setEventFilter(link.eventFilter);
    setOverridesDefaults(link.overridesDefaults);
  };

  const saveLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!linking || !linkPoolId) return;
    if (await run(async () => {
      await api(`/v1/notifications/pools/${linkPoolId}/channels/${linking.id}`, {
        method: "POST",
        ...jsonBody({ eventFilter, overridesDefaults }),
      });
    })) {
      const refreshed = channels.data?.find((channel) => channel.id === linking.id);
      if (refreshed) setLinking(refreshed);
      setLinkPoolId("");
      setEventFilter([]);
      setOverridesDefaults(false);
    }
  };

  const unlink = async (poolId: string) => {
    if (!linking) return;
    if (await run(async () => {
      await api(`/v1/notifications/pools/${poolId}/channels/${linking.id}`, { method: "DELETE" });
    })) {
      setLinking((current) => current ? { ...current, poolLinks: (current.poolLinks ?? []).filter((link) => link.poolId !== poolId) } : null);
    }
  };

  const test = async (id: string) => {
    await run(async () => { await api(`/v1/notifications/channels/${id}/test`, { method: "POST" }); });
  };

  const remove = async () => {
    if (!deleting) return;
    if (await run(async () => { await api(`/v1/notifications/channels/${deleting.id}`, { method: "DELETE" }); })) setDeleting(null);
  };

  const ownerPools = linking ? (pools.data ?? []).filter((pool) => pool.ownerUserId === linking.ownerUserId) : [];
  const selectedLink = linking?.poolLinks?.find((link) => link.poolId === linkPoolId);

  return <ConsoleLayout>
    <PageHeader title="告警渠道" description="Webhook HMAC 签名与 Telegram 通知" actions={<Button icon={<Plus size={15} />} onClick={() => openEditor()}>添加渠道</Button>} />
    {actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <div className="content-grid">
      <section className="surface">
        <header className="surface-header"><div><h2>通知渠道</h2><p>用户默认与 Pool 覆盖</p></div></header>
        {channels.loading ? <LoadingState /> : channels.error ? <ErrorState message={channels.error} /> : channels.data?.length === 0 ? <EmptyState title="没有通知渠道" /> : <div className="table-wrap"><table>
          <thead><tr><th>渠道</th><th>目标</th><th>默认</th><th>Pool</th><th>状态</th><th aria-label="操作" /></tr></thead>
          <tbody>{channels.data?.map((channel) => <tr key={channel.id}>
            <td><div className="table-primary"><strong>{channel.name}</strong><small>{channel.type === "webhook" ? "Webhook" : "Telegram"}</small></div></td>
            <td className="mono">{channel.endpoint}</td>
            <td>{channel.isDefault ? "是" : "否"}</td>
            <td>{channel.poolLinks?.length ?? 0}</td>
            <td><StatusBadge value={channel.enabled ? "active" : "disabled"} /></td>
            <td><div className="row-actions">
              <IconButton label="发送测试消息" disabled={busy} onClick={() => void test(channel.id)}><Send size={15} /></IconButton>
              <IconButton label="管理 Pool 关联" onClick={() => openLinks(channel)}><Link2 size={15} /></IconButton>
              <IconButton label="编辑通知渠道" onClick={() => openEditor(channel)}><Edit3 size={15} /></IconButton>
              <IconButton label="删除通知渠道" onClick={() => { setActionError(null); setDeleting(channel); }}><Trash2 size={15} /></IconButton>
            </div></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <aside className="surface">
        <header className="surface-header"><div><h2>最近投递</h2><p>状态与重试次数</p></div><BellRing size={16} /></header>
        {deliveries.loading ? <LoadingState /> : deliveries.data?.length === 0 ? <EmptyState title="暂无投递记录" /> : <ul className="compact-list">{deliveries.data?.map(({ delivery, channelName }) => <li key={delivery.id}><div><strong>{channelName}</strong><small>{formatDate(delivery.createdAt)} · {delivery.attempts} 次{delivery.durationMs !== null && delivery.durationMs !== undefined ? ` · ${delivery.durationMs}ms` : ""}{delivery.errorCode ? ` · ${delivery.errorCode}` : ""}</small></div><StatusBadge value={delivery.status} /></li>)}</ul>}
      </aside>
    </div>

    <Dialog open={editor !== null} title={editor === "new" ? "添加通知渠道" : "编辑通知渠道"} onClose={() => setEditor(null)} footer={<><Button variant="secondary" onClick={() => setEditor(null)}>取消</Button><Button type="submit" form="channel-form" disabled={busy}>保存渠道</Button></>}>
      <form id="channel-form" className="field-grid" onSubmit={save}>
        {actionError && <div className="login-error span-2" role="alert">{actionError}</div>}
        <div className="span-2 segmented"><button type="button" disabled={editor !== "new"} className={draft.type === "webhook" ? "active" : ""} onClick={() => setDraft({ ...draft, type: "webhook", endpoint: "", secret: "" })}>Webhook</button><button type="button" disabled={editor !== "new"} className={draft.type === "telegram" ? "active" : ""} onClick={() => setDraft({ ...draft, type: "telegram", endpoint: "", secret: "" })}>Telegram</button></div>
        <Field label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></Field>
        <Field label={draft.type === "webhook" ? "Webhook URL" : "Chat ID"} {...(editor !== "new" && draft.type === "telegram" ? { hint: "留空则保持当前 Chat ID" } : {})}><input type={draft.type === "webhook" ? "url" : "text"} value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} required={editor === "new" || draft.type === "webhook"} /></Field>
        <Field label={draft.type === "webhook" ? "签名 Secret" : "Bot Token"} {...(editor !== "new" ? { hint: "留空则不轮换密钥" } : {})}><input type="password" autoComplete="new-password" {...(draft.type === "webhook" ? { minLength: 16 } : {})} value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} required={editor === "new"} /></Field>
        <div className="switch-row"><span>启用渠道</span><Switch checked={draft.enabled} label="切换渠道状态" onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
        <div className="switch-row"><span>用户默认渠道</span><Switch checked={draft.isDefault} label="切换默认渠道" onCheckedChange={(isDefault) => setDraft({ ...draft, isDefault })} /></div>
      </form>
    </Dialog>

    <Dialog open={linking !== null} title={`Pool 关联 · ${linking?.name ?? ""}`} size="large" onClose={() => setLinking(null)} footer={<Button onClick={() => setLinking(null)}>完成</Button>}>
      {actionError && <div className="login-error" role="alert">{actionError}</div>}
      {(linking?.poolLinks?.length ?? 0) > 0 && <div className="linked-list">{linking?.poolLinks?.map((link) => <div key={link.poolId}><div><strong>{poolName(pools.data, link.poolId)}</strong><small>{link.eventFilter.length === 0 ? "全部事件" : `${link.eventFilter.length} 类事件`}{link.overridesDefaults ? " · 覆盖默认渠道" : ""}</small></div><div className="row-actions"><IconButton label="编辑关联" onClick={() => editLink(link)}><Edit3 size={14} /></IconButton><IconButton label="解除关联" disabled={busy} onClick={() => void unlink(link.poolId)}><Trash2 size={14} /></IconButton></div></div>)}</div>}
      <form id="pool-channel-form" className="field-grid section-form" onSubmit={saveLink}>
        <Field label="IP Pool"><select value={linkPoolId} onChange={(event) => {
          const link = linking?.poolLinks?.find((item) => item.poolId === event.target.value);
          setLinkPoolId(event.target.value);
          setEventFilter(link?.eventFilter ?? []);
          setOverridesDefaults(link?.overridesDefaults ?? false);
        }} required><option value="">选择 Pool</option>{ownerPools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></Field>
        <div className="switch-row"><span>匹配时覆盖用户默认渠道</span><Switch checked={overridesDefaults} label="切换默认渠道覆盖" onCheckedChange={setOverridesDefaults} /></div>
        <fieldset className="event-filter span-2"><legend>事件过滤</legend><p>不选择表示接收该 Pool 的全部事件。</p><div>{eventOptions.map(([value, label]) => <label key={value}><input type="checkbox" checked={eventFilter.includes(value)} onChange={() => setEventFilter(toggleValue(eventFilter, value))} />{label}</label>)}</div></fieldset>
        <div className="span-2 form-actions"><Button type="submit" variant="secondary" disabled={busy || !linkPoolId}>{selectedLink ? "更新关联" : "添加关联"}</Button></div>
      </form>
    </Dialog>

    <Dialog open={deleting !== null} title="删除通知渠道" size="small" onClose={() => setDeleting(null)} footer={<><Button variant="secondary" onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void remove()}>删除渠道</Button></>}>{actionError && <div className="login-error" role="alert">{actionError}</div>}<p className="confirm-copy">删除 <strong>{deleting?.name}</strong> 及其 Pool 关联。已有投递历史将按数据库关系一并删除。</p></Dialog>
  </ConsoleLayout>;
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function poolName(pools: Pool[] | null, poolId: string) {
  return pools?.find((pool) => pool.id === poolId)?.name ?? poolId.slice(0, 8);
}
