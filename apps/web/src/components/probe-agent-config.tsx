"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { createProbeAgentConfigJson, type ProbeAgentConfigInput } from "../lib/probe-install";
import { Button, Field } from "./ui";

export function ProbeAgentConfig({ input }: { input: ProbeAgentConfigInput }) {
  const [platform, setPlatform] = useState<"linux" | "manual">("linux");
  const [copyResult, setCopyResult] = useState<{ json: string; success: boolean } | null>(null);
  let configJson: string;
  try {
    configJson = createProbeAgentConfigJson({ ...input, platform });
  } catch (error) {
    return <section><strong>完整配置文件 config.json</strong><div className="inline-error" role="alert">{error instanceof Error ? error.message : "无法生成 Agent 配置"}</div></section>;
  }

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configJson);
      setCopyResult({ json: configJson, success: true });
    } catch {
      setCopyResult({ json: configJson, success: false });
    }
  };
  const currentCopyResult = copyResult?.json === configJson ? copyResult : null;

  return <section aria-label="Agent 配置文件">
    <div className="agent-config-header">
      <strong>完整配置文件 config.json</strong>
      <Button variant="secondary" icon={<Copy size={14} />} onClick={() => void copyConfig()}>复制配置 JSON</Button>
    </div>
    <Field label="配置路径">
      <select value={platform} onChange={(event) => { setPlatform(event.target.value as "linux" | "manual"); setCopyResult(null); }}>
        <option value="linux">Linux（systemd 服务）</option>
        <option value="manual">Windows / macOS（手动运行）</option>
      </select>
    </Field>
    <pre className="code-box" tabIndex={0} aria-label="config.json"><code>{configJson}</code></pre>
    {currentCopyResult && (currentCopyResult.success
      ? <small role="status">配置 JSON 已复制</small>
      : <div className="inline-error" role="alert">复制失败，请选中上方 JSON 手动复制。</div>)}
    <small>{platform === "linux"
      ? "保存至 /etc/masterdns-agent/config.json，并确保 masterdns-agent 账号可读写。"
      : "将 config.json 保存到当前用户目录下的 Agent 文件夹，并在该文件夹中运行 enroll 和 run；相对路径以运行目录为准。Windows 请使用 UTF-8 无 BOM 编码保存。"}</small>
    <small>这是注册前的完整配置。使用一次性 Token 执行 enroll 后，Agent 会自动写入运行凭据文件；随后才能启动。重新注册时请保留已有的 CA、网络和路径设置。</small>
    <small>无 IPv6 网络时将 allowIpv6 改为 false；caFile 留空使用系统证书。Agent 并发上限为 64，内网探测需按实际需求填写 allowedPrivateCidrs。</small>
  </section>;
}
