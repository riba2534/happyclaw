import { useState } from 'react';
import { ChevronDown, ChevronUp, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { GroupInfo } from '../../stores/groups';
import { GroupDetail } from './GroupDetail';

interface GroupCardProps {
  group: GroupInfo & { jid: string };
}

export function GroupCard({ group }: GroupCardProps) {
  const [expanded, setExpanded] = useState(false);

  // 截短 JID 显示（保留前缀和后缀）
  const truncateJid = (jid: string) => {
    if (jid.length <= 30) return jid;
    const parts = jid.split(':');
    if (parts.length === 2 && parts[1].length > 20) {
      const id = parts[1];
      return `${parts[0]}:${id.slice(0, 8)}...${id.slice(-4)}`;
    }
    return jid;
  };

  return (
    <Card className="hover:border-brand-300 transition-colors duration-200">
      {/* Card Header - Clickable */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left cursor-pointer"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            {/* Group Name */}
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold text-foreground truncate">
                {group.name}
              </h3>
              {group.is_shared && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand-100 text-primary text-[10px] font-medium flex-shrink-0">
                  <Users className="w-3 h-3" />
                  {group.member_count ?? 0}
                </span>
              )}
            </div>

            {/* JID */}
            <p className="text-xs text-muted-foreground font-mono mb-2">
              {truncateJid(group.jid)}
            </p>

            {/* Folder & Trigger */}
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">文件夹:</span>
                <span className="text-foreground font-medium">
                  {group.folder}
                </span>
              </div>
            </div>
          </div>

          {/* Expand Icon */}
          <div className="ml-4 flex-shrink-0">
            {expanded ? (
              <ChevronUp className="w-5 h-5 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-5 h-5 text-muted-foreground" />
            )}
          </div>
        </div>
      </button>

      {/* Expanded Detail */}
      {expanded && (
        <div className="border-t border-border">
          <GroupDetail group={group} />
        </div>
      )}
    </Card>
  );
}
