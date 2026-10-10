import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plug, Puzzle, Server } from 'lucide-react';

import { PageContainer } from '@/components/common/PageContainer';
import { PageTopBar } from '@/components/common/PageTopBar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CapabilityActionsSlotContext,
  CapabilityPageNoteContext,
} from '@/components/capabilities/capability-ui';
import { McpServersPage } from './McpServersPage';
import { PluginsPage } from './PluginsPage';
import { SkillsPage } from './SkillsPage';

const sections = [
  { key: 'skills', label: 'Skills', icon: Puzzle },
  { key: 'mcp', label: 'MCP', icon: Server },
  { key: 'plugins', label: 'Plugins', icon: Plug },
] as const;

export function CapabilitiesPage() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  if (!section) return <Navigate to="/capabilities/skills" replace />;
  if (!sections.some((item) => item.key === section)) {
    return <Navigate to="/capabilities/skills" replace />;
  }

  return (
    <Tabs
      value={section}
      onValueChange={(next) => navigate(`/capabilities/${next}`)}
      className="min-h-full gap-0 bg-background"
    >
      <PageTopBar
        title="能力库"
        actions={
          <div ref={setActionsSlot} className="flex items-center gap-1.5" />
        }
      >
        <TabsList
          variant="line"
          aria-label="能力类型"
          className="group-data-horizontal/tabs:h-12"
        >
          {sections.map(({ key, label, icon: Icon }) => (
            <TabsTrigger key={key} value={key} className="flex-none px-2">
              <Icon className="max-sm:hidden" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </PageTopBar>

      <PageContainer size="full" className="space-y-4 lg:px-6 lg:py-5">
        {/* Each tab folds this note into its own notice. */}
        <CapabilityPageNoteContext.Provider
          value={
            <>
              在这里安装和管理可复用资源；到具体智能体的“能力配置”中决定是否启用。
              工作区自带的 CLAUDE.md、.claude/skills 与项目 MCP 不在这里分配。
            </>
          }
        >
          <CapabilityActionsSlotContext.Provider value={actionsSlot}>
            <TabsContent value="skills">
              <SkillsPage />
            </TabsContent>
            <TabsContent value="mcp">
              <McpServersPage />
            </TabsContent>
            <TabsContent value="plugins">
              <PluginsPage />
            </TabsContent>
          </CapabilityActionsSlotContext.Provider>
        </CapabilityPageNoteContext.Provider>
      </PageContainer>
    </Tabs>
  );
}
