import { useState } from 'react';
import { Loader2, Plus, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  MAX_PROVIDER_MODELS,
  type ProviderCatalogPublic,
  type ProviderModelEntry,
} from '@/lib/model-providers';
import { formatSessionTime } from '../../lib/session-presentation';
import { errorCopy } from './model-connections';

interface ConnectionCatalogProps {
  catalog: ProviderCatalogPublic;
  /** The connection's models: an upstream model already listed is not new. */
  listed: readonly ProviderModelEntry[];
  /** Adds the chosen upstream models to the list; true once saved. */
  onAdd: (entries: ProviderModelEntry[]) => Promise<boolean>;
  onAutoAddChange: (next: boolean) => void;
  disabled: boolean;
}

/**
 * A magpie connection's catalog: when its list was last read from magpie,
 * the upstream models the connection does not offer yet (to add some or
 * all), and whether new ones join by themselves. Models magpie stopped
 * listing are marked in the list itself and never removed here.
 */
export function ConnectionCatalog({
  catalog,
  listed,
  onAdd,
  onAutoAddChange,
  disabled,
}: ConnectionCatalogProps) {
  const known = new Set(listed.map((entry) => entry.id));
  // The server drops what a save added, but a list saved meanwhile may
  // already hold a model the last sync still calls new.
  const fresh = catalog.newModels.filter((entry) => !known.has(entry.id));
  const room = Math.max(0, MAX_PROVIDER_MODELS - listed.length);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const add = async (entries: ProviderModelEntry[]) => {
    setAdding(true);
    try {
      if (await onAdd(entries)) {
        setChosen(new Set());
        setChoosing(false);
      }
    } finally {
      setAdding(false);
    }
  };
  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const picked = fresh.filter((entry) => chosen.has(entry.id));
  const busy = disabled || adding;

  return (
    <section
      aria-label="magpie 模型目录"
      className="space-y-3 rounded-lg p-3 ring-1 ring-surface-border"
    >
      <SyncLine catalog={catalog} />

      {fresh.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-label text-foreground">
              上游有 {fresh.length} 个新模型
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChoosing((open) => !open)}
              aria-expanded={choosing}
              disabled={busy}
            >
              {choosing ? '收起' : '选择'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void add(fresh)}
              disabled={busy || fresh.length > room}
            >
              {adding ? <Loader2 className="animate-spin" /> : <Plus />}
              全部添加
            </Button>
          </div>
          {choosing && (
            <div className="space-y-2">
              <div
                role="group"
                aria-label="上游新模型"
                className="max-h-60 divide-y divide-surface-border overflow-y-auto overscroll-contain rounded-lg ring-1 ring-surface-border"
              >
                {fresh.map((entry) => {
                  const id = `catalog-new-${entry.id}`;
                  return (
                    <div
                      key={entry.id}
                      className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-1.5"
                    >
                      <Checkbox
                        id={id}
                        checked={chosen.has(entry.id)}
                        onCheckedChange={(next) =>
                          toggle(entry.id, next === true)
                        }
                        aria-label={`添加 ${entry.id}`}
                        disabled={busy}
                      />
                      <label htmlFor={id} className="min-w-0 flex-1">
                        <span className="block truncate text-caption text-foreground">
                          {entry.displayName ?? entry.id}
                        </span>
                        <span className="block truncate font-mono text-micro text-muted-foreground">
                          {[entry.displayName ? entry.id : null, entry.vendor]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
              <Button
                size="sm"
                onClick={() => void add(picked)}
                disabled={busy || picked.length === 0 || picked.length > room}
              >
                添加所选（{picked.length}）
              </Button>
            </div>
          )}
          {fresh.length > room && (
            <p className="text-caption text-warning">
              一个连接最多 {MAX_PROVIDER_MODELS} 个模型，还能添加 {room} 个。
            </p>
          )}
        </div>
      )}

      <div className="flex items-start gap-3">
        <Switch
          id="catalog-auto-add"
          checked={catalog.autoAdd}
          onCheckedChange={onAutoAddChange}
          disabled={busy}
          className="mt-0.5"
        />
        <label htmlFor="catalog-auto-add" className="min-w-0 flex-1">
          <span className="block text-label text-foreground">
            自动添加上游新模型
          </span>
          <span className="block text-caption leading-5 text-muted-foreground">
            magpie
            新增的模型自动加入列表；上游不再提供的模型只做标记，不会自动删除。
          </span>
        </label>
      </div>
    </section>
  );
}

function SyncLine({ catalog }: { catalog: ProviderCatalogPublic }) {
  if (catalog.error) {
    const copy = errorCopy(catalog.error.code);
    return (
      <div role="status" className="flex gap-2 text-caption leading-5">
        <TriangleAlert
          className="mt-0.5 size-3.5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="text-foreground">
            同步失败：{copy.title}
            {catalog.syncedAt
              ? `，上次成功 ${formatSessionTime(catalog.syncedAt)}`
              : ''}
          </div>
          {catalog.error.message && (
            <div className="font-mono text-micro break-all text-faint-foreground">
              {catalog.error.message}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <p className="text-caption text-muted-foreground">
      {catalog.syncedAt
        ? `已与 magpie 同步 · ${formatSessionTime(catalog.syncedAt)}`
        : '还没有与 magpie 同步'}
    </p>
  );
}
