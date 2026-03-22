import { useEffect, useMemo, useState } from 'react';
import {
  Gift,
  Search,
  Download,
  Copy,
  Check,
  Trash2,
  Eye,
  Loader2,
} from 'lucide-react';
import { useBillingStore, type RedeemCode } from '../../stores/billing';
import { useCurrency } from './utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import RedeemCodeCreateDialog from './RedeemCodeCreateDialog';

const TYPE_LABELS: Record<string, string> = {
  balance: '余额充值',
  subscription: '套餐激活',
  trial: '试用',
};

export default function AdminRedeemCodesList() {
  const {
    redeemCodes,
    loadRedeemCodes,
    deleteRedeemCode,
    exportRedeemCodesCSV,
    getRedeemCodeUsage,
  } = useBillingStore();
  const fmt = useCurrency();

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [usageDetail, setUsageDetail] = useState<
    Array<{ user_id: string; username: string; redeemed_at: string }>
  >([]);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    loadRedeemCodes();
  }, [loadRedeemCodes]);

  const filtered = useMemo(() => {
    return redeemCodes.filter((c) => {
      if (typeFilter !== 'all' && c.type !== typeFilter) return false;
      if (search && !c.code.toLowerCase().includes(search.toLowerCase()))
        return false;
      return true;
    });
  }, [redeemCodes, typeFilter, search]);

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleDelete = async (code: RedeemCode) => {
    if (!confirm(`确定删除兑换码 ${code.code}？`)) return;
    await deleteRedeemCode(code.code);
  };

  const handleViewUsage = async (code: string) => {
    if (expandedCode === code) {
      setExpandedCode(null);
      return;
    }
    setExpandedCode(code);
    setLoadingUsage(true);
    try {
      const details = await getRedeemCodeUsage(code);
      setUsageDetail(details);
    } catch {
      setUsageDetail([]);
    } finally {
      setLoadingUsage(false);
    }
  };

  const handleExport = async () => {
    try {
      await exportRedeemCodesCSV();
    } catch {
      alert('导出失败');
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold flex items-center gap-2">
          <Gift className="w-5 h-5 text-primary" />
          兑换码管理
        </h3>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowCreate(true)}>
            创建兑换码
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="w-4 h-4" />
            CSV 导出
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 px-3 text-sm border border-zinc-300 dark:border-zinc-600 rounded-md bg-transparent"
        >
          <option value="all">全部类型</option>
          <option value="balance">余额充值</option>
          <option value="subscription">套餐激活</option>
          <option value="trial">试用</option>
        </select>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索码值"
            className="pl-9"
          />
        </div>
      </div>

      {/* List */}
      <div className="space-y-2">
        {filtered.map((code) => {
          const isExpired =
            code.expires_at && new Date(code.expires_at) < new Date();
          const isFull = code.used_count >= code.max_uses;

          return (
            <div key={code.code}>
              <div
                className={`flex items-center justify-between p-3 bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 ${
                  isExpired || isFull ? 'opacity-60' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-sm font-mono">{code.code}</code>
                    <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400">
                      {TYPE_LABELS[code.type] ?? code.type}
                    </span>
                    {isExpired && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
                        已过期
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5 space-x-2">
                    {code.type === 'balance' && (
                      <span>面值: {fmt(code.value_usd ?? 0)}</span>
                    )}
                    {code.type === 'subscription' && (
                      <span>
                        套餐: {code.plan_id}
                        {code.duration_days != null &&
                          ` / ${code.duration_days}天`}
                      </span>
                    )}
                    {code.type === 'trial' && code.duration_days != null && (
                      <span>试用: {code.duration_days}天</span>
                    )}
                    <span>
                      已用 {code.used_count}/{code.max_uses}
                    </span>
                    {code.expires_at && (
                      <span>
                        过期{' '}
                        {new Date(code.expires_at).toLocaleDateString()}
                      </span>
                    )}
                    {code.batch_id && <span>批次: {code.batch_id}</span>}
                  </div>
                  {code.notes && (
                    <div className="text-[10px] text-zinc-400 mt-0.5">
                      {code.notes}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <button
                    onClick={() => handleViewUsage(code.code)}
                    className="p-1.5 text-zinc-400 hover:text-primary"
                    title="查看使用明细"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleCopy(code.code)}
                    className="p-1.5 text-zinc-400 hover:text-primary"
                    title="复制"
                  >
                    {copiedCode === code.code ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(code)}
                    className="p-1.5 text-zinc-400 hover:text-red-500"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Usage detail expand */}
              {expandedCode === code.code && (
                <div className="ml-4 mt-1 p-3 bg-zinc-50 dark:bg-zinc-900 rounded-md border border-zinc-200 dark:border-zinc-700">
                  {loadingUsage ? (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      加载中...
                    </div>
                  ) : usageDetail.length === 0 ? (
                    <p className="text-xs text-zinc-500">暂无使用记录</p>
                  ) : (
                    <div className="space-y-1">
                      {usageDetail.map((d, i) => (
                        <div
                          key={i}
                          className="flex justify-between text-xs"
                        >
                          <span>@{d.username}</span>
                          <span className="text-zinc-400">
                            {new Date(d.redeemed_at).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-zinc-500 text-center py-8">
          {search || typeFilter !== 'all'
            ? '未找到匹配的兑换码'
            : '暂无兑换码'}
        </p>
      )}

      <RedeemCodeCreateDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}
