"use client";

import { useCallback, useEffect, useState } from "react";
import { api, UI_PREVIEW } from "../lib/api";

export function useResource<T>(path: string, previewValue: T) {
  const [data, setData] = useState<T | null>(UI_PREVIEW ? previewValue : null);
  const [loading, setLoading] = useState(!UI_PREVIEW);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (UI_PREVIEW) { setData(previewValue); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try { setData(await api<T>(path)); }
    catch (value) { setError(value instanceof Error ? value.message : "加载失败"); }
    finally { setLoading(false); }
  }, [path, previewValue]);
  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    api<T>(path).then((value) => { if (active) setData(value); }).catch((value) => {
      if (active) setError(value instanceof Error ? value.message : "加载失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path]);
  useEffect(() => {
    if (UI_PREVIEW) return;
    let active = true;
    const refresh = () => {
      api<T>(path).then((value) => { if (active) setData(value); }).catch(() => undefined);
    };
    window.addEventListener("masterdns:invalidate", refresh);
    return () => {
      active = false;
      window.removeEventListener("masterdns:invalidate", refresh);
    };
  }, [path]);
  return { data, setData, loading, error, reload };
}
