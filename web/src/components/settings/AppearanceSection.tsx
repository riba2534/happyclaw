import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Loader2, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { api, apiFetch } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getErrorMessage } from './types';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import { withBasePath } from '../../utils/url';
import type { AppearanceConfig } from '../../stores/auth';

const BRAND_ASSET_MAX_BYTES = 3 * 1024 * 1024;
const BRAND_ASSET_TYPES = ['image/png', 'image/jpeg'];

export function createAppearanceMutationQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<T>(request: () => Promise<T>): Promise<T> {
    const operation = tail.then(request);
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

interface BrandAssetUploadProps {
  kind: 'icon' | 'banner';
  title: string;
  desc: string;
  url: string | null;
  canManageAssets: boolean;
  mutationDisabled: boolean;
  executeMutation: (
    request: () => Promise<AppearanceConfig>,
  ) => Promise<AppearanceConfig>;
  previewClassName: string;
  imageClassName: string;
}

function BrandAssetUpload({
  kind,
  title,
  desc,
  url,
  canManageAssets,
  mutationDisabled,
  executeMutation,
  previewClassName,
  imageClassName,
}: BrandAssetUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldName = kind;

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > BRAND_ASSET_MAX_BYTES) {
      toast.error('图片文件不能超过 3MB');
      return;
    }
    if (!BRAND_ASSET_TYPES.includes(file.type)) {
      toast.error('仅支持 png、jpg 格式');
      return;
    }
    const body = new FormData();
    body.append(fieldName, file);
    setUploading(true);
    try {
      await executeMutation(async () => {
        const result = await apiFetch<{
          assetUrl: string;
          appearance: AppearanceConfig;
        }>(`/api/config/appearance/brand-${kind}`, {
          method: 'POST',
          body,
        });
        return result.appearance;
      });
      toast.success(`${title}已更新`);
    } catch (err) {
      toast.error(getErrorMessage(err, `上传${title}失败`));
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await executeMutation(async () => {
        const result = await api.delete<{ appearance: AppearanceConfig }>(
          `/api/config/appearance/brand-${kind}`,
        );
        return result.appearance;
      });
      toast.success(`已恢复默认${title}`);
    } catch (err) {
      toast.error(getErrorMessage(err, `移除${title}失败`));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SettingsRow
      label={title}
      description={desc}
      control={
        <>
          <div
            className={cn(
              'flex shrink-0 items-center overflow-hidden rounded-md bg-muted ring-1 ring-surface-border',
              previewClassName,
              !url && 'justify-center',
            )}
          >
            {url ? (
              <img
                src={withBasePath(url)}
                alt={title}
                className={cn('object-contain', imageClassName)}
              />
            ) : (
              <>
                <ImageIcon
                  className="size-4 text-faint-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">使用默认</span>
              </>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={BRAND_ASSET_TYPES.join(',')}
            className="hidden"
            onChange={upload}
          />
          {url && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                uploading || removing || mutationDisabled || !canManageAssets
              }
              onClick={remove}
            >
              {removing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              恢复默认
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              uploading || removing || mutationDisabled || !canManageAssets
            }
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            上传图片
          </Button>
        </>
      }
    />
  );
}

export function AppearanceSection() {
  const { user, hasPermission } = useAuthStore();

  const [appName, setAppName] = useState('');
  const [brandIconUrl, setBrandIconUrl] = useState<string | null>(null);
  const [brandBannerUrl, setBrandBannerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pendingMutations, setPendingMutations] = useState(0);
  const mutationQueueRef = useRef<ReturnType<
    typeof createAppearanceMutationQueue
  > | null>(null);
  mutationQueueRef.current ??= createAppearanceMutationQueue();

  const canManage = hasPermission('manage_system_config');
  // Brand asset upload/delete is gated to admin on the backend
  // (`adminRoleMiddleware`), which is stricter than `manage_system_config`.
  const canManageAssets = user?.role === 'admin';

  const applyAppearance = (
    appearance: AppearanceConfig,
    updateNameDraft: boolean,
  ) => {
    if (updateNameDraft) setAppName(appearance.appName);
    setBrandIconUrl(appearance.brandIconUrl);
    setBrandBannerUrl(appearance.brandBannerUrl);
    useAuthStore.setState({ appearance });
  };

  const executeMutation = (
    request: () => Promise<AppearanceConfig>,
    updateNameDraft = false,
  ): Promise<AppearanceConfig> => {
    setPendingMutations((count) => count + 1);

    // Keep all appearance writes in one client-side sequence. Each endpoint
    // returns a full appearance snapshot, so allowing requests to overlap can
    // let an older response replace a newer icon, banner, or app name.
    const operation = mutationQueueRef.current!(async () => {
      const responseAppearance = await request();
      applyAppearance(responseAppearance, updateNameDraft);

      // Reconcile the final server snapshot after the mutation. Failure here
      // does not turn a committed write into an apparent failure; the serialized
      // mutation response remains a safe fallback until the next refresh.
      try {
        const current = await api.get<AppearanceConfig>(
          '/api/config/appearance',
        );
        applyAppearance(current, updateNameDraft);
        return current;
      } catch {
        return responseAppearance;
      }
    });

    return operation.finally(() => {
      setPendingMutations((count) => Math.max(0, count - 1));
    });
  };

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<AppearanceConfig>('/api/config/appearance');
        applyAppearance(data, true);
      } catch (err) {
        toast.error(getErrorMessage(err, '加载外观配置失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, [canManage]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await executeMutation(
        () =>
          api.put<AppearanceConfig>('/api/config/appearance', {
            appName: appName.trim(),
          }),
        true,
      );
      toast.success('外观设置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存外观设置失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="text-body text-muted-foreground">
        需要系统配置权限才能修改全局外观设置。
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="站点名称"
        description="显示在浏览器标题和欢迎页面中"
      >
        <SettingsGroup>
          <SettingsRow
            label="名称"
            htmlFor="system-brand-name"
            control={
              <Input
                id="system-brand-name"
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                maxLength={32}
                placeholder="HappyClaw"
                className="sm:w-64"
              />
            }
          />
          <div className="flex justify-end px-4 py-3">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || pendingMutations > 0 || !appName.trim()}
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              保存系统品牌
            </Button>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Logo"
        description={
          canManageAssets
            ? undefined
            : '品牌资源文件的上传与删除需要管理员权限。'
        }
      >
        <SettingsGroup>
          <BrandAssetUpload
            kind="icon"
            title="图形 Logo"
            desc="建议尺寸 400x400，显示在侧边栏折叠图标位置，支持 PNG/JPG"
            url={brandIconUrl}
            canManageAssets={canManageAssets}
            mutationDisabled={pendingMutations > 0}
            executeMutation={(request) => executeMutation(request)}
            previewClassName="size-10 justify-center"
            imageClassName="h-full w-full"
          />
          <BrandAssetUpload
            kind="banner"
            title="文字 Logo"
            desc="建议尺寸 600x200，左对齐显示在工作区列表上方，支持 PNG/JPG"
            url={brandBannerUrl}
            canManageAssets={canManageAssets}
            mutationDisabled={pendingMutations > 0}
            executeMutation={(request) => executeMutation(request)}
            previewClassName="h-10 w-30 justify-start px-1.5"
            imageClassName="h-full w-full object-left"
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
