"use client";

import type { ConsensusPolicy, HealthCheckConfig } from "@masterdns/contracts";
import { useMemo, useState, type FormEvent } from "react";
import { consensusPreview, defaultMinimumValid, validateProbePolicyDraft } from "../lib/probe-policy";
import type { AddressHealthPolicy, HealthConfigRow, HealthPolicyInput, ProbeAgent, ProbeGroup } from "../lib/probe-types";
import { Field, Switch } from "./ui";

type Props = {
  formId: string;
  targetKind: "slot" | "endpoint";
  targetId: string;
  family: "4" | "6";
  policy?: AddressHealthPolicy | null | undefined;
  config?: HealthConfigRow | null | undefined;
  groups: ProbeGroup[];
  probes: ProbeAgent[];
  isAdmin: boolean;
  onSubmit: (input: { config: HealthCheckConfig; policy: HealthPolicyInput }) => Promise<void>;
};

type ConsensusMode = ConsensusPolicy["mode"];

export function ProbePolicyForm({ formId, targetKind, targetId, family, policy, config, groups, probes, isAdmin, onSubmit }: Props) {
  const initialConfig = config?.config ?? defaultConfig();
  const [checkType, setCheckType] = useState<"http" | "tcp">(initialConfig.type);
  const [protocol, setProtocol] = useState(initialConfig.type === "http" ? initialConfig.protocol : "https");
  const [port, setPort] = useState(initialConfig.port ?? (initialConfig.type === "tcp" ? 443 : 443));
  const [hostname, setHostname] = useState(initialConfig.type === "http" ? initialConfig.hostname ?? "" : "");
  const [method, setMethod] = useState<"GET" | "HEAD">(initialConfig.type === "http" ? initialConfig.method : "GET");
  const [path, setPath] = useState(initialConfig.type === "http" ? initialConfig.path : "/");
  const [headers, setHeaders] = useState(initialConfig.type === "http" ? Object.entries(initialConfig.headers).map(([key, value]) => `${key}: ${value}`).join("\n") : "");
  const [statusList, setStatusList] = useState(initialConfig.type === "http" ? initialConfig.expectedStatuses?.join(", ") ?? "" : "");
  const [statusMin, setStatusMin] = useState(initialConfig.type === "http" ? initialConfig.expectedStatusMin : 200);
  const [statusMax, setStatusMax] = useState(initialConfig.type === "http" ? initialConfig.expectedStatusMax : 399);
  const [bodyContains, setBodyContains] = useState(initialConfig.type === "http" ? initialConfig.bodyContains ?? "" : "");
  const [bodyPattern, setBodyPattern] = useState(initialConfig.type === "http" ? initialConfig.bodyPattern ?? "" : "");
  const [followRedirects, setFollowRedirects] = useState(initialConfig.type === "http" ? initialConfig.followRedirects : true);
  const [verifyTls, setVerifyTls] = useState(initialConfig.type === "http" ? initialConfig.verifyTls : true);
  const [timeoutMs, setTimeoutMs] = useState(initialConfig.timeoutMs);
  const initialMode = targetKind === "slot" && policy?.mode === "local" ? "external" : policy?.mode ?? "external";
  const [mode, setMode] = useState<"local" | "external" | "mixed">(initialMode);
  const [groupId, setGroupId] = useState(policy?.groupId ?? groups[0]?.id ?? "");
  const [consensusMode, setConsensusMode] = useState<ConsensusMode>(policy?.consensus.mode ?? "majority");
  const [minimumValid, setMinimumValid] = useState(policy?.consensus.minimumValid ?? defaultMinimumValid(initialMode, groups.find((group) => group.id === groupId)?.memberIds.length ?? 0));
  const [failureVotes, setFailureVotes] = useState(policy?.consensus.mode === "at_least" ? policy.consensus.failureVotes ?? 1 : 1);
  const [specifiedProbeId, setSpecifiedProbeId] = useState(policy?.consensus.mode === "specified" ? policy.consensus.specifiedProbeId ?? "" : "");
  const [checkIntervalSeconds, setCheckIntervalSeconds] = useState(policy?.checkIntervalSeconds ?? 15);
  const [executionWindowSeconds, setExecutionWindowSeconds] = useState(policy?.executionWindowSeconds ?? 10);
  const [resultExpirySeconds, setResultExpirySeconds] = useState(policy?.resultExpirySeconds ?? 60);
  const [successThreshold, setSuccessThreshold] = useState(policy?.successThreshold ?? 3);
  const [failureThreshold, setFailureThreshold] = useState(policy?.failureThreshold ?? 3);
  const [privateCidrs, setPrivateCidrs] = useState(policy?.networkPolicy?.allowedPrivateCIDRs.join("\n") ?? "");
  const [error, setError] = useState<string | null>(null);

  const group = groups.find((candidate) => candidate.id === groupId);
  const groupMembers = probes.filter((probe) => group?.memberIds.includes(probe.id));
  const cohortSize = mode === "local" ? 1 : groupMembers.length + (mode === "mixed" ? 1 : 0);
  const consensus = useMemo<ConsensusPolicy>(() => consensusMode === "at_least"
    ? { mode: consensusMode, minimumValid, failureVotes }
    : consensusMode === "specified"
      ? { mode: consensusMode, minimumValid, specifiedProbeId }
      : { mode: consensusMode, minimumValid }, [consensusMode, failureVotes, minimumValid, specifiedProbeId]);
  const preview = consensusPreview(consensus, cohortSize);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const errors = validateProbePolicyDraft({ cohortSize, mode, targetKind, consensus, checkIntervalSeconds, executionWindowSeconds, resultExpirySeconds, timeoutMs });
    if (mode !== "local" && !groupId) errors.push("group_required");
    if (consensusMode === "specified" && !(group?.memberIds.includes(specifiedProbeId) ?? false)) errors.push("specified_probe_required");
    if (errors.length) { setError(policyError(errors[0]!)); return; }

    try {
      const nextConfig = checkType === "tcp"
        ? { type: "tcp" as const, port, timeoutMs }
        : {
            type: "http" as const, protocol, ...(port ? { port } : {}), ...(hostname.trim() ? { hostname: hostname.trim() } : {}), method, path,
            headers: parseHeaders(headers), expectedStatusMin: statusMin, expectedStatusMax: statusMax, ...(parseStatuses(statusList).length ? { expectedStatuses: parseStatuses(statusList) } : {}),
            ...(bodyContains ? { bodyContains } : {}), ...(bodyPattern ? { bodyPattern } : {}), followRedirects, verifyTls, timeoutMs,
          };
      await onSubmit({
        config: nextConfig,
        policy: {
          ...(targetKind === "slot" ? { slotId: targetId } : { endpointId: targetId }), family,
          configId: config?.id ?? "", mode, ...(mode !== "local" ? { groupId } : {}), ...(policy ? { expectedRevision: policy.revision } : {}), consensus,
          checkIntervalSeconds, executionWindowSeconds, resultExpirySeconds, successThreshold, failureThreshold,
          ...(isAdmin && privateCidrs.trim() ? { networkPolicy: { allowedPrivateCIDRs: privateCidrs.split(/\s+/u).filter(Boolean) } } : {}),
        },
      });
    } catch (value) { setError(value instanceof Error ? value.message : "健康策略保存失败"); }
  };

  return <form id={formId} className="policy-form" onSubmit={submit}>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <fieldset disabled={targetKind === "endpoint" && Boolean(config)}><legend>检查请求</legend>{targetKind === "endpoint" && config && <p className="fieldset-note">普通节点沿用 Pool 中的检查配置；请在对应 Pool 修改请求参数。</p>}<div className="field-grid">
      <Field label="检查类型"><div className="segmented"><button type="button" className={checkType === "http" ? "active" : ""} onClick={() => setCheckType("http")}>HTTP(S)</button><button type="button" className={checkType === "tcp" ? "active" : ""} onClick={() => setCheckType("tcp")}>TCP</button></div></Field>
      {checkType === "http" && <Field label="协议"><select value={protocol} onChange={(event) => setProtocol(event.target.value as "http" | "https")}><option value="https">HTTPS</option><option value="http">HTTP</option></select></Field>}
      <Field label="端口"><input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} required /></Field>
      <Field label="超时（毫秒）"><input type="number" min={100} max={60000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} required /></Field>
      {checkType === "http" && <><Field label="Host / SNI"><input value={hostname} onChange={(event) => setHostname(event.target.value)} /></Field><Field label="方法"><select value={method} onChange={(event) => setMethod(event.target.value as "GET" | "HEAD")}><option>GET</option><option>HEAD</option></select></Field><Field label="路径"><input value={path} onChange={(event) => setPath(event.target.value)} required pattern="/.*" /></Field><Field label="期望状态码列表" hint="留空时使用状态码范围"><input value={statusList} onChange={(event) => setStatusList(event.target.value)} placeholder="200, 204" /></Field><Field label="状态码下限"><input type="number" min={100} max={599} value={statusMin} disabled={Boolean(statusList.trim())} onChange={(event) => setStatusMin(Number(event.target.value))} /></Field><Field label="状态码上限"><input type="number" min={100} max={599} value={statusMax} disabled={Boolean(statusList.trim())} onChange={(event) => setStatusMax(Number(event.target.value))} /></Field><Field label="响应包含"><input value={bodyContains} maxLength={2048} onChange={(event) => setBodyContains(event.target.value)} /></Field><Field label="响应正则"><input value={bodyPattern} maxLength={2048} onChange={(event) => setBodyPattern(event.target.value)} /></Field><Field label="请求 Header" hint="每行 Name: Value"><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} /></Field><div className="policy-switches"><div className="switch-row"><span>跟随重定向</span><Switch checked={followRedirects} label="跟随重定向" onCheckedChange={setFollowRedirects} /></div><div className="switch-row"><span>验证 TLS 证书</span><Switch checked={verifyTls} label="验证 TLS 证书" onCheckedChange={setVerifyTls} /></div></div></>}
    </div></fieldset>
    <fieldset><legend>探测与投票</legend><div className="field-grid">
      <Field label="探测模式"><select value={mode} onChange={(event) => { const next = event.target.value as "local" | "external" | "mixed"; setMode(next); setMinimumValid(defaultMinimumValid(next, group?.memberIds.length ?? 0)); }}><option value="external">外部探测</option><option value="mixed">本地 + 外部</option>{targetKind === "endpoint" && <option value="local">仅本地</option>}</select></Field>
      {mode !== "local" && <Field label="固定探测组"><select value={groupId} onChange={(event) => { const next = event.target.value; setGroupId(next); setSpecifiedProbeId(""); setMinimumValid(defaultMinimumValid(mode, groups.find((item) => item.id === next)?.memberIds.length ?? 0)); }} required><option value="">选择探测组</option>{groups.map((item) => { const supported = item.memberIds.length > 0 && item.memberIds.every((id) => { const capabilities = probes.find((probe) => probe.id === id)?.capabilities; return family === "4" ? capabilities?.ipv4 : capabilities?.ipv6; }); return <option key={item.id} value={item.id} disabled={!supported}>{item.name} / Revision {item.revision}{supported ? "" : ` / IPv${family} 能力不足`}</option>; })}</select></Field>}
      <Field label="投票规则"><select value={consensusMode} onChange={(event) => setConsensusMode(event.target.value as ConsensusMode)}><option value="majority">多数失败</option><option value="any">任一失败</option><option value="all">全部失败</option><option value="at_least">至少 K 票失败</option><option value="specified">指定探测点</option></select></Field>
      <Field label="最少有效结果 Q"><input type="number" min={1} max={Math.max(1, cohortSize)} value={minimumValid} onChange={(event) => setMinimumValid(Number(event.target.value))} required /></Field>
      {consensusMode === "at_least" && <Field label="失败票数 K"><input type="number" min={1} max={Math.max(1, cohortSize)} value={failureVotes} onChange={(event) => setFailureVotes(Number(event.target.value))} required /></Field>}
      {consensusMode === "specified" && <Field label="指定探测点"><select value={specifiedProbeId} onChange={(event) => setSpecifiedProbeId(event.target.value)} required><option value="">选择探测点</option>{groupMembers.map((probe) => <option key={probe.id} value={probe.id}>{probe.name}</option>)}</select></Field>}
    </div><div className="vote-preview"><strong>固定 Cohort：{cohortSize} 票</strong><span>有效结果不足 {minimumValid} 票时为未知；unknown / unavailable 不计失败。</span><span>{preview.failureVotesRequired === null ? "由指定探测点结果决定" : `失败需 F >= ${preview.failureVotesRequired}；成功需 S > ${cohortSize} - ${preview.failureVotesRequired}，即至少 ${preview.successVotesRequired} 票。`}</span></div></fieldset>
    <fieldset><legend>轮次与状态</legend><div className="field-grid"><Field label="检查间隔（秒）"><input type="number" min={1} max={86400} value={checkIntervalSeconds} onChange={(event) => setCheckIntervalSeconds(Number(event.target.value))} required /></Field><Field label="轮次截止（秒）"><input type="number" min={1} max={300} value={executionWindowSeconds} onChange={(event) => setExecutionWindowSeconds(Number(event.target.value))} required /></Field><Field label="结果有效期（秒）"><input type="number" min={1} max={86400} value={resultExpirySeconds} onChange={(event) => setResultExpirySeconds(Number(event.target.value))} required /></Field><Field label="连续成功轮数"><input type="number" min={1} max={100} value={successThreshold} onChange={(event) => setSuccessThreshold(Number(event.target.value))} required /></Field><Field label="连续失败轮数"><input type="number" min={1} max={100} value={failureThreshold} onChange={(event) => setFailureThreshold(Number(event.target.value))} required /></Field>{isAdmin && <Field label="允许的私网 CIDR" hint="每行一个，仅管理员可配置"><textarea value={privateCidrs} onChange={(event) => setPrivateCidrs(event.target.value)} /></Field>}</div></fieldset>
  </form>;
}

function defaultConfig(): HealthCheckConfig { return { type: "http", protocol: "https", method: "GET", path: "/", headers: {}, expectedStatusMin: 200, expectedStatusMax: 399, followRedirects: true, verifyTls: true, timeoutMs: 3000 }; }
function parseStatuses(value: string) { return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item)); }
function parseHeaders(value: string) { return Object.fromEntries(value.split("\n").map((line) => { const separator = line.indexOf(":"); return separator < 1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]; }).filter((entry): entry is [string, string] => Boolean(entry))); }
function policyError(value: string) { return ({ interval_before_window: "检查间隔不能短于轮次截止时间", expiry_before_window: "结果有效期不能短于轮次截止时间", timeout_exceeds_window: "外部检查超时需为任务领取保留至少 1 秒", minimum_valid_exceeds_cohort: "最少有效结果不能超过固定 Cohort", failure_votes_exceed_cohort: "失败票数不能超过固定 Cohort", slot_requires_external_vote: "云地址槽位必须包含至少一个有效外部探测票", group_required: "请选择探测组", specified_probe_required: "请选择固定 Cohort 内的探测点" } as Record<string, string>)[value] ?? "策略配置不合法"; }
