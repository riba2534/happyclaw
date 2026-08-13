import { useEffect, useRef, useState } from 'react';
import { AppWindow, Loader2, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthStore } from '../../stores/auth';
import { api, apiFetch } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';
import { withBasePath } from '../../utils/url';
import type { AppearanceConfig } from '../../stores/auth';

const BRAND_ASSET_MAX_BYTES = 3 * 1024 * 1024;
const BRAND_ASSET_TYPES = ['image/png', 'image/jpeg'];

interface BrandAssetUploadProps {
  kind: 'icon' | 'banner';
  title: string;
  desc: string;
  url: string | null;
  canManageAssets: boolean;
  onChange: (appearance: AppearanceConfig) => void;
  previewClassName: string;
  imageClassName: string;
}

function BrandAssetUpload({
  kind,
  title,
  desc,
  url,
  canManageAssets,
  onChange,
  previewClassName,
  imageClassName,
}: BrandAssetUploadProps) {
  const [uploading, setUploading] = useState(false);
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
      const result = await apiFetch<{
        assetUrl: string;
        appearance: AppearanceConfig;
      }>(`/api/config/appearance/brand-${kind}`, {
        method: 'POST',
        body,
      });
      onChange(result.appearance);
      toast.success(`${title}已更新`);
    } catch (err) {
      toast.error(getErrorMessage(err, `上传${title}失败`));
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    try {
      const result = await api.delete<{ appearance: AppearanceConfig }>(
        `/api/config/appearance/brand-${kind}`,
      );
      onChange(result.appearance);
      toast.success(`已恢复默认${title}`);
    } catch (err) {
      toast.error(getErrorMessage(err, `移除${title}失败`));
    }
  };

  return (
    <Section icon={AppWindow} title={title} desc={desc}>
      <div className="flex items-center gap-4">
        <div
          className={`flex flex-shrink-0 items-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/30 ${previewClassName}`}
        >
          {url ? (
            <img
              src={withBasePath(url)}
              alt={title}
              className={`object-contain ${imageClassName}`}
            />
          ) : (
            <span className="px-2 text-center text-[11px] text-muted-foreground">
              使用默认
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={BRAND_ASSET_TYPES.join(',')}
            className="hidden"
            onChange={upload}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading || !canManageAssets}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            上传图片
          </Button>
          {url && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canManageAssets}
              onClick={remove}
            >
              <RotateCcw className="size-3.5" />
              恢复默认
            </Button>
          )}
        </div>
      </div>
      {!canManageAssets && (
        <p className="mt-2 text-xs text-muted-foreground">
          品牌资源文件的上传与删除需要管理员权限。
        </p>
      )}
    </Section>
  );
}

export function AppearanceSection() {
  const { user, hasPermission } = useAuthStore();

  const [appName, setAppName] = useState('');
  const [brandIconUrl, setBrandIconUrl] = useState<string | null>(null);
  const [brandBannerUrl, setBrandBannerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission('manage_system_config');
  // Brand asset upload/delete is gated to admin on the backend
  // (`adminRoleMiddleware`), which is stricter than `manage_system_config`.
  const canManageAssets = user?.role === 'admin';

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<AppearanceConfig>('/api/config/appearance');
        setAppName(data.appName);
        setBrandIconUrl(data.brandIconUrl);
        setBrandBannerUrl(data.brandBannerUrl);
      } catch (err) {
        toast.error(getErrorMessage(err, '加载外观配置失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, [canManage]);

  const syncBrandAsset =
    (
      setter: (url: string | null) => void,
      pick: (a: AppearanceConfig) => string | null,
    ) =>
    (appearance: AppearanceConfig) => {
      setter(pick(appearance));
      useAuthStore.setState({ appearance });
    };

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await api.put<AppearanceConfig>('/api/config/appearance', {
        appName: appName.trim(),
      });
      setAppName(data.appName);
      useAuthStore.setState({ appearance: data });
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
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="text-sm text-muted-foreground">
        需要系统配置权限才能修改全局外观设置。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground bg-muted rounded-lg px-4 py-3">
        系统品牌影响站点标题、欢迎文案和侧边栏 Logo，不会改变 HappyClaw
        或自定义智能体的名称。
      </p>

      <Section
        icon={AppWindow}
        title="站点名称"
        desc="显示在浏览器标题和欢迎页面中"
      >
        <div>
          <Label
            htmlFor="system-brand-name"
            className="text-xs text-muted-foreground mb-1"
          >
            名称
          </Label>
          <Input
            id="system-brand-name"
            type="text"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            maxLength={32}
            placeholder="HappyClaw"
          />
        </div>
      </Section>

      <Button
        onClick={handleSave}
        disabled={saving || !appName.trim()}
        className="w-full sm:w-auto"
      >
        {saving && <Loader2 className="size-4 animate-spin" />}
        保存系统品牌
      </Button>

      <BrandAssetUpload
        kind="icon"
        title="图形 Logo"
        desc="建议尺寸 400x400，显示在侧边栏折叠图标位置，支持 PNG/JPG"
        url={brandIconUrl}
        canManageAssets={canManageAssets}
        onChange={syncBrandAsset(setBrandIconUrl, (a) => a.brandIconUrl)}
        previewClassName="h-16 w-16 justify-center"
        imageClassName="h-full w-full"
      />

      <BrandAssetUpload
        kind="banner"
        title="文字 Logo"
        desc="建议尺寸 600x200，左对齐显示在工作区列表上方，支持 PNG/JPG"
        url={brandBannerUrl}
        canManageAssets={canManageAssets}
        onChange={syncBrandAsset(setBrandBannerUrl, (a) => a.brandBannerUrl)}
        previewClassName="h-[3.35rem] w-[10rem] justify-start px-2"
        imageClassName="h-full w-full object-left"
      />
    </div>
  );
}
