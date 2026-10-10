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
}: ProviderSwitcherProps) {
  if (!groupFolder) return <span className="text-muted-foreground">-</span>;

  return (
    <span
      className="block max-w-40 truncate text-foreground"
      title="模型由所属智能体配置决定"
    >
      {currentProviderName || currentProviderId || '-'}
    </span>
  );
}
