import { useState } from 'react';
import { Bug, ExternalLink } from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

function ExternalAnchor({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm text-body font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
      <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="space-y-8">
      <SettingsGroup>
        {/* 项目信息 */}
        <div className="flex items-center gap-3 px-4 py-4">
          <img
            src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
            alt=""
            className="size-10 shrink-0 rounded-lg"
          />
          <div className="min-w-0">
            <h2 className="text-title-sm text-foreground">HappyClaw</h2>
            <p className="mt-0.5 text-caption text-balance text-muted-foreground">
              基于 Claude Agent SDK 的自托管多智能体工作平台
            </p>
            <p className="text-caption text-faint-foreground tabular-nums">
              版本 1.0.0 · MIT License
            </p>
          </div>
        </div>

        {/* 开源地址 & 作者 & 报告问题 */}
        <SettingsRow
          label="开源地址"
          control={
            <ExternalAnchor href="https://github.com/riba2534/happyclaw">
              riba2534/happyclaw
            </ExternalAnchor>
          }
        />
        <SettingsRow
          label="作者"
          control={<span className="text-body text-foreground">riba2534</span>}
        />
        <SettingsRow
          label="问题反馈"
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowBugReport(true)}
            >
              <Bug className="size-3.5" />
              报告问题
            </Button>
          }
        />
      </SettingsGroup>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      {/* 灵感来源 */}
      <SettingsSection title="灵感来源">
        <SettingsGroup>
          <SettingsRow
            label={
              <ExternalAnchor href="https://github.com/slopus/happy">
                Happy
              </ExternalAnchor>
            }
            description="Claude Code Web 化方向的重要启发项目，让用户可以通过浏览器在不同设备上继续使用 Claude Code 工作流。"
          />
          <SettingsRow
            label={
              <ExternalAnchor href="https://github.com/openclaw/openclaw">
                OpenClaw
              </ExternalAnchor>
            }
            description="自托管个人智能体产品方向的重要参考。HappyClaw 选择复用 Claude Agent SDK，并在此基础上构建工作区、渠道与多智能体管理能力。"
          />
        </SettingsGroup>
      </SettingsSection>

      {/* 设计哲学 */}
      <SettingsSection title="设计哲学">
        <SettingsGroup>
          <p className="px-4 py-3 text-body leading-6 text-muted-foreground">
            复用成熟的 Claude Agent
            SDK，把产品重心放在工作区、渠道连接、能力治理和多用户协作体验上。
          </p>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
