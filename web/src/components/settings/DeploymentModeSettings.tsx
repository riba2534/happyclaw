import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, type ApiError } from '../../api/client';
import { useAuthStore, type DeploymentMode } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useChatStore } from '../../stores/chat';
import { useGroupsStore } from '../../stores/groups';
import { confirmDialog } from '../../stores/confirm';
import { Callout } from '@/components/capabilities/capability-ui';
import { SettingsGroup, SettingsSection } from './SettingsLayout';
import { DeploymentModeChoice } from './DeploymentModeChoice';
import type { HostIntegrationSettings, OtherActiveUser } from './types';
import { getErrorMessage } from './types';

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  member: '成员',
  guest: '访客',
};

interface Conflict {
  message: string;
  users: OtherActiveUser[];
}

function conflictOf(error: unknown): Conflict | null {
  const body = (error as ApiError | null)?.body;
  if (body?.code !== 'SINGLE_USER_HOST_OTHER_USERS') return null;
  return {
    message: getErrorMessage(error, '请先停用其他账号。'),
    users: Array.isArray(body.users) ? (body.users as OtherActiveUser[]) : [],
  };
}

/**
 * 部署方式: switching it takes effect at once (after a confirm), separately
 * from the host settings form, because it migrates workspaces and restarts
 * runners.
 */
export function DeploymentModeSettings({
  settings,
  onSaved,
}: {
  settings: HostIntegrationSettings;
  onSaved: (data: HostIntegrationSettings) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const current: DeploymentMode = settings.deploymentMode ?? 'multi_user';

  const switchTo = async (mode: DeploymentMode) => {
    if (mode === current || saving) return;
    const toSingle = mode === 'single_user_host';
    const confirmed = await confirmDialog(
      toSingle
        ? {
            title: '切换到单人宿主机模式？',
            message:
              '你的工作区和自动化会迁移到宿主机运行，正在运行的会话会重启；注册、用户与访问、访客、计费和 Docker 相关设置随之隐藏。已有工作区的目录不变。',
            confirmText: '切换',
          }
        : {
            title: '切换到多人模式？',
            message:
              '只保存这项设置：已有工作区仍在宿主机上运行，注册、用户与访问、访客和计费重新出现。',
            confirmText: '切换',
          },
    );
    if (!confirmed) return;
    setSaving(true);
    setConflict(null);
    try {
      const data = await api.put<HostIntegrationSettings>(
        '/api/config/host-integration',
        { deploymentMode: mode },
      );
      useAuthStore
        .getState()
        .setDeploymentMode(data.deploymentMode ?? 'multi_user');
      onSaved(data);
      // Workspaces moved to the host, and billing follows the mode.
      await Promise.allSettled([
        useChatStore.getState().loadGroups(),
        useGroupsStore.getState().loadGroups(),
        useBillingStore.getState().loadBillingStatus({ force: true }),
      ]);
      toast.success(toSingle ? '已切换到单人宿主机模式' : '已切换到多人模式');
    } catch (error) {
      const refused = conflictOf(error);
      if (refused) {
        setConflict(refused);
      } else {
        toast.error(getErrorMessage(error, '部署方式切换失败，请稍后重试。'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="部署方式"
      description="单人宿主机模式下不再使用 Docker，也没有注册、其他用户、访客和计费；切换后立即生效。"
    >
      <SettingsGroup className="p-4">
        <DeploymentModeChoice
          legend="部署方式"
          value={current}
          onChange={(mode) => void switchTo(mode)}
          disabled={saving}
          hint={
            <>
              {saving && (
                <p
                  role="status"
                  className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground"
                >
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  正在切换…
                </p>
              )}
              {settings.deploymentModeSource === 'env' && (
                <p className="mt-2 text-caption text-muted-foreground">
                  当前取自环境变量
                  HAPPYCLAW_DEPLOYMENT_MODE；在这里切换后以系统设置为准。
                </p>
              )}
              {conflict && (
                <Callout tone="error" role="alert" className="mt-3">
                  <div className="min-w-0 space-y-1.5">
                    <p>{conflict.message}</p>
                    {conflict.users.length > 0 && (
                      <ul
                        aria-label="仍在使用的其他账号"
                        className="list-disc space-y-0.5 pl-4"
                      >
                        {conflict.users.map((user) => (
                          <li key={user.id}>
                            <span className="font-mono">{user.username}</span>
                            {' · '}
                            {ROLE_LABELS[user.role] ?? user.role}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p>
                      在
                      <Link
                        to="/settings?tab=users"
                        className="mx-1 underline underline-offset-2"
                      >
                        用户与访问
                      </Link>
                      和
                      <Link
                        to="/settings?tab=guests"
                        className="mx-1 underline underline-offset-2"
                      >
                        访客
                      </Link>
                      里停用他们后再切换。
                    </p>
                  </div>
                </Callout>
              )}
            </>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
