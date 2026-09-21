import type { CloudService } from "@masterdns/contracts/cloud";
import type { CloudRotationLimitRule, CloudRotationLimitStatus } from "@masterdns/contracts/cloud-rotation-limits";
import { formatDate } from "../lib/api";
import { cloudServiceLabel } from "../lib/cloud-ui";

export function parseRotationLimitPercent(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

export function CloudRotationLimits({ services, service, status, utilizationPercent, disabled, onServiceChange, onUtilizationPercentChange }: {
  services: readonly CloudService[];
  service: CloudService;
  status: CloudRotationLimitStatus | null;
  utilizationPercent: string;
  disabled: boolean;
  onServiceChange: (service: CloudService) => void;
  onUtilizationPercentChange: (value: string) => void;
}) {
  return <div className="rotation-limit-settings">
    {services.length > 1 && <div className="segmented" aria-label="云服务">{services.map((option) => <button key={option} type="button" className={option === service ? "active" : ""} aria-pressed={option === service} disabled={disabled} onClick={() => onServiceChange(option)}>{cloudServiceLabel(option)}</button>)}</div>}
    <label className="field"><span>使用官方额度</span><div className="rotation-percent-input"><input type="number" min={1} max={100} step={1} required inputMode="numeric" value={utilizationPercent} disabled={disabled} onChange={(event) => onUtilizationPercentChange(event.target.value)} /><span>%</span></div><small>默认 80%，必须填写 1–100 的整数，不能关闭。</small></label>
    {status && <>
      <div className="rotation-limit-summary"><span>当前设置 <strong>{status.utilizationPercent}%</strong></span><span>共享生效 <strong>{status.effectivePercent}%</strong></span></div>
      {status.effectivePercent < status.utilizationPercent && <p className="inline-warning">同一远端账号还有更低的设置，当前按 {status.effectivePercent}% 生效。</p>}
      <div className="table-wrap rotation-limit-table"><table><thead><tr><th>规则</th><th>范围</th><th>官方基准</th><th>本地生效</th><th>最近用量 / 可重试</th></tr></thead><tbody>{status.rules.map((rule) => {
        const usage = status.usage.filter((entry) => entry.ruleId === rule.id);
        return <tr key={rule.id}><td><div className="table-primary"><strong>{ruleLabel(rule)}</strong><small>{rule.operations.join(" / ")}</small></div></td><td>{rule.scope === "global" ? "远端账号全局" : "按区域"}</td><td>{ruleValue(rule, true)}</td><td>{ruleValue(rule, false)}</td><td>{usage.length ? <div className="table-primary">{usage.map((entry) => <span key={`${entry.ruleId}:${entry.region ?? "global"}`}><strong>{entry.region ?? "全局"} · 已用 {formatCount(entry.used)}，剩余 {formatCount(entry.remaining)}</strong>{entry.retryAt && <small>可重试 {formatDate(entry.retryAt)}</small>}</span>)}</div> : <span className="muted">尚无消耗</span>}</td></tr>;
      })}</tbody></table></div>
    </>}
    <div className="rotation-limit-notes">
      <p>同一远端账号和云服务的本地账号共用计数，并按其中最低比例生效。</p>
      <p>这里只统计 MasterDNS 发出的换址写请求；其他工具或控制台的调用不可观测，云厂商也可能应用更低额度。</p>
      {service === "lightsail" && <p>Lightsail 滚动窗口采用官方安全下限 50 次/小时、500 次/天，不随实例数量放大；清理 Release 仍计数，但可按清理例外越过动态窗口。比例过低而无法预留完整换址步骤时，任务会暂停；提高比例后可恢复任务。</p>}
    </div>
  </div>;
}

function ruleLabel(rule: CloudRotationLimitRule): string {
  const labels: Record<string, string> = {
    "lightsail.static-ip.hour": "静态 IP 小时窗口",
    "lightsail.static-ip.day": "静态 IP 每日窗口",
    "azure.arm.writes": "Azure ARM 写入",
    "azure.arm.deletes": "Azure ARM 删除",
    "azure.network.mutations": "Azure 网络变更窗口",
    "linode.mutations": "Linode 账号变更窗口",
  };
  return labels[rule.id] ?? rule.operations.join(" / ");
}

function ruleValue(rule: CloudRotationLimitRule, official: boolean): string {
  const prefix = official ? "官方" : "生效";
  const capacity = official ? rule.officialCapacity : rule.capacity;
  if (rule.kind === "sliding_window") return `${prefix} ${formatCount(capacity)} 次 / ${durationLabel(rule.windowSeconds!)}`;
  const refill = official ? rule.officialRefillPerSecond : rule.refillPerSecond;
  return `${prefix}突发 ${formatCount(capacity)}，补充 ${formatCount(refill ?? 0)} 次/秒`;
}

function durationLabel(seconds: number): string {
  if (seconds === 86_400) return "滚动 24 小时";
  if (seconds === 3_600) return "滚动 1 小时";
  if (seconds === 60) return "1 分钟";
  return `${seconds} 秒`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value);
}
