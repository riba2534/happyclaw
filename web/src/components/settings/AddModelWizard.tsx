import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  PROVIDER_ERROR_COPY,
  describeBaseUrlProblem,
  findPresetsByBaseUrl,
  getModelPreset,
  isMagpieAliasModelId,
  normalizeConnectionModelRoles,
  normalizeProviderBaseUrl,
  type ConnectionModelRoles,
  type ModelPreset,
  type ProviderGateway,
} from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import { api } from '../../api/client';
import { buildDefaultProviderEnv } from '../../utils/provider-model';
import {
  codexDefaultsPatch,
  codexFallbackEffort,
  storedCodexEffort,
  useCodexCatalog,
} from './codex-catalog';
import { CodexModelFields } from './CodexModelFields';
import { ConnectionTestResult } from './ConnectionTestResult';
import {
  AUTO_AUTH_MODE_HINT,
  CONNECTION_KIND_LABELS,
  PROVIDERS_API,
  connectionWriteErrorMessage,
  discoverModels,
  discoveredModelsFor,
  isThirdPartyKind,
  testConnection,
  testOutcome,
  updateConnection,
  type ConnectionDraftBody,
  type ProviderAuthMode,
  type TestOutcome,
} from './model-connections';
import {
  ModelPicker,
  addCandidates,
  candidateEntry,
  candidateForSource,
  type DiscoveryState,
  type ModelCandidate,
} from './ModelPicker';
import { OAuthLoginPanel } from './OAuthLoginPanel';
import { ProviderEnvEditor, buildProviderCustomEnv } from './ProviderEnvEditor';
import { SettingsField } from './SettingsLayout';
import {
  getErrorMessage,
  type EnvRow,
  type UnifiedProviderPublic,
  type WebFetchPreflightPolicy,
} from './types';
import {
  ExternalAnchor,
  WizardSourceStep,
  hostnameOf,
  type WizardSource,
} from './WizardSourceStep';

type Step = 'source' | 'connect' | 'models' | 'save';

const STEPS: ReadonlyArray<{ key: Step; label: string }> = [
  { key: 'source', label: '选择来源' },
  { key: 'connect', label: '连接' },
  { key: 'models', label: '选择模型' },
  { key: 'save', label: '测试并保存' },
];

/**
 * Model aliases Claude Code resolves to the newest version. An official
 * connection offers these when its model list cannot be read.
 */
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * magpie takes any key on its own machine and credits the calls to the app
 * a `magpie-<app>` key names, so a new magpie connection starts with one.
 */
const MAGPIE_APP_KEY = 'magpie-happyclaw';

function sourceKey(source: WizardSource | null): string {
  if (!source) return '';
  return source.kind === 'preset' ? `preset:${source.presetId}` : source.kind;
}

