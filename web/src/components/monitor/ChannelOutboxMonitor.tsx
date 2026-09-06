import { useState, useEffect, useCallback } from 'react';
import { useMonitorStore, type OutboxItem } from '../../stores/monitor';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import {
  RefreshCw,
  AlertTriangle,
  Clock,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Send,
} from 'lucide-react';

export function ChannelOutboxMonitor() {
  const {
    outboxSummary,
    outboxItems,
    outboxLoading,
    loadOutbox,
    resolveOutbox,
  } = useMonitorStore();

  const [filter, setFilter] = useState<
    'all' | 'overdue' | 'uncertain' | 'failed' | 'pending'
  >('all');
  const [activeItem, setActiveItem] = useState<OutboxItem | null>(null);
  const [resolution, setResolution] = useState<'delivered' | 'failed'>(
    'delivered',
  );
  const [providerMessageId, setProviderMessageId] = useState('');
  const [resolveError, setResolveError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [impactNotice, setImpactNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchItems = useCallback(() => {
    if (filter === 'overdue') {
      loadOutbox({ overdueOnly: true });
    } else if (filter === 'all') {
      loadOutbox({});
    } else {
      loadOutbox({ status: filter });
    }
  }, [filter, loadOutbox]);

  useEffect(() => {
    fetchItems();
    const timer = setInterval(() => {
      fetchItems();
    }, 10000);
    return () => clearInterval(timer);
  }, [fetchItems]);

  const handleOpenResolve = (item: OutboxItem) => {
    setActiveItem(item);
    setResolution('delivered');
    setProviderMessageId('');
    setResolveError('');
    setActionError(null);
    setImpactNotice(null);
  };

  const handleSubmitResolve = async () => {
    if (!activeItem) return;
    if (resolution === 'delivered' && !providerMessageId.trim()) {
      setActionError(
        '确认已送达时必须提供第三方渠道的消息 ID (providerMessageId)',
      );
      return;
    }

    setSubmitting(true);
    setActionError(null);
    try {
      const res = await resolveOutbox(activeItem.id, {
        resolution,
        expectedRevision: activeItem.revision,
        providerMessageId:
          resolution === 'delivered' ? providerMessageId.trim() : undefined,
        error:
          resolution === 'failed'
            ? resolveError.trim() || '操作员标记投递失败'
            : undefined,
      });

      if (res.ok) {
        setImpactNotice(
          res.impact?.description || '裁决已生效，相关 Turn 栅栏已释放。',
        );
        fetchItems();
        setTimeout(() => {
          setActiveItem(null);
          setImpactNotice(null);
        }, 2500);
      }
    } catch (err: any) {
      if (err?.status === 409) {
        setActionError(
          `CAS 版本冲突：条目状态或版本已发生变更（当前版本: ${err?.body?.currentRevision ?? '未知'}），请刷新后重试。`,
        );
        fetchItems();
      } else {
        setActionError(err?.message || '裁决提交失败，请检查网络或日志。');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (item: OutboxItem) => {
    if (item.status === 'uncertain') {
      return (
        <Badge
          variant="outline"
          className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 flex items-center gap-1"
        >
          <HelpCircle className="w-3.5 h-3.5" /> 待人工确认
        </Badge>
      );
    }
    if (item.status === 'failed') {
      return (
        <Badge
          variant="outline"
          className="bg-destructive/10 text-destructive border-destructive/30 flex items-center gap-1"
        >
          <XCircle className="w-3.5 h-3.5" /> 投递失败
        </Badge>
      );
    }
    if (item.status === 'delivered') {
      return (
        <Badge
          variant="outline"
          className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 flex items-center gap-1"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> 已送达
        </Badge>
      );
    }
    if (item.status === 'retry_wait') {
      return (
        <Badge
          variant="outline"
          className="bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30 flex items-center gap-1"
        >
          <Clock className="w-3.5 h-3.5" /> 等待重试
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className="bg-muted text-muted-foreground flex items-center gap-1"
      >
        <Send className="w-3.5 h-3.5" /> 排队中 ({item.status})
      </Badge>
    );
  };

  return (
    <Card className="mt-6 border-border">
      <CardContent className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">
                渠道出站队列 (Outbox) 监控
              </h2>
              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                R12 投递定位
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              实时监控多渠道出站消息年龄、状态、异常原因与来源定位；支持对丢失
              ACK 的条目进行 CAS 人工裁决。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchItems}
            disabled={outboxLoading}
            className="shrink-0"
          >
            <RefreshCw
              className={`w-4 h-4 mr-1.5 ${outboxLoading ? 'animate-spin' : ''}`}
            />
            刷新队列
          </Button>
        </div>

        {/* 统计指标卡片 */}
        {outboxSummary && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className="p-3 bg-muted/40 rounded-lg border border-border">
              <div className="text-xs text-muted-foreground">总出站数</div>
              <div className="text-lg font-semibold text-foreground mt-0.5">
                {outboxSummary.total}
              </div>
            </div>
            <div
              className={`p-3 rounded-lg border ${outboxSummary.uncertain > 0 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-muted/40 border-border'}`}
            >
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                待确认 (Uncertain)
                {outboxSummary.uncertain > 0 && (
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                )}
              </div>
              <div
                className={`text-lg font-semibold mt-0.5 ${outboxSummary.uncertain > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}
              >
                {outboxSummary.uncertain}
              </div>
            </div>
            <div
              className={`p-3 rounded-lg border ${outboxSummary.overdue > 0 ? 'bg-destructive/10 border-destructive/30' : 'bg-muted/40 border-border'}`}
            >
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                超期风险 (Overdue)
                {outboxSummary.overdue > 0 && (
                  <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                )}
              </div>
              <div
                className={`text-lg font-semibold mt-0.5 ${outboxSummary.overdue > 0 ? 'text-destructive font-bold' : 'text-foreground'}`}
              >
                {outboxSummary.overdue}
              </div>
            </div>
            <div className="p-3 bg-muted/40 rounded-lg border border-border">
              <div className="text-xs text-muted-foreground">待发送 / 重试</div>
              <div className="text-lg font-semibold text-foreground mt-0.5">
                {outboxSummary.pending + outboxSummary.retryWait}
              </div>
            </div>
            <div className="p-3 bg-muted/40 rounded-lg border border-border">
              <div className="text-xs text-muted-foreground">投递失败</div>
              <div className="text-lg font-semibold text-foreground mt-0.5">
                {outboxSummary.failed}
              </div>
            </div>
            <div className="p-3 bg-muted/40 rounded-lg border border-border">
              <div className="text-xs text-muted-foreground">已确认送达</div>
              <div className="text-lg font-semibold text-foreground mt-0.5">
                {outboxSummary.delivered}
              </div>
            </div>
          </div>
        )}

        {/* 筛选控制器 */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button
            size="sm"
            variant={filter === 'all' ? 'default' : 'outline'}
            onClick={() => setFilter('all')}
            className="text-xs h-7 px-2.5"
          >
            全部条目
          </Button>
          <Button
            size="sm"
            variant={filter === 'overdue' ? 'default' : 'outline'}
            onClick={() => setFilter('overdue')}
            className={`text-xs h-7 px-2.5 ${outboxSummary?.overdue ? 'border-destructive/50 text-destructive' : ''}`}
          >
            超期项 ({outboxSummary?.overdue || 0})
          </Button>
          <Button
            size="sm"
            variant={filter === 'uncertain' ? 'default' : 'outline'}
            onClick={() => setFilter('uncertain')}
            className={`text-xs h-7 px-2.5 ${outboxSummary?.uncertain ? 'border-amber-500/50 text-amber-600 dark:text-amber-400' : ''}`}
          >
            待人工确认 ({outboxSummary?.uncertain || 0})
          </Button>
          <Button
            size="sm"
            variant={filter === 'failed' ? 'default' : 'outline'}
            onClick={() => setFilter('failed')}
            className="text-xs h-7 px-2.5"
          >
            失败项
          </Button>
          <Button
            size="sm"
            variant={filter === 'pending' ? 'default' : 'outline'}
            onClick={() => setFilter('pending')}
            className="text-xs h-7 px-2.5"
          >
            排队中
          </Button>
        </div>

        {/* 列表 / 表格 */}
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full divide-y divide-border text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2.5">状态 / 年龄</th>
                <th className="px-3 py-2.5">来源 Bot / 渠道</th>
                <th className="px-3 py-2.5">目标群组 / 会话</th>
                <th className="px-3 py-2.5">异常原因</th>
                <th className="px-3 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {outboxItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    暂无相关出站记录
                  </td>
                </tr>
              ) : (
                outboxItems.map((item) => (
                  <tr
                    key={item.id}
                    className="hover:bg-muted/40 transition-colors"
                  >
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <div>{getStatusBadge(item)}</div>
                        <div className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
                          <Clock className="w-3 h-3 shrink-0" />
                          <span>{item.ageFormatted} 前</span>
                          {item.isOverdue && (
                            <span className="text-destructive font-bold inline-flex items-center gap-0.5 ml-1">
                              [超期]
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-foreground">
                        {item.route.botName || item.route.provider}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono">
                        {item.route.provider} · acc:{' '}
                        {item.route.accountId.slice(0, 10)}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-foreground">
                          {item.route.groupName ||
                            item.route.groupFolder ||
                            item.route.sourceJid}
                        </span>
                        {item.route.navigationUrl && (
                          <a
                            href={item.route.navigationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline inline-flex items-center gap-0.5 text-[11px]"
                            title="导航至该工作区会话"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono truncate max-w-xs">
                        {item.route.agentId
                          ? `agent: ${item.route.agentId}`
                          : item.route.sessionId
                            ? `session: ${item.route.sessionId}`
                            : item.route.sourceJid}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground max-w-md">
                      {item.error ? (
                        <span className="text-destructive/90 break-words font-mono text-[11px]">
                          {item.error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {item.status === 'uncertain' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleOpenResolve(item)}
                          className="h-7 text-xs font-medium"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 mr-1" />
                          人工裁决
                        </Button>
                      ) : item.route.navigationUrl ? (
                        <a
                          href={item.route.navigationUrl}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          前往会话 <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground/40 text-[11px]">
                          只读
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>

      {/* CAS 人工裁决弹窗 */}
      <Dialog
        open={Boolean(activeItem)}
        onOpenChange={(open) => !open && setActiveItem(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <ShieldCheck className="w-5 h-5 text-amber-500" />
              人工裁决待确认投递
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              由于网络中断或第三方平台未及时返回
              ACK，该投递处于待确认状态。为防止同一消息重复投递，其所属 Turn
              已被并发栅栏锁定。
            </DialogDescription>
          </DialogHeader>

          {activeItem && (
            <div className="space-y-4 py-2 text-xs">
              {/* 元数据展示 */}
              <div className="bg-muted/40 p-3 rounded-md space-y-1.5 border border-border font-mono text-[11px]">
                <div>
                  <span className="text-muted-foreground">条目 ID:</span>{' '}
                  {activeItem.id}
                </div>
                <div>
                  <span className="text-muted-foreground">当前版本 (CAS):</span>{' '}
                  rev {activeItem.revision}
                </div>
                <div>
                  <span className="text-muted-foreground">来源渠道:</span>{' '}
                  {activeItem.route.provider} (
                  {activeItem.route.botName || activeItem.route.accountId})
                </div>
                <div>
                  <span className="text-muted-foreground">目标群/工作区:</span>{' '}
                  {activeItem.route.groupName ||
                    activeItem.route.groupFolder ||
                    activeItem.route.sourceJid}
                </div>
                {activeItem.route.sessionId && (
                  <div>
                    <span className="text-muted-foreground">Session ID:</span>{' '}
                    {activeItem.route.sessionId}
                  </div>
                )}
                <div className="text-amber-600 dark:text-amber-400 font-sans text-xs pt-1">
                  🔒
                  消息正文严格受隐私边界保护未在此处展示。请在对应聊天窗口核实机器人是否已发言。
                </div>
              </div>

              {/* 裁决类型选择 */}
              <div className="space-y-2">
                <label className="font-semibold text-foreground block">
                  选择裁决结果：
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={resolution === 'delivered' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setResolution('delivered');
                      setActionError(null);
                    }}
                    className="text-xs justify-start"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-emerald-500" />
                    确认已成功送达
                  </Button>
                  <Button
                    type="button"
                    variant={
                      resolution === 'failed' ? 'destructive' : 'outline'
                    }
                    size="sm"
                    onClick={() => {
                      setResolution('failed');
                      setActionError(null);
                    }}
                    className="text-xs justify-start"
                  >
                    <XCircle className="w-3.5 h-3.5 mr-1.5" />
                    标记投递失败
                  </Button>
                </div>
              </div>

              {/* 附加输入 */}
              {resolution === 'delivered' ? (
                <div className="space-y-1.5">
                  <label className="font-medium text-foreground block">
                    第三方渠道消息 ID (providerMessageId){' '}
                    <span className="text-destructive">*</span>
                  </label>
                  <Input
                    placeholder="例如: om_xxxxxxxx 或 msg_xxxx"
                    value={providerMessageId}
                    onChange={(e) => setProviderMessageId(e.target.value)}
                    className="text-xs h-8"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    必填。请从目标聊天或日志中获取该消息在平台上的唯一 ID。
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="font-medium text-foreground block">
                    失败原因说明 (可选)
                  </label>
                  <Input
                    placeholder="例如: 确认群内未收到，放弃补发"
                    value={resolveError}
                    onChange={(e) => setResolveError(e.target.value)}
                    className="text-xs h-8"
                  />
                </div>
              )}

              {/* 错误与影响提示 */}
              {actionError && (
                <div className="p-2.5 bg-destructive/10 border border-destructive/30 rounded text-destructive text-xs">
                  {actionError}
                </div>
              )}

              {impactNotice && (
                <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded text-emerald-600 dark:text-emerald-400 text-xs">
                  {impactNotice}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActiveItem(null)}
              disabled={submitting}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleSubmitResolve}
              disabled={submitting || Boolean(impactNotice)}
              className="text-xs"
            >
              {submitting ? '提交裁决中...' : '确认并释放栅栏'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
