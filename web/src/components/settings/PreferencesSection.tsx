import { useState } from 'react';
import { Bell, BellOff, CheckCircle2, Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { cn } from '@/lib/utils';
import {
  useTheme,
  type ColorScheme,
  type FontStyle,
  type Theme,
} from '../../hooks/useTheme';
import {
  isRouteRestoreEnabled,
  setRouteRestoreEnabled,
} from '../../utils/routeRestore';
import {
  getDefaultFollowUpMode,
  setDefaultFollowUpMode,
  type FollowUpPreference,
} from '../../lib/follow-up-preferences';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

const SCHEME_OPTIONS: {
  value: ColorScheme;
  label: string;
  preview: { bg: string; accent: string; text: string };
}[] = [
  {
    value: 'default',
    label: '经典绿',
    preview: { bg: '#f8fafc', accent: '#0d9488', text: '#0f172a' },
  },
  {
    value: 'orange',
    label: '暖橙',
    preview: { bg: '#faf9f5', accent: '#f97316', text: '#141413' },
  },
  {
    value: 'neutral',
    label: '素白',
    preview: { bg: '#fafafa', accent: '#52525b', text: '#18181b' },
  },
];

const FONT_OPTIONS: { value: FontStyle; label: string }[] = [
  { value: 'default', label: 'HappyClaw' },
  { value: 'anthropic', label: 'Anthropic' },
];

const FOLLOW_UP_OPTIONS: {
  value: FollowUpPreference;
  label: string;
  description: string;
}[] = [
  {
    value: 'queue',
    label: '排队',
    description: '等待当前回复完成，再作为下一轮消息发送。',
  },
  {
    value: 'steer',
    label: '引导',
    description: '中断当前回复，把新消息作为下一轮优先执行。',
  },
];

function ColorSchemePicker({
  value,
  onChange,
}: {
  value: ColorScheme;
  onChange: (value: ColorScheme) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="配色方案"
      className="grid grid-cols-3 gap-2"
    >
      {SCHEME_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 text-left ring-1 transition-[box-shadow,background-color] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              active
                ? 'ring-2 ring-primary'
                : 'ring-surface-border hover:bg-surface-hover',
            )}
          >
            <span
              aria-hidden="true"
              className="flex h-10 w-full items-end gap-1 rounded-md p-1.5 ring-1 ring-black/5"
              style={{ background: option.preview.bg }}
            >
              <span
                className="size-3.5 shrink-0 rounded-full"
                style={{ background: option.preview.accent }}
              />
              <span className="flex-1 space-y-0.5">
                <span
                  className="block h-1 w-3/4 rounded-full opacity-60"
                  style={{ background: option.preview.text }}
                />
                <span
                  className="block h-1 w-1/2 rounded-full opacity-25"
                  style={{ background: option.preview.text }}
                />
              </span>
            </span>
            <span className="px-0.5 text-caption font-medium text-foreground">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DesktopNotificationSection() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  );

  const handleRequest = async () => {
    if (!supported) return;
    setPermission(await Notification.requestPermission());
  };

  let description: React.ReactNode;
  let control: React.ReactNode;
  if (!supported) {
    description = '当前浏览器不支持桌面通知';
    control = <BellOff className="size-4 text-faint-foreground" />;
  } else if (permission === 'granted') {
    description = '当前设备已允许桌面通知';
    control = <CheckCircle2 className="size-4 text-success" />;
  } else if (permission === 'denied') {
    description = (
      <>
        <span className="block text-warning">当前浏览器已拒绝通知权限</span>
        请在浏览器的网站权限中允许通知，然后刷新页面。
      </>
    );
    control = <BellOff className="size-4 text-warning" />;
  } else {
    description = '页面位于后台或你切换到其他会话时，任务完成会发送系统通知。';
    control = (
      <Button type="button" size="sm" variant="outline" onClick={handleRequest}>
        <Bell className="size-3.5" />
        允许当前设备通知
      </Button>
    );
  }

  return (
    <SettingsSection
      title="桌面通知"
      description="当前设备：对话任务完成时通过浏览器通知提醒你"
    >
      <SettingsGroup>
        <SettingsRow
          label="通知权限"
          description={description}
          control={control}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function RouteRestoreSection() {
  const [enabled, setEnabled] = useState(() => isRouteRestoreEnabled());

  const handleChange = (next: boolean) => {
    setEnabled(next);
    setRouteRestoreEnabled(next);
  };

  return (
    <SettingsSection
      title="恢复上次页面"
      description="当前设备：再次打开 PWA 时回到上次访问的页面"
    >
      <SettingsGroup>
        <SettingsRow
          label="记住当前设备的最后访问位置"
          htmlFor="route-restore"
          description="关闭后，每次重新打开都进入默认主页。"
          control={
            <Switch
              id="route-restore"
              checked={enabled}
              onCheckedChange={handleChange}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function FollowUpBehaviorSection() {
  const [mode, setMode] = useState<FollowUpPreference>(() =>
    getDefaultFollowUpMode(),
  );
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.userAgent);
  const alternateShortcut = isMac ? '⌘⇧Enter' : 'Ctrl+Shift+Enter';

  const handleChange = (next: FollowUpPreference) => {
    setMode(next);
    setDefaultFollowUpMode(next);
  };

  const current =
    FOLLOW_UP_OPTIONS.find((option) => option.value === mode) ??
    FOLLOW_UP_OPTIONS[0];

  return (
    <SettingsSection
      title="运行中的后续消息"
      description="当前设备：选择智能体正在运行时发送新消息的默认行为"
    >
      <SettingsGroup>
        <SettingsRow
          label="默认行为"
          description={current.description}
          control={
            <SegmentedControl
              label="运行中的后续消息"
              value={mode}
              options={FOLLOW_UP_OPTIONS}
              onChange={handleChange}
            />
          }
        />
        <div className="px-4 py-2.5 text-caption leading-5 text-muted-foreground">
          发送时按 <Kbd>{alternateShortcut}</Kbd>{' '}
          可临时使用另一种行为，不会修改默认设置。
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

export function PreferencesSection() {
  const {
    theme,
    setTheme,
    colorScheme,
    setColorScheme,
    fontStyle,
    setFontStyle,
  } = useTheme();

  return (
    <div className="space-y-8">
      <FollowUpBehaviorSection />

      <SettingsSection
        title="界面外观"
        description="当前设备：主题、配色和字体不会同步到其他浏览器"
      >
        <SettingsGroup>
          <SettingsRow
            label="明暗模式"
            control={
              <SegmentedControl
                label="明暗模式"
                value={theme}
                options={THEME_OPTIONS}
                onChange={setTheme}
              />
            }
          />
          <SettingsRow label="配色方案">
            <ColorSchemePicker value={colorScheme} onChange={setColorScheme} />
          </SettingsRow>
          <SettingsRow
            label="字体风格"
            control={
              <SegmentedControl
                label="字体风格"
                value={fontStyle}
                options={FONT_OPTIONS}
                onChange={setFontStyle}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <DesktopNotificationSection />
      <RouteRestoreSection />
    </div>
  );
}
