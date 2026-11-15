import { useState } from 'react';
import { Loader2, Plus, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  discoveredModelEntry,
  isValidModelId,
  modelCapabilities,
  normalizeProviderModels,
  splitOneMillionSuffix,
  type ConnectionModelRoles,
  type DiscoveredModel,
  type ModelPresetModel,
  type ProviderErrorCode,
  type ProviderModelEntry,
} from '@/lib/model-providers';
import { errorCopy } from './model-connections';
import {
  ModelCapabilityFields,
  ModelRolesFields,
  formatContextWindow,
  withAddDefaults,
} from './ModelCapabilityFields';

/** One model the wizard may save with the connection. */
export interface ModelCandidate extends ProviderModelEntry {
  picked: boolean;
  name?: string;
  origin: 'preset' | 'discovered' | 'manual';
  /** Efforts filled in with every level because nothing is known. */
  effortsUnverified?: boolean;
  /** The window is the registry's suggestion, not one the user picked. */
  windowSuggested?: boolean;
}

/**
 * What the connection stores for a candidate: every entry field, an empty
 * effort list included (the vendor declared the model takes none).
 */
export function candidateEntry(candidate: ModelCandidate): ProviderModelEntry {
  const entry: ProviderModelEntry = { id: candidate.id };
  if (candidate.displayName) entry.displayName = candidate.displayName;
  if (candidate.contextWindow) entry.contextWindow = candidate.contextWindow;
  if (candidate.efforts) entry.efforts = candidate.efforts;
  if (candidate.defaultEffort) entry.defaultEffort = candidate.defaultEffort;
  if (candidate.thinks) entry.thinks = true;
  if (candidate.maxOutputTokens) {
    entry.maxOutputTokens = candidate.maxOutputTokens;
  }
  if (candidate.vendor) entry.vendor = candidate.vendor;
  return entry;
}

/**
 * A model as a candidate: its window from the vendor or the preset (`[1m]`
 * spelled the old way counts as 1M), what the vendor says about it, and what
 * an added model starts with (see withAddDefaults). Null for a discovered id
 * a connection cannot keep, such as a magpie discovery alias.
 */
function toCandidate(
  model: DiscoveredModel | ModelPresetModel,
  origin: ModelCandidate['origin'],
  picked: boolean,
  declareSuggestedWindow: boolean,
): ModelCandidate | null {
  // A vendor's list carries the name, reply limit, vendor and declared
  // efforts; a preset or a typed name only what the user may edit.
  const normalized =
    origin === 'discovered'
      ? discoveredModelEntry(model)
      : (normalizeProviderModels([model]) ?? [])[0];
  if (!normalized) return null;
  const { entry, effortsUnverified, windowSuggested } = withAddDefaults(
    normalized,
    declareSuggestedWindow,
  );
  const candidate: ModelCandidate = { ...entry, picked, origin };
  if (model.name) candidate.name = model.name;
  if (effortsUnverified) candidate.effortsUnverified = true;
  if (windowSuggested) candidate.windowSuggested = true;
  return candidate;
}

/**
 * A kept candidate under another source. An official connection takes no
 * suggested window (above 200K it is the billed 1M opt-in); a third-party one
 * takes the suggestion where the candidate has no window. A window the user
 * picked stays either way.
 */
export function candidateForSource(
  candidate: ModelCandidate,
  thirdParty: boolean,
): ModelCandidate {
  if (!thirdParty) {
    if (!candidate.windowSuggested) return candidate;
    const next = { ...candidate };
    delete next.contextWindow;
    delete next.windowSuggested;
    return next;
  }
  if (candidate.contextWindow) return candidate;
  const { entry, windowSuggested } = withAddDefaults(candidate, true);
  return windowSuggested
    ? { ...candidate, contextWindow: entry.contextWindow, windowSuggested }
    : candidate;
}

/**
 * Adds models the list does not have yet, leaving the ones it has (and the
 * user's choices on them) alone. `picked: 'known'` checks the models the
 * registry knows and leaves the rest unchecked. A third-party connection
 * declares the registry's window (`declareSuggestedWindow`).
 */
