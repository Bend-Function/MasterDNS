import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MasterDNS",
  description: "多云 DNS、健康检查与自动故障转移",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
