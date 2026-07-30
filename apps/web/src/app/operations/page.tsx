"use client";

import { Eye, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, ErrorState, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, formatDate, UI_PREVIEW } from "../../lib/api";
import { demoOperations } from "../../lib/demo";
import { createIntentKey } from "../../lib/intent-key";
import type { Operation } from "../../lib/types";

export default function OperationsPage() {
  const { data, loading, error, reload } = useResource<Operation[]>("/v1/operations?limit=200", demoOperations);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Operation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const deepLinkHandled = useRef(false);
  const rollbackIntentKey = useRef(createIntentKey());
  const rows = useMemo(() => (data ?? []).filter((operation) => `${operation.id} ${operation.source} ${operation.status} ${operation.resourceType}`.toLowerCase().includes(search.toLowerCase())), [data, search]);
  const close = () => {
    rollbackIntentKey.current.reset();
    setSelected(null);
    setConfirmRollback(false);
    setActionError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("id");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const open = useCallback(async (operation: Operation, updateLocation = true) => {
    rollbackIntentKey.current.reset();
    if (updateLocation) {
      const url = new URL(window.location.href);
      url.searchParams.set("id", operation.id);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setSelected(operation);
    setActionError(null);
    if (UI_PREVIEW) {
      setSelected({ ...operation, steps: [{ id: "step-1", sequence: 1, action: "update", status: operation.status === "running" ? "running" : "succeeded", attempts: 1, errorCode: null, errorDetail: null, remoteSnapshot: { verified: true } }] });
      return;
    }
    setDetailLoading(true);
    try {
      setSelected(await api<Operation>(`/v1/operations/${operation.id}`));
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "无法加载 Operation 详情");
    } finally {
      setDetailLoading(false);
    }
  }, []);
  useEffect(() => {
    if (loading || deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const operationId = new URLSearchParams(window.location.search).get("id");
    if (!operationId) return;
    const operation = data?.find((item) => item.id === operationId);
    if (operation) {
      Promise.resolve().then(() => void open(operation, false));
      return;
    }
    Promise.resolve().then(() => setActionError("找不到指定的 Operation，可能已超出当前查询范围"));
  }, [data, loading, open]);
  const action = async (kind: "retry" | "rollback") => {
    if (!selected) return;
    if (UI_PREVIEW) { close(); return; }
    setActionPending(true);
    setActionError(null);
    try {
      await api(`/v1/operations/${selected.id}/${kind}`, { method: "POST", headers: kind === "rollback" ? { "idempotency-key": rollbackIntentKey.current.current() } : {} });
      close();
      await reload();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "操作提交失败");
    } finally {
      setActionPending(false);
    }
  };

  const startRollback = () => {
    rollbackIntentKey.current.reset();
    setActionError(null);
    setConfirmRollback(true);
  };

  const cancelRollback = () => {
    rollbackIntentKey.current.reset();
    setActionError(null);
    setConfirmRollback(false);
  };
  return <ConsoleLayout><PageHeader title="变更历史" description="每次人工与自动 DNS 写入均有独立状态和远端验证" actions={<Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => void reload()}>刷新</Button>} />{actionError && selected === null && <div className="inline-error" role="alert">{actionError}</div>}<div className="toolbar"><div className="toolbar-left"><label className="search-box"><Search size={15} /><input aria-label="搜索变更" placeholder="Operation ID、来源或状态" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div><div className="toolbar-right"><span className="muted">永久保留审计历史</span></div></div>{loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} /></div> : <div className="table-wrap"><table><thead><tr><th>Operation</th><th>来源</th><th>资源</th><th>状态</th><th>开始</th><th>完成</th><th aria-label="操作" /></tr></thead><tbody>{rows.map((operation) => <tr key={operation.id}><td><div className="table-primary"><strong className="mono">{operation.id.slice(0, 18)}</strong><small>{operation.id}</small></div></td><td>{sourceLabel(operation.source)}</td><td>{operation.resourceType}</td><td><StatusBadge value={operation.status} />{operation.errorCode && <div className="muted">{operation.errorCode}</div>}</td><td className="muted">{formatDate(operation.startedAt ?? operation.createdAt)}</td><td className="muted">{formatDate(operation.finishedAt)}</td><td><IconButton label="查看操作详情" onClick={() => void open(operation)}><Eye size={15} /></IconButton></td></tr>)}</tbody></table></div>}
    <Dialog open={selected !== null} title={confirmRollback ? "确认创建回滚" : "Operation 详情"} size="large" onClose={close} footer={confirmRollback
      ? <><Button variant="danger" icon={<RotateCcw size={14} />} disabled={actionPending} onClick={() => void action("rollback")}>{actionPending ? "提交中" : "确认回滚"}</Button><Button variant="secondary" disabled={actionPending} onClick={cancelRollback}>取消</Button></>
      : <>{selected && ["failed", "partial"].includes(selected.status) && <Button variant="secondary" icon={<RefreshCw size={14} />} disabled={actionPending} onClick={() => void action("retry")}>{actionPending ? "提交中" : "重试失败项"}</Button>}{selected?.status === "succeeded" && selected.resourceType === "dns_record" && <Button icon={<RotateCcw size={14} />} onClick={startRollback}>创建回滚操作</Button>}<Button variant="secondary" onClick={close}>关闭</Button></>}>
      {detailLoading ? <LoadingState /> : selected && (confirmRollback
        ? <><p>系统将以历史快照创建一个新的 DNS Operation，并在云端读取验证。原始历史不会被修改。</p>{actionError && <p className="inline-error">{actionError}</p>}</>
        : <><div className="field-grid"><FieldLike label="Operation ID" value={selected.id} mono /><FieldLike label="状态" value={<StatusBadge value={selected.status} />} /><FieldLike label="来源" value={sourceLabel(selected.source)} /><FieldLike label="资源" value={selected.resourceType} /></div>{actionError && <p className="inline-error">{actionError}</p>}<div className="surface" style={{ marginTop: 18 }}><header className="surface-header"><h2>执行步骤</h2></header><div className="table-wrap"><table><thead><tr><th>#</th><th>动作</th><th>状态</th><th>尝试</th><th>错误</th></tr></thead><tbody>{selected.steps?.map((step) => <tr key={step.id}><td>{step.sequence}</td><td>{step.action}</td><td><StatusBadge value={step.status} /></td><td>{step.attempts}</td><td className="muted">{step.errorCode ?? "-"}</td></tr>)}</tbody></table></div></div></>)}
    </Dialog>
  </ConsoleLayout>;
}
function FieldLike({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) { return <div className="field"><span>{label}</span><div className={mono ? "code-box" : "surface-body"}>{value}</div></div>; }
function sourceLabel(value: string) { return ({ user: "人工", failover: "故障转移", recovery: "恢复", ddns: "DDNS", drift: "漂移修复", sync: "同步", rollback: "回滚" } as Record<string, string>)[value] ?? value; }
