"use client";

import { LockKeyhole, ShieldCheck, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field } from "../../components/ui";
import { api, jsonBody, UI_PREVIEW } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true); setError(null);
    try {
      if (!UI_PREVIEW) await api("/v1/auth/login", { method: "POST", ...jsonBody({ identifier, password }) });
      router.replace("/");
    } catch (value) { setError(value instanceof Error ? value.message : "登录失败"); }
    finally { setLoading(false); }
  };
  return <main className="login-page">
    <section className="login-context">
      <div className="login-brand"><span className="brand-mark"><ShieldCheck size={20} /></span>MasterDNS</div>
      <div className="login-copy"><h1>DNS control plane</h1><p>跨 Cloudflare 与阿里云统一管理解析、节点健康、动态地址和自动故障转移。</p></div>
      <div className="login-signals"><span><LockKeyhole size={14} />本地会话与加密凭证</span><span><Workflow size={14} />变更可追踪与回滚</span></div>
    </section>
    <section className="login-panel">
      <h2>登录控制台</h2><p>使用内部账号继续</p>
      <form className="login-form" onSubmit={submit}>
        <Field label="用户名或邮箱"><input autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required autoFocus /></Field>
        <Field label="密码"><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
        {error && <div className="login-error" role="alert">{error}</div>}
        <Button type="submit" disabled={loading}>{loading ? "正在登录" : "登录"}</Button>
      </form>
    </section>
  </main>;
}
