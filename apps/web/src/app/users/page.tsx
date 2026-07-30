"use client";

import { KeyRound, Plus, UserRoundCheck, UserRoundX } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConsoleLayout } from "../../components/console-layout";
import { Button, Dialog, EmptyState, ErrorState, Field, IconButton, LoadingState, PageHeader, StatusBadge } from "../../components/ui";
import { useResource } from "../../hooks/use-resource";
import { api, formatDate, jsonBody, UI_PREVIEW } from "../../lib/api";
import { demoNow, demoUser } from "../../lib/demo";
import type { User } from "../../lib/types";

const previewUsers: User[] = [demoUser, { id: "user-2", username: "oncall", email: "oncall@example.internal", role: "user", status: "active", createdAt: demoNow }];
export default function UsersPage() {
  const { data, loading, error, reload } = useResource<User[]>("/v1/users", previewUsers);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setActionError("");
    try {
      if (!UI_PREVIEW) { await api("/v1/users", { method: "POST", ...jsonBody({ username, email: email || undefined, password, role }) }); await reload(); }
      setOpen(false);
      setUsername(""); setEmail(""); setPassword(""); setRole("user");
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "创建用户失败");
    }
  };
  const toggle = async (user: User) => {
    setActionError("");
    try {
      if (!UI_PREVIEW) { await api(`/v1/users/${user.id}/status`, { method: "PATCH", ...jsonBody({ status: user.status === "active" ? "disabled" : "active" }) }); await reload(); }
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "修改用户状态失败");
    }
  };
  const openReset = (user: User) => {
    setResetTarget(user);
    setResetPassword("");
    setResetError("");
  };
  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetTarget) return;
    setResetBusy(true);
    setResetError("");
    try {
      if (!UI_PREVIEW) await api(`/v1/users/${resetTarget.id}/reset-password`, { method: "POST", ...jsonBody({ password: resetPassword }) });
      setResetTarget(null);
      setResetPassword("");
    } catch (requestError) {
      setResetError(requestError instanceof Error ? requestError.message : "密码重置失败");
    } finally {
      setResetBusy(false);
    }
  };
  return <ConsoleLayout><PageHeader title="用户管理" description="轻量本地账号与资源隔离" actions={<Button icon={<Plus size={15} />} onClick={() => { setActionError(""); setOpen(true); }}>创建用户</Button>} />{actionError && <div className="inline-error" role="alert">{actionError}</div>}{loading ? <div className="surface"><LoadingState /></div> : error ? <div className="surface"><ErrorState message={error} /></div> : data?.length === 0 ? <div className="surface"><EmptyState title="没有用户" /></div> : <div className="table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{data?.map((user) => <tr key={user.id}><td><div className="table-primary"><strong>{user.username}</strong><small>{user.email ?? "未设置邮箱"}</small></div></td><td>{user.role === "admin" ? "管理员" : "普通用户"}</td><td><StatusBadge value={user.status} /></td><td className="muted">{formatDate(user.createdAt)}</td><td><div className="row-actions"><IconButton label="重置密码" onClick={() => openReset(user)}><KeyRound size={15} /></IconButton><IconButton label={user.status === "active" ? "停用用户" : "启用用户"} onClick={() => void toggle(user)}>{user.status === "active" ? <UserRoundX size={15} /> : <UserRoundCheck size={15} />}</IconButton></div></td></tr>)}</tbody></table></div>}
    <Dialog open={open} title="创建用户" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>取消</Button><Button type="submit" form="user-form">创建用户</Button></>}><form id="user-form" className="field-grid" onSubmit={create}><Field label="用户名"><input value={username} onChange={(event) => setUsername(event.target.value)} required /></Field><Field label="邮箱"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field><Field label="初始密码"><input type="password" value={password} minLength={12} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} required /></Field><Field label="角色"><select value={role} onChange={(event) => setRole(event.target.value as "admin" | "user")}><option value="user">普通用户</option><option value="admin">管理员</option></select></Field>{actionError && <div className="login-error span-2">{actionError}</div>}</form></Dialog>
    <Dialog open={Boolean(resetTarget)} title={`重置 ${resetTarget?.username ?? "用户"} 的密码`} onClose={() => setResetTarget(null)} size="small" footer={<><Button variant="secondary" onClick={() => setResetTarget(null)}>取消</Button><Button type="submit" form="reset-password-form" disabled={resetBusy}>{resetBusy ? "正在重置" : "确认重置"}</Button></>}><form id="reset-password-form" onSubmit={reset}><Field label="新密码" hint="至少 12 位；重置后该用户的现有会话全部失效"><input type="password" value={resetPassword} minLength={12} autoComplete="new-password" onChange={(event) => setResetPassword(event.target.value)} required autoFocus /></Field>{resetError && <p className="login-error">{resetError}</p>}</form></Dialog>
  </ConsoleLayout>;
}