export function addCandidates(
  existing: readonly ModelCandidate[],
  models: ReadonlyArray<DiscoveredModel | ModelPresetModel>,
  origin: ModelCandidate['origin'],
  picked: boolean | 'known',
  declareSuggestedWindow: boolean,
): ModelCandidate[] {
  const known = new Set(existing.map((candidate) => candidate.id));
  const next = [...existing];
  for (const model of models) {
    const id = splitOneMillionSuffix(model.id).model;
    if (!id || known.has(id) || !isValidModelId(id)) continue;
    const candidate = toCandidate(
      model,
      origin,
      picked === 'known' ? modelCapabilities(id) !== null : picked,
      declareSuggestedWindow,
    );
    if (!candidate) continue;
    known.add(id);
    next.push(candidate);
  }
  return next;
}

export type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; count: number; builtin: boolean }
  | {
      status: 'failed';
      code: ProviderErrorCode;
      message: string | null;
    };

interface ModelPickerProps {
  candidates: ModelCandidate[];
  onCandidatesChange: (next: ModelCandidate[]) => void;
  /** Third-party connections pick models for sub-agents and background calls. */
  roles: ConnectionModelRoles | null;
  /** Added models declare the registry's window (third-party connections). */
  declareSuggestedWindow: boolean;
  onRolesChange: (next: ConnectionModelRoles) => void;
  discovery: DiscoveryState;
  onRetryDiscovery: () => void;
}

