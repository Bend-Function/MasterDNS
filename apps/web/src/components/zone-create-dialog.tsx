"use client";

import { createZonesInputSchema, type ZoneCreationResult, type ZoneCreationSuccess } from "@masterdns/contracts/zones";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError, jsonBody, UI_PREVIEW } from "../lib/api";
import { createRequestGeneration } from "../lib/session-state";
import type { ProviderAccount, ZoneListRow } from "../lib/types";
import { Button, Dialog, Field, StatusBadge } from "./ui";

const errorMessages: Record<string, string> = {
  authentication_failed: "Cloudflare Token 无效，请更新账号凭据",
  permission_denied: "Cloudflare 权限不足，请确认 Token 具有目标账号的 Zone 编辑权限",
  rate_limited: "Cloudflare 请求频率受限，请稍后重试",
  validation_failed: "Cloudflare 拒绝了该域名，请确认它是可接入的完整域名",
  transient_failure: "Cloudflare 暂时无法响应，域名可能已创建，请稍后重试以核对结果",
};

export function ZoneCreateDialog({ accounts, zones, onClose, onChanged }: {
  accounts: ProviderAccount[];
  zones: ZoneListRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const available = accounts.filter(account => account.provider === "cloudflare" && account.status === "active");
  const knownIds = (id: string) => [...new Set(zones.filter(row => row.zone.providerAccountId === id).flatMap(row => {
    const value = row.zone.providerMetadata?.accountId;
    return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value) ? [value] : [];
  }))];
  const initialId = available[0]?.id ?? "";
  const defaultAccountId = (id: string) => { const ids = knownIds(id); return ids.length === 1 ? ids[0]! : UI_PREVIEW ? "a".repeat(32) : ""; };
  const [providerAccountId, setProviderAccountId] = useState(initialId);
  const [cloudflareAccountId, setCloudflareAccountId] = useState(() => defaultAccountId(initialId));
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [name, setName] = useState("");
  const [names, setNames] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [results, setResults] = useState<ZoneCreationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const requests = useRef(createRequestGeneration());
  const formId = useId();
  const accountListId = useId();
  useEffect(() => { const current = requests.current; return () => { current.invalidate(); }; }, []);
  const selected = available.find(account => account.id === providerAccountId);
  const failed = results.filter(result => result.status === "failed");

  const run = async (domainNames: string[], retry = false) => {
    if (pending.current || !selected) return;
    const token = requests.current.current();
    const current = new Map((retry ? results : []).map(result => [result.name, result]));
    pending.current = true; setSaving(true); setError(null); setResults([...current.values()]);
    setProgress({ completed: 0, total: domainNames.length });
    let completed = 0;
    let changed = false;
    try {
      for (const domainName of domainNames) {
        if (!requests.current.isCurrent(token)) break;
        let result: ZoneCreationResult;
        try {
          result = UI_PREVIEW
            ? { name: domainName, status: "created", zoneId: "zone-1", zoneStatus: "pending", nameServers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"] }
            : await api<ZoneCreationSuccess>("/v1/zones", { method: "POST", ...jsonBody({ providerAccountId, cloudflareAccountId: cloudflareAccountId.trim().toLowerCase(), name: domainName }) });
          changed = true;
        } catch (cause) {
          const code = cause instanceof ApiError ? cause.code : "request_failed";
          result = { name: domainName, status: "failed", error: { code, message: errorMessages[code] ?? (cause instanceof Error ? cause.message : "添加失败，请稍后重试") } };
        }
        if (!requests.current.isCurrent(token)) break;
        current.set(domainName, result);
        setResults([...current.values()]); setProgress({ completed: ++completed, total: domainNames.length });
      }
    } finally {
      pending.current = false;
      if (requests.current.isCurrent(token)) { setSaving(false); if (changed) onChanged(); }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || !selected) return;
    const parsed = createZonesInputSchema.safeParse({
      providerAccountId: UI_PREVIEW ? "3ebae6b0-ff56-4dd0-a1f4-42b8af07aa65" : providerAccountId,
      cloudflareAccountId,
      names: mode === "single" ? [name] : names.trim().split(/[\s,，;；]+/u).filter(Boolean),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请检查域名及账号信息"); return; }
    void run(parsed.data.names);
  };

  return <Dialog open title="新增域名" size="large" onClose={() => { if (!pending.current) onClose(); }} footer={<>
    <Button variant="secondary" disabled={saving} onClick={onClose}>关闭</Button>
    {failed.length > 0 && <Button variant="secondary" disabled={saving || !selected} onClick={() => void run(failed.map(result => result.name), true)}>重试失败项</Button>}
    <Button type="submit" form={formId} disabled={saving || !selected || !(mode === "single" ? name : names).trim()}>{saving ? "正在添加…" : mode === "single" ? "添加域名" : "开始批量添加"}</Button>
  </>}>
    <form id={formId} onSubmit={submit} className="zone-creation-form">
      <div className="segmented" role="group" aria-label="添加方式">
        <button type="button" aria-pressed={mode === "single"} className={mode === "single" ? "active" : ""} disabled={saving} onClick={() => { setMode("single"); setError(null); }}>单个添加</button>
        <button type="button" aria-pressed={mode === "batch"} className={mode === "batch" ? "active" : ""} disabled={saving} onClick={() => { setMode("batch"); setError(null); }}>批量添加</button>
      </div>
      <Field label="Cloudflare DNS 账号"><select value={selected?.id ?? ""} disabled={saving || available.length === 0} onChange={event => { setProviderAccountId(event.target.value); setCloudflareAccountId(defaultAccountId(event.target.value)); setResults([]); setError(null); }}>
        <option value="" disabled>请选择账号</option>{available.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select></Field>
      {!available.length && <p className="muted">请先<Link href="/accounts">接入并启用 Cloudflare DNS 账号</Link>。</p>}
      <Field label="Cloudflare Account ID" hint="在 Cloudflare 账号概览中复制 Account ID；已同步域名的账号 ID 可直接选用。">
        <input name="cloudflareAccountId" value={cloudflareAccountId} list={accountListId} disabled={saving} autoComplete="off" placeholder="32 位 Cloudflare 账号 ID" onChange={event => { setCloudflareAccountId(event.target.value); setResults([]); }} />
        <datalist id={accountListId}>{knownIds(providerAccountId).map(id => <option key={id} value={id} />)}</datalist>
      </Field>
      {mode === "single" ? <Field label="域名" hint="输入完整域名，例如 example.com；支持中文域名。"><input name="name" value={name} disabled={saving} autoComplete="off" placeholder="example.com" onChange={event => setName(event.target.value)} /></Field>
        : <Field label="域名列表" hint="每行一个域名，也支持逗号或空格分隔。重复域名自动去重，每次最多 100 个。"><textarea name="names" value={names} disabled={saving} rows={6} placeholder={"example.com\nexample.net\nexample.org"} onChange={event => setNames(event.target.value)} /></Field>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </form>
    {(saving || results.length > 0) && <section className="zone-creation-results" aria-label="域名添加结果">
      <p role="status" aria-live="polite">{saving ? `正在添加 ${progress.completed}/${progress.total}` : `处理完成：${results.filter(result => result.status === "created").length} 个新增，${results.filter(result => result.status === "existing").length} 个已存在，${failed.length} 个失败`}</p>
      {results.some(result => result.status !== "failed" && result.zoneStatus === "pending") && <p className="muted">请在域名注册商处将 NS 改为下方 Cloudflare 分配的服务器，生效后域名才会激活。</p>}
      <ul>{results.map(result => <li key={result.name}>
        <div className="zone-creation-result-heading"><strong>{result.name}</strong><StatusBadge value={result.status === "failed" ? "failed" : "succeeded"} /></div>
        {result.status === "failed" ? <p className="inline-error">{result.error.message}</p> : <>
          <p className="muted">{result.status === "existing" ? "域名已存在，已接入本地列表" : "域名已添加"} · {result.zoneStatus === "pending" ? "等待 NS 生效" : "已激活"} <Link href={`/zones/${result.zoneId}`}>管理解析</Link></p>
          {result.nameServers.length > 0 && <div className="zone-name-servers">{result.nameServers.map(server => <code key={server}>{server}</code>)}</div>}
        </>}
      </li>)}</ul>
    </section>}
  </Dialog>;
}
