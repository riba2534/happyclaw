import { useState } from 'react';
import { Github, ExternalLink, Heart, Code2, Lightbulb, Bug } from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="space-y-6">
      {/* 项目信息 */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">HappyClaw</h2>
        <p className="text-sm text-muted-foreground">自托管个人 AI Agent 系统</p>
      </div>

      {/* 开源地址 & 作者 & 报告问题 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <a
            href="https://github.com/riba2534/happyclaw"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
          >
            riba2534/happyclaw
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Code2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-foreground">作者：riba2534</span>
        </div>
        <div className="flex items-center gap-3">
          <Bug className="w-4 h-4 text-muted-foreground shrink-0" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBugReport(true)}
          >
            <Bug className="w-3.5 h-3.5" />
            报告问题
          </Button>
        </div>
      </div>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      <hr className="border-border" />

      {/* 灵感来源 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-medium text-foreground">灵感来源</h3>
        </div>
        <div className="space-y-4 text-sm text-muted-foreground">
          <div>
            <a
              href="https://github.com/slopus/happy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              Happy
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              我接触到的第一个类似项目。它是 Claude Code 的网页 Web 版，让你可以在任何地方通过浏览器使用 Claude Code，不再受限于本地终端。这个理念深深吸引了我，但遗憾的是项目维护更新不够及时，许多问题长期得不到修复。
            </p>
          </div>
          <div>
            <a
              href="https://github.com/openclaw/openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              OpenClaw
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              当下最火爆、最流行的个人 Agent 项目。但我认为它的架构存在根本性的缺陷——它自己从头实现了一个 Agent。而 Claude Code 已经是世界上最好的 Agent 了，为什么不站在巨人的肩膀上去构建呢？
            </p>
          </div>
        </div>
      </div>

      <hr className="border-border" />

      {/* 设计哲学 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-medium text-foreground">设计哲学</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          站在巨人的肩膀上，基于 Claude Code（全世界最好的 Agent）构建。
        </p>
      </div>

    </div>
  );
}
