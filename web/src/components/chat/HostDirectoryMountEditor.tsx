import { useId } from 'react';
import {
  FolderSymlink,
  HardDrive,
  LockKeyhole,
  Plus,
  Trash2,
} from 'lucide-react';
import { IconButton } from '@/components/common/IconButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import {
  storageSourceLocation,
  type StorageSource,
} from '../../lib/storage-sources';
import type { AdditionalMountInput } from '../../types';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';

export const MAX_HOST_DIRECTORY_MOUNTS = 8;
export const CONTAINER_MOUNT_ROOT = '/workspace/extra/';
const RESERVED_CONTAINER_SUFFIX_COMPONENTS = new Set(['.npm-global']);

let mountDraftSequence = 0;

export interface HostDirectoryMountDraft {
  id: string;
  /** A host directory bind, or a network storage source from the allowlist. */
  kind: 'host' | 'storage';
  hostPath: string;
  source: string;
  subPath: string;
  /** Storage mounts only; host directories are always read-only. */
  readonly: boolean;
  containerPath: string;
  containerPathTouched: boolean;
}

export function createHostDirectoryMountDraft(
  kind: HostDirectoryMountDraft['kind'] = 'host',
  source = '',
): HostDirectoryMountDraft {
  mountDraftSequence += 1;
  return {
    id: `host-mount-${mountDraftSequence}`,
    kind,
    hostPath: '',
    source,
    subPath: '',
    readonly: true,
    containerPath: kind === 'storage' ? source : '',
    containerPathTouched: false,
  };
}

function isSafeSubPath(value: string): boolean {
  if (!value) return true;
  if (
    value.startsWith('/') ||
    value.length > 1024 ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value !== value.trim()
  ) {
    return false;
  }
  return value
    .replace(/\/+$/, '')
    .split('/')
    .every((segment) => segment && segment !== '.' && segment !== '..');
}

function basename(directoryPath: string): string {
  return (
    directoryPath.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? ''
  );
}

function isSafeContainerSuffix(value: string): boolean {
  if (!value || value.startsWith('/') || value.endsWith('/')) return false;
  if (
    value.length > 512 ||
    value.includes('\\') ||
    value.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !RESERVED_CONTAINER_SUFFIX_COMPONENTS.has(segment),
  );
}

