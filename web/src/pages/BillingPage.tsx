import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageContainer, PageHeader } from '@/components/common';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../stores/auth';
import { useBillingStore, type BillingPlan } from '../stores/billing';

// User components
import SubscriptionCard from '../components/billing/SubscriptionCard';
import BalanceCard from '../components/billing/BalanceCard';
import UsageCard from '../components/billing/UsageCard';
import DailyUsageChart from '../components/billing/DailyUsageChart';
import TransactionsList from '../components/billing/TransactionsList';
import PricingGrid from '../components/billing/PricingGrid';

// Admin components
import AdminDashboard from '../components/billing/AdminDashboard';
import AdminPlansList from '../components/billing/AdminPlansList';
import PlanFormDialog from '../components/billing/PlanFormDialog';
import AdminUsersList from '../components/billing/AdminUsersList';
import UserBillingDrawer from '../components/billing/UserBillingDrawer';
import AdminRedeemCodesList from '../components/billing/AdminRedeemCodesList';
import AdminAuditLog from '../components/billing/AdminAuditLog';
import AdminBillingSettings from '../components/billing/AdminBillingSettings';

type TabKey =
  | 'overview'
  | 'pricing'
  | 'dashboard'
  | 'plans'
  | 'users'
  | 'redeem'
  | 'audit'
  | 'settings';

/**
 * Underline tabs that scroll sideways on narrow screens. The edge that still
 * has hidden tabs fades out, since mobile scrollbars stay invisible at rest.
 */
function BillingTabs({
  value,
  onChange,
  tabs,
  label,
}: {
  value: TabKey;
  onChange: (tab: TabKey) => void;
  tabs: { key: TabKey; label: string }[];
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const update = () => {
      const maxScroll = node.scrollWidth - node.clientWidth;
      const next = {
        start: node.scrollLeft > 2,
        end: node.scrollLeft < maxScroll - 2,
      };
      setEdges((current) =>
        current.start === next.start && current.end === next.end
          ? current
          : next,
      );
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-state="active"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);

  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as TabKey)}>
      <div className="border-b border-surface-border">
        <TabsList
          ref={listRef}
          variant="line"
          aria-label={label}
          className={cn(
            'h-10 w-full justify-start gap-4 overflow-x-auto overflow-y-hidden p-0 group-data-horizontal/tabs:h-10 [scrollbar-width:none]',
            edges.start &&
              edges.end &&
              '[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]',
            edges.start &&
              !edges.end &&
              '[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]',
            !edges.start &&
              edges.end &&
              '[mask-image:linear-gradient(to_left,transparent,black_1.5rem)]',
          )}
        >
          {tabs.map(({ key, label: tabLabel }) => (
            <TabsTrigger
              key={key}
              value={key}
              className="flex-none px-0.5 group-data-horizontal/tabs:after:-bottom-px"
            >
              {tabLabel}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}

interface BillingPageProps {
  managementOnly?: boolean;
}

export default function BillingPage({
  managementOnly = false,
}: BillingPageProps) {
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const billingStatusLoaded = useBillingStore((s) => s.billingStatusLoaded);
  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  const canManageBilling = useAuthStore((state) =>
    state.hasPermission('manage_billing'),
  );

  // All hooks must be called before any conditional return (React Hooks rules)
  const [tab, setTab] = useState<TabKey>(
    managementOnly ? 'settings' : 'overview',
  );
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<BillingPlan | null>(null);
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!billingStatusLoaded) {
      loadBillingStatus();
    }
  }, [billingStatusLoaded, loadBillingStatus]);

  if (!billingStatusLoaded) {
    const loadingState = (
      <div className="min-h-40 text-body text-muted-foreground">
        加载账单状态中...
      </div>
    );
    return managementOnly ? (
      loadingState
    ) : (
      <PageContainer size="wide">{loadingState}</PageContainer>
    );
  }

  if (managementOnly && !canManageBilling) {
    return <Navigate to="/settings" replace />;
  }

  if (!managementOnly && !billingEnabled) {
    if (canManageBilling) {
      return <Navigate to="/settings?tab=billing" replace />;
    }
    return <Navigate to="/chat" replace />;
  }

  const userTabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'pricing', label: '套餐对比' },
  ];

  const managementTabs: { key: TabKey; label: string }[] =
    managementOnly && canManageBilling
      ? [
          { key: 'settings', label: '计费设置' },
          { key: 'dashboard', label: '仪表盘' },
          { key: 'plans', label: '套餐管理' },
          { key: 'users', label: '用户账务' },
          { key: 'redeem', label: '兑换码' },
          { key: 'audit', label: '计费审计' },
        ]
      : [];

  const allTabs = managementOnly ? managementTabs : userTabs;

  const content = (
    <div className="space-y-6">
      <BillingTabs
        value={tab}
        onChange={setTab}
        tabs={allTabs}
        label={managementOnly ? '计费管理分区' : '账单分区'}
      />

      {/* User: Overview */}
      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <BalanceCard />
            <SubscriptionCard />
            <UsageCard />
          </div>
          <DailyUsageChart />
          <TransactionsList />
        </>
      )}

      {/* User: Pricing comparison */}
      {tab === 'pricing' && <PricingGrid />}

      {/* Billing management settings */}
      {managementOnly && tab === 'settings' && canManageBilling && (
        <AdminBillingSettings />
      )}

      {/* Admin: Dashboard */}
      {managementOnly && tab === 'dashboard' && canManageBilling && (
        <AdminDashboard />
      )}

      {/* Admin: Plans management */}
      {managementOnly && tab === 'plans' && canManageBilling && (
        <AdminPlansList
          onEditPlan={(plan) => {
            setEditingPlan(plan);
            setPlanDialogOpen(true);
          }}
          onCreatePlan={() => {
            setEditingPlan(null);
            setPlanDialogOpen(true);
          }}
        />
      )}

      {/* Admin: Users management */}
      {managementOnly && tab === 'users' && canManageBilling && (
        <AdminUsersList onSelectUser={setDrawerUserId} />
      )}

      {/* Admin: Redeem codes */}
      {managementOnly && tab === 'redeem' && canManageBilling && (
        <AdminRedeemCodesList />
      )}

      {/* Admin: Audit log */}
      {managementOnly && tab === 'audit' && canManageBilling && (
        <AdminAuditLog />
      )}

      {managementOnly && (
        <>
          <PlanFormDialog
            open={planDialogOpen}
            onOpenChange={setPlanDialogOpen}
            plan={editingPlan}
          />
          <UserBillingDrawer
            userId={drawerUserId}
            onClose={() => setDrawerUserId(null)}
          />
        </>
      )}
    </div>
  );

  // Settings supplies the page frame and header for the management view.
  if (managementOnly) return content;

  return (
    <PageContainer size="wide" className="space-y-6">
      <PageHeader title="账单" />
      {content}
    </PageContainer>
  );
}