interface AddModelWizardProps {
  /** The connection was saved; `verified` = its test passed. */
  onDone: (provider: UnifiedProviderPublic, verified: boolean) => void;
  /** An OAuth login created the connection before the wizard finished. */
  onConnectionCreated?: (provider: UnifiedProviderPublic) => void;
  /** Absent on the setup page, which has its own way out. */
  onCancel?: () => void;
  /** Inside a dialog the footer sticks to the dialog's bottom edge. */
  layout?: 'dialog' | 'page';
  /** Reports whether a save is in flight, so a host can hold its close. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * The one way to add a model connection: pick where the models come from,
 * connect, choose the models, then test and save. Settings and the first-run
 * setup page share it. The draft survives going back and forth; a response
 * that arrives after its inputs changed is dropped.
 */
export function AddModelWizard({
  onDone,
  onConnectionCreated,
  onCancel,
  layout = 'dialog',
  onBusyChange,
}: AddModelWizardProps) {
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<WizardSource | null>(null);

  // ─── Connection draft ───
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [credentialInput, setCredentialInput] = useState('');
  // A third-party connection starts from the runtime defaults; a row the
  // user deletes or empties is not saved, so it is not injected.
  const [env, setEnv] = useState<EnvRow[]>(buildDefaultProviderEnv);
  /** Made by an OAuth callback; later steps update it instead of creating. */
  const [created, setCreated] = useState<UnifiedProviderPublic | null>(null);
  const [detected, setDetected] = useState<ModelPreset | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState('');

  // ─── Models ───
  const [candidates, setCandidates] = useState<ModelCandidate[]>([]);
  const [roles, setRoles] = useState<ConnectionModelRoles>({});
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    status: 'idle',
  });
  const [discoveredAuthMode, setDiscoveredAuthMode] =
    useState<ProviderAuthMode | null>(null);
  /** What the model list says the endpoint is (magpie labels its rows). */
  const [discoveredGateway, setDiscoveredGateway] =
    useState<ProviderGateway | null>(null);
  const discoveredFor = useRef<string | null>(null);
  const discoverySeq = useRef(0);
  /** The draft whose model list is being read, while it is. */
  const [discoveringFor, setDiscoveringFor] = useState<string | null>(null);
  /** A key the vendor refused, for the draft it was refused on. */
  const [keyRefused, setKeyRefused] = useState<string | null>(null);
  const codexCatalog = useCodexCatalog(
    source?.kind === 'chatgpt' && created ? created.id : null,
  );
  /** A ChatGPT login starts from what the server gave it until changed. */
  const [codexPick, setCodexPick] = useState<{
    model: string;
    effort: string;
  } | null>(null);

  // ─── Test and save ───
  const [name, setName] = useState('');
  // Only offered for magpie, whose reason to skip is known up front.
  const [webFetchPolicy, setWebFetchPolicy] =
    useState<WebFetchPreflightPolicy>('skip');
  const [test, setTest] = useState<{
    signature: string;
    outcome: TestOutcome | null;
    error: string | null;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const testSeq = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const preset =
    source?.kind === 'preset' ? getModelPreset(source.presetId) : null;
  const kind = source?.kind ?? null;
  const thirdParty = isThirdPartyKind(kind);
  // A gateway's preset (magpie) names where it usually runs, not a vendor's
  // fixed endpoint: its address is the draft's own.
  const ownBaseUrl = kind === 'custom' || !!preset?.editableBaseUrl;
  const magpiePreset = preset?.gateway === 'magpie';
  const effectiveBaseUrl =
    preset && !preset.editableBaseUrl ? preset.baseUrl : baseUrl.trim();
  const baseUrlProblem = ownBaseUrl ? describeBaseUrlProblem(baseUrl) : null;
  const picked = candidates.filter((candidate) => candidate.picked);
  const codexModel =
    codexPick?.model ?? (created?.anthropicModel || codexCatalog.defaultModel);
  const codexEffort =
    codexPick?.effort ??
    codexFallbackEffort(
      codexCatalog,
      codexModel,
      (created && storedCodexEffort(created)) || codexCatalog.defaultEffort,
    );
  // The first checked model is the connection's own; nothing names it a
  // default, since Agents and chats pick their model.
  const connectionModel =
    kind === 'chatgpt' ? codexModel : (picked[0]?.id ?? '');

  // A third-party address may need its own environment, such as the custom
  // headers its key travels in; they go with every request for the draft.
  const envResult = thirdParty
    ? buildProviderCustomEnv(env)
    : { customEnv: {}, error: null };
  const customEnv = envResult.customEnv;
  const hasCustomHeaders = !!customEnv.ANTHROPIC_CUSTOM_HEADERS?.trim();

  // Whatever the requests carry (custom headers are credentials too): a
  // change makes the model list and the test stale. The server decides
  // which of it matters.
  const connectionSignature = JSON.stringify([
    sourceKey(source),
    thirdParty ? effectiveBaseUrl : '',
    kind === 'claude_subscription' ? credentialInput.trim() : apiKey.trim(),
    created?.id ?? '',
    customEnv,
  ]);
  // A saved connection is tested by id alone, so only the draft's model
  // makes a new test worth sending.
  const testSignature = created
    ? connectionSignature
    : JSON.stringify([connectionSignature, connectionModel]);
  const latest = useRef({ connectionSignature, testSignature });
  latest.current = { connectionSignature, testSignature };

  useEffect(() => {
    onBusyChange?.(saving);
  }, [saving, onBusyChange]);

  // ─── Source ───
  const chooseSource = (next: WizardSource) => {
    if (sourceKey(next) !== sourceKey(source)) {
      // A different vendor starts from its own models; models typed by hand
      // stay, with a suggested window only where the new source takes one.
      const manual = candidates
        .filter((candidate) => candidate.origin === 'manual')
        .map((candidate) =>
          candidateForSource(candidate, isThirdPartyKind(next.kind)),
        );
      const nextPreset =
        next.kind === 'preset' ? getModelPreset(next.presetId) : null;
      setCandidates(
        nextPreset
          ? addCandidates(manual, nextPreset.models, 'preset', true, true)
          : manual,
      );
      setDiscovery({ status: 'idle' });
      discoveredFor.current = null;
      // An address typed for a custom connection is kept (it is how the
      // gateway was recognised); otherwise the gateway's usual one.
      if (
        nextPreset?.editableBaseUrl &&
        !(kind === 'custom' && baseUrl.trim())
      ) {
        setBaseUrl(nextPreset.baseUrl);
      }
      // The magpie app key means nothing to another vendor.
      if (nextPreset?.gateway === 'magpie') {
        if (!apiKey.trim()) setApiKey(MAGPIE_APP_KEY);
      } else if (apiKey === MAGPIE_APP_KEY) {
        setApiKey('');
      }
    }
    setSource(next);
    setDetected(null);
    setStep('connect');
  };

  // ─── Custom address detection ───
  useEffect(() => {
    setDetected(null);
    if (kind !== 'custom') return;
    const timer = setTimeout(() => {
      const matches = findPresetsByBaseUrl(baseUrl);
      // Several presets may share one endpoint: suggest only a sure match.
      setDetected(
        matches.length === 1 &&
          normalizeProviderBaseUrl(baseUrl) !== dismissedUrl
          ? matches[0]
          : null,
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [kind, baseUrl, dismissedUrl]);

  // ─── Discovery ───
  const draftBody = (): ConnectionDraftBody => {
    switch (kind) {
      case 'preset':
        return {
          type: 'third_party',
          presetId: preset!.id,
          anthropicBaseUrl: effectiveBaseUrl,
          anthropicAuthToken: apiKey.trim(),
          ...(Object.keys(customEnv).length > 0 ? { customEnv } : {}),
        };
      case 'custom':
        return {
          type: 'third_party',
          anthropicBaseUrl: baseUrl.trim(),
          anthropicAuthToken: apiKey.trim(),
          ...(Object.keys(customEnv).length > 0 ? { customEnv } : {}),
        };
      case 'anthropic_api':
        return { type: 'official', anthropicApiKey: apiKey.trim() };
      case 'agy':
        return { type: 'third_party', runner: 'agy' };
      default:
        return {
          type: 'official',
          claudeCredentialInput: credentialInput.trim(),
        };
    }
  };

  /**
   * Reads the draft's model list. A refused key sends the user back to the
   * key instead of on to a model list built from guesses; any other failure
   * still leaves the preset or manual models to finish with.
   */
  const runDiscovery = async (): Promise<
    'listed' | 'key_refused' | 'superseded'
  > => {
    const signature = connectionSignature;
    const seq = ++discoverySeq.current;
    discoveredFor.current = signature;
    setDiscoveringFor(signature);
    setDiscovery({ status: 'loading' });
    const official = kind === 'claude_subscription' || kind === 'anthropic_api';
    let next: DiscoveryState;
    let extra = () => {};
    try {
      const result = await discoverModels(
        created ? { providerId: created.id } : draftBody(),
      );
      if (result.ok) {
        next = {
          status: 'done',
          // magpie's discovery aliases name rows, not models: never offered.
          count: result.models.filter(
            (model) => !isMagpieAliasModelId(model.id),
          ).length,
          builtin: result.source === 'builtin',
        };
        extra = () => {
          // Built-in aliases are what a subscription runs: offer them
          // checked. From a vendor's own list the models the registry knows
          // arrive checked, the rest unchecked.
          setCandidates((current) =>
            addCandidates(
              current,
              discoveredModelsFor(kind, result.models),
              'discovered',
              result.source === 'builtin' ? true : 'known',
              thirdParty,
            ),
          );
          setDiscoveredAuthMode(result.authMode ?? null);
          setDiscoveredGateway(result.gateway ?? null);
        };
      } else {
        next = {
          status: 'failed',
          code: result.code,
          message: result.message || null,
        };
        extra = () => {
          // A list that could not be read says nothing about the endpoint.
          setDiscoveredGateway(null);
          if (official && result.code !== 'AUTH_INVALID') {
            setCandidates((current) =>
              addCandidates(
                current,
                CLAUDE_MODEL_ALIASES.map((id) => ({ id })),
                'discovered',
                kind === 'claude_subscription' ? true : 'known',
                false,
              ),
            );
          }
        };
      }
    } catch (err) {
      next = {
        status: 'failed',
        code: 'UNKNOWN',
        message: getErrorMessage(err, '获取模型列表失败'),
      };
      extra = () => setDiscoveredGateway(null);
    }
    // A slower answer for an earlier draft must not land on this one.
    if (
      seq !== discoverySeq.current ||
      signature !== latest.current.connectionSignature
    ) {
      return 'superseded';
    }
    setDiscoveringFor(null);
    // With custom headers the refusal may be about them, not the key: the
    // user moves on and the test step tells.
    if (
      next.status === 'failed' &&
      next.code === 'AUTH_INVALID' &&
      !hasCustomHeaders
    ) {
      // Asked again on the next try, so a fixed key gets through.
      discoveredFor.current = null;
      setDiscovery({ status: 'idle' });
      setKeyRefused(signature);
      setStep('connect');
      return 'key_refused';
    }
    setDiscovery(next);
    extra();
    return 'listed';
  };

  const leaveConnect = async () => {
    if (kind === 'chatgpt' || discoveredFor.current === connectionSignature) {
      setStep('models');
      return;
    }
    if ((await runDiscovery()) === 'listed') setStep('models');
  };
  const checkingKey = discoveringFor === connectionSignature;
  const keyError =
    keyRefused === connectionSignature
      ? `${PROVIDER_ERROR_COPY.AUTH_INVALID.title}：${PROVIDER_ERROR_COPY.AUTH_INVALID.hint}`
      : null;

  useEffect(() => {
    if (
      step === 'models' &&
      kind !== 'chatgpt' &&
      discoveredFor.current !== connectionSignature
    ) {
      void runDiscovery();
    }
    // runDiscovery reads the current draft; the signature is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, kind, connectionSignature]);

  // ─── Test ───
  const runTest = () => {
    const signature = testSignature;
    const seq = ++testSeq.current;
    setTesting(true);
    setTest(null);
    const body = created
      ? { providerId: created.id }
      : {
          ...draftBody(),
          anthropicModel: connectionModel,
        };
    const settle = (outcome: TestOutcome | null, error: string | null) => {
      if (
        seq !== testSeq.current ||
        signature !== latest.current.testSignature
      ) {
        return;
      }
      setTest({ signature, outcome, error });
      setTesting(false);
    };
    if (kind === 'agy') {
      const t0 = Date.now();
      discoverModels({ type: 'third_party', runner: 'agy' })
        .then((res) => {
          if (res.ok && res.models.length > 0) {
            settle(
              {
                ok: true,
                code: null,
                model: connectionModel || res.models[0].id,
                authMode: null,
                message: `AGY CLI 就绪（发现 ${res.models.length} 个可用模型）`,
                latencyMs: Date.now() - t0,
              },
              null,
            );
          } else {
            settle(
              null,
              !res.ok
                ? res.message
                : '未从宿主机 agy CLI 发现可用模型，请先执行 agy 登录',
            );
          }
        })
        .catch((err) => settle(null, getErrorMessage(err, '检测 AGY CLI 失败')));
      return;
    }
    testConnection(body)
      .then((result) => settle(testOutcome(result), null))
      .catch((err) => settle(null, getErrorMessage(err, '测试连接失败')));
  };

  // One test per draft: entering the last step tests it once, and only a
  // change to the draft (or the user) asks again.
  useEffect(() => {
    if (step !== 'save' || test?.signature === testSignature) return;
    runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, testSignature]);

  const currentTest = test?.signature === testSignature ? test : null;
  const authInvalid = currentTest?.outcome?.code === 'AUTH_INVALID';
  const verified = currentTest?.outcome?.ok === true;

  // ─── Save ───
  const defaultName =
    created?.name ??
    preset?.name ??
    (kind === 'custom'
      ? hostnameOf(baseUrl) || CONNECTION_KIND_LABELS.custom
      : CONNECTION_KIND_LABELS[kind ?? 'custom']);
  const save = async () => {
    if (authInvalid || testing || saving) return;
    setSaving(true);
    setSaveError(null);
    const trimmedName = name.trim() || defaultName;
    const models = picked.map(candidateEntry);
    try {
      let provider: UnifiedProviderPublic;
      if (created) {
        const patch: Record<string, unknown> =
          kind === 'chatgpt'
            ? codexDefaultsPatch(created, codexModel, codexEffort)
            : { models, anthropicModel: connectionModel };
        if (trimmedName !== created.name) patch.name = trimmedName;
        provider =
          Object.keys(patch).length > 0
            ? await updateConnection(created.id, patch)
            : created;
      } else {
        // A model list the endpoint answered proves the header; the test's
        // report counts only when the list did not.
        const authMode = discoveredAuthMode ?? currentTest?.outcome?.authMode;
        const body: Record<string, unknown> = {
          name: trimmedName,
          ...draftBody(),
          anthropicModel: connectionModel,
          models,
        };
        if (thirdParty) {
          // A role on a model left unchecked follows the turn's model.
          body.roles = normalizeConnectionModelRoles(roles, models);
          if (authMode) body.anthropicAuthMode = authMode;
          // A custom address the list showed to be magpie is saved as one,
          // so its catalog is kept in step from the start.
          if (discoveredGateway === 'magpie') body.gateway = 'magpie';
          if (magpiePreset) body.webFetchPreflightPolicy = webFetchPolicy;
        }
        provider = await api.post<UnifiedProviderPublic>(PROVIDERS_API, body);
        // The draft test was not stored; test the saved connection so its
        // status is on record.
        if (kind !== 'agy') {
          await testConnection({ providerId: provider.id }).catch(() => {});
        }
      }
      onDone(provider, verified);
    } catch (err) {
      setSaveError(
        connectionWriteErrorMessage(err) ??
          getErrorMessage(err, '保存模型连接失败'),
      );
    } finally {
      setSaving(false);
    }
  };

  // ─── Navigation ───
  const stepIndex = STEPS.findIndex((item) => item.key === step);
  const canLeaveConnect = (() => {
    switch (kind) {
      case 'claude_subscription':
        return !!created || !!credentialInput.trim();
      case 'chatgpt':
        return !!created;
      case 'custom':
        return (
          !!normalizeProviderBaseUrl(baseUrl) &&
          !!apiKey.trim() &&
          !envResult.error
        );
      case 'preset':
        return (
          (!preset?.editableBaseUrl || !!normalizeProviderBaseUrl(baseUrl)) &&
          !!apiKey.trim() &&
          !envResult.error
        );
      case 'anthropic_api':
        return !!apiKey.trim();
      case 'agy':
        return true;
      default:
        return false;
    }
  })();
  const goBack = () => {
    setSaveError(null);
    if (step === 'connect') setStep('source');
    else if (step === 'models') setStep('connect');
    else if (step === 'save') setStep('models');
  };
  // Once an OAuth login made the connection, the source is settled.
  const canGoBack = step !== 'source' && !(step === 'connect' && created);

  const handleLoggedIn = (provider: UnifiedProviderPublic | null) => {
    if (!provider) {
      setSaveError('登录成功，但没有收到新连接，请在模型配置列表中查看。');
      return;
    }
    setCreated(provider);
    setName((current) => current || provider.name);
    onConnectionCreated?.(provider);
    setStep('models');
  };

  const footer = (
    <>
      {canGoBack && (
        <Button
          variant="ghost"
          onClick={goBack}
          disabled={saving}
          className="sm:mr-auto"
        >
          <ArrowLeft />
          上一步
        </Button>
      )}
      {onCancel && (
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {created ? '稍后再配置' : '取消'}
        </Button>
      )}
      {step === 'connect' && (
        <Button
          onClick={() => void leaveConnect()}
          disabled={!canLeaveConnect || checkingKey}
        >
          {checkingKey && <Loader2 className="animate-spin" />}
          下一步
        </Button>
      )}
      {step === 'models' && (
        <Button
          onClick={() => setStep('save')}
          disabled={kind === 'chatgpt' ? !codexModel : picked.length === 0}
        >
          下一步
        </Button>
      )}
      {step === 'save' && (
        <Button
          onClick={() => void save()}
          disabled={saving || testing || authInvalid}
        >
          {saving && <Loader2 className="animate-spin" />}
          {verified || testing || authInvalid ? '保存' : '仍然保存（未验证）'}
        </Button>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <StepIndicator current={stepIndex} />

      {step === 'source' && <WizardSourceStep onChoose={chooseSource} />}

      {step === 'connect' && kind === 'claude_subscription' && (
        <div className="space-y-4">
          {created ? (
            <LoggedIn provider={created} />
          ) : (
            <>
              <OAuthLoginPanel service="claude" onSuccess={handleLoggedIn} />
              <SettingsField
                label="或粘贴 setup-token / .credentials.json"
                htmlFor="wizard-claude-credential"
                description={
                  <>
                    支持{' '}
                    <code className="rounded bg-muted px-1 font-mono">
                      claude setup-token
                    </code>{' '}
                    的输出，或{' '}
                    <code className="rounded bg-muted px-1 font-mono">
                      cat ~/.claude/.credentials.json
                    </code>{' '}
                    的 JSON 内容。
                  </>
                }
              >
                <Input
                  variant="code"
                  id="wizard-claude-credential"
                  type="password"
                  value={credentialInput}
                  onChange={(event) => setCredentialInput(event.target.value)}
                  placeholder="粘贴 setup-token 或 .credentials.json 内容"
                  autoComplete="off"
                  aria-invalid={keyError ? true : undefined}
                />
                <KeyError message={keyError} />
              </SettingsField>
            </>
          )}
        </div>
      )}

      {step === 'connect' && kind === 'chatgpt' && (
        <div className="space-y-4">
          {created ? (
            <LoggedIn provider={created} />
          ) : (
            <OAuthLoginPanel service="chatgpt" onSuccess={handleLoggedIn} />
          )}
        </div>
      )}

      {step === 'connect' && kind === 'agy' && (
        <div className="space-y-3 rounded-lg bg-surface-subtle p-4 text-body text-muted-foreground ring-1 ring-surface-border">
          <p className="font-medium text-foreground">
            使用宿主机已登录的 Antigravity CLI（agy-runner）
          </p>
          <p className="text-caption leading-5">
            无需填写 API Key，将直接复用宿主机当前用户的{' '}
            <code className="font-mono text-foreground">agy</code>{' '}
            登录态，并通过{' '}
            <code className="font-mono text-foreground">stream-json</code>{' '}
            常驻进程运行。目前仅支持宿主机模式工作区。
          </p>
        </div>
      )}

      {step === 'connect' && kind === 'anthropic_api' && (
        <KeyField
          error={keyError}
          value={apiKey}
          onChange={setApiKey}
          label="Anthropic API Key"
          placeholder="sk-ant-api03-..."
          description={
            <>
              在{' '}
              <ExternalAnchor href="https://console.anthropic.com/settings/keys">
                console.anthropic.com
              </ExternalAnchor>{' '}
              创建 API Key。
            </>
          }
        />
      )}

      {step === 'connect' && kind === 'preset' && preset && (
        <div className="space-y-4">
          {preset.editableBaseUrl ? (
            <SettingsField
              label="服务地址"
              htmlFor="wizard-preset-url"
              description={
                baseUrlProblem ? (
                  <BaseUrlProblem problem={baseUrlProblem} />
                ) : (
                  `${preset.name} 运行的地址；它在另一台机器上时改成那台机器的地址。`
                )
              }
            >
              <Input
                variant="code"
                id="wizard-preset-url"
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={preset.baseUrl}
                autoComplete="off"
                aria-invalid={baseUrlProblem ? true : undefined}
                className="font-mono"
              />
            </SettingsField>
          ) : (
            <SettingsField
              label="服务地址"
              htmlFor="wizard-preset-url"
              description={
                <button
                  type="button"
                  className="cursor-pointer text-primary-text underline-offset-2 hover:underline"
                  onClick={() => {
                    setBaseUrl(preset.baseUrl);
                    setDismissedUrl(normalizeProviderBaseUrl(preset.baseUrl));
                    chooseSource({ kind: 'custom' });
                  }}
                >
                  地址不一样？改用自定义地址
                </button>
              }
            >
              <Input
                variant="code"
                id="wizard-preset-url"
                value={preset.baseUrl}
                readOnly
                className="font-mono text-muted-foreground"
              />
            </SettingsField>
          )}
          <KeyField
            error={keyError}
            value={apiKey}
            onChange={setApiKey}
            label={`${preset.name} API Key`}
            placeholder="粘贴 API Key"
            description={
              <span className="flex flex-wrap gap-x-3">
                {magpiePreset && (
                  <span className="basis-full">
                    {`本机的 magpie 接受任意密钥，默认的 ${MAGPIE_APP_KEY} 让 magpie 的用量记在 HappyClaw 名下；从别的机器连接时填 magpie 的网关密钥。`}
                  </span>
                )}
                {preset.keyUrl && (
                  <ExternalAnchor href={preset.keyUrl}>
                    获取 API Key
                  </ExternalAnchor>
                )}
                {preset.docsUrl && (
                  <ExternalAnchor href={preset.docsUrl}>
                    接入文档
                  </ExternalAnchor>
                )}
              </span>
            }
          />
          {magpiePreset && (
            <SettingsField
              label="网页抓取域名检查"
              htmlFor="wizard-web-fetch-preflight"
              description="Claude Code 抓取网页前会先把域名发到 api.anthropic.com 检查；只连得上 magpie 时这一步会失败，所以默认跳过。"
            >
              <NativeSelect
                id="wizard-web-fetch-preflight"
                value={webFetchPolicy}
                onChange={(event) =>
                  setWebFetchPolicy(
                    event.target.value as WebFetchPreflightPolicy,
                  )
                }
                className="w-full sm:w-72"
              >
                <NativeSelectOption value="skip">跳过检查</NativeSelectOption>
                <NativeSelectOption value="check">
                  跟随 Claude Code 设置（默认检查）
                </NativeSelectOption>
              </NativeSelect>
            </SettingsField>
          )}
        </div>
      )}

      {step === 'connect' && kind === 'custom' && (
        <div className="space-y-4">
          <SettingsField
            label="服务地址"
            htmlFor="wizard-base-url"
            description={
              baseUrlProblem ? (
                <BaseUrlProblem problem={baseUrlProblem} />
              ) : (
                'Anthropic Messages 兼容接口的地址，Claude Code 会在后面追加 /v1/messages。'
              )
            }
          >
            <Input
              variant="code"
              id="wizard-base-url"
              type="url"
              inputMode="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/anthropic"
              autoComplete="off"
              aria-invalid={baseUrlProblem ? true : undefined}
              className="font-mono"
            />
          </SettingsField>
          {detected && (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-lg bg-primary/10 px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <span className="min-w-0 flex-1 text-caption text-foreground">
                看起来是「{detected.name}」。
                {detected.models.length > 0
                  ? '按预设配置会带上它的推荐模型。'
                  : ''}
              </span>
              <span className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    chooseSource({ kind: 'preset', presetId: detected.id })
                  }
                >
                  按预设配置
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDismissedUrl(normalizeProviderBaseUrl(baseUrl))
                  }
                >
                  继续自定义
                </Button>
              </span>
            </div>
          )}
          <KeyField
            error={keyError}
            value={apiKey}
            onChange={setApiKey}
            label="API Key"
            placeholder="粘贴 API Key 或 Token"
            description={`认证方式会自动识别：${AUTO_AUTH_MODE_HINT}`}
          />
        </div>
      )}

      {step === 'connect' && thirdParty && (
        <div className="space-y-1">
          <ProviderEnvEditor value={env} onChange={setEnv} />
          <KeyError message={envResult.error} />
        </div>
      )}

      {step === 'models' && kind === 'chatgpt' && (
        <CodexModelFields
          catalog={codexCatalog}
          model={codexModel}
          effort={codexEffort}
          onChange={setCodexPick}
        />
      )}

      {step === 'models' && kind !== 'chatgpt' && (
        <ModelPicker
          candidates={candidates}
          onCandidatesChange={setCandidates}
          roles={thirdParty ? roles : null}
          onRolesChange={setRoles}
          declareSuggestedWindow={thirdParty}
          discovery={discovery}
          onRetryDiscovery={runDiscovery}
        />
      )}

      {step === 'save' && (
        <div className="space-y-4">
          <SettingsField label="名称" htmlFor="wizard-name">
            <Input
              id="wizard-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={defaultName}
              autoComplete="off"
            />
          </SettingsField>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg px-3 py-2.5 text-caption ring-1 ring-surface-border">
            <dt className="text-muted-foreground">来源</dt>
            <dd className="truncate text-foreground">
              {preset?.name ?? CONNECTION_KIND_LABELS[kind ?? 'custom']}
              {thirdParty && (
                <span className="ml-2 font-mono text-muted-foreground">
                  {effectiveBaseUrl}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">模型</dt>
            <dd className="min-w-0 text-foreground">
              {kind === 'chatgpt' ? (
                <span className="font-mono">{codexModel || '—'}</span>
              ) : (
                <>
                  {picked.length} 个
                  <span className="ml-2 block truncate font-mono text-muted-foreground sm:inline">
                    {picked.map((candidate) => candidate.id).join('、')}
                  </span>
                </>
              )}
            </dd>
            {thirdParty && (
              <>
                <dt className="text-muted-foreground">环境变量</dt>
                <dd className="text-foreground">
                  {Object.keys(customEnv).length > 0
                    ? `${Object.keys(customEnv).length} 项`
                    : '无'}
                </dd>
              </>
            )}
          </dl>

          <div className="space-y-2">
            <ConnectionTestResult
              outcome={currentTest?.outcome ?? null}
              testing={testing}
              requestError={currentTest?.error ?? null}
            />
            {authInvalid && (
              <p className="text-caption text-error">
                密钥无效时不能保存。返回「连接」修改密钥后再试。
              </p>
            )}
            {currentTest && !testing && (
              <Button variant="ghost" size="sm" onClick={runTest}>
                <RotateCcw />
                重新测试
              </Button>
            )}
          </div>
        </div>
      )}

      {saveError && (
        <p role="alert" className="text-caption leading-5 text-error">
          {saveError}
        </p>
      )}

      {step !== 'source' || onCancel ? (
        layout === 'dialog' ? (
          <DialogFooter>{footer}</DialogFooter>
        ) : (
          <div className="flex flex-col-reverse gap-2 border-t border-surface-border pt-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )
      ) : null}
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <ol
      aria-label="添加步骤"
      className="flex items-center gap-1.5 text-caption text-muted-foreground sm:gap-3"
    >
      {STEPS.map((item, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={item.key}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              active && 'font-medium text-foreground',
            )}
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-micro ring-1',
                active
                  ? 'bg-primary text-primary-foreground ring-primary'
                  : done
                    ? 'bg-surface-selected text-foreground ring-surface-selected'
                    : 'ring-surface-border',
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            {/* Phones show only the current step's name. */}
            <span className={cn('truncate', !active && 'max-sm:hidden')}>
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function KeyField({
  value,
  onChange,
  label,
  placeholder,
  description,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  description?: ReactNode;
  /** The vendor refused this key. */
  error: string | null;
}) {
  return (
    <SettingsField
      label={label}
      htmlFor="wizard-api-key"
      description={description}
    >
      <Input
        variant="code"
        id="wizard-api-key"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        aria-invalid={error ? true : undefined}
        className="font-mono"
      />
      <KeyError message={error} />
    </SettingsField>
  );
}

function BaseUrlProblem({ problem }: { problem: string }) {
  return (
    <span className="flex gap-1.5 text-warning">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {problem}
    </span>
  );
}

function KeyError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-caption leading-5 text-error">
      {message}
    </p>
  );
}

function LoggedIn({ provider }: { provider: UnifiedProviderPublic }) {
  const account =
    provider.claudeOAuthAccountEmail ?? provider.codexOAuthCredentialsEmail;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2.5 text-caption leading-5"
    >
      <Check
        className="mt-0.5 size-4 shrink-0 text-success"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-foreground">
          已登录，连接「{provider.name}」已创建
        </div>
        <div className="text-muted-foreground">
          {account ? `账号 ${account}。` : ''}接下来选择模型并测试。
        </div>
      </div>
    </div>
  );
}

interface AddModelWizardDialogProps {
  open: boolean;
  /**
   * The wizard closed. `saved` is the finished connection; `created` one an
   * OAuth login made before the user left.
   */
  onClose: (result: {
    saved: UnifiedProviderPublic | null;
    verified: boolean;
    created: UnifiedProviderPublic | null;
  }) => void;
}

/**
 * The wizard in a dialog, as Settings → 模型配置 opens it. The dialog drops
 * its content when closed, so every opening starts a fresh draft.
 */
export function AddModelWizardDialog({
  open,
  onClose,
}: AddModelWizardDialogProps) {
  const [busy, setBusy] = useState(false);
  const created = useRef<UnifiedProviderPublic | null>(null);

  const finish = (saved: UnifiedProviderPublic | null, verified: boolean) => {
    const leftBehind = saved ? null : created.current;
    created.current = null;
    onClose({ saved, verified, created: leftBehind });
  };
  const close = () => {
    if (!busy) finish(null, false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加模型连接</DialogTitle>
          <DialogDescription>
            一个连接对应一份凭据和一个服务地址，可以提供多个模型。
          </DialogDescription>
        </DialogHeader>
        <AddModelWizard
          onBusyChange={setBusy}
          onConnectionCreated={(provider) => {
            created.current = provider;
          }}
          onCancel={close}
          onDone={finish}
        />
      </DialogContent>
    </Dialog>
  );
}
