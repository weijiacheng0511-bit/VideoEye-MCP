import { useState } from "react";
import { useSubmitDouyinVideo, useReadDouyinVideo, getReadDouyinVideoQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Layout } from "@/components/layout";
import { Loader2, ArrowRight, Video, FileText, Link as LinkIcon, AlertCircle, Copy, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function Home() {
  const [input, setInput] = useState("");
  const submitMutation = useSubmitDouyinVideo();
  
  // Interactive GET demo state
  const [getTestUrl, setGetTestUrl] = useState("");
  const [activeGetUrl, setActiveGetUrl] = useState("");
  const getQuery = useReadDouyinVideo(
    { input: activeGetUrl },
    { query: { queryKey: getReadDouyinVideoQueryKey({ input: activeGetUrl }), enabled: !!activeGetUrl, retry: false } }
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    submitMutation.mutate({ data: { input: input.trim() } });
  };

  const handleGetTest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!getTestUrl.trim()) return;
    setActiveGetUrl(getTestUrl.trim());
  };

  const [copied, setCopied] = useState(false);
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Layout>
      <div className="space-y-16">
        {/* Hero */}
        <section className="space-y-4 max-w-2xl">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground">
            内容提取与解析
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">
            输入抖音分享口令或公开链接，快速提取视频的标题、作者、文案与无水印地址。专为研究与归档设计。
          </p>
        </section>

        {/* Main Parser Form */}
        <section>
          <Card className="border-primary/10 shadow-lg shadow-primary/5 overflow-hidden">
            <CardContent className="p-1">
              <form onSubmit={handleSubmit} className="relative">
                <Textarea
                  placeholder="粘贴抖音分享文本，例如：7.81 IAE:/ 复制打开抖音，看看【作者】的作品..."
                  className="min-h-[160px] resize-none border-0 focus-visible:ring-0 text-base p-6 bg-transparent"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
                <div className="absolute bottom-4 right-4">
                  <Button 
                    type="submit" 
                    size="lg" 
                    disabled={submitMutation.isPending || !input.trim()}
                    className="shadow-md"
                  >
                    {submitMutation.isPending ? (
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    ) : (
                      <ArrowRight className="mr-2 h-5 w-5" />
                    )}
                    开始解析
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </section>

        {/* Results Area */}
        <AnimatePresence mode="wait">
          {submitMutation.isPending && (
            <motion.div
              key="loading"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="h-8 w-1/3 bg-muted animate-pulse rounded-md"></div>
              <div className="h-24 w-full bg-muted animate-pulse rounded-md"></div>
              <div className="h-64 w-full bg-muted animate-pulse rounded-md"></div>
            </motion.div>
          )}

          {submitMutation.isError && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="border-destructive bg-destructive/5">
                <CardContent className="p-6 flex items-start gap-4 text-destructive">
                  <AlertCircle className="w-6 h-6 mt-0.5 shrink-0" />
                  <div>
                    <h3 className="font-semibold text-lg">解析请求失败</h3>
                    <p className="text-sm opacity-90 mt-1">
                      {submitMutation.error?.message || "发生未知错误，请稍后重试。"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {submitMutation.isSuccess && submitMutation.data && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {submitMutation.data.error ? (
                <Card className="border-destructive bg-destructive/5">
                  <CardContent className="p-6 flex items-start gap-4 text-destructive">
                    <AlertCircle className="w-6 h-6 mt-0.5 shrink-0" />
                    <div>
                      <h3 className="font-semibold text-lg">无法完整解析</h3>
                      <p className="text-sm opacity-90 mt-1">{submitMutation.data.error}</p>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {/* Header Info */}
              <div className="flex flex-col gap-6">
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold font-serif leading-snug text-foreground">
                    {submitMutation.data.title || "无标题"}
                  </h2>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    {submitMutation.data.author && (
                      <span className="font-medium text-foreground bg-secondary px-2 py-1 rounded-md">
                        @{submitMutation.data.author}
                      </span>
                    )}
                    {submitMutation.data.video_id && (
                      <span className="font-mono bg-muted px-2 py-1 rounded-md text-xs">
                        ID: {submitMutation.data.video_id}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-3">
                  {submitMutation.data.video_url && (
                    <Button variant="secondary" size="sm" asChild>
                      <a href={submitMutation.data.video_url} target="_blank" rel="noreferrer">
                        <Video className="w-4 h-4 mr-2" />
                        视频源地址
                      </a>
                    </Button>
                  )}
                  {submitMutation.data.resolved_url && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={submitMutation.data.resolved_url} target="_blank" rel="noreferrer">
                        <LinkIcon className="w-4 h-4 mr-2" />
                        网页版链接
                      </a>
                    </Button>
                  )}
                </div>
              </div>

              {/* Transcript */}
              {submitMutation.data.transcript && (
                <Card className="overflow-hidden shadow-sm">
                  <div className="bg-muted/50 px-6 py-4 border-b flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">视频文案</span>
                    </div>
                    {submitMutation.data.transcript_source && (
                      <Badge variant="outline" className="text-xs bg-background shadow-sm">
                        {submitMutation.data.transcript_source === 'native' ? '原生提取' : 'AI 听写'}
                      </Badge>
                    )}
                  </div>
                  <CardContent className="p-6 md:p-8">
                    <div className="prose prose-sm sm:prose-base prose-neutral max-w-none font-serif leading-relaxed text-foreground/90 whitespace-pre-wrap">
                      {submitMutation.data.transcript}
                    </div>
                  </CardContent>
                </Card>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <hr className="border-border/60" />

        {/* API Usage */}
        <section className="space-y-8 pt-4">
          <div className="space-y-3">
            <h2 className="text-2xl font-bold tracking-tight">API 接入指南</h2>
            <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">
              本服务提供标准 RESTful API，支持 GET 与 POST 两种调用方式。系统无需用户登录信息即可读取公开内容，但在高频调用或特定地区可能会触发平台的反爬机制导致解析失败。
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">POST 调用 (推荐)</CardTitle>
                <CardDescription>适用于传递包含特殊字符的完整分享口令</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative group">
                  <pre className="bg-muted p-4 rounded-md text-xs font-mono overflow-x-auto text-foreground/80 border">
{`curl -X POST /api/douyin/read \\
  -H "Content-Type: application/json" \\
  -d '{"input": "7.81 IAE:/ 复制打开抖音..."}'`}
                  </pre>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity bg-background border shadow-sm"
                    onClick={() => copyToClipboard(`curl -X POST /api/douyin/read -H "Content-Type: application/json" -d '{"input": "..."}'`)}
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">GET 调用</CardTitle>
                <CardDescription>适用于直接传递短链接或视频 URL</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <pre className="bg-muted p-4 rounded-md text-xs font-mono overflow-x-auto text-foreground/80 border">
{`curl "/api/douyin/read?input=https://v.douyin.com/..."`}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Interactive GET Test */}
          <Card className="border-primary/20 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">在线 GET 请求测试</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form onSubmit={handleGetTest} className="flex flex-col sm:flex-row gap-3">
                <Input
                  placeholder="输入抖音短链接，如 https://v.douyin.com/xxx/"
                  value={getTestUrl}
                  onChange={(e) => setGetTestUrl(e.target.value)}
                  className="font-mono text-sm flex-1"
                />
                <Button type="submit" variant="secondary" disabled={getQuery.isFetching}>
                  {getQuery.isFetching ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  发送请求
                </Button>
              </form>

              {getQuery.isSuccess && getQuery.data && (
                <div className="bg-foreground text-background p-4 rounded-md text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto">
                  <pre>{JSON.stringify(getQuery.data, null, 2)}</pre>
                </div>
              )}
              {getQuery.isError && (
                <div className="bg-destructive/10 border border-destructive/20 text-destructive p-4 rounded-md text-sm">
                  请求失败: {getQuery.error?.message}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </Layout>
  );
}
