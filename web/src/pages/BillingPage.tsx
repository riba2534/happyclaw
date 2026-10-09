import { useEffect, useState } from 'react';
import {
  CreditCard,
  Package,
  Users,
  Gift,
  FileText,
  LayoutDashboard,
  Layers,
  Settings,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { PageContainer, PageTopBar } from '@/components/common';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMediaQuery } from '@/hooks/useMediaQuery';
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
  // Settings already shows its own mobile header with the section title.
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    if (!billingStatusLoaded) {
      loadBillingStatus();
    }
  }, [billingStatusLoaded, loadBillingStatus]);

  if (!billingStatusLoaded) {
    return (
      <div className="min-h-40 p-6 text-body text-muted-foreground">
        加载账单状态中...
      </div>
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

  const userTabs: { key: TabKey; label: string; icon: typeof CreditCard }[] = [
    { key: 'overview', label: '概览', icon: CreditCard },
    { key: 'pricing', label: '套餐对比', icon: Layers },
  ];

  const managementTabs: {
    key: TabKey;
    label: string;
    icon: typeof CreditCard;
  }[] =
    managementOnly && canManageBilling
      ? [
          { key: 'settings', label: '计费设置', icon: Settings },
          { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
          { key: 'plans', label: '套餐管理', icon: Package },
          { key: 'users', label: '用户账务', icon: Users },
          { key: 'redeem', label: '兑换码', icon: Gift },
          { key: 'audit', label: '计费审计', icon: FileText },
        ]
      : [];

  const allTabs = managementOnly ? managementTabs : userTabs;

  return (
    <div className="min-h-full">
      <PageTopBar
        title={managementOnly ? (isDesktop ? '计费管理' : undefined) : '账单'}
        className={managementOnly ? 'top-12 lg:top-0' : undefined}
      >
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as TabKey)}
          className="h-full min-w-0 flex-1"
        >
          <TabsList
            variant="line"
            aria-label={managementOnly ? '计费管理分区' : '账单分区'}
            className="w-full justify-start gap-4 overflow-x-auto overflow-y-hidden p-0 group-data-horizontal/tabs:h-full [scrollbar-width:none]"
          >
            {allTabs.map(({ key, label, icon: Icon }) => (
              <TabsTrigger
                key={key}
                value={key}
                className="flex-none px-0.5 group-data-horizontal/tabs:after:-bottom-px"
              >
                <Icon />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageTopBar>

      <PageContainer size="wide" className="space-y-6">
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
      </PageContainer>

      {/* Shared dialogs / drawers */}
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
}
