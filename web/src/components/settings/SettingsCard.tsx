import type { LucideIcon } from 'lucide-react';
import { SettingsGroup, SettingsSection } from './SettingsLayout';

/**
 * Titled settings block whose body sits in a bordered group. Kept for the
 * existing call sites; new code can compose SettingsSection + SettingsGroup.
 */
export function SettingsCard({
  icon: _icon,
  title,
  desc,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <SettingsSection title={title} description={desc}>
      <SettingsGroup className="divide-y-0">
        <div className="space-y-4 px-4 py-4">{children}</div>
      </SettingsGroup>
    </SettingsSection>
  );
}