export function validateHostDirectoryMounts(
  mounts: HostDirectoryMountDraft[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const targets = new Map<string, number>();
  if (mounts.length > MAX_HOST_DIRECTORY_MOUNTS) {
    errors.additional_mounts = `最多只能挂载 ${MAX_HOST_DIRECTORY_MOUNTS} 个目录`;
  }

  mounts.forEach((mount, index) => {
    const hostPath = mount.hostPath.trim();
    const containerPath = mount.containerPath.trim();
    if (mount.kind === 'storage') {
      if (!mount.source) {
        errors[`additional_mounts.${index}.source`] = '请选择存储源';
      }
      if (!isSafeSubPath(mount.subPath)) {
        errors[`additional_mounts.${index}.sub_path`] =
          '子目录必须是相对路径，不能以 / 开头或包含 .、..、反斜杠';
      }
    } else if (!hostPath) {
      errors[`additional_mounts.${index}.host_path`] =
        '请选择 HappyClaw 服务器上的宿主机目录';
    } else if (!hostPath.startsWith('/')) {
      errors[`additional_mounts.${index}.host_path`] =
        '宿主机目录必须是服务器上的绝对路径';
    }

    if (!containerPath) {
      errors[`additional_mounts.${index}.container_path`] = '请输入容器内目录';
    } else if (!isSafeContainerSuffix(containerPath)) {
      errors[`additional_mounts.${index}.container_path`] =
        '请输入安全的相对路径，不能以 / 开头、以 / 结尾或包含 .、..、反斜杠、冒号及运行时保留目录';
    } else {
      const existingIndex = targets.get(containerPath);
      if (existingIndex !== undefined) {
        errors[`additional_mounts.${existingIndex}.container_path`] =
          '容器内目录不能重复';
        errors[`additional_mounts.${index}.container_path`] =
          '容器内目录不能重复';
      } else {
        targets.set(containerPath, index);
      }
    }
  });

  const validTargets = Array.from(targets.entries());
  for (let first = 0; first < validTargets.length; first += 1) {
    const [firstTarget, firstIndex] = validTargets[first];
    for (let second = first + 1; second < validTargets.length; second += 1) {
      const [secondTarget, secondIndex] = validTargets[second];
      const nested =
        firstTarget.startsWith(`${secondTarget}/`) ||
        secondTarget.startsWith(`${firstTarget}/`);
      if (!nested) continue;
      errors[`additional_mounts.${firstIndex}.container_path`] =
        '容器内目录不能与另一个挂载目录相互嵌套';
      errors[`additional_mounts.${secondIndex}.container_path`] =
        '容器内目录不能与另一个挂载目录相互嵌套';
    }
  }

  return errors;
}

export function toAdditionalMountInputs(
  mounts: HostDirectoryMountDraft[],
): AdditionalMountInput[] {
  return mounts.map((mount) =>
    mount.kind === 'storage'
      ? {
          source: mount.source,
          ...(mount.subPath.trim()
            ? { sub_path: mount.subPath.trim().replace(/\/+$/, '') }
            : {}),
          container_path: mount.containerPath.trim(),
          readonly: mount.readonly,
        }
      : {
          host_path: mount.hostPath.trim(),
          container_path: mount.containerPath.trim(),
          readonly: true as const,
        },
  );
}

interface HostDirectoryMountEditorProps {
  mounts: HostDirectoryMountDraft[];
  onChange: (mounts: HostDirectoryMountDraft[]) => void;
  fieldErrors?: Record<string, string>;
  disabled?: boolean;
  /** Storage sources the administrator defined; empty hides the option. */
  storageSources?: StorageSource[];
  /** False when the allowlist keeps new workspaces read-only. */
  storageReadWriteAllowed?: boolean;
}

export function HostDirectoryMountEditor({
  mounts,
  onChange,
  fieldErrors = {},
  disabled = false,
  storageSources = [],
  storageReadWriteAllowed = false,
}: HostDirectoryMountEditorProps) {
  const headingId = useId();
  const mountListError = fieldErrors.additional_mounts;

  const updateMount = (
    index: number,
    update: Partial<HostDirectoryMountDraft>,
  ) => {
    onChange(
      mounts.map((mount, mountIndex) =>
        mountIndex === index ? { ...mount, ...update } : mount,
      ),
    );
  };

  const removeMount = (index: number) => {
    onChange(mounts.filter((_, mountIndex) => mountIndex !== index));
  };

  const addMount = (kind: HostDirectoryMountDraft['kind'] = 'host') => {
    if (mounts.length >= MAX_HOST_DIRECTORY_MOUNTS) return;
    onChange([
      ...mounts,
      createHostDirectoryMountDraft(
        kind,
        kind === 'storage' ? (storageSources[0]?.id ?? '') : '',
      ),
    ]);
  };
  const hasStorage = storageSources.length > 0;
  const atLimit = mounts.length >= MAX_HOST_DIRECTORY_MOUNTS;
  const addButtons = (first: boolean) => (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => addMount('host')}
        disabled={disabled || atLimit}
        className="pointer-coarse:h-10"
      >
        <Plus />
        {first ? '添加宿主机目录' : '添加另一个目录'}
      </Button>
      {hasStorage && (
        <Button
          type="button"
          variant="outline"
          onClick={() => addMount('storage')}
          disabled={disabled || atLimit}
          className="pointer-coarse:h-10"
        >
          <HardDrive />
          添加存储源
        </Button>
      )}
    </div>
  );

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-start gap-2">
        <FolderSymlink className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 id={headingId} className="text-body font-medium text-foreground">
            {hasStorage ? '目录与存储挂载' : '宿主机目录挂载'}
          </h3>
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
            仅管理员可用。选择 HappyClaw/Docker
            服务器上的目录，并实时挂载到容器；这不是复制，源目录后续变化会直接反映到容器中。
            {hasStorage &&
              '存储源是设置里配置的 NAS 共享，由 Docker 直接挂载。'}
          </p>
        </div>
      </div>
      {mountListError && (
        <p className="text-caption text-error" role="alert">
          {mountListError}
        </p>
      )}

      {mounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-border px-3 py-3">
          <p className="text-caption leading-5 text-muted-foreground">
            当前不挂载额外目录。添加后，目录会出现在
            <code className="mx-1 rounded bg-surface-selected px-1 py-0.5 font-mono">
              /workspace/extra/
            </code>
            下。宿主机目录固定为只读。
          </p>
          <div className="mt-2.5">{addButtons(true)}</div>
        </div>
      ) : (
        <div className="space-y-3">
          {mounts.map((mount, index) => {
            const hostError =
              fieldErrors[`additional_mounts.${index}.host_path`];
            const containerError =
              fieldErrors[`additional_mounts.${index}.container_path`];
            const containerInputId = `${mount.id}-container-path`;
            const containerErrorId = `${containerInputId}-error`;
            const isStorage = mount.kind === 'storage';
            const selectedSource = storageSources.find(
              (source) => source.id === mount.source,
            );
            const sourceError =
              fieldErrors[`additional_mounts.${index}.source`];
            const subPathError =
              fieldErrors[`additional_mounts.${index}.sub_path`];
            const canWrite =
              storageReadWriteAllowed && !!selectedSource?.allowReadWrite;
            const writeHint = !selectedSource
              ? null
              : !selectedSource.allowReadWrite
                ? '这个存储源只允许只读挂载'
                : !storageReadWriteAllowed
                  ? '挂载白名单要求新建的工作区只读挂载'
                  : null;
            const defaultTarget = (sourceId: string, subPath: string) =>
              basename(subPath) || sourceId;
            return (
              <fieldset
                key={mount.id}
                className="space-y-3 rounded-lg border border-surface-border p-3"
                disabled={disabled}
              >
                <legend className="sr-only">
                  {isStorage ? '存储源挂载' : '宿主机目录挂载'} {index + 1}
                </legend>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-label text-foreground">
                    挂载目录 {index + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    {isStorage ? (
                      <Badge variant="outline">
                        <HardDrive />
                        存储源
                      </Badge>
                    ) : (
                      <Badge variant="neutral">
                        <LockKeyhole />
                        固定只读
                      </Badge>
                    )}
                    <IconButton
                      label={`删除挂载目录 ${index + 1}`}
                      icon={<Trash2 />}
                      onClick={() => removeMount(index)}
                      className="text-muted-foreground hover:text-destructive pointer-coarse:size-10"
                    />
                  </div>
                </div>

                {isStorage ? (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor={`${mount.id}-source`} className="mb-1.5">
                        存储源
                      </Label>
                      <NativeSelect
                        id={`${mount.id}-source`}
                        value={mount.source}
                        onChange={(event) => {
                          const source = event.target.value;
                          const next = storageSources.find(
                            (candidate) => candidate.id === source,
                          );
                          updateMount(index, {
                            source,
                            ...(next?.allowReadWrite ? {} : { readonly: true }),
                            ...(mount.containerPathTouched
                              ? {}
                              : {
                                  containerPath: defaultTarget(
                                    source,
                                    mount.subPath,
                                  ),
                                }),
                          });
                        }}
                        className="w-full"
                        aria-invalid={!!sourceError}
                      >
                        {!selectedSource && (
                          <NativeSelectOption value="">
                            {mount.source
                              ? `${mount.source}（已删除）`
                              : '请选择'}
                          </NativeSelectOption>
                        )}
                        {storageSources.map((source) => (
                          <NativeSelectOption key={source.id} value={source.id}>
                            {source.description || source.id} ·{' '}
                            {storageSourceLocation(source)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {sourceError && (
                        <p
                          className="mt-1 text-caption text-error"
                          role="alert"
                        >
                          {sourceError}
                        </p>
                      )}
                    </div>
                    <div>
                      <Label
                        htmlFor={`${mount.id}-sub-path`}
                        className="mb-1.5"
                      >
                        子目录（可选）
                      </Label>
                      <Input
                        id={`${mount.id}-sub-path`}
                        value={mount.subPath}
                        onChange={(event) =>
                          updateMount(index, {
                            subPath: event.target.value,
                            ...(mount.containerPathTouched
                              ? {}
                              : {
                                  containerPath: defaultTarget(
                                    mount.source,
                                    event.target.value.trim(),
                                  ),
                                }),
                          })
                        }
                        placeholder="projects/alpha"
                        variant="code"
                        className="font-mono pointer-coarse:h-10"
                        aria-invalid={!!subPathError}
                        autoComplete="off"
                      />
                      <p className="mt-1.5 text-caption text-muted-foreground">
                        留空挂载整个共享；目录必须已在 NAS 上存在。
                      </p>
                      {subPathError && (
                        <p
                          className="mt-1 text-caption text-error"
                          role="alert"
                        >
                          {subPathError}
                        </p>
                      )}
                    </div>
                    <label
                      htmlFor={`${mount.id}-writable`}
                      className="flex items-center justify-between gap-4"
                    >
                      <span className="min-w-0">
                        <span className="block text-label text-foreground">
                          允许写入
                        </span>
                        {writeHint && (
                          <span className="block text-caption text-muted-foreground">
                            {writeHint}
                          </span>
                        )}
                      </span>
                      <Switch
                        id={`${mount.id}-writable`}
                        checked={!mount.readonly && canWrite}
                        disabled={!canWrite}
                        onCheckedChange={(checked) =>
                          updateMount(index, { readonly: !checked })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    <DirectoryBrowser
                      value={mount.hostPath}
                      onChange={(nextPath, source) => {
                        const nextUpdate: Partial<HostDirectoryMountDraft> = {
                          hostPath: nextPath,
                        };
                        if (
                          (source === 'browser' || source === 'created') &&
                          !mount.containerPathTouched
                        ) {
                          nextUpdate.containerPath = basename(nextPath);
                        }
                        updateMount(index, nextUpdate);
                      }}
                      inputId={`${mount.id}-host-path`}
                      label="宿主机目录"
                      description="这里浏览的是 HappyClaw/Docker 服务器目录，不是当前浏览器设备上的文件夹。"
                      placeholder="/srv/projects/example"
                      purpose="mount"
                      allowCreateFolder={false}
                      disabled={disabled}
                    />
                    {hostError && (
                      <p className="text-caption text-error" role="alert">
                        {hostError}
                      </p>
                    )}
                  </>
                )}

                <div>
                  <Label htmlFor={containerInputId} className="mb-1.5">
                    容器内目录
                  </Label>
                  <div className="flex min-w-0 items-stretch">
                    <span className="inline-flex shrink-0 items-center rounded-l-lg border border-r-0 border-input bg-surface-hover px-2 font-mono text-caption text-muted-foreground">
                      {CONTAINER_MOUNT_ROOT}
                    </span>
                    <Input
                      id={containerInputId}
                      value={mount.containerPath}
                      onChange={(event) =>
                        updateMount(index, {
                          containerPath: event.target.value,
                          containerPathTouched: true,
                        })
                      }
                      placeholder="project-data"
                      variant="code"
                      className="min-w-0 rounded-l-none font-mono pointer-coarse:h-10"
                      aria-invalid={!!containerError}
                      aria-describedby={
                        containerError ? containerErrorId : undefined
                      }
                      autoComplete="off"
                    />
                  </div>
                  <p className="mt-1.5 text-caption text-muted-foreground">
                    只能填写
                    <code className="mx-1 rounded bg-surface-selected px-1 py-0.5 font-mono">
                      /workspace/extra/
                    </code>
                    下的相对路径。
                  </p>
                  {containerError && (
                    <p
                      id={containerErrorId}
                      className="mt-1 text-caption text-error"
                      role="alert"
                    >
                      {containerError}
                    </p>
                  )}
                </div>
              </fieldset>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {addButtons(false)}
            <span
              className="text-caption text-muted-foreground tabular-nums"
              aria-live="polite"
            >
              {mounts.length} / {MAX_HOST_DIRECTORY_MOUNTS}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
