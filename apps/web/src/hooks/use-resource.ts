"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, UI_PREVIEW } from "../lib/api";

export function useResource<T>(path: string, previewValue: T) {
  const [data, setData] = useState<T | null>(UI_PREVIEW ? previewValue : null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef<{ path: string; active: boolean; requestId: number } | null>(null);

  const request = useCallback(async (background: boolean) => {
    const current = lifecycle.current;
    if (!current?.active || current.path !== path) return;
    const requestId = ++current.requestId;
    const isLatest = () => current.active && current.requestId === requestId;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const value = await api<T>(path);
      if (isLatest()) setData(value);
    } catch (value) {
      if (isLatest() && !background) setError(value instanceof Error ? value.message : "加载失败");
    } finally {
      // A background request can supersede a foreground load and must settle it.
      if (isLatest()) setLoading(false);
    }
  }, [path]);

  const reload = useCallback(async () => {
    if (UI_PREVIEW) { setData(previewValue); setLoading(false); return; }
    await request(false);
  }, [previewValue, request]);

  useEffect(() => {
    if (UI_PREVIEW) return;
    const current = { path, active: true, requestId: 0 };
    lifecycle.current = current;
    void Promise.resolve().then(() => {
      if (current.active) void request(false);
    });
    const refresh = () => { void request(true); };
    window.addEventListener("masterdns:invalidate", refresh);
    return () => {
      current.active = false;
      window.removeEventListener("masterdns:invalidate", refresh);
    };
  }, [path, request]);
  return { data, setData, loading, error, reload };
}
