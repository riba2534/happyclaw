import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { EyeOff, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { wsManager } from '../../api/ws';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

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
        wsManager.send({ type: 'terminal_resize', chatJid: groupJid, cols, rows });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [visible, groupJid]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.15,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      scrollback: 5000,
      convertEol: true,
      theme: {
        background: '#1a1b26',
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
      },
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
        terminal.write(`\r\n\x1b[33m[${data.reason || '终端已断开'}]\x1b[0m\r\n`);
        // Auto-reconnect after unexpected stop (not user-initiated)
        if (data.reason !== '用户关闭终端') {
          terminal.write('\x1b[33m[3 秒后自动重连...]\x1b[0m\r\n');
          setTimeout(() => {
            if (connStateRef.current === 'disconnected' && wsManager.isConnected()) {
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
        if (data.error?.includes('工作区未运行') || data.error?.includes('工作区启动中')) {
          terminal.write(`\r\n\x1b[33m[工作区启动中，5 秒后自动重连...]\x1b[0m\r\n`);
          setTimeout(() => {
            if (connStateRef.current === 'disconnected' && wsManager.isConnected()) {
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
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => {
      // 延迟重置，确保 compositionend 后的 onData 事件能正确发送
      setTimeout(() => { composing = false; }, 50);
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
            wsManager.send({ type: 'terminal_resize', chatJid: groupJid, cols, rows });
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
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [groupJid]);

  return (
    <div className="h-full flex flex-col terminal-panel">
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1b26] border-b border-slate-700 text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${
            connState === 'connected' ? 'bg-green-400' :
            connState === 'connecting' ? 'bg-yellow-400 animate-pulse' :
            'bg-muted0'
          }`} />
          <span className="text-muted-foreground/60">
            {connState === 'connected' ? '已连接' :
             connState === 'connecting' ? '连接中...' :
             connState === 'disconnected' ? '已断开' : '空闲'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {connState === 'disconnected' && (
            <button
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
              className="text-primary hover:text-primary/60 transition-colors cursor-pointer"
            >
              重新连接
            </button>
          )}
          {onHide && (
            <button
              onClick={onHide}
              className="p-1 rounded hover:bg-slate-700 text-muted-foreground/60 hover:text-slate-200 transition-colors cursor-pointer"
              aria-label="隐藏终端"
              title="隐藏终端"
            >
              <EyeOff className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-red-900/30 text-muted-foreground/60 hover:text-red-300 transition-colors cursor-pointer"
              aria-label="删除终端"
              title="删除终端"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* Terminal container */}
      <div ref={termRef} className="flex-1 min-h-0 overflow-hidden bg-[#1a1b26]" />
    </div>
  );
}
