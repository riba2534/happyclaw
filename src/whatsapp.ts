/**
 * WhatsApp Channel — Skeleton (PR 1 of multi-PR series)
 *
 * 占位骨架：仅暴露与其他 IM 通道一致的工厂函数和接口契约，所有方法均抛出
 * "not implemented yet" 错误。后续 PR 接入 Baileys（@whiskeysockets/baileys）
 * 实现真正的 WhatsApp Web 协议连接、QR 码扫码登录、消息收发、媒体下载等。
 *
 * 设计目标：让 PR 1 通过 typecheck 并且端到端配置流程（保存/加载/启停）能跑通，
 * 即使连接本身永远 false。后续 PR 只需替换 connect()/disconnect()/sendMessage()
 * 等方法的内部实现，不需要再改任何外围接入点（im-manager / im-channel / index.ts
 * / routes / schemas）。
 */
import { logger } from './logger.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WhatsAppConnectionConfig {
  /** Account identifier — currently固定 'default'，未来扩展 multi-account 用 */
  accountId?: string;
  /** Optional phone number hint for display purposes (E.164 format, e.g. +15551234567) */
  phoneNumber?: string;
  /** Auth state directory override; defaults to data/config/user-im/{userId}/whatsapp-auth/ */
  authDir?: string;
}

export interface WhatsAppConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
}

export interface WhatsAppConnection {
  connect(opts: WhatsAppConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(
    chatId: string,
    filePath: string,
    fileName: string,
  ): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
}

const NOT_IMPLEMENTED =
  'WhatsApp channel skeleton only — Baileys integration pending in next PR';

// ─── Factory ────────────────────────────────────────────────────

export function createWhatsAppConnection(
  config: WhatsAppConnectionConfig,
): WhatsAppConnection {
  void config; // suppress unused warning until Baileys impl lands

  return {
    async connect(_opts: WhatsAppConnectOpts): Promise<void> {
      void _opts;
      logger.warn({ feature: 'whatsapp' }, NOT_IMPLEMENTED);
      throw new Error(NOT_IMPLEMENTED);
    },

    async disconnect(): Promise<void> {
      // No-op: nothing to disconnect from skeleton
    },

    async sendMessage(
      chatId: string,
      _text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      void _text;
      void _localImagePaths;
      logger.warn(
        { feature: 'whatsapp', chatId },
        'sendMessage called on WhatsApp skeleton',
      );
      throw new Error(NOT_IMPLEMENTED);
    },

    async sendImage(
      chatId: string,
      _imageBuffer: Buffer,
      _mimeType: string,
      _caption?: string,
      _fileName?: string,
    ): Promise<void> {
      void _imageBuffer;
      void _mimeType;
      void _caption;
      void _fileName;
      logger.warn(
        { feature: 'whatsapp', chatId },
        'sendImage called on WhatsApp skeleton',
      );
      throw new Error(NOT_IMPLEMENTED);
    },

    async sendFile(
      chatId: string,
      _filePath: string,
      _fileName: string,
    ): Promise<void> {
      void _filePath;
      void _fileName;
      logger.warn(
        { feature: 'whatsapp', chatId },
        'sendFile called on WhatsApp skeleton',
      );
      throw new Error(NOT_IMPLEMENTED);
    },

    async sendTyping(_chatId: string, _isTyping: boolean): Promise<void> {
      void _chatId;
      void _isTyping;
      // No-op for skeleton
    },

    isConnected(): boolean {
      return false;
    },
  };
}
