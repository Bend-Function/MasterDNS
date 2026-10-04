import type { RotationDetail } from "../lib/rotation-types";
import { StatusBadge } from "./ui";

export function RotationTemporaryInstances({ instances }: { instances?: RotationDetail["temporaryInstances"] }) {
  if (!instances?.length) return null;
  const retained = instances.some(instance => instance.cleanupStatus !== "released");
  return <section className="surface">
    <header className="surface-header"><div><h2>Linode 临时实例</h2><p>用于交换 IPv4 的临时实例，生产实例及其磁盘保留</p></div></header>
    {retained && <div className="surface-body"><div className="inline-warning" role="alert">以下尚未完成清理的临时实例可能持续计费。失败、暂停或终止任务不会自动删除这些实例，请按实例 ID、区域和任务记录核对；恢复任务后系统仍须验证归属与清理条件。</div></div>}
    <div className="table-wrap"><table><thead><tr><th>临时实例 / ID</th><th>区域</th><th>所属尝试</th><th>换下的旧 IP</th><th>提供的新 IP</th><th>清理状态</th></tr></thead><tbody>{instances.map(instance => <tr key={`${instance.id}:${instance.attemptId}`}><td><div className="table-primary"><strong>{instance.label}</strong><small className="mono">{instance.id}</small></div></td><td>{instance.region}</td><td className="mono">{instance.attemptId}</td><td className="mono">{instance.originalAddress}</td><td className="mono">{instance.candidateAddress ?? "尚未确认"}</td><td><StatusBadge value={instance.cleanupStatus} /></td></tr>)}</tbody></table></div>
  </section>;
}
