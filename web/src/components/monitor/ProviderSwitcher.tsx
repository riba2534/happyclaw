import { useCallback, useState } from 'react';
import { ArrowRightLeft, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMonitorStore } from '@/stores/monitor';

export interface SimpleProvider {
  id: string;
  name: string;
}

interface ProviderSwitcherProps {
  groupFolder: string | null;
  currentProviderId: string | null;
  currentProviderName: string | null;
  providers: SimpleProvider[];
}

export function ProviderSwitcher({
  groupFolder,
  currentProviderId,
  currentProviderName,
  providers,
}: ProviderSwitcherProps) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchProvider = useMonitorStore((s) => s.switchProvider);
  const loadStatus = useMonitorStore((s) => s.loadStatus);

  const handleSwitch = useCallback(
    async (providerId: string) => {
      if (!groupFolder || switching) return;
      setSwitching(true);
      setError(null);
      try {
        await switchProvider(groupFolder, providerId);
        // Reload status after a short delay to reflect the restart
        setTimeout(() => loadStatus(), 2000);
      } catch (err) {
        const message = err instanceof Error ? err.message : '切换失败';
        console.error('Provider switch failed:', err);
        setError(message);
      } finally {
        setSwitching(false);
      }
    },
    [groupFolder, switching, switchProvider, loadStatus],
  );

  if (!groupFolder) return <span className="text-muted-foreground">-</span>;

  const otherProviders = providers.filter((p) => p.id !== currentProviderId);

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-foreground truncate max-w-[120px]">
        {currentProviderName || currentProviderId || '-'}
      </span>
      {error && (
        <span className="text-destructive text-xs truncate max-w-[100px]" title={error}>
          {error}
        </span>
      )}
      {otherProviders.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0"
              disabled={switching}
              title="切换 Provider（一次性）"
            >
              {switching ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ArrowRightLeft className="size-3" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {otherProviders.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => handleSwitch(p.id)}>
                {p.name}
              </DropdownMenuItem>
            ))}
            {currentProviderId && (
              <DropdownMenuItem disabled>
                <Check className="size-3 mr-1.5" />
                {currentProviderName || currentProviderId}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
