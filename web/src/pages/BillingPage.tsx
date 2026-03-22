import { useEffect, useState } from 'react';
import {
  CreditCard,
  Package,
  Users,
  Gift,
  FileText,
  LayoutDashboard,
  Layers,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';
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

type TabKey =
  | 'overview'
  | 'pricing'
  | 'dashboard'
  | 'plans'
  | 'users'
  | 'redeem'
  | 'audit';

export default function BillingPage() {
  const user = useAuthStore((s) => s.user);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const billingStatusLoaded = useBillingStore((s) => s.billingStatusLoaded);
  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  const isAdmin = user?.role === 'admin';

  // All hooks must be called before any conditional return (React Hooks rules)
  const [tab, setTab] = useState<TabKey>('overview');
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<BillingPlan | null>(null);
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!billingStatusLoaded) {
      loadBillingStatus();
    }
  }, [billingStatusLoaded, loadBillingStatus]);

  if (!billingStatusLoaded) {
    return <div className="h-full p-6 text-sm text-zinc-500">加载账单状态中...</div>;
  }

  if (!billingEnabled) {
    return <Navigate to="/chat" replace />;
  }

  const userTabs: { key: TabKey; label: string; icon: typeof CreditCard }[] = [
    { key: 'overview', label: '概览', icon: CreditCard },
    { key: 'pricing', label: '套餐对比', icon: Layers },
  ];

  const adminTabs: { key: TabKey; label: string; icon: typeof CreditCard }[] = isAdmin
    ? [
        { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
        { key: 'plans', label: '套餐管理', icon: Package },
        { key: 'users', label: '用户管理', icon: Users },
        { key: 'redeem', label: '兑换码', icon: Gift },
        { key: 'audit', label: '审计', icon: FileText },
      ]
    : [];

  const allTabs = [...userTabs, ...adminTabs];

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-4 overflow-x-auto">
          <h2 className="text-lg font-semibold flex items-center gap-2 shrink-0">
            <CreditCard className="w-5 h-5 text-primary" />
            账单
          </h2>
          <div className="flex gap-1">
            {allTabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap ${
                  tab === key
                    ? 'bg-brand-50 dark:bg-brand-700/20 text-brand-700 dark:text-brand-300'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
        {/* User: Overview */}
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

        {/* Admin: Dashboard */}
        {tab === 'dashboard' && isAdmin && <AdminDashboard />}

        {/* Admin: Plans management */}
        {tab === 'plans' && isAdmin && (
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
        {tab === 'users' && isAdmin && (
          <AdminUsersList onSelectUser={setDrawerUserId} />
        )}

        {/* Admin: Redeem codes */}
        {tab === 'redeem' && isAdmin && <AdminRedeemCodesList />}

        {/* Admin: Audit log */}
        {tab === 'audit' && isAdmin && <AdminAuditLog />}
      </div>

      {/* Shared dialogs / drawers */}
      <PlanFormDialog
        open={planDialogOpen}
        onOpenChange={setPlanDialogOpen}
        plan={editingPlan}
      />
      <UserBillingDrawer
        userId={drawerUserId}
        onClose={() => setDrawerUserId(null)}
      />
    </div>
  );
}
