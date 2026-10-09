import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { EyeOff, RotateCw, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { wsManager } from '../../api/ws';
import { Button } from '@/components/ui/button';
import { IconButton } from '../common/IconButton';
import { cn } from '@/lib/utils';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

// ANSI palettes: Tokyo Night for dark mode, GitHub Light for light mode.
// The background stays transparent so the panel surface shows through.
const DARK_THEME = {
  background: '#00000000',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#ad8ee6',
  cyan: '#449dab',
  white: '#787c99',
  brightBlack: '#444b6a',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#acb0d0',
};

const LIGHT_THEME = {
  background: '#00000000',
  foreground: '#24292f',
  cursor: '#24292f',
  selectionBackground: '#0969da33',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

function terminalTheme() {
  return document.documentElement.classList.contains('dark')
    ? DARK_THEME
    : LIGHT_THEME;
}

interface TerminalPanelProps {
  groupJid: string;
  visible: boolean;
  onHide?: () => void;
  onDelete?: () => void;
}

export function TerminalPanel({
  groupJid,
  visible,
  onHide,
  onDelete,
}: TerminalPanelProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef<boolean>(visible);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const connStateRef = useRef<ConnectionState>('idle');
  const syncConnState = (state: ConnectionState) => {
    connStateRef.current = state;
    setConnState(state);
  };

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) return;
    // Delay fit until after the CSS height transition (200ms) completes,
    // otherwise FitAddon computes 0x0 dimensions during the animation.
    const timer = setTimeout(() => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      fitAddonRef.current.fit();
      xtermRef.current.focus();
      if (connStateRef.current === 'connected') {
        const { cols, rows } = xtermRef.current;
        wsManager.send({
          type: 'terminal_resize',
          chatJid: groupJid,
          cols,
          rows,
        });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [visible, groupJid]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.15,
      fontSize: 13,
      fontFamily:
        "'Geist Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      scrollback: 5000,
      convertEol: true,
      allowTransparency: true,
      theme: terminalTheme(),
    });

    // Follow the app's light/dark mode; the canvas background shows through.
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(termRef.current);

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Fit terminal to container — delay to ensure DOM layout is stable
    setTimeout(() => {
      fitAddon.fit();
    }, 100);

    const sendStartTerminal = () => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      wsManager.send({ type: 'terminal_start', chatJid: groupJid, cols, rows });
    };

    const requestStartTerminal = () => {
      syncConnState('connecting');
      if (wsManager.isConnected()) {
        sendStartTerminal();
      } else {
        wsManager.connect();
      }
    };

    // 监听 WebSocket 消息
    const unsubOutput = wsManager.on('terminal_output', (data: any) => {
      if (data.chatJid === groupJid) {
        terminal.write(data.data);
      }
    });

    const unsubStarted = wsManager.on('terminal_started', (data: any) => {
      if (data.chatJid === groupJid) {
        syncConnState('connected');
      }
    });

    const unsubStopped = wsManager.on('terminal_stopped', (data: any) => {
      if (data.chatJid === groupJid) {
        syncConnState('disconnected');
        terminal.write(
          `\r\n\x1b[33m[${data.reason || '终端已断开'}]\x1b[0m\r\n`,
        );
        // Auto-reconnect after unexpected stop (not user-initiated)
        if (data.reason !== '用户关闭终端') {
          terminal.write('\x1b[33m[3 秒后自动重连...]\x1b[0m\r\n');
          setTimeout(() => {
            if (
              connStateRef.current === 'disconnected' &&
              wsManager.isConnected()
            ) {
              requestStartTerminal();
            }
          }, 3000);
        }
      }
    });

    const unsubError = wsManager.on('terminal_error', (data: any) => {
      if (data.chatJid === groupJid) {
        syncConnState('disconnected');
        // 针对工作区未运行/启动中的错误，自动延迟重连
        if (
          data.error?.includes('工作区未运行') ||
          data.error?.includes('工作区启动中')
        ) {
          terminal.write(
            `\r\n\x1b[33m[工作区启动中，5 秒后自动重连...]\x1b[0m\r\n`,
          );
          setTimeout(() => {
            if (
              connStateRef.current === 'disconnected' &&
              wsManager.isConnected()
            ) {
              requestStartTerminal();
            }
          }, 5000);
        } else {
          terminal.write(`\r\n\x1b[31m[错误: ${data.error}]\x1b[0m\r\n`);
        }
      }
    });

    const unsubWsConnected = wsManager.on('connected', () => {
      if (connStateRef.current !== 'connected') {
        syncConnState('connecting');
        sendStartTerminal();
      }
    });

    const unsubWsDisconnected = wsManager.on('disconnected', () => {
      syncConnState('disconnected');
      terminal.write('\r\n\x1b[33m[WebSocket 已断开，等待重连]\x1b[0m\r\n');
    });

    // IME 组合事件处理 —— 防止中文输入法在英文直输模式下产生重复输入
    // xterm.js v6 内部已有 IME 处理，但 macOS 中文 IME 某些边界情况仍会泄漏
    let composing = false;
    const textarea = termRef.current?.querySelector('textarea');
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = () => {
      // 延迟重置，确保 compositionend 后的 onData 事件能正确发送
      setTimeout(() => {
        composing = false;
      }, 50);
    };
    if (textarea) {
      textarea.addEventListener('compositionstart', onCompositionStart);
      textarea.addEventListener('compositionend', onCompositionEnd);
    }

    // 用户输入 → WebSocket（仅在已连接且非 IME 组合状态时发送）
    const onDataDisposable = terminal.onData((data) => {
      if (composing) return;
      if (connStateRef.current === 'connected') {
        wsManager.send({ type: 'terminal_input', chatJid: groupJid, data });
      }
    });

    // ResizeObserver 监听尺寸变化（debounce 防止动画期间 resize 风暴）
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          if (connStateRef.current === 'connected') {
            const { cols, rows } = xtermRef.current;
            wsManager.send({
              type: 'terminal_resize',
              chatJid: groupJid,
              cols,
              rows,
            });
          }
        }
      }, 150);
    });
    resizeObserver.observe(termRef.current);

    // 初次尝试连接；若 WS 未就绪，connected 事件会自动触发 terminal_start
    requestStartTerminal();

    // Cleanup
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompositionStart);
        textarea.removeEventListener('compositionend', onCompositionEnd);
      }
      onDataDisposable.dispose();
      unsubOutput();
      unsubStarted();
      unsubStopped();
      unsubError();
      unsubWsConnected();
      unsubWsDisconnected();
      if (wsManager.isConnected()) {
        wsManager.send({ type: 'terminal_stop', chatJid: groupJid });
      }
      themeObserver.disconnect();
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [groupJid]);

  const status = {
    connected: { label: '已连接', dot: 'bg-success' },
    connecting: { label: '连接中…', dot: 'bg-warning animate-pulse' },
    disconnected: { label: '已断开', dot: 'bg-faint-foreground' },
    idle: { label: '空闲', dot: 'bg-faint-foreground' },
  }[connState];

  return (
    <div className="terminal-panel flex h-full flex-col bg-surface-raised">
      {/* Status bar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-surface-border px-3 text-caption">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', status.dot)}
          />
          <span>{status.label}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {connState === 'disconnected' && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                syncConnState('connecting');
                if (wsManager.isConnected()) {
                  const cols = xtermRef.current?.cols || 80;
                  const rows = xtermRef.current?.rows || 24;
                  wsManager.send({
                    type: 'terminal_start',
                    chatJid: groupJid,
                    cols,
                    rows,
                  });
                } else {
                  wsManager.connect();
                }
              }}
            >
              <RotateCw />
              重新连接
            </Button>
          )}
          {onHide && (
            <IconButton
              label="隐藏终端"
              icon={<EyeOff />}
              size="icon-xs"
              onClick={onHide}
              tooltipSide="top"
              className="text-muted-foreground"
            />
          )}
          {onDelete && (
            <IconButton
              label="删除终端"
              icon={<Trash2 />}
              size="icon-xs"
              onClick={onDelete}
              tooltipSide="top"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            />
          )}
        </div>
      </div>
      {/* Terminal container; padding keeps output off the edges. */}
      <div className="min-h-0 flex-1 px-3 py-2">
        <div ref={termRef} className="h-full w-full overflow-hidden" />
      </div>
    </div>
  );
}
