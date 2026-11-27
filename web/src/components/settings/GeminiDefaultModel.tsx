import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  effectiveProviderModels,
  splitOneMillionSuffix,
} from '@/lib/model-providers';
import { confirmProtocolChange, updateConnection } from './model-connections';
import { SettingsField } from './SettingsLayout';
import { getErrorMessage, type UnifiedProviderPublic } from './types';

interface GeminiDefaultModelProps {
  provider: UnifiedProviderPublic;
  onChanged: (update?: UnifiedProviderPublic) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

/** One model option: the catalog's display name beside the model id. */
function optionLabel(displayName: string | undefined, id: string): string {
  return displayName && displayName !== id ? `${displayName} · ${id}` : id;
}

/**
 * The Gemini connection's default model: the one a turn uses when neither the
 * Agent nor the conversation picked a model. The account's whole catalog
 * (tens of models) stays a single dropdown instead of a long editable list.
 */
export function GeminiDefaultModel({
  provider,
  onChanged,
  setNotice,
  setError,
}: GeminiDefaultModelProps) {
  const entries = effectiveProviderModels(provider);
  const names = new Map(
    (provider.geminiModels ?? []).map((entry) => [entry.id, entry.displayName]),
  );
  const savedModel = splitOneMillionSuffix(provider.anthropicModel).model;
  const [pick, setPick] = useState<string | null>(null);
  const model = pick ?? (savedModel || entries[0]?.id || '');
  const changed = model !== savedModel;
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!changed) return;
    if (!(await confirmProtocolChange(provider))) return;
    setSaving(true);
    try {
      onChanged(await updateConnection(provider.id, { anthropicModel: model }));
      setPick(null);
      setNotice('默认模型已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存默认模型失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <SettingsField
        label="默认模型"
        htmlFor="gemini-model-select"
        description={`对话没有指定模型时使用它；聊天里可以随时切换。账号目录现有 ${entries.length} 个模型。`}
      >
        <NativeSelect
          id="gemini-model-select"
          value={model}
          onChange={(event) => setPick(event.target.value)}
          disabled={saving || entries.length === 0}
          className="w-full"
        >
          {entries.map((entry) => (
            <NativeSelectOption key={entry.id} value={entry.id}>
              {optionLabel(names.get(entry.id), entry.id)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsField>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()} disabled={!changed || saving}>
          {saving && <Loader2 className="animate-spin" />}
          保存默认模型
        </Button>
        <span className="text-caption text-muted-foreground">
          切换后，用这个连接的下一条消息会开启新的 SDK 会话，聊天记录保留。
        </span>
      </div>
    </div>
  );
}
