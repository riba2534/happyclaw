import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AtSign } from 'lucide-react';
import { toast } from 'sonner';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';
import { BindingsSection } from './BindingsSection';
import { ChannelAccountsManager } from './ChannelAccountsManager';
import { SettingsGroup, SettingsSection } from './SettingsLayout';
import { getErrorMessage } from './types';

export function UserChannelsSection() {
  const { user, updateProfile } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [requireMention, setRequireMention] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRequireMention(user?.default_require_mention ?? false);
  }, [user?.default_require_mention]);

  const handleDefaultChange = async (next: boolean) => {
    const previous = requireMention;
    setRequireMention(next);
    setSaving(true);
    try {
      await updateProfile({ default_require_mention: next });
      toast.success('新群默认响应方式已保存');
    } catch (error) {
      setRequireMention(previous);
      toast.error(getErrorMessage(error, '保存新群默认响应方式失败'));
    } finally {
      setSaving(false);
    }
  };

  const responseOptions = [
    {
      value: true,
      title: '仅在 @机器人时回复（推荐）',
      description: '降低误触发、无关消息处理和额外费用。',
    },
    {
      value: false,
      title: '响应允许成员的所有消息',
      description: '实际可触发成员仍受该渠道与群聊的权限规则限制。',
    },
  ];

  return (
    <Tabs
      value={searchParams.get('view') === 'bindings' ? 'bindings' : 'accounts'}
      onValueChange={(view) => {
        const next = new URLSearchParams(searchParams);
        if (view === 'bindings') next.set('view', 'bindings');
        else next.delete('view');
        setSearchParams(next, { replace: true });
      }}
      className="gap-6"
    >
      <div className="border-b border-surface-border">
        <TabsList variant="line" aria-label="消息渠道设置" className="-mb-px">
          <TabsTrigger value="accounts" className="flex-none px-2">
            渠道账号与默认规则
          </TabsTrigger>
          <TabsTrigger value="bindings" className="flex-none px-2">
            已接入会话
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="accounts" className="space-y-8">
        <SettingsSection
          title="新群默认响应方式"
          description="仅影响之后自动注册的群聊；已有群聊继续使用各自的响应设置"
        >
          <SettingsGroup role="radiogroup" aria-label="新群默认响应方式">
            {responseOptions.map((option) => {
              const checked = requireMention === option.value;
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={saving}
                  onClick={() => handleDefaultChange(option.value)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-100 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                      checked ? 'border-primary bg-primary' : 'border-input',
                    )}
                  >
                    {checked && (
                      <span className="size-1.5 rounded-full bg-primary-foreground" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-body font-medium text-foreground">
                      {option.value && (
                        <AtSign className="size-3.5 text-muted-foreground" />
                      )}
                      {option.title}
                    </span>
                    <span className="mt-0.5 block text-caption text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </SettingsGroup>
          <p className="text-caption text-muted-foreground">
            已有群聊可在“已接入会话”中单独修改，也可在群里使用 /require_mention
            快捷命令。
          </p>
        </SettingsSection>

        <ChannelAccountsManager />
      </TabsContent>

      <TabsContent value="bindings">
        <BindingsSection />
      </TabsContent>
    </Tabs>
  );
}
