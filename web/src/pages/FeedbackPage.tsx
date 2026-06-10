import { useEffect, useState } from 'react';
import { useFeedbackStore } from '@/stores/feedback';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ThumbsUp, ThumbsDown, TrendingUp, MessageSquare } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

export function FeedbackPage() {
  const {
    stats,
    records,
    total,
    page,
    totalPages,
    feedbackType,
    selectedDetail,
    loading,
    error,
    fetchStats,
    fetchList,
    fetchDetail,
    setFeedbackType,
    clearDetail,
  } = useFeedbackStore();

  const [detailDialogOpen, setDetailDialogOpen] = useState(false);

  useEffect(() => {
    fetchStats();
    fetchList();
  }, []);

  const handleViewDetail = (id: string) => {
    fetchDetail(id);
    setDetailDialogOpen(true);
  };

  const handleCloseDetail = () => {
    setDetailDialogOpen(false);
    setTimeout(() => clearDetail(), 300);
  };

  const likeCount = stats?.byType.find((t) => t.feedback_type === 'like')?.count || 0;
  const dislikeCount = stats?.byType.find((t) => t.feedback_type === 'dislike')?.count || 0;
  const likeRate = stats?.total ? ((likeCount / stats.total) * 100).toFixed(1) : '0.0';

  return (
    <div className="container mx-auto p-4 lg:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">用户反馈分析</h1>
        <p className="text-muted-foreground mt-2">查看和分析用户对 AI 回复的反馈数据</p>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* 统计卡片 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">总反馈数</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.total || 0}</div>
            <p className="text-xs text-muted-foreground">累计收到的反馈</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">赞同数</CardTitle>
            <ThumbsUp className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{likeCount}</div>
            <p className="text-xs text-muted-foreground">用户点赞次数</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">反对数</CardTitle>
            <ThumbsDown className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{dislikeCount}</div>
            <p className="text-xs text-muted-foreground">用户点踩次数</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">满意度</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{likeRate}%</div>
            <p className="text-xs text-muted-foreground">赞同率</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list">反馈列表</TabsTrigger>
          <TabsTrigger value="analysis">数据分析</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          {/* 筛选按钮 */}
          <div className="flex gap-2">
            <Button
              variant={feedbackType === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFeedbackType('all')}
            >
              全部
            </Button>
            <Button
              variant={feedbackType === 'like' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFeedbackType('like')}
            >
              <ThumbsUp className="h-4 w-4 mr-1" />
              赞同
            </Button>
            <Button
              variant={feedbackType === 'dislike' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFeedbackType('dislike')}
            >
              <ThumbsDown className="h-4 w-4 mr-1" />
              反对
            </Button>
          </div>

          {/* 反馈列表 */}
          <Card>
            <CardHeader>
              <CardTitle>反馈记录</CardTitle>
              <CardDescription>共 {total} 条反馈</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-muted-foreground text-center py-8">加载中...</p>
              ) : records.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">暂无反馈数据</p>
              ) : (
                <div className="space-y-4">
                  {records.map((record) => (
                    <div
                      key={record.id}
                      className="border rounded-lg p-4 hover:bg-accent cursor-pointer transition-colors"
                      onClick={() => handleViewDetail(record.id)}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {record.feedback_type === 'like' ? (
                            <ThumbsUp className="h-5 w-5 text-green-500" />
                          ) : (
                            <ThumbsDown className="h-5 w-5 text-red-500" />
                          )}
                          <span className="font-medium">
                            {record.username || record.user_id || '匿名用户'}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(record.created_at).toLocaleString('zh-CN')}
                        </span>
                      </div>
                      <div className="space-y-2 text-sm">
                        {record.user_message_preview && (
                          <div>
                            <span className="text-muted-foreground">用户：</span>
                            <span className="ml-2">{record.user_message_preview}...</span>
                          </div>
                        )}
                        {record.ai_response_preview && (
                          <div>
                            <span className="text-muted-foreground">AI：</span>
                            <span className="ml-2">{record.ai_response_preview}...</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 分页 */}
              {totalPages > 1 && (
                <div className="flex justify-center gap-2 mt-6">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 1}
                    onClick={() => fetchList(page - 1)}
                  >
                    上一页
                  </Button>
                  <span className="text-sm text-muted-foreground flex items-center px-2">
                    第 {page} / {totalPages} 页
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === totalPages}
                    onClick={() => fetchList(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analysis" className="space-y-4">
          {/* 用户排行 */}
          <Card>
            <CardHeader>
              <CardTitle>活跃用户 Top 10</CardTitle>
              <CardDescription>反馈次数最多的用户</CardDescription>
            </CardHeader>
            <CardContent>
              {stats?.byUser && stats.byUser.length > 0 ? (
                <div className="space-y-2">
                  {stats.byUser.map((user, index) => (
                    <div key={user.user_id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-sm w-6">#{index + 1}</span>
                        <span>{user.username || user.user_id}</span>
                      </div>
                      <Badge variant="secondary">{user.count} 次</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">暂无数据</p>
              )}
            </CardContent>
          </Card>

          {/* 聊天分布 */}
          <Card>
            <CardHeader>
              <CardTitle>聊天分布 Top 10</CardTitle>
              <CardDescription>反馈最多的聊天</CardDescription>
            </CardHeader>
            <CardContent>
              {stats?.byChat && stats.byChat.length > 0 ? (
                <div className="space-y-2">
                  {stats.byChat.map((chat, index) => (
                    <div key={chat.chat_jid} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-sm w-6">#{index + 1}</span>
                        <span className="text-sm truncate max-w-[300px]">{chat.chat_name || chat.chat_jid}</span>
                      </div>
                      <Badge variant="secondary">{chat.count} 次</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">暂无数据</p>
              )}
            </CardContent>
          </Card>

          {/* 每日趋势 */}
          <Card>
            <CardHeader>
              <CardTitle>最近 30 天趋势（显示最新 10 天）</CardTitle>
              <CardDescription>每日反馈数量统计</CardDescription>
            </CardHeader>
            <CardContent>
              {stats?.dailyTrend && stats.dailyTrend.length > 0 ? (
                <div className="space-y-2">
                  {Array.from(
                    new Set(stats.dailyTrend.map((t) => t.date))
                  ).slice(0, 10).map((date) => {
                    const likeCount = stats.dailyTrend.find(
                      (t) => t.date === date && t.feedback_type === 'like'
                    )?.count || 0;
                    const dislikeCount = stats.dailyTrend.find(
                      (t) => t.date === date && t.feedback_type === 'dislike'
                    )?.count || 0;
                    return (
                      <div key={date} className="flex items-center justify-between">
                        <span className="text-sm">{date}</span>
                        <div className="flex gap-4">
                          <span className="text-green-600 text-sm">
                            <ThumbsUp className="inline h-3 w-3 mr-1" />
                            {likeCount}
                          </span>
                          <span className="text-red-600 text-sm">
                            <ThumbsDown className="inline h-3 w-3 mr-1" />
                            {dislikeCount}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">暂无数据</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 详情对话框 */}
      <Dialog open={detailDialogOpen} onOpenChange={handleCloseDetail}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedDetail?.feedback_type === 'like' ? (
                <ThumbsUp className="h-5 w-5 text-green-500" />
              ) : (
                <ThumbsDown className="h-5 w-5 text-red-500" />
              )}
              反馈详情
            </DialogTitle>
            <DialogDescription>
              {selectedDetail && new Date(selectedDetail.created_at).toLocaleString('zh-CN')}
            </DialogDescription>
          </DialogHeader>
          {selectedDetail && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium mb-2">用户信息</h4>
                <p className="text-sm text-muted-foreground">
                  {selectedDetail.username || selectedDetail.user_id || '匿名用户'}
                </p>
              </div>
              {selectedDetail.user_message && (
                <div>
                  <h4 className="text-sm font-medium mb-2">用户消息</h4>
                  <div className="bg-accent rounded-lg p-3 text-sm whitespace-pre-wrap">
                    {selectedDetail.user_message}
                  </div>
                </div>
              )}
              {selectedDetail.ai_response && (
                <div>
                  <h4 className="text-sm font-medium mb-2">AI 回复</h4>
                  <div className="bg-accent rounded-lg p-3 text-sm whitespace-pre-wrap">
                    {selectedDetail.ai_response}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
