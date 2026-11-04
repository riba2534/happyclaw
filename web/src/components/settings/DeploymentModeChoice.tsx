import type { ReactNode } from 'react';
import { Monitor, Users } from 'lucide-react';
import {
  ModeChoiceGroup,
  type ModeChoiceOption,
} from '../chat/InteractionModeSelector';
import type { DeploymentMode } from '../../stores/auth';

/**
 * 部署方式 as two choice cards; used by the setup wizard and by settings.
 * The legend is for screen readers: both callers title the section with it.
 */
export function DeploymentModeChoice({
  value,
  onChange,
  legend,
  hint,
  disabled,
  recommendSingleUser = false,
}: {
  value: DeploymentMode;
  onChange: (mode: DeploymentMode) => void;
  legend: string;
  hint?: ReactNode;
  disabled?: boolean;
  /** Mark 单人宿主机 as the recommended choice (the setup wizard). */
  recommendSingleUser?: boolean;
}) {
  const options: ModeChoiceOption<DeploymentMode>[] = [
    {
      value: 'single_user_host',
      title: recommendSingleUser ? '单人宿主机（推荐）' : '单人宿主机',
      description:
        '只有你一个人用，不需要 Docker：智能体直接在这台机器上运行，省下容器的资源。',
      icon: Monitor,
    },
    {
      value: 'multi_user',
      title: '多人',
      description:
        '可以邀请其他人注册；每个成员的工作区在 Docker 容器里隔离运行。',
      icon: Users,
    },
  ];
  return (
    <ModeChoiceGroup
      name="deployment_mode"
      legend={legend}
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      hint={hint}
      hideLegend
    />
  );
}
