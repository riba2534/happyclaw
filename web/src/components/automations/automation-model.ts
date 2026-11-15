import type { Automation } from '../../lib/automation';
import { describeModelChoice } from '../../lib/session-model-choice';
import { useIsGuest } from '../../stores/auth';
import { useWorkspaceModelOptions } from '../chat/SessionModelChoiceField';

/**
 * The model an automation's runs use, as `连接 · 模型 · 档位`; null when it
 * follows the default. Connection and model names come from the model
 * options of its workspace, read once for every row there; ids stand in when
 * they cannot be read. Guests see no model choices, as in the chat.
 */
export function useAutomationModelLabel(automation: Automation): string | null {
  const guest = useIsGuest();
  const choice = guest ? null : (automation.model ?? null);
  const loaded = useWorkspaceModelOptions(
    choice ? automation.workspaceJid : null,
  );
  // Nothing until the names are in, so a row does not flash its ids.
  if (!choice || loaded.status === 'loading') return null;
  return describeModelChoice(
    choice,
    loaded.status === 'ready' ? loaded.options : null,
  );
}
