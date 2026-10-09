import { useEffect, useMemo, useState } from 'react';
import {
  Gift,
  Search,
  Download,
  Copy,
  Check,
  Trash2,
  Eye,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBillingStore, type RedeemCode } from '../../stores/billing';
import { useCurrency } from './utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DataTable,
  EmptyState,
  IconButton,
  SearchInput,
  type DataTableColumn,
} from '@/components/common';
import { SettingsSection } from '@/components/settings/SettingsLayout';
import { confirmDialog } from '@/stores/confirm';
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
    const confirmed = await confirmDialog({
      title: '删除兑换码',
      message: `确定删除兑换码 ${code.code}？`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
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
      toast.error('导出失败');
    }
  };

  const columns: DataTableColumn<RedeemCode>[] = [
    {
      key: 'code',
      header: '兑换码',
      cell: (code) => (
        <div className="min-w-0">
          <code className="font-mono text-label text-foreground">
            {code.code}
          </code>
          {code.notes && (
            <div className="mt-0.5 max-w-64 truncate text-caption text-muted-foreground">
              {code.notes}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-caption tabular-nums text-muted-foreground sm:hidden">
            <Badge variant="neutral">
              {TYPE_LABELS[code.type] ?? code.type}
            </Badge>
            已用 {code.used_count}/{code.max_uses}
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: '类型',
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (code) => {
        const isExpired =
          code.expires_at && new Date(code.expires_at) < new Date();
        return (
          <div className="flex items-center gap-1">
            <Badge variant="neutral">
              {TYPE_LABELS[code.type] ?? code.type}
            </Badge>
            {isExpired && <Badge variant="error">已过期</Badge>}
          </div>
        );
      },
    },
    {
      key: 'value',
      header: '内容',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (code) => (
        <span className="text-caption tabular-nums text-muted-foreground">
          {code.type === 'balance' && <>面值: {fmt(code.value_usd ?? 0)}</>}
          {code.type === 'subscription' && (
            <>
              套餐: {code.plan_id}
              {code.duration_days != null && ` / ${code.duration_days}天`}
            </>
          )}
          {code.type === 'trial' &&
            code.duration_days != null &&
            `试用: ${code.duration_days}天`}
        </span>
      ),
    },
    {
      key: 'uses',
      header: '已用',
      align: 'right',
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (code) => (
        <span className="tabular-nums">
          {code.used_count}/{code.max_uses}
        </span>
      ),
    },
    {
      key: 'expires',
      header: '过期时间',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (code) =>
        code.expires_at ? (
          <span className="text-caption tabular-nums text-muted-foreground">
            {new Date(code.expires_at).toLocaleDateString()}
          </span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: 'batch',
      header: '批次',
      className: 'hidden lg:table-cell',
      headerClassName: 'hidden lg:table-cell',
      cell: (code) =>
        code.batch_id ? (
          <span className="font-mono text-caption text-muted-foreground">
            {code.batch_id}
          </span>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      cell: (code) => (
        <div className="flex items-center justify-end gap-0.5">
          <Popover
            open={expandedCode === code.code}
            onOpenChange={(open) => {
              if (!open && expandedCode === code.code) setExpandedCode(null);
            }}
          >
            <PopoverTrigger asChild>
              <IconButton
                label="查看使用明细"
                icon={<Eye />}
                className="text-muted-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  void handleViewUsage(code.code);
                }}
              />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <div className="text-label text-foreground">使用明细</div>
              {loadingUsage ? (
                <div className="flex items-center gap-2 text-caption text-muted-foreground">
                  <Spinner className="size-3.5" />
                  加载中...
                </div>
              ) : usageDetail.length === 0 ? (
                <p className="text-caption text-muted-foreground">
                  暂无使用记录
                </p>
              ) : (
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {usageDetail.map((d, i) => (
                    <div
                      key={i}
                      className="flex justify-between gap-3 text-caption"
                    >
                      <span className="truncate text-foreground">
                        @{d.username}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {new Date(d.redeemed_at).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
          <IconButton
            label="复制"
            icon={
              copiedCode === code.code ? (
                <Check className="text-success" />
              ) : (
                <Copy />
              )
            }
            onClick={() => handleCopy(code.code)}
            className="text-muted-foreground"
          />
          <IconButton
            label="删除"
            icon={<Trash2 />}
            onClick={() => void handleDelete(code)}
            className="text-muted-foreground hover:text-error"
          />
        </div>
      ),
    },
  ];

  return (
    <SettingsSection
      title="兑换码管理"
      actions={
        <>
          <Button variant="outline" onClick={handleExport}>
            <Download />
            CSV 导出
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus />
            创建兑换码
          </Button>
        </>
      }
    >
      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-full sm:w-36" aria-label="兑换码类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="balance">余额充值</SelectItem>
            <SelectItem value="subscription">套餐激活</SelectItem>
            <SelectItem value="trial">试用</SelectItem>
          </SelectContent>
        </Select>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索码值"
          debounce={150}
          className="w-full sm:max-w-xs"
        />
      </div>

      {/* List */}
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(code) => code.code}
        rowClassName={(code) => {
          const isExpired =
            code.expires_at && new Date(code.expires_at) < new Date();
          const isFull = code.used_count >= code.max_uses;
          return isExpired || isFull ? 'opacity-60' : undefined;
        }}
        empty={
          <EmptyState
            icon={search || typeFilter !== 'all' ? Search : Gift}
            title={
              search || typeFilter !== 'all'
                ? '未找到匹配的兑换码'
                : '暂无兑换码'
            }
          />
        }
      />

      <RedeemCodeCreateDialog open={showCreate} onOpenChange={setShowCreate} />
    </SettingsSection>
  );
}
