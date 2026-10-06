import { ReactNode } from "react";
import { useHealthCheck } from "@workspace/api-client-react";
import { Link } from "wouter";

export function Layout({ children }: { children: ReactNode }) {
  const { data: health } = useHealthCheck();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background font-sans selection:bg-primary/20">
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="container mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold text-foreground hover:opacity-80 transition-opacity">
            <div className="w-6 h-6 rounded bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
              读
            </div>
            <span>抖音视频解析工具</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            {health ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="relative flex h-2 w-2">
                  {health.status === "ok" ? (
                    <>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </>
                  ) : (
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive"></span>
                  )}
                </span>
                系统状态
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-12">
        {children}
      </main>
      <footer className="py-8 border-t border-border/50 text-center text-sm text-muted-foreground">
        <p>此服务通过公开接口解析视频，可能受区域或反爬策略限制。</p>
      </footer>
    </div>
  );
}
