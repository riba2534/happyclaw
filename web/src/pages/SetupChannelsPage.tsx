import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, MessageSquare, SkipForward } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '../stores/auth';
import { api } from '../api/client';
import { getErrorMessage } from '../components/settings/types';

export function SetupChannelsPage() {
  const navigate = useNavigate();
  const { user, initialized } = useAuthStore();

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Feishu
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  // Telegram
  const [telegramBotToken, setTelegramBotToken] = useState('');

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    }
  }, [user, initialized, navigate]);

  const handleSkip = () => {
    navigate('/chat', { replace: true });
  };

  const handleSave = async () => {
    setError(null);

    const hasFeishu = feishuAppId.trim() || feishuAppSecret.trim();
    const hasTelegram = telegramBotToken.trim();

    if (!hasFeishu && !hasTelegram) {
      navigate('/chat', { replace: true });
      return;
    }

    if (feishuAppSecret.trim() && !feishuAppId.trim()) {
      setError('填写飞书 Secret 时，App ID 也必须填写');
      return;
    }
    if (feishuAppId.trim() && !feishuAppSecret.trim()) {
      setError('填写飞书 App ID 时，App Secret 也必须填写');
      return;
    }

    setSaving(true);
    try {
      if (hasFeishu) {
        const payload: Record<string, string | boolean> = { enabled: true };
        if (feishuAppId.trim()) payload.appId = feishuAppId.trim();
        if (feishuAppSecret.trim()) payload.appSecret = feishuAppSecret.trim();
        await api.put('/api/config/user-im/feishu', payload);
      }

      if (hasTelegram) {
        await api.put('/api/config/user-im/telegram', {
          botToken: telegramBotToken.trim(),
          enabled: true,
        });
      }

      navigate('/chat', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '保存消息通道配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-screen bg-slate-50 overflow-y-auto p-4">
      <div className="w-full max-w-2xl mx-auto space-y-5">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <MessageSquare className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">配置消息通道（可选）</h1>
          <p className="text-sm text-slate-600">
            绑定飞书或 Telegram，即可通过 IM 与 AI 对话。跳过后也可在设置中随时配置。
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
        )}

        {/* Feishu */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">飞书</h2>
          <p className="text-xs text-slate-500 mb-3">
            填写你的飞书应用凭证，绑定后即可在飞书中与 AI 对话。
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">App ID</label>
              <Input
                type="text"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
                placeholder="输入飞书 App ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">App Secret</label>
              <Input
                type="password"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="输入飞书 App Secret"
              />
            </div>
          </div>
        </section>

        {/* Telegram */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Telegram</h2>
          <p className="text-xs text-slate-500 mb-3">
            填写 Telegram Bot Token，绑定后即可在 Telegram 中与 AI 对话。
          </p>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Bot Token</label>
            <Input
              type="password"
              value={telegramBotToken}
              onChange={(e) => setTelegramBotToken(e.target.value)}
              placeholder="输入 Telegram Bot Token"
            />
          </div>
        </section>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-end">
          <Button variant="outline" onClick={handleSkip}>
            <SkipForward className="w-4 h-4" />
            跳过
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存并继续
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
