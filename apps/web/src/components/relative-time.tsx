"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "../lib/api";

export function RelativeTime({ value }: { value: string | Date | null | undefined }) {
  const timestamp = value instanceof Date ? value.toISOString() : value ?? null;
  const [label, setLabel] = useState(() => stableTimestamp(timestamp));

  useEffect(() => {
    const update = () => setLabel(relativeTime(timestamp));
    const initial = window.setTimeout(update, 0);
    const interval = window.setInterval(update, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [timestamp]);

  return <time dateTime={timestamp ?? undefined}>{label}</time>;
}

function stableTimestamp(value: string | null): string {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().slice(0, 16).replace("T", " ");
}