/** Step 3 of the wizard: which models the connection offers, and how. */
export function ModelPicker({
  candidates,
  onCandidatesChange,
  roles,
  onRolesChange,
  declareSuggestedWindow,
  discovery,
  onRetryDiscovery,
}: ModelPickerProps) {
  const [filter, setFilter] = useState('');

  const picked = candidates.filter((candidate) => candidate.picked);
  const query = filter.trim().toLowerCase();
  const shown = query
    ? candidates.filter(
        (candidate) =>
          candidate.id.toLowerCase().includes(query) ||
          candidate.name?.toLowerCase().includes(query),
      )
    : candidates;

  const replace = (id: string, next: ModelCandidate) =>
    onCandidatesChange(
      candidates.map((candidate) => (candidate.id === id ? next : candidate)),
    );
  // 全选 / 清空 act on what the search shows.
  const pickShown = (next: boolean) => {
    const ids = new Set(shown.map((candidate) => candidate.id));
    onCandidatesChange(
      candidates.map((candidate) =>
        ids.has(candidate.id) ? { ...candidate, picked: next } : candidate,
      ),
    );
  };

  const addManual = (raw: string) => {
    const existing = candidates.find(
      (candidate) => candidate.id === splitOneMillionSuffix(raw).model,
    );
    onCandidatesChange(
      existing
        ? candidates.map((candidate) =>
            candidate === existing ? { ...candidate, picked: true } : candidate,
          )
        : addCandidates(
            candidates,
            [{ id: raw }],
            'manual',
            true,
            declareSuggestedWindow,
          ),
    );
    setFilter('');
    return true;
  };

  return (
    <div className="space-y-3">
      <DiscoveryLine discovery={discovery} onRetry={onRetryDiscovery} />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          enterKeyHint="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="搜索模型"
          aria-label="搜索模型"
          className="min-w-0 flex-1 basis-48"
        />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => pickShown(true)}
            disabled={shown.every((candidate) => candidate.picked)}
          >
            全选
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => pickShown(false)}
            disabled={shown.every((candidate) => !candidate.picked)}
          >
            清空
          </Button>
        </div>
      </div>

      <div
        role="group"
        aria-label="可用模型"
        className="max-h-[min(26rem,50dvh)] divide-y divide-surface-border overflow-y-auto overscroll-contain rounded-lg ring-1 ring-surface-border"
      >
        {shown.map((candidate) => {
          const checkboxId = `wizard-model-${candidate.id}`;
          const about = [
            candidate.name ??
              (candidate.origin === 'manual' ? '手动添加' : undefined),
            candidate.vendor,
            candidate.maxOutputTokens
              ? `最长回复 ${formatContextWindow(candidate.maxOutputTokens)}`
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div key={candidate.id} className="min-w-0 space-y-2 px-3 py-2">
              <div className="flex min-h-7 min-w-0 items-center gap-3">
                <Checkbox
                  id={checkboxId}
                  checked={candidate.picked}
                  onCheckedChange={(next) =>
                    replace(candidate.id, {
                      ...candidate,
                      picked: next === true,
                    })
                  }
                  aria-label={`使用 ${candidate.id}`}
                />
                <label
                  htmlFor={checkboxId}
                  className="min-w-0 flex-1 cursor-pointer"
                >
                  <span className="block truncate font-mono text-caption text-foreground">
                    {candidate.id}
                  </span>
                  {about && (
                    <span className="block truncate text-micro text-muted-foreground">
                      {about}
                    </span>
                  )}
                </label>
              </div>
              {/* Only a checked model is saved, so only it is configured. */}
              {candidate.picked && (
                <div className="pl-7">
                  <ModelCapabilityFields
                    entry={candidateEntry(candidate)}
                    effortsUnverified={candidate.effortsUnverified}
                    onChange={(entry, effortsTouched) =>
                      replace(candidate.id, {
                        ...entry,
                        picked: true,
                        name: candidate.name,
                        origin: candidate.origin,
                        // An effort or window the user set is theirs, not a
                        // guess.
                        effortsUnverified:
                          candidate.effortsUnverified && !effortsTouched,
                        windowSuggested:
                          candidate.windowSuggested &&
                          entry.contextWindow === candidate.contextWindow,
                      })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && candidates.length > 0 && (
          <p className="px-3 py-4 text-caption text-muted-foreground">
            没有匹配「{filter.trim()}」的模型，可以在下方手动添加。
          </p>
        )}
        {candidates.length === 0 && discovery.status !== 'loading' && (
          <p className="px-3 py-4 text-caption text-muted-foreground">
            还没有模型。在下方手动添加，或重新获取模型列表。
          </p>
        )}
      </div>

      <p className="text-caption text-muted-foreground" aria-live="polite">
        已选 {picked.length} / 共 {candidates.length}
      </p>

      <ManualModelInput
        placeholder="手动添加模型名，例如 glm-5.3"
        onAdd={addManual}
      />

      {roles && (
        <ModelRolesFields
          models={picked.map((candidate) => candidate.id)}
          roles={roles}
          onChange={onRolesChange}
        />
      )}
    </div>
  );
}

function DiscoveryLine({
  discovery,
  onRetry,
}: {
  discovery: DiscoveryState;
  onRetry: () => void;
}) {
  if (discovery.status === 'loading') {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-caption text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        正在获取模型列表…
      </p>
    );
  }
  if (discovery.status === 'done') {
    return (
      <p className="text-caption text-muted-foreground">
        {discovery.builtin
          ? '这类连接使用内置的模型别名。'
          : `从服务商获取到 ${discovery.count} 个模型；已知的模型默认勾选。`}
      </p>
    );
  }
  if (discovery.status !== 'failed') return null;
  const copy = errorCopy(discovery.code);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5"
    >
      <TriangleAlert
        className="mt-0.5 size-3.5 shrink-0 text-warning"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="text-foreground">没能获取模型列表：{copy.title}</div>
        <div className="text-muted-foreground">
          {copy.hint}仍可使用下方的模型或手动添加。
        </div>
        {discovery.message && (
          <div className="mt-0.5 font-mono text-micro break-all text-faint-foreground">
            {discovery.message}
          </div>
        )}
      </div>
      <Button variant="ghost" size="xs" onClick={onRetry} className="shrink-0">
        <RotateCcw />
        重试
      </Button>
    </div>
  );
}

/**
 * A model name typed by hand. `onAdd` gets a valid id and
 * says whether it was taken; the field clears only then.
 */
export function ManualModelInput({
  placeholder,
  onAdd,
  disabled = false,
}: {
  placeholder: string;
  onAdd: (id: string) => boolean | Promise<boolean>;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const id = value.trim();
    if (!isValidModelId(splitOneMillionSuffix(id).model)) {
      setError('模型名不能为空，也不能包含空格');
      return;
    }
    setError(null);
    if (await onAdd(id)) setValue('');
  };
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex gap-2">
        <Input
          variant="code"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void add();
            }
          }}
          placeholder={placeholder}
          aria-label="手动添加模型"
          autoComplete="off"
          disabled={disabled}
          className="min-w-0 flex-1 font-mono"
        />
        <Button
          variant="outline"
          onClick={() => void add()}
          disabled={disabled || !value.trim()}
        >
          <Plus />
          添加
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-caption text-error">
          {error}
        </p>
      )}
    </div>
  );
}
