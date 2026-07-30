import './load-env.js'; // 必须最先执行：加载 .env 到 process.env，供后续模块（config/web 等）读取
import { ChildProcess, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  MAIN_GROUP_FOLDER,
  CONVERSATION_AGENT_ARCHIVE_DAYS,
  POLL_INTERVAL,
  TIMEZONE,
  isDockerAvailable,
} from './config.js';
import { detectImageMimeType } from './image-detector.js';
import { interruptibleSleep } from './message-notifier.js';
import { createIpcSendDeduplicator } from './ipc-send-dedup.js';
import {
  acknowledgeIpcReplyTurn,
  decideAssistantPrimaryProjection,
  isGenuineReplyResult,
  setIpcReplyInputTurn,
  shouldSkipRetryAfterLateError,
  wasGenuineReplyDeliveredForInput,
  type IpcReplyTurnTracker,
} from './reply-delivery.js';
import {
  ActiveTurnOutputRegistry,
  TurnOutputCoordinator,
  type TurnMessageDeliveryRole,
} from './turn-output-coordinator.js';
import {
  preserveUnacknowledgedProactiveFinal,
  recoverProactiveFinalCandidate,
  type ProactiveFinalFallbackDelivery,
} from './proactive-final-recovery.js';
import {
  resolveHostIpcLogicalChatJid,
  routeHostIpcOutput,
} from './host-ipc-output-router.js';
import {
  buildInterruptedReply,
  buildSteeredReply,
  buildStoppedReply,
  stripRedundantCompletionPreamble,
} from './reply-finalization.js';
export { buildInterruptedReply } from './reply-finalization.js';
import { resolveTurnOutcome } from './turn-outcome.js';
import { finalizeChannelCardAfterDelivery } from './channel-card-finalization.js';
import { resolveContainerOutputInputTurnId } from './channel-output-correlation.js';
import { SteeringTransitionRegistry } from './steering-transition.js';
import { resolveFeishuFollowUpMode } from './follow-up-policy.js';
import { discardStartupTypedIpcDeliveries } from './ipc-delivery-recovery.js';
import {
  DeferredOutOfBandCursorLedger,
  hasEarlierCursorMessage,
  hasUncoveredCursorMessageThrough,
  shouldRecoverPendingHistory,
} from './delivery-cursor.js';
import {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
  cleanupContainerTaskRuntimeEnvDirs,
  runContainerAgent,
  runHostAgent,
  runAgentWithModelFallback,
  willClearSessionOnProviderSwitch,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { resolveRunnerLivenessTimeouts } from './runner-liveness.js';
import { resolveFeishuCliBoundAccountId } from './feishu-cli-runtime.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';
import { PROVIDER_FAILURE_USER_NOTICE } from './provider-failure.js';
import {
  closeDatabase,
  createTask,
  deleteExpiredSessions,
  getExpiredSessionIds,
  deleteTask,
  ensureChatExists,
  ensureUserHomeGroup,
  getAllChats,
  getAllChatJids,
  getAllRegisteredGroups,
  getAllSessions,
  hasContainerModeGroups,
  getAllTasks,
  getDeletedTasks,
  getJidsByFolder,
  getLastGroupSync,
  getRegisteredGroup,
  getAgentBuilderInputMessage,
  getMessageChannelTurnContext,
  getMessage,
  getUserById,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSessionChannelOwner,
  getRouterStateByPrefix,
  deleteRouterState,
  getTaskById,
  getTaskRunById,
  getActiveTaskRunForTask,
  getTaskRunsForTask,
  finalizeDeliveredGroupTaskRun,
  recordGroupWorkspaceProjectionFailureAndFinalize,
  recordTaskRunNotificationReceipt,
  finalizeTaskRunNotificationIfPending,
  type TaskRunAtomicNotificationPayload,
  type TaskRunNotificationPayload,
  type TaskRunNotificationReceipt,
  getUserHomeGroup,
  initDatabase,
  listUsers,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setRouterStateBatch,
  setSessionChannelOwnerOnce,
  setSession,
  deleteSession,
  deleteMessagesForChatJid,
  storeMessageDirect,
  storeScheduledGroupPromptAndCompleteRun,
  storeScheduledGroupWorkspaceResultAndFinalize,
  updateLatestMessageTokenUsage,
  rebuildMessageTokenUsageFromLedger,
  updateChatName,
  updateTask,
  updateTaskWithRevision,
  softDeleteTaskWithRevision,
  restoreTaskWithRevision,
  createAgent,
  getAgent,
  updateAgentStatus,
  updateAgentLastImJid,
  updateAgentInfo,
  deleteAgent,
  archiveInactiveConversationAgents,
  deleteCompletedAgents,
  deleteImGroupRecord,
  getRunningTaskAgentsByChat,
  markRunningTaskAgentsAsError,
  markAllRunningTaskAgentsAsError,
  markStaleSpawnAgentsAsError,
  listActiveConversationAgents,
  getSession,
  getSessionAgentIdentity,
  getAgentProfileForWorkspace,
  getWorkspaceInteractionMode,
  listAgentsByJid,
  getGroupsByOwner,
  getMessagesPage,
  cleanupOldDailyUsage,
  cleanupOldBillingAuditLog,
  getImContextBinding,
  getImContextBindingByRootMessageId,
  upsertImContextBinding,
  touchImContextBindingActivity,
  updateAgentContextInfo,
  backfillEmptyAllowlistsForUser,
  backfillEmptyAllowlistsForChannelAccount,
  getChannelMount,
  migrateAgentProfileAutoCompactWindow,
  getChannelAccount,
  listChannelAccountsForUser,
  listEnabledChannelAccounts,
  updateChannelAccountAuthStatus,
  updateChannelAccountStatus,
  cancelQueuedFollowUp,
  claimNextQueuedFollowUp,
  getQueuedFollowUp,
  getQueuedFollowUpChatJids,
  listQueuedFollowUps,
  moveQueuedFollowUp,
  prioritizeQueuedFollowUp,
  releaseQueuedFollowUp,
  restorePromotingFollowUp,
  setMessageFollowUp,
  updateQueuedFollowUpContent,
} from './db.js';
import {
  createWorkspaceMemory,
  forgetWorkspaceMemory,
  getWorkspaceMemory,
  getWorkspaceMemorySnapshot,
  searchWorkspaceMemory,
  updateWorkspaceMemory,
  WorkspaceMemoryServiceError,
} from './memory-service.js';
import { type WorkspaceMemoryMutationContext } from './memory-store.js';
import {
  isHappyClawBootstrapTurn,
  isHappyClawOwnerProfileRuntimeStructurallyEligible,
} from './happyclaw-bootstrap.js';
import {
  acknowledgeHappyClawOwnerIntroduction,
  claimHappyClawOwnerIntroduction,
  clearHappyClawOwnerPreferredAddress,
  getHappyClawOwnerProfileProjection,
  OwnerProfileStoreError,
  setHappyClawOwnerPreferredAddress,
  skipHappyClawOwnerIntroduction,
  type HappyClawOwnerProfileProjection,
} from './owner-profile-store.js';
import {
  buildWorkspaceMemoryUpdateInput,
  workspaceMemoryWriteRejection,
} from './workspace-memory-ipc.js';
import {
  grantWorkspaceMemoryTurnToCurrentRunner,
  verifyAndConsumeWorkspaceMemoryMutation,
  verifyWorkspaceMemoryCapability,
} from './workspace-memory-capability.js';
import {
  buildSessionMountUpdate,
  buildDetachedWorkspaceUpdate,
  buildNativeThreadWorkspaceUpdate,
  buildWorkspaceMountUpdate,
  hasRemainingThreadMapMount,
  isNativeContextContainer,
  resolveChannelMountTarget,
  restoreDefaultChannelMount,
  upgradeNativeContextChannelMount,
} from './channel-mount-service.js';
import { isThreadMapCapableChat } from './im-channel-capabilities.js';
// feishu.js deprecated exports are no longer needed; imManager handles all connections
import { imManager } from './im-manager.js';
import {
  reconcileChannelReliabilityOnStartup,
  startChannelReliabilityRecoveryLoop,
} from './channel-reliability-recovery.js';
import {
  deliverChannelOutboxItem,
  reconcileChannelOutboxDeliveries,
} from './channel-outbox-delivery.js';
import {
  ActiveChannelOutboxScopeRegistry,
  semanticChannelOutboxIdentity,
  stableChannelOutboxOrdinal,
  syntheticChannelProviderAck,
  type ActiveChannelOutboxScope,
} from './channel-outbox-runtime-scope.js';
import {
  cleanupChannelReliability,
  getChannelTurnRun,
  getUncertainChannelOutboxForTurn,
  CHANNEL_RELIABILITY_TERMINAL_STATUSES,
} from './channel-reliability-store.js';
import { ChannelTurnRuntime } from './channel-turn-runtime.js';
import { resolveStickyChannelOwner } from './channel-session-owner.js';
import { migrateLegacyWhatsAppAuthDir } from './whatsapp.js';
import {
  getChannelType,
  extractChatId,
  type StreamingSession,
  type ChannelMessageDeliveryOptions,
} from './im-channel.js';
import {
  PROACTIVE_TAIL_INTERRUPTION_NOTICE,
  buildInteractionTextOutboxPayload,
  isProactiveControlPlaneSuccess,
  publishesFrameworkAnswer,
  resolveFrozenIpcInteractionMode,
  resolveRuntimeInteractionMode,
  shouldBroadcastSdkStreamEvent,
  shouldResolveFrameworkPrimaryAnswer,
  shouldSendProactiveTailInterruptionNotice,
  usesNativeMessagePresentation,
} from './workspace-interaction-runtime.js';
import {
  channelConversationJid,
  parseChannelAddress,
} from './channel-address.js';
import {
  matchesChannelAccountAuthorization,
  matchesChannelPairTarget,
} from './channel-admission.js';
import {
  registerStreamingSession,
  unregisterStreamingSession,
  hasActiveStreamingSession,
  abortAllStreamingSessions,
  registerMessageIdMapping,
  getStreamingSession,
  StreamingCardController,
} from './feishu-streaming-card.js';
import {
  formatContextMessages,
  formatWorkspaceList,
  formatSystemStatus,
  resolveBoundChatTarget,
  resolveLocationInfo,
  checkImOwnerCommand,
  isDirectMessageJid,
  OWNER_REQUIRED_IM_COMMANDS,
  type WorkspaceInfo,
} from './im-command-utils.js';
import {
  extractLastTaskId,
  broadcastToOwnerIMChannels as broadcastToOwnerIMChannelsPure,
  resolveBroadcastFolder,
  resolveTaskRoutingDecision,
} from './task-routing.js';
import {
  canDeleteAcknowledgedIpcSource,
  extractDurableTaskRunIdFromNamespace,
  tryCleanupCompletedIsolatedTaskRunIpc,
} from './isolated-task-ipc.js';
import {
  buildFailedTaskImageNotification,
  settleTaskNotificationDeliveries,
  type TaskNotificationDeliveryAttempt,
} from './task-notification.js';
import { resolveImGroupDefaults } from './im-group-defaults.js';
import {
  applyAutoIsolateContextForGroups,
  getUserContextIsolationConfig,
} from './im-context-isolation.js';
import { canSendCrossGroupMessage as canSendCrossGroupMessagePure } from './cross-group-acl.js';
import {
  canIpcActorAccessGroup,
  canIpcActorManageTask,
  type TaskAclDeps,
} from './task-acl.js';
import {
  resolveIpcDeliveryTargetGroup,
  resolveIpcImRoute,
} from './ipc-delivery-routing.js';
import {
  invalidateSessionCache,
  getWebDeps,
  canAccessGroup,
} from './web-context.js';
import { resolveEffectiveAgentProfile } from './agent-profile-runtime.js';
import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  getAgentBuilderRuntimeRejection,
  isAgentBuilderOwnerInput,
  isOwnerProfileOwnerInput,
  OWNER_PROFILE_TRUSTED_CLAIM_SOURCES,
  ownerImIdFromDirectConversationJid,
  resolveTrustedDirectOwnerUpgrade,
} from './agent-builder-turn-auth.js';
import {
  ActiveChannelTurnRegistry,
  channelTurnScope,
} from './channel-turn-registry.js';
import type {
  FeishuCapabilityOperation,
  FeishuCapabilityRequest,
} from './feishu-capability.js';
import { isFeishuCapabilityMutation } from './feishu-capability.js';
import { deliverFeishuCapabilityMutation } from './feishu-capability-outbox.js';
import {
  discardPreparedAgentDraft,
  getAgentCapabilityCatalogForBuilder,
  getAgentBuilderDraftForBuilder,
  getAgentProfileForBuilder,
  listAgentProfilesForBuilder,
  prepareAgentBuilderDraft,
  publishAgentBuilderDraft,
  type AgentBuilderActor,
} from './agent-builder.js';
import {
  loadChannelAccountSecret,
  saveChannelAccountSecret,
  type ChannelAccountSecret,
} from './channel-account-secrets.js';
import {
  ensureLegacyDefaultChannelAccount,
  syncDefaultChannelAccountCredentials,
} from './channel-account-migration.js';
import {
  applyChannelAccountRegistrationFallback,
  resolveChannelAccountFallbackWorkspace,
} from './channel-account-routing.js';
import { testChannelAccountCredentials } from './channel-account-connectivity.js';
import {
  buildAgentProfilePrompt,
  hasAgentProfilePrompts,
} from './agent-profile-prompts.js';
import {
  getFeishuProviderConfigWithSource,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  getUserFeishuConfig,
  getUserTelegramConfig,
  getUserQQConfig,
  getUserWeChatConfig,
  getUserDingTalkConfig,
  getUserDiscordConfig,
  getUserWhatsAppConfig,
  getSystemSettings,
  getLegacySystemAutoCompactWindow,
  saveUserFeishuConfig,
  saveFeishuOwnerOpenId,
  saveUserTelegramConfig,
  saveUserWeChatConfig,
  updateAllSessionCredentials,
} from './runtime-config.js';
import {
  MAX_TASK_PROMPT_LENGTH,
  MAX_TASK_SCRIPT_COMMAND_LENGTH,
} from './schemas.js';
import type {
  FeishuConnectConfig,
  TelegramConnectConfig,
  QQConnectConfig,
  WeChatConnectConfig,
  DingTalkConnectConfig,
  DiscordConnectConfig,
  WhatsAppConnectConfig,
} from './im-manager.js';
import {
  GroupQueue,
  type IpcDeliveryReceipt,
  type IpcDeliveryTarget,
  type MessageRetrySnapshot,
  type IpcPrePublishAdmission,
} from './group-queue.js';
import {
  startSchedulerLoop,
  stopSchedulerLoop,
  triggerTaskNow,
  cancelTaskRunNow,
  waitForTaskRunsToStop,
  notifyTaskSchedulerChanged,
  computeNextRunForSchedule,
  computeNextRunForTaskResume,
  getRunningTaskIds,
  formatScheduledTaskWorkspaceResult,
  resolveScheduledGroupRunsForOutput,
  resolveTerminalScheduledGroupPromptRun,
  scheduledGroupPromptMessageId,
} from './task-scheduler.js';
import { getMergedTaskRunHistory } from './task-run-history.js';
import { findDuplicateActiveAgentTask } from './task-definition-fingerprint.js';
import {
  getScriptTaskHostExecutionError,
  resolveTaskExecutionModeForTarget,
  SCRIPT_TASK_HOST_REQUIRED_ERROR,
} from './script-task-policy.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
  checkAndExpireSubscriptions,
  isBillingEnabled,
  getUserConcurrentContainerLimit,
  reconcileMonthlyUsage,
} from './billing.js';
import { recordUsageEvent } from './usage-service.js';
import {
  AgentStatus,
  AgentProfile,
  ChannelMessageMeta,
  ChannelTurnContext,
  MessageCursor,
  NewMessage,
  RegisteredGroup,
  StreamEvent,
  SubAgent,
  ChannelAccount,
  FollowUpMode,
  QueuedFollowUp,
  FollowUpActionResult,
  MessageSourceKind,
  MessageFinalizationReason,
  TaskRun,
  TaskRunStatus,
} from './types.js';
import {
  buildNativeThreadRouteJid,
  resolveNativeThreadContext,
  type NativeThreadContext,
} from './channel-native-context.js';
import {
  resolveFeishuConversationPlan,
  requiresMention as feishuRequiresMention,
  type ActiveFeishuContext,
  type FeishuConversationPlan,
} from './feishu-conversation-policy.js';
import {
  effectiveAudienceMode,
  isSenderAllowedByAudience,
  isUnknownFeishuSenderAllowed,
} from './im-audience-policy.js';
import { logger } from './logger.js';
import { resolveTaskOwner } from './task-utils.js';
import { checkOwnerActive } from './owner-gate.js';
import {
  canExecuteOnHost,
  HOST_EXECUTION_FORBIDDEN_ERROR,
} from './host-execution-policy.js';
import {
  parseContainerConfig,
  validateAdditionalMountsStrict,
} from './mount-security.js';
import {
  ensureAgentDirectories,
  isRealpathInside,
  isSystemMaintenanceNoise,
  stripAgentInternalTags,
  stripVirtualJidSuffix,
} from './utils.js';
import { normalizeImageAttachment } from './message-attachments.js';
import {
  startWebServer,
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  broadcastAgentRemoved,
  broadcastTitleGenerating,
  broadcastGroupCreated,
  broadcastBillingUpdate,
  broadcastWhatsAppStatus,
  broadcastChannelAccountStatus,
  shutdownTerminals,
  shutdownWebServer,
  getActiveStreamingTexts,
  clearStreamingSnapshot,
  broadcastFollowUpUpdate,
} from './web.js';
import { installSkillForUser, deleteSkillForUser } from './routes/skills.js';
import { verifyPairingCode } from './telegram-pairing.js';
import { sdkQuery } from './sdk-query.js';
import { executeSessionReset } from './commands.js';
import {
  claimOwner,
  claimOwnerFromMention,
  releaseOwner,
  addToAllowlist,
  removeFromAllowlist,
  persistGroupUpdate,
} from './group-owner.js';
import { buildRecentConversationHistoryContext } from './conversation-history.js';
import {
  collectKnownReferenceAttachmentIndexes,
  collectReferencedMessageIds,
  formatMessages,
} from './message-prompt.js';
export { escapeXml, formatMessages } from './message-prompt.js';
import { scanHostMarketplaces } from './plugin-importer.js';
import { expandMessagesIfNeeded } from './plugin-expander-core.js';
import { makeExpandContext } from './plugin-expander-context.js';
import type { ExpandContext } from './plugin-expander-context.js';
import { persistPluginExpansion } from './plugin-expander-store.js';

// Set timezone so all child processes (host agents, containers) inherit it
process.env.TZ = process.env.TZ || TIMEZONE;

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const execFileAsync = promisify(execFile);
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;
const OOM_EXIT_RE = /code 137/;

function buildWebTraceUrl(
  folder: string | undefined,
  turnId?: string,
): string | null {
  const base =
    process.env.HAPPYCLAW_WEB_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.WEB_BASE_URL;
  if (!base || !folder) return null;
  const url = new URL(`/chat/${encodeURIComponent(folder)}`, base);
  if (turnId) url.searchParams.set('turn', turnId);
  url.searchParams.set('trace', '1');
  return url.toString();
}

/**
 * Feed a stream event into a Feishu streaming card controller.
 * Centralizes the event → card mapping for both main and sub-agent handlers.
 */
export function feedStreamEventToCard(
  session: StreamingSession,
  se: StreamEvent,
  accumulatedText: string,
  traceUrl?: string | null,
): void {
  if (traceUrl && session instanceof StreamingCardController) {
    session.setTraceUrl(traceUrl);
  }
  switch (se.eventType) {
    case 'text_delta':
      if (se.text) session.append(accumulatedText);
      break;
    case 'thinking_delta':
      // 子 Agent（SDK Task）的思考带 parentToolUseId，在 task 面板独立呈现；
      // 混入主卡思考面板会反复重新激活 thinking 态并污染内容（Web 端
      // applyStreamEvent 与服务端快照均已隔离，此处对齐）。
      if (se.parentToolUseId) break;
      if (se.text) {
        session.appendThinking(se.text);
      } else if (!accumulatedText) {
        // Only call setThinking() when no text was appended
        // (appendThinking already sets thinking=true and triggers card creation)
        session.setThinking();
      }
      break;
    case 'tool_use_start':
      if (se.toolUseId && se.toolName) {
        // Tool-only/model-reasoning turns may legally emit no text_delta for
        // minutes. Create the primary projection from deterministic host
        // activity instead of leaving the user with no card until Result.
        session.setThinking();
        session.startTool(se.toolUseId, se.toolName);
        // Feishu streaming card wants richer metadata (skillName / nested /
        // raw toolInput for AskUserQuestion). Attach separately so the
        // StreamingSession union's common signature stays tight.
        if (
          session instanceof StreamingCardController &&
          (se.skillName || se.isNested || se.toolInput)
        ) {
          session.setToolMeta(se.toolUseId, {
            skillName: se.skillName,
            isNested: se.isNested,
            toolInput: se.toolInput,
          });
        }
        const label = se.skillName ? `技能 ${se.skillName}` : se.toolName;
        session.setSystemStatus(`正在使用 ${label}…`);
        session.pushRecentEvent(`🔄 ${label}`);
      }
      break;
    case 'tool_use_end':
      if (se.toolUseId) {
        const info = session.getToolInfo(se.toolUseId);
        session.endTool(se.toolUseId, false);
        if (info) session.pushRecentEvent(`✅ ${info.name}`);
      }
      break;
    case 'tool_result': {
      // Surface the (truncated + sanitized) tool output in the timeline so the
      // card shows *what* a tool returned, aligning with Claude Code's trace.
      if (se.toolResult) {
        const resultInfo = se.toolUseId
          ? session.getToolInfo(se.toolUseId)
          : undefined;
        const toolLabel = resultInfo?.name ? `\`${resultInfo.name}\` ` : '';
        session.pushRecentEvent(
          `↳ <font color='grey'>结果</font> ${toolLabel}${se.toolResult.slice(0, 120)}`,
        );
      }
      break;
    }
    case 'tool_progress':
      if (se.toolUseId && se.toolInputSummary) {
        session.updateToolSummary(se.toolUseId, se.toolInputSummary);
      }
      // AskUserQuestion 等工具的结构化输入（questions/options）经 tool_progress
      // 的 toolInput 字段下发（非 toolInputSummary，因流式 tool_use_start 时 input 恒空）。
      // 写入 tc.toolInput 以驱动飞书 ASK 面板渲染，与 Web 端 applyStreamEvent 对齐。
      if (
        se.toolUseId &&
        se.toolInput &&
        session instanceof StreamingCardController
      ) {
        session.setToolMeta(se.toolUseId, { toolInput: se.toolInput });
      }
      break;
    case 'status':
      if (se.statusText && se.statusText !== 'interrupted') {
        session.setThinking();
        session.setSystemStatus(
          se.statusText === 'requesting'
            ? '正在处理…'
            : se.statusText === 'compacting'
              ? '正在整理上下文…'
              : se.statusText,
        );
      }
      break;
    case 'hook_started':
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'hook_response':
      if (se.hookName) {
        session.pushRecentEvent(`✅ Hook: ${se.hookName}`);
      }
      session.setHook(null);
      break;
    case 'todo_update':
      if (se.todos) session.setTodos(se.todos);
      break;
    case 'task_start':
      if (se.toolUseId) {
        session.setThinking();
        const label = se.taskDescription
          ? `Task: ${se.taskDescription.slice(0, 40)}`
          : 'Task';
        if (session instanceof StreamingCardController) {
          session.updateTask(se.toolUseId, {
            title: se.taskDescription || se.toolInputSummary || 'Task',
            status: 'running',
            subagentType: se.subagentType,
            summary: se.summary,
          });
        }
        session.startTool(se.toolUseId, label);
        session.setSystemStatus(
          se.taskDescription
            ? `正在执行任务：${se.taskDescription.slice(0, 80)}`
            : '正在执行子任务…',
        );
        session.pushRecentEvent(`🚀 ${label}`);
      }
      break;
    case 'task_progress': {
      const id = se.toolUseId || se.taskId;
      if (id && session instanceof StreamingCardController) {
        session.updateTask(id, {
          title: se.taskDescription || 'Task',
          status: 'running',
          subagentType: se.subagentType,
          lastToolName: se.lastToolName,
          summary: se.summary || se.taskSummary,
        });
      }
      if (se.summary)
        session.pushRecentEvent(`🔄 Task: ${se.summary.slice(0, 60)}`);
      break;
    }
    case 'task_updated': {
      const id = se.toolUseId || se.taskId;
      if (id && session instanceof StreamingCardController) {
        const patchStatus = se.taskPatch?.status;
        session.updateTask(id, {
          status:
            patchStatus === 'completed'
              ? 'completed'
              : patchStatus === 'failed' || patchStatus === 'killed'
                ? 'error'
                : se.taskPatch?.is_backgrounded
                  ? 'backgrounded'
                  : 'running',
          summary:
            se.summary || se.taskPatch?.description || se.taskPatch?.error,
        });
      }
      break;
    }
    case 'task_notification':
      if (se.toolUseId || se.taskId) {
        const id = se.toolUseId || se.taskId || '';
        if (session instanceof StreamingCardController) {
          session.updateTask(id, {
            status: se.taskStatus === 'completed' ? 'completed' : 'error',
            summary: se.taskSummary || se.summary,
          });
        }
        session.endTool(id, false);
        const label = se.taskSummary
          ? `Task: ${se.taskSummary.slice(0, 40)}`
          : 'Task 完成';
        session.pushRecentEvent(`✅ ${label}`);
      }
      break;
    case 'hook_progress':
      // Update hook state (no card push needed — card already shows hook indicator)
      session.setHook({
        hookName: se.hookName || '',
        hookEvent: se.hookEvent || '',
      });
      break;
    case 'usage':
      if (se.usage) session.patchUsageNote(se.usage);
      break;
    case 'permission_denied': {
      // A denied tool call is a real signal (the agent wanted to do something
      // it wasn't allowed to) — render it in red so it stands out from the
      // grey routine-event stream instead of being buried as plain text.
      const pd = se.permissionDenied;
      const toolName = pd?.toolName || se.toolName || '';
      const reason = pd?.reason || pd?.message || se.summary || '';
      const toolPart = toolName ? ` \`${toolName}\`` : '';
      const reasonPart = reason
        ? ` <font color='grey'>${reason.slice(0, 80)}</font>`
        : '';
      session.pushRecentEvent(
        `🚫 <text_tag color='red'>权限拒绝</text_tag>${toolPart}${reasonPart}`,
      );
      break;
    }
    case 'memory_recall':
    case 'compact_boundary':
    case 'notification':
    case 'prompt_suggestion':
      if (se.summary || se.title) {
        // memory_recall / compact_boundary carry the matched memory or the
        // pre-compaction summary in `detail`; surface it (clamped) after the
        // headline so the runtime trace shows *what* was recalled/compacted,
        // not just that it happened.
        const detail = se.detail
          ? ` <font color='grey'>${se.detail.slice(0, 120)}</font>`
          : '';
        session.pushRecentEvent(
          `${se.title || se.eventType}: ${(se.summary || '').slice(0, 80)}${detail}`,
        );
      }
      if (se.eventType === 'compact_boundary') {
        session.setSystemStatus(se.summary || '上下文已压缩');
      }
      break;
    case 'context_audit':
      // Context audits describe HappyClaw/Claude runtime wiring. Keep them in
      // service logs for operators, but never leak framework internals into a
      // user's conversation or streaming card.
      if (se.contextAudit?.warnings?.length) {
        logger.warn(
          { warnings: se.contextAudit.warnings },
          'Agent context audit warning',
        );
      }
      break;
    case 'raw_sdk_event':
      if (se.displayLevel === 'primary') {
        session.pushRecentEvent(
          `${se.title || se.rawType || 'SDK'}: ${(se.summary || '').slice(0, 80)}`,
        );
      }
      break;
    case 'init':
      // Internal signal, no card display needed
      break;
  }
}

let globalMessageCursor: MessageCursor = { timestamp: '', id: '' };
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, MessageCursor> = {};
// Recovery-safe cursor: only advances when an agent actually finishes processing.
// recoverPendingMessages() uses this to detect IPC-injected but unprocessed messages.
let lastCommittedCursor: Record<string, MessageCursor> = {};
const deferredOutOfBandCursors = new DeferredOutOfBandCursorLedger();
const startupRecoveredDeliveryJids = new Set<string>();

/** Set both cursors directly (no max-merge) and persist. */
function setCursors(jid: string, cursor: MessageCursor): void {
  lastAgentTimestamp[jid] = cursor;
  lastCommittedCursor[jid] = cursor;
  saveState();
}

/**
 * Advance only the next-pull cursor (lastAgentTimestamp) so the next poll
 * skips this message; lastCommittedCursor stays put so recovery still
 * detects unprocessed earlier messages on crash.
 *
 * Use for plugin-expander system replies that are delivered out-of-band
 * (no agent involvement) when the same batch still has earlier user
 * messages destined for the agent. Without this, a crash between the
 * reply commit and the agent finishing processing of the earlier
 * messages would lose them (#18 P2-bug-2).
 *
 * Comparison uses lexicographic (timestamp, id) via `isCursorAfter` —
 * `getMessagesSince` sorts by `(timestamp, id)` so two messages with the
 * same timestamp must be ordered by id. Comparing on timestamp alone
 * could regress the cursor to an earlier id when the later id has
 * already been processed (#20 P2-3, #24 round-16 P2-2).
 */
function advanceNextPullCursorOnly(
  jid: string,
  candidate: MessageCursor,
): void {
  const current = lastAgentTimestamp[jid];
  const target =
    current && isCursorAfter(current, candidate) ? current : candidate;
  lastAgentTimestamp[jid] = target;
  saveState();
}

/**
 * Advance cursors to `candidate`, never regressing behind existing position.
 *
 * Comparison uses lexicographic (timestamp, id) via `isCursorAfter` so
 * mixed batches with same-timestamp ids cannot regress the cursor (#24
 * round-16 P2-2). Pre-fix, only timestamps were compared, so a `/cmd`
 * reply that ran `setCursors` to (T,m2) followed by the agent processing
 * a plain m1 with the same timestamp T would call `advanceCursors(T,m1)`
 * → cursor regressed to m1 → next poll re-read m2 and reply re-fired.
 */
function advanceCursors(jid: string, candidate: MessageCursor): void {
  const currentPull = lastAgentTimestamp[jid];
  lastAgentTimestamp[jid] =
    currentPull && isCursorAfter(currentPull, candidate)
      ? currentPull
      : candidate;
  const currentCommitted = lastCommittedCursor[jid];
  lastCommittedCursor[jid] =
    currentCommitted && isCursorAfter(currentCommitted, candidate)
      ? currentCommitted
      : candidate;
  saveState();
}

function rewindNextPullCursorToCommitted(jid: string): void {
  lastAgentTimestamp[jid] = lastCommittedCursor[jid] || EMPTY_CURSOR;
  saveState();
}

function commitIpcDeliveryReceipts(receipts: IpcDeliveryReceipt[]): void {
  const touchedJids = new Set<string>();
  for (const receipt of receipts) {
    advanceCursors(receipt.chatJid, receipt.cursor);
    touchedJids.add(receipt.chatJid);
  }
  for (const jid of touchedJids) {
    flushDeferredOutOfBandMessages(jid);
  }
}

function hasEarlierPendingMessage(
  jid: string,
  candidate: MessageCursor,
): boolean {
  const sinceCursor = lastCommittedCursor[jid] || EMPTY_CURSOR;
  return hasEarlierCursorMessage(getMessagesSince(jid, sinceCursor), candidate);
}

function createIpcDeliveryTarget(
  chatJid: string,
  messages: Array<{
    timestamp: string;
    id: string;
    source_jid?: string;
    chat_jid?: string;
  }>,
): IpcDeliveryTarget | undefined {
  if (messages.length === 0) return undefined;
  const unique = new Map<
    string,
    { timestamp: string; id: string; sourceJid?: string }
  >();
  for (const message of messages) {
    const candidateSourceJid = message.source_jid ?? message.chat_jid;
    const cursor = {
      timestamp: message.timestamp,
      id: message.id,
      ...(candidateSourceJid && getChannelType(candidateSourceJid)
        ? { sourceJid: candidateSourceJid }
        : {}),
    };
    unique.set(`${cursor.timestamp}\u0000${cursor.id}`, cursor);
  }
  const coveredCursors = [...unique.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  return {
    chatJid,
    coveredCursors,
    cursor: coveredCursors[coveredCursors.length - 1],
  };
}

function hasUncoveredPendingMessage(receipt: IpcDeliveryReceipt): boolean {
  const sinceCursor = lastCommittedCursor[receipt.chatJid] || EMPTY_CURSOR;
  const covered =
    receipt.coveredCursors && receipt.coveredCursors.length > 0
      ? receipt.coveredCursors
      : [receipt.cursor];
  return hasUncoveredCursorMessageThrough(
    getMessagesSince(receipt.chatJid, sinceCursor),
    receipt.cursor,
    covered,
  );
}

/** Complete an out-of-band reply/drop without crossing earlier work that an
 * active runner accepted but has not receipted yet. */
function completeOutOfBandMessage(jid: string, candidate: MessageCursor): void {
  if (hasEarlierPendingMessage(jid, candidate)) {
    advanceNextPullCursorOnly(jid, candidate);
    deferredOutOfBandCursors.defer(jid, candidate);
  } else {
    advanceCursors(jid, candidate);
    flushDeferredOutOfBandMessages(jid);
    flushAcknowledgedIpcForJid(jid);
  }
}

function completeOutOfBandMessages(
  jid: string,
  messages: Array<{ timestamp: string; id: string }>,
): void {
  const ordered = [...messages].sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.id.localeCompare(b.id)
      : a.timestamp.localeCompare(b.timestamp),
  );
  for (const message of ordered) {
    completeOutOfBandMessage(jid, {
      timestamp: message.timestamp,
      id: message.id,
    });
  }
}

function flushDeferredOutOfBandMessages(jid: string): void {
  deferredOutOfBandCursors.flush(
    jid,
    (cursor) => hasEarlierPendingMessage(jid, cursor),
    (cursor) => advanceCursors(jid, cursor),
  );
}

function flushAcknowledgedIpcForJid(jid: string): void {
  queue.flushAcknowledgedIpcDeliveries(jid, commitIpcDeliveryReceipts);
}

function clearPersistedIpcDeliveriesForChats(chatJids: Set<string>): number {
  if (chatJids.size === 0) return 0;
  const ipcRoot = path.join(DATA_DIR, 'ipc');
  let removed = 0;
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filepath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tasks-run') continue;
        visit(filepath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(fs.readFileSync(filepath, 'utf8')) as {
          receipt?: { chatJid?: unknown };
        };
        const chatJid = payload.receipt?.chatJid;
        if (typeof chatJid === 'string' && chatJids.has(chatJid)) {
          fs.unlinkSync(filepath);
          removed++;
        }
      } catch (err) {
        logger.warn(
          { filepath, err },
          'Failed to inspect persisted IPC delivery during recovery',
        );
      }
    }
  };
  visit(ipcRoot);
  return removed;
}
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let shuttingDown = false;

// ── IPC Watcher Manager (event-driven fs.watch + fallback polling) ──

class IpcWatcherManager {
  private watchers = new Map<
    string,
    { watchers: fs.FSWatcher[]; refCount: number }
  >();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processingFolders = new Set<string>();
  private pendingReprocess = new Set<string>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private processGroupFn: ((folder: string) => Promise<void>) | null = null;
  private processFullFn: (() => Promise<void>) | null = null;

  /** Bind the per-group and full-scan processing functions (set once from startIpcWatcher). */
  bind(
    processGroup: (folder: string) => Promise<void>,
    processFull: () => Promise<void>,
  ): void {
    this.processGroupFn = processGroup;
    this.processFullFn = processFull;
  }

  /** Start watching a group's IPC directories. Called when a container/process starts. */
  watchGroup(folder: string): void {
    const existing = this.watchers.get(folder);
    if (existing) {
      existing.refCount++;
      return;
    }

    const groupIpcRoot = path.join(DATA_DIR, 'ipc', folder);
    const dirsToWatch = [
      path.join(groupIpcRoot, 'messages'),
      path.join(groupIpcRoot, 'tasks'),
    ];

    const folderWatchers: fs.FSWatcher[] = [];
    for (const dir of dirsToWatch) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Listen to all event types — 'rename' covers atomic writes on Linux,
        // but Docker bind mounts (macOS virtiofs) may emit 'change' instead.
        const w = fs.watch(dir, () => {
          this.debouncedProcess(folder);
        });
        w.on('error', () => {
          // Watcher error — fallback polling will handle it
        });
        folderWatchers.push(w);
      } catch {
        // Watch failed — fallback polling will handle it
      }
    }
    this.watchers.set(folder, { watchers: folderWatchers, refCount: 1 });
  }

  /** Stop watching a group's IPC directories. Called when a container/process stops. */
  unwatchGroup(folder: string): void {
    const entry = this.watchers.get(folder);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;

    for (const w of entry.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers.delete(folder);
    const timer = this.debounceTimers.get(folder);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(folder);
    }
  }

  private debouncedProcess(folder: string): void {
    const existing = this.debounceTimers.get(folder);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        // Skip if a previous processGroupIpc call for this folder is still running;
        // the pending flag ensures we re-process after the current run finishes.
        if (this.processingFolders.has(folder)) {
          this.pendingReprocess.add(folder);
          return;
        }
        this.processingFolders.add(folder);
        this.processGroupFn?.(folder)
          .catch((err) => {
            logger.error({ err, folder }, 'Error processing IPC for group');
          })
          .finally(() => {
            this.processingFolders.delete(folder);
            // Files may have arrived during processing — run once more
            if (
              this.pendingReprocess.delete(folder) &&
              this.watchers.has(folder)
            ) {
              this.debouncedProcess(folder);
            }
          });
      }, 100),
    );
  }

  /** Trigger processing for a folder through the concurrency guard. */
  triggerProcess(folder: string): void {
    this.debouncedProcess(folder);
  }

  /** Start fallback polling (every 5s) as safety net for inotify failures. */
  startFallback(): void {
    this.fallbackTimer = setInterval(() => {
      if (shuttingDown) return;
      this.processFullFn?.().catch((err) => {
        logger.error({ err }, 'Error in IPC fallback scan');
      });
    }, 5000);
    this.fallbackTimer.unref(); // Don't prevent process from naturally exiting
  }

  /** Close all watchers and timers. */
  closeAll(): void {
    for (const [, entry] of this.watchers) {
      for (const w of entry.watchers) {
        try {
          w.close();
        } catch {}
      }
    }
    this.watchers.clear();
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}

let ipcWatcherManager: IpcWatcherManager | null = null;
/** JIDs already persisted by the shutdown handler — prevents finally blocks from duplicating. */
const shutdownSavedJids = new Set<string>();

const queue = new GroupQueue();
const EMPTY_CURSOR: MessageCursor = { timestamp: '', id: '' };
const terminalWarmupInFlight = new Set<string>();
const STUCK_RUNNER_CHECK_INTERVAL_POLLS = 15;
const STUCK_RUNNER_IDLE_MS = 3 * 60 * 1000;
let stuckRunnerCheckCounter = 0;

// OOM auto-recovery: track consecutive OOM (exit code 137) exits per folder.
// After OOM_AUTO_RESET_THRESHOLD consecutive OOMs, auto-clear the session.
const consecutiveOomExits: Record<string, number> = {};
const OOM_AUTO_RESET_THRESHOLD = 2;

// Per-folder reply route updater: lets sendMessage callers update the
// reply routing of a running processGroupMessages without killing the process.
// Key is group folder (one active processGroupMessages per folder).
type ReplyRouteUpdater = (
  newSourceJid: string | null,
  inputTurnId?: string,
  inputCursor?: MessageCursor,
) => Promise<void>;
const activeRouteUpdaters = new Map<string, ReplyRouteUpdater>();
type ReplyRouteAdmission = (
  sourceJid: string | null,
  inputTurnId: string,
  inputCursor?: MessageCursor,
  coveredInputs?: Array<{ id: string; sourceJid?: string }>,
) => IpcPrePublishAdmission | false;
const activeRouteAdmissions = new Map<string, ReplyRouteAdmission>();

function invokeActiveRouteAdmission(
  folder: string,
  sourceJid: string | null,
  receipt: IpcDeliveryReceipt | undefined,
  runtimeAgentId?: string,
): IpcPrePublishAdmission | false {
  if (!receipt) return false;
  const admission = activeRouteAdmissions.get(
    channelTurnScope(folder, runtimeAgentId),
  );
  return admission
    ? admission(
        sourceJid,
        receipt.deliveryId,
        receipt.cursor,
        (receipt.coveredCursors ?? [receipt.cursor]).map((cursor) => ({
          id: cursor.id,
          sourceJid: cursor.sourceJid,
        })),
      )
    : false;
}

function invokeActiveRouteUpdater(
  folder: string,
  sourceJid: string | null,
  inputTurnId?: string,
  inputCursor?: MessageCursor,
): void {
  const updater = activeRouteUpdaters.get(folder);
  if (!updater) return;
  void updater(sourceJid, inputTurnId, inputCursor).catch((error) => {
    logger.error(
      { error, folder, sourceJid, inputTurnId },
      'Active reply-route update failed',
    );
  });
}

// Per-folder IM reply route: tracks the current replySourceImJid for each
// running processGroupMessages.  IPC watcher reads this to forward send_message
// outputs to the correct IM channel (the running session holds the truth).
const activeImReplyRoutes = new Map<string, string | null>();

// Exact active-turn trackers shared with the independent IPC watcher. Keeping
// only the currently running object avoids stale timestamps/message-id reuse
// across later turns and sibling JIDs that share one folder.
const activeIpcReplyTurnTrackers = new Map<string, IpcReplyTurnTracker>();

// Foreground send_message(progress/final) joins the one host-owned primary
// reply instead of creating an independent provider message. Bindings are
// exact to (workspace/agent scope, immutable input turn).
// Internal runaway-loop fuse, deliberately not configurable. It is a process
// safety invariant rather than a product policy or quota for the model to spend.
const MAX_REPLIES_PER_TURN = 20;
const activeTurnOutputs = new ActiveTurnOutputRegistry(MAX_REPLIES_PER_TURN);

/**
 * Per-turn reply fuse shared by every user-visible IPC delivery path.
 *
 * `send_message`, `send_image`, `send_file` and `feishu_send_card` all spend
 * the same budget through `recordDeliveredUtterance`, so they must all consult
 * it before delivering. Gating only one of them lets the unchecked paths drain
 * the budget silently and then refuse the single path that does check.
 *
 * A delivery without an `inputTurnId` is never blocked: it is not recorded
 * against a turn either, so it spends nothing.
 */
function canDeliverTurnUtterance(
  sourceGroup: string,
  ipcAgentId: string | null | undefined,
  inputTurnId: unknown,
): boolean {
  if (typeof inputTurnId !== 'string' || !inputTurnId) return true;
  return activeTurnOutputs.canDeliverUtterance({
    scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
    inputTurnId,
  });
}

// Host-owned current-turn registry. Agent Builder authorization never trusts
// turn/chat/task claims from the runner's writable IPC JSON.
const activeAgentBuilderTurns = new AgentBuilderTurnRegistry();

// Exact credential-free provider context for the user input currently being
// answered. Feishu broker IPC is authorized against this host-owned registry;
// runner-supplied chat/account claims are never trusted.
const activeChannelTurns = new ActiveChannelTurnRegistry();

// Durable output identity for the currently executing channel turn. Runtime
// keys match the IPC routing keys; exact route matching inside the registry
// prevents one thread/account from borrowing another thread's outbox.
const activeChannelOutboxScopes = new ActiveChannelOutboxScopeRegistry();

// ── 卡片挂起完成机制的共享工具 ──
// 挂起卡内各 turn 文本之间的分隔线（最终定稿卡片正文按时间序拼接各 turn）。
const HELD_TURN_DIVIDER = '\n\n---\n\n';
// agent-runner 截断续写触顶放弃时发出的机器状态标记（与
// container/agent-runner/src/index.ts 的 emit 保持字面一致），主进程据此
// 把挂起中的卡片收口，不再等一个永远不会来的 healthy result。
const TRUNCATION_EXHAUSTED_STATUS = 'truncation_continue_exhausted';
// 挂起期间累计的 usage 增量（与 StreamEvent['usage'] 同形），定稿后与最终
// turn 的 usage 合并成整个回合的总量补到卡片 usage note。
type HeldUsageTotals = NonNullable<StreamEvent['usage']>;
function mergeHeldUsage(
  base: HeldUsageTotals | null,
  next: HeldUsageTotals,
): HeldUsageTotals {
  if (!base)
    return {
      ...next,
      modelUsage: next.modelUsage ? { ...next.modelUsage } : undefined,
    };
  const mergedModel: NonNullable<HeldUsageTotals['modelUsage']> = {
    ...(base.modelUsage || {}),
  };
  for (const [model, mu] of Object.entries(next.modelUsage || {})) {
    const prev = mergedModel[model];
    mergedModel[model] = prev
      ? {
          inputTokens: (prev.inputTokens || 0) + (mu.inputTokens || 0),
          outputTokens: (prev.outputTokens || 0) + (mu.outputTokens || 0),
          cacheReadInputTokens:
            (prev.cacheReadInputTokens || 0) + (mu.cacheReadInputTokens || 0),
          cacheCreationInputTokens:
            (prev.cacheCreationInputTokens || 0) +
            (mu.cacheCreationInputTokens || 0),
          reasoningTokens:
            (prev.reasoningTokens || 0) + (mu.reasoningTokens || 0),
          costUSD: (prev.costUSD || 0) + (mu.costUSD || 0),
        }
      : { ...mu };
  }
  return {
    inputTokens: (base.inputTokens || 0) + (next.inputTokens || 0),
    outputTokens: (base.outputTokens || 0) + (next.outputTokens || 0),
    cacheReadInputTokens:
      (base.cacheReadInputTokens || 0) + (next.cacheReadInputTokens || 0),
    cacheCreationInputTokens:
      (base.cacheCreationInputTokens || 0) +
      (next.cacheCreationInputTokens || 0),
    reasoningTokens: (base.reasoningTokens || 0) + (next.reasoningTokens || 0),
    costUSD: (base.costUSD || 0) + (next.costUSD || 0),
    durationMs: (base.durationMs || 0) + (next.durationMs || 0),
    numTurns: (base.numTurns || 0) + (next.numTurns || 0),
    modelUsage: Object.keys(mergedModel).length > 0 ? mergedModel : undefined,
  };
}

// Sub-Agent 路径的挂起卡 finalizer 注册表（key: virtualChatJid）。主路径复用
// activeRouteUpdaters（用户消息注入时必经），Sub-Agent 注入点不走 route updater，
// 由 web.ts / 消息循环在注入成功回调里显式触发。
const activeHeldCardFinalizers = new Map<
  string,
  (sourceJid?: string | null, inputTurnId?: string) => void
>();

interface PreparedFollowUp {
  messages: NewMessage[];
  replyText?: string;
}

function resolveFollowUpRuntime(chatJid: string): {
  baseChatJid: string;
  agentId: string | null;
  effectiveGroup: RegisteredGroup;
} | null {
  const marker = '#agent:';
  const markerIndex = chatJid.indexOf(marker);
  const baseChatJid =
    markerIndex >= 0 ? chatJid.slice(0, markerIndex) : chatJid;
  const agentId =
    markerIndex >= 0 ? chatJid.slice(markerIndex + marker.length) : null;
  let group = registeredGroups[baseChatJid] ?? getRegisteredGroup(baseChatJid);
  if (!group && agentId) {
    const agent = getAgent(agentId);
    if (agent) {
      group =
        registeredGroups[agent.chat_jid] ?? getRegisteredGroup(agent.chat_jid);
    }
  }
  if (!group) return null;
  return {
    baseChatJid,
    agentId,
    effectiveGroup: resolveEffectiveGroup(group).effectiveGroup,
  };
}

async function prepareFollowUp(
  item: QueuedFollowUp,
): Promise<PreparedFollowUp> {
  const runtime = resolveFollowUpRuntime(item.chat_jid);
  if (!runtime) return { messages: [item] };
  const expandContext = buildExpandContext(
    item.chat_jid,
    runtime.effectiveGroup,
    runtime.effectiveGroup.created_by,
  );
  if (!expandContext) return { messages: [item] };
  const { toSend, replies } = await expandMessagesIfNeeded(
    [item],
    expandContext,
    undefined,
    persistPluginExpansion,
  );
  return {
    messages: toSend,
    replyText: replies[0]?.text,
  };
}

async function completeFollowUpReply(
  item: QueuedFollowUp,
  replyText: string,
): Promise<boolean> {
  const runId = item.delivery_run_id || crypto.randomUUID();
  const deliveryUpdatedAt = new Date().toISOString();
  const sourceJid = item.source_jid || item.chat_jid;
  const followUpRuntime = resolveFollowUpRuntime(item.chat_jid);
  if (!followUpRuntime) return false;
  const delivery = await sendPluginExpanderReply(item.chat_jid, replyText, {
    originalMessageId: item.id,
    groupFolder: followUpRuntime.effectiveGroup.folder,
    imRouteJid: getChannelType(sourceJid) ? sourceJid : null,
    agentId: followUpRuntime.agentId,
  });
  if (!delivery.acknowledged) return false;
  const released = releaseQueuedFollowUp(
    item.chat_jid,
    item.id,
    runId,
    deliveryUpdatedAt,
  );
  if (!released) return false;
  completeOutOfBandMessage(item.chat_jid, {
    timestamp: item.timestamp,
    id: item.id,
  });
  broadcastFollowUpUpdate(item.chat_jid, {
    id: item.id,
    delivery_status: 'released',
    delivery_run_id: runId,
    delivery_updated_at: deliveryUpdatedAt,
  });
  if (getChannelType(sourceJid)) {
    await clearStandaloneProcessingIndicator(item.chat_jid, sourceJid, item.id);
  }
  return true;
}

function enqueueReleasedFollowUp(item: QueuedFollowUp): void {
  const runtime = resolveFollowUpRuntime(item.chat_jid);
  if (runtime?.agentId) {
    queue.enqueueTask(item.chat_jid, `follow-up:${item.id}`, async () => {
      return processAgentConversation(runtime.baseChatJid, runtime.agentId!);
    });
    return;
  }
  queue.enqueueMessageCheck(item.chat_jid);
}

function injectPreparedFollowUp(
  item: QueuedFollowUp,
  prepared: PreparedFollowUp,
  runId: string,
): 'sent' | 'no_active' | 'cancelled' {
  if (!getQueuedFollowUp(item.chat_jid, item.id)) return 'cancelled';
  const sourceJid = item.source_jid || item.chat_jid;
  const deliveryTarget = createIpcDeliveryTarget(item.chat_jid, [item]);
  const knownReferencedMessageIds = collectPersistedReferencedMessageIds(
    item.chat_jid,
    prepared.messages,
  );
  const images = collectMessageImages(item.chat_jid, prepared.messages, {
    knownMessageIds: knownReferencedMessageIds,
  });
  const runtime = resolveFollowUpRuntime(item.chat_jid);
  const result = queue.sendMessage(
    item.chat_jid,
    formatMessages(prepared.messages, {
      knownMessageIds: knownReferencedMessageIds,
    }),
    images.length > 0 ? images : undefined,
    (receipt) => {
      if (runtime && receipt) {
        activeAgentBuilderTurns.enqueueBatch(
          agentBuilderTurnScope(runtime.effectiveGroup.folder, runtime.agentId),
          (receipt.coveredCursors ?? [receipt.cursor]).map((cursor) => ({
            chatJid: receipt.chatJid,
            messageId: cursor.id,
            runtimeTurnId: receipt.deliveryId,
            scheduledTaskId: null,
          })),
        );
        grantWorkspaceMemoryTurnToCurrentRunner(
          {
            groupFolder: runtime.effectiveGroup.folder,
            agentId: runtime.agentId ?? null,
            taskRunId: null,
          },
          receipt.deliveryId,
        );
      }
      if (runtime?.agentId) {
        activeHeldCardFinalizers.get(item.chat_jid)?.(
          sourceJid,
          receipt?.deliveryId,
        );
      } else if (runtime) {
        invokeActiveRouteUpdater(
          runtime.effectiveGroup.folder,
          sourceJid,
          receipt?.deliveryId,
          receipt?.cursor,
        );
      }
    },
    sourceJid,
    undefined,
    deliveryTarget,
    undefined,
    (receipt) =>
      runtime
        ? invokeActiveRouteAdmission(
            runtime.effectiveGroup.folder,
            sourceJid,
            receipt,
            runtime.agentId ?? undefined,
          )
        : false,
  );

  if (result === 'sent') {
    const deliveryUpdatedAt = new Date().toISOString();
    const released = releaseQueuedFollowUp(
      item.chat_jid,
      item.id,
      runId,
      deliveryUpdatedAt,
    );
    if (!released) {
      logger.error(
        { chatJid: item.chat_jid, messageId: item.id, runId },
        'Follow-up was injected but its durable queue claim could not be released',
      );
    }
    if (deliveryTarget) {
      advanceNextPullCursorOnly(item.chat_jid, deliveryTarget.cursor);
    }
    broadcastFollowUpUpdate(
      item.chat_jid,
      released
        ? {
            id: item.id,
            delivery_status: 'released',
            delivery_run_id: runId,
            delivery_updated_at: deliveryUpdatedAt,
          }
        : undefined,
    );
    return 'sent';
  }

  // The runner disappeared between preparation and injection. Make the row
  // visible to the normal cold-start reader so it can be recovered safely.
  const deliveryUpdatedAt = new Date().toISOString();
  const released = releaseQueuedFollowUp(
    item.chat_jid,
    item.id,
    runId,
    deliveryUpdatedAt,
  );
  broadcastFollowUpUpdate(
    item.chat_jid,
    released
      ? {
          id: item.id,
          delivery_status: 'released',
          delivery_run_id: runId,
          delivery_updated_at: deliveryUpdatedAt,
        }
      : undefined,
  );
  enqueueReleasedFollowUp(item);
  return 'no_active';
}

async function dispatchNextQueuedFollowUp(chatJid: string): Promise<void> {
  const reservedRunId = queue.reserveNextQuery(chatJid);
  if (!reservedRunId) return;
  const item = claimNextQueuedFollowUp(chatJid, reservedRunId);
  if (!item) {
    queue.releaseQueryReservation(chatJid, reservedRunId);
    return;
  }
  queue.announceReservedQuery(chatJid, reservedRunId);
  item.delivery_run_id = reservedRunId;
  item.delivery_status = 'promoting';
  broadcastFollowUpUpdate(chatJid);

  try {
    const prepared = await prepareFollowUp(item);
    if (!getQueuedFollowUp(chatJid, item.id)) {
      queue.releaseQueryReservation(chatJid, reservedRunId, true);
      return;
    }
    if (prepared.replyText && prepared.messages.length === 0) {
      const completed = await completeFollowUpReply(item, prepared.replyText);
      if (!completed) {
        restorePromotingFollowUp(chatJid, item.id);
        broadcastFollowUpUpdate(chatJid);
      }
      queue.releaseQueryReservation(chatJid, reservedRunId, completed);
      if (!completed) {
        const retryTimer = setTimeout(() => {
          void dispatchNextQueuedFollowUp(chatJid);
        }, 1_000);
        retryTimer.unref();
      }
      return;
    }
    const result = injectPreparedFollowUp(item, prepared, reservedRunId);
    if (result !== 'sent') {
      queue.releaseQueryReservation(chatJid, reservedRunId);
    }
  } catch (err) {
    restorePromotingFollowUp(chatJid, item.id);
    queue.releaseQueryReservation(chatJid, reservedRunId);
    broadcastFollowUpUpdate(chatJid);
    logger.error(
      { err, chatJid, messageId: item.id },
      'Failed to prepare queued follow-up',
    );
    const retryTimer = setTimeout(() => {
      void dispatchNextQueuedFollowUp(chatJid);
    }, 1_000);
    retryTimer.unref();
  }
}

function dispatchQueuedFollowUpFamily(completedChatJid: string): void {
  // A running workspace may be addressed through a sibling Web/IM JID that
  // resolves to the same serialized runner. Try the completing JID first, then
  // every durable queue. reserveNextQuery() atomically lets only the first JID
  // from this runner family claim the next turn.
  const candidates = new Set([
    completedChatJid,
    ...getQueuedFollowUpChatJids(),
  ]);
  for (const chatJid of candidates) {
    void dispatchNextQueuedFollowUp(chatJid);
  }
}

function promoteFollowUp(
  chatJid: string,
  messageId: string,
  expectedRunId: string,
): FollowUpActionResult {
  // Resolve the run at click time. A queued card can outlive the run it was
  // created under; explicitly sending it now must behave like a fresh direct
  // steer, not fail because its original run id became stale.
  const activeRunId = queue.getActiveQueryId(chatJid);
  const item = prioritizeQueuedFollowUp(
    chatJid,
    messageId,
    activeRunId ?? expectedRunId,
  );
  if (!item) {
    return { ok: false, message: '这条排队消息已被处理或取消。' };
  }
  broadcastFollowUpUpdate(chatJid);
  if (!activeRunId) {
    dispatchQueuedFollowUpFamily(chatJid);
    return {
      ok: true,
      state: 'queued',
      message: '当前回复已结束，这条消息将作为下一轮优先发送。',
      item,
    };
  }
  return interruptAndRunFollowUp(chatJid, messageId, activeRunId);
}

function cancelFollowUp(
  chatJid: string,
  messageId: string,
): FollowUpActionResult {
  const deliveryUpdatedAt = new Date().toISOString();
  const item = cancelQueuedFollowUp(chatJid, messageId, deliveryUpdatedAt);
  if (!item) return { ok: false, message: '这条排队消息已被处理或取消。' };
  broadcastFollowUpUpdate(chatJid, {
    id: messageId,
    delivery_status: 'cancelled',
    delivery_run_id: item.delivery_run_id,
    delivery_updated_at: deliveryUpdatedAt,
  });
  const indicatorJid =
    item.source_jid && getChannelType(item.source_jid)
      ? item.source_jid
      : getChannelType(chatJid)
        ? chatJid
        : null;
  if (indicatorJid) {
    void clearStandaloneProcessingIndicator(chatJid, indicatorJid, messageId);
  }
  return { ok: true, state: 'cancelled', message: '已取消排队消息。', item };
}

function editFollowUp(
  chatJid: string,
  messageId: string,
  content: string,
): FollowUpActionResult {
  const item = updateQueuedFollowUpContent(chatJid, messageId, content);
  if (!item) return { ok: false, message: '这条消息已开始发送，无法再编辑。' };
  broadcastFollowUpUpdate(chatJid);
  return { ok: true, state: 'queued', message: '已更新排队消息。', item };
}

function reorderFollowUp(
  chatJid: string,
  messageId: string,
  direction: 'up' | 'down',
): FollowUpActionResult {
  const item = moveQueuedFollowUp(chatJid, messageId, direction);
  if (!item) return { ok: false, message: '消息顺序已变化，请刷新后重试。' };
  broadcastFollowUpUpdate(chatJid);
  return { ok: true, state: 'queued', message: '已调整排队顺序。', item };
}

// Claude Agent SDK reports both an explicit Stop and a follow-up steer as the
// same `status: interrupted` event. Keep the product intent beside the queue
// interrupt so the stream finalizer can present the two transitions correctly.
// The registry also guards the SDK race where the superseded turn's buffered
// final arrives after interrupt() has already been requested.
const steeringTransitions = new SteeringTransitionRegistry();

function markSteeringInterrupt(chatJid: string): void {
  steeringTransitions.mark(chatJid);
}

function clearSteeringInterrupt(chatJid: string): void {
  steeringTransitions.clear(chatJid);
}

function resolveSteeringInterrupt(chatJid: string, turnId?: string): boolean {
  return steeringTransitions.resolveInterrupted(chatJid, turnId);
}

function interruptAndRunFollowUp(
  chatJid: string,
  messageId: string,
  _expectedRunId: string,
): FollowUpActionResult {
  const first = listQueuedFollowUps(chatJid)[0];
  if (!first || first.id !== messageId) {
    return {
      ok: false,
      state: 'queued',
      message: '为保证消息顺序，只能中断后立即执行队首消息。',
      item: getQueuedFollowUp(chatJid, messageId) ?? undefined,
    };
  }
  const activeRunId = queue.getActiveQueryId(chatJid);
  if (activeRunId) markSteeringInterrupt(chatJid);
  if (!activeRunId || !queue.interruptQuery(chatJid, activeRunId)) {
    clearSteeringInterrupt(chatJid);
    // The query can become idle after the caller observed activeRunId but
    // before this interrupt reaches GroupQueue.  Kick the durable dispatcher
    // so the newly queued steer cannot be stranded in that race window.
    dispatchQueuedFollowUpFamily(chatJid);
    return {
      ok: true,
      state: 'queued',
      message: '当前回复已结束，这条消息将作为下一轮优先发送。',
      item: getQueuedFollowUp(chatJid, messageId) ?? undefined,
    };
  }
  // Steering is terminal for the superseded input family. The newly queued
  // follow-up has not been admitted/tracked yet, so exact cleanup here cannot
  // erase the replacement turn's provider reaction.
  void clearTrackedProcessingIndicators(chatJid);
  broadcastFollowUpUpdate(chatJid);
  return {
    ok: true,
    state: 'interrupting',
    message: '正在根据这条消息调整当前任务。',
    item: first,
  };
}

function recoverDurableFollowUps(): void {
  for (const chatJid of getQueuedFollowUpChatJids()) {
    const recoveryRunId = `recovery:${crypto.randomUUID()}`;
    const item = claimNextQueuedFollowUp(chatJid, recoveryRunId);
    if (!item) continue;
    releaseQueuedFollowUp(chatJid, item.id, recoveryRunId);
    enqueueReleasedFollowUp(item);
  }
}

// ── IPC send_message 跨重试去重 ──
// 错误退避重试会把整个 prompt 从头重跑，agent 在失败前已执行的 send_message
// 会被原样再执行一遍，经 IPC watcher 即时送达用户（重复刷消息）。
//
// 关键：抑制必须严格限定在「重试重放」窗口，否则会误杀合法的重复内容
// （周期定时任务每次报告相同文案、用户明确要求重发同一句话）。因此始终记录
// 每条 send 的指纹，但仅当该源 group 当前正处于失败重试轮次（retryCount>0）
// 时，命中已记录的指纹才抑制——正常首轮永不抑制。
const ipcSendDedup = createIpcSendDeduplicator({
  getRetryCount: (jid) => queue.getRetryCount(jid),
  getJidsByFolder,
});
function isRetryDuplicateIpcSend(
  sourceGroup: string,
  chatJid: string,
  text: string,
): boolean {
  return ipcSendDedup.isRetryDuplicate(sourceGroup, chatJid, text);
}

function recordSuccessfulIpcSend(
  sourceGroup: string,
  chatJid: string,
  text: string,
): void {
  ipcSendDedup.recordSuccessfulSend(sourceGroup, chatJid, text);
}

// Track consecutive IM send failures per JID for auto-unbind
const imSendFailCounts = new Map<string, number>();
const IM_SEND_FAIL_THRESHOLD = 3;

// Groups whose pending messages were recovered after a restart.
// processGroupMessages injects recent conversation history for these groups
// so the fresh session has context despite the session being cleared.
const recoveryGroups = new Set<string>();

// Track consecutive IM health check failures per JID for safe auto-unbind
const imHealthCheckFailCounts = new Map<string, number>();
const IM_HEALTH_CHECK_FAIL_THRESHOLD = 3;
const RELATIVE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

/**
 * Resolve the IM JID that send_image / send_file / other media MCP tools
 * should target. Three cases:
 * - Conversation agent: use the agent-bound route map (IM channel the
 *   conversation agent was started on).
 * - Home container: prefer the route map because ctx.chatJid is frozen to
 *   the first IM source, while the home container serves multiple channels
 *   concurrently. Fall back to chatJid if it's an IM JID.
 * - Regular group: prefer chatJid when it's an IM JID, fall back to the
 *   route map.
 */
function resolveImRoute(opts: {
  ipcAgentId: string | null | undefined;
  isHome: boolean;
  chatJid: string;
  sourceGroup: string;
}): string | null {
  return resolveIpcImRoute({
    ...opts,
    getActiveRoute: (runtimeJid) => activeImReplyRoutes.get(runtimeJid) ?? null,
    getAgentChatJid: (agentId) => getAgent(agentId)?.chat_jid ?? null,
    isImJid: (jid) => getChannelType(jid) !== null,
  });
}

function detachThreadMapWorkspace(
  targetMainJid?: string,
  excludingImJid?: string,
): void {
  if (!targetMainJid) return;
  if (hasRemainingThreadMapMount(targetMainJid, excludingImJid)) return;
  const workspaceJid = resolveWorkspaceJid(targetMainJid);
  if (!workspaceJid) return;
  const workspace =
    registeredGroups[workspaceJid] ?? getRegisteredGroup(workspaceJid);
  if (!workspace) return;

  const updatedWorkspace = buildDetachedWorkspaceUpdate(workspace);
  setRegisteredGroup(workspaceJid, updatedWorkspace);
  registeredGroups[workspaceJid] = updatedWorkspace;
}

function markThreadMapWorkspace(targetMainJid?: string): void {
  if (!targetMainJid) return;
  const workspaceJid = resolveWorkspaceJid(targetMainJid);
  if (!workspaceJid) return;
  const workspace =
    registeredGroups[workspaceJid] ?? getRegisteredGroup(workspaceJid);
  if (!workspace) return;
  const updatedWorkspace = buildNativeThreadWorkspaceUpdate(workspace);
  if (
    updatedWorkspace.conversation_source === workspace.conversation_source &&
    updatedWorkspace.conversation_nav_mode === workspace.conversation_nav_mode
  ) {
    return;
  }
  setRegisteredGroup(workspaceJid, updatedWorkspace);
  registeredGroups[workspaceJid] = updatedWorkspace;
}

function persistActivationAwareGroupUpdate(
  chatJid: string,
  previous: RegisteredGroup,
  candidate: RegisteredGroup,
): boolean {
  const threadMapped = isNativeContextContainer(chatJid, candidate, {
    activation_mode: candidate.activation_mode,
  });
  if (threadMapped && candidate.target_agent_id) return false;

  const updated = candidate.target_main_jid
    ? buildWorkspaceMountUpdate(
        candidate,
        candidate.target_main_jid,
        threadMapped ? 'thread_map' : 'single_session',
        {
          activationMode: candidate.activation_mode,
          ownerImId: candidate.owner_im_id ?? null,
        },
      )
    : candidate;
  persistGroupUpdate(chatJid, updated, registeredGroups);
  if (previous.binding_mode === 'thread_map' && !threadMapped) {
    detachThreadMapWorkspace(previous.target_main_jid, chatJid);
  }
  if (threadMapped) markThreadMapWorkspace(updated.target_main_jid);
  return true;
}

/** Restore an authorized chat to its channel account's default workspace. */
function unbindImGroup(jid: string, reason: string): boolean {
  const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
  if (!group) return false;
  const agentId = group.target_agent_id;
  const targetMainJid = group.target_main_jid;
  const wasThreadMap = group.binding_mode === 'thread_map';
  const restored = restoreDefaultChannelMount(jid, group, group.created_by);
  if (restored.status !== 'resolved') {
    logger.warn({ jid, reason: restored.reason }, `${reason}: restore failed`);
    return false;
  }
  registeredGroups[jid] = restored.updated;
  if (restored.routingMode === 'thread_map') {
    markThreadMapWorkspace(restored.workspaceJid);
  }
  if (
    wasThreadMap &&
    (restored.routingMode !== 'thread_map' ||
      resolveWorkspaceJid(targetMainJid || '') !== restored.workspaceJid)
  ) {
    detachThreadMapWorkspace(targetMainJid, jid);
  }
  imSendFailCounts.delete(jid);
  imHealthCheckFailCounts.delete(jid);
  logger.info(
    { jid, agentId, targetMainJid, restoredWorkspace: restored.workspaceJid },
    reason,
  );
  return true;
}

/**
 * Remove an IM group entirely (jid record + chat history + pinned refs + send/health counters).
 * Use this when the group is detected as dead — bot kicked, group disbanded,
 * health-check repeatedly unreachable, or consecutive send failures.
 *
 * Differs from unbindImGroup() which only clears target_* fields (used for
 * user-initiated soft unbind where the IM group itself is still alive).
 */
export function removeImGroupRecord(jid: string, reason: string): void {
  const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
  if (!group) return;
  const detachedThreadTarget =
    group.binding_mode === 'thread_map' ? group.target_main_jid : undefined;
  deleteImGroupRecord(jid);
  delete registeredGroups[jid];
  if (detachedThreadTarget) {
    detachThreadMapWorkspace(detachedThreadTarget, jid);
  }
  imSendFailCounts.delete(jid);
  imHealthCheckFailCounts.delete(jid);
  logger.info(
    {
      jid,
      hadTargetAgent: !!group.target_agent_id,
      hadTargetMain: !!group.target_main_jid,
    },
    reason,
  );
}

/**
 * Resolve the workspace folder an IM chat should use for file downloads and
 * execution context. Bound targets take precedence over the source IM folder.
 */
function resolveEffectiveFolder(chatJid: string): string | undefined {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return undefined;

  if (group.target_agent_id) {
    const agent = getAgent(group.target_agent_id);
    const agentParent = agent
      ? (registeredGroups[agent.chat_jid] ?? getRegisteredGroup(agent.chat_jid))
      : null;
    return agentParent?.folder || group.folder;
  }

  if (group.target_main_jid) {
    const targetGroup =
      registeredGroups[group.target_main_jid] ??
      getRegisteredGroup(group.target_main_jid);
    return targetGroup?.folder || group.target_main_jid.replace(/^web:/, '');
  }

  return group.folder;
}

/**
 * Resolve the effective group for a non-home group by finding its sibling home group.
 * Non-home groups use their own executionMode/customCwd — no owner fallback.
 * Populates registeredGroups cache as a side-effect.
 */
function resolveEffectiveGroup(group: RegisteredGroup): {
  effectiveGroup: RegisteredGroup;
  isHome: boolean;
} {
  // If the group already has an explicit binding, keep it — do NOT overwrite it by searching for is_home
  // This fixes the bug where binding an IM group to a non-home workspace would lose the binding on restart
  if (group.target_agent_id || group.target_main_jid) {
    // Still inherit runtime properties (executionMode/customCwd/created_by) from home sibling
    if (!group.is_home) {
      const siblingJids = getJidsByFolder(group.folder);
      for (const jid of siblingJids) {
        const sibling = registeredGroups[jid] ?? getRegisteredGroup(jid);
        if (sibling && !registeredGroups[jid]) registeredGroups[jid] = sibling;
        if (sibling?.is_home) {
          return {
            effectiveGroup: {
              ...group,
              executionMode: sibling.executionMode,
              customCwd: sibling.customCwd || group.customCwd,
              created_by: group.created_by || sibling.created_by,
              is_home: true,
            },
            isHome: true,
          };
        }
      }
    }
    return { effectiveGroup: group, isHome: !!group.is_home };
  }

  // Only auto-resolve to home sibling if there is NO explicit binding
  if (group.is_home) return { effectiveGroup: group, isHome: true };

  const siblingJids = getJidsByFolder(group.folder);
  for (const jid of siblingJids) {
    const sibling = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (sibling && !registeredGroups[jid]) registeredGroups[jid] = sibling;
    if (sibling?.is_home) {
      return {
        effectiveGroup: {
          ...group,
          executionMode: sibling.executionMode,
          customCwd: sibling.customCwd || group.customCwd,
          created_by: group.created_by || sibling.created_by,
          is_home: true,
        },
        isHome: true,
      };
    }
  }

  return { effectiveGroup: group, isHome: false };
}

/** Recursively search for a file by name in subdirectories (max 3 levels). */
function findFileInSubdirs(
  dir: string,
  fileName: string,
  depth = 0,
): string | null {
  if (depth > 3) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) return fullPath;
      if (entry.isDirectory()) {
        const found = findFileInSubdirs(fullPath, fileName, depth + 1);
        if (found) return found;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** Resolve the owner's home folder for memory mounting. Non-home groups read owner's home memory. */
function resolveOwnerHomeFolder(group: RegisteredGroup): string {
  if (group.created_by) {
    return getUserHomeGroup(group.created_by)?.folder || group.folder;
  }
  return group.folder;
}

function toContainerAgentProfile(
  profile: AgentProfile | undefined,
): ContainerInput['agentProfile'] | undefined {
  profile = resolveEffectiveAgentProfile(profile);
  if (!profile) return undefined;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    isDefault: profile.is_default,
    identityHash: profile.identity_hash,
    identityPrompt: buildAgentProfilePrompt(profile),
    includeClaudePreset: profile.prompt_mode === 'append',
    runtimePolicy: profile.runtime_policy,
  };
}

function resolveHappyClawOwnerProfileForTurn(input: {
  group: RegisteredGroup;
  profile: AgentProfile | undefined;
  turnId?: string;
  isScheduledTask?: boolean;
  runtimeAgentId?: string | null;
  runtimeAgentKind?: 'task' | 'conversation' | 'spawn' | null;
}): HappyClawOwnerProfileProjection | undefined {
  if (
    !isHappyClawBootstrapTurn({
      turnId: input.turnId,
      isHome: input.group.is_home === true,
      isDefaultProfile: input.profile?.is_default === true,
      isScheduledTask: input.isScheduledTask,
    }) ||
    (input.runtimeAgentId && input.runtimeAgentKind !== 'conversation')
  ) {
    return undefined;
  }
  const ownerId = input.group.created_by;
  const owner = ownerId ? getUserById(ownerId) : undefined;
  if (!ownerId || owner?.status !== 'active') return undefined;
  try {
    activeAgentBuilderTurns.requireExactActiveOwnerHumanTurn(
      agentBuilderTurnScope(input.group.folder, input.runtimeAgentId),
      input.turnId,
      getAgentBuilderInputMessage,
      (persistedInput) =>
        isAgentBuilderOwnerInput(
          persistedInput,
          ownerId,
          (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
        ),
    );
  } catch {
    // A Home group can admit non-owner audience turns. Owner Profile data and
    // first-wake onboarding are intentionally absent from those turns.
    return undefined;
  }
  const workspaceJid = getJidsByFolder(input.group.folder).find((jid) =>
    jid.startsWith('web:'),
  );
  if (!workspaceJid) return undefined;
  try {
    return getHappyClawOwnerProfileProjection(workspaceJid);
  } catch {
    return undefined;
  }
}

function isHappyClawOwnerProfileRuntimeEligible(input: {
  group: RegisteredGroup;
  profile: AgentProfile | undefined;
  turnId?: string;
  isScheduledTask?: boolean;
  runtimeAgentId?: string | null;
  runtimeAgentKind?: 'task' | 'conversation' | 'spawn' | null;
}): boolean {
  return isHappyClawOwnerProfileRuntimeStructurallyEligible({
    isHome: input.group.is_home === true,
    isDefaultProfile: input.profile?.is_default === true,
    isScheduledTask: input.isScheduledTask,
    runtimeAgentId: input.runtimeAgentId,
    runtimeAgentKind: input.runtimeAgentKind,
  });
}

function hasSessionAgentProfileMismatch(
  groupFolder: string,
  agentId: string | null | undefined,
  profile: AgentProfile | undefined,
): boolean {
  if (!profile) return false;
  const current = getSessionAgentIdentity(groupFolder, agentId);
  if (!current) return false;

  const hasLegacyUntrackedIdentity =
    !current.agent_profile_id && !current.identity_hash;
  if (
    hasLegacyUntrackedIdentity &&
    !hasAgentProfilePrompts(profile) &&
    profile.prompt_mode === 'append'
  ) {
    return false;
  }

  if (current.identity_hash !== profile.identity_hash) return true;
  if (
    current.agent_profile_version != null &&
    current.agent_profile_version !== profile.version
  ) {
    return true;
  }
  return !!current.agent_profile_id && current.agent_profile_id !== profile.id;
}

function resetMainSessionForAgentProfileMismatch(
  group: RegisteredGroup,
  profile: AgentProfile | undefined,
): boolean {
  if (!hasSessionAgentProfileMismatch(group.folder, null, profile))
    return false;
  deleteSession(group.folder);
  delete sessions[group.folder];
  logger.info(
    {
      groupFolder: group.folder,
      agentProfileId: profile?.id,
      identityHash: profile?.identity_hash,
    },
    'Cleared main Claude session after AgentProfile identity changed',
  );
  return true;
}

function resetConversationSessionForAgentProfileMismatch(
  group: RegisteredGroup,
  agentId: string,
  profile: AgentProfile | undefined,
): boolean {
  if (!hasSessionAgentProfileMismatch(group.folder, agentId, profile)) {
    return false;
  }
  deleteSession(group.folder, agentId);
  logger.info(
    {
      groupFolder: group.folder,
      agentId,
      agentProfileId: profile?.id,
      identityHash: profile?.identity_hash,
    },
    'Cleared conversation agent Claude session after AgentProfile identity changed',
  );
  return true;
}

/**
 * Write usage records from a usage event to the database.
 * Handles both modelUsage (per-model breakdown) and legacy flat format.
 * When modelUsage is present, per-model cache tokens are read directly from each model entry.
 */
function writeUsageRecords(opts: {
  userId: string;
  groupFolder: string;
  messageId?: string;
  agentId?: string;
  source?: string;
  usage: {
    eventId?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens?: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        reasoningTokens?: number;
        costUSD: number;
      }
    >;
  };
}): ReturnType<typeof recordUsageEvent> {
  const { userId, groupFolder, messageId, agentId, source, usage } = opts;
  return recordUsageEvent({
    userId,
    groupFolder,
    agentId,
    messageId,
    eventId: usage.eventId,
    source: source || (agentId ? 'custom-agent' : 'main-agent'),
    usage,
  });
}

/**
 * Detect Feishu interactive card JSON and extract readable text for web display.
 * Returns null if the text is not a Feishu card.
 */
function extractFeishuCardText(text: string): string | null {
  if (!text.startsWith('{"type":"interactive"')) return null;
  try {
    const card = JSON.parse(text);
    if (card.type !== 'interactive' || !card.card) return null;
    const parts: string[] = [];
    // Extract header title
    const title = card.card.header?.title?.content;
    if (title) parts.push(`**${title}**\n`);
    // Extract markdown content from elements
    for (const el of card.card.elements || []) {
      if (el.tag === 'markdown' && el.content) {
        parts.push(el.content);
      } else if (el.tag === 'column_set') {
        for (const col of el.columns || []) {
          for (const colEl of col.elements || []) {
            if (colEl.tag === 'markdown' && colEl.content) {
              parts.push(colEl.content);
            }
          }
        }
      } else if (el.tag === 'note') {
        for (const noteEl of el.elements || []) {
          if (noteEl.content) parts.push(`_${noteEl.content}_`);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

/** Send a message to an IM channel with automatic fail-count tracking and auto-unbind. */
function extractLocalImImagePaths(
  text: string,
  groupFolder?: string,
): string[] {
  if (!groupFolder || !text) return [];

  const workspaceRoot = path.resolve(GROUPS_DIR, groupFolder);
  const seen = new Set<string>();
  const imagePaths: string[] = [];
  const candidates: string[] = [];
  const markdownImageRe = /!\[[^\]]*]\(([^)]+)\)/g;
  const taggedImageRe = /\[图片:\s*([^\]\n]+)\]/g;

  const pushCandidate = (raw: string): void => {
    const trimmed = raw.trim().replace(/^<|>$/g, '');
    const pathToken = trimmed
      .split(/\s+/)[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    if (
      !pathToken ||
      pathToken.startsWith('/') ||
      pathToken.startsWith('data:') ||
      /^[a-z]+:\/\//i.test(pathToken)
    ) {
      return;
    }
    candidates.push(pathToken);
  };

  for (const match of text.matchAll(markdownImageRe)) {
    pushCandidate(match[1] || '');
  }
  for (const match of text.matchAll(taggedImageRe)) {
    pushCandidate(match[1] || '');
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(workspaceRoot, candidate);
    const ext = path.extname(resolved).toLowerCase();
    if (!RELATIVE_IMAGE_EXTENSIONS.has(ext)) continue;
    if (
      resolved !== workspaceRoot &&
      !resolved.startsWith(workspaceRoot + path.sep)
    )
      continue;
    // Symlink-escape protection: reject paths whose realpath leaves the
    // workspace (a symlink with an in-workspace lexical path could otherwise
    // exfiltrate arbitrary host/other-user files via IM).
    if (!isRealpathInside(resolved, workspaceRoot)) continue;
    if (seen.has(resolved)) continue;
    try {
      if (!fs.statSync(resolved).isFile()) continue;
      seen.add(resolved);
      imagePaths.push(resolved);
    } catch {
      continue;
    }
  }

  return imagePaths;
}

/**
 * Generic IM operation retry with linear backoff (2s, 4s, 6s).
 * Returns true on success, false when all retries are exhausted.
 */
const IM_SEND_MAX_RETRIES = 3;
const IM_SEND_RETRY_DELAY_MS = 2_000;

interface ChannelOutboxDeliveryRef {
  scopeKey: string;
  operationKey: string;
  scopeToken: string;
  ordinalSlot?: string;
}

function bindChannelOutboxScope(
  key: string,
  runtime: ChannelTurnRuntime,
  route: {
    provider: string;
    accountId: string;
    sourceJid: string;
    chatId: string;
    rootId?: string | null;
    threadId?: string | null;
  },
): ActiveChannelOutboxScope {
  return activeChannelOutboxScopes.bind(key, {
    ...route,
    rootId: route.rootId ?? null,
    threadId: route.threadId ?? null,
    turnRunId: runtime.runId,
    inputTurnId: runtime.inputTurnId,
    owner: `happyclaw-outbox:${process.pid}:${runtime.runId}`,
  });
}

function channelOutboxRefForInput(
  scopeKey: string,
  targetJid: string,
  inputTurnId: unknown,
  operationKey: string,
): ChannelOutboxDeliveryRef | undefined {
  if (typeof inputTurnId !== 'string' || !inputTurnId) return undefined;
  const scope = activeChannelOutboxScopes.resolveInput(
    scopeKey,
    inputTurnId,
    targetJid,
  );
  return {
    scopeKey,
    // A missing exact scope must fail closed in deliverScopedChannelOutput;
    // never let an old MCP output borrow the newest warm turn's scope.
    scopeToken: scope?.token ?? `missing:${inputTurnId}`,
    operationKey,
  };
}

async function deliverScopedChannelOutput(
  targetJid: string,
  ref: ChannelOutboxDeliveryRef | undefined,
  input: {
    kind: 'text' | 'card' | 'image' | 'file';
    payload: unknown;
    send: () => Promise<void>;
  },
): Promise<boolean | null> {
  if (!ref) return null;
  const scope = activeChannelOutboxScopes.resolveToken(
    ref.scopeKey,
    ref.scopeToken,
    targetJid,
  );
  if (!scope) {
    logger.error(
      {
        targetJid,
        scopeKey: ref.scopeKey,
        operationKey: ref.operationKey,
      },
      'Suppressed channel side effect because its exact outbox scope is unavailable',
    );
    return false;
  }
  // The scope projection deliberately outlives a single input turn so a late
  // duplicate callback resolves the same delivered Outbox row. That must not
  // become an open window: once the turn itself reached a terminal state, its
  // output window is closed and anything still arriving is out of bounds.
  // Proactive mode makes this reachable in normal operation, because the
  // contract explicitly lets a model keep working after a send.
  const scopeTurnRun = getChannelTurnRun(scope.turnRunId);
  if (
    !scopeTurnRun ||
    (CHANNEL_RELIABILITY_TERMINAL_STATUSES.turns as readonly string[]).includes(
      scopeTurnRun.status,
    )
  ) {
    logger.error(
      {
        targetJid,
        turnRunId: scope.turnRunId,
        turnStatus: scopeTurnRun?.status ?? 'missing',
        operationKey: ref.operationKey,
      },
      'Suppressed channel side effect because its turn already closed its output window',
    );
    return false;
  }
  const uncertainSibling = getUncertainChannelOutboxForTurn(scope.turnRunId);
  if (uncertainSibling) {
    logger.warn(
      {
        targetJid,
        turnRunId: scope.turnRunId,
        uncertainOutboxItemId: uncertainSibling.id,
        operationKey: ref.operationKey,
      },
      'Blocked channel side effect until uncertain turn is manually reconciled',
    );
    return false;
  }
  const semanticIdentity = semanticChannelOutboxIdentity({
    route: scope,
    kind: input.kind,
    payload: input.payload,
    ordinalSlot: ref.ordinalSlot,
  });
  const ordinal = stableChannelOutboxOrdinal(semanticIdentity);
  const result = await deliverChannelOutboxItem({
    provider: scope.provider,
    accountId: scope.accountId,
    sourceJid: scope.sourceJid,
    chatId: scope.chatId,
    rootId: scope.rootId,
    threadId: scope.threadId,
    turnRunId: scope.turnRunId,
    ordinal,
    kind: input.kind,
    payload: input.payload,
    idempotencyKey: `${scope.turnRunId}:${semanticIdentity}`,
    owner: scope.owner,
    delivery: {
      mode: 'single',
      send: async ({ item }) => {
        // deliverChannelOutboxItem persists `sending` before entering here.
        await input.send();
        return {
          providerMessageId: syntheticChannelProviderAck({
            turnRunId: scope.turnRunId,
            ordinal,
            payloadHash: item.payloadHash,
          }),
        };
      },
    },
  });
  if (result.status !== 'delivered') {
    logger.warn(
      {
        targetJid,
        turnRunId: scope.turnRunId,
        outboxItemId: result.itemId,
        outboxStatus: result.status,
        operationKey: ref.operationKey,
        error: result.error,
      },
      result.status === 'uncertain'
        ? 'Channel delivery outcome is uncertain; automatic replay blocked'
        : 'Durable channel delivery did not complete',
    );
  }
  return result.status === 'delivered';
}

async function retryImOperation(
  label: string,
  imJid: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < IM_SEND_MAX_RETRIES; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      logger.warn(
        { imJid, attempt, label, err },
        'IM operation attempt failed',
      );
      if (attempt < IM_SEND_MAX_RETRIES - 1) {
        await new Promise((r) =>
          setTimeout(r, IM_SEND_RETRY_DELAY_MS * (attempt + 1)),
        );
      }
    }
  }
  logger.error({ imJid, label }, 'IM operation failed after all retries');
  return false;
}

/**
 * Send an IM message with retry.
 * On final failure, increments imSendFailCounts and may auto-unbind the IM group.
 */
async function sendImWithRetry(
  imJid: string,
  text: string,
  localImagePaths: string[],
  outbox?: ChannelOutboxDeliveryRef,
  deliveryOptions?: ChannelMessageDeliveryOptions,
  outboxMetadata?: {
    deliveryRole?: TurnMessageDeliveryRole | null;
    inputTurnId?: string | null;
    logicalChatJid?: string | null;
  },
): Promise<boolean> {
  let ok: boolean;
  const durableScoped = outbox !== undefined;
  if (durableScoped) {
    ok = true;
    if (text) {
      const delivered = await deliverScopedChannelOutput(
        imJid,
        {
          ...outbox!,
          operationKey: `${outbox!.operationKey}:text`,
          ordinalSlot: `${outbox!.ordinalSlot ?? 'message'}:text`,
        },
        {
          kind: 'text',
          payload: buildInteractionTextOutboxPayload(
            text,
            deliveryOptions?.presentation,
            outboxMetadata,
          ),
          send: () => imManager.sendMessage(imJid, text, [], deliveryOptions),
        },
      );
      ok = delivered === true;
    }
    for (let index = 0; index < localImagePaths.length; index++) {
      const imagePath = localImagePaths[index];
      const imageBuffer = fs.readFileSync(imagePath);
      const contentHash = crypto
        .createHash('sha256')
        .update(imageBuffer)
        .digest('hex');
      const mimeType = detectImageMimeType(imageBuffer);
      const delivered = await deliverScopedChannelOutput(
        imJid,
        {
          ...outbox!,
          operationKey: `${outbox!.operationKey}:image:${index}`,
          ordinalSlot: `${outbox!.ordinalSlot ?? 'message'}:image:${index}`,
        },
        {
          kind: 'image',
          payload: {
            fileName: path.basename(imagePath),
            contentHash,
          },
          // One physical attachment per outbox row. A later attachment failure
          // therefore cannot cause the already delivered body to be resent.
          send: () =>
            imManager.sendImage(
              imJid,
              imageBuffer,
              mimeType,
              undefined,
              path.basename(imagePath),
            ),
        },
      );
      if (delivered !== true) ok = false;
    }
  } else {
    ok = await retryImOperation('send_message', imJid, () =>
      imManager.sendMessage(imJid, text, localImagePaths, deliveryOptions),
    );
  }
  if (ok) {
    imSendFailCounts.delete(imJid);
    return true;
  }
  // `uncertain` is not evidence that the channel is unhealthy. In particular,
  // do not auto-unbind a Bot merely because its ACK was lost after acceptance.
  if (durableScoped) return false;
  // All retries exhausted — track cumulative failures
  const count = (imSendFailCounts.get(imJid) ?? 0) + 1;
  imSendFailCounts.set(imJid, count);
  if (count >= IM_SEND_FAIL_THRESHOLD) {
    try {
      removeImGroupRecord(
        imJid,
        'Auto-removed IM group after consecutive send failures',
      );
    } catch (unbindErr) {
      logger.error({ imJid, unbindErr }, 'Failed to auto-remove IM group');
    }
  }
  return false;
}

const CHANNEL_MANUAL_RECONCILIATION_NOTICE =
  '⚠️ 上一次回复在部分内容已送达后异常中断。为避免重复发送，系统已停止自动重放；可能仍有附件或结论未送达，请重新发起请求或联系管理员核对。';

/**
 * Surface a crash-after-delivery fence to the exact native route. The notice
 * itself uses an independent auxiliary Turn: an uncertain effect on the
 * original Turn must not block the warning that tells the user why automatic
 * replay stopped.
 */
async function deliverChannelManualReconciliationNotice(input: {
  logicalChatJid: string;
  scopeKey: string;
  targetJid: string;
  runtime: ChannelTurnRuntime;
  agentId?: string | null;
  presentation?: 'default' | 'native';
  route: {
    provider: string;
    accountId: string;
    sourceJid: string;
    chatId: string;
    rootId?: string | null;
    threadId?: string | null;
  };
}): Promise<boolean> {
  const delivered = await deliverIndependentChannelSystemNotice({
    logicalChatJid: input.logicalChatJid,
    scopeKey: input.scopeKey,
    targetJid: input.targetJid,
    route: input.route,
    agentId: input.agentId,
    originalInputTurnId: input.runtime.inputTurnId,
    originalRunId: input.runtime.runId,
    noticeKey: 'manual-reconciliation',
    text: CHANNEL_MANUAL_RECONCILIATION_NOTICE,
    presentation: input.presentation,
  });
  if (delivered) return true;

  // The native warning can itself fail. Preserve an auditable Web-visible
  // terminal error instead of leaving the session looking permanently stuck.
  sendSystemMessage(
    input.logicalChatJid,
    'delivery_uncertain',
    CHANNEL_MANUAL_RECONCILIATION_NOTICE,
  );
  return true;
}

async function deliverIndependentChannelSystemNotice(input: {
  logicalChatJid: string;
  scopeKey: string;
  targetJid: string;
  originalInputTurnId: string;
  originalRunId: string;
  noticeKey: string;
  text: string;
  sender?: string;
  senderName?: string;
  agentId?: string | null;
  presentation?: 'default' | 'native';
  messageMeta?: {
    turnId?: string;
    sessionId?: string;
    sourceKind?: MessageSourceKind;
    finalizationReason?: MessageFinalizationReason;
  };
  route: {
    provider: string;
    accountId: string;
    sourceJid: string;
    chatId: string;
    rootId?: string | null;
    threadId?: string | null;
  };
}): Promise<boolean> {
  const noticeRuntime = ChannelTurnRuntime.start({
    ...input.route,
    externalMessageId: `${input.originalInputTurnId}:system-notice:${input.noticeKey}`,
    correlationId: input.originalInputTurnId,
    agentId: input.agentId,
  });
  if (noticeRuntime.executionDisposition === 'defer') {
    noticeRuntime.dispose();
    return false;
  }
  const scope = bindChannelOutboxScope(
    input.scopeKey,
    noticeRuntime,
    input.route,
  );
  try {
    // An uncertain notice might already be visible. Never send a sibling;
    // preserve the Web audit record and let an operator reconcile provider
    // state instead of risking duplicate warnings.
    let acknowledged = Boolean(
      getUncertainChannelOutboxForTurn(noticeRuntime.runId),
    );
    if (!acknowledged) {
      acknowledged = await sendImWithRetry(
        input.targetJid,
        input.text,
        [],
        {
          scopeKey: input.scopeKey,
          scopeToken: scope.token,
          operationKey: `system-notice:${input.noticeKey}`,
          ordinalSlot: `system-notice:${input.noticeKey}`,
        },
        input.presentation === 'native'
          ? { presentation: 'native' }
          : undefined,
      );
    }
    const becameUncertain = Boolean(
      getUncertainChannelOutboxForTurn(noticeRuntime.runId),
    );
    if (!acknowledged && !becameUncertain) {
      if (noticeRuntime.executionDisposition === 'execute') {
        noticeRuntime.retry('System notice delivery failed before ACK');
      }
      return false;
    }

    if (noticeRuntime.executionDisposition === 'execute') {
      if (becameUncertain) {
        noticeRuntime.interrupt(
          `System notice ${input.noticeKey} delivery is uncertain; manual reconciliation required`,
        );
      } else {
        noticeRuntime.markFinalizing();
        noticeRuntime.complete({
          originalRunId: input.originalRunId,
          noticeKey: input.noticeKey,
          delivered: true,
        });
      }
    }

    const msgId = `sys_notice_${noticeRuntime.runId}`;
    const timestamp = new Date().toISOString();
    ensureChatExists(input.logicalChatJid);
    storeMessageDirect(
      msgId,
      input.logicalChatJid,
      input.sender ?? '__reconciliation__',
      input.senderName ?? ASSISTANT_NAME,
      input.text,
      timestamp,
      true,
      {
        sourceJid: input.targetJid,
        meta: {
          turnId: input.messageMeta?.turnId,
          sessionId: input.messageMeta?.sessionId,
          sourceKind: input.messageMeta?.sourceKind,
          finalizationReason: input.messageMeta?.finalizationReason,
        },
      },
    );
    broadcastNewMessage(input.logicalChatJid, {
      id: msgId,
      chat_jid: input.logicalChatJid,
      sender: input.sender ?? '__reconciliation__',
      sender_name: input.senderName ?? ASSISTANT_NAME,
      content: input.text,
      timestamp,
      is_from_me: true,
      source_jid: input.targetJid,
      turn_id: input.messageMeta?.turnId ?? null,
      session_id: input.messageMeta?.sessionId ?? null,
      source_kind: input.messageMeta?.sourceKind ?? null,
      finalization_reason: input.messageMeta?.finalizationReason ?? null,
    });
    return true;
  } finally {
    activeChannelOutboxScopes.unbind(input.scopeKey, scope);
    noticeRuntime.dispose();
  }
}

async function deliverProactiveTailInterruptionNotice(input: {
  logicalChatJid: string;
  scopeKey: string;
  inputTurnId: string;
  agentId?: string | null;
  targetJid?: string | null;
  scope?: ActiveChannelOutboxScope;
}): Promise<boolean> {
  const scopeRoute = input.scope?.chatId
    ? {
        provider: input.scope.provider,
        accountId: input.scope.accountId,
        sourceJid: input.scope.sourceJid,
        chatId: input.scope.chatId,
        rootId: input.scope.rootId,
        threadId: input.scope.threadId,
      }
    : null;
  const route =
    scopeRoute ??
    (input.targetJid ? resolveDurableChannelRoute(input.targetJid) : null);
  if (input.targetJid && route) {
    const delivered = await deliverIndependentChannelSystemNotice({
      logicalChatJid: input.logicalChatJid,
      scopeKey: input.scopeKey,
      targetJid: input.targetJid,
      originalInputTurnId: input.inputTurnId,
      originalRunId: input.scope?.turnRunId ?? `proactive:${input.inputTurnId}`,
      noticeKey: 'proactive-tail-interruption',
      text: PROACTIVE_TAIL_INTERRUPTION_NOTICE,
      sender: '__system__',
      senderName: 'system',
      agentId: input.agentId,
      presentation: 'native',
      route,
    });
    if (delivered) return true;
  }

  // Web-only sessions, and native notices that could not be acknowledged,
  // still receive a durable system record explaining why no replay occurred.
  sendSystemMessage(
    input.logicalChatJid,
    'proactive_interrupted',
    PROACTIVE_TAIL_INTERRUPTION_NOTICE,
  );
  return true;
}

/**
 * Recover non-empty SDK final text that a Proactive model forgot to send.
 *
 * Native delivery gets a fresh, durable Outbox turn because the original turn
 * may already be finalizing. A failed/unavailable native route still projects
 * the exact answer into the canonical Web session so the result is never
 * silently lost; it deliberately does not claim a physical provider ACK.
 */
async function deliverProactiveFinalFallback(input: {
  logicalChatJid: string;
  scopeKey: string;
  inputTurnId: string;
  text: string;
  sessionId?: string;
  agentId?: string | null;
  targetJid?: string | null;
  scope?: ActiveChannelOutboxScope;
}): Promise<ProactiveFinalFallbackDelivery> {
  const scopeRoute = input.scope?.chatId
    ? {
        provider: input.scope.provider,
        accountId: input.scope.accountId,
        sourceJid: input.scope.sourceJid,
        chatId: input.scope.chatId,
        rootId: input.scope.rootId,
        threadId: input.scope.threadId,
      }
    : null;
  const route =
    scopeRoute ??
    (input.targetJid ? resolveDurableChannelRoute(input.targetJid) : null);
  if (input.targetJid && route) {
    const delivered = await deliverIndependentChannelSystemNotice({
      logicalChatJid: input.logicalChatJid,
      scopeKey: input.scopeKey,
      targetJid: input.targetJid,
      originalInputTurnId: input.inputTurnId,
      originalRunId: input.scope?.turnRunId ?? `proactive:${input.inputTurnId}`,
      noticeKey: 'proactive-final-fallback',
      text: input.text,
      sender: 'happyclaw-agent',
      senderName: ASSISTANT_NAME,
      agentId: input.agentId,
      presentation: 'native',
      messageMeta: {
        turnId: input.inputTurnId,
        sessionId: input.sessionId,
        sourceKind: 'proactive_sdk_fallback',
        finalizationReason: 'completed',
      },
      route,
    });
    if (delivered) {
      return { projected: true, targetDelivered: true, path: 'native' };
    }
  }

  const messageId = `proactive_final_${crypto
    .createHash('sha256')
    .update(`${input.logicalChatJid}\0${input.inputTurnId}\0${input.text}`)
    .digest('hex')
    .slice(0, 32)}`;
  const webDelivery = await sendMessageWithOutcome(
    input.logicalChatJid,
    input.text,
    {
      sendToIM: false,
      messageId,
      messageMeta: {
        turnId: input.inputTurnId,
        sessionId: input.sessionId,
        sourceKind: 'proactive_sdk_fallback',
        finalizationReason: 'completed',
      },
    },
  );
  return {
    projected: webDelivery.targetDelivered,
    targetDelivered: !input.targetJid && webDelivery.targetDelivered,
    path: input.targetJid ? 'web_after_native_failure' : 'web',
  };
}

function resolveDurableChannelRoute(targetJid: string): {
  provider: string;
  accountId: string;
  sourceJid: string;
  chatId: string;
  rootId: string | null;
  threadId: string | null;
} | null {
  const address = parseChannelAddress(targetJid);
  if (!address) return null;
  const group = getRegisteredGroup(channelConversationJid(targetJid));
  const accountId = address.channelAccountId ?? group?.channel_account_id;
  if (!accountId) return null;
  return {
    provider: address.provider,
    accountId,
    sourceJid: targetJid,
    chatId: address.externalChatId,
    rootId: address.rootMessageId ?? null,
    threadId: address.threadId ?? null,
  };
}

async function sendTaskImageWithRetry(
  targetJid: string,
  imageBuffer: Buffer,
  mimeType: string,
  caption?: string,
  fileName?: string,
  outbox?: ChannelOutboxDeliveryRef,
): Promise<boolean> {
  if (!imManager.isChannelAvailableForJid(targetJid)) return false;
  const scoped = await deliverScopedChannelOutput(targetJid, outbox, {
    kind: 'image',
    payload: {
      mimeType,
      caption: caption ?? null,
      fileName: fileName ?? null,
      contentHash: crypto
        .createHash('sha256')
        .update(imageBuffer)
        .digest('hex'),
    },
    send: () =>
      imManager.sendImage(targetJid, imageBuffer, mimeType, caption, fileName),
  });
  if (scoped !== null) return scoped;
  return retryImOperation('send_task_image', targetJid, () =>
    imManager.sendImage(targetJid, imageBuffer, mimeType, caption, fileName),
  );
}

async function sendTaskFileWithRetry(
  targetJid: string,
  filePath: string,
  fileName: string,
  outbox?: ChannelOutboxDeliveryRef,
): Promise<boolean> {
  if (!imManager.isChannelAvailableForJid(targetJid)) return false;
  const scoped = await deliverScopedChannelOutput(targetJid, outbox, {
    kind: 'file',
    payload: {
      fileName,
      contentHash: crypto
        .createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex'),
    },
    send: () => imManager.sendFile(targetJid, filePath, fileName),
  });
  if (scoped !== null) return scoped;
  return retryImOperation('send_task_file', targetJid, () =>
    imManager.sendFile(targetJid, filePath, fileName),
  );
}

/**
 * Statuses that may still emit user-visible output.
 *
 * This is an allow-list on purpose. The previous deny-list rejected only
 * `cancelled` and `missed`, so a warm runner could keep delivering into a run
 * that had already settled as `success` or `failed` — output attributed to a
 * finished occurrence, after its result was recorded.
 *
 * `delivered` is included because it is not an execution terminal: group-mode
 * runs are marked `delivered` the moment the prompt is injected, and the real
 * Agent turn produces its output afterwards. Narrowing that is tracked
 * separately; doing it here would silently suppress group-mode task output.
 */
/**
 * Stable, machine-readable refusal for the per-turn reply fuse.
 *
 * The model must be able to tell "stop talking" from "retry later"; collapsing
 * every failure into one opaque string is what makes a looping model retry
 * forever. The limit itself is never stated, so it cannot be treated as a quota.
 */
const REPLY_LIMIT_REACHED_ERROR =
  'reply_limit_reached: this turn has already delivered its maximum number of user-visible messages. Do not retry or rephrase; end the turn now.';

const TASK_RUN_STATUSES_ACCEPTING_OUTPUT: ReadonlySet<TaskRunStatus> = new Set([
  'queued',
  'running',
  'retry_wait',
  'delivered',
]);

function taskRunAcceptsLateIpcOutput(runId: string | null): boolean {
  if (!runId) return true;
  const run = getTaskRunById(runId);
  return Boolean(run && TASK_RUN_STATUSES_ACCEPTING_OUTPUT.has(run.status));
}

async function settleAndRecordTaskIpcDeliveries(
  runId: string | null,
  attempts: TaskNotificationDeliveryAttempt[],
): Promise<{
  accepted: boolean;
  receipt: TaskRunNotificationReceipt;
}> {
  if (!taskRunAcceptsLateIpcOutput(runId)) {
    return {
      accepted: false,
      receipt: {
        status: 'skipped',
        summary: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          failed_channels: [],
        },
        error: 'Task run was cancelled before IPC delivery',
      },
    };
  }
  const outcome = await settleTaskNotificationDeliveries(attempts);
  if (runId) {
    recordTaskRunNotificationReceipt(
      runId,
      outcome.receipt,
      outcome.retryPayload,
    );
  }
  return { accepted: true, receipt: outcome.receipt };
}

/** Fire-and-forget wrapper for sendImWithRetry (used in non-await contexts). */
function sendImWithFailTracking(
  imJid: string,
  text: string,
  localImagePaths: string[],
  outbox?: ChannelOutboxDeliveryRef,
): void {
  sendImWithRetry(imJid, text, localImagePaths, outbox).catch(() => {});
}

export function isCursorAfter(
  candidate: MessageCursor,
  base: MessageCursor,
): boolean {
  if (candidate.timestamp > base.timestamp) return true;
  if (candidate.timestamp < base.timestamp) return false;
  return candidate.id > base.id;
}

export function normalizeCursor(value: unknown): MessageCursor {
  if (typeof value === 'string') {
    return { timestamp: value, id: '' };
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  ) {
    const maybeId = (value as { id?: unknown }).id;
    return {
      timestamp: (value as { timestamp: string }).timestamp,
      id: typeof maybeId === 'string' ? maybeId : '',
    };
  }
  return { ...EMPTY_CURSOR };
}

function sendSystemMessage(jid: string, type: string, detail: string): void {
  const msgId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__system__',
    'system',
    `${type}:${detail}`,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__system__',
    sender_name: 'system',
    content: `${type}:${detail}`,
    timestamp,
    is_from_me: true,
  });
}

function sendBillingDeniedMessage(jid: string, content: string): string {
  const msgId = `sys_quota_${Date.now()}`;
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__billing__',
    ASSISTANT_NAME,
    content,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__billing__',
    sender_name: ASSISTANT_NAME,
    content,
    timestamp,
    is_from_me: true,
  });
  return msgId;
}

/**
 * Persist + broadcast a plugin-expander system reply (e.g. command conflict,
 * docker container offline). Mirrors `sendBillingDeniedMessage` but uses the
 * `__plugin__` synthetic sender so audits can distinguish the two paths.
 *
 * When `imRouteJid` is a connected IM channel, also fan the reply out to that
 * channel so users on Feishu / Telegram / QQ / DingTalk see the response —
 * without this, plugin-expander system replies (conflict / offline-runner /
 * etc.) would silently drop on IM and the slash command appears to no-op
 * (#20 P1-1).
 */
async function sendPluginExpanderReply(
  jid: string,
  content: string,
  options: {
    originalMessageId: string;
    groupFolder: string;
    imRouteJid?: string | null;
    agentId?: string | null;
  },
): Promise<{ messageId: string; acknowledged: boolean }> {
  const msgId = `sys_plugin_${crypto
    .createHash('sha256')
    .update(`${jid}:${options.originalMessageId}`)
    .digest('hex')
    .slice(0, 24)}`;
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__plugin__',
    ASSISTANT_NAME,
    content,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__plugin__',
    sender_name: ASSISTANT_NAME,
    content,
    timestamp,
    is_from_me: true,
  });
  const imRouteJid = options.imRouteJid;
  if (!imRouteJid || !getChannelType(imRouteJid)) {
    return { messageId: msgId, acknowledged: true };
  }
  const address = parseChannelAddress(imRouteJid);
  const routeGroup = address
    ? getRegisteredGroup(channelConversationJid(imRouteJid))
    : undefined;
  const accountId = address?.channelAccountId ?? routeGroup?.channel_account_id;
  if (!address || !accountId) {
    logger.error(
      { jid, imRouteJid, originalMessageId: options.originalMessageId },
      'Suppressed plugin-expander IM reply without an exact channel account',
    );
    return { messageId: msgId, acknowledged: false };
  }

  const runtime = ChannelTurnRuntime.start({
    provider: address.provider,
    accountId,
    sourceJid: imRouteJid,
    chatId: address.externalChatId,
    rootId: address.rootMessageId,
    threadId: address.threadId,
    externalMessageId: `${options.originalMessageId}:plugin-expander-reply`,
    correlationId: options.originalMessageId,
    agentId: options.agentId ?? null,
    sessionId: getSession(options.groupFolder, options.agentId) ?? null,
  });
  if (runtime.executionDisposition !== 'execute') {
    const disposition = runtime.executionDisposition;
    if (disposition === 'manual_reconciliation') {
      const notified = await deliverChannelManualReconciliationNotice({
        logicalChatJid: jid,
        scopeKey: channelTurnScope(options.groupFolder, options.agentId),
        targetJid: imRouteJid,
        runtime,
        agentId: options.agentId,
        route: {
          provider: address.provider,
          accountId,
          sourceJid: imRouteJid,
          chatId: address.externalChatId,
          rootId: address.rootMessageId,
          threadId: address.threadId,
        },
      });
      runtime.dispose();
      return { messageId: msgId, acknowledged: notified };
    }
    const existing = getChannelTurnRun(runtime.runId);
    runtime.dispose();
    return {
      messageId: msgId,
      acknowledged: existing?.status === 'completed',
    };
  }

  const scopeKey = channelTurnScope(options.groupFolder, options.agentId);
  const scope = bindChannelOutboxScope(scopeKey, runtime, {
    provider: address.provider,
    accountId,
    sourceJid: imRouteJid,
    chatId: address.externalChatId,
    rootId: address.rootMessageId,
    threadId: address.threadId,
  });
  let acknowledged = false;
  try {
    acknowledged = await sendImWithRetry(imRouteJid, content, [], {
      scopeKey,
      scopeToken: scope.token,
      operationKey: `plugin-expander:${options.originalMessageId}:${msgId}`,
      ordinalSlot: 'plugin-expander-reply',
    });
    if (acknowledged) {
      acknowledged =
        runtime.markFinalizing() &&
        runtime.complete({
          cursorCommitted: true,
          replyDelivered: true,
          inputTurnId: options.originalMessageId,
        });
    } else {
      const uncertain = getUncertainChannelOutboxForTurn(runtime.runId);
      if (uncertain) {
        runtime.interrupt(
          `Plugin-expander delivery ${uncertain.id} is uncertain; manual reconciliation required`,
        );
      } else {
        runtime.retry('Plugin-expander reply was not physically acknowledged');
      }
    }
  } finally {
    activeChannelOutboxScopes.unbind(scopeKey, scope);
    runtime.dispose();
  }
  return { messageId: msgId, acknowledged };
}

function getSessionClaudeDir(folder: string, agentId?: string): string {
  return agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', folder, '.claude');
}

async function clearSessionRuntimeFiles(
  folder: string,
  agentId?: string,
): Promise<void> {
  const claudeDir = getSessionClaudeDir(folder, agentId);
  if (!fs.existsSync(claudeDir)) return;

  let cleared = false;
  try {
    for (const entry of fs.readdirSync(claudeDir)) {
      if (entry === 'settings.json') continue;
      fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
    }
    cleared = true;
  } catch {
    logger.info(
      { folder, agentId },
      'Direct session cleanup failed, trying Docker fallback',
    );
  }

  if (!cleared) {
    try {
      await execFileAsync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${claudeDir}:/target`,
          CONTAINER_IMAGE,
          'sh',
          '-c',
          'find /target -mindepth 1 -not -name settings.json -exec rm -rf {} + 2>/dev/null; exit 0',
        ],
        { timeout: 15_000 },
      );
    } catch (err) {
      logger.error({ folder, agentId, err }, 'Docker fallback cleanup failed');
    }
  }
}

/**
 * Slash command handler for IM channels (Feishu/Telegram).
 * Returns a reply string on success, or null if command not recognized.
 * @param senderImId 发送者的 IM 标识符（如飞书 open_id），由支持的 IM 通道传入
 */
async function handleCommand(
  chatJid: string,
  command: string,
  senderImId?: string,
  mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>,
): Promise<string | null> {
  const parts = command.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rawArgs = command.slice(parts[0].length).trim();

  // Owner gate for destructive IM commands. See OWNER_REQUIRED_IM_COMMANDS
  // doc in im-command-utils.ts for the exclusion rationale (notably
  // /owner_mention stays open as the bootstrap path for unowned groups).
  let group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);

  // DM auto-claim: in a 1:1 IM chat the sender is unambiguously the owner, so
  // claim them on the first owner-required command instead of forcing a
  // separate /owner_mention (pure friction for a single-person DM). Group
  // chats never auto-claim — isDirectMessageJid returns false for them, so the
  // first commander can't silently grab ownership. Feishu already auto-sets
  // owner_im_id via its DM owner-learn path, so this only kicks in for the
  // non-Feishu channels that buildOnNewChat leaves unowned.
  if (
    OWNER_REQUIRED_IM_COMMANDS.has(cmd) &&
    group &&
    !group.owner_im_id &&
    group.owner_claim_source !== 'transfer_reset' &&
    senderImId &&
    isDirectMessageJid(chatJid)
  ) {
    const claimed = claimOwner(group, senderImId);
    persistGroupUpdate(chatJid, claimed, registeredGroups);
    group = claimed;
    logger.info(
      { chatJid, senderImId },
      'Auto-claimed DM owner on first owner-required command',
    );
  }

  const ownerCheck = checkImOwnerCommand(cmd, group, senderImId);
  if (!ownerCheck.ok) {
    return `⚠️ ${ownerCheck.reason}`;
  }

  switch (cmd) {
    case 'clear':
      return handleClearCommand(chatJid);
    case 'list':
    case 'ls':
      return handleListCommand(chatJid);
    case 'status':
      return handleStatusCommand(chatJid);
    case 'recall':
    case 'rc':
      return handleRecallCommand(chatJid);
    case 'where':
      return handleWhereCommand(chatJid);
    case 'unbind':
      return handleUnbindCommand(chatJid);
    case 'bind':
      return handleBindCommand(chatJid, rawArgs);
    case 'new':
      return handleNewCommand(chatJid, rawArgs);
    case 'require_mention':
      return handleRequireMentionCommand(chatJid, rawArgs, senderImId);
    case 'owner_mention':
      return handleOwnerMentionCommand(chatJid, senderImId);
    case 'release_owner':
      return handleReleaseOwnerCommand(chatJid);
    case 'sw':
    case 'spawn':
      return handleSpawnCommand(chatJid, rawArgs, chatJid);
    case 'allow':
      return handleAllowCommand(chatJid, senderImId, mentions);
    case 'disallow':
      return handleDisallowCommand(chatJid, senderImId, mentions);
    case 'allowlist':
      return handleAllowlistCommand(chatJid);
    default:
      return null;
  }
}

async function handleClearCommand(chatJid: string): Promise<string> {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前工作区';

  const target = resolveBoundChatTarget(
    chatJid,
    group,
    (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
    getAgent,
    findGroupNameByFolder,
    resolveWorkspaceJid,
  );
  if (!target) return '当前绑定目标不存在，请先重新绑定工作区或会话。';

  try {
    await executeSessionReset(
      target.baseChatJid,
      target.folder,
      {
        queue,
        sessions,
        broadcast: broadcastNewMessage,
        setLastAgentTimestamp: setCursors,
      },
      target.agentId ?? undefined,
    );
    return '已清除对话上下文 ✓';
  } catch (err) {
    logger.error(
      {
        chatJid,
        targetChatJid: target.targetChatJid,
        targetFolder: target.folder,
        agentId: target.agentId,
        err,
      },
      'handleCommand /clear failed',
    );
    return '清除上下文失败，请稍后重试';
  }
}

/**
 * Collect all accessible workspaces for a user as pure WorkspaceInfo[].
 */
function collectWorkspaces(userId: string): WorkspaceInfo[] {
  const ownedGroups = getGroupsByOwner(userId);

  const seen = new Set<string>();
  const workspaces: WorkspaceInfo[] = [];

  for (const g of ownedGroups) {
    if (!g.jid.startsWith('web:')) continue;
    if (seen.has(g.folder)) continue;
    seen.add(g.folder);

    const agents = listAgentsByJid(g.jid)
      .filter((a) => a.kind === 'conversation')
      .map((a) => ({ id: a.id, name: a.name, status: a.status }));

    workspaces.push({ folder: g.folder, name: g.name, agents });
  }

  return workspaces;
}

function resolveBindingTarget(
  userId: string,
  rawSpec: string,
): {
  target_agent_id?: string;
  target_main_jid?: string;
  display: string;
} | null {
  const spec = rawSpec.trim();
  if (!spec) return null;

  const [workspaceSpecRaw, sessionSpecRaw] = spec.split('/', 2);
  const workspaceSpec = workspaceSpecRaw.trim().toLowerCase();
  const sessionSpec = sessionSpecRaw?.trim().toLowerCase();
  const workspaces = collectWorkspaces(userId);
  const workspace = workspaces.find(
    (ws) =>
      ws.folder.toLowerCase() === workspaceSpec ||
      ws.name.trim().toLowerCase() === workspaceSpec,
  );
  if (!workspace) return null;

  if (
    !sessionSpec ||
    sessionSpec === 'main' ||
    sessionSpec === '主会话' ||
    sessionSpec === '主对话'
  ) {
    const mainJid = findWebJidForFolder(workspace.folder);
    if (!mainJid) return null;
    return {
      target_main_jid: mainJid,
      display: `${workspace.name} / 主会话`,
    };
  }

  const agent = workspace.agents.find(
    (item) =>
      item.id.toLowerCase().startsWith(sessionSpec) ||
      item.name.trim().toLowerCase() === sessionSpec,
  );
  if (!agent) return null;

  return {
    target_agent_id: agent.id,
    display: `${workspace.name} / ${agent.name}`,
  };
}

/**
 * Find the primary web JID for a folder (the one used for web:xxx groups).
 */
function findWebJidForFolder(folder: string): string | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder && jid.startsWith('web:')) return jid;
  }
  const jids = getJidsByFolder(folder);
  for (const jid of jids) {
    if (jid.startsWith('web:')) return jid;
  }
  return null;
}

/**
 * Find the display name for a folder by looking up its web group.
 */
function findGroupNameByFolder(folder: string): string {
  const webJid = findWebJidForFolder(folder);
  if (webJid) {
    const group = registeredGroups[webJid] ?? getRegisteredGroup(webJid);
    if (group) return group.name;
  }
  return folder;
}

/**
 * Fetch recent messages and format a context summary.
 */
function getConversationContext(
  folder: string,
  agentId: string | null,
  count = 5,
  maxLen = 80,
): string {
  const webJid = findWebJidForFolder(folder);
  if (!webJid) return '';

  const chatJidForMsg = agentId ? `${webJid}#agent:${agentId}` : webJid;
  const messages = getMessagesPage(chatJidForMsg, undefined, count);

  if (messages.length === 0) return '\n\n📭 该对话暂无消息记录';

  const formatted = formatContextMessages(messages.reverse(), maxLen);
  return formatted || '\n\n📭 该对话暂无消息记录';
}

function handleListCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';

  const userId = group.created_by;
  if (!userId) return '无法确定用户身份';

  const workspaces = collectWorkspaces(userId);
  if (workspaces.length === 0) return '没有可用的工作区';

  const lookupGroup = (jid: string) =>
    registeredGroups[jid] ?? getRegisteredGroup(jid);
  const location = resolveLocationInfo(
    group,
    lookupGroup,
    getAgent,
    findGroupNameByFolder,
  );

  const currentAgentId = group.target_agent_id ?? null;
  const currentOnMain = !currentAgentId;

  return (
    formatWorkspaceList(
      workspaces,
      location.folder,
      currentAgentId,
      currentOnMain,
    ) + '\n💡 使用 /bind <workspace> 或 /bind <workspace>/<会话短ID>'
  );
}

function handleStatusCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';

  const lookupGroup = (jid: string) =>
    registeredGroups[jid] ?? getRegisteredGroup(jid);
  const location = resolveLocationInfo(
    group,
    lookupGroup,
    getAgent,
    findGroupNameByFolder,
  );

  const queueStatus = queue.getStatus();
  const settings = getSystemSettings();

  // Check if the current group's folder is active or queued
  const groupState = queueStatus.groups.find((g) => {
    const rg = lookupGroup(g.jid);
    return rg?.folder === location.folder;
  });
  const isActive = !!groupState?.active;
  const queuePosition =
    !isActive && queueStatus.waitingGroupJids.includes(chatJid)
      ? queueStatus.waitingGroupJids.indexOf(chatJid) + 1
      : null;

  return formatSystemStatus(
    location,
    {
      activeContainerCount: queueStatus.activeContainerCount,
      activeHostProcessCount: queueStatus.activeHostProcessCount,
      maxContainers: settings.maxConcurrentContainers,
      waitingCount: queueStatus.waitingCount,
      waitingGroupJids: queueStatus.waitingGroupJids,
    },
    isActive,
    queuePosition,
  );
}

function handleWhereCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';

  const lookupGroup = (jid: string) =>
    registeredGroups[jid] ?? getRegisteredGroup(jid);
  const location = resolveLocationInfo(
    group,
    lookupGroup,
    getAgent,
    findGroupNameByFolder,
  );

  const lines = [`📍 当前绑定: ${location.locationLine}`];
  if (location.replyPolicy) {
    lines.push(`🔁 回复策略: ${location.replyPolicy}`);
  }
  return lines.join('\n');
}

function handleUnbindCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';
  if (!unbindImGroup(chatJid, 'IM slash command restore default')) {
    return '无法恢复 Bot 默认工作区，已保留当前绑定。请检查渠道账号的默认工作区设置。';
  }
  return '已恢复 Bot 默认工作区。';
}

function handleBindCommand(chatJid: string, rawSpec: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';
  const userId = group.created_by;
  if (!userId) return '无法确定当前聊天所属用户';
  if (!rawSpec)
    return '用法: /bind <workspace> 或 /bind <workspace>/<会话短ID>';

  const resolved = resolveBindingTarget(userId, rawSpec);
  if (!resolved) {
    return '未找到目标。先用 /list 查看工作区和会话短 ID，再执行 /bind <workspace>/<会话短ID>';
  }

  const channelType = getChannelType(chatJid);
  const threadMapCapable =
    group.binding_mode === 'thread_map' ||
    isThreadMapCapableChat({
      channel_type: channelType,
      chat_mode: group.feishu_chat_mode,
      group_message_type: group.feishu_group_message_type,
    });
  if (threadMapCapable && resolved.target_agent_id) {
    return '飞书话题群只能绑定工作区，不能绑定单个会话。请使用 /bind <workspace>。';
  }
  if (!threadMapCapable && resolved.target_main_jid) {
    return '普通群和私聊只能绑定具体会话。请使用 /bind <workspace>/<会话短ID>。';
  }

  const updated: RegisteredGroup = resolved.target_agent_id
    ? buildSessionMountUpdate(group, resolved.target_agent_id, {
        replyPolicy: 'source_only',
      })
    : buildWorkspaceMountUpdate(
        group,
        resolved.target_main_jid!,
        'thread_map',
        { replyPolicy: 'source_only' },
      );
  setRegisteredGroup(chatJid, updated);
  registeredGroups[chatJid] = updated;
  if (updated.binding_mode === 'thread_map') {
    markThreadMapWorkspace(updated.target_main_jid);
  }
  imSendFailCounts.delete(chatJid);
  imHealthCheckFailCounts.delete(chatJid);
  return `已切换到 ${resolved.display}\n🔁 回复策略: source_only`;
}

async function handleNewCommand(
  chatJid: string,
  rawName: string,
): Promise<string> {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';
  const userId = group.created_by;
  if (!userId) return '无法确定当前聊天所属用户';

  const name = rawName.trim();
  if (!name) return '用法: /new <工作区名称>';
  if (name.length > 50) return '名称过长（最多 50 字符）';

  // Create a new workspace (same pattern as routes/groups.ts POST)
  const newJid = `web:${crypto.randomUUID()}`;
  const folder = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  const newGroup: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: (await isDockerAvailable()) ? 'container' : 'host',
    created_by: userId,
  };

  // Register the workspace
  registerGroup(newJid, newGroup);
  ensureChatExists(newJid);
  updateChatName(newJid, name);
  const threadMapCapable = isThreadMapCapableChat({
    channel_type: getChannelType(chatJid),
    chat_mode: group.feishu_chat_mode,
    group_message_type: group.feishu_group_message_type,
  });
  let updated: RegisteredGroup;
  let targetLabel: string;
  if (threadMapCapable) {
    updated = buildWorkspaceMountUpdate(group, newJid, 'thread_map', {
      replyPolicy: 'source_only',
    });
    markThreadMapWorkspace(newJid);
    targetLabel = '工作区';
  } else {
    const created = createAutoImConversationAgent({
      userId,
      sourceJid: chatJid,
      groupFolder: folder,
      name: group.name || '默认会话',
    });
    if (!created) return `工作区「${name}」已创建，但自动创建绑定会话失败。`;
    updated = buildSessionMountUpdate(group, created.agentId, {
      replyPolicy: 'source_only',
    });
    targetLabel = `会话「${group.name || '默认会话'}」`;
  }
  setRegisteredGroup(chatJid, updated);
  registeredGroups[chatJid] = updated;
  imSendFailCounts.delete(chatJid);
  imHealthCheckFailCounts.delete(chatJid);

  return `工作区「${name}」已创建，并绑定到${targetLabel}\n📁 ${folder}\n🔁 回复策略: source_only\n\n发送 /unbind 可解除绑定`;
}

function handleRequireMentionCommand(
  chatJid: string,
  rawArgs: string,
  senderImId?: string,
): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前会话';

  // owner_im_id 已存在时，无论 activation_mode 是什么，非 owner 都不能改 activation_mode：
  // 否则任意成员可以 /require_mention false 把群从 auto/when_mentioned/owner_mentioned 翻成
  // always，相当于聊天提权。owner_im_id 未设置时仍放行（bootstrap path）。
  if (group.owner_im_id) {
    if (!senderImId || senderImId !== group.owner_im_id) {
      return '⚠️ 只有工作区 owner 才能修改此设置';
    }
  }

  const action = rawArgs.trim().toLowerCase();
  if (group.feishu_chat_mode === 'p2p') {
    return '飞书私聊始终直接响应，不支持 @ 激活模式。';
  }
  if (action === 'true') {
    // 如果当前是 owner_mentioned 模式，切换为 when_mentioned 但保留 owner
    // 注意：不清空 owner_im_id —— owner 是工作区认领标识，非 owner 通过
    // 切换 activation_mode 不应该获得清掉 owner、再 /owner_mention 自我夺权的能力。
    if (group.activation_mode === 'owner_mentioned') {
      const updated: RegisteredGroup = {
        ...group,
        require_mention: true,
        activation_mode: 'when_mentioned',
      };
      if (!persistActivationAwareGroupUpdate(chatJid, group, updated)) {
        return '需要 @ 模式会为每个话题创建独立会话，请先把当前聊天绑定到工作区。';
      }
      return '已从「仅 owner 响应」切换为「需要 @机器人」模式，所有人 @机器人 均可触发';
    }
    const updated: RegisteredGroup = { ...group, require_mention: true };
    if (!persistActivationAwareGroupUpdate(chatJid, group, updated)) {
      return '需要 @ 模式会为每个话题创建独立会话，请先把当前聊天绑定到工作区。';
    }
    return '已开启：群聊中需要 @机器人 才会响应';
  } else if (action === 'false') {
    // 关闭 require_mention 时退出 owner_mentioned 模式，但保留 owner_im_id：
    // owner 身份是工作区的安全锚点（owner-required 命令依据它鉴权），不能因为
    // 切换激活策略就被任意人通过 /require_mention false 重置。
    const updated: RegisteredGroup = {
      ...group,
      require_mention: false,
      activation_mode: 'always',
    };
    persistActivationAwareGroupUpdate(chatJid, group, updated);
    return '已关闭：群聊中所有消息都会响应，无需 @机器人';
  } else if (!action) {
    const current = group.require_mention === true;
    return `当前 require_mention: ${current}\n\n用法:\n/require_mention true — 需要 @机器人\n/require_mention false — 全量响应`;
  }
  return '用法: /require_mention true|false';
}

/**
 * /owner_mention 命令：将当前发送者认领为群组 owner（owner-only 命令的鉴权锚点）。
 * 仅写入 owner_im_id，不修改 activation_mode —— 群组的激活策略（auto / always /
 * when_mentioned / owner_mentioned）保持不变。
 * 已有 owner 时（任意 activation_mode），只有当前 owner 本人可幂等地重发，
 * 其他人会被拒绝以防夺权。
 */
function handleOwnerMentionCommand(
  chatJid: string,
  senderImId?: string,
): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前会话';

  if (!senderImId) {
    return '无法识别发送者身份，请在飞书或钉钉群聊中使用此命令';
  }

  if (group.owner_claim_source === 'transfer_reset') {
    return '⚠️ 此会话刚完成凭据转移，请重新配对或在 Web 中配置 owner';
  }

  // 已有 owner 时，任意 activation_mode 下都拒绝非 owner 的认领，避免任意人通过
  // /owner_mention 覆盖已存在的 owner_im_id（哪怕群组当前是 'auto' / 'always' /
  // 'when_mentioned' 模式，owner_im_id 也可能由 /allow 回填或别处设置过）。
  // 当前 sender 就是 owner 本人时允许，保持幂等。
  if (group.owner_im_id && group.owner_im_id !== senderImId) {
    return '⚠️ 该群组已有 owner，无法重新认领';
  }

  // 仅认领 owner，不强制切换 activation_mode：用户当前的群组激活策略（auto /
  // always / when_mentioned）保持不变，避免 bootstrap 时被意外改成「仅 owner 响应」。
  const updated = claimOwnerFromMention(group, senderImId);
  persistGroupUpdate(chatJid, updated, registeredGroups);

  logger.info(
    { chatJid, senderImId, activationMode: updated.activation_mode },
    'Owner claimed via /owner_mention command',
  );

  return `已认领工作区 owner\n\n你的 IM 标识: ${senderImId}\n后续 /clear、/bind、/spawn 等 owner-only 命令将以你为准。\n群组激活策略保持不变（当前: ${updated.activation_mode ?? 'auto'}）。`;
}

/**
 * /release_owner 命令：当前 owner 主动释放 owner 身份（reclaim path）。
 * `checkImOwnerCommand` 已在 handleCommand 顶部确保 sender === owner_im_id。
 * 同时清空 sender_allowlist（避免新 owner 被旧 owner 的白名单锁死、/allow 也
 * 无法自救），并把 owner_mentioned 模式降级为 when_mentioned（否则清掉 owner
 * 后 isGroupOwnerMessage 永远返回 false，bot 会在群里全员沉默）。
 */
function handleReleaseOwnerCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前工作区';
  const updated = releaseOwner(group);
  persistGroupUpdate(chatJid, updated, registeredGroups);
  logger.info({ chatJid }, 'Owner released via /release_owner');
  return '✅ 已释放 owner 身份。白名单已清空，激活策略已调整为 when_mentioned（如原本是 owner-only）。下一位用户可发送 /owner_mention 重新认领。';
}

/**
 * /allow @成员 命令：将 @提及的成员加入发言者白名单（仅 owner 可操作）。
 */
function handleAllowCommand(
  chatJid: string,
  senderImId?: string,
  mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>,
): string {
  if (!senderImId) return '无法识别发送者身份';
  let group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前会话';

  // Backfill owner_im_id if the group was registered before the user-level
  // ownerOpenId was known (e.g., bot added to group first, owner DM'd later).
  // Only backfill when the sender matches the user-level ownerOpenId.
  if (
    !group.owner_im_id &&
    group.owner_claim_source !== 'transfer_reset' &&
    group.created_by
  ) {
    const userOwnerOpenId = getUserFeishuConfig(group.created_by)?.ownerOpenId;
    if (userOwnerOpenId && userOwnerOpenId === senderImId) {
      const updated = claimOwner(group, senderImId);
      persistGroupUpdate(chatJid, updated, registeredGroups);
      group = updated;
      logger.info(
        { chatJid, senderImId },
        'Backfilled owner_im_id via /allow (matched user-level ownerOpenId)',
      );
    }
  }

  if (!group.owner_im_id) {
    return '尚未识别到 owner，请先向机器人发一条私信以完成身份识别';
  }
  if (group.owner_im_id !== senderImId) {
    return '只有 bot owner 才能修改白名单';
  }

  const toAdd = (mentions ?? [])
    .map((m) => m.id?.open_id)
    .filter((id): id is string => !!id && id !== senderImId);

  if (toAdd.length === 0) {
    return '请 @提及 要加入白名单的群成员：/allow @成员';
  }

  const { group: updated, added } = addToAllowlist(group, senderImId, toAdd);
  if (added.length === 0) {
    return '这些成员已在白名单中';
  }
  persistGroupUpdate(chatJid, updated, registeredGroups);
  logger.info(
    { chatJid, senderImId, added },
    'Members added to sender allowlist',
  );

  return `已将 ${added.length} 名成员加入白名单（当前共 ${updated.sender_allowlist!.length} 人）`;
}

/**
 * /disallow @成员 命令：将 @提及的成员从发言者白名单移除（仅 owner 可操作）。
 * owner 本人不能被移除。
 */
function handleDisallowCommand(
  chatJid: string,
  senderImId?: string,
  mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>,
): string {
  if (!senderImId) return '无法识别发送者身份';
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前会话';

  if (!group.owner_im_id || group.owner_im_id !== senderImId) {
    return '只有 bot owner 才能修改白名单';
  }
  if (!group.sender_allowlist || group.sender_allowlist.length === 0) {
    return '白名单为空';
  }

  const toRemove = (mentions ?? [])
    .map((m) => m.id?.open_id)
    .filter((id): id is string => !!id);

  if (toRemove.length === 0) {
    return '请 @提及 要从白名单移除的群成员：/disallow @成员';
  }
  if (toRemove.includes(senderImId)) {
    return 'Owner 不能将自己移出白名单';
  }

  const { group: updated, removed } = removeFromAllowlist(group, toRemove);
  if (removed === 0) {
    // Nothing matched — skip the no-op persist (mirrors handleAllowCommand's
    // early return when added.length === 0; avoids a redundant full-row write).
    return `这些成员不在白名单中（当前共 ${group.sender_allowlist!.length} 人）`;
  }
  persistGroupUpdate(chatJid, updated, registeredGroups);
  logger.info(
    { chatJid, senderImId, removed: toRemove },
    'Members removed from sender allowlist',
  );

  return `已将 ${removed} 名成员从白名单移除（当前共 ${updated.sender_allowlist!.length} 人）`;
}

/**
 * /allowlist 命令：查看当前群组的发言者白名单。
 */
function handleAllowlistCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前会话';

  const allowlist = group.sender_allowlist;
  if (allowlist === undefined || allowlist === null) {
    return '当前群组未启用白名单模式（所有人均可触发）';
  }
  if (allowlist.length === 0) {
    return `白名单模式已启用，当前无人可触发。\nOwner: ${group.owner_im_id ?? '未识别（请先向机器人发一条私信）'}`;
  }

  const ownerMark = (id: string) =>
    id === group.owner_im_id ? ' (owner)' : '';
  const lines = allowlist.map((id, i) => `${i + 1}. ${id}${ownerMark(id)}`);
  return `白名单（${allowlist.length} 人）：\n${lines.join('\n')}`;
}

const recallCooldowns = new Map<string, number>();

async function handleRecallCommand(chatJid: string): Promise<string> {
  logger.info({ chatJid }, '/recall command received');

  const now = Date.now();
  const lastRecall = recallCooldowns.get(chatJid) || 0;
  if (now - lastRecall < 10000) {
    return '⏳ 请稍后再试（冷却中）';
  }
  recallCooldowns.set(chatJid, now);

  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) {
    logger.warn({ chatJid }, '/recall: no registered group found');
    return '当前 IM 未绑定工作区';
  }

  // Resolve binding target — use bound workspace/agent if present
  let targetJid: string | undefined;
  let targetFolder: string;
  let targetAgentId: string | null = null;
  let headerName: string;

  if (group.target_agent_id) {
    const agent = getAgent(group.target_agent_id);
    const parent = agent
      ? (registeredGroups[agent.chat_jid] ?? getRegisteredGroup(agent.chat_jid))
      : null;
    const workspaceName = parent?.name || parent?.folder || group.folder;
    headerName = `${workspaceName} / ${agent?.name || group.target_agent_id}`;
    targetFolder = parent?.folder || group.folder;
    targetAgentId = group.target_agent_id;
    targetJid = agent
      ? `${agent.chat_jid}#agent:${group.target_agent_id}`
      : undefined;
  } else if (group.target_main_jid) {
    const target =
      registeredGroups[group.target_main_jid] ??
      getRegisteredGroup(group.target_main_jid);
    headerName = `${target?.name || group.target_main_jid} / 主会话`;
    targetFolder = target?.folder || group.folder;
    targetJid = group.target_main_jid;
  } else {
    headerName = `${findGroupNameByFolder(group.folder)} / 主会话`;
    targetFolder = group.folder;
    targetJid = findWebJidForFolder(group.folder) ?? undefined;
  }

  const header = `🧠 ${headerName}`;

  if (!targetJid) {
    logger.warn({ chatJid, targetFolder }, '/recall: no JID found for target');
    return `${header}\n\n📭 该对话暂无消息记录`;
  }

  // Fetch recent messages for summarization
  const messages = getMessagesPage(targetJid, undefined, 10);
  logger.info(
    { chatJid, targetJid, messageCount: messages.length },
    '/recall: fetched messages',
  );

  if (messages.length === 0) return `${header}\n\n📭 该对话暂无消息记录`;

  // Build chronological transcript
  const transcript = messages
    .reverse()
    .map((msg) => {
      const who = msg.is_from_me ? 'AI' : msg.sender_name || '用户';
      const text = (msg.content || '').slice(0, 300);
      return `${who}: ${text}`;
    })
    .join('\n');

  logger.info(
    { chatJid, transcriptLen: transcript.length },
    '/recall: built transcript, calling Claude CLI',
  );

  // Try to summarize via Claude CLI
  const summary = await summarizeWithClaude(transcript);
  if (summary) {
    logger.info(
      { chatJid, summaryLen: summary.length },
      '/recall: summary generated successfully',
    );
    return `${header}\n\n${summary}`;
  }

  logger.warn(
    { chatJid },
    '/recall: summary failed, falling back to raw messages',
  );

  // Fallback: raw context if CLI unavailable
  const context = getConversationContext(targetFolder, targetAgentId, 10, 200);
  if (!context) return `${header}\n\n📭 该对话暂无消息记录`;
  return header + context;
}

/**
 * Summarize a conversation transcript using Claude Agent SDK.
 * Uses the provider configured in the web settings page.
 */
async function summarizeWithClaude(transcript: string): Promise<string | null> {
  const prompt = `请用简洁的中文总结以下对话的要点和进展，重点说明讨论了什么、达成了什么结论、还有什么待办事项。不要逐条翻译，而是提炼核心信息。\n\n${transcript}`;
  const model = process.env.RECALL_MODEL || undefined;
  return sdkQuery(prompt, { model, timeout: 30_000 });
}

/**
 * After an agent conversation's first reply finalizes, upgrade the placeholder
 * title to an LLM-generated one. Fire-and-forget; optimistically flips
 * title_source to 'auto' up-front so concurrent replies don't double-trigger.
 */
async function generateAndApplyLLMTitle(
  agentId: string,
  chatJid: string,
  virtualChatJid: string,
): Promise<void> {
  updateAgentContextInfo(agentId, { title_source: 'auto' });

  // Notify clients that title generation has started → show loading indicator.
  broadcastTitleGenerating(chatJid, agentId, true);

  let finalName: string | undefined;
  try {
    const recent = getMessagesPage(virtualChatJid, undefined, 6)
      .slice()
      .reverse();
    const firstUser = recent.find((m) => !m.is_from_me);
    const firstAI = recent.find((m) => m.is_from_me);
    if (!firstUser) return;

    const userText = (firstUser.content || '').slice(0, 500);
    const aiText = (firstAI?.content || '').slice(0, 500);
    const prompt =
      `根据以下对话生成一个简洁的中文标题，用于在会话列表中展示。要求：\n` +
      `- 不超过 16 个字符\n` +
      `- 概括用户的核心诉求\n` +
      `- 不要加标点、引号、emoji、括号\n` +
      `- 直接输出标题，不要解释\n\n` +
      `用户: ${userText}\n` +
      (aiText ? `AI: ${aiText}\n` : '');

    const raw = await sdkQuery(prompt, { timeout: 20_000 });
    if (!raw) return;

    const cleaned = raw
      .trim()
      .split('\n')[0]
      .replace(/^["'「『《【\[(]+|["'」』》】\])]+$/g, '')
      .trim()
      .slice(0, 20);
    if (!cleaned) return;

    // Re-check title_source: user may have manually renamed during the LLM window.
    const currentAgent = getAgent(agentId);
    if (currentAgent?.title_source !== 'auto') {
      logger.info(
        `[llm-title] skip applying generated title for agent=${agentId} because title_source=${currentAgent?.title_source}`,
      );
    } else {
      updateAgentContextInfo(agentId, { name: cleaned });
      updateChatName(virtualChatJid, cleaned);
      finalName = cleaned;
    }
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message?.slice(0, 200),
        agentId,
      },
      'LLM title generation failed',
    );
  } finally {
    // Always clear loading indicator, whether LLM succeeded, returned empty, or threw.
    broadcastTitleGenerating(chatJid, agentId, false, finalName);
  }
}

// ─── /sw & /spawn: parallel task spawning ────────────────────────

interface SpawnWorkspace {
  homeChatJid: string;
  homeGroup: RegisteredGroup;
  effectiveGroup: RegisteredGroup;
}

/**
 * Resolve the workspace for a /spawn command.
 * Returns a SpawnWorkspace on success, or an error message string on failure.
 */
function resolveSpawnWorkspace(
  baseJid: string,
  group: RegisteredGroup,
  userId: string,
): SpawnWorkspace | string {
  let homeChatJid: string;
  let homeGroup: RegisteredGroup;

  if (group.target_main_jid || group.target_agent_id) {
    const target = resolveBoundChatTarget(
      baseJid,
      group,
      (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
      getAgent,
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );
    if (!target) {
      return group.target_agent_id
        ? '绑定会话所属的工作区不存在'
        : '绑定的工作区不存在';
    }
    const targetGroup =
      registeredGroups[target.baseChatJid] ??
      getRegisteredGroup(target.baseChatJid);
    if (!targetGroup) {
      return group.target_agent_id
        ? '绑定会话所属的工作区不存在'
        : '绑定的工作区不存在';
    }
    homeChatJid = target.baseChatJid;
    homeGroup = targetGroup;
  } else if (baseJid.startsWith('web:')) {
    homeChatJid = baseJid;
    homeGroup = group;
  } else {
    // IM group not bound — use the user's home workspace
    const userHome = getUserHomeGroup(userId);
    if (!userHome) return '未找到用户主工作区';
    homeChatJid = `web:${userHome.folder}`;
    // Lookup the RegisteredGroup object — prefer the web: JID, fall back to any JID for this folder
    const homeJids = getJidsByFolder(userHome.folder);
    const webJid = homeJids.find((j) => j.startsWith('web:')) ?? homeJids[0];
    const resolvedHome = webJid
      ? (registeredGroups[webJid] ?? getRegisteredGroup(webJid))
      : undefined;
    if (!resolvedHome) return '未找到用户主工作区';
    homeGroup = resolvedHome;
  }

  const { effectiveGroup } = resolveEffectiveGroup(homeGroup);
  return { homeChatJid, homeGroup, effectiveGroup };
}

async function handleSpawnCommand(
  chatJid: string,
  rawMessage: string,
  sourceImJid?: string,
): Promise<string> {
  const message = rawMessage.trim();
  if (!message) return '用法: /sw <任务描述>\n在当前工作区创建并行任务';

  const baseJid = stripVirtualJidSuffix(chatJid);
  const group = registeredGroups[baseJid] ?? getRegisteredGroup(baseJid);
  if (!group) return '未找到当前工作区';
  const userId = group.created_by;
  if (!userId) return '无法确定当前聊天所属用户';

  const resolved = resolveSpawnWorkspace(baseJid, group, userId);
  if (typeof resolved === 'string') return resolved;
  const { homeChatJid, effectiveGroup } = resolved;

  // 3. Determine the spawned_from_jid (where to inject results back)
  //    For IM: resolve to the effective web JID so results enter the web message stream
  //    For Web: use the chatJid directly (may include #agent: for agent-scoped spawn)
  const spawnedFromJid = sourceImJid ? homeChatJid : chatJid;

  const now = new Date().toISOString();
  const agentId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const user = getUserById(userId);
  const senderName = user?.display_name || user?.username || userId;
  const truncatedName =
    message.length > 30 ? message.slice(0, 30) + '…' : message;
  const agentName = `⚡ ${truncatedName}`;

  // Create agent record
  const newAgent: SubAgent = {
    id: agentId,
    group_folder: effectiveGroup.folder,
    chat_jid: homeChatJid,
    name: agentName,
    prompt: '',
    status: 'idle',
    kind: 'spawn',
    created_by: userId,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: sourceImJid ?? null,
    spawned_from_jid: spawnedFromJid,
  };
  createAgent(newAgent);

  // Create IPC + session directories
  ensureAgentDirectories(effectiveGroup.folder, agentId);

  // Create virtual chat + store user's message in it
  const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
  ensureChatExists(virtualChatJid);
  updateChatName(virtualChatJid, agentName);
  storeMessageDirect(
    messageId,
    virtualChatJid,
    userId,
    senderName,
    message,
    now,
    false,
    sourceImJid ? { sourceJid: sourceImJid } : undefined,
  );
  broadcastNewMessage(virtualChatJid, {
    id: messageId,
    chat_jid: virtualChatJid,
    sender: userId,
    sender_name: senderName,
    content: message,
    timestamp: now,
    is_from_me: false,
  });

  broadcastAgentStatus(
    homeChatJid,
    agentId,
    'idle',
    agentName,
    '',
    undefined,
    'spawn',
  );

  // For IM-originated /sw, mirror the command into homeChatJid so Web chat
  // shows what was requested. Web path handles this in web.ts instead.
  if (sourceImJid) {
    ensureChatExists(homeChatJid);
    // source_kind='user_command' prevents the polling loop from picking it up.
    const cmdId = crypto.randomUUID();
    storeMessageDirect(
      cmdId,
      homeChatJid,
      userId,
      senderName,
      `/sw ${message}`,
      now,
      false,
      {
        meta: { sourceKind: 'user_command' },
      },
    );
    broadcastNewMessage(homeChatJid, {
      id: cmdId,
      chat_jid: homeChatJid,
      sender: userId,
      sender_name: senderName,
      content: `/sw ${message}`,
      timestamp: now,
      is_from_me: false,
    });
  }

  // Enqueue task to start the agent
  const taskId = `spawn:${agentId}:${Date.now()}`;
  queue.enqueueTask(virtualChatJid, taskId, async () => {
    return processAgentConversation(homeChatJid, agentId);
  });

  logger.info(
    {
      chatJid,
      homeChatJid,
      agentId,
      userId,
      sourceImJid,
      folder: effectiveGroup.folder,
    },
    '/spawn command: agent created and enqueued',
  );

  const shortId = agentId.slice(0, 4);
  return `⚡ 并行任务已启动 [${shortId}]: ${truncatedName}`;
}

async function setTyping(
  jid: string,
  isTyping: boolean,
  leaseId?: string,
  transportJid = jid,
): Promise<void> {
  // Skip Feishu Reaction when a streaming card is active — the card itself
  // serves as a live typing indicator.
  if (isTyping && hasActiveStreamingSession(transportJid)) {
    broadcastTyping(jid, isTyping);
    return;
  }
  await imManager.setTyping(transportJid, isTyping, leaseId);
  broadcastTyping(jid, isTyping);
}

async function clearStandaloneProcessingIndicator(
  logicalJid: string,
  transportJid: string,
  inputTurnId: string,
): Promise<void> {
  await setTyping(logicalJid, false, inputTurnId, transportJid);
  let ackCleared = false;
  await imManager.clearAckReaction(transportJid, inputTurnId).then(
    () => {
      ackCleared = true;
    },
    (err) => {
      logger.debug(
        { err, logicalJid, transportJid, inputTurnId },
        'Failed to clear standalone exact processing indicator',
      );
    },
  );
  if (ackCleared) untrackProcessingIndicator(logicalJid, inputTurnId);
}

async function clearStandaloneProcessingIndicatorsForMessages(
  logicalJid: string,
  messages: Array<Pick<NewMessage, 'id' | 'source_jid' | 'chat_jid'>>,
): Promise<void> {
  for (const message of messages) {
    const sourceJid = message.source_jid || message.chat_jid;
    if (!getChannelType(sourceJid)) continue;
    await clearStandaloneProcessingIndicator(logicalJid, sourceJid, message.id);
  }
}

const trackedProcessingIndicators = new Map<string, Map<string, string>>();
const trackedTypingIndicators = new Map<
  string,
  Map<string, { transportJid: string; ready: Promise<void> }>
>();

function trackProcessingIndicator(
  logicalJid: string,
  inputTurnId: string,
  transportJid: string,
): void {
  let inputs = trackedProcessingIndicators.get(logicalJid);
  if (!inputs) {
    inputs = new Map<string, string>();
    trackedProcessingIndicators.set(logicalJid, inputs);
  }
  inputs.set(inputTurnId, transportJid);
}

function untrackProcessingIndicator(
  logicalJid: string,
  inputTurnId: string,
): void {
  const inputs = trackedProcessingIndicators.get(logicalJid);
  inputs?.delete(inputTurnId);
  if (inputs?.size === 0) trackedProcessingIndicators.delete(logicalJid);
}

function trackTypingIndicator(
  logicalJid: string,
  leaseId: string,
  transportJid: string,
  ready: Promise<void>,
): void {
  let leases = trackedTypingIndicators.get(logicalJid);
  if (!leases) {
    leases = new Map();
    trackedTypingIndicators.set(logicalJid, leases);
  }
  // Observe acquisition failure immediately to avoid an unhandled rejection;
  // a later clear still sends the provider stop because some adapters install
  // their local lease before the provider call settles.
  const observedReady = ready.catch((err) => {
    logger.debug(
      { err, logicalJid, leaseId, transportJid },
      'Processing typing indicator acquisition failed',
    );
  });
  leases.set(leaseId, { transportJid, ready: observedReady });
}

function untrackTypingIndicator(logicalJid: string, leaseId: string): void {
  const leases = trackedTypingIndicators.get(logicalJid);
  leases?.delete(leaseId);
  if (leases?.size === 0) trackedTypingIndicators.delete(logicalJid);
}

async function clearTrackedTypingIndicator(
  logicalJid: string,
  leaseId: string,
  fallbackTransportJid?: string,
): Promise<void> {
  const owner = trackedTypingIndicators.get(logicalJid)?.get(leaseId);
  if (owner) {
    await owner.ready;
    await setTyping(logicalJid, false, leaseId, owner.transportJid);
    untrackTypingIndicator(logicalJid, leaseId);
    return;
  }
  if (fallbackTransportJid) {
    await setTyping(logicalJid, false, leaseId, fallbackTransportJid);
  }
}

async function clearTrackedProcessingIndicators(
  logicalJid: string,
): Promise<void> {
  const inputs = trackedProcessingIndicators.get(logicalJid);
  const typingLeases = trackedTypingIndicators.get(logicalJid);
  await Promise.allSettled([
    ...[...(inputs ?? [])].map(async ([inputTurnId, transportJid]) => {
      await setTyping(logicalJid, false, inputTurnId, transportJid);
      await imManager.clearAckReaction(transportJid, inputTurnId);
      untrackProcessingIndicator(logicalJid, inputTurnId);
    }),
    ...[...(typingLeases ?? [])].map(async ([leaseId]) => {
      await clearTrackedTypingIndicator(logicalJid, leaseId);
    }),
  ]);
}

interface SendMessageOptions {
  /** Stable logical message id for replay-safe Web projection. */
  messageId?: string;
  /** Whether to forward the reply to the IM channel (Feishu/Telegram). Defaults to true for IM JIDs. */
  sendToIM?: boolean;
  /** IM 渠道实际发送的文本（默认与 text 相同）。挂起序列合并时 text 为
   * 全量合并正文（入库/Web），纯文本 IM 渠道无法编辑已发消息，只发本 turn
   * 增量，避免每个 turn 重发一遍全量。 */
  imTextOverride?: string;
  /** Pre-computed local image paths to attach to IM messages. Avoids redundant filesystem scans. */
  localImagePaths?: string[];
  /** Stable durable-output identity for a reply produced inside an active turn. */
  channelOutbox?: ChannelOutboxDeliveryRef;
  /** Message source identifier (e.g. 'scheduled_task') for frontend routing. */
  source?: string;
  /** Completed Claude Code Workflow snapshots associated with this reply. */
  workflowRuns?: NonNullable<StreamEvent['workflowRun']>[];
  /** Metadata used to preserve Claude SDK turn semantics for persisted messages. */
  messageMeta?: {
    turnId?: string;
    sessionId?: string;
    sdkMessageUuid?: string;
    sourceKind?: MessageSourceKind;
    finalizationReason?: MessageFinalizationReason;
  };
  /**
   * Exact scheduler occurrences represented by this canonical group result.
   * The DB row and these transitions commit atomically before Web broadcast.
   */
  scheduledGroupFinalizations?: Array<{
    runId: string;
    taskId: string;
    status?: 'success' | 'failed' | 'cancelled';
    result?: string | null;
    error?: string | null;
  }>;
}

/**
 * One-time migration: copy system-level IM config → admin's per-user config.
 * Safe to call repeatedly — writes a flag file after first successful run.
 */
function migrateSystemIMToPerUser(): void {
  const flagFile = path.join(DATA_DIR, 'config', '.im-config-migrated');
  if (fs.existsSync(flagFile)) return;

  try {
    // Find first admin user
    const adminResult = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    });
    const admin = adminResult.users[0];
    if (!admin) {
      // No admin yet (fresh install) — nothing to migrate
      return;
    }

    let migratedFeishu = false;
    let migratedTelegram = false;

    // Feishu: copy system config → admin per-user (if admin has no per-user config)
    const existingUserFeishu = getUserFeishuConfig(admin.id);
    if (!existingUserFeishu) {
      const { config: sysFeishu, source: feishuSource } =
        getFeishuProviderConfigWithSource();
      if (feishuSource !== 'none' && sysFeishu.appId && sysFeishu.appSecret) {
        saveUserFeishuConfig(admin.id, {
          appId: sysFeishu.appId,
          appSecret: sysFeishu.appSecret,
          enabled: sysFeishu.enabled,
        });
        migratedFeishu = true;
      }
    }

    // Telegram: copy system config → admin per-user (if admin has no per-user config)
    const existingUserTelegram = getUserTelegramConfig(admin.id);
    if (!existingUserTelegram) {
      const { config: sysTelegram, source: telegramSource } =
        getTelegramProviderConfigWithSource();
      if (telegramSource !== 'none' && sysTelegram.botToken) {
        saveUserTelegramConfig(admin.id, {
          botToken: sysTelegram.botToken,
          proxyUrl: sysTelegram.proxyUrl,
          enabled: sysTelegram.enabled,
        });
        migratedTelegram = true;
      }
    }

    // Write flag file (even if nothing was migrated — to avoid re-checking)
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, new Date().toISOString() + '\n', 'utf-8');

    if (migratedFeishu || migratedTelegram) {
      logger.info(
        {
          adminId: admin.id,
          feishu: migratedFeishu,
          telegram: migratedTelegram,
        },
        'Migrated system-level IM config to admin per-user config',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to migrate system-level IM config (non-fatal)',
    );
  }
}

function loadState(): void {
  // Load from SQLite
  const persistedTimestamp = getRouterState('last_timestamp') || '';
  const lastTimestampId = getRouterState('last_timestamp_id') || '';
  globalMessageCursor = {
    timestamp: persistedTimestamp,
    id: lastTimestampId,
  };
  const loadCursorMap = (key: string): Record<string, MessageCursor> => {
    const raw = getRouterState(key);
    try {
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const normalized: Record<string, MessageCursor> = {};
      for (const [jid, v] of Object.entries(parsed)) {
        normalized[jid] = normalizeCursor(v);
      }
      return normalized;
    } catch {
      logger.warn(`Corrupted ${key} in DB, resetting`);
      return {};
    }
  };
  lastAgentTimestamp = loadCursorMap('last_agent_timestamp');
  lastCommittedCursor = loadCursorMap('last_committed_cursor');
  const prunedCursors = pruneCursorState();
  if (prunedCursors > 0) {
    logger.info(
      { prunedCursors },
      'Pruned message cursors for chats that no longer exist',
    );
  }

  // Do not synthesize a missing committed cursor from the next-pull cursor.
  // A crash can persist next-pull immediately after IPC acceptance while the
  // corresponding receipt is still uncommitted. Treating that position as
  // committed would turn an upgrade/startup heuristic into silent data loss.
  // Legacy installs may replay once from EMPTY_CURSOR; at-least-once is the
  // intentional safety trade-off.

  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Restore persisted OOM counters
  for (const { key, value } of getRouterStateByPrefix('oom_exits:')) {
    const folder = key.slice('oom_exits:'.length);
    const count = parseInt(value, 10);
    if (count > 0) {
      consecutiveOomExits[folder] = count;
      logger.info({ folder, count }, 'Restored OOM counter from DB');
    }
  }

  // Auto-register default groups from config/default-groups.json
  const defaultGroupsPath = path.resolve(
    process.cwd(),
    'config',
    'default-groups.json',
  );
  if (fs.existsSync(defaultGroupsPath)) {
    try {
      const defaults = JSON.parse(
        fs.readFileSync(defaultGroupsPath, 'utf-8'),
      ) as Array<{
        jid: string;
        name: string;
        folder: string;
      }>;
      for (const g of defaults) {
        if (!registeredGroups[g.jid]) {
          registerGroup(g.jid, {
            name: g.name,
            folder: g.folder,
            added_at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load default groups config');
    }
  }

  // Ensure every active user has an owner-specific home group (is_home=true).
  try {
    // Paginate through all active users
    const activeUsers: Array<{ id: string; role: string; username: string }> =
      [];
    {
      let page = 1;
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        activeUsers.push(...result.users);
        if (activeUsers.length >= result.total) break;
        page++;
      }
    }
    for (const user of activeUsers) {
      const homeJid = ensureUserHomeGroup(
        user.id,
        user.role as 'admin' | 'member',
        user.username,
      );
      // Always refresh this entry from DB to pick up any patches (is_home, executionMode, etc.)
      const freshGroup = getRegisteredGroup(homeJid);
      if (freshGroup) {
        registeredGroups[homeJid] = freshGroup;
      } else if (!registeredGroups[homeJid]) {
        registeredGroups = getAllRegisteredGroups();
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to ensure user home groups');
  }

  // Enforce execution mode on all is_home groups:
  // - admin home → host mode
  // - member home → container mode
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!group.is_home) continue;

    const owner = group.created_by ? getUserById(group.created_by) : undefined;
    const expectedMode = owner?.role === 'admin' ? 'host' : 'container';

    if (group.executionMode !== expectedMode) {
      group.executionMode = expectedMode;
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
      // 清除旧 session，避免恢复不兼容的 session
      if (sessions[group.folder]) {
        logger.info(
          { folder: group.folder, expectedMode },
          'Clearing stale session during execution mode migration',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Cursor persistence. Both cursor maps are serialized whole, so this cost
 * scales with the number of historical chats; two defenses keep it bounded:
 * only keys whose value actually changed are written (in one transaction, not
 * four), and pruneCursorState() drops keys whose chat no longer exists
 * (73% of production keys were dead web sessions).
 */
const lastPersistedRouterState: Record<string, string> = {};
function saveState(): void {
  const entries: Array<[string, string]> = [
    ['last_timestamp', globalMessageCursor.timestamp],
    ['last_timestamp_id', globalMessageCursor.id],
    ['last_agent_timestamp', JSON.stringify(lastAgentTimestamp)],
    ['last_committed_cursor', JSON.stringify(lastCommittedCursor)],
  ];
  const changed = entries.filter(
    ([key, value]) => lastPersistedRouterState[key] !== value,
  );
  if (changed.length === 0) return;
  setRouterStateBatch(changed);
  for (const [key, value] of changed) lastPersistedRouterState[key] = value;
}

/** Drop cursor entries for chats that no longer exist. Safe: a chat row is
 * the FK parent of its messages, so a missing chat has no messages to skip
 * and a recreated chat starts empty anyway. Returns pruned key count. */
function pruneCursorState(): number {
  const validJids = new Set(getAllChatJids());
  let pruned = 0;
  for (const key of Object.keys(lastAgentTimestamp)) {
    if (!validJids.has(key)) {
      delete lastAgentTimestamp[key];
      pruned += 1;
    }
  }
  for (const key of Object.keys(lastCommittedCursor)) {
    if (!validJids.has(key)) {
      delete lastCommittedCursor[key];
      pruned += 1;
    }
  }
  if (pruned > 0) saveState();
  return pruned;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  // 严格校验 folder 名：注册路径来自 IPC（agent register_group 工具）和直接调用，
  // folder 会直接拼到 path.join(GROUPS_DIR, ...) 上。任何含 `..`、绝对路径或
  // 路径分隔符的 folder 都会让 mkdir/写入跑出 GROUPS_DIR 之外（agent
  // bypass-permissions 模式下完全可达）。规则与典型 unix 目录命名一致。
  if (!group.folder || !isValidWorkspaceFolderName(group.folder)) {
    throw new Error(`registerGroup: invalid folder name: ${group.folder}`);
  }

  // register_group is reachable from an agent IPC channel. Treat its
  // containerConfig as untrusted and apply the same structural, privilege and
  // filesystem policy checks as the HTTP creation route.
  const parsedContainerConfig = parseContainerConfig(group.containerConfig);
  if (parsedContainerConfig.error) {
    throw new Error(
      `registerGroup: invalid container config: ${parsedContainerConfig.error}`,
    );
  }
  const additionalMounts = parsedContainerConfig.config?.additionalMounts ?? [];
  if (additionalMounts.length > 0) {
    if (group.executionMode === 'host') {
      throw new Error(
        'registerGroup: additional mounts require container execution mode',
      );
    }
    const currentOwner = group.created_by
      ? getUserById(group.created_by)
      : undefined;
    if (!canExecuteOnHost(currentOwner)) {
      throw new Error(
        'registerGroup: host directory mounts require a currently active administrator owner',
      );
    }
    const validated = validateAdditionalMountsStrict(
      additionalMounts,
      group.name,
      group.is_home === true,
    );
    group = {
      ...group,
      containerConfig: {
        ...parsedContainerConfig.config,
        version: 1,
        additionalMounts: validated.map((mount) => mount.persisted),
      },
    };
  } else if (parsedContainerConfig.config) {
    group = { ...group, containerConfig: parsedContainerConfig.config };
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from Feishu.
 * Fetches all bot groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  // Every Feishu bot has its own visible group set. Sync all connected
  // account-scoped sockets; stopping after the first/default bot leaves stale
  // metadata for every secondary account.
  const connectedUserIds = imManager.getConnectedUserIds();
  let syncedAccounts = 0;
  for (const uid of connectedUserIds) {
    try {
      syncedAccounts += await imManager.syncAllFeishuGroups(uid);
    } catch (error) {
      logger.warn({ error, uid }, 'Feishu user group sync failed; continuing');
    }
  }
  // A manual per-user discovery must not postpone this shared daily repair
  // pass for every other user. Only the all-user scheduler advances the legacy
  // global checkpoint.
  if (syncedAccounts > 0) setLastGroupSync();
}

let feishuSyncInterval: ReturnType<typeof setInterval> | null = null;

function ensureFeishuSyncScheduler(): void {
  if (feishuSyncInterval) return;
  syncGroupMetadata().catch((err) =>
    logger.error({ err }, 'Initial Feishu group sync failed'),
  );
  feishuSyncInterval = setInterval(() => {
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Periodic group sync failed'),
    );
  }, GROUP_SYNC_INTERVAL_MS);
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.startsWith('feishu:'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Build an ExpandContext for plugin slash-command expansion. Resolves the
 * runtime owner / cwd / executionMode / active container name.
 *
 * Returns null when the group has no resolvable owner — in that case callers
 * skip expansion and fall through to the raw message. Plugin commands require
 * a per-user runtime so an ownerless group simply has no plugins to expand.
 *
 * `ownerOverride` lets callers pin a specific owner when a caller already
 * resolved the workspace identity.
 */
function buildExpandContext(
  chatJid: string,
  group: RegisteredGroup,
  ownerOverride?: string | null,
): ExpandContext | null {
  const ownerId = ownerOverride ?? group.created_by;
  if (
    (group.executionMode || 'container') === 'host' &&
    !canExecuteOnHost(ownerId ? getUserById(ownerId) : undefined)
  ) {
    // Plugin slash commands may execute inline Bash before the Agent runner is
    // started. Apply the same live host authorization boundary here so a
    // downgraded owner cannot bypass the runHostAgent gate.
    return null;
  }
  return makeExpandContext({
    chatJid,
    groupFolder: group.folder,
    ownerId,
    executionMode: group.executionMode,
    customCwd: group.customCwd,
    groupsDir: GROUPS_DIR,
    containerName: queue.getActiveContainerName(chatJid),
  });
}

function collectPersistedReferencedMessageIds(
  chatJid: string,
  messages: NewMessage[],
): Set<string> {
  return new Set(
    [...collectReferencedMessageIds(messages)].filter((messageId) =>
      Boolean(getMessage(chatJid, messageId)),
    ),
  );
}

function resolveBatchChannelContext(
  messages: NewMessage[],
  workspaceJid: string,
  sessionAgentId?: string | null,
): ChannelTurnContext | undefined {
  if (messages.length === 0) return undefined;
  const contexts = messages.map((message) => message.channel_context);
  if (contexts.some((context) => !context)) return undefined;
  const latest = contexts[contexts.length - 1]!;
  const routeKey = (context: ChannelTurnContext): string =>
    [
      context.provider,
      context.channelAccountId ?? '',
      context.sourceJid,
      context.chat.id,
      context.message.threadId ?? '',
      context.message.rootId ?? '',
    ].join('\u0000');
  if (contexts.some((context) => routeKey(context!) !== routeKey(latest))) {
    return undefined;
  }
  const latestMessage = messages[messages.length - 1];
  return {
    ...latest,
    targetJid: latestMessage.chat_jid,
    workspaceJid,
    sessionAgentId: sessionAgentId ?? null,
  };
}

function bindActiveChannelTurn(
  scope: string,
  correlationId: string | undefined,
  context: ChannelTurnContext | undefined,
): void {
  if (!correlationId || !context) {
    activeChannelTurns.set(scope, null);
    return;
  }
  activeChannelTurns.set(scope, {
    correlationId,
    sourceJid: context.sourceJid,
    context,
  });
}

export function collectMessageImages(
  chatJid: string,
  messages: NewMessage[],
  options: { knownMessageIds?: ReadonlySet<string> } = {},
): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  const knownMessageIds = options.knownMessageIds ?? new Set<string>();
  for (const msg of messages) {
    if (!msg.attachments) continue;
    try {
      const parsed = JSON.parse(msg.attachments);
      if (!Array.isArray(parsed)) continue;
      const excludedIndexes = collectKnownReferenceAttachmentIndexes(
        msg,
        knownMessageIds,
      );
      for (let index = 0; index < parsed.length; index++) {
        if (excludedIndexes.has(index)) continue;
        const item = normalizeImageAttachment(parsed[index], {
          onMimeMismatch: ({ declaredMime, detectedMime }) => {
            logger.warn(
              { chatJid, messageId: msg.id, declaredMime, detectedMime },
              'Attachment MIME mismatch detected, using detected MIME',
            );
          },
        });
        if (!item) continue;
        images.push({ data: item.data, mimeType: item.mimeType });
      }
    } catch (err) {
      logger.warn(
        { chatJid, messageId: msg.id },
        'Failed to parse message attachments',
      );
    }
  }
  return images;
}

/** A paired/registered direct chat is already bound to one HappyClaw user.
 * Learn that chat's provider-native owner identity from its first durable human
 * message so natural-language owner workflows do not require a bootstrap slash
 * command. Group chats remain explicit-claim only. */
function learnDirectMessageOwners(
  ownerUserId: string,
  messages: NewMessage[],
): void {
  for (const message of messages) {
    if (
      message.task_id ||
      message.source_kind === 'scheduled_task_prompt' ||
      !message.sender
    ) {
      continue;
    }
    const sourceJid = message.source_jid || message.chat_jid;
    const conversationJid = channelConversationJid(sourceJid);
    if (!isDirectMessageJid(conversationJid)) continue;
    const sourceGroup =
      registeredGroups[conversationJid] ?? getRegisteredGroup(conversationJid);
    if (!sourceGroup || sourceGroup.created_by !== ownerUserId) {
      continue;
    }
    const ownerImId = resolveTrustedDirectOwnerUpgrade(
      sourceJid,
      message.sender,
      sourceGroup.owner_im_id,
      sourceGroup.owner_claim_source,
    );
    if (!ownerImId) continue;
    const claimed = claimOwner(sourceGroup, ownerImId, 'trusted_direct');
    persistGroupUpdate(conversationJid, claimed, registeredGroups);
    logger.info(
      { conversationJid, ownerUserId },
      'Learned IM owner from a trusted direct message',
    );
  }
}

function settleScheduledGroupWorkspaceProjection(input: {
  runs: TaskRun[];
  chatJid: string;
  workspaceFolder: string;
  text: string;
  messageId: string;
  projected: boolean;
  projectionError?: string;
  runStatus?: 'success' | 'failed' | 'cancelled';
  runResult?: string | null;
  runError?: string | null;
}): boolean {
  if (input.runs.length === 0) return false;
  let allDurable = true;
  for (const run of input.runs) {
    if (input.projected) {
      const finalized = finalizeDeliveredGroupTaskRun(run.id, run.task_id, {
        status: input.runStatus,
        result: input.runResult === undefined ? input.text : input.runResult,
        error: input.runError,
      });
      allDurable &&= finalized;
      if (!finalized) {
        logger.error(
          { runId: run.id, taskId: run.task_id, chatJid: input.chatJid },
          'Failed to finalize group scheduled-task workspace result',
        );
      }
      continue;
    }

    const error =
      input.projectionError ||
      `Scheduled-task workspace result was not persisted and broadcast: ${input.chatJid}`;
    const payload = {
      kind: 'workspace_result',
      chatJid: input.chatJid,
      text: input.text,
      groupRunId: run.id,
      groupTaskId: run.task_id,
      groupStatus: input.runStatus,
      groupResult: input.runResult === undefined ? input.text : input.runResult,
      groupError: input.runError,
      options: {
        sourceKind: 'scheduled_task_result',
        messageId: input.messageId,
        skipStore: false,
        workspaceFolder: input.workspaceFolder,
      },
    } as const;
    const recorded = recordGroupWorkspaceProjectionFailureAndFinalize({
      runId: run.id,
      taskId: run.task_id,
      receipt: {
        status: 'failed',
        summary: {
          attempted: 1,
          succeeded: 0,
          failed: 1,
          failed_channels: [`workspace:${input.chatJid}`],
        },
        error,
      },
      payload,
      status: input.runStatus,
      result: input.runResult === undefined ? input.text : input.runResult,
      error: input.runError,
    });
    allDurable &&= recorded;
    if (!recorded) {
      logger.error(
        { runId: run.id, taskId: run.task_id, chatJid: input.chatJid },
        'Failed to persist group scheduled-task workspace projection retry',
      );
    }
  }
  return allDurable;
}

async function projectTerminalScheduledGroupRuns(input: {
  runs: Iterable<TaskRun>;
  chatJid: string;
  workspaceFolder: string;
  status: 'failed' | 'cancelled';
  error: string;
}): Promise<boolean> {
  let allDurable = true;
  let sawDeliveredRun = false;
  for (const staleRun of input.runs) {
    const run = getTaskRunById(staleRun.id);
    if (!run) continue;
    if (run.status === input.status && run.error === input.error) {
      sawDeliveredRun = true;
      continue;
    }
    if (run.status !== 'delivered') continue;
    sawDeliveredRun = true;
    const task = getTaskById(run.task_id);
    const text = task
      ? formatScheduledTaskWorkspaceResult({
          task,
          runId: run.id,
          result: null,
          error: input.error,
        })
      : `## ❌ 定时任务执行失败\n\n**任务 ID**：\`${run.task_id}\`\n**运行 ID**：\`${run.id}\`\n**错误**：${input.error}`;
    const messageId = `scheduled-group-terminal:${run.id}`;
    const outcome = await sendMessageWithOutcome(input.chatJid, text, {
      messageId,
      sendToIM: false,
      source: 'scheduled_task',
      messageMeta: {
        sourceKind: 'scheduled_task_result',
        finalizationReason:
          input.status === 'cancelled' ? 'interrupted' : 'error',
      },
      scheduledGroupFinalizations: [
        {
          runId: run.id,
          taskId: run.task_id,
          status: input.status,
          result: null,
          error: input.error,
        },
      ],
    });
    const durable = settleScheduledGroupWorkspaceProjection({
      runs: [run],
      chatJid: input.chatJid,
      workspaceFolder: input.workspaceFolder,
      text,
      messageId,
      projected: outcome.webProjected && !!outcome.messageId,
      projectionError: outcome.webProjected
        ? undefined
        : `Scheduled-task terminal workspace result was not persisted and broadcast: ${input.chatJid}`,
      runStatus: input.status,
      runResult: null,
      runError: input.error,
    });
    allDurable &&= durable;
    if (!durable) {
      logger.error(
        {
          runId: run.id,
          taskId: run.task_id,
          chatJid: input.chatJid,
          status: input.status,
        },
        'Failed to durably project terminal group scheduled-task result',
      );
    }
  }
  return sawDeliveredRun && allDurable;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 *
 * Uses streaming output: agent results are sent to Feishu as they arrive.
 * The container stays alive for idleTimeout after each result, allowing
 * rapid-fire messages to be piped in without spawning a new container.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) {
    // Group may have been created after loadState (e.g., during setup/registration)
    registeredGroups = getAllRegisteredGroups();
    group = registeredGroups[chatJid];
  }
  if (!group) {
    await clearStandaloneProcessingIndicatorsForMessages(
      chatJid,
      getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || EMPTY_CURSOR),
    );
    return true;
  }

  // activation_mode === 'disabled' 时忽略所有消息（DM 和群聊）
  if (group.activation_mode === 'disabled') {
    await clearStandaloneProcessingIndicatorsForMessages(
      chatJid,
      getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || EMPTY_CURSOR),
    );
    logger.debug({ chatJid }, 'Group activation_mode is disabled, skipping');
    return true;
  }

  const resolved = resolveEffectiveGroup(group);
  const effectiveGroup = resolved.effectiveGroup;

  // Get all messages since last agent interaction
  const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
  let missedMessages = getMessagesSince(chatJid, sinceCursor);

  if (missedMessages.length === 0) return true;

  // Bounded-retry exhaustion may intentionally leave ordinary messages
  // behind the committed cursor. Consume only scheduler prompts whose exact
  // durable occurrence is already terminal, so a later user message cannot
  // execute that old occurrence again.
  const terminalScheduledPrompts = missedMessages.filter((message) =>
    resolveTerminalScheduledGroupPromptRun(message, getTaskRunById),
  );
  if (terminalScheduledPrompts.length > 0) {
    for (const message of terminalScheduledPrompts) {
      completeOutOfBandMessage(chatJid, {
        timestamp: message.timestamp,
        id: message.id,
      });
    }
    const terminalIds = new Set(
      terminalScheduledPrompts.map((message) => message.id),
    );
    missedMessages = missedMessages.filter(
      (message) => !terminalIds.has(message.id),
    );
    if (missedMessages.length === 0) return true;
  }

  // Direct IM chats reply to themselves. Routed IM messages keep their original
  // source_jid so workspace-bound conversations can reply back to the sender
  // without mirroring every Web reply into IM.
  //
  // When messages from multiple sources (web + IM) are batched together, only
  // route replies to IM if ALL messages came from the same IM source. If any
  // message originated from web, the web user expects replies on web only — do
  // not broadcast to IM (#99).
  const directImReply = getChannelType(chatJid) !== null;
  let incomingImOwner: string | null = null;
  if (!directImReply) {
    // chatJid is a web channel — check if ALL messages share the same IM source
    const firstSourceJid = missedMessages[0]?.source_jid || chatJid;
    const allSameImSource =
      getChannelType(firstSourceJid) !== null &&
      missedMessages.every((m) => (m.source_jid || chatJid) === firstSourceJid);
    if (allSameImSource) {
      incomingImOwner = firstSourceJid;
    }
  } else {
    // chatJid is an IM channel — reply directly
    incomingImOwner = chatJid;
  }
  const persistedMainOwner = getSessionChannelOwner(effectiveGroup.folder);
  let replySourceImJid = resolveStickyChannelOwner(
    persistedMainOwner ?? null,
    incomingImOwner,
  );
  if (!persistedMainOwner && replySourceImJid) {
    replySourceImJid = setSessionChannelOwnerOnce(
      effectiveGroup.folder,
      null,
      replySourceImJid,
    );
  }
  // Publish the current IM reply route so the IPC watcher can forward
  // send_message outputs to the correct IM channel.
  activeImReplyRoutes.set(effectiveGroup.folder, replySourceImJid);

  // Plugin command expander (DMI commands): replace `/foo` slash-commands
  // contributed by enabled plugins with their fully-rendered prompt body
  // before the agent ever sees them. Conflicts / offline-container errors
  // become in-band system replies that advance the cursor without spawning
  // a runner.
  {
    const fallbackExpandCtx = buildExpandContext(
      chatJid,
      effectiveGroup,
      effectiveGroup.created_by,
    );
    if (fallbackExpandCtx) {
      const { toSend, replies } = await expandMessagesIfNeeded(
        missedMessages,
        fallbackExpandCtx,
        undefined,
        persistPluginExpansion,
      );
      // When toSend still has unprocessed messages, only the next-pull cursor
      // advances for replies — committing the recovery cursor past a reply
      // could lose earlier toSend messages on crash before the agent runs
      // (#18 P2-bug-2). When toSend is empty we fully commit.
      const advanceReplyCursor =
        toSend.length === 0
          ? completeOutOfBandMessage
          : advanceNextPullCursorOnly;
      let pluginRepliesAcknowledged = true;
      for (const r of replies) {
        // Per-reply IM target: prefer the originating message's source_jid
        // (so individual replies route back to whoever sent the slash command,
        // even in mixed batches), falling back to the batch's IM source
        // computed earlier.
        const perMsgImJid =
          r.originalMsg.source_jid && getChannelType(r.originalMsg.source_jid)
            ? r.originalMsg.source_jid
            : replySourceImJid;
        const delivery = await sendPluginExpanderReply(chatJid, r.text, {
          originalMessageId: r.originalMsg.id,
          groupFolder: effectiveGroup.folder,
          imRouteJid: perMsgImJid,
        });
        if (!delivery.acknowledged) {
          pluginRepliesAcknowledged = false;
          break;
        }
        if (perMsgImJid) {
          await clearStandaloneProcessingIndicator(
            chatJid,
            perMsgImJid,
            r.originalMsg.id,
          );
        }
        // Advance cursor to the original user message timestamp so the next
        // poll skips it. setCursors (not advance) bypasses any stale future
        // cursor when the reply is the only output of this batch.
        advanceReplyCursor(chatJid, {
          timestamp: r.originalMsg.timestamp,
          id: r.originalMsg.id,
        });
      }
      if (!pluginRepliesAcknowledged) return false;
      if (toSend.length === 0) {
        // Reply-only batch never spawns a runner — the normal completion
        // path's finally block (line ~3532) is skipped, so clear the IM
        // route here. Otherwise a stale entry leaks across batches and the
        // next IPC send_message/send_file mirrors to the wrong IM chat.
        activeImReplyRoutes.delete(effectiveGroup.folder);
        return true;
      }
      missedMessages = toSend;
    }
  }

  if (effectiveGroup.created_by) {
    learnDirectMessageOwners(effectiveGroup.created_by, missedMessages);
  }

  const retrySnapshot = createIpcDeliveryTarget(chatJid, missedMessages);
  if (retrySnapshot) {
    queue.setMessageRetrySnapshot(chatJid, retrySnapshot);
  }

  const agentProfile = resolveEffectiveAgentProfile(
    getAgentProfileForWorkspace(
      effectiveGroup.folder,
      effectiveGroup.created_by,
    ),
  );
  const interactionMode = resolveRuntimeInteractionMode(
    getWorkspaceInteractionMode(effectiveGroup.folder),
    { agentKind: 'main' },
  );
  const resetForAgentProfile = resetMainSessionForAgentProfileMismatch(
    effectiveGroup,
    agentProfile,
  );

  // Recovery mode: session was cleared to prevent session ghost, so inject
  // recent conversation history to give the fresh session context.
  const isRecovery = recoveryGroups.delete(chatJid);
  let historyContext: ReturnType<typeof buildRecentConversationHistoryContext> =
    null;
  if (isRecovery) {
    historyContext = buildRecentConversationHistoryContext(
      chatJid,
      new Set(missedMessages.map((m) => m.id)),
      {
        limit: 20,
        maxMessageLength: 500,
        intro:
          '检测到上次有未完成消息，当前使用新会话恢复处理。以下是恢复前的最近对话记录，供你了解上下文。',
      },
    );
    if (historyContext) {
      logger.info(
        { group: group.name, historyCount: historyContext.count },
        'Recovery: injected recent conversation history into prompt',
      );
    }
  } else if (resetForAgentProfile) {
    historyContext = buildRecentConversationHistoryContext(
      chatJid,
      new Set(missedMessages.map((m) => m.id)),
      {
        limit: 30,
        maxMessageLength: 700,
        intro:
          '检测到当前 workspace 切换或更新了顶层 AgentProfile 身份提示词，底层模型 session 已重置。以下是 HappyClaw 保存的最近对话记录，供你在新身份下延续上下文。',
      },
    );
    if (historyContext) {
      logger.info(
        {
          group: group.name,
          agentProfileId: agentProfile?.id,
          historyCount: historyContext.count,
        },
        'AgentProfile identity change: injected recent conversation history into prompt',
      );
    }
  } else if (
    willClearSessionOnProviderSwitch(effectiveGroup.folder, undefined)
  ) {
    // Proactive provider switch (sticky binding unhealthy/disabled) will clear
    // the SDK session inside the runner. Inject history so the new provider's
    // first turn keeps context, matching the recovery + reactive-failure paths.
    historyContext = buildRecentConversationHistoryContext(
      chatJid,
      new Set(missedMessages.map((m) => m.id)),
      {
        limit: 30,
        maxMessageLength: 700,
        intro:
          '检测到本次因切换 provider 需要使用新的底层模型 session。以下是 HappyClaw 保存的最近对话记录，供你延续上下文。',
      },
    );
    if (historyContext) {
      logger.info(
        { group: group.name, historyCount: historyContext.count },
        'Provider switch: injected recent conversation history into prompt',
      );
    }
  }

  const activeSessionReferencedMessageIds =
    !historyContext && sessions[effectiveGroup.folder]
      ? collectPersistedReferencedMessageIds(chatJid, missedMessages)
      : new Set<string>();
  const knownReferencedMessageIds = historyContext
    ? new Set(historyContext.messageIds)
    : activeSessionReferencedMessageIds;
  let prompt =
    (historyContext?.context ?? '') +
    formatMessages(missedMessages, {
      knownMessageIds: knownReferencedMessageIds,
    });

  const images = collectMessageImages(chatJid, missedMessages, {
    knownMessageIds: activeSessionReferencedMessageIds,
  });
  const imagesForAgent = images.length > 0 ? images : undefined;

  // Extract task_id from the most recent task-prompt message (if any).
  // See extractLastTaskId() for semantics; see §C of the routing fix plan for
  // why getMessagesSince (not getNewMessages) surfaces task-prompt rows here.
  const messageTaskId = extractLastTaskId(missedMessages);

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      directImReply,
      imageCount: images.length,
      isRecovery,
      messageTaskId,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const runnerIdleCloseMs = resolveRunnerLivenessTimeouts({
    executionTimeoutMs:
      effectiveGroup.containerConfig?.timeout ??
      getSystemSettings().containerTimeout,
    idleTimeoutMs: getSystemSettings().idleTimeout,
  }).idleCloseMs;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, runnerIdleCloseMs);
  };

  const lastProcessed = missedMessages[missedMessages.length - 1];
  const initialProcessingIndicatorJid =
    lastProcessed.source_jid && getChannelType(lastProcessed.source_jid)
      ? lastProcessed.source_jid
      : replySourceImJid;
  const initialTypingTransportJid = initialProcessingIndicatorJid ?? chatJid;
  const initialTypingReady = setTyping(
    chatJid,
    true,
    lastProcessed.id,
    initialTypingTransportJid,
  );
  trackTypingIndicator(
    chatJid,
    lastProcessed.id,
    initialTypingTransportJid,
    initialTypingReady,
  );
  await initialTypingReady;
  let hadError = false;
  let sentReply = false;
  // Narrower than sentReply and fenced by immutable input id: true only for a
  // genuine completed SDK final result that was physically acknowledged.
  // A warm runner may activate B before a delayed A callback arrives, so a
  // runner-wide boolean would let late A incorrectly suppress B's retry.
  const genuineReplyDeliveredByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  let lastError = '';
  // Cursor terminal state is likewise input-scoped. commitCursor still
  // advances/flushed the durable cursor, but a late A completion must not make
  // active B appear committed when B later fails.
  const cursorCommittedInputTurns = new Set<string>();
  let providerFailoverPending = false;
  let channelDeliveryNeedsManualReconciliation = false;
  let channelManualNoticesAcknowledged = true;
  let lastReplyMsgId: string | undefined;
  const queryTaskIds = new Set<string>();
  const healthyCompletedInputTurns = new Set<string>();
  const processingIndicatorJidsByInput = new Map<string, string>();
  // One cold SDK turn may cover several rapidly-arriving DB inputs. Each
  // provider reaction is owned by the original DB message id, while the SDK
  // completion is correlated to the batch's terminal input id.
  const processingIndicatorInputsByCompletion = new Map<string, string[]>([
    [
      lastProcessed.id,
      [...new Set(missedMessages.map((message) => message.id))],
    ],
  ]);
  const processingTypingLeaseIdsByCompletion = new Map<string, string>([
    [lastProcessed.id, lastProcessed.id],
  ]);
  for (const message of missedMessages) {
    const indicatorJid =
      message.source_jid && getChannelType(message.source_jid)
        ? message.source_jid
        : directImReply
          ? chatJid
          : null;
    if (!indicatorJid) continue;
    processingIndicatorJidsByInput.set(message.id, indicatorJid);
    trackProcessingIndicator(chatJid, message.id, indicatorJid);
  }
  const clearProcessingIndicatorForInput = async (
    inputTurnId: string,
  ): Promise<void> => {
    const exactInputIds = processingIndicatorInputsByCompletion.get(
      inputTurnId,
    ) ?? [inputTurnId];
    const typingLeaseId =
      processingTypingLeaseIdsByCompletion.get(inputTurnId) ?? inputTurnId;
    let typingCleared = false;
    await clearTrackedTypingIndicator(
      chatJid,
      typingLeaseId,
      processingIndicatorJidsByInput.get(exactInputIds[0]) ?? chatJid,
    ).then(
      () => {
        typingCleared = true;
      },
      (err) => {
        logger.debug(
          { err, chatJid, inputTurnId, typingLeaseId },
          'Failed to clear exact processing typing lease',
        );
      },
    );
    if (typingCleared) {
      processingTypingLeaseIdsByCompletion.delete(inputTurnId);
    }
    const failedExactInputIds: string[] = [];
    for (const exactInputId of new Set(exactInputIds)) {
      const indicatorJid = processingIndicatorJidsByInput.get(exactInputId);
      if (!indicatorJid) continue;
      let ackCleared = false;
      await imManager.clearAckReaction(indicatorJid, exactInputId).then(
        () => {
          ackCleared = true;
        },
        (err) => {
          logger.debug(
            { err, chatJid, inputTurnId: exactInputId, indicatorJid },
            'Failed to clear exact processing indicator',
          );
        },
      );
      if (ackCleared) {
        processingIndicatorJidsByInput.delete(exactInputId);
        untrackProcessingIndicator(chatJid, exactInputId);
      } else {
        failedExactInputIds.push(exactInputId);
      }
    }
    if (failedExactInputIds.length > 0) {
      processingIndicatorInputsByCompletion.set(
        inputTurnId,
        failedExactInputIds,
      );
    } else {
      processingIndicatorInputsByCompletion.delete(inputTurnId);
    }
  };
  const sentReplyByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  const channelPhysicalDeliveryAckByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  // Cold-start MCP output uses the triggering DB message id. Warm IPC turns
  // replace this with the receipt delivery id through activeRouteUpdaters.
  const ipcReplyTurnTracker: IpcReplyTurnTracker = {
    inputTurnId: lastProcessed.id,
    delivered: false,
  };
  const scheduledGroupRunsByInput = new Map<string, Map<string, TaskRun>>();
  const terminalScheduledGroupInputs = new Set<string>();
  const rememberScheduledGroupRuns = (
    containerOutput: Pick<ContainerOutput, 'inputTurnId' | 'ipcReceipts'>,
  ): TaskRun[] => {
    const runs = resolveScheduledGroupRunsForOutput({
      chatJid,
      fallbackInputTurnId: lastProcessed.id,
      coldMessages: missedMessages,
      output: containerOutput,
      getMessage: (targetJid, messageId) =>
        getAgentBuilderInputMessage(targetJid, messageId),
      getRun: getTaskRunById,
    });
    const inputTurnId =
      containerOutput.inputTurnId ??
      containerOutput.ipcReceipts?.[containerOutput.ipcReceipts.length - 1]
        ?.deliveryId ??
      ipcReplyTurnTracker.inputTurnId;
    if (runs.length > 0 && inputTurnId) {
      const remembered =
        scheduledGroupRunsByInput.get(inputTurnId) ??
        new Map<string, TaskRun>();
      for (const run of runs) remembered.set(run.id, run);
      scheduledGroupRunsByInput.set(inputTurnId, remembered);
    }
    return runs;
  };
  const projectCurrentScheduledGroupTerminal = (
    status: 'failed' | 'cancelled',
    error: string,
  ): Promise<boolean> => {
    const inputTurnId = ipcReplyTurnTracker.inputTurnId;
    return projectTerminalScheduledGroupRuns({
      runs: scheduledGroupRunsByInput.get(inputTurnId)?.values() ?? [],
      chatJid,
      workspaceFolder: effectiveGroup.folder,
      status,
      error,
    }).then((durable) => {
      if (durable) terminalScheduledGroupInputs.add(inputTurnId);
      return durable;
    });
  };
  // A cold run owns the whole initial durable batch. Warm turns are remembered
  // later from each IPC receipt's covered cursor set.
  rememberScheduledGroupRuns({ inputTurnId: lastProcessed.id });
  let currentInputCursor: MessageCursor = {
    timestamp: lastProcessed.timestamp,
    id: lastProcessed.id,
  };

  // ── Feishu Streaming Card ──
  // Create a streaming session for Feishu channels (typing-machine effect).
  // Non-Feishu channels get undefined → all streaming logic is no-op.
  let streamingSessionJid = replySourceImJid ?? chatJid;
  const streamingAddress = parseChannelAddress(streamingSessionJid);
  const streamingGroup = streamingAddress
    ? getRegisteredGroup(channelConversationJid(streamingSessionJid))
    : undefined;
  const streamingAccountId =
    streamingAddress?.channelAccountId ?? streamingGroup?.channel_account_id;
  let channelTurnRuntime =
    streamingAddress && streamingAccountId
      ? ChannelTurnRuntime.start({
          provider: streamingAddress.provider,
          accountId: streamingAccountId,
          sourceJid: streamingSessionJid,
          chatId: streamingAddress.externalChatId,
          rootId: streamingAddress.rootMessageId,
          threadId: streamingAddress.threadId,
          externalMessageId: lastProcessed.id,
          sessionId: sessions[effectiveGroup.folder] ?? null,
        })
      : undefined;
  const channelTurnRuntimes = new Map<string, ChannelTurnRuntime>();
  if (channelTurnRuntime) {
    channelTurnRuntimes.set(lastProcessed.id, channelTurnRuntime);
  }
  const completeChannelRuntimesForOutput = async (
    result: ContainerOutput,
  ): Promise<boolean> => {
    if (!result.inputTurnCompleted) return false;
    let allCompleted = true;
    const inputIds = result.ipcReceipts?.length
      ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
      : [result.inputTurnId ?? lastProcessed.id];
    for (const inputId of inputIds) {
      healthyCompletedInputTurns.add(inputId);
      const runtime = channelTurnRuntimes.get(inputId);
      if (!runtime) {
        await clearProcessingIndicatorForInput(inputId);
        continue;
      }
      const uncertainDelivery = getUncertainChannelOutboxForTurn(runtime.runId);
      if (uncertainDelivery) {
        channelDeliveryNeedsManualReconciliation = true;
        const interrupted = runtime.interrupt(
          `Channel delivery ${uncertainDelivery.id} is uncertain; manual reconciliation required`,
        );
        const exactScope = channelOutboxScopesByInput.get(inputId);
        const notified = exactScope?.chatId
          ? await deliverChannelManualReconciliationNotice({
              logicalChatJid: chatJid,
              scopeKey: channelTurnScope(effectiveGroup.folder),
              targetJid: exactScope.sourceJid,
              runtime,
              presentation:
                interactionMode === 'proactive' ? 'native' : 'default',
              route: { ...exactScope, chatId: exactScope.chatId },
            })
          : false;
        if (interrupted && notified) {
          await clearProcessingIndicatorForInput(inputId);
          runtime.dispose();
          channelTurnRuntimes.delete(inputId);
        } else {
          allCompleted = false;
        }
        continue;
      }
      const utteranceDelivered =
        channelPhysicalDeliveryAckByInput.get(inputId) === true;
      if (publishesFrameworkAnswer(interactionMode) && !utteranceDelivered) {
        allCompleted = false;
        logger.error(
          { chatJid, inputTurnId: inputId, runId: runtime.runId },
          'Refusing to complete channel input without exact physical delivery ACK',
        );
        continue;
      }
      const completed =
        runtime.markFinalizing() &&
        runtime.complete({
          cursorCommitted: true,
          sentReply: utteranceDelivered,
          silent: !utteranceDelivered,
          inputTurnId: inputId,
        });
      if (completed) {
        // Keep the immutable scope projection until the whole warm runner
        // exits. A late duplicate SDK callback for this already-completed
        // input must still resolve the same delivered Outbox item instead of
        // falling back to an ungoverned legacy send.
        await clearProcessingIndicatorForInput(inputId);
        runtime.dispose();
        channelTurnRuntimes.delete(inputId);
      } else {
        allCompleted = false;
        logger.error(
          {
            chatJid,
            inputTurnId: inputId,
            runId: runtime.runId,
            durabilityFailure: runtime.hasDurabilityFailure,
            lostFence: runtime.hasLostFence,
          },
          'Completed input could not terminalize its channel turn ledger',
        );
      }
    }
    return allCompleted;
  };
  const channelScopeForOutput = (
    result: ContainerOutput,
  ): {
    inputId: string;
    scope?: ActiveChannelOutboxScope;
    rejected: boolean;
  } => {
    const inputIds = result.ipcReceipts?.length
      ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
      : [];
    const inputId = resolveContainerOutputInputTurnId(result, lastProcessed.id);
    return {
      inputId,
      scope: channelOutboxScopesByInput.get(inputId),
      rejected: inputIds.some((id) => rejectedChannelInputTurns.has(id)),
    };
  };
  if (
    channelTurnRuntime &&
    channelTurnRuntime.executionDisposition !== 'execute'
  ) {
    const disposition = channelTurnRuntime.executionDisposition;
    if (
      disposition === 'manual_reconciliation' &&
      streamingAddress &&
      streamingAccountId
    ) {
      const notified = await deliverChannelManualReconciliationNotice({
        logicalChatJid: chatJid,
        scopeKey: channelTurnScope(effectiveGroup.folder),
        targetJid: streamingSessionJid,
        runtime: channelTurnRuntime,
        presentation: interactionMode === 'proactive' ? 'native' : 'default',
        route: {
          provider: streamingAddress.provider,
          accountId: streamingAccountId,
          sourceJid: streamingSessionJid,
          chatId: streamingAddress.externalChatId,
          rootId: streamingAddress.rootMessageId,
          threadId: streamingAddress.threadId,
        },
      });
      channelTurnRuntime.dispose();
      if (idleTimer) clearTimeout(idleTimer);
      await clearProcessingIndicatorForInput(lastProcessed.id);
      activeImReplyRoutes.delete(effectiveGroup.folder);
      if (!notified) return false;
      advanceCursors(chatJid, {
        timestamp: lastProcessed.timestamp,
        id: lastProcessed.id,
      });
      return true;
    }
    channelTurnRuntime.dispose();
    if (idleTimer) clearTimeout(idleTimer);
    activeImReplyRoutes.delete(effectiveGroup.folder);
    if (disposition === 'skip_terminal') {
      await clearProcessingIndicatorForInput(lastProcessed.id);
      advanceCursors(chatJid, {
        timestamp: lastProcessed.timestamp,
        id: lastProcessed.id,
      });
      return true;
    }
    logger.info(
      { chatJid, turnRunId: channelTurnRuntime.runId },
      'Channel turn is already leased; deferring duplicate execution',
    );
    return false;
  }
  // Retried executions reuse the same logical run but deliberately avoid a
  // second provider card. The final static fallback remains outbox-governed.
  const retryAttempt = queue.getRetryCount(chatJid);
  let activeDurableCardLifecycle =
    publishesFrameworkAnswer(interactionMode) &&
    retryAttempt === 0 &&
    streamingAddress?.provider === 'feishu'
      ? channelTurnRuntime?.reserveStreamingCard()
      : undefined;
  if (
    publishesFrameworkAnswer(interactionMode) &&
    channelTurnRuntime &&
    streamingAddress?.provider === 'feishu' &&
    retryAttempt === 0 &&
    !activeDurableCardLifecycle
  ) {
    channelTurnRuntime.retry('Duplicate streaming card reservation');
    channelTurnRuntime.dispose();
    if (idleTimer) clearTimeout(idleTimer);
    activeImReplyRoutes.delete(effectiveGroup.folder);
    return false;
  }
  let channelOutboxScope: ActiveChannelOutboxScope | undefined;
  const channelOutboxScopesByInput = new Map<
    string,
    ActiveChannelOutboxScope
  >();
  const rejectedChannelInputTurns = new Set<string>();
  const proactiveTailNoticesDelivered = new Set<string>();
  const notifyProactiveTailInterruption = async (
    inputTurnId: string,
  ): Promise<boolean> => {
    if (
      proactiveTailNoticesDelivered.has(inputTurnId) ||
      !shouldSendProactiveTailInterruptionNotice({
        mode: interactionMode,
        utteranceDelivered:
          channelPhysicalDeliveryAckByInput.get(inputTurnId) === true,
        runnerFailed: true,
        healthyInputTurnCompleted: healthyCompletedInputTurns.has(inputTurnId),
      })
    ) {
      return false;
    }
    proactiveTailNoticesDelivered.add(inputTurnId);
    const scope = channelOutboxScopesByInput.get(inputTurnId);
    return deliverProactiveTailInterruptionNotice({
      logicalChatJid: chatJid,
      scopeKey: channelTurnScope(effectiveGroup.folder),
      inputTurnId,
      targetJid: scope?.sourceJid ?? replySourceImJid,
      scope,
    });
  };
  const makeOnCardCreated = (jid: string) => (messageId: string) =>
    registerMessageIdMapping(messageId, jid);
  // 重试轮（指数退避后的重跑）静默执行，不新建流式卡片：否则一条持续失败的
  // 消息每轮都会在飞书发一张「生成中→处理出错」卡，最多刷 6 张（消息洪流）。
  // 重试成功时最终回复仍经静态 sendMessage 送达。
  let streamingSession =
    retryAttempt > 0 || !publishesFrameworkAnswer(interactionMode)
      ? undefined
      : await imManager.createStreamingSession(
          streamingSessionJid,
          makeOnCardCreated(streamingSessionJid),
          activeDurableCardLifecycle,
        );
  const channelStreamingSessionsByInput = new Map<
    string,
    { session: NonNullable<typeof streamingSession>; jid: string }
  >();
  let streamingAccumulatedText = '';
  let streamingAccumulatedThinking = '';
  let streamInterrupted = false;
  let streamSteered = false;
  // 本 run 是否已进入 finally 收尾。outputChain 的迟到回调可能在 run resolve
  // 之后才执行（waitForOutputChain 30s 兜底只放行不取消）；此时绝不能再重建
  // 流式卡片——重建出的卡片永远无人 complete，成为僵尸「生成中」卡。
  let runEnded = false;
  // ── 卡片挂起完成机制 ──
  // pendingBgTasks>0 / truncated 的 result 不定稿卡片：本 turn 文本存入
  // heldCardParts（DB 照常逐 turn 入库），卡片保持 streaming 态并显示
  // 「后台任务运行中」，后续 turn 的流式增量继续追加到同一张卡；全部后台
  // 任务 settle 后的 healthy result 才用累积全文定稿「已完成」——对齐
  // Claude Code "一次委托 = 一个完整回合" 的体验，不再分段发多张卡。
  let heldCardParts: string[] = [];
  // All Workflow snapshots for the current logical turn. Running snapshots
  // must survive the first held sdk_final so Web can keep rendering the live
  // Workflow card while Claude waits for the background task notification.
  let activeWorkflowRuns: NonNullable<StreamEvent['workflowRun']>[] = [];
  let completedWorkflowRuns: NonNullable<StreamEvent['workflowRun']>[] = [];
  // 挂起期间各 turn 的 usage 增量累计，定稿后与最终 turn 的 usage 合并
  // 补到卡片 usage note（否则卡片只显示最后一个 turn 的用量）。
  let heldCardUsage: HeldUsageTotals | null = null;
  // The runner emits one replay-safe ledger event per Anthropic message ID.
  // Buffer those siblings and expose one cumulative usage summary to UI/card.
  let pendingLedgerUsageBatch: HeldUsageTotals | null = null;
  // 定稿后等待最终 usage 事件合并补丁的卡片控制器。usage 事件在 result 之后
  // 到达，而主路径定稿即轮换 session——不留引用的话 usage note 永远打在新空卡
  // 上（no-op）。每条 result 开始时清空，避免打到过期卡。
  let heldUsagePatchTarget: StreamingSession | null = null;
  // 挂起序列的 DB 合并锚点：整个序列（含收尾 turn）共用第一个 held turn 的
  // turnId，storeMessageDirect 按 (chat_jid, turn_id) UPSERT 到同一行——
  // 全渠道（Web / 历史 / 飞书卡）永远只有一条回复。与卡片存在性无关：
  // 纯 Web 会话没有流式卡片，同样合并。
  let heldDbTurnId: string | null = null;
  const heldCardBaseText = (): string =>
    heldCardParts.length > 0
      ? heldCardParts.join(HELD_TURN_DIVIDER) + HELD_TURN_DIVIDER
      : '';
  // 挂起序列的异常收口：进程退出/中断/续写放弃时给合并行追加说明注记并广播，
  // 否则 Web 上那条回复会永远停在"…运行中/续写中"的悬空提示上。
  const finalizeHeldDbMessage = async (
    note: string | null,
    reason: 'interrupted' | 'truncated',
    warning = true,
  ): Promise<void> => {
    if (!heldDbTurnId || heldCardParts.length === 0) return;
    const suffix = note ? `\n\n> ${warning ? '⚠️ ' : ''}${note}` : '';
    const joined = heldCardParts.join(HELD_TURN_DIVIDER) + suffix;
    const tid = heldDbTurnId;
    heldDbTurnId = null;
    await sendMessage(chatJid, joined, {
      sendToIM: false,
      messageMeta: {
        turnId: tid,
        sessionId: activeSessionId,
        sourceKind: 'sdk_final',
        finalizationReason: reason,
      },
    });
  };
  // 用户在挂起期间发来新消息 → 先把挂起卡定稿并轮换新卡。IM 时间线上挂起卡
  // 在用户消息之前，新 turn 的回复不能长在旧卡里。
  const finalizeHeldCardForNewMessage = async (): Promise<void> => {
    if (heldCardParts.length === 0) return;
    const txt = heldCardParts.join(HELD_TURN_DIVIDER);
    heldCardParts = [];
    heldCardUsage = null;
    // DB 合并行内容已随每个 held turn 更新到位，仅需结束序列锚点
    heldDbTurnId = null;
    if (!streamingSession?.isActive()) return;
    try {
      await streamingSession.complete(txt);
    } catch {
      await streamingSession.abort('').catch(() => {});
    }
    unregisterStreamingSession(streamingSessionJid);
    streamingAccumulatedText = '';
    streamingAccumulatedThinking = '';
    streamingSession = undefined;
  };
  logger.info(
    { chatJid, streamingSessionJid, hasSession: !!streamingSession },
    'Streaming session creation result',
  );
  if (streamingSession) {
    registerStreamingSession(streamingSessionJid, streamingSession);
    channelStreamingSessionsByInput.set(lastProcessed.id, {
      session: streamingSession,
      jid: streamingSessionJid,
    });
    logger.debug({ chatJid }, 'Streaming card session created for Feishu');
  }
  const rollbackIdleMainCardReservation = (inputTurnId: string): boolean => {
    const projection =
      channelStreamingSessionsByInput.get(inputTurnId) ??
      (inputTurnId === lastProcessed.id && streamingSession
        ? { session: streamingSession, jid: streamingSessionJid }
        : undefined);
    const runtime = channelTurnRuntimes.get(inputTurnId);
    if (projection?.session.isActive()) return false;
    if (!runtime?.rollbackUnpublishedStreamingCardReservation()) {
      // The reservation may already have reached Feishu. Activate the
      // controller so the normal complete/abort path can terminalize it.
      projection?.session.setThinking();
      return false;
    }
    projection?.session.dispose();
    if (projection) unregisterStreamingSession(projection.jid);
    channelStreamingSessionsByInput.delete(inputTurnId);
    if (projection?.session === streamingSession) {
      streamingSession = undefined;
      activeDurableCardLifecycle = undefined;
    }
    logger.info(
      { chatJid, inputTurnId },
      'Rolled back unpublished streaming card after provider failure',
    );
    return true;
  };

  interface AdmittedWarmMainInput {
    sourceJid: string | null;
    imJid: string | null;
    runtime?: ChannelTurnRuntime;
    scope?: ActiveChannelOutboxScope;
    lifecycle?: typeof activeDurableCardLifecycle;
  }
  const admittedWarmMainInputs = new Map<string, AdmittedWarmMainInput>();
  const mainAdmissionKey = channelTurnScope(effectiveGroup.folder);
  const turnOutputCoordinators = new Map<string, TurnOutputCoordinator>();
  const bindTurnOutputCoordinator = (
    inputTurnId: string,
  ): TurnOutputCoordinator => {
    const existing = turnOutputCoordinators.get(inputTurnId);
    if (existing) return existing;
    const coordinator = activeTurnOutputs.bind(mainAdmissionKey, inputTurnId, {
      onProgress: (text) => {
        const projection = channelStreamingSessionsByInput.get(inputTurnId);
        if (projection?.session.isActive()) {
          projection.session.setThinking();
          projection.session.setSystemStatus(text.slice(0, 160));
          projection.session.pushRecentEvent(
            `🔄 ${text.replace(/\s+/g, ' ').slice(0, 80)}`,
          );
        }
        broadcastStreamEvent(chatJid, {
          eventType: 'status',
          agentScope: 'system',
          statusText: text.slice(0, 160),
          summary: text.slice(0, 500),
          isSynthetic: true,
          displayLevel: 'primary',
          turnId: inputTurnId,
          sessionId: activeSessionId,
        });
        return true;
      },
      onFinalCandidate: (text) => {
        streamingAccumulatedText = text;
        const projection = channelStreamingSessionsByInput.get(inputTurnId);
        if (projection?.session.isActive()) {
          projection.session.append(heldCardBaseText() + text);
          projection.session.setSystemStatus('正在完成最终回复…');
        }
        return true;
      },
      onUtteranceDelivered: () => {
        if (interactionMode !== 'proactive') return;
        channelPhysicalDeliveryAckByInput.set(inputTurnId, true);
        sentReplyByInput.set(inputTurnId, true);
        acknowledgeIpcReplyTurn(ipcReplyTurnTracker, inputTurnId);
      },
    });
    turnOutputCoordinators.set(inputTurnId, coordinator);
    return coordinator;
  };
  const finalizeProactiveOutputCoordinators = (
    result: ContainerOutput,
  ): void => {
    const inputIds = result.ipcReceipts?.length
      ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
      : [result.inputTurnId ?? lastProcessed.id];
    for (const inputId of inputIds) {
      const coordinator = turnOutputCoordinators.get(inputId);
      if (!coordinator) continue;
      coordinator.markFinalized();
      activeTurnOutputs.unbind(mainAdmissionKey, inputId, coordinator);
      turnOutputCoordinators.delete(inputId);
    }
    // These lanes are Assistant-only invariants. Clear any stale projection
    // left by an older warm callback so it cannot contaminate the next input.
    streamingAccumulatedText = '';
    streamingAccumulatedThinking = '';
    heldCardParts = [];
    heldCardUsage = null;
    heldUsagePatchTarget = null;
    heldDbTurnId = null;
    activeWorkflowRuns = [];
    completedWorkflowRuns = [];
  };
  bindTurnOutputCoordinator(lastProcessed.id);
  activeRouteAdmissions.set(
    mainAdmissionKey,
    (newSourceJid, inputTurnId, inputCursor, coveredInputs) => {
      const isCurrentOrNewer =
        !inputCursor ||
        isCursorAfter(inputCursor, currentInputCursor) ||
        (inputCursor.timestamp === currentInputCursor.timestamp &&
          inputCursor.id === currentInputCursor.id);
      if (!isCurrentOrNewer || admittedWarmMainInputs.has(inputTurnId)) {
        return false;
      }

      const newImJid = resolveStickyChannelOwner(
        replySourceImJid,
        newSourceJid,
      );
      let nextRuntime: ChannelTurnRuntime | undefined;
      let nextScope: ActiveChannelOutboxScope | undefined;
      let nextLifecycle: typeof activeDurableCardLifecycle;
      if (newImJid) {
        const nextAddress = parseChannelAddress(newImJid);
        const nextGroup = nextAddress
          ? getRegisteredGroup(channelConversationJid(newImJid))
          : undefined;
        const nextAccountId =
          nextAddress?.channelAccountId ?? nextGroup?.channel_account_id;
        if (!nextAddress || !nextAccountId) return false;
        nextRuntime = ChannelTurnRuntime.start({
          provider: nextAddress.provider,
          accountId: nextAccountId,
          sourceJid: newImJid,
          chatId: nextAddress.externalChatId,
          rootId: nextAddress.rootMessageId,
          threadId: nextAddress.threadId,
          externalMessageId: inputCursor?.id ?? inputTurnId,
          sessionId: activeSessionId,
        });
        if (nextRuntime.executionDisposition !== 'execute') {
          nextRuntime.dispose();
          return false;
        }
        nextLifecycle =
          publishesFrameworkAnswer(interactionMode) &&
          nextAddress.provider === 'feishu'
            ? nextRuntime.reserveStreamingCard()
            : undefined;
        if (
          publishesFrameworkAnswer(interactionMode) &&
          nextAddress.provider === 'feishu' &&
          !nextLifecycle
        ) {
          nextRuntime.retry('Unable to reserve warm streaming card');
          nextRuntime.dispose();
          return false;
        }
        nextScope = bindChannelOutboxScope(mainAdmissionKey, nextRuntime, {
          provider: nextAddress.provider,
          accountId: nextAccountId,
          sourceJid: newImJid,
          chatId: nextAddress.externalChatId,
          rootId: nextAddress.rootMessageId,
          threadId: nextAddress.threadId,
        });
        channelTurnRuntimes.set(inputTurnId, nextRuntime);
        channelOutboxScopesByInput.set(inputTurnId, nextScope);
      }
      admittedWarmMainInputs.set(inputTurnId, {
        sourceJid: newSourceJid,
        imJid: newImJid,
        runtime: nextRuntime,
        scope: nextScope,
        lifecycle: nextLifecycle,
      });
      genuineReplyDeliveredByInput.set(inputTurnId, false);
      const exactInputs =
        coveredInputs && coveredInputs.length > 0
          ? coveredInputs
          : [{ id: inputTurnId, sourceJid: newSourceJid ?? undefined }];
      const exactInputIds = [...new Set(exactInputs.map((input) => input.id))];
      processingIndicatorInputsByCompletion.set(inputTurnId, exactInputIds);
      processingTypingLeaseIdsByCompletion.set(inputTurnId, inputTurnId);
      const fallbackProcessingIndicatorJid =
        newSourceJid && getChannelType(newSourceJid) ? newSourceJid : newImJid;
      for (const exactInput of exactInputs) {
        const processingIndicatorJid =
          exactInput.sourceJid && getChannelType(exactInput.sourceJid)
            ? exactInput.sourceJid
            : fallbackProcessingIndicatorJid;
        if (processingIndicatorJid) {
          processingIndicatorJidsByInput.set(
            exactInput.id,
            processingIndicatorJid,
          );
          trackProcessingIndicator(
            chatJid,
            exactInput.id,
            processingIndicatorJid,
          );
        }
      }
      return {
        rollback: () => {
          const admitted = admittedWarmMainInputs.get(inputTurnId);
          if (!admitted) return;
          admittedWarmMainInputs.delete(inputTurnId);
          channelTurnRuntimes.delete(inputTurnId);
          channelOutboxScopesByInput.delete(inputTurnId);
          activeChannelOutboxScopes.unbind(mainAdmissionKey, admitted.scope);
          if (admitted.runtime) {
            const cardRolledBack = admitted.lifecycle
              ? admitted.runtime.rollbackUnpublishedStreamingCardReservation()
              : true;
            if (cardRolledBack) {
              admitted.runtime.retry('IPC publish failed after warm admission');
            } else {
              admitted.runtime.interrupt(
                'Warm admission could not safely roll back its unpublished card',
              );
            }
            admitted.runtime.dispose();
          }
        },
      };
    },
  );

  // ── Dynamic reply route updater ──
  // Allows IPC-injected messages (from web.ts / IM polling) to update the
  // reply routing target without killing the agent process.  This replaces
  // the old "closeStdin + restart" approach for home groups (#99).
  activeRouteUpdaters.set(
    effectiveGroup.folder,
    async (newSourceJid, inputTurnId, inputCursor) => {
      let acceptedNewInput = false;
      let previousSessionForRotation: typeof streamingSession;
      let durableLifecycleForInput: typeof activeDurableCardLifecycle;
      const admittedInput = inputTurnId
        ? admittedWarmMainInputs.get(inputTurnId)
        : undefined;
      if (inputTurnId) {
        // A warm input must have acquired its Turn/Card/Outbox fence before
        // GroupQueue published the IPC file. The post-publish updater only
        // activates that immutable reservation; it may never create one late.
        if (!admittedInput) return;
        const isCurrentOrNewer =
          !inputCursor ||
          isCursorAfter(inputCursor, currentInputCursor) ||
          (inputCursor.timestamp === currentInputCursor.timestamp &&
            inputCursor.id === currentInputCursor.id);
        if (!isCurrentOrNewer) return;
        if (inputCursor) currentInputCursor = inputCursor;
        setIpcReplyInputTurn(ipcReplyTurnTracker, inputTurnId);
        bindTurnOutputCoordinator(inputTurnId);
        acceptedNewInput = true;
        const typingTransportJid = admittedInput.imJid ?? chatJid;
        const typingReady = setTyping(
          chatJid,
          true,
          inputTurnId,
          typingTransportJid,
        );
        trackTypingIndicator(
          chatJid,
          inputTurnId,
          typingTransportJid,
          typingReady,
        );
        await typingReady;
      }
      // Web is a public control surface, not a transport ownership change. A
      // session first opened from Feishu/QQ/etc. keeps that exact account and
      // thread route when its next input is submitted from Web.
      let newImJid =
        admittedInput?.imJid ??
        resolveStickyChannelOwner(replySourceImJid, newSourceJid);
      if (!replySourceImJid && newImJid) {
        newImJid = setSessionChannelOwnerOnce(
          effectiveGroup.folder,
          null,
          newImJid,
        );
      }
      if (acceptedNewInput && inputTurnId && admittedInput) {
        channelTurnRuntime = admittedInput.runtime;
        channelOutboxScope = admittedInput.scope;
        activeDurableCardLifecycle = admittedInput.lifecycle;
        durableLifecycleForInput = admittedInput.lifecycle;
      }
      // 用户新消息注入：挂起中的卡片先定稿轮换——IM 时间线上旧卡在用户消息
      // 之前，新 turn 的回复不能长在旧卡里。route updater 在所有用户消息
      // 注入点（index.ts 消息循环 / web.ts）都会被调用，是天然的挂钩位置。
      if (previousSessionForRotation) {
        const previousText = heldCardParts.join(HELD_TURN_DIVIDER);
        heldCardParts = [];
        heldCardUsage = null;
        heldDbTurnId = null;
        try {
          if (previousSessionForRotation.isActive()) {
            if (previousText) {
              await previousSessionForRotation.complete(previousText);
            } else {
              await previousSessionForRotation.abort('新消息已开始');
            }
          }
        } finally {
          previousSessionForRotation.dispose();
        }
      } else if (!acceptedNewInput)
        await finalizeHeldCardForNewMessage().catch((err) => {
          logger.warn(
            { err, chatJid },
            'Failed to finalize held streaming card on new message',
          );
        });
      // New IPC user message arrived — reset sentReply so the next result
      // can be delivered to IM. This is the correct place to reset, NOT
      // in the streaming session rebuild (which also fires on SDK Task
      // completion and would cause multi-result IM spam).
      sentReply = false;
      if (inputTurnId) sentReplyByInput.set(inputTurnId, false);
      if (inputTurnId) {
        channelPhysicalDeliveryAckByInput.set(inputTurnId, false);
      }
      // Do not rotate the visible provider projection merely because B was
      // published while A is still emitting. The first B-correlated runner
      // event activates B after A has reached its own terminal output.
      if (acceptedNewInput) return;
      if (newImJid === replySourceImJid) {
        if (streamingSession && !streamingSession.isActive()) {
          streamingSession.dispose();
          unregisterStreamingSession(streamingSessionJid);
          streamingSession = undefined;
        }
        // 同一路由下，若上一轮卡片因连续更新失败进入 error 态被冻结（防同轮刷屏，
        // 见下方 stream 事件处理的 sessionErrored 分支），在新用户消息开启新一轮时
        // 重建一张干净卡片，恢复流式展示能力。
        if (
          publishesFrameworkAnswer(interactionMode) &&
          streamingSession &&
          (streamingSession as { currentState?: string }).currentState ===
            'error'
        ) {
          unregisterStreamingSession(streamingSessionJid);
          streamingAccumulatedText = '';
          streamingAccumulatedThinking = '';
          streamInterrupted = false;
          try {
            streamingSession = await imManager.createStreamingSession(
              streamingSessionJid,
              makeOnCardCreated(streamingSessionJid),
              durableLifecycleForInput,
            );
          } catch (err: any) {
            logger.warn(
              { err: err?.message, streamingSessionJid },
              'Failed to rebuild streaming session after card error',
            );
            streamingSession = undefined;
          }
          if (streamingSession) {
            registerStreamingSession(streamingSessionJid, streamingSession);
            if (inputTurnId) {
              channelStreamingSessionsByInput.set(inputTurnId, {
                session: streamingSession,
                jid: streamingSessionJid,
              });
            }
          }
        }
        if (
          publishesFrameworkAnswer(interactionMode) &&
          !streamingSession &&
          newImJid
        ) {
          streamingSession = await imManager
            .createStreamingSession(
              streamingSessionJid,
              makeOnCardCreated(streamingSessionJid),
              durableLifecycleForInput,
            )
            .catch((err) => {
              logger.error(
                { err, streamingSessionJid, inputTurnId },
                'Failed to create warm streaming session',
              );
              return undefined;
            });
          if (streamingSession) {
            registerStreamingSession(streamingSessionJid, streamingSession);
            if (inputTurnId) {
              channelStreamingSessionsByInput.set(inputTurnId, {
                session: streamingSession,
                jid: streamingSessionJid,
              });
            }
          }
        }
        return; // no route change
      }
      logger.debug(
        { chatJid, oldRoute: replySourceImJid, newRoute: newImJid },
        'Reply route updated via IPC injection',
      );
      replySourceImJid = newImJid;
      activeImReplyRoutes.set(effectiveGroup.folder, replySourceImJid);

      // Rebuild streaming session if the target channel changed.
      // A route changes only when another concrete IM route takes ownership.
      // Web follow-ups keep the existing transport/account/thread identity.
      const newStreamingJid =
        replySourceImJid ??
        (directImReply ? `web:${effectiveGroup.folder}` : chatJid);
      if (
        publishesFrameworkAnswer(interactionMode) &&
        newStreamingJid !== streamingSessionJid
      ) {
        if (streamingSession) {
          if (streamingSession.isActive()) streamingSession.dispose();
          unregisterStreamingSession(streamingSessionJid);
        }
        streamingSessionJid = newStreamingJid;
        try {
          streamingSession = await imManager.createStreamingSession(
            streamingSessionJid,
            makeOnCardCreated(streamingSessionJid),
            durableLifecycleForInput,
          );
        } catch (err: any) {
          logger.error(
            { err: err.message, streamingSessionJid },
            'Failed to create streaming session in route updater',
          );
          streamingSession = undefined;
        }
        streamingAccumulatedText = '';
        streamingAccumulatedThinking = '';
        if (streamingSession) {
          registerStreamingSession(streamingSessionJid, streamingSession);
          if (inputTurnId) {
            channelStreamingSessionsByInput.set(inputTurnId, {
              session: streamingSession,
              jid: streamingSessionJid,
            });
          }
        }
      }
    },
  );

  const activateMainProjectionForInput = async (
    inputTurnId: string | undefined,
  ): Promise<void> => {
    if (!inputTurnId) return;
    const existing = channelStreamingSessionsByInput.get(inputTurnId);
    if (existing) {
      streamingSession = existing.session;
      streamingSessionJid = existing.jid;
      return;
    }
    const admitted = admittedWarmMainInputs.get(inputTurnId);
    if (!admitted?.imJid || !admitted.lifecycle) return;
    const projectionJid = admitted.imJid;
    const session = await imManager
      .createStreamingSession(
        projectionJid,
        makeOnCardCreated(projectionJid),
        admitted.lifecycle,
      )
      .catch((error) => {
        logger.error(
          { error, chatJid, inputTurnId, projectionJid },
          'Failed to activate pre-admitted streaming projection',
        );
        return undefined;
      });
    if (!session) return;
    channelStreamingSessionsByInput.set(inputTurnId, {
      session,
      jid: projectionJid,
    });
    registerStreamingSession(projectionJid, session);
    streamingSession = session;
    streamingSessionJid = projectionJid;
    streamingAccumulatedText = '';
    streamingAccumulatedThinking = '';
  };

  const pickRunningTaskForNotification = (): string | null => {
    const runningInQuery = Array.from(queryTaskIds)
      .map((id) => getAgent(id))
      .filter(
        (a): a is NonNullable<ReturnType<typeof getAgent>> =>
          !!a &&
          a.kind === 'task' &&
          a.chat_jid === chatJid &&
          a.status === 'running',
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (runningInQuery.length > 0) {
      return runningInQuery[0].id;
    }
    const runningInChat = listAgentsByJid(chatJid)
      .filter((a) => a.kind === 'task' && a.status === 'running')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return runningInChat[0]?.id || null;
  };

  const commitCursor = (
    inputTurnId = ipcReplyTurnTracker.inputTurnId,
  ): void => {
    if (cursorCommittedInputTurns.has(inputTurnId)) return;
    advanceCursors(chatJid, {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    });
    flushAcknowledgedIpcForJid(chatJid);
    cursorCommittedInputTurns.add(inputTurnId);
  };

  if (effectiveGroup.created_by) {
    const owner = getUserById(effectiveGroup.created_by);
    // Defense-in-depth: drop messages whose owner is no longer active
    // (disabled or deleted). See `src/owner-gate.ts` for rationale.
    const ownerGate = checkOwnerActive(owner);
    if (!ownerGate.allowed) {
      completeOutOfBandMessages(chatJid, missedMessages);
      cursorCommittedInputTurns.add(lastProcessed.id);
      await clearProcessingIndicatorForInput(lastProcessed.id);
      logger.info(
        {
          chatJid,
          userId: effectiveGroup.created_by,
          ownerStatus: ownerGate.status,
        },
        'Dropping message: group owner is not active',
      );
      return true;
    }
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(
        effectiveGroup.created_by,
        owner.role,
      );
      if (!accessResult.allowed) {
        const sysMsg = formatBillingAccessDeniedMessage(accessResult);
        if (replySourceImJid) {
          const route = resolveDurableChannelRoute(replySourceImJid);
          const acknowledged = route
            ? await deliverIndependentChannelSystemNotice({
                logicalChatJid: chatJid,
                scopeKey: channelTurnScope(effectiveGroup.folder),
                targetJid: replySourceImJid,
                originalInputTurnId: lastProcessed.id,
                originalRunId: `billing:${lastProcessed.id}`,
                noticeKey: 'billing-denied',
                text: sysMsg,
                sender: '__billing__',
                route,
              })
            : false;
          if (!acknowledged) {
            logger.warn(
              { chatJid, replySourceImJid, messageId: lastProcessed.id },
              'Billing notice not acknowledged; preserving cursor for retry',
            );
            return false;
          }
        } else {
          sendBillingDeniedMessage(chatJid, sysMsg);
        }
        completeOutOfBandMessages(chatJid, missedMessages);
        cursorCommittedInputTurns.add(lastProcessed.id);
        await clearProcessingIndicatorForInput(lastProcessed.id);
        logger.info(
          {
            chatJid,
            userId: effectiveGroup.created_by,
            reason: accessResult.reason,
            blockType: accessResult.blockType,
          },
          'Billing access denied inside processGroupMessages',
        );
        return true;
      }
    }
  }

  let output:
    | { status: 'success' | 'error' | 'closed'; error?: string }
    | undefined;
  let activeSessionId = getSession(effectiveGroup.folder) || undefined;
  // currentSourceJid: tells the agent-runner which IM chat the latest user
  // message came from, so per-channel MCP tools (discord_*, etc.) can detect
  // it correctly even when the home container was originally started by a
  // different chat (e.g. web message before the Discord one arrived).
  const currentSourceJid =
    missedMessages[missedMessages.length - 1]?.source_jid || chatJid;
  const currentChannelContext = resolveBatchChannelContext(
    missedMessages,
    chatJid,
  );
  bindActiveChannelTurn(
    channelTurnScope(effectiveGroup.folder),
    lastProcessed.id,
    currentChannelContext,
  );
  activeIpcReplyTurnTrackers.set(effectiveGroup.folder, ipcReplyTurnTracker);
  activeAgentBuilderTurns.startBatch(
    effectiveGroup.folder,
    missedMessages.map((message) => ({
      chatJid,
      messageId: message.id,
      runtimeTurnId: lastProcessed.id,
      scheduledTaskId: message.task_id ?? null,
    })),
  );
  try {
    channelOutboxScope =
      channelTurnRuntime && streamingAddress && streamingAccountId
        ? bindChannelOutboxScope(
            channelTurnScope(effectiveGroup.folder),
            channelTurnRuntime,
            {
              provider: streamingAddress.provider,
              accountId: streamingAccountId,
              sourceJid: streamingSessionJid,
              chatId: streamingAddress.externalChatId,
              rootId: streamingAddress.rootMessageId,
              threadId: streamingAddress.threadId,
            },
          )
        : undefined;
    if (channelOutboxScope) {
      channelOutboxScopesByInput.set(lastProcessed.id, channelOutboxScope);
    }
    output = await runAgent(
      effectiveGroup,
      prompt,
      chatJid,
      lastProcessed.id,
      async (result) => {
        try {
          const isInterruptStatus =
            result.status === 'stream' &&
            result.streamEvent?.eventType === 'status' &&
            result.streamEvent.statusText === 'interrupted';
          const isUsageEvent =
            result.status === 'stream' &&
            result.streamEvent?.eventType === 'usage';
          if (
            !isInterruptStatus &&
            !isUsageEvent &&
            steeringTransitions.shouldSuppressOutput(
              chatJid,
              result.turnId || result.streamEvent?.turnId,
            )
          ) {
            logger.info(
              {
                chatJid,
                turnId: result.turnId || result.streamEvent?.turnId,
                status: result.status,
                eventType: result.streamEvent?.eventType,
              },
              'Superseded turn output suppressed during steer transition',
            );
            return;
          }
          // Warm runners may report the exact covered scheduled prompt only on
          // an earlier IPC receipt. Remember it before lifecycle/provider
          // callbacks return so the later genuine final can settle the same
          // durable run without guessing from ordinary conversation history.
          rememberScheduledGroupRuns(result);
          await activateMainProjectionForInput(result.inputTurnId);
          if (result.inputTurnCompleted) {
            const completedInputTurnIds = result.ipcReceipts?.length
              ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
              : [result.inputTurnId ?? lastProcessed.id];
            for (const inputTurnId of completedInputTurnIds) {
              healthyCompletedInputTurns.add(inputTurnId);
            }
            const completedInputs = result.ipcReceipts?.length
              ? result.ipcReceipts.flatMap((receipt) =>
                  (receipt.coveredCursors ?? [receipt.cursor]).map(
                    (cursor) => ({
                      chatJid: receipt.chatJid,
                      messageId: cursor.id,
                    }),
                  ),
                )
              : [{ chatJid, messageId: lastProcessed.id }];
            activeAgentBuilderTurns.clearCompleted(
              effectiveGroup.folder,
              completedInputs,
            );
          }
          if (result.newSessionId && result.status !== 'error') {
            activeSessionId = result.newSessionId;
          }
          // 流式事件处理 - 广播 WebSocket + 持久化 SDK Task 生命周期到 DB
          if (result.status === 'stream' && result.streamEvent) {
            if (result.streamEvent.workflowRun) {
              const run = result.streamEvent.workflowRun;
              activeWorkflowRuns = [
                ...activeWorkflowRuns.filter(
                  (item) => item.taskId !== run.taskId,
                ),
                run,
              ];
              if (run.status !== 'running') {
                completedWorkflowRuns = [
                  ...completedWorkflowRuns.filter(
                    (item) => item.taskId !== run.taskId,
                  ),
                  run,
                ];
              }
            }
            // ── 截断续写触顶信号（机器标记，不广播不展示）──
            // runner 连续续写仍被断流、放弃后发出。挂起中的卡片不能再等一个
            // 永远不会来的 healthy result，就地收口为「已中断」。
            if (
              result.streamEvent.eventType === 'status' &&
              result.streamEvent.statusText === TRUNCATION_EXHAUSTED_STATUS
            ) {
              if (heldCardParts.length > 0) {
                await finalizeHeldDbMessage(
                  '自动续写未能完成（上游连续断流），以上为已生成内容',
                  'truncated',
                ).catch(() => {});
                heldCardParts = [];
                heldCardUsage = null;
                if (streamingSession?.isActive()) {
                  await streamingSession
                    .abort('自动续写未能完成（上游连续断流），以上为已生成内容')
                    .catch(() => {});
                }
              }
              return;
            }
            // Claude SDK 的 costUSD 只是上游估算。实时 Web/飞书展示前先走
            // 与账本相同的 Kaboo 计价入口，确保流式金额和最终统计一致。
            // 后面的持久化调用会被 eventId 幂等去重，并负责关联最终消息。
            if (
              result.streamEvent.eventType === 'usage' &&
              result.streamEvent.usage
            ) {
              try {
                const accounting = writeUsageRecords({
                  userId:
                    effectiveGroup.created_by ||
                    registeredGroups[chatJid]?.created_by ||
                    'system',
                  groupFolder: effectiveGroup.folder,
                  messageId: lastReplyMsgId,
                  source: chatJid.split(':', 1)[0] || 'unknown',
                  usage: result.streamEvent.usage,
                });
                result.streamEvent.usage.costUSD =
                  accounting.providerEstimatedCostUSD;
              } catch (err) {
                logger.warn(
                  { err, chatJid },
                  'Failed to normalize usage cost before stream delivery',
                );
              }
              const ledgerUsage = result.streamEvent.usage;
              pendingLedgerUsageBatch = mergeHeldUsage(
                pendingLedgerUsageBatch,
                ledgerUsage,
              );
              const batchIndex = Math.max(0, ledgerUsage.batchIndex || 0);
              const batchCount = Math.max(1, ledgerUsage.batchCount || 1);
              if (batchIndex < batchCount - 1) return;
              result.streamEvent.usage = {
                ...pendingLedgerUsageBatch,
                eventId: ledgerUsage.eventId,
                batchIndex,
                batchCount,
              };
              pendingLedgerUsageBatch = null;
            }
            const streamInputTurnId = result.inputTurnId ?? lastProcessed.id;
            // Proactive SDK text is private model-loop state. Do not even feed
            // it into the Assistant answer reducer: a later empty/session-only
            // success must not be able to recover that hidden text as sdk_final.
            const answerProjection = publishesFrameworkAnswer(interactionMode)
              ? (
                  turnOutputCoordinators.get(streamInputTurnId) ??
                  bindTurnOutputCoordinator(streamInputTurnId)
                ).reduceStreamEvent(result.streamEvent)
              : null;
            if (answerProjection?.visibleAnswerChanged) {
              streamingAccumulatedText = answerProjection.visibleAnswerText;
            }

            if (
              shouldBroadcastSdkStreamEvent(interactionMode, result.streamEvent)
            ) {
              broadcastStreamEvent(chatJid, result.streamEvent);
            }

            // ── 累积 text_delta / thinking_delta 文本（中断时用于保存已输出内容）──
            // 仅累积主 Agent 文本（无 parentToolUseId）。子 Agent（SDK Task）的
            // 中间文本带 parentToolUseId，混入会污染飞书主卡片正文与 interrupt_partial。
            // 与 Web 端 chat.ts 对带 parentToolUseId 的 text_delta 隔离到 Task 块的逻辑对齐。
            // Main text remains provisional until the enclosing
            // AssistantMessage reaches message_stop. Interrupt persistence
            // follows the exact user-visible projection on every delta and
            // rolls back immediately if that message later calls a tool.
            if (
              result.streamEvent.eventType === 'thinking_delta' &&
              result.streamEvent.text &&
              !result.streamEvent.parentToolUseId
            ) {
              streamingAccumulatedThinking += result.streamEvent.text;
            }

            // ── Feed stream events into Feishu streaming card ──
            // 例外：卡片因连续更新失败进入 error 态时绝不在本轮重建——每次重建
            // 都会向群里再发一张新卡片（失败持续时演变成每隔几秒一条的刷屏），
            // 且清空 streamingAccumulatedText 会丢失已生成的内容。error 态保持
            // 冻结，让最终 result 走静态 sendMessage 兜底；下一条用户消息到达时
            // 由 route updater 重建干净卡片。
            const sessionErrored =
              streamingSession &&
              (streamingSession as { currentState?: string }).currentState ===
                'error';
            if (
              streamingSession &&
              !streamingSession.isActive() &&
              !sessionErrored &&
              !runEnded
            ) {
              unregisterStreamingSession(streamingSessionJid);
              streamingAccumulatedText = '';
              streamingAccumulatedThinking = '';
              // Note: sentReply is NOT reset here. Resetting it would cause
              // subsequent SDK Task results to be sent to IM as separate messages,
              // spamming the IM channel. The first substantive reply already
              // delivered the main content; follow-up results are DB-only.
              streamInterrupted = false;
              // Never rebuild here without a fresh input receipt and durable
              // lifecycle reservation. A second result belonging to the same
              // logical input falls back to that input's exact Outbox instead
              // of creating an ungoverned provider card.
              streamingSession = undefined;
              activeDurableCardLifecycle = undefined;
            }
            if (streamingSession) {
              const se = result.streamEvent;
              if (
                answerProjection?.visibleAnswerChanged &&
                streamingSession.isActive()
              ) {
                streamingSession.append(
                  heldCardBaseText() + answerProjection.visibleAnswerText,
                );
              }
              if (
                se.eventType === 'usage' &&
                se.usage &&
                heldCardParts.length > 0
              ) {
                // 挂起中：累计本 turn 的 usage 增量，不喂卡
                //（patchUsageNote 在 streaming 态本就 no-op，累计后定稿时合并补丁）。
                heldCardUsage = mergeHeldUsage(heldCardUsage, se.usage);
              } else if (
                se.eventType === 'usage' &&
                se.usage &&
                heldUsagePatchTarget
              ) {
                // 挂起回合刚定稿：合并挂起期累计 + 最终 turn 的 usage，
                // 补到已定稿的旧卡上（session 已轮换，正常喂卡会打到新空卡上 no-op）。
                const target = heldUsagePatchTarget;
                heldUsagePatchTarget = null;
                const merged = heldCardUsage
                  ? mergeHeldUsage(heldCardUsage, se.usage)
                  : se.usage;
                heldCardUsage = null;
                void target.patchUsageNote(merged);
              } else if (
                !(se.eventType === 'text_delta' && !se.parentToolUseId)
              ) {
                feedStreamEventToCard(
                  streamingSession,
                  se,
                  heldCardBaseText() + streamingAccumulatedText,
                  buildWebTraceUrl(
                    effectiveGroup.folder,
                    se.turnId || lastProcessed.id,
                  ),
                );
              }
            }

            // ── 中断时立即保存已输出内容 ──
            // agent-runner 中断后不退出进程（进入 waitForIpcMessage），
            // finally 块不会执行，必须在此处立即保存。
            if (
              result.streamEvent.eventType === 'status' &&
              result.streamEvent.statusText === 'interrupted'
            ) {
              const steered = resolveSteeringInterrupt(
                chatJid,
                result.streamEvent.turnId || result.turnId,
              );
              streamInterrupted = true;
              streamSteered ||= steered;
              // 引导是正常换向：干净收束已有内容；显式停止才显示中性停止状态。
              if (heldCardParts.length > 0) {
                const heldText = heldCardParts.join(HELD_TURN_DIVIDER);
                await finalizeHeldDbMessage(
                  steered ? null : '已停止',
                  'interrupted',
                  false,
                ).catch(() => {});
                heldCardParts = [];
                heldCardUsage = null;
                if (streamingSession?.isActive()) {
                  if (steered) {
                    await streamingSession.complete(heldText).catch(() => {});
                  } else {
                    await streamingSession.abort('已停止').catch(() => {});
                  }
                }
              }
              // Skip if shutdown handler already saved this text (prevents duplicates)
              const inlineWebJid = chatJid.startsWith('web:')
                ? chatJid
                : `web:${effectiveGroup.folder}`;
              const inlineAlreadySaved =
                shutdownSavedJids.has(chatJid) ||
                shutdownSavedJids.has(inlineWebJid);
              if (
                publishesFrameworkAnswer(interactionMode) &&
                !sentReply &&
                !inlineAlreadySaved
              ) {
                const interruptedText = steered
                  ? buildSteeredReply(streamingAccumulatedText)
                  : buildStoppedReply(
                      streamingAccumulatedText,
                      streamingAccumulatedThinking,
                    );
                try {
                  if (streamingSession?.isActive()) {
                    if (steered) {
                      await streamingSession
                        .complete(streamingAccumulatedText)
                        .catch(() => {});
                    } else {
                      await streamingSession.abort('已停止').catch(() => {});
                    }
                  }
                  if (interruptedText) {
                    lastReplyMsgId = await sendMessage(
                      chatJid,
                      interruptedText,
                      {
                        sendToIM: false,
                        messageMeta: {
                          turnId: result.streamEvent.turnId || lastProcessed.id,
                          sessionId:
                            result.streamEvent.sessionId || activeSessionId,
                          sourceKind: 'interrupt_partial',
                          finalizationReason: 'interrupted',
                        },
                      },
                    );
                  }
                  sentReply = true;
                  clearStreamingSnapshot(chatJid);
                  streamingAccumulatedText = '';
                  streamingAccumulatedThinking = '';
                  commitCursor(
                    resolveContainerOutputInputTurnId(result, lastProcessed.id),
                  );
                } catch (err) {
                  logger.warn(
                    { err, chatJid },
                    'Failed to save interrupted text on status event',
                  );
                }
              }
            }

            // Persist SDK Task lifecycle to DB so tabs survive page refresh
            const se = result.streamEvent;
            if (
              (se.eventType === 'task_start' && se.toolUseId) ||
              (se.eventType === 'tool_use_start' &&
                se.toolName === 'Task' &&
                se.toolUseId)
            ) {
              try {
                const taskId = se.toolUseId;
                queryTaskIds.add(taskId);
                const existing = getAgent(taskId);
                const desc = se.taskDescription || se.toolInputSummary || '';
                const taskName = desc.slice(0, 40) || existing?.name || 'Task';
                if (!existing) {
                  createAgent({
                    id: taskId,
                    group_folder: group.folder,
                    chat_jid: chatJid,
                    name: taskName,
                    prompt: desc,
                    status: 'running',
                    kind: 'task',
                    created_by: null,
                    created_at: new Date().toISOString(),
                    completed_at: null,
                    result_summary: null,
                    last_im_jid: null,
                    spawned_from_jid: null,
                  });
                } else if (se.taskDescription) {
                  updateAgentInfo(
                    taskId,
                    se.taskDescription.slice(0, 40),
                    se.taskDescription,
                  );
                }
                if (publishesFrameworkAnswer(interactionMode)) {
                  broadcastAgentStatus(
                    chatJid,
                    taskId,
                    'running',
                    taskName,
                    desc,
                    undefined,
                    'task',
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, toolUseId: se.toolUseId },
                  'Failed to persist task_start to DB',
                );
              }
            }
            if (se.eventType === 'tool_use_end' && se.toolUseId) {
              try {
                const existing = getAgent(se.toolUseId);
                if (
                  existing &&
                  existing.kind === 'task' &&
                  existing.status === 'running'
                ) {
                  updateAgentStatus(se.toolUseId, 'completed');
                  queryTaskIds.delete(existing.id);
                  if (publishesFrameworkAnswer(interactionMode)) {
                    broadcastAgentStatus(
                      chatJid,
                      existing.id,
                      'completed',
                      existing.name,
                      existing.prompt,
                      existing.result_summary || '任务已完成',
                      'task',
                    );
                  }
                }
              } catch (err) {
                logger.warn(
                  { err, toolUseId: se.toolUseId },
                  'Failed to persist tool_use_end to DB',
                );
              }
            }
            if (se.eventType === 'task_notification' && se.taskId) {
              try {
                const status =
                  se.taskStatus === 'completed' ? 'completed' : 'error';
                const summary = se.taskSummary?.slice(0, 2000);
                let targetTaskId = se.taskId;
                let existing = getAgent(targetTaskId);
                if (!existing || existing.kind !== 'task') {
                  // agent-runner now translates SDK task_id → toolUseId,
                  // so this fallback should rarely trigger. Keep as safety net.
                  const fallbackTaskId = pickRunningTaskForNotification();
                  if (fallbackTaskId) {
                    targetTaskId = fallbackTaskId;
                    existing = getAgent(fallbackTaskId);
                    logger.debug(
                      {
                        chatJid,
                        sdkTaskId: se.taskId,
                        mappedTaskId: fallbackTaskId,
                      },
                      'Task notification ID fallback to running task',
                    );
                  }
                }

                if (!existing) {
                  createAgent({
                    id: targetTaskId,
                    group_folder: group.folder,
                    chat_jid: chatJid,
                    name: 'Task',
                    prompt: '',
                    status,
                    kind: 'task',
                    created_by: null,
                    created_at: new Date().toISOString(),
                    completed_at: new Date().toISOString(),
                    result_summary: summary || null,
                    last_im_jid: null,
                    spawned_from_jid: null,
                  });
                  if (publishesFrameworkAnswer(interactionMode)) {
                    broadcastAgentStatus(
                      chatJid,
                      targetTaskId,
                      status,
                      'Task',
                      '',
                      summary,
                      'task',
                    );
                  }
                } else if (existing.kind === 'task') {
                  updateAgentStatus(existing.id, status, summary);
                  queryTaskIds.delete(existing.id);
                  if (publishesFrameworkAnswer(interactionMode)) {
                    broadcastAgentStatus(
                      chatJid,
                      existing.id,
                      status,
                      existing.name,
                      existing.prompt,
                      summary,
                      'task',
                    );
                  }
                }
              } catch (err) {
                logger.warn(
                  { err, taskId: se.taskId },
                  'Failed to persist task_notification to DB',
                );
              }
            }

            // Persist token usage to the latest agent message + usage_records
            if (se.eventType === 'usage' && se.usage) {
              try {
                writeUsageRecords({
                  userId:
                    effectiveGroup.created_by ||
                    registeredGroups[chatJid]?.created_by ||
                    'system',
                  groupFolder: effectiveGroup.folder,
                  messageId: lastReplyMsgId,
                  source: chatJid.split(':', 1)[0] || 'unknown',
                  usage: se.usage,
                });
                if (lastReplyMsgId) {
                  rebuildMessageTokenUsageFromLedger(
                    chatJid,
                    effectiveGroup.folder,
                    lastReplyMsgId,
                  );
                } else {
                  updateLatestMessageTokenUsage(
                    chatJid,
                    JSON.stringify(se.usage),
                    undefined,
                    se.usage.costUSD,
                  );
                }

                logger.debug(
                  {
                    chatJid,
                    msgId: lastReplyMsgId,
                    costUSD: se.usage.costUSD,
                    inputTokens: se.usage.inputTokens,
                  },
                  'Token usage persisted',
                );

                // recordUsageEvent updates analytics, token quotas and balance
                // for both paid and zero-cost runs. Only the realtime UI push
                // remains here.
                const ownerId =
                  effectiveGroup.created_by ||
                  registeredGroups[chatJid]?.created_by;
                if (ownerId) {
                  const owner = getUserById(ownerId);
                  if (owner && owner.role !== 'admin') {
                    const freshAccess = checkBillingAccessFresh(
                      ownerId,
                      owner.role,
                    );
                    if (freshAccess.usage) {
                      broadcastBillingUpdate(ownerId, { ...freshAccess });
                    }
                  }
                }
              } catch (err) {
                logger.warn({ err, chatJid }, 'Failed to persist token usage');
              }
            }

            // Reset idle timer on stream events so long-running tool calls
            // (e.g. MCP batch writes) don't get killed while the agent is
            // actively working. Previously only final results triggered a reset.
            resetIdleTimer();
            return;
          }

          // Surface a stable localized notice only after the host has exhausted the
          // provider pool. Otherwise preserve the input for failover replay.
          if (result.providerFailure) {
            const providerFailureInputId = resolveContainerOutputInputTurnId(
              result,
              lastProcessed.id,
            );
            rollbackIdleMainCardReservation(providerFailureInputId);
            if (result.providerFailureTerminal !== true) {
              providerFailoverPending = true;
              logger.warn(
                {
                  group: group.name,
                  inputTurnId: providerFailureInputId,
                },
                'Provider failure kept retryable for failover',
              );
              resetIdleTimer();
              return;
            }
            const terminalGroupFailureDurable =
              await projectCurrentScheduledGroupTerminal(
                'failed',
                PROVIDER_FAILURE_USER_NOTICE,
              );
            // The dedicated scheduled-task failure projection is richer and
            // stable across replay. Suppress the generic provider notice only
            // when that exact run has been durably projected or queued for
            // workspace retry.
            result.result = terminalGroupFailureDurable
              ? null
              : PROVIDER_FAILURE_USER_NOTICE;
            logger.warn(
              {
                group: group.name,
                terminalGroupFailureDurable,
              },
              'Provider failure surfaced to user',
            );
          }

          if (
            !publishesFrameworkAnswer(interactionMode) &&
            !result.providerFailure
          ) {
            const proactiveInputId = resolveContainerOutputInputTurnId(
              result,
              lastProcessed.id,
            );
            const scheduledRuns = [
              ...(scheduledGroupRunsByInput.get(proactiveInputId)?.values() ??
                []),
            ];
            const completedScheduledCandidate =
              result.status === 'success' &&
              result.inputTurnCompleted === true &&
              result.proactiveFinalCandidate?.trim()
                ? stripAgentInternalTags(result.proactiveFinalCandidate).trim()
                : '';
            if (
              scheduledRuns.length > 0 &&
              result.inputTurnCompleted === true
            ) {
              if (completedScheduledCandidate) {
                const messageId = `scheduled-group-result:${crypto
                  .createHash('sha256')
                  .update(
                    [
                      chatJid,
                      proactiveInputId,
                      ...scheduledRuns.map((run) => run.id).sort(),
                    ].join('\0'),
                  )
                  .digest('hex')
                  .slice(0, 32)}`;
                const outcome = await sendMessageWithOutcome(
                  chatJid,
                  completedScheduledCandidate,
                  {
                    messageId,
                    sendToIM: false,
                    source: 'scheduled_task',
                    messageMeta: {
                      turnId: proactiveInputId,
                      sessionId: result.sessionId || activeSessionId,
                      sourceKind: 'scheduled_task_result',
                      finalizationReason: 'completed',
                    },
                    scheduledGroupFinalizations: scheduledRuns.map((run) => ({
                      runId: run.id,
                      taskId: run.task_id,
                      status: 'success',
                      result: completedScheduledCandidate,
                      error: null,
                    })),
                  },
                );
                settleScheduledGroupWorkspaceProjection({
                  runs: scheduledRuns,
                  chatJid,
                  workspaceFolder: effectiveGroup.folder,
                  text: completedScheduledCandidate,
                  messageId,
                  projected: outcome.webProjected && !!outcome.messageId,
                });
              } else {
                await projectCurrentScheduledGroupTerminal(
                  'failed',
                  '定时任务已结束，但 Agent 没有返回可展示的完整业务结果。',
                );
              }
            } else if (result.proactiveFinalCandidate?.trim()) {
              const outputScope =
                channelOutboxScopesByInput.get(proactiveInputId);
              const recovery = await recoverProactiveFinalCandidate({
                registry: activeTurnOutputs,
                scopeKey: mainAdmissionKey,
                inputTurnId: proactiveInputId,
                inputTurnCompleted: result.inputTurnCompleted,
                candidate: result.proactiveFinalCandidate,
                canDeliver: () =>
                  canDeliverTurnUtterance(
                    effectiveGroup.folder,
                    null,
                    proactiveInputId,
                  ),
                deliver: (text) =>
                  deliverProactiveFinalFallback({
                    logicalChatJid: chatJid,
                    scopeKey: mainAdmissionKey,
                    inputTurnId: proactiveInputId,
                    text,
                    sessionId: activeSessionId,
                    targetJid: outputScope?.sourceJid ?? replySourceImJid,
                    scope: outputScope,
                  }),
              });
              if (recovery.projected) {
                sentReplyByInput.set(proactiveInputId, true);
              }
              if (recovery.targetDelivered) {
                channelPhysicalDeliveryAckByInput.set(proactiveInputId, true);
                genuineReplyDeliveredByInput.set(proactiveInputId, true);
              }
              logger[recovery.projected ? 'warn' : 'info'](
                {
                  group: effectiveGroup.folder,
                  inputTurnId: proactiveInputId,
                  recoveryReason: recovery.reason,
                  deliveryPath: recovery.path,
                  targetDelivered: recovery.targetDelivered,
                },
                recovery.projected
                  ? 'Recovered Proactive SDK final that was not sent through send_message'
                  : 'Proactive SDK final recovery not required',
              );
            }
            // In Proactive mode the SDK Result is an internal control-plane
            // terminal, never a user-visible answer. A healthy turn may have
            // emitted several native messages or intentionally stayed silent.
            result.result = null;
            if (
              isProactiveControlPlaneSuccess({
                mode: interactionMode,
                status: result.status,
                providerFailure: result.providerFailure,
              })
            ) {
              if (result.inputTurnCompleted) {
                if (await completeChannelRuntimesForOutput(result)) {
                  commitCursor(
                    resolveContainerOutputInputTurnId(result, lastProcessed.id),
                  );
                }
                finalizeProactiveOutputCoordinators(result);
                broadcastStreamEvent(chatJid, {
                  eventType: 'status',
                  statusText: 'idle',
                  turnId: result.inputTurnId ?? lastProcessed.id,
                  sessionId: activeSessionId,
                });
              }
              resetIdleTimer();
              // Interim background results and SIGTERM's session-only success
              // intentionally have no inputTurnCompleted flag. They are still
              // control-plane events and must never fall through to sdk_final.
              return;
            }
          }

          // Merge SDK Result and any send_message(final) candidate into the
          // same primary answer slot. A non-empty SDK Result stays
          // authoritative; the staged MCP candidate is only a fallback for a
          // genuinely empty Result, never an independently delivered message.
          if (
            shouldResolveFrameworkPrimaryAnswer({
              mode: interactionMode,
              status: result.status,
              sourceKind: result.sourceKind,
              providerFailure: result.providerFailure,
            })
          ) {
            const resultInputTurnId = resolveContainerOutputInputTurnId(
              result,
              lastProcessed.id,
            );
            const projectionDecision = decideAssistantPrimaryProjection({
              canonicalInputTurnId: resultInputTurnId,
              status: result.status,
              result: result.result,
              sourceKind: result.sourceKind,
              inputTurnId: result.inputTurnId,
              ipcReceiptCount: result.ipcReceipts?.length,
              inputTurnCompleted: result.inputTurnCompleted,
              finalizationReason: result.finalizationReason,
              pendingBgTasks: result.pendingBgTasks,
              sdkMessageUuid: result.sdkMessageUuid,
              primaryAlreadyProjected:
                genuineReplyDeliveredByInput.get(resultInputTurnId) === true,
              anyReplyProjected:
                sentReplyByInput.get(resultInputTurnId) === true,
            });
            if (!projectionDecision.project) {
              result.result = null;
              if (
                result.inputTurnCompleted &&
                (await completeChannelRuntimesForOutput(result))
              ) {
                commitCursor(resultInputTurnId);
              }
              logger.info(
                {
                  group: group.name,
                  inputTurnId: resultInputTurnId,
                  reason: projectionDecision.reason,
                },
                'Assistant terminal output handled as lifecycle-only',
              );
              resetIdleTimer();
              return;
            }
            const coordinator =
              turnOutputCoordinators.get(resultInputTurnId) ??
              bindTurnOutputCoordinator(resultInputTurnId);
            const resolved = coordinator.resolvePrimaryAnswer(result.result);
            result.result = resolved.text;
          }

          // Streaming output callback — called for each agent result
          if (result.result) {
            const outputChannelScope = channelScopeForOutput(result);
            if (outputChannelScope.rejected) {
              hadError = true;
              logger.error(
                { chatJid, inputTurnId: outputChannelScope.inputId },
                'Suppressing output for a warm input that failed durable admission',
              );
              return;
            }
            const outputCardProjection = channelStreamingSessionsByInput.get(
              outputChannelScope.inputId,
            );
            const outputStreamingSession = outputCardProjection?.session;
            const outputReplySourceJid =
              outputChannelScope.scope?.sourceJid ?? replySourceImJid;
            if (outputReplySourceJid && !outputChannelScope.scope) {
              hadError = true;
              logger.error(
                { chatJid, inputTurnId: outputChannelScope.inputId },
                'Suppressing IM output without an exact durable turn scope',
              );
              return;
            }
            const outputAlreadySent =
              sentReplyByInput.get(outputChannelScope.inputId) ?? false;
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            let text = stripAgentInternalTags(raw);
            if (
              result.sourceKind === 'overflow_partial' ||
              result.sourceKind === 'compact_partial'
            ) {
              text = buildOverflowPartialReply(text);
            }
            // auto_continue outputs that consist solely of system-maintenance
            // acknowledgements (e.g. "OK", "已更新 CLAUDE.md") are suppressed from
            // IM delivery. These arise when the agent's session transcript contains
            // memory-flush / CLAUDE.md-update context from the compaction pipeline
            // and the agent echoes it back in the resumption query. Substantive
            // user-facing continuations (longer replies or actual task resumption)
            // pass through normally. See issue #275.
            if (
              result.sourceKind === 'auto_continue' &&
              isSystemMaintenanceNoise(text)
            ) {
              logger.info(
                { group: group.name, textLen: text.length },
                'auto_continue output suppressed (system maintenance noise)',
              );
              return;
            }
            logger.info(
              { group: group.name },
              `Agent output: ${raw.slice(0, 200)}`,
            );
            if (text) {
              // ── 挂起判定（消息级，与卡片存在性解耦）──
              // 后台任务未 settle / 截断待续写的 result 进入挂起序列：内容进
              // heldCardParts，DB 合并到同一条消息（全渠道一条回复），有卡片
              // 则卡片同步保持活跃，全部结束后的 healthy result 才收尾。
              const isPartialOutput =
                result.sourceKind === 'compact_partial' ||
                result.sourceKind === 'overflow_partial';
              const holdReason: 'bg_tasks' | 'truncated' | null = runEnded
                ? null
                : result.finalizationReason === 'truncated' || isPartialOutput
                  ? 'truncated'
                  : (result.pendingBgTasks ?? 0) > 0
                    ? 'bg_tasks'
                    : null;
              // 状态提示追加进正文：进入 DB / Web / 卡片转录，非卡渠道（QQ 纯文本
              // 等无法挂起的通道）也能看到"还没完"。
              if (result.finalizationReason === 'truncated') {
                text += '\n\n> ⚠️ 回复在生成中被上游截断，正在自动续写…';
              } else if ((result.pendingBgTasks ?? 0) > 0) {
                text += `\n\n> ⏳ ${result.pendingBgTasks} 个后台任务运行中，完成后将继续汇总`;
              }
              if (!holdReason) text = stripRedundantCompletionPreamble(text);
              const localImagePaths = extractLocalImImagePaths(
                text,
                effectiveGroup.folder,
              );
              // 新 result 到达即关闭上一轮的 usage 合并补丁窗口
              heldUsagePatchTarget = null;
              // DB 合并用：进入卡片分支前留存已有挂起前缀（分支内会改动 parts）
              const heldBaseForDb = heldCardBaseText();
              const wasInHeldSeq = heldDbTurnId !== null;

              // ── Complete or hold Feishu streaming card ──
              // If a streaming card is active, finalize it with the complete text.
              // The card replaces the normal IM sendMessage for the Feishu channel.
              let streamingCardHandledIM = false;
              let streamingCardAttachmentsDelivered = true;
              let cardHeldThisResult = false;
              let pendingStreamingCardCompletion:
                | NonNullable<typeof outputStreamingSession>
                | undefined;
              if (holdReason) {
                heldCardParts.push(text);
                cardHeldThisResult = true;
                if (outputStreamingSession?.isActive()) {
                  streamingCardHandledIM = true;
                  const holdNote =
                    holdReason === 'truncated'
                      ? '检测到上游断流，自动续写中…'
                      : `${result.pendingBgTasks} 个后台任务运行中，完成后将继续汇总`;
                  outputStreamingSession.setSystemStatus(holdNote);
                  if (
                    outputStreamingSession instanceof StreamingCardController
                  ) {
                    outputStreamingSession.setHeldOpen(
                      holdReason === 'bg_tasks'
                        ? (result.pendingBgTasks ?? 0)
                        : null,
                    );
                  }
                }
                logger.info(
                  {
                    chatJid,
                    holdReason,
                    pendingBgTasks: result.pendingBgTasks,
                    heldParts: heldCardParts.length,
                    cardActive: streamingCardHandledIM,
                  },
                  'Reply held open (background tasks / truncation continue)',
                );
              } else if (outputStreamingSession?.isActive()) {
                pendingStreamingCardCompletion = outputStreamingSession;
                streamingCardHandledIM = true;
              }

              // ── Rebuild streaming card after completion ──
              // The completed card was consumed; create a new one so subsequent
              // messages get a fresh streaming card instead of falling back to static.
              // Previously only rebuilt for partial outputs (#223); now rebuild for
              // all completions to fix DingTalk "second message gets no reply" bug.
              // 挂起中的卡片不轮换：session 保持原状，后续 turn 继续追加。
              if (streamingCardHandledIM && !pendingStreamingCardCompletion) {
                // Streaming card strips local image references (only img_xxx keys
                // are valid in Feishu cards).  Send any local images as separate
                // messages so they are not silently lost.
                if (localImagePaths.length > 0 && outputReplySourceJid) {
                  for (
                    let imageIndex = 0;
                    imageIndex < localImagePaths.length;
                    imageIndex++
                  ) {
                    const imgPath = localImagePaths[imageIndex];
                    try {
                      const imgBuf = await fs.promises.readFile(imgPath);
                      const mimeType = detectImageMimeType(imgBuf);
                      if (!outputChannelScope.scope) {
                        streamingCardAttachmentsDelivered = false;
                        logger.error(
                          { chatJid, imgPath },
                          'Suppressed streaming-card image without an exact durable turn scope',
                        );
                        continue;
                      }
                      const delivered = await sendTaskImageWithRetry(
                        outputReplySourceJid,
                        imgBuf,
                        mimeType,
                        undefined,
                        path.basename(imgPath),
                        {
                          scopeKey: channelTurnScope(effectiveGroup.folder),
                          scopeToken: outputChannelScope.scope.token,
                          operationKey: `streaming-card-image:${outputChannelScope.inputId}:${imageIndex}`,
                          ordinalSlot: `streaming-card-image:${imageIndex}`,
                        },
                      );
                      if (!delivered) {
                        streamingCardAttachmentsDelivered = false;
                        continue;
                      }
                      logger.info(
                        { chatJid, imgPath },
                        'Sent local image after streaming card completion',
                      );
                    } catch (imgErr) {
                      streamingCardAttachmentsDelivered = false;
                      logger.warn(
                        { chatJid, imgPath, err: imgErr },
                        'Failed to send local image after streaming card',
                      );
                    }
                  }
                }

                if (!cardHeldThisResult) {
                  channelStreamingSessionsByInput.delete(
                    outputChannelScope.inputId,
                  );
                  streamingAccumulatedText = '';
                  streamingAccumulatedThinking = '';
                  // Do not pre-create the next provider card. Its deterministic
                  // run id and lifecycle only exist after the next input receipt;
                  // the route updater creates both together.
                  if (outputStreamingSession === streamingSession) {
                    if (outputCardProjection) {
                      unregisterStreamingSession(outputCardProjection.jid);
                    }
                    streamingSession = undefined;
                    activeDurableCardLifecycle = undefined;
                  }
                }
              }

              // Skip IM send to the original chatJid when:
              // 1. Streaming card already handled the IM delivery, OR
              // 2. Reply route switched to a different IM channel (the routed IM
              //    path below will deliver to the correct channel instead), OR
              // 3. Reply route was cleared to null (web message injected into an
              //    IM-originated session — replies should go to web only).
              // Any send_message content is delivered independently via IPC watcher.
              const routeCleared =
                directImReply && outputReplySourceJid === null;
              const routeSwitchedAway =
                directImReply &&
                outputReplySourceJid !== null &&
                outputReplySourceJid !== chatJid;
              const skipImSend =
                (streamingCardHandledIM && directImReply) ||
                routeSwitchedAway ||
                routeCleared;
              // One immutable user input owns one canonical primary-answer row.
              // Presentation turnId may rotate or be absent on a trailing host
              // lifecycle frame; never use that mutable field to fork DB identity.
              const effectiveTurnId = outputChannelScope.inputId;
              // ── 挂起序列 DB 合并：全渠道一条回复 ──
              // 序列内所有 turn（含收尾）共用第一个 held turn 的 turnId，
              // storeMessageDirect 按 (chat_jid, turn_id) UPSERT 覆盖同一行，
              // 正文为按时间序拼接的全量内容；Web 端按消息 id 原地替换气泡。
              // 纯文本 IM 渠道无法编辑已发消息，经 imTextOverride 只发本 turn 增量。
              let dbText = text;
              let turnIdForDb: string | undefined;
              if (holdReason || wasInHeldSeq) {
                if (!heldDbTurnId) heldDbTurnId = effectiveTurnId;
                turnIdForDb = heldDbTurnId;
                // Intermediate held turns remain visible while running. The
                // healthy completion replaces them with the authoritative
                // final answer; WorkflowRunCard preserves the execution trace.
                dbText = holdReason ? heldBaseForDb + text : text;
                if (!holdReason) heldDbTurnId = null; // healthy 收尾，序列结束
              } else {
                turnIdForDb = effectiveTurnId;
              }
              const isGenuineCompletedGroupResult =
                result.status === 'success' &&
                !result.providerFailure &&
                !holdReason &&
                result.inputTurnCompleted === true &&
                isGenuineReplyResult({
                  holdReason,
                  sourceKind: result.sourceKind,
                  finalizationReason: result.finalizationReason,
                });
              const scheduledGroupRuns = isGenuineCompletedGroupResult
                ? [
                    ...(scheduledGroupRunsByInput
                      .get(effectiveTurnId)
                      ?.values() ?? []),
                  ]
                : [];
              const scheduledGroupResultMessageId =
                scheduledGroupRuns.length > 0
                  ? `scheduled-group-result:${crypto
                      .createHash('sha256')
                      .update(
                        [
                          chatJid,
                          effectiveTurnId,
                          ...scheduledGroupRuns.map((run) => run.id).sort(),
                        ].join('\0'),
                      )
                      .digest('hex')
                      .slice(0, 32)}`
                  : undefined;
              const durableOutputIdentity =
                result.sdkMessageUuid ||
                crypto
                  .createHash('sha256')
                  .update(text)
                  .digest('hex')
                  .slice(0, 24);

              const replySendOutcome = await sendMessageWithOutcome(
                chatJid,
                dbText,
                {
                  messageId: scheduledGroupResultMessageId,
                  sendToIM: directImReply && !skipImSend,
                  imTextOverride: dbText !== text ? text : undefined,
                  localImagePaths,
                  channelOutbox: outputChannelScope.scope
                    ? {
                        scopeKey: channelTurnScope(effectiveGroup.folder),
                        scopeToken: outputChannelScope.scope.token,
                        operationKey: `main:${lastProcessed.id}:${effectiveTurnId}:${durableOutputIdentity}`,
                      }
                    : undefined,
                  workflowRuns: holdReason
                    ? activeWorkflowRuns
                    : completedWorkflowRuns,
                  messageMeta: {
                    turnId: turnIdForDb,
                    sessionId: result.sessionId || activeSessionId,
                    sdkMessageUuid: result.sdkMessageUuid,
                    sourceKind: result.sourceKind || 'sdk_final',
                    finalizationReason:
                      result.finalizationReason || 'completed',
                  },
                  scheduledGroupFinalizations: scheduledGroupRuns.map(
                    (run) => ({
                      runId: run.id,
                      taskId: run.task_id,
                      status: 'success',
                      result: dbText,
                      error: null,
                    }),
                  ),
                },
              );
              lastReplyMsgId = replySendOutcome.messageId;
              const scheduledGroupProjectionDurable =
                scheduledGroupRuns.length > 0
                  ? settleScheduledGroupWorkspaceProjection({
                      runs: scheduledGroupRuns,
                      chatJid,
                      workspaceFolder: effectiveGroup.folder,
                      text: dbText,
                      messageId: scheduledGroupResultMessageId!,
                      projected:
                        replySendOutcome.webProjected &&
                        !!replySendOutcome.messageId,
                    })
                  : false;
              // A final provider-card ACK is the irreversible user-visible
              // side effect for this turn.  Do it only after the Web/DB row is
              // durable, and only after every local attachment has reached
              // its exact turn-scoped Outbox destination.  This ordering
              // makes a crash before DB persistence safely retryable and
              // prevents a completed card from claiming success while one of
              // its files is still missing.
              let pendingStreamingCardCompleted = false;
              if (pendingStreamingCardCompletion) {
                if (localImagePaths.length > 0 && outputReplySourceJid) {
                  for (
                    let imageIndex = 0;
                    imageIndex < localImagePaths.length;
                    imageIndex++
                  ) {
                    const imgPath = localImagePaths[imageIndex];
                    try {
                      if (!outputChannelScope.scope) {
                        streamingCardAttachmentsDelivered = false;
                        logger.error(
                          { chatJid, imgPath },
                          'Suppressed final streaming-card image without an exact durable turn scope',
                        );
                        continue;
                      }
                      const imgBuf = await fs.promises.readFile(imgPath);
                      const delivered = await sendTaskImageWithRetry(
                        outputReplySourceJid,
                        imgBuf,
                        detectImageMimeType(imgBuf),
                        undefined,
                        path.basename(imgPath),
                        {
                          scopeKey: channelTurnScope(effectiveGroup.folder),
                          scopeToken: outputChannelScope.scope.token,
                          operationKey: `streaming-card-image:${outputChannelScope.inputId}:${imageIndex}`,
                          ordinalSlot: `streaming-card-image:${imageIndex}`,
                        },
                      );
                      if (!delivered) {
                        streamingCardAttachmentsDelivered = false;
                      }
                    } catch (imgErr) {
                      streamingCardAttachmentsDelivered = false;
                      logger.warn(
                        { chatJid, imgPath, err: imgErr },
                        'Failed to deliver final streaming-card image',
                      );
                    }
                  }
                }

                const cardFinalization = await finalizeChannelCardAfterDelivery(
                  pendingStreamingCardCompletion,
                  text,
                  streamingCardAttachmentsDelivered,
                  streamingCardAttachmentsDelivered
                    ? '回复投递未确认，系统将重试'
                    : '附件投递未确认，系统将重试',
                );
                pendingStreamingCardCompleted = cardFinalization.acknowledged;
                if (pendingStreamingCardCompleted) {
                  heldUsagePatchTarget = pendingStreamingCardCompletion;
                  heldCardParts = [];
                } else if (cardFinalization.error) {
                  logger.warn(
                    { cardError: cardFinalization.error, chatJid },
                    'Streaming card final ACK failed; keeping the channel turn retryable',
                  );
                } else {
                  logger.error(
                    { chatJid, inputTurnId: outputChannelScope.inputId },
                    'Streaming card remains unfinished because an attachment was not physically ACKed',
                  );
                }

                // A provisional active card is not a delivery ACK.  Failed
                // attachment/card completion must flow into the retry path.
                streamingCardHandledIM = pendingStreamingCardCompleted;
                if (pendingStreamingCardCompleted) {
                  channelStreamingSessionsByInput.delete(
                    outputChannelScope.inputId,
                  );
                  if (outputStreamingSession === streamingSession) {
                    if (outputCardProjection) {
                      unregisterStreamingSession(outputCardProjection.jid);
                    }
                    streamingSession = undefined;
                    activeDurableCardLifecycle = undefined;
                  }
                }
              }
              // A completed streaming card is the physical IM delivery. The
              // static send path is intentionally skipped in that case, so its
              // targetDelivered flag remains false even though Feishu ACKed the
              // card. Any separately emitted local image is part of the same
              // logical reply and must also be durably ACKed before the turn can
              // advance its cursor.
              let replyDeliveryAcknowledged = streamingCardHandledIM
                ? streamingCardAttachmentsDelivered
                : replySendOutcome.targetDelivered;
              // A Web-only group-mode task must not replay Agent work after
              // its canonical projection failure has been persisted for
              // idempotent notification-worker repair.
              if (
                scheduledGroupRuns.length > 0 &&
                !directImReply &&
                !outputReplySourceJid &&
                scheduledGroupProjectionDurable
              ) {
                replyDeliveryAcknowledged = true;
              }
              if (!holdReason) {
                activeWorkflowRuns = [];
                completedWorkflowRuns = [];
              }
              // For routed IM (web JID with IM source), only send the FIRST
              // substantive reply to IM. Subsequent results (e.g., SDK Task
              // completions) are stored in DB but not spammed to IM.
              // Streaming card already handles IM delivery for the first reply.
              if (outputReplySourceJid && outputReplySourceJid !== chatJid) {
                if (!streamingCardHandledIM && !outputAlreadySent) {
                  replyDeliveryAcknowledged = await sendImWithRetry(
                    outputReplySourceJid,
                    text,
                    localImagePaths,
                    outputChannelScope.scope
                      ? {
                          scopeKey: channelTurnScope(effectiveGroup.folder),
                          scopeToken: outputChannelScope.scope.token,
                          operationKey: `main-routed:${lastProcessed.id}:${effectiveTurnId}:${durableOutputIdentity}`,
                        }
                      : undefined,
                  );
                }
              }

              // Optional mirror mode for explicitly bound IM channels
              const webJid = chatJid.startsWith('web:')
                ? chatJid
                : `web:${effectiveGroup.folder}`;
              let mirrorDeliveryAcknowledged = true;
              for (const [imJid, g] of Object.entries(registeredGroups)) {
                if (
                  g.target_main_jid !== webJid ||
                  imJid === chatJid ||
                  imJid === replySourceImJid
                )
                  continue;
                if (g.reply_policy !== 'mirror') continue;
                if (!getChannelType(imJid)) continue;
                const mirrorRuntime = channelTurnRuntimes.get(
                  outputChannelScope.inputId,
                );
                const mirrorAddress = parseChannelAddress(imJid);
                const mirrorAccountId =
                  mirrorAddress?.channelAccountId ?? g.channel_account_id;
                if (!mirrorRuntime || !mirrorAddress || !mirrorAccountId) {
                  mirrorDeliveryAcknowledged = false;
                  logger.error(
                    { chatJid, imJid, inputTurnId: outputChannelScope.inputId },
                    'Suppressed mirror delivery without an exact durable source turn',
                  );
                  continue;
                }
                const mirrorScope = bindChannelOutboxScope(
                  mainAdmissionKey,
                  mirrorRuntime,
                  {
                    provider: mirrorAddress.provider,
                    accountId: mirrorAccountId,
                    sourceJid: imJid,
                    chatId: mirrorAddress.externalChatId,
                    rootId: mirrorAddress.rootMessageId,
                    threadId: mirrorAddress.threadId,
                  },
                );
                channelOutboxScopesByInput.set(
                  `${outputChannelScope.inputId}:mirror:${imJid}`,
                  mirrorScope,
                );
                const delivered = await sendImWithRetry(
                  imJid,
                  text,
                  localImagePaths,
                  {
                    scopeKey: mainAdmissionKey,
                    scopeToken: mirrorScope.token,
                    operationKey: `main-mirror:${outputChannelScope.inputId}:${imJid}:${durableOutputIdentity}`,
                    ordinalSlot: `mirror:${imJid}`,
                  },
                );
                mirrorDeliveryAcknowledged &&= delivered;
              }
              replyDeliveryAcknowledged &&= mirrorDeliveryAcknowledged;
              // An IM/card ACK proves only a channel side effect. Every
              // scheduled group occurrence must also have durably committed
              // its canonical Web result and business terminal before its
              // input cursor may advance; otherwise a DB failure can consume
              // the prompt while leaving the run stranded in `delivered`.
              if (scheduledGroupRuns.length > 0) {
                replyDeliveryAcknowledged &&= scheduledGroupProjectionDurable;
              }

              sentReply = true;
              sentReplyByInput.set(outputChannelScope.inputId, true);
              // See isGenuineReplyResult's doc comment (src/reply-delivery.ts)
              // for why a held/partial result must not count. Only ever SET
              // to true, never overwrite back to false: a later held/partial
              // result within the same multi-result turn (e.g. a follow-up
              // SDK task result after the main reply already completed)
              // must not erase an earlier genuine delivery in this same run.
              if (
                replyDeliveryAcknowledged &&
                isGenuineReplyResult({
                  holdReason,
                  sourceKind: result.sourceKind,
                  finalizationReason: result.finalizationReason,
                })
              ) {
                genuineReplyDeliveredByInput.set(
                  outputChannelScope.inputId,
                  true,
                );
                const completedCoordinator = turnOutputCoordinators.get(
                  outputChannelScope.inputId,
                );
                completedCoordinator?.markFinalized();
              }
              // Clear streaming snapshot so the next turn starts fresh.
              // Without this, saveInterruptedStreamingMessages() would merge
              // text from multiple turns into one message on shutdown.
              // A held result is only an intermediate acknowledgement. Keep
              // the Workflow task snapshot alive across the background wait;
              // the authoritative completion result will clear it later.
              if (!holdReason) {
                clearStreamingSnapshot(chatJid);
                streamingAccumulatedText = '';
                streamingAccumulatedThinking = '';
              }
              // Persist cursor as soon as a visible reply is emitted.
              // Long-lived runners may stay alive for idleTimeout, and waiting
              // until process exit would cause duplicate replay after restart.
              if (replyDeliveryAcknowledged) {
                const acknowledgedInputIds = result.ipcReceipts?.length
                  ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
                  : [result.inputTurnId ?? lastProcessed.id];
                for (const inputId of acknowledgedInputIds) {
                  channelPhysicalDeliveryAckByInput.set(inputId, true);
                }
              }
              if (
                result.inputTurnCompleted &&
                replyDeliveryAcknowledged &&
                (await completeChannelRuntimesForOutput(result))
              ) {
                commitCursor(outputChannelScope.inputId);
              }
            }
            // Only reset idle timer on actual results, not session-update markers (result: null)
            resetIdleTimer();
          }

          if (result.status === 'error') {
            hadError = true;
            if (result.error) lastError = result.error;
          }
        } catch (err) {
          logger.error({ group: group.name, err }, 'onOutput callback failed');
          hadError = true;
        }
      },
      imagesForAgent,
      messageTaskId,
      currentSourceJid,
      currentChannelContext,
      agentProfile,
    );
  } finally {
    runEnded = true;
    if (idleTimer) clearTimeout(idleTimer);
    activeRouteUpdaters.delete(effectiveGroup.folder);
    activeRouteAdmissions.delete(mainAdmissionKey);
    activeImReplyRoutes.delete(effectiveGroup.folder);
    activeAgentBuilderTurns.delete(effectiveGroup.folder);
    activeChannelTurns.delete(channelTurnScope(effectiveGroup.folder));
    for (const scope of new Set(channelOutboxScopesByInput.values())) {
      activeChannelOutboxScopes.unbind(
        channelTurnScope(effectiveGroup.folder),
        scope,
      );
    }
    if (
      activeIpcReplyTurnTrackers.get(effectiveGroup.folder) ===
      ipcReplyTurnTracker
    ) {
      activeIpcReplyTurnTrackers.delete(effectiveGroup.folder);
    }
    for (const [inputTurnId, coordinator] of turnOutputCoordinators) {
      activeTurnOutputs.unbind(mainAdmissionKey, inputTurnId, coordinator);
    }

    // ── 检测中断：有累积文本但从未发送回复 ──
    const wasInterrupted =
      publishesFrameworkAnswer(interactionMode) &&
      streamInterrupted &&
      !sentReply;
    const wasSteered = wasInterrupted && streamSteered;

    // ── Streaming card cleanup ──
    if (streamingSession) {
      if (streamingSession.isActive()) {
        // isActive() 仍为 true ⟹ 卡片从未被 complete()（result.result 非空路径会
        // 在 3594 complete 后令 isActive 转 false）。这里覆盖所有"卡片建了但没收口"的
        // 收尾场景，避免卡片永久停在「生成中」（僵尸卡片）。
        if (heldCardParts.length > 0) {
          // 挂起卡收口：后台任务未等到 settle 进程就结束了（空闲/容器超时、
          // _close、出错）。DB 合并行补注记 + 卡片定稿为「已中断」+ 原因，
          // 绝不留僵尸「后台任务运行中」卡，Web 上也不留悬空的"运行中"提示。
          const heldNote =
            hadError || !output || output.status === 'error'
              ? '处理出错，后台任务可能未完成'
              : '后台任务未全部完成，会话已结束';
          await finalizeHeldDbMessage(heldNote, 'interrupted').catch(() => {});
          heldCardParts = [];
          heldCardUsage = null;
          await streamingSession.abort(heldNote).catch(() => {});
        } else if (providerFailoverPending) {
          await streamingSession
            .abort('模型服务切换中，正在重试')
            .catch(() => {});
        } else if (hadError || !output || output.status === 'error') {
          await streamingSession.abort('处理出错').catch(() => {});
        } else if (wasInterrupted) {
          if (wasSteered) {
            await streamingSession
              .complete(streamingAccumulatedText)
              .catch(() => {});
          } else {
            await streamingSession.abort('已停止').catch(() => {});
          }
        } else if (output.status === 'closed') {
          // closed：容器 drain/_close 中断了 in-flight query（agent-runner 发
          // status:'closed' 而非 interrupt 流事件，streamInterrupted 仍为 false）。
          // 该消息会重试（3904 保留 cursor），此处仅收口卡片避免僵尸卡 + 重试叠卡。
          // 文案区别于"已中断"：closed 是系统侧打断并自动重试，非用户主动中断。
          await streamingSession.abort('连接已切换，正在重试').catch(() => {});
        } else if (!sentReply) {
          // 真 silent-success：本轮从未发过可见回复（agent 仅用 send_message 旁路
          // 回复、最终 result 为空，3546 if(result.result) 门控跳过了 complete()）。
          // complete() 把卡片从 streaming 收口到 completed（空正文由 buildStructuredFinalCard
          // 兜底为 "..."，并保留 thinking/工具统计），而非裸 dispose() 留下「生成中」僵尸卡。
          try {
            await streamingSession.complete(streamingAccumulatedText);
          } catch (err) {
            logger.warn(
              { err, chatJid },
              'Streaming card silent-success finalize failed, aborting card',
            );
            // dispose() 只清定时器不碰卡面，会留下永久「生成中」僵尸卡；
            // abort() 内部自带 catch，会尽力把卡面切到「已中断」终态。
            await streamingSession.abort('').catch(() => {});
            streamingSession.dispose();
          }
        } else {
          // sentReply 已为 true：卡片是正常回复 complete 后由 3651 为"下一条消息"预建的
          // 空白 active 卡，本轮无后续 result。dispose() 丢弃，不可 complete()（否则会
          // 凭空渲染一张正文为 "..." 的完成卡）。
          streamingSession.dispose();
        }
      }
      unregisterStreamingSession(streamingSessionJid);
    }

    // ── 无卡片场景（纯 Web / 卡片已死）的挂起序列 DB 收口 ──
    // 上方卡片分支已处理的场景 parts 已清空，此处天然跳过。
    if (heldCardParts.length > 0) {
      const heldNote =
        hadError || !output || output.status === 'error'
          ? '处理出错，后台任务可能未完成'
          : '后台任务未全部完成，会话已结束';
      await finalizeHeldDbMessage(heldNote, 'interrupted').catch(() => {});
      heldCardParts = [];
      heldCardUsage = null;
    }

    if (channelTurnRuntimes.size > 0) {
      const explicitDiscard =
        queue.getRecentStopDisposition(effectiveGroup.folder) === 'discard';
      for (const [inputTurnId, runtime] of channelTurnRuntimes) {
        const utteranceDelivered =
          channelPhysicalDeliveryAckByInput.get(inputTurnId) === true;
        const healthyInputCompleted =
          healthyCompletedInputTurns.has(inputTurnId);
        let settled = false;
        let terminal = false;
        const uncertainDelivery = getUncertainChannelOutboxForTurn(
          runtime.runId,
        );
        if (uncertainDelivery) {
          channelDeliveryNeedsManualReconciliation = true;
          settled = runtime.interrupt(
            `Channel delivery ${uncertainDelivery.id} is uncertain; manual reconciliation required`,
          );
          const exactScope = channelOutboxScopesByInput.get(inputTurnId);
          const notified = exactScope?.chatId
            ? await deliverChannelManualReconciliationNotice({
                logicalChatJid: chatJid,
                scopeKey: channelTurnScope(effectiveGroup.folder),
                targetJid: exactScope.sourceJid,
                runtime,
                presentation:
                  interactionMode === 'proactive' ? 'native' : 'default',
                route: { ...exactScope, chatId: exactScope.chatId },
              })
            : false;
          if (!notified) channelManualNoticesAcknowledged = false;
          terminal = settled;
        } else if (explicitDiscard) {
          settled = runtime.cancel('Input discarded by explicit stop');
          terminal = settled;
        } else if (
          healthyInputCompleted &&
          (interactionMode === 'proactive' || utteranceDelivered)
        ) {
          settled =
            runtime.markFinalizing() &&
            runtime.complete({
              cursorCommitted: cursorCommittedInputTurns.has(inputTurnId),
              sentReply:
                interactionMode === 'proactive'
                  ? utteranceDelivered
                  : sentReplyByInput.get(inputTurnId) === true,
              silent: interactionMode === 'proactive' && !utteranceDelivered,
            });
          terminal = settled;
        } else if (interactionMode === 'proactive' && utteranceDelivered) {
          // The native utterance is irreversible, but the agent failed after
          // delivery. Record a failed (not completed) terminal, seal replay,
          // and emit at most one exact-input tail notice.
          settled = runtime.fail(
            lastError ||
              (output?.status === 'closed'
                ? 'Agent connection closed after native delivery'
                : 'Agent failed after native delivery'),
          );
          terminal = settled;
          if (settled) {
            commitCursor(inputTurnId);
            await notifyProactiveTailInterruption(inputTurnId);
          }
        } else {
          settled = runtime.retry(
            lastError ||
              (output?.status === 'closed'
                ? 'Agent connection closed before completing input turn'
                : wasInterrupted
                  ? 'Agent interrupted before completing input turn'
                  : 'Agent execution ended before completing input turn'),
          );
        }
        if (!settled) {
          logger.error(
            {
              chatJid,
              inputTurnId,
              runId: runtime.runId,
              durabilityFailure: runtime.hasDurabilityFailure,
              lostFence: runtime.hasLostFence,
            },
            'Channel turn cleanup did not reach a durable state',
          );
        }
        if (terminal) {
          await clearProcessingIndicatorForInput(inputTurnId);
        }
        runtime.dispose();
      }
      channelTurnRuntimes.clear();
      if (channelDeliveryNeedsManualReconciliation) {
        if (channelManualNoticesAcknowledged) commitCursor();
      }
    }

    // ── 保存中断内容到数据库 + 广播到 Web ──
    // Skip if the shutdown handler already saved this streaming text (prevents duplicates).
    const webJidForShutdownCheck = chatJid.startsWith('web:')
      ? chatJid
      : `web:${effectiveGroup.folder}`;
    const alreadySavedByShutdown =
      shutdownSavedJids.has(chatJid) ||
      shutdownSavedJids.has(webJidForShutdownCheck);

    if (wasInterrupted && !alreadySavedByShutdown) {
      const interruptedText = wasSteered
        ? buildSteeredReply(streamingAccumulatedText)
        : buildStoppedReply(
            streamingAccumulatedText,
            streamingAccumulatedThinking,
          );
      try {
        // sendToIM: false — 飞书卡片已在原卡片上完成收束，不重复发送
        if (interruptedText) {
          lastReplyMsgId = await sendMessage(chatJid, interruptedText, {
            sendToIM: false,
            messageMeta: {
              turnId: lastProcessed.id,
              sessionId: activeSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'interrupted',
            },
          });
        }
        sentReply = true;
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to save interrupted text');
      }
    }

    // ── 兜底：进程异常退出导致累积文本未持久化 ──
    // 使用 buildInterruptedReply 而非 buildOverflowPartialReply：
    // 进程被杀（SIGTERM/错误）后不会自动继续，"上下文压缩中"提示会误导用户。
    if (
      !sentReply &&
      !alreadySavedByShutdown &&
      streamingAccumulatedText.trim()
    ) {
      try {
        const partialReply = buildInterruptedReply(
          streamingAccumulatedText,
          streamingAccumulatedThinking,
        );
        lastReplyMsgId = await sendMessage(chatJid, partialReply, {
          sendToIM: false,
          messageMeta: {
            turnId: lastProcessed.id,
            sessionId: activeSessionId,
            sourceKind: 'interrupt_partial',
            finalizationReason: 'error',
          },
        });
        sentReply = true;
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to save overflow partial text');
      }
    }
  }

  // runAgent threw — output is undefined, cannot proceed with post-processing.
  // If a reply was already sent, commit the cursor so we don't re-process.
  // Otherwise return false to allow retry (H-1 audit fix).
  const activeInputTurnId = ipcReplyTurnTracker.inputTurnId;
  const activeGenuineReplyDelivered = wasGenuineReplyDeliveredForInput(
    genuineReplyDeliveredByInput,
    activeInputTurnId,
  );
  const activeCursorCommitted =
    cursorCommittedInputTurns.has(activeInputTurnId);
  if (channelDeliveryNeedsManualReconciliation) {
    return channelManualNoticesAcknowledged && activeCursorCommitted;
  }
  if (!output) {
    if (queue.getRecentStopDisposition(effectiveGroup.folder) === 'discard') {
      await projectCurrentScheduledGroupTerminal(
        'cancelled',
        '定时任务已被用户停止，未继续执行。',
      );
      commitCursor();
      await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
      return true;
    }
    // A runner may throw after the final SDK reply (or an acknowledged
    // send_message delivery) but before returning its terminal output. Those
    // narrow delivery signals complete the turn; DB-only interrupt partials
    // deliberately do not set either signal and therefore remain retryable.
    if (activeGenuineReplyDelivered || ipcReplyTurnTracker.delivered) {
      if (!activeGenuineReplyDelivered && ipcReplyTurnTracker.delivered) {
        await projectCurrentScheduledGroupTerminal(
          'failed',
          'Agent 在发送旁路消息后退出，但没有返回定时任务的完整业务结果。',
        );
      }
      await notifyProactiveTailInterruption(ipcReplyTurnTracker.inputTurnId);
      commitCursor();
      await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
      return true;
    }
    return activeCursorCommitted;
  }

  const stopDisposition = queue.getRecentStopDisposition(effectiveGroup.folder);
  if (stopDisposition === 'discard') {
    await projectCurrentScheduledGroupTerminal(
      'cancelled',
      '定时任务已被用户停止，未继续执行。',
    );
    const activeInputHealthy = healthyCompletedInputTurns.has(
      ipcReplyTurnTracker.inputTurnId,
    );
    const turnOutcome = resolveTurnOutcome({
      status: output.status,
      healthyInputTurnCompleted: activeInputHealthy,
      cursorCommitted: activeCursorCommitted,
      replyDelivered:
        activeGenuineReplyDelivered || ipcReplyTurnTracker.delivered,
      stopRequested: true,
    });
    if (turnOutcome.cursor === 'commit') commitCursor();
    await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
    logger.info(
      { group: group.name, chatJid, turnOutcome },
      'Explicit stop discarded the interrupted input without replay',
    );
    return true;
  }

  // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）：无论是否已有回复，都必须重置会话
  const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
  if (
    (output.status === 'error' || hadError) &&
    errorForReset.includes('unrecoverable_transcript:')
  ) {
    const detail = (lastError || output.error || '').replace(
      /.*unrecoverable_transcript:\s*/,
      '',
    );
    logger.warn(
      { group: group.name, folder: group.folder, error: detail },
      'Unrecoverable transcript error, auto-resetting session',
    );

    // 清除会话文件（保留 settings.json）
    await clearSessionRuntimeFiles(group.folder);

    // 清除当前主会话（保留同 folder 下独立 agent 会话）
    try {
      deleteSession(group.folder);
      delete sessions[group.folder];
    } catch (err) {
      logger.error(
        { folder: group.folder, err },
        'Failed to clear session state during auto-reset',
      );
    }

    sendSystemMessage(chatJid, 'context_reset', `会话已自动重置：${detail}`);
    await projectCurrentScheduledGroupTerminal(
      'failed',
      `无法恢复的会话记录错误：${detail}`,
    );
    commitCursor();
    await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
    return true;
  }

  if (output.status === 'closed') {
    const activeInputHealthy = healthyCompletedInputTurns.has(
      ipcReplyTurnTracker.inputTurnId,
    );
    const turnOutcome = resolveTurnOutcome({
      status: output.status,
      healthyInputTurnCompleted: activeInputHealthy,
      cursorCommitted: activeCursorCommitted,
      // `sentReply` also includes DB-only interrupt/error partials that were
      // never delivered to the user's channel. Only a genuine SDK final or an
      // acknowledged send_message for this exact input turn may suppress
      // replay after `_close`.
      replyDelivered:
        activeGenuineReplyDelivered || ipcReplyTurnTracker.delivered,
      // A mutation-preserve stop must keep/replay the cursor after the pause;
      // ordinary discard stops returned above.
      stopRequested: false,
    });

    if (turnOutcome.cursor === 'commit') commitCursor();

    if (turnOutcome.kind === 'retryable') {
      logger.warn(
        { group: group.name, chatJid, turnOutcome },
        'Container closed during an unfinished input turn; scheduling replay',
      );
      // The retry runs after GroupQueue's backoff without requiring another
      // incoming message. Close the current Web streaming state while waiting.
      broadcastStreamEvent(chatJid, {
        eventType: 'status',
        statusText: 'idle',
        turnId: lastProcessed.id,
        sessionId: activeSessionId,
      });
      return false;
    }

    await projectCurrentScheduledGroupTerminal(
      'failed',
      output.error || lastError || 'Agent 连接在定时任务产生完整结果前关闭。',
    );
    logger.info(
      { group: group.name, chatJid, turnOutcome },
      'Container close resolved without replay',
    );
    await notifyProactiveTailInterruption(ipcReplyTurnTracker.inputTurnId);
    await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
    return true;
  }

  // Query 出错时，将残留 running task 标记为 error，避免长期僵尸状态。
  // 正常退出不做强制 completed，避免把未确认完成的任务误判为已完成。
  const isErrorExit = output.status === 'error' || hadError;
  if (isErrorExit) {
    try {
      // 先获取 running agents（广播需要 agent 详情），再批量标记 error
      const runningAgents = getRunningTaskAgentsByChat(chatJid);
      const marked = markRunningTaskAgentsAsError(chatJid);
      if (marked > 0) {
        logger.info(
          { chatJid, marked },
          'Marked remaining running task agents as error',
        );
        if (publishesFrameworkAnswer(interactionMode)) {
          for (const agent of runningAgents) {
            broadcastAgentStatus(
              chatJid,
              agent.id,
              'error',
              agent.name,
              agent.prompt,
              '容器超时或异常退出',
              agent.kind,
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to mark running task agents');
    }
  } else {
    // Safety net: if query already ended successfully but some task agents are still
    // running (usually due SDK event ID mismatch), force-complete them to avoid stale tabs.
    try {
      let completed = 0;
      for (const taskId of queryTaskIds) {
        const agent = getAgent(taskId);
        if (
          !agent ||
          agent.kind !== 'task' ||
          agent.chat_jid !== chatJid ||
          agent.status !== 'running'
        )
          continue;
        updateAgentStatus(
          taskId,
          'completed',
          agent.result_summary || '任务已完成',
        );
        if (publishesFrameworkAnswer(interactionMode)) {
          broadcastAgentStatus(
            chatJid,
            taskId,
            'completed',
            agent.name,
            agent.prompt,
            agent.result_summary || '任务已完成',
            agent.kind,
          );
        }
        completed += 1;
      }
      if (completed > 0) {
        logger.warn(
          { chatJid, completed },
          'Force-completed stale running task agents after successful query',
        );
      }
    } catch (err) {
      logger.warn(
        { chatJid, err },
        'Failed to force-complete stale running task agents',
      );
    }
  }

  if (
    shouldSendProactiveTailInterruptionNotice({
      mode: interactionMode,
      utteranceDelivered: ipcReplyTurnTracker.delivered,
      runnerFailed: isErrorExit,
      healthyInputTurnCompleted: healthyCompletedInputTurns.has(
        ipcReplyTurnTracker.inputTurnId,
      ),
    })
  ) {
    await notifyProactiveTailInterruption(ipcReplyTurnTracker.inputTurnId);
    commitCursor();
    await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
    return true;
  }

  if (
    isErrorExit &&
    terminalScheduledGroupInputs.has(ipcReplyTurnTracker.inputTurnId)
  ) {
    commitCursor();
    await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
    return true;
  }

  if (
    isErrorExit &&
    !healthyCompletedInputTurns.has(ipcReplyTurnTracker.inputTurnId)
  ) {
    // Partial/interrupted text is useful to persist, but it is not a delivery
    // acknowledgement. Keep the recovery cursor behind so the user input is
    // replayed at least once after the failed runner exits — UNLESS a
    // genuine complete reply was already delivered (below). Only skip retry
    // when a *genuine* reply went out: if the agent already replied (e.g.
    // via send_message before the runner hit a late-turn error/timeout), a
    // retry would re-run the agent against the same messages via
    // getMessagesSince(uncommitted cursor) and can produce a second,
    // separate reply to a request that already got one. Commit here and
    // stop instead of returning false into a retry.
    //
    // sentReply alone is NOT sufficient for this decision: it also becomes
    // true for interrupt/error partial fallback saves (sourceKind
    // 'interrupt_partial', always sendToIM:false) which are persisted to
    // DB/web history for continuity but never actually reach the user's IM
    // channel on non-card channels. Gating on sentReply there would commit
    // the cursor and silently drop the message forever with nothing ever
    // delivered. genuineReplyDelivered excludes those fallback saves.
    //
    // A send_message MCP call mid-turn is ALSO a genuine delivery, but only
    // after the host acknowledges the exact current input turn and confirms
    // the relevant Web/IM target was actually reached.
    if (
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: activeGenuineReplyDelivered,
        ipcReplyDeliveredForInputTurn: ipcReplyTurnTracker.delivered,
      })
    ) {
      await projectCurrentScheduledGroupTerminal(
        'failed',
        output.error || lastError || 'Agent 在发送旁路消息后异常退出。',
      );
      commitCursor();
      await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
      return true;
    }
    const errorDetail = output.error || lastError || '未知错误';

    // Prompt/context startup budget is derived from the immutable context
    // snapshot for this turn. Retrying cannot change it, so classify it as a
    // deterministic failure and commit exactly once instead of entering the
    // transient-error backoff loop.
    if (
      errorDetail.startsWith('context_budget_exceeded:') ||
      errorDetail.startsWith('prompt_plan_invalid:')
    ) {
      const budgetMsg = errorDetail.replace(
        /^(?:context_budget_exceeded|prompt_plan_invalid):\s*/,
        '',
      );
      const turnOutcome = resolveTurnOutcome({
        status: output.status,
        healthyInputTurnCompleted: healthyCompletedInputTurns.has(
          ipcReplyTurnTracker.inputTurnId,
        ),
        cursorCommitted: activeCursorCommitted,
        replyDelivered: sentReply,
        deterministicFailure: true,
      });
      sendSystemMessage(chatJid, 'context_overflow', budgetMsg);
      await projectCurrentScheduledGroupTerminal('failed', budgetMsg);
      logger.warn(
        { group: group.name, error: budgetMsg, turnOutcome },
        'Static prompt/context budget is invalid; skipping retry',
      );
      if (turnOutcome.cursor === 'commit') commitCursor();
      await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
      return true;
    }

    // 上下文溢出错误：跳过重试，提交游标，通知用户
    if (errorDetail.startsWith('context_overflow:')) {
      const overflowMsg = errorDetail.replace(/^context_overflow:\s*/, '');
      sendSystemMessage(chatJid, 'context_overflow', overflowMsg);
      await projectCurrentScheduledGroupTerminal('failed', overflowMsg);
      logger.warn(
        { group: group.name, error: overflowMsg },
        'Context overflow detected, skipping retry',
      );
      commitCursor();
      await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
      return true;
    }

    // AgentProfile 引用的 skill/MCP 已被删除或禁用：确定性配置错误，重试
    // 永远不会成功，跳过指数退避重试，直接提交游标并告知用户。
    if (errorDetail.startsWith('agent_profile_unavailable:')) {
      const profileMsg = errorDetail.replace(
        /^agent_profile_unavailable:\s*/,
        '',
      );
      sendSystemMessage(chatJid, 'system_error', profileMsg);
      await projectCurrentScheduledGroupTerminal('failed', profileMsg);
      logger.warn(
        { group: group.name, error: profileMsg },
        'AgentProfile references unavailable skill/MCP, skipping retry',
      );
      commitCursor();
      await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
      return true;
    }

    // ── OOM auto-recovery: detect consecutive exit code 137 (OOM) ──
    // Only match `code 137` (Docker cgroup OOM killer), not `signal SIGKILL`
    // which is ambiguous for host processes (could be user stop, process tree
    // kill, or actual OOM).  exitLabel is either `code N` or `signal X` —
    // never both — so this only triggers on Docker container OOM exits.
    //
    // Additional guard: stopGroup → SIGTERM → grace timeout → docker kill 也会
    // 让容器以 137 退出。如果用户刚点过 stop（GroupQueue.isRecentlyStopped），
    // 不要把这次退出计入 OOM 计数 —— 否则连续两次手动 stop 就会触发会话重置
    // 并显示『内存溢出』提示，混淆运维。
    const isUserStopped = queue.isRecentlyStopped(effectiveGroup.folder);
    const isOom = !isUserStopped && OOM_EXIT_RE.test(errorDetail);
    if (isOom) {
      const folder = effectiveGroup.folder;
      consecutiveOomExits[folder] = (consecutiveOomExits[folder] || 0) + 1;
      setRouterState(
        `oom_exits:${folder}`,
        String(consecutiveOomExits[folder]),
      );
      logger.warn(
        {
          folder,
          consecutive: consecutiveOomExits[folder],
          threshold: OOM_AUTO_RESET_THRESHOLD,
        },
        'OOM exit detected (code 137)',
      );

      if (consecutiveOomExits[folder] >= OOM_AUTO_RESET_THRESHOLD) {
        logger.warn(
          { folder, consecutive: consecutiveOomExits[folder] },
          'Consecutive OOM threshold reached, auto-resetting session to break death loop',
        );
        consecutiveOomExits[folder] = 0;
        deleteRouterState(`oom_exits:${folder}`);

        // Clear session files and DB records (same as unrecoverable_transcript handling)
        try {
          await clearSessionRuntimeFiles(folder);
        } catch (err) {
          logger.error(
            { folder, err },
            'Failed to clear session files during OOM auto-reset',
          );
        }
        try {
          deleteSession(folder);
          delete sessions[folder];
        } catch (err) {
          logger.error(
            { folder, err },
            'Failed to clear session during OOM auto-reset',
          );
        }

        sendSystemMessage(
          chatJid,
          'context_reset',
          '会话文件过大导致内存溢出（OOM），已自动重置会话。之前的对话上下文已清除，请重新描述您的需求。',
        );
        await projectCurrentScheduledGroupTerminal(
          'failed',
          '会话文件过大导致内存溢出（OOM），已自动重置会话。',
        );
        commitCursor();
        await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
        return true;
      }
    } else if (consecutiveOomExits[effectiveGroup.folder]) {
      // Non-OOM error: reset the consecutive counter only if it was set
      delete consecutiveOomExits[effectiveGroup.folder];
      deleteRouterState(`oom_exits:${effectiveGroup.folder}`);
    }

    // 还会重试的中间轮次不向用户广播 agent_error：每轮一条错误消息叠加每轮
    // 一张中断卡就是「消息洪流」。最终失败由 onMaxRetriesExceeded 的
    // agent_max_retries 系统消息统一告知。
    if (queue.willRetryAfterFailure(chatJid)) {
      logger.warn(
        {
          group: group.name,
          error: errorDetail,
          retry: queue.getRetryCount(chatJid),
        },
        'Agent error (no reply sent), will retry silently with backoff',
      );
      // agent_error 同时承担清除 Web 端 waiting/streaming 的职责；抑制它后
      // 必须补一个 status:idle 终态事件，否则重试退避期间 Web 一直转圈。
      broadcastStreamEvent(chatJid, {
        eventType: 'status',
        statusText: 'idle',
        turnId: lastProcessed.id,
        sessionId: activeSessionId,
      });
    } else {
      sendSystemMessage(chatJid, 'agent_error', errorDetail);
      logger.warn(
        { group: group.name, error: errorDetail },
        'Agent error (no reply sent), keeping cursor at previous position for retry',
      );
    }
    return false;
  }

  // Reset OOM counter on successful exit (only write DB if counter was set)
  if (consecutiveOomExits[effectiveGroup.folder]) {
    delete consecutiveOomExits[effectiveGroup.folder];
    deleteRouterState(`oom_exits:${effectiveGroup.folder}`);
  }

  // Final fallback for silent-success paths (no visible reply).
  // silent-success：agent 仅用 send_message 旁路回复或最终 result 为空，未发
  // sdk_final new_message。前端的 waiting/streaming 被 thinking/tool 流事件设为 true 后
  // 没有任何终态信号可清，会永久停在「正在思考...」。广播一个 idle status 事件让前端
  // 收口；broadcastStreamEvent→updateStreamingSnapshot 会据 idle 删除后端快照，
  // 避免 WS 重连恢复到「生成中」僵尸快照。
  // （飞书等 IM 卡片已在 finally 的 complete()/abort() 收口，此处仅补 Web 通路。）
  if (!sentReply) {
    broadcastStreamEvent(chatJid, {
      eventType: 'status',
      statusText: 'idle',
      turnId: lastProcessed.id,
      sessionId: activeSessionId,
    });
  }
  if (healthyCompletedInputTurns.has(ipcReplyTurnTracker.inputTurnId)) {
    commitCursor();
    await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
    return true;
  }
  logger.warn(
    { chatJid, status: output.status },
    'Runner exited without a healthy input-turn completion; keeping cursor for replay',
  );
  return false;
}

async function runTerminalWarmup(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;
  if ((group.executionMode || 'container') === 'host') return;

  logger.info({ chatJid, group: group.name }, 'Starting terminal warmup run');

  const warmupReadyToken = '<terminal_ready>';
  const warmupPrompt = [
    '这是系统触发的终端预热请求。',
    `请只回复 ${warmupReadyToken}，不要回复其它内容，也不要调用工具。`,
  ].join(' ');

  let bootstrapCompleted = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const warmupIdleCloseMs = resolveRunnerLivenessTimeouts({
    executionTimeoutMs:
      group.containerConfig?.timeout ?? getSystemSettings().containerTimeout,
    idleTimeoutMs: getSystemSettings().idleTimeout,
  }).idleCloseMs;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { chatJid, group: group.name },
        'Terminal warmup idle timeout, closing stdin',
      );
      queue.closeStdin(chatJid);
    }, warmupIdleCloseMs);
  };

  try {
    const output = await runAgent(
      group,
      warmupPrompt,
      chatJid,
      undefined,
      async (result) => {
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);
          return;
        }

        if (result.status === 'error') return;

        // During warmup query, NEVER emit assistant text to chat.
        // Only mark bootstrap complete after the session update marker.
        if (result.result === null) {
          if (!bootstrapCompleted) {
            bootstrapCompleted = true;
            resetIdleTimer();
          }
          return;
        }

        if (!bootstrapCompleted) return;

        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = stripAgentInternalTags(raw);
        if (!text || text === warmupReadyToken) return;
        await sendMessage(chatJid, text);
        resetIdleTimer();
      },
    );

    if (output.status === 'error') {
      logger.warn(
        { chatJid, group: group.name, error: output.error },
        'Terminal warmup run ended with error',
      );
    } else {
      logger.info(
        { chatJid, group: group.name },
        'Terminal warmup run completed',
      );
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function ensureTerminalContainerStarted(chatJid: string): boolean {
  const group = registeredGroups[chatJid];
  if (!group) return false;
  if ((group.executionMode || 'container') === 'host') return false;

  const status = queue.getStatus();
  const groupStatus = status.groups.find((g) => g.jid === chatJid);
  if (groupStatus?.active) return true;
  if (terminalWarmupInFlight.has(chatJid)) return true;

  terminalWarmupInFlight.add(chatJid);
  const taskId = `terminal-warmup:${chatJid}`;
  queue.enqueueTask(chatJid, taskId, async () => {
    try {
      await runTerminalWarmup(chatJid);
    } finally {
      terminalWarmupInFlight.delete(chatJid);
    }
  });
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  turnId?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  images?: Array<{ data: string; mimeType?: string }>,
  messageTaskId?: string,
  currentSourceJid?: string,
  channelContext?: ChannelTurnContext,
  agentProfile?: AgentProfile,
): Promise<{ status: 'success' | 'error' | 'closed'; error?: string }> {
  const isHome = !!group.is_home;
  const owner = group.created_by ? getUserById(group.created_by) : undefined;
  const isAdminHome = isHome && owner?.role === 'admin';
  const resolvedAgentProfile = resolveEffectiveAgentProfile(
    agentProfile ?? getAgentProfileForWorkspace(group.folder, group.created_by),
  );
  const interactionMode = resolveRuntimeInteractionMode(
    getWorkspaceInteractionMode(group.folder),
    { agentKind: 'main' },
  );
  if (resetMainSessionForAgentProfileMismatch(group, resolvedAgentProfile)) {
    logger.info(
      { groupFolder: group.folder, chatJid },
      'AgentProfile identity mismatch handled inside runAgent',
    );
  }
  const sessionId = sessions[group.folder];
  const containerAgentProfile = toContainerAgentProfile(resolvedAgentProfile);
  const happyClawOwnerProfile = resolveHappyClawOwnerProfileForTurn({
    group,
    profile: resolvedAgentProfile,
    turnId,
    isScheduledTask: Boolean(messageTaskId),
  });
  const happyClawBootstrapPending =
    happyClawOwnerProfile?.onboarding.state === 'pending' ||
    happyClawOwnerProfile?.onboarding.state === 'claimed';
  const happyClawOwnerProfileEnabled = isHappyClawOwnerProfileRuntimeEligible({
    group,
    profile: resolvedAgentProfile,
    turnId,
    isScheduledTask: Boolean(messageTaskId),
  });

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (admin home only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isAdminHome,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        queue.markRunnerActivity(chatJid);
        if (
          output.ipcReceipts?.length &&
          (!output.providerFailure || output.providerFailureTerminal === true)
        ) {
          queue.acknowledgeIpcDeliveries(
            chatJid,
            output.ipcReceipts,
            commitIpcDeliveryReceipts,
          );
        }
        if (
          output.queryIdle === true ||
          (output.status === 'stream' &&
            output.streamEvent?.eventType === 'status' &&
            output.streamEvent.statusText === 'interrupted')
        ) {
          queue.markRunnerQueryIdle(chatJid);
        }
        // 仅从成功的输出中更新 session ID；
        // error 输出可能携带 stale ID，会覆盖流式传递的有效 session
        if (
          output.newSessionId &&
          output.status !== 'error' &&
          !output.providerFailure
        ) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId, undefined, {
            agentProfileId: resolvedAgentProfile?.id,
            agentProfileVersion: resolvedAgentProfile?.version,
            identityHash: resolvedAgentProfile?.identity_hash,
          });
        }
        await onOutput(output);
      }
    : undefined;

  ipcWatcherManager?.watchGroup(group.folder);
  try {
    const executionMode = group.executionMode || 'container';
    const feishuCliAccountId =
      executionMode === 'container'
        ? resolveFeishuCliBoundAccountId({
            channelContext,
            workspaceChannelAccountId: group.channel_account_id,
          })
        : null;

    const onProcessCb = (
      proc: ChildProcess,
      identifier: string,
      selectedProviderId: string | null,
    ) => {
      // 宿主机模式：containerName 传 null，走 process.kill() 路径
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(chatJid, proc, {
        containerName,
        groupFolder: group.folder,
        displayName: identifier,
        selectedProviderId,
        feishuCliAccountId,
      });
    };

    const ownerHomeFolder = resolveOwnerHomeFolder(group);

    let output: ContainerOutput;

    if (executionMode === 'host') {
      // Re-read the owner at the last possible point before spawning a host
      // process. A persisted host workspace is not an authorization grant:
      // role/status changes take effect immediately without rewriting it.
      const currentOwner = group.created_by
        ? getUserById(group.created_by)
        : undefined;
      if (!canExecuteOnHost(currentOwner)) {
        logger.warn(
          { chatJid, groupFolder: group.folder, ownerId: group.created_by },
          'Blocked host workspace execution for non-admin owner',
        );
        return { status: 'error', error: HOST_EXECUTION_FORBIDDEN_ERROR };
      }
      output = await runAgentWithModelFallback(
        runHostAgent,
        group,
        {
          prompt,
          sessionId,
          turnId,
          queryRunId: queue.getActiveQueryId(chatJid) ?? undefined,
          groupFolder: group.folder,
          chatJid,
          interactionMode,
          currentSourceJid,
          channelContext,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          happyClawBootstrapPending,
          happyClawOwnerProfile,
          happyClawOwnerProfileEnabled,
          agentBuilderEnabled: resolvedAgentProfile?.is_default === true,
          images,
          messageTaskId,
          agentProfile: containerAgentProfile,
        },
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    } else {
      output = await runAgentWithModelFallback(
        runContainerAgent,
        group,
        {
          prompt,
          sessionId,
          turnId,
          queryRunId: queue.getActiveQueryId(chatJid) ?? undefined,
          groupFolder: group.folder,
          chatJid,
          interactionMode,
          currentSourceJid,
          channelContext,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          happyClawBootstrapPending,
          happyClawOwnerProfile,
          happyClawOwnerProfileEnabled,
          agentBuilderEnabled: resolvedAgentProfile?.is_default === true,
          images,
          messageTaskId,
          agentProfile: containerAgentProfile,
        },
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    }

    // 仅从成功的最终输出中更新 session ID；
    // error 状态的输出可能携带 stale ID，覆盖流式阶段已写入的有效 session
    if (
      output.newSessionId &&
      output.status !== 'error' &&
      !output.providerFailure
    ) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId, undefined, {
        agentProfileId: resolvedAgentProfile?.id,
        agentProfileVersion: resolvedAgentProfile?.version,
        identityHash: resolvedAgentProfile?.identity_hash,
      });
    }

    // Agent was interrupted by _close sentinel (home folder drain).
    // Propagate so processGroupMessages can skip cursor commit.
    if (output.status === 'closed') {
      return { status: 'closed' };
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Agent error');
      if (output.result && wrappedOnOutput) {
        try {
          await wrappedOnOutput(output);
        } catch (err) {
          logger.error(
            { group: group.name, err },
            'Failed to emit agent error output',
          );
        }
      }
      return { status: 'error', error: output.error };
    }

    return { status: 'success' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: errorMsg };
  } finally {
    ipcWatcherManager?.unwatchGroup(group.folder);
  }
}

interface SendMessageOutcome {
  messageId?: string;
  /** True only after the canonical DB row and its WebSocket broadcast both
   * complete. Kept separate from an IM connector ACK. */
  webProjected: boolean;
  /** True only when the logical target actually received the message. For an
   * IM JID this requires connector success; for a Web/virtual JID it requires
   * successful persistence+broadcast. */
  targetDelivered: boolean;
}

async function sendMessageWithOutcome(
  jid: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<SendMessageOutcome> {
  const isIMChannel = getChannelType(jid) !== null;
  const sendToIM = options.sendToIM ?? isIMChannel;
  let targetDelivered = false;
  let webProjected = false;
  try {
    if (sendToIM && isIMChannel) {
      try {
        const imText = options.imTextOverride ?? text;
        const localImagePaths =
          options.localImagePaths ??
          extractLocalImImagePaths(imText, resolveEffectiveFolder(jid));
        targetDelivered = await sendImWithRetry(
          jid,
          imText,
          localImagePaths,
          options.channelOutbox,
        );
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send message to IM channel');
      }
    }

    // Persist assistant reply so Web polling can render it and clear waiting state.
    const msgId = options.messageId ?? crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const persistedMsgId =
      options.scheduledGroupFinalizations &&
      options.scheduledGroupFinalizations.length > 0
        ? storeScheduledGroupWorkspaceResultAndFinalize({
            messageId: msgId,
            chatJid: jid,
            senderId: 'happyclaw-agent',
            senderName: ASSISTANT_NAME,
            text,
            timestamp,
            messageMeta: options.messageMeta,
            finalizations: options.scheduledGroupFinalizations,
          })
        : (() => {
            ensureChatExists(jid);
            return storeMessageDirect(
              msgId,
              jid,
              'happyclaw-agent',
              ASSISTANT_NAME,
              text,
              timestamp,
              true,
              { meta: options.messageMeta },
            );
          })();
    if (!sendToIM || !isIMChannel) targetDelivered = true;

    broadcastNewMessage(
      jid,
      {
        id: persistedMsgId,
        chat_jid: jid,
        sender: 'happyclaw-agent',
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp,
        is_from_me: true,
        turn_id: options.messageMeta?.turnId ?? null,
        session_id: options.messageMeta?.sessionId ?? null,
        sdk_message_uuid: options.messageMeta?.sdkMessageUuid ?? null,
        source_kind: options.messageMeta?.sourceKind ?? null,
        finalization_reason: options.messageMeta?.finalizationReason ?? null,
        workflow_runs: options.workflowRuns,
      },
      undefined,
      options.source,
    );
    webProjected = true;
    logger.info({ jid, length: text.length, sendToIM }, 'Message sent');
    // Skip agent_reply broadcast for scheduled tasks to avoid clearing
    // streaming state of a concurrently running main agent.
    // Safe because scheduled tasks never trigger typing indicators, so there's
    // no typing state to clear. The message is still delivered via new_message.
    if (!options.source) {
      broadcastToWebClients(jid, text);
    }
    return { messageId: persistedMsgId, targetDelivered, webProjected };
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
    return { targetDelivered, webProjected };
  }
}

async function sendMessage(
  jid: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<string | undefined> {
  return (await sendMessageWithOutcome(jid, text, options)).messageId;
}

export function buildOverflowPartialReply(partialText: string): string {
  const trimmed = partialText.trimEnd();
  return trimmed
    ? `${trimmed}\n\n---\n*⚠️ 上下文压缩中，稍后自动继续*`
    : '*⚠️ 上下文压缩中，稍后自动继续*';
}

/**
 * Save any in-progress streaming responses to DB before shutdown.
 * Without this, partial bot responses are lost when the service restarts.
 */
function saveInterruptedStreamingMessages(): void {
  try {
    const activeTexts = getActiveStreamingTexts();
    if (activeTexts.size === 0) return;

    logger.info(
      { count: activeTexts.size },
      'Saving interrupted streaming messages to DB',
    );

    for (const [jid, partialText] of activeTexts) {
      if (!partialText.trim()) {
        shutdownSavedJids.add(jid);
        continue;
      }
      const interruptedText = buildInterruptedReply(partialText);
      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      ensureChatExists(jid);
      storeMessageDirect(
        msgId,
        jid,
        'happyclaw-agent',
        ASSISTANT_NAME,
        interruptedText,
        timestamp,
        true,
        {
          meta: {
            sourceKind: 'interrupt_partial',
            finalizationReason: 'shutdown',
          },
        },
      );
      // Mark as saved so the per-group finally blocks don't duplicate
      shutdownSavedJids.add(jid);
    }
  } catch (err) {
    logger.warn({ err }, 'Error saving interrupted streaming messages');
  }

  // Clean up buffer files since we saved to DB (avoids duplicates on next startup)
  cleanStreamingBufferDir();
}

// ─── Periodic Streaming Buffer ──────────────────────────────────────
// Writes in-progress streaming text to disk every 5s so that even SIGKILL
// crashes preserve most of the partial response.

const STREAMING_BUFFER_DIR = path.join(DATA_DIR, 'streaming-buffer');
const STREAMING_BUFFER_INTERVAL_MS = 5000;
let streamingBufferInterval: ReturnType<typeof setInterval> | null = null;

export function encodeJidForFilename(jid: string): string {
  return Buffer.from(jid).toString('base64url');
}

export function decodeJidFromFilename(filename: string): string {
  const name = filename.endsWith('.txt') ? filename.slice(0, -4) : filename;
  return Buffer.from(name, 'base64url').toString();
}

/** Write all active streaming texts to disk (atomic write per file). */
function flushStreamingBuffer(): void {
  try {
    const activeTexts = getActiveStreamingTexts();
    if (activeTexts.size === 0) {
      // Nothing streaming — clean up any stale files
      cleanStreamingBufferDir();
      return;
    }

    fs.mkdirSync(STREAMING_BUFFER_DIR, { recursive: true });

    const activeFiles = new Set<string>();
    for (const [jid, text] of activeTexts) {
      const filename = encodeJidForFilename(jid) + '.txt';
      activeFiles.add(filename);
      const filePath = path.join(STREAMING_BUFFER_DIR, filename);
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, text);
      fs.renameSync(tmpPath, filePath);
    }

    // Remove files for JIDs that are no longer streaming
    try {
      for (const f of fs.readdirSync(STREAMING_BUFFER_DIR)) {
        if (f.endsWith('.txt') && !activeFiles.has(f)) {
          fs.unlinkSync(path.join(STREAMING_BUFFER_DIR, f));
        }
      }
    } catch {
      /* ignore cleanup errors */
    }
  } catch (err) {
    logger.debug({ err }, 'Error flushing streaming buffer');
  }
}

/** On startup, recover interrupted responses from buffer files left by a crash. */
function recoverStreamingBuffer(): void {
  try {
    if (!fs.existsSync(STREAMING_BUFFER_DIR)) return;

    const txtFiles = fs
      .readdirSync(STREAMING_BUFFER_DIR)
      .filter((f) => f.endsWith('.txt'));
    if (txtFiles.length === 0) return;

    logger.info(
      { count: txtFiles.length },
      'Recovering interrupted streaming messages from buffer files',
    );

    for (const filename of txtFiles) {
      try {
        const jid = decodeJidFromFilename(filename);
        const text = fs.readFileSync(
          path.join(STREAMING_BUFFER_DIR, filename),
          'utf-8',
        );
        if (text.trim()) {
          const interruptedText = buildInterruptedReply(text);
          const msgId = crypto.randomUUID();
          const timestamp = new Date().toISOString();
          ensureChatExists(jid);
          storeMessageDirect(
            msgId,
            jid,
            'happyclaw-agent',
            ASSISTANT_NAME,
            interruptedText,
            timestamp,
            true,
            {
              meta: {
                sourceKind: 'interrupt_partial',
                finalizationReason: 'crash_recovery',
              },
            },
          );
          logger.info(
            { jid, textLen: text.length },
            'Recovered interrupted streaming message',
          );
        }
        fs.unlinkSync(path.join(STREAMING_BUFFER_DIR, filename));
      } catch (err) {
        logger.warn(
          { err, filename },
          'Error recovering streaming buffer file',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error recovering streaming buffer');
  }
}

/** Remove all buffer files. */
function cleanStreamingBufferDir(): void {
  try {
    if (!fs.existsSync(STREAMING_BUFFER_DIR)) return;
    for (const f of fs.readdirSync(STREAMING_BUFFER_DIR)) {
      try {
        fs.unlinkSync(path.join(STREAMING_BUFFER_DIR, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function startStreamingBuffer(): void {
  streamingBufferInterval = setInterval(
    flushStreamingBuffer,
    STREAMING_BUFFER_INTERVAL_MS,
  );
}

function stopStreamingBuffer(): void {
  if (streamingBufferInterval) {
    clearInterval(streamingBufferInterval);
    streamingBufferInterval = null;
  }
}

// Thin production wrapper around the pure helper in ./cross-group-acl.ts so
// the helper can be unit-tested without booting all of index.ts.
function canSendCrossGroupMessage(
  isAdminHome: boolean,
  isHome: boolean,
  sourceFolder: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  targetGroup: RegisteredGroup | undefined,
): boolean {
  return canSendCrossGroupMessagePure(
    isAdminHome,
    isHome,
    sourceFolder,
    sourceGroupEntry,
    targetGroup,
    (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
  );
}

function getIpcDeliveryTargetGroup(
  chatJid: string,
): RegisteredGroup | undefined {
  return resolveIpcDeliveryTargetGroup(
    chatJid,
    (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
  );
}

// Thin production wrapper around the pure helper in ./task-routing.ts so the
// internal call sites keep their short signature (deps inferred from the
// runtime IM manager + DB). Tests should import `broadcastToOwnerIMChannels`
// from ./task-routing.js directly and pass their own deps — that file has no
// side effects, unlike this one (which runs main() at module load).
function broadcastToOwnerIMChannels(
  userId: string,
  sourceFolder: string,
  alreadySentJids: Set<string>,
  sendFn: (jid: string) => void,
  notifyChannels?: string[] | null,
): void {
  broadcastToOwnerIMChannelsPure(
    userId,
    sourceFolder,
    alreadySentJids,
    sendFn,
    notifyChannels,
    {
      getConnectedChannelTypes:
        imManager.getConnectedChannelTypes.bind(imManager),
      getGroupsByOwner,
      getChannelType,
      resolveJidFolder: (jid: string) => {
        // Follow ImBindingDialog's target_main_jid binding to the bound
        // workspace's folder. Delegated to resolveWorkspaceJid so we inherit
        // its legacy-format compatibility: historical DBs may store
        // target_main_jid as `web:{folder}` instead of `web:{uuid}`,
        // and resolveWorkspaceJid folds both shapes to the canonical
        // registered jid.
        const effectiveJid = resolveWorkspaceJid(jid);
        if (!effectiveJid) return null;
        const target =
          registeredGroups[effectiveJid] ?? getRegisteredGroup(effectiveJid);
        return target?.folder ?? null;
      },
    },
  );
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const fsp = fs.promises;

  const processGroupIpc = async (sourceGroup: string) => {
    if (shuttingDown) return;
    // Determine if this IPC directory belongs to an admin home group
    const sourceFolderEntries = Object.values(registeredGroups).filter(
      (group) => group.folder === sourceGroup,
    );
    // A home runtime can serve sibling channel JIDs that share its folder.
    // Prefer the home record so folder-level IPC gets the identity of the
    // process that actually owns it, independent of object insertion order.
    const sourceGroupEntry =
      sourceFolderEntries.find((group) => group.is_home) ??
      sourceFolderEntries[0];
    const sourceOwner = sourceGroupEntry?.created_by
      ? getUserById(sourceGroupEntry.created_by)
      : undefined;
    const isAdminHome =
      !!sourceGroupEntry?.is_home && sourceOwner?.role === 'admin';
    const isHome = !!sourceGroupEntry?.is_home;

    // Collect all IPC roots: main group dir + agents/*/ + tasks-run/*/
    // Tag agent roots with their agentId so we can route messages to virtual JIDs.
    const groupIpcRoot = path.join(ipcBaseDir, sourceGroup);
    const ipcRoots: Array<{
      path: string;
      agentId: string | null;
      taskId: string | null;
    }> = [{ path: groupIpcRoot, agentId: null, taskId: null }];
    try {
      const agentsDir = path.join(groupIpcRoot, 'agents');
      const agentEntries = await fsp.readdir(agentsDir, {
        withFileTypes: true,
      });
      for (const entry of agentEntries) {
        if (entry.isDirectory()) {
          ipcRoots.push({
            path: path.join(agentsDir, entry.name),
            agentId: entry.name,
            taskId: null,
          });
        }
      }
    } catch {
      /* agents dir may not exist */
    }
    try {
      const tasksRunDir = path.join(groupIpcRoot, 'tasks-run');
      const taskRunEntries = await fsp.readdir(tasksRunDir, {
        withFileTypes: true,
      });
      for (const entry of taskRunEntries) {
        if (entry.isDirectory()) {
          ipcRoots.push({
            path: path.join(tasksRunDir, entry.name),
            agentId: null,
            taskId: entry.name,
          });
        }
      }
    } catch {
      /* tasks-run dir may not exist */
    }

    // Broadcast folder: the workspace folder whose IPC message we are
    // processing. Fix F: use sourceGroup (the emitting workspace's folder),
    // NOT the owner's home folder — non-home workspaces bind to their own
    // IM groups and must route replies to those bindings.
    //
    // Go through resolveBroadcastFolder so the choice between sourceGroup
    // and ownerHome is locked by a unit test. Reverting this line to
    // `ownerHome?.folder || sourceGroup` (the pre-fix F behavior) must
    // break the helper's test, not silently pass CI.
    const ownerHomeFolderCandidate = sourceGroupEntry?.created_by
      ? getUserHomeGroup(sourceGroupEntry.created_by)?.folder
      : null;
    const broadcastFolder = resolveBroadcastFolder(
      sourceGroup,
      ownerHomeFolderCandidate,
    );

    for (const {
      path: ipcRoot,
      agentId: ipcAgentId,
      taskId: ipcTaskId,
    } of ipcRoots) {
      const durableTaskRunId = extractDurableTaskRunIdFromNamespace(ipcTaskId);
      const messagesDir = path.join(ipcRoot, 'messages');
      const messageResultsDir = path.join(ipcRoot, 'message-results');
      const tasksDir = path.join(ipcRoot, 'tasks');

      await cleanupStaleIpcMessageResults(messageResultsDir);

      // Process messages from this group's IPC directory
      try {
        const messageEntries = await fsp.readdir(messagesDir);
        const messageFiles = messageEntries.filter((f) => f.endsWith('.json'));
        for (const file of messageFiles) {
          const filePath = path.join(messagesDir, file);
          let messageRequestId: string | undefined;
          let messageResultWritten = false;
          try {
            const raw = await fsp.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            messageRequestId =
              typeof data.requestId === 'string' ? data.requestId : undefined;
            if (
              data.type === 'message' &&
              (typeof data.chatJid !== 'string' ||
                !data.chatJid ||
                typeof data.text !== 'string' ||
                !data.text)
            ) {
              messageResultWritten = writeIpcMessageResult(
                messageResultsDir,
                messageRequestId,
                { success: false, error: 'Invalid message request.' },
              );
              await fsp.unlink(filePath);
              continue;
            }
            if (
              data.type === 'image' &&
              (typeof data.chatJid !== 'string' ||
                !data.chatJid ||
                typeof data.imageBase64 !== 'string' ||
                !data.imageBase64)
            ) {
              messageResultWritten = writeIpcMessageResult(
                messageResultsDir,
                messageRequestId,
                { success: false, error: 'Invalid image request.' },
              );
              if (
                !canDeleteAcknowledgedIpcSource(
                  messageRequestId,
                  messageResultWritten,
                )
              ) {
                throw new Error('Failed to acknowledge invalid image request');
              }
              await fsp.unlink(filePath);
              continue;
            }
            if (data.type === 'message' && data.chatJid && data.text) {
              const targetGroup = getIpcDeliveryTargetGroup(data.chatJid);
              let messageDelivered = false;
              let messageStaged = false;
              let messageDeliveryError: string | undefined;
              let messageDeliveryUncertain = false;
              let nativeDeliveryAcknowledged = false;
              let stagedDisposition:
                | 'staged_progress'
                | 'staged_final'
                | undefined;
              const isTaskIpcMessage = !!(
                data.isScheduledTask ||
                data.taskId ||
                ipcTaskId
              );
              const frozenIpcMode = resolveFrozenIpcInteractionMode(
                data.interactionMode,
                {
                  scheduledTask: isTaskIpcMessage,
                  spawnAgent:
                    !!ipcAgentId &&
                    getAgent(ipcAgentId)?.kind !== 'conversation',
                },
              );
              if (!frozenIpcMode.valid) {
                messageResultWritten = writeIpcMessageResult(
                  messageResultsDir,
                  messageRequestId,
                  {
                    success: false,
                    error: 'Invalid frozen interaction mode.',
                  },
                );
                await fsp.unlink(filePath);
                continue;
              }
              const ipcInteractionMode = frozenIpcMode.mode;
              const authorized = canSendCrossGroupMessage(
                isAdminHome,
                isHome,
                sourceGroup,
                sourceGroupEntry,
                targetGroup,
              );
              const hostOutputRoute = routeHostIpcOutput(
                {
                  sourceGroup,
                  agentId: ipcAgentId,
                  inputTurnId: data.inputTurnId,
                  text: data.text,
                  deliveryRole: data.deliveryRole,
                  authorized,
                  scheduledTask: isTaskIpcMessage,
                  interactionMode: ipcInteractionMode,
                },
                activeTurnOutputs,
              );
              const stagingAttempted =
                hostOutputRoute.path === 'primary_projection';
              if (hostOutputRoute.path === 'primary_projection') {
                messageDelivered = hostOutputRoute.delivered;
                messageStaged = hostOutputRoute.staged;
                stagedDisposition = hostOutputRoute.disposition;
                if (hostOutputRoute.stageResult.accepted) {
                  logger.info(
                    {
                      sourceGroup,
                      agentId: ipcAgentId,
                      inputTurnId: data.inputTurnId,
                      deliveryRole: hostOutputRoute.deliveryRole,
                      duplicate: hostOutputRoute.stageResult.duplicate,
                    },
                    'IPC send_message joined the active primary reply',
                  );
                } else {
                  logger.warn(
                    {
                      sourceGroup,
                      agentId: ipcAgentId,
                      inputTurnId: data.inputTurnId,
                      deliveryRole: hostOutputRoute.deliveryRole,
                      reason: hostOutputRoute.stageResult.reason,
                    },
                    'IPC send_message could not join its exact active primary reply',
                  );
                }
              }
              if (messageStaged || stagingAttempted) {
                // Staged progress/final text intentionally has no independent
                // DB/IM side effect. SDK Result will finalize the same primary
                // answer; a failed staging attempt must not fall through into
                // the legacy separate-message path.
              } else if (
                isRetryDuplicateIpcSend(sourceGroup, data.chatJid, data.text)
              ) {
                // The deduplicator only records confirmed deliveries, so a
                // replay hit is itself evidence that the prior attempt reached
                // the user. Failed attempts are deliberately never recorded.
                messageDelivered = true;
                nativeDeliveryAcknowledged = true;
                logger.info(
                  { sourceGroup, chatJid: data.chatJid },
                  'Duplicate IPC send_message suppressed (retry replay window)',
                );
              } else if (authorized) {
                if (
                  isTaskIpcMessage &&
                  durableTaskRunId &&
                  !taskRunAcceptsLateIpcOutput(durableTaskRunId)
                ) {
                  messageResultWritten = writeIpcMessageResult(
                    messageResultsDir,
                    messageRequestId,
                    {
                      success: false,
                      error: 'Task run was cancelled before message delivery.',
                    },
                  );
                  await fsp.unlink(filePath);
                  continue;
                }
                // Conversation agents and isolated scheduled tasks route to
                // virtual JIDs so output appears in their own tab/session,
                // not the workspace main conversation.
                const effectiveChatJid = resolveHostIpcLogicalChatJid({
                  sourceChatJid: data.chatJid,
                  agentId: ipcAgentId,
                  agentChatJid: ipcAgentId
                    ? getAgent(ipcAgentId)?.chat_jid
                    : undefined,
                  taskRunId: ipcTaskId,
                  scheduledTask: data.isScheduledTask === true,
                });
                // Feishu card JSON: store extracted markdown for web, send raw JSON to IM
                const cardText = extractFeishuCardText(data.text);
                const webText = cardText || data.text;

                // Every non-task native send, including conversation agents,
                // resolves the sticky exact route and uses the Turn Outbox.
                // DB/Web stores markdown extracted from a Feishu card; the
                // connector receives the original JSON/text payload.
                if (!isTaskIpcMessage) {
                  const ipcImRoute = resolveImRoute({
                    ipcAgentId,
                    isHome,
                    chatJid: data.chatJid,
                    sourceGroup,
                  });
                  if (ipcImRoute) {
                    if (
                      typeof data.inputTurnId !== 'string' ||
                      !data.inputTurnId
                    ) {
                      messageDelivered = false;
                      logger.error(
                        {
                          sourceGroup,
                          agentId: ipcAgentId,
                          chatJid: data.chatJid,
                        },
                        'Suppressed IPC send_message without an immutable inputTurnId',
                      );
                    } else {
                      const messageScopeKey = channelTurnScope(
                        sourceGroup,
                        ipcAgentId,
                      );
                      const messageScope =
                        activeChannelOutboxScopes.resolveInput(
                          messageScopeKey,
                          data.inputTurnId,
                          ipcImRoute,
                        );
                      if (
                        !activeTurnOutputs.canDeliverUtterance({
                          scopeKey: messageScopeKey,
                          inputTurnId: data.inputTurnId,
                        })
                      ) {
                        // Runaway-loop fuse. Already delivered messages stand;
                        // the model gets a stable machine-readable reason so it
                        // can tell "stop talking" from "retry later".
                        messageDelivered = false;
                        messageDeliveryError = REPLY_LIMIT_REACHED_ERROR;
                        logger.warn(
                          {
                            sourceGroup,
                            agentId: ipcAgentId,
                            inputTurnId: data.inputTurnId,
                          },
                          'Suppressed IPC send_message: per-turn reply limit reached',
                        );
                      } else {
                        messageDelivered = await sendImWithRetry(
                          ipcImRoute,
                          data.text,
                          extractLocalImImagePaths(data.text, sourceGroup),
                          channelOutboxRefForInput(
                            messageScopeKey,
                            ipcImRoute,
                            data.inputTurnId,
                            `ipc-message:${messageRequestId ?? file}`,
                          ),
                          usesNativeMessagePresentation(ipcInteractionMode)
                            ? { presentation: 'native' }
                            : undefined,
                          {
                            deliveryRole: hostOutputRoute.deliveryRole,
                            inputTurnId: data.inputTurnId,
                            logicalChatJid: effectiveChatJid,
                          },
                        );
                        nativeDeliveryAcknowledged = messageDelivered;
                        if (
                          !messageDelivered &&
                          messageScope &&
                          getUncertainChannelOutboxForTurn(
                            messageScope.turnRunId,
                          )
                        ) {
                          messageDeliveryUncertain = true;
                          messageDeliveryError =
                            'Message delivery is uncertain or fenced by an earlier uncertain channel mutation. Do not retry, sleep, switch to a card, or call a raw channel API; the framework will notify the user.';
                        }
                      }
                    }
                  } else if (
                    getSessionChannelOwner(sourceGroup, ipcAgentId ?? null)
                  ) {
                    // The session is owned by a native channel, so a missing
                    // route means the route is unavailable — not that this is a
                    // Web-only session. Reporting "delivered" here told the
                    // model its message had reached the user while the IM side
                    // stayed silent, which in Proactive mode (no published SDK
                    // final) meant the user saw nothing at all.
                    messageDelivered = false;
                    messageDeliveryError =
                      'Message could not be delivered: this session is bound to a native channel whose route is currently unavailable.';
                    logger.error(
                      {
                        sourceGroup,
                        agentId: ipcAgentId,
                        chatJid: data.chatJid,
                      },
                      'Suppressed IPC send_message: native-owned session has no resolvable route',
                    );
                  } else {
                    // A genuinely Web-only logical session is delivered by
                    // durable persistence/broadcast below; it has no native
                    // provider side effect to acknowledge first.
                    messageDelivered = true;
                  }
                }

                // Scheduled-task delivery uses its independent durable task
                // receipt ledger.
                if (!ipcAgentId) {
                  // Scheduled-task output routing. Decision logic is in
                  // resolveTaskRoutingDecision() (src/task-routing.ts) so it
                  // can be unit-tested without booting this module.
                  const routingDecision = resolveTaskRoutingDecision(
                    data,
                    ipcTaskId,
                    !!sourceGroupEntry?.created_by,
                    { getTaskById, getChannelType },
                  );
                  if (isTaskIpcMessage) {
                    const taskLocalImages = extractLocalImImagePaths(
                      data.text,
                      sourceGroup,
                    );
                    const attempts: TaskNotificationDeliveryAttempt[] = [];
                    const addTargetAttempts = (targetJid: string): void => {
                      const channel = getChannelType(targetJid) ?? targetJid;
                      attempts.push({
                        channel,
                        payload: {
                          kind: 'im_message',
                          targetJid,
                          text: data.text,
                          localImagePaths: [],
                        },
                        deliver: () =>
                          sendImWithRetry(targetJid, data.text, []),
                      });
                      for (const imagePath of taskLocalImages) {
                        const imageBuffer = fs.readFileSync(imagePath);
                        const mimeType = detectImageMimeType(imageBuffer);
                        const fileName = path.basename(imagePath);
                        attempts.push({
                          channel,
                          payload: {
                            kind: 'im_image',
                            targetJid,
                            workspaceFolder: sourceGroup,
                            filePath: path.relative(
                              path.resolve(GROUPS_DIR, sourceGroup),
                              imagePath,
                            ),
                            mimeType,
                            fileName,
                          },
                          deliver: () =>
                            sendTaskImageWithRetry(
                              targetJid,
                              imageBuffer,
                              mimeType,
                              undefined,
                              fileName,
                            ),
                        });
                      }
                    };
                    if (routingDecision.mode === 'direct') {
                      const targetJid = routingDecision.taskChatJid;
                      addTargetAttempts(targetJid);
                    } else if (
                      routingDecision.mode === 'broadcast' &&
                      sourceGroupEntry?.created_by
                    ) {
                      // Fallback: broadcast to all connected IM channels
                      const alreadySent = new Set<string>(
                        [
                          data.chatJid,
                          activeImReplyRoutes.get(sourceGroup),
                        ].filter(Boolean) as string[],
                      );
                      broadcastToOwnerIMChannels(
                        sourceGroupEntry.created_by,
                        broadcastFolder,
                        alreadySent,
                        (jid) => {
                          addTargetAttempts(jid);
                        },
                        routingDecision.notifyChannels,
                      );
                    }
                    const delivery = await settleAndRecordTaskIpcDeliveries(
                      durableTaskRunId,
                      attempts,
                    );
                    messageDelivered =
                      delivery.accepted &&
                      (delivery.receipt.status === 'success' ||
                        delivery.receipt.status === 'skipped');
                  }
                }
                const projectionMessageId = `ipc_${crypto
                  .createHash('sha256')
                  .update(
                    [
                      effectiveChatJid,
                      typeof data.inputTurnId === 'string'
                        ? data.inputTurnId
                        : '',
                      data.text,
                    ].join('\0'),
                  )
                  .digest('hex')
                  .slice(0, 32)}`;
                const isExplicitProactiveFinal =
                  !isTaskIpcMessage &&
                  ipcInteractionMode === 'proactive' &&
                  hostOutputRoute.deliveryRole === 'final' &&
                  typeof data.inputTurnId === 'string' &&
                  Boolean(data.inputTurnId);

                // An unacknowledged native final must keep the exact answer in
                // the canonical Web session without replaying the provider
                // mutation. Its provenance remains visibly non-completed.
                if (!messageDelivered && isExplicitProactiveFinal) {
                  const preserved = await preserveUnacknowledgedProactiveFinal({
                    registry: activeTurnOutputs,
                    scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
                    inputTurnId: data.inputTurnId,
                    text: webText,
                    uncertain: messageDeliveryUncertain,
                    project: async (text, finalizationReason) => {
                      const outcome = await sendMessageWithOutcome(
                        effectiveChatJid,
                        text,
                        {
                          sendToIM: false,
                          messageId: projectionMessageId,
                          messageMeta: {
                            turnId: data.inputTurnId,
                            sourceKind: 'sdk_send_message',
                            finalizationReason,
                          },
                        },
                      );
                      return outcome.targetDelivered;
                    },
                  });
                  logger[preserved.projected ? 'warn' : 'error'](
                    {
                      chatJid: effectiveChatJid,
                      sourceGroup,
                      agentId: ipcAgentId,
                      inputTurnId: data.inputTurnId,
                      finalizationReason: preserved.finalizationReason,
                    },
                    preserved.projected
                      ? 'Preserved unacknowledged Proactive final in canonical Web session'
                      : 'Failed to preserve unacknowledged Proactive final in canonical Web session',
                  );
                }
                if (messageDelivered) {
                  const sendOutcome = await sendMessageWithOutcome(
                    effectiveChatJid,
                    webText,
                    {
                      // Native delivery above owns the physical ACK. Only
                      // confirmed sends are projected into the canonical Web
                      // session, using a replay-stable id.
                      sendToIM: false,
                      messageId: projectionMessageId,
                      messageMeta: {
                        turnId:
                          typeof data.inputTurnId === 'string'
                            ? data.inputTurnId
                            : undefined,
                        sourceKind: 'sdk_send_message',
                        finalizationReason:
                          hostOutputRoute.deliveryRole === 'final'
                            ? 'completed'
                            : undefined,
                      },
                    },
                  );
                  messageDelivered = sendOutcome.targetDelivered;
                  if (!messageDelivered && nativeDeliveryAcknowledged) {
                    // The provider side effect already ACKed. Reporting a tool
                    // failure would invite a duplicate retry; preserve the ACK
                    // while leaving the canonical projection failure visible
                    // in logs for operator repair.
                    messageDelivered = true;
                    logger.error(
                      {
                        chatJid: effectiveChatJid,
                        sourceGroup,
                        agentId: ipcAgentId,
                        inputTurnId: data.inputTurnId,
                      },
                      'Native IPC message ACKed but canonical Web projection failed',
                    );
                  }
                }
                if (messageDelivered) {
                  recordSuccessfulIpcSend(sourceGroup, data.chatJid, data.text);
                }
                logger.info(
                  {
                    chatJid: effectiveChatJid,
                    sourceGroup,
                    agentId: ipcAgentId,
                    delivered: messageDelivered,
                  },
                  messageDelivered
                    ? 'IPC message delivered and projected'
                    : 'IPC message was not delivered',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              }
              const isMainUserTurnReply = !(
                data.isScheduledTask ||
                data.taskId ||
                ipcTaskId ||
                ipcAgentId
              );
              if (
                messageDelivered &&
                !messageStaged &&
                !isTaskIpcMessage &&
                typeof data.inputTurnId === 'string' &&
                data.inputTurnId
              ) {
                activeTurnOutputs.recordDeliveredUtterance({
                  scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
                  inputTurnId: data.inputTurnId,
                  role: hostOutputRoute.deliveryRole ?? undefined,
                  text: data.text,
                });
              }
              if (
                messageDelivered &&
                !messageStaged &&
                isMainUserTurnReply &&
                typeof data.inputTurnId === 'string' &&
                data.inputTurnId
              ) {
                const activeTracker =
                  activeIpcReplyTurnTrackers.get(sourceGroup);
                if (activeTracker) {
                  acknowledgeIpcReplyTurn(activeTracker, data.inputTurnId);
                }
              }
              messageResultWritten = writeIpcMessageResult(
                messageResultsDir,
                messageRequestId,
                messageDelivered
                  ? {
                      success: true,
                      disposition: stagedDisposition ?? 'delivered_separately',
                    }
                  : {
                      success: false,
                      error:
                        messageDeliveryError ??
                        'Message could not be delivered to its target.',
                    },
              );
            } else if (
              data.type === 'image' &&
              data.chatJid &&
              data.imageBase64
            ) {
              // Handle image IPC messages from send_image MCP tool
              const targetGroup = getIpcDeliveryTargetGroup(data.chatJid);
              let taskImageTargetJids: string[] = [];
              let taskImageDeliverySettled = false;
              let isTaskIpcImage = false;
              if (
                canSendCrossGroupMessage(
                  isAdminHome,
                  isHome,
                  sourceGroup,
                  sourceGroupEntry,
                  targetGroup,
                )
              ) {
                try {
                  const imageBuffer = Buffer.from(data.imageBase64, 'base64');
                  const mimeType = data.mimeType || 'image/png';
                  const caption = data.caption || undefined;
                  const fileName = data.fileName || undefined;

                  isTaskIpcImage = !!(
                    data.isScheduledTask ||
                    data.taskId ||
                    ipcTaskId
                  );
                  if (
                    isTaskIpcImage &&
                    durableTaskRunId &&
                    !taskRunAcceptsLateIpcOutput(durableTaskRunId)
                  ) {
                    messageResultWritten = writeIpcMessageResult(
                      messageResultsDir,
                      messageRequestId,
                      {
                        success: false,
                        error: 'Task run was cancelled before image delivery.',
                      },
                    );
                    if (
                      !canDeleteAcknowledgedIpcSource(
                        messageRequestId,
                        messageResultWritten,
                      )
                    ) {
                      throw new Error(
                        'Failed to acknowledge cancelled image request',
                      );
                    }
                    await fsp.unlink(filePath);
                    continue;
                  }
                  // Runaway-loop fuse, sharing send_message's budget. An image
                  // is an irreversible side effect in a real chat, so it must
                  // be gated too: otherwise images drain the budget silently
                  // and the turn's actual answer is the delivery that gets
                  // refused. Task images keep their own accounting.
                  if (
                    !isTaskIpcImage &&
                    !canDeliverTurnUtterance(
                      sourceGroup,
                      ipcAgentId,
                      data.inputTurnId,
                    )
                  ) {
                    logger.warn(
                      {
                        sourceGroup,
                        agentId: ipcAgentId,
                        inputTurnId: data.inputTurnId,
                      },
                      'Suppressed IPC send_image: per-turn reply limit reached',
                    );
                    messageResultWritten = writeIpcMessageResult(
                      messageResultsDir,
                      messageRequestId,
                      { success: false, error: REPLY_LIMIT_REACHED_ERROR },
                    );
                    if (
                      !canDeleteAcknowledgedIpcSource(
                        messageRequestId,
                        messageResultWritten,
                      )
                    ) {
                      throw new Error(
                        'Failed to acknowledge reply-limited image request',
                      );
                    }
                    await fsp.unlink(filePath);
                    continue;
                  }
                  const imgImRoute = isTaskIpcImage
                    ? null
                    : resolveImRoute({
                        ipcAgentId,
                        isHome,
                        chatJid: data.chatJid,
                        sourceGroup,
                      });
                  let regularImageDelivered: boolean | null = null;
                  let durableScopedImage = false;
                  if (isTaskIpcImage) {
                    const imgRoutingDecision = resolveTaskRoutingDecision(
                      data,
                      ipcTaskId,
                      !!sourceGroupEntry?.created_by,
                      { getTaskById, getChannelType },
                    );
                    if (imgRoutingDecision.mode === 'direct') {
                      taskImageTargetJids = [imgRoutingDecision.taskChatJid];
                    } else if (
                      imgRoutingDecision.mode === 'broadcast' &&
                      sourceGroupEntry?.created_by
                    ) {
                      const alreadySent = new Set<string>(
                        [data.chatJid, imgImRoute].filter(Boolean) as string[],
                      );
                      broadcastToOwnerIMChannels(
                        sourceGroupEntry.created_by,
                        broadcastFolder,
                        alreadySent,
                        (jid) => taskImageTargetJids.push(jid),
                        imgRoutingDecision.notifyChannels,
                      );
                    }
                  }
                  if (imgImRoute) {
                    const imageOutboxRef = channelOutboxRefForInput(
                      channelTurnScope(sourceGroup, ipcAgentId),
                      imgImRoute,
                      data.inputTurnId,
                      `ipc-image:${messageRequestId ?? file}`,
                    );
                    durableScopedImage = Boolean(imageOutboxRef);
                    regularImageDelivered = await sendTaskImageWithRetry(
                      imgImRoute,
                      imageBuffer,
                      mimeType,
                      caption,
                      fileName,
                      imageOutboxRef,
                    );
                    if (!regularImageDelivered) {
                      const failMsg = durableScopedImage
                        ? `⚠️ 图片 "${fileName || caption || 'image'}" 的投递结果待确认，系统不会自动重发，以免产生重复图片。`
                        : `⚠️ 图片 "${fileName || caption || 'image'}" 发送失败（IM 通道发送失败），请稍后重试。`;
                      broadcastToWebClients(sourceGroup, failMsg);
                    }
                  } else if (!isTaskIpcImage) {
                    logger.debug(
                      { chatJid: data.chatJid, sourceGroup },
                      'No IM route for send_image, skipped IM delivery',
                    );
                    const skipImgMsg = `⚠️ 图片 "${fileName || 'image'}" 未发送到 IM 通道（当前会话无 IM 路由绑定）。`;
                    broadcastToWebClients(
                      data.chatJid ?? sourceGroup,
                      skipImgMsg,
                    );
                  }

                  // Conversation agents and isolated scheduled tasks store in
                  // virtual JIDs (agent/task tab), not the main conversation.
                  const imgChatJid = ipcAgentId
                    ? `${data.chatJid}#agent:${ipcAgentId}`
                    : ipcTaskId && data.isScheduledTask
                      ? `${data.chatJid}#task:${ipcTaskId}`
                      : data.chatJid;

                  // Persist image message to DB and broadcast to WebSocket (same as sendMessage flow)
                  const displayText = caption
                    ? `[图片: ${fileName || 'image'}]\n${caption}`
                    : `[图片: ${fileName || 'image'}]`;
                  const imgMsgId = crypto.randomUUID();
                  const imgTimestamp = new Date().toISOString();
                  ensureChatExists(imgChatJid);
                  const persistedImgMsgId = storeMessageDirect(
                    imgMsgId,
                    imgChatJid,
                    'happyclaw-agent',
                    ASSISTANT_NAME,
                    displayText,
                    imgTimestamp,
                    true,
                    { meta: { sourceKind: 'sdk_send_message' } },
                  );
                  broadcastNewMessage(imgChatJid, {
                    id: persistedImgMsgId,
                    chat_jid: imgChatJid,
                    sender: 'happyclaw-agent',
                    sender_name: ASSISTANT_NAME,
                    content: displayText,
                    timestamp: imgTimestamp,
                    is_from_me: true,
                    turn_id: null,
                    session_id: null,
                    sdk_message_uuid: null,
                    source_kind: 'sdk_send_message',
                    finalization_reason: null,
                  });
                  broadcastToWebClients(imgChatJid, displayText);

                  // Scheduled-task image routing uses the same direct target /
                  // notify-channel fan-out contract as text and file outputs.
                  if (isTaskIpcImage) {
                    const attempts: TaskNotificationDeliveryAttempt[] = [];
                    const relativeImagePath =
                      typeof data.filePath === 'string' ? data.filePath : '';
                    const imageAttempt = (
                      targetJid: string,
                    ): TaskNotificationDeliveryAttempt => ({
                      channel: getChannelType(targetJid) ?? targetJid,
                      payload: {
                        kind: 'im_image',
                        targetJid,
                        workspaceFolder: sourceGroup,
                        filePath: relativeImagePath,
                        mimeType,
                        caption,
                        fileName,
                      },
                      deliver: () =>
                        sendTaskImageWithRetry(
                          targetJid,
                          imageBuffer,
                          mimeType,
                          caption,
                          fileName,
                        ),
                    });
                    for (const targetJid of taskImageTargetJids) {
                      attempts.push(imageAttempt(targetJid));
                    }
                    const delivery = await settleAndRecordTaskIpcDeliveries(
                      durableTaskRunId,
                      attempts,
                    );
                    taskImageDeliverySettled = true;
                    const delivered =
                      delivery.accepted &&
                      (delivery.receipt.status === 'success' ||
                        delivery.receipt.status === 'skipped');
                    messageResultWritten = writeIpcMessageResult(
                      messageResultsDir,
                      messageRequestId,
                      delivered
                        ? { success: true }
                        : {
                            success: false,
                            error:
                              delivery.receipt.error ||
                              'Image could not be delivered to its target.',
                          },
                    );
                  } else {
                    messageResultWritten = writeIpcMessageResult(
                      messageResultsDir,
                      messageRequestId,
                      regularImageDelivered
                        ? { success: true }
                        : {
                            success: false,
                            error: durableScopedImage
                              ? 'Image delivery outcome is uncertain; do not retry automatically.'
                              : 'Image could not be delivered to its IM target.',
                          },
                    );
                    // An image is user-visible speech. Without this the turn
                    // looks silent, so a later runner error replays the input
                    // and the user receives the artifact twice.
                    if (
                      regularImageDelivered &&
                      typeof data.inputTurnId === 'string' &&
                      data.inputTurnId
                    ) {
                      activeTurnOutputs.recordDeliveredUtterance({
                        scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
                        inputTurnId: data.inputTurnId,
                      });
                    }
                  }

                  logger.info(
                    {
                      chatJid: imgChatJid,
                      sourceGroup,
                      mimeType,
                      size: imageBuffer.length,
                      agentId: ipcAgentId,
                    },
                    'IPC image sent',
                  );
                } catch (err) {
                  if (
                    isTaskIpcImage &&
                    durableTaskRunId &&
                    !taskImageDeliverySettled
                  ) {
                    const failed = buildFailedTaskImageNotification({
                      targetJids: taskImageTargetJids,
                      workspaceFolder: sourceGroup,
                      filePath:
                        typeof data.filePath === 'string' ? data.filePath : '',
                      mimeType: data.mimeType || 'image/png',
                      caption: data.caption || undefined,
                      fileName: data.fileName || undefined,
                      error: err,
                      getChannel: getChannelType,
                    });
                    if (failed) {
                      recordTaskRunNotificationReceipt(
                        durableTaskRunId,
                        failed.receipt,
                        failed.payload,
                      );
                    }
                  }
                  logger.error(
                    { chatJid: data.chatJid, sourceGroup, err },
                    'Failed to process IPC image',
                  );
                  throw err;
                }
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC image attempt blocked',
                );
                messageResultWritten = writeIpcMessageResult(
                  messageResultsDir,
                  messageRequestId,
                  { success: false, error: 'Unauthorized image target.' },
                );
              }
            }
            if (
              !canDeleteAcknowledgedIpcSource(
                messageRequestId,
                messageResultWritten,
              )
            ) {
              throw new Error('Failed to acknowledge IPC delivery result');
            }
            await fsp.unlink(filePath);
          } catch (err) {
            if (!messageResultWritten) {
              writeIpcMessageResult(messageResultsDir, messageRequestId, {
                success: false,
                error: 'Internal error while delivering message.',
              });
            }
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC message',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fsp.mkdir(errorDir, { recursive: true });
            try {
              await fsp.rename(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            } catch (renameErr) {
              logger.error(
                { file, sourceGroup, renameErr },
                'Failed to move IPC message to error directory; retaining source for retry',
              );
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC messages directory',
          );
        }
      }

      // Process tasks from this group's IPC directory
      try {
        const allEntries = await fsp.readdir(tasksDir, {
          withFileTypes: true,
        });

        // 清理孤儿结果文件（容器崩溃或超时后残留，超过 10 分钟自动删除）
        const RESULT_FILE_PREFIXES = [
          'install_skill_result_',
          'uninstall_skill_result_',
          'list_tasks_result_',
          'schedule_task_result_',
          'cancel_task_result_',
          'pause_task_result_',
          'resume_task_result_',
          'update_task_result_',
          'run_task_now_result_',
          'stop_task_run_result_',
          'restore_task_result_',
          'list_task_runs_result_',
          'send_file_result_',
          'discord_get_history_result_',
          'discord_get_channel_info_result_',
          'discord_get_server_info_result_',
          'agent_profile_list_result_',
          'agent_profile_get_result_',
          'agent_profile_draft_get_result_',
          'agent_capability_catalog_result_',
          'agent_profile_prepare_result_',
          'agent_profile_publish_result_',
          'agent_profile_discard_result_',
          'workspace_memory_result_',
          'happyclaw_owner_profile_result_',
        ];
        const isResultFile = (name: string) =>
          RESULT_FILE_PREFIXES.some((p) => name.startsWith(p));

        for (const entry of allEntries) {
          if (
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            isResultFile(entry.name)
          ) {
            try {
              const filePath = path.join(tasksDir, entry.name);
              const stat = await fsp.stat(filePath);
              if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                await fsp.unlink(filePath);
                logger.debug(
                  { sourceGroup, file: entry.name },
                  'Cleaned up stale result file',
                );
              }
            } catch {
              /* ignore */
            }
          }
        }

        const taskFiles = allEntries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              !isResultFile(entry.name),
          )
          .map((entry) => entry.name);
        for (const file of taskFiles) {
          const filePath = path.join(tasksDir, file);
          let parsedData: { type?: string; requestId?: string } | undefined;
          try {
            const raw = await fsp.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            parsedData = data;
            // Pass source group identity to processTaskIpc for authorization.
            // tasksDir 是请求文件被读出的那个 ipcRoot/tasks，回执必须写回同一目录。
            await processTaskIpc(
              data,
              sourceGroup,
              isAdminHome,
              isHome,
              sourceGroupEntry,
              tasksDir,
              ipcAgentId,
              ipcTaskId,
            );
            await fsp.unlink(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC task',
            );
            // 兜底：带 requestId 的任务请求若在处理中抛异常（如 DB 锁/损坏），也写一条
            // 失败回执，避免容器侧 pollIpcResult 空等满 30s 超时。
            if (
              parsedData?.requestId &&
              typeof parsedData.type === 'string' &&
              parsedData.type.endsWith('_task')
            ) {
              writeTaskResult(tasksDir, parsedData.type, parsedData.requestId, {
                success: false,
                error: 'Internal error while processing task request.',
              });
            }
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fsp.mkdir(errorDir, { recursive: true });
            try {
              await fsp.rename(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            } catch (renameErr) {
              logger.error(
                { file, sourceGroup, renameErr },
                'Failed to move IPC task to error directory, deleting',
              );
              try {
                await fsp.unlink(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC tasks directory',
          );
        }
      }

      // The scheduler only marks isolated IPC namespaces complete.  Output
      // files remain authoritative until this watcher has finished their side
      // effects and unlinked/archived them.  Cleaning here also recovers runs
      // left behind by a process crash: the startup full scan drains the files
      // first, then removes the completed namespace.
      if (ipcTaskId) {
        try {
          if (
            tryCleanupCompletedIsolatedTaskRunIpc(ipcRoot, (completion) => {
              if (
                completion.taskRunId !== ipcTaskId ||
                completion.workspaceFolder !== sourceGroup
              ) {
                throw new Error(
                  'Isolated task completion marker does not match its IPC namespace',
                );
              }
              const completedDurableRunId =
                completion.durableRunId ?? durableTaskRunId;
              if (completedDurableRunId) {
                finalizeTaskRunNotificationIfPending(completedDurableRunId);
              }
              deleteSession(sourceGroup, completion.sessionAgentId);
              deleteMessagesForChatJid(completion.virtualChatJid);
              fs.rmSync(
                path.join(
                  DATA_DIR,
                  'sessions',
                  sourceGroup,
                  'agents',
                  completion.sessionAgentId,
                ),
                { recursive: true, force: true },
              );
              cleanupContainerTaskRuntimeEnvDirs(sourceGroup, ipcTaskId);
            })
          ) {
            logger.debug(
              { sourceGroup, taskRunId: ipcTaskId },
              'Cleaned completed isolated task IPC namespace after drain',
            );
          }
        } catch (err) {
          logger.warn(
            { sourceGroup, taskRunId: ipcTaskId, err },
            'Failed to clean completed isolated task IPC namespace',
          );
        }
      }
    } // end for (const ipcRoot of ipcRoots)
  };

  const processIpcFilesFull = async () => {
    if (shuttingDown) return;
    let groupFolders: string[];
    try {
      const entries = await fsp.readdir(ipcBaseDir, { withFileTypes: true });
      groupFolders = entries
        .filter((e) => e.isDirectory() && e.name !== 'errors')
        .map((e) => e.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    for (const sourceGroup of groupFolders) {
      // Route through the concurrency guard to prevent racing with event-driven triggers
      ipcWatcherManager!.triggerProcess(sourceGroup);
    }
  };

  // Initialize the event-driven IPC watcher manager
  ipcWatcherManager = new IpcWatcherManager();
  ipcWatcherManager.bind(processGroupIpc, processIpcFilesFull);

  // Initial full scan
  processIpcFilesFull().catch((err) => {
    logger.error({ err }, 'Error in initial IPC scan');
  });

  // Start fallback polling (5s instead of 1s)
  ipcWatcherManager.startFallback();

  logger.info('IPC watcher started (event-driven + 5s fallback)');
}

/** Atomically acknowledge send_message only after the host has completed its
 * real delivery side effects. Results live outside messages/ so the host
 * watcher cannot consume its own acknowledgement before the runner sees it. */
function writeIpcMessageResult(
  resultsDir: string,
  requestId: string | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!requestId) return false; // backwards compatibility with older runners
  if (!SAFE_REQUEST_ID_RE.test(requestId)) {
    logger.warn(
      { resultsDir, requestId },
      'Rejected message result with invalid requestId',
    );
    return false;
  }
  const dirResolved = path.resolve(resultsDir);
  const resultFilePath = path.resolve(
    resultsDir,
    `send_message_result_${requestId}.json`,
  );
  if (!resultFilePath.startsWith(`${dirResolved}${path.sep}`)) return false;
  try {
    fs.mkdirSync(resultsDir, { recursive: true });
    const tmpPath = `${resultFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, resultFilePath);
    return true;
  } catch (err) {
    logger.error(
      { resultsDir, requestId, err },
      'Failed to write message IPC result',
    );
    return false;
  }
}

async function cleanupStaleIpcMessageResults(
  resultsDir: string,
): Promise<void> {
  try {
    const entries = await fs.promises.readdir(resultsDir, {
      withFileTypes: true,
    });
    const cutoff = Date.now() - 10 * 60 * 1000;
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith('send_message_result_') &&
            entry.name.endsWith('.json'),
        )
        .map(async (entry) => {
          const resultPath = path.join(resultsDir, entry.name);
          try {
            const stat = await fs.promises.stat(resultPath);
            if (stat.mtimeMs < cutoff) {
              await fs.promises.unlink(resultPath);
            }
          } catch {
            // Concurrent runner consumption or cleanup is harmless.
          }
        }),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ resultsDir, err }, 'Failed to clean message IPC results');
    }
  }
}

/**
 * 把任务类 IPC 工具（schedule/pause/resume/cancel/update_task）的处理结果原子写回到
 * 「请求文件被读出的那个 tasksDir」/{type}_result_{requestId}.json，供容器侧 pollIpcResult
 * 读取。必须用请求所在的 tasksDir 而非按 folder 重算主 root——会话子 agent
 * （ipc/{folder}/agents/{id}/tasks）与 isolated 任务（ipc/{folder}/tasks-run/{id}/tasks）
 * 各有自己的嵌套 IPC root，写到主 root 会让它们永远读不到回执而空等超时。
 * 带 requestId 合法性 + 路径穿越校验；写失败仅记日志不抛。requestId 缺失时直接跳过
 * （兼容旧的 fire-and-forget 客户端，旧镜像不带 requestId 时退回原静默语义）。
 */
function writeTaskResult(
  tasksDir: string,
  type: string,
  requestId: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (!requestId) return;
  if (!SAFE_REQUEST_ID_RE.test(requestId)) {
    logger.warn(
      { tasksDir, type, requestId },
      'Rejected task result with invalid requestId',
    );
    return;
  }
  const dirResolved = path.resolve(tasksDir);
  const resultFilePath = path.resolve(
    tasksDir,
    `${type}_result_${requestId}.json`,
  );
  if (!resultFilePath.startsWith(`${dirResolved}${path.sep}`)) {
    logger.warn(
      { tasksDir, type, requestId, resultFilePath },
      'Rejected task result with unsafe path',
    );
    return;
  }
  try {
    fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
    const tmpPath = `${resultFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload), {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, resultFilePath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* already renamed or never created */
      }
    }
  } catch (err) {
    logger.error(
      { tasksDir, type, requestId, err },
      'Failed to write task IPC result',
    );
  }
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    runId?: string;
    expectedRevision?: number;
    idempotencyKey?: string;
    isScheduledTask?: boolean;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    execution_type?: string;
    execution_mode?: string;
    script_command?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    executionMode?: string;
    // For install_skill / uninstall_skill
    package?: string;
    requestId?: string;
    skillId?: string;
    // For send_file
    filePath?: string;
    fileName?: string;
    // For list_tasks
    isAdminHome?: boolean;
    includeDeleted?: boolean;
    // For discord_get_history
    limit?: number;
    before?: string;
    // Host-side Feishu capability broker
    inputTurnId?: string;
    operation?: string;
    params?: Record<string, unknown>;
    // Workspace Memory v2. Workspace/actor/sourceType are never accepted from
    // IPC; processTaskIpc derives them from the verified namespace.
    query?: string;
    kind?: string;
    maxChars?: number;
    itemId?: string;
    title?: string;
    content?: string;
    canonicalKey?: string | null;
    importance?: number;
    confidence?: number;
    validFrom?: string | null;
    validUntil?: string | null;
    expiresAt?: string | null;
    patch?: Record<string, unknown>;
    sessionId?: string;
    timestamp?: string;
    runnerInstanceId?: string;
    mutationSignature?: string;
    // Dedicated built-in HappyClaw Owner Profile facade.
    preferredAddress?: string;
    expectedOnboardingRevision?: number;
    leaseToken?: number;
    // For the main HappyClaw's conversational Agent Builder
    profileId?: string;
    draftId?: string;
    expectedDraftRevision?: number;
    targetAgentProfileId?: string;
    expectedAgentVersion?: number;
    definition?: unknown;
    assumptions?: string[];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isAdminHome: boolean, // Whether source is admin home container
  isHome: boolean, // Whether source is a home container
  sourceGroupEntry: RegisteredGroup | undefined, // Source group's registered entry
  tasksDir: string, // The exact ipcRoot/tasks dir the request was read from (for result write-back)
  ipcAgentId: string | null = null, // Non-null when IPC comes from a conversation agent
  ipcTaskId: string | null = null, // Non-null for an isolated scheduled-task run namespace
): Promise<void> {
  const durableTaskRunId = extractDurableTaskRunIdFromNamespace(ipcTaskId);
  const ownerHomeFolderCandidate = sourceGroupEntry?.created_by
    ? getUserHomeGroup(sourceGroupEntry.created_by)?.folder
    : null;
  const broadcastFolder = resolveBroadcastFolder(
    sourceGroup,
    ownerHomeFolderCandidate,
  );

  // Scheduled-task ACL for this IPC surface. The predicate itself lives in
  // src/task-acl.ts so it is unit-testable and cannot silently regress; see
  // that module for why `isAdminHome` is deliberately absent.
  const taskAclDeps: TaskAclDeps = {
    lookupGroup: (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
    resolveActor: () => {
      const actorId = sourceGroupEntry?.created_by;
      if (!actorId) return undefined;
      const actor = getUserById(actorId);
      if (!actor) return undefined;
      return { id: actor.id, role: actor.role, status: actor.status };
    },
    canAccessGroup,
  };
  const ipcActorCanAccessGroupJid = (targetJid: string): boolean =>
    canIpcActorAccessGroup(sourceGroup, targetJid, taskAclDeps);
  const ipcActorCanManageTask = (task: {
    group_folder: string;
    chat_jid: string;
  }): boolean => canIpcActorManageTask(sourceGroup, task, taskAclDeps);

  const requireAgentBuilderActor = (): AgentBuilderActor => {
    const ownerId = sourceGroupEntry?.created_by;
    const user = ownerId ? getUserById(ownerId) : undefined;
    if (!user || user.status !== 'active') {
      throw new Error('No active user owns this workspace');
    }
    const sourceProfile = getAgentProfileForWorkspace(sourceGroup, user.id);
    const runtimeAgent = ipcAgentId ? getAgent(ipcAgentId) : undefined;
    const runtimeRejection = getAgentBuilderRuntimeRejection({
      isScheduledTask: data.isScheduledTask === true,
      isolatedTaskId: ipcTaskId,
      runtimeAgentId: ipcAgentId,
      runtimeAgentKind: runtimeAgent?.kind ?? null,
      runtimeAgentFolder: runtimeAgent?.group_folder ?? null,
      sourceFolder: sourceGroup,
      sourceProfileIsDefault: sourceProfile?.is_default === true,
    });
    if (runtimeRejection) throw new Error(runtimeRejection);

    const activeTurn = activeAgentBuilderTurns.requireOwnerHumanTurn(
      agentBuilderTurnScope(sourceGroup, ipcAgentId),
      getAgentBuilderInputMessage,
      (input) =>
        isAgentBuilderOwnerInput(
          input,
          user.id,
          (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
        ),
    );
    return {
      user,
      sourceGroup,
      sourceChatJid: activeTurn.chatJid,
      sourceTurnId: activeTurn.messageId,
      sourceMessageContent: activeTurn.content,
    };
  };

  const requireOwnerProfileActor = () => {
    const ownerId = sourceGroupEntry?.created_by;
    const user = ownerId ? getUserById(ownerId) : undefined;
    const runtimeAgent = ipcAgentId ? getAgent(ipcAgentId) : undefined;
    const sourceProfile = ownerId
      ? getAgentProfileForWorkspace(sourceGroup, ownerId)
      : undefined;
    if (
      isHome !== true ||
      !sourceGroupEntry?.is_home ||
      !user ||
      user.status !== 'active' ||
      sourceProfile?.is_default !== true ||
      ipcTaskId ||
      (ipcAgentId &&
        (runtimeAgent?.kind !== 'conversation' ||
          runtimeAgent.group_folder !== sourceGroup))
    ) {
      throw new OwnerProfileStoreError(
        'not_home_workspace',
        'Owner Profile is unavailable in this runtime',
      );
    }
    const resolveOwnerTurn =
      data.operation === 'get'
        ? activeAgentBuilderTurns.requireExactOwnerHumanTurn.bind(
            activeAgentBuilderTurns,
          )
        : activeAgentBuilderTurns.requireExactActiveOwnerHumanTurn.bind(
            activeAgentBuilderTurns,
          );
    // The owner's IM identity is anchored across Home registrations, not the
    // single source row: Home chats registered before owner capture (legacy
    // topic groups with a NULL owner_im_id) must still authorize the owner.
    const resolveHomeOwnerImIds = (provider: string): string[] => {
      const ids = new Set<string>();
      for (const jid of getJidsByFolder(sourceGroup)) {
        if (getChannelType(jid) !== provider) continue;
        const row = registeredGroups[jid] ?? getRegisteredGroup(jid);
        if (
          row?.created_by === user.id &&
          row.owner_im_id &&
          row.owner_claim_source &&
          OWNER_PROFILE_TRUSTED_CLAIM_SOURCES.includes(row.owner_claim_source)
        ) {
          ids.add(row.owner_im_id);
        }
      }
      return [...ids];
    };
    let activeTurn: ReturnType<typeof resolveOwnerTurn>;
    try {
      activeTurn = resolveOwnerTurn(
        agentBuilderTurnScope(sourceGroup, ipcAgentId),
        data.inputTurnId,
        getAgentBuilderInputMessage,
        (persistedInput) =>
          isOwnerProfileOwnerInput(
            persistedInput,
            user.id,
            (jid) => registeredGroups[jid] ?? getRegisteredGroup(jid),
            resolveHomeOwnerImIds,
          ),
      );
    } catch (error) {
      // Turn-authorization misses are expected policy outcomes (queued
      // non-owner turns, stale turn ids), not host faults.
      throw new OwnerProfileStoreError(
        'not_owner_turn',
        error instanceof Error
          ? error.message
          : 'Owner Profile requires an owner conversation turn',
      );
    }
    const workspaceJid = getJidsByFolder(sourceGroup).find((jid) =>
      jid.startsWith('web:'),
    );
    if (!workspaceJid) {
      throw new OwnerProfileStoreError(
        'not_home_workspace',
        'Owner Home Workspace is unavailable',
      );
    }
    const scope = {
      groupFolder: sourceGroup,
      agentId: ipcAgentId,
      taskRunId: ipcTaskId,
    };
    const isMutation = data.operation !== 'get';
    if (
      !verifyWorkspaceMemoryCapability(
        scope,
        data as Record<string, unknown>,
        data.mutationSignature,
        isMutation,
      )
    ) {
      throw new OwnerProfileStoreError(
        'lease_conflict',
        'Owner Profile runner capability is missing or invalid',
      );
    }
    const context: WorkspaceMemoryMutationContext = {
      actorId: user.id,
      sourceType: 'agent_runtime',
      sourceId: activeTurn.messageId,
      sessionId: getSession(sourceGroup, ipcAgentId ?? undefined) ?? null,
      observedAt: new Date().toISOString(),
    };
    return { user, workspaceJid, activeTurn, context };
  };

  switch (data.type) {
    case 'happyclaw_owner_profile': {
      const finish = (payload: Record<string, unknown>): void =>
        writeTaskResult(
          tasksDir,
          'happyclaw_owner_profile',
          data.requestId,
          payload,
        );
      try {
        if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
          throw new Error('Invalid Owner Profile request ID');
        }
        const principal = requireOwnerProfileActor();
        if (
          (data.operation === 'get' || data.operation === 'skip') &&
          data.idempotencyKey !== undefined
        ) {
          throw new OwnerProfileStoreError(
            'idempotency_conflict',
            'Owner Profile get and skip do not accept idempotency keys',
          );
        }
        let result: Record<string, unknown>;
        switch (data.operation) {
          case 'get': {
            if (!data.runnerInstanceId) {
              throw new OwnerProfileStoreError(
                'lease_conflict',
                'Owner Profile runner identity is required',
              );
            }
            const claim = claimHappyClawOwnerIntroduction({
              workspaceJid: principal.workspaceJid,
              leaseOwner: data.runnerInstanceId,
            });
            const projection = claim.projection;
            const onboardingStatus = projection.preferredAddress
              ? 'known'
              : projection.onboarding.state === 'skipped'
                ? 'skipped'
                : projection.onboarding.state === 'completed'
                  ? 'cleared'
                  : claim.claimed
                    ? 'awaiting'
                    : 'unavailable';
            result = {
              projection,
              onboardingStatus,
              firstWake: claim.firstWake,
              leaseAcquired: claim.leaseAcquired,
            };
            break;
          }
          case 'ack_first_wake': {
            if (!data.runnerInstanceId) {
              throw new OwnerProfileStoreError(
                'lease_conflict',
                'Owner Profile runner identity is required',
              );
            }
            if (!Number.isInteger(data.leaseToken) || data.leaseToken! < 1) {
              throw new OwnerProfileStoreError(
                'lease_conflict',
                'Owner Profile lease token is required',
              );
            }
            result = acknowledgeHappyClawOwnerIntroduction({
              workspaceJid: principal.workspaceJid,
              leaseOwner: data.runnerInstanceId,
              leaseToken: data.leaseToken!,
            });
            break;
          }
          case 'set':
            result = setHappyClawOwnerPreferredAddress({
              workspaceJid: principal.workspaceJid,
              preferredAddress: data.preferredAddress ?? '',
              expectedRevision: data.expectedRevision,
              idempotencyKey: data.idempotencyKey,
              context: principal.context,
            });
            break;
          case 'clear':
            if (!Number.isInteger(data.expectedRevision)) {
              throw new OwnerProfileStoreError(
                'revision_conflict',
                'expectedRevision is required to clear the Owner Profile',
              );
            }
            result = clearHappyClawOwnerPreferredAddress({
              workspaceJid: principal.workspaceJid,
              expectedRevision: data.expectedRevision!,
              idempotencyKey: data.idempotencyKey,
              context: principal.context,
            });
            break;
          case 'skip':
            result = skipHappyClawOwnerIntroduction({
              workspaceJid: principal.workspaceJid,
              expectedOnboardingRevision: data.expectedOnboardingRevision,
              context: principal.context,
            });
            break;
          default:
            throw new Error('Unknown Owner Profile operation');
        }
        finish({ success: true, ...result });
      } catch (error) {
        const code =
          error instanceof OwnerProfileStoreError
            ? error.code
            : 'internal_error';
        finish({
          success: false,
          code,
          error:
            error instanceof OwnerProfileStoreError
              ? error.message
              : 'Internal error while processing Owner Profile request.',
          ...(error instanceof OwnerProfileStoreError && error.details
            ? { details: error.details }
            : {}),
        });
        logger.warn(
          {
            sourceGroup,
            operation: data.operation,
            code,
            error: error instanceof Error ? error.message : String(error),
          },
          'HappyClaw Owner Profile IPC request failed',
        );
      }
      break;
    }

    case 'workspace_memory': {
      const finish = (payload: Record<string, unknown>): void =>
        writeTaskResult(tasksDir, 'workspace_memory', data.requestId, payload);
      try {
        if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
          throw new Error('Invalid Workspace Memory request ID');
        }
        const ownerId = sourceGroupEntry?.created_by;
        const actor = ownerId ? getUserById(ownerId) : undefined;
        if (!actor || actor.status !== 'active') {
          throw new WorkspaceMemoryServiceError(
            'not_found',
            'Workspace memory not found',
          );
        }
        // Folder IPC is shared by Web and bound IM sessions. Resolve the
        // canonical registered Web workspace; never trust a model-supplied JID.
        const siblingJids = getJidsByFolder(sourceGroup);
        const workspaceJid =
          siblingJids.find((jid) => jid.startsWith('web:')) ?? siblingJids[0];
        if (!workspaceJid) {
          throw new WorkspaceMemoryServiceError(
            'not_found',
            'Workspace memory not found',
          );
        }
        const base = {
          actor: { id: actor.id, role: actor.role },
          workspaceJid,
        };
        const hostTurnKind = ipcTaskId
          ? ('scheduled' as const)
          : activeAgentBuilderTurns.classifyActiveTurn(
              agentBuilderTurnScope(sourceGroup, ipcAgentId),
              data.inputTurnId,
              getAgentBuilderInputMessage,
            );
        const runtimeAgentKind = ipcAgentId
          ? (getAgent(ipcAgentId)?.kind ?? null)
          : null;
        const sourceType =
          hostTurnKind === 'scheduled'
            ? ('scheduled_task' as const)
            : ('agent_runtime' as const);
        const mutation = {
          sourceType,
          provenance: {
            // Correlation fields are non-authoritative provenance only. Actor,
            // workspace, and source type are host-derived above.
            sourceId: data.inputTurnId ?? null,
            sessionId: data.sessionId ?? null,
            observedAt: new Date().toISOString(),
          },
        };
        const mutationOperation =
          data.operation === 'create' ||
          data.operation === 'update' ||
          data.operation === 'delete';
        const capabilityValid =
          mutationOperation &&
          (!ipcAgentId || runtimeAgentKind === 'conversation') &&
          hostTurnKind === 'interactive' &&
          verifyAndConsumeWorkspaceMemoryMutation(
            {
              groupFolder: sourceGroup,
              agentId: ipcAgentId,
              taskRunId: ipcTaskId,
            },
            data as Record<string, unknown>,
            data.mutationSignature,
          );
        const writeRejection = workspaceMemoryWriteRejection({
          operation: data.operation,
          hostTurnKind,
          runtimeAgentId: ipcAgentId,
          runtimeAgentKind,
          capabilityValid,
        });
        if (writeRejection) {
          finish({
            success: false,
            ...writeRejection,
          });
          break;
        }

        let result: Record<string, unknown>;
        switch (data.operation) {
          case 'snapshot': {
            const snapshot = getWorkspaceMemorySnapshot({
              ...base,
              query: data.query,
              kind: data.kind as
                | 'fact'
                | 'decision'
                | 'lesson'
                | 'open_loop'
                | undefined,
              limit: data.limit,
              maxChars: data.maxChars,
            });
            result = { snapshot };
            logger.info(
              {
                sourceGroup,
                workspaceJid,
                storeRevision: snapshot.storeRevision,
                retrievalTrace: snapshot.retrievalTrace,
              },
              'Workspace Memory snapshot retrieved for runtime turn',
            );
            break;
          }
          case 'search':
            result = searchWorkspaceMemory({
              ...base,
              query: data.query ?? '',
              kind: data.kind as
                | 'fact'
                | 'decision'
                | 'lesson'
                | 'open_loop'
                | undefined,
              limit: data.limit,
            });
            break;
          case 'get':
            result = getWorkspaceMemory({
              ...base,
              itemId: data.itemId ?? '',
            });
            break;
          case 'create':
            result = createWorkspaceMemory({
              ...base,
              ...mutation,
              kind: data.kind as 'fact' | 'decision' | 'lesson' | 'open_loop',
              title: data.title,
              content: data.content ?? '',
              canonicalKey: data.canonicalKey,
              importance: data.importance,
              confidence: data.confidence,
              validFrom: data.validFrom,
              validUntil: data.validUntil,
              expiresAt: data.expiresAt,
              idempotencyKey: data.idempotencyKey,
            });
            break;
          case 'update': {
            result = updateWorkspaceMemory(
              buildWorkspaceMemoryUpdateInput(data, {
                ...base,
                ...mutation,
              }) as unknown as Parameters<typeof updateWorkspaceMemory>[0],
            );
            break;
          }
          case 'delete':
            result = forgetWorkspaceMemory({
              ...base,
              ...mutation,
              itemId: data.itemId ?? '',
              expectedRevision: data.expectedRevision ?? 0,
              idempotencyKey: data.idempotencyKey,
            });
            break;
          default:
            throw new WorkspaceMemoryServiceError(
              'invalid_request',
              'Unknown Workspace Memory operation',
            );
        }
        finish({ success: true, ...result });
      } catch (error) {
        const code =
          error instanceof WorkspaceMemoryServiceError
            ? error.code
            : 'internal_error';
        finish({
          success: false,
          code,
          error:
            error instanceof WorkspaceMemoryServiceError
              ? error.message
              : 'Internal error while processing Workspace Memory request.',
          ...(error instanceof WorkspaceMemoryServiceError && error.details
            ? { details: error.details }
            : {}),
        });
        logger.warn(
          {
            sourceGroup,
            operation: data.operation,
            code,
            error: error instanceof Error ? error.message : String(error),
          },
          'Workspace Memory IPC request failed',
        );
      }
      break;
    }

    case 'agent_profile_list': {
      try {
        const actor = requireAgentBuilderActor();
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...listAgentProfilesForBuilder(actor.user.id),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_get': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.profileId) throw new Error('profileId is required');
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...getAgentProfileForBuilder(actor.user.id, data.profileId),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_draft_get': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.draftId) throw new Error('draftId is required');
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          draft: getAgentBuilderDraftForBuilder(actor.user.id, data.draftId),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_capability_catalog': {
      try {
        const actor = requireAgentBuilderActor();
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          catalog: getAgentCapabilityCatalogForBuilder(actor),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_prepare': {
      try {
        const actor = requireAgentBuilderActor();
        const result = prepareAgentBuilderDraft(actor, {
          draftId: data.draftId,
          expectedDraftRevision: data.expectedDraftRevision,
          targetAgentProfileId: data.targetAgentProfileId,
          expectedAgentVersion: data.expectedAgentVersion,
          definition: data.definition,
          assumptions: data.assumptions,
        });
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...result,
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_publish': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.draftId || data.expectedDraftRevision === undefined) {
          throw new Error('draftId and expectedDraftRevision are required');
        }
        const result = await publishAgentBuilderDraft(
          actor,
          data.draftId,
          data.expectedDraftRevision,
        );
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...result,
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_discard': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.draftId || data.expectedDraftRevision === undefined) {
          throw new Error('draftId and expectedDraftRevision are required');
        }
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          draft: discardPreparedAgentDraft(
            actor.user.id,
            data.draftId,
            data.expectedDraftRevision,
          ),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'schedule_task': {
      const failSchedule = (error: string): void => {
        logger.warn({ sourceGroup, error }, 'schedule_task rejected');
        writeTaskResult(tasksDir, 'schedule_task', data.requestId, {
          success: false,
          error,
        });
      };
      if (data.schedule_type && data.schedule_value && data.targetJid) {
        const execType =
          data.execution_type === 'script'
            ? ('script' as const)
            : ('agent' as const);

        // Script tasks require prompt OR script_command; agent tasks require prompt
        if (execType === 'agent' && !data.prompt) {
          failSchedule('Agent mode requires a prompt.');
          break;
        }
        if (execType === 'script' && !data.script_command) {
          failSchedule('Script mode requires script_command.');
          break;
        }

        // Same bound the REST surface enforces. This is the path the cap was
        // written for: an Agent exposed to untrusted content can otherwise
        // write an unbounded prompt into scheduled_tasks, where it is stored
        // and replayed on every tick.
        if (
          typeof data.prompt === 'string' &&
          data.prompt.length > MAX_TASK_PROMPT_LENGTH
        ) {
          failSchedule(
            `prompt exceeds the maximum length of ${MAX_TASK_PROMPT_LENGTH} characters.`,
          );
          break;
        }
        if (
          typeof data.script_command === 'string' &&
          data.script_command.length > MAX_TASK_SCRIPT_COMMAND_LENGTH
        ) {
          failSchedule(
            `script_command exceeds the maximum length of ${MAX_TASK_SCRIPT_COMMAND_LENGTH} characters.`,
          );
          break;
        }

        // Only admin home can create script tasks
        if (execType === 'script' && !isAdminHome) {
          failSchedule(
            'Only the admin home container can create script tasks.',
          );
          break;
        }

        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          failSchedule(`Target group is not registered: ${targetJid}`);
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: own workspace, or a group this workspace's owner also
        // owns. Admin home gets no global bypass here — see
        // ipcActorCanAccessGroupJid.
        if (!ipcActorCanAccessGroupJid(targetJid)) {
          failSchedule('Not authorized to schedule tasks for another group.');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string;
        try {
          nextRun = computeNextRunForSchedule(
            scheduleType,
            data.schedule_value,
          );
        } catch (err) {
          failSchedule(err instanceof Error ? err.message : 'Invalid schedule');
          break;
        }

        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';

        // Resolve the effective execution mode before compatibility deduplication.
        // The requested mode is part of task identity: otherwise an identical
        // prompt could silently reuse a task running across a different security
        // boundary (host vs container).
        let executionMode: 'host' | 'container';
        try {
          executionMode = resolveTaskExecutionModeForTarget(
            targetGroupEntry.executionMode,
            data.execution_mode === 'host' ||
              data.execution_mode === 'container'
              ? data.execution_mode
              : undefined,
          );
        } catch (err) {
          failSchedule(err instanceof Error ? err.message : String(err));
          break;
        }
        if (execType === 'script' && executionMode !== 'host') {
          failSchedule(SCRIPT_TASK_HOST_REQUIRED_ERROR);
          break;
        }
        const taskCreatedBy = resolveTaskOwner(
          {},
          sourceGroupEntry,
          targetGroupEntry,
        );

        // 幂等去重：仅对 agent 任务生效。#564 的递归增殖只发生在 agent 触发回放路径；
        // 而 script 任务真正承载工作的是 script_command（prompt 常为空），prompt/schedule
        // 相同但命令不同的多个 script 任务是合法的，按 prompt 去重会静默丢任务。agent
        // 任务则比较全部执行定义；目标会话、最终执行环境或路由配置不同都不是重复任务。
        const dupExisting = findDuplicateActiveAgentTask(getAllTasks(), {
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          execution_mode: executionMode,
          script_command: data.script_command ?? null,
          created_by: taskCreatedBy,
          notify_channels: null,
        });
        if (dupExisting) {
          logger.info(
            { sourceGroup, taskId: dupExisting.id },
            'schedule_task: identical active agent task already exists, returning existing',
          );
          writeTaskResult(tasksDir, 'schedule_task', data.requestId, {
            success: true,
            taskId: dupExisting.id,
            nextRun: dupExisting.next_run,
            duplicate: true,
          });
          break;
        }

        const taskId = crypto.randomUUID();

        // Capture the concrete route this task was scheduled from, so a task
        // created inside a Feishu topic delivers back into that topic. The
        // session owner JID carries the thread/root and account fragments;
        // `targetJid` is only conversation-level. Cross-workspace scheduling has
        // no such context, so it binds to the target conversation itself.
        const scheduleDeliveryRouteJid =
          targetFolder === sourceGroup
            ? (getSessionChannelOwner(sourceGroup, ipcAgentId ?? null) ??
              targetJid)
            : targetJid;

        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          delivery_route_jid: scheduleDeliveryRouteJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          execution_mode: executionMode,
          script_command: data.script_command ?? null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          created_by: taskCreatedBy,
          notify_channels: null,
        });
        notifyTaskSchedulerChanged();
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, execType },
          'Task created via IPC',
        );
        writeTaskResult(tasksDir, 'schedule_task', data.requestId, {
          success: true,
          taskId,
          nextRun,
        });
      } else {
        failSchedule('Missing schedule_type, schedule_value, or target group.');
      }
      break;
    }

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && ipcActorCanManageTask(task)) {
          if (!Number.isInteger(data.expectedRevision)) {
            writeTaskResult(tasksDir, 'pause_task', data.requestId, {
              success: false,
              error: 'expected_revision is required. Call list_tasks first.',
            });
            break;
          }
          const mutation = updateTaskWithRevision(
            data.taskId,
            data.expectedRevision!,
            { status: 'paused' },
          );
          if (mutation.status === 'conflict') {
            writeTaskResult(tasksDir, 'pause_task', data.requestId, {
              success: false,
              code: 'TASK_REVISION_CONFLICT',
              error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
              task: mutation.task,
            });
            break;
          }
          if (mutation.status === 'not_found') {
            writeTaskResult(tasksDir, 'pause_task', data.requestId, {
              success: false,
              error: 'Task not found.',
            });
            break;
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          notifyTaskSchedulerChanged();
          writeTaskResult(tasksDir, 'pause_task', data.requestId, {
            success: true,
            taskId: data.taskId,
            revision: mutation.task.revision,
          });
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
          writeTaskResult(tasksDir, 'pause_task', data.requestId, {
            success: false,
            error: task
              ? 'Not authorized to pause this task.'
              : 'Task not found.',
          });
        }
      } else {
        writeTaskResult(tasksDir, 'pause_task', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && ipcActorCanManageTask(task)) {
          if (task.status === 'parsing') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error: 'Task is still being parsed.',
            });
            break;
          }
          if (task.execution_type === 'script') {
            if (!isAdminHome) {
              writeTaskResult(tasksDir, 'resume_task', data.requestId, {
                success: false,
                error: 'Only the admin home container can resume script tasks.',
              });
              break;
            }
            const policyError = getScriptTaskHostExecutionError(
              task,
              registeredGroups,
            );
            if (policyError) {
              writeTaskResult(tasksDir, 'resume_task', data.requestId, {
                success: false,
                error: policyError,
              });
              break;
            }
          }
          if (task.status === 'completed' && task.schedule_type === 'once') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error:
                'Completed one-shot tasks cannot be resumed. Create a new task or update its schedule.',
            });
            break;
          }
          const patch: Parameters<typeof updateTask>[1] = { status: 'active' };
          if (task.schedule_type === 'once' || task.next_run == null) {
            try {
              patch.next_run = computeNextRunForTaskResume(
                task.schedule_type,
                task.schedule_value,
              );
            } catch (err) {
              writeTaskResult(tasksDir, 'resume_task', data.requestId, {
                success: false,
                error: `Invalid schedule: ${err instanceof Error ? err.message : String(err)}`,
              });
              break;
            }
          }
          if (!Number.isInteger(data.expectedRevision)) {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error: 'expected_revision is required. Call list_tasks first.',
            });
            break;
          }
          const mutation = updateTaskWithRevision(
            data.taskId,
            data.expectedRevision!,
            patch,
          );
          if (mutation.status === 'conflict') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              code: 'TASK_REVISION_CONFLICT',
              error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
              task: mutation.task,
            });
            break;
          }
          if (mutation.status === 'not_found') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error: 'Task not found.',
            });
            break;
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          notifyTaskSchedulerChanged();
          writeTaskResult(tasksDir, 'resume_task', data.requestId, {
            success: true,
            taskId: data.taskId,
            revision: mutation.task.revision,
          });
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
          writeTaskResult(tasksDir, 'resume_task', data.requestId, {
            success: false,
            error: task
              ? 'Not authorized to resume this task.'
              : 'Task not found.',
          });
        }
      } else {
        writeTaskResult(tasksDir, 'resume_task', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && ipcActorCanManageTask(task)) {
          if (task.execution_type === 'script' && !isAdminHome) {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error: 'Only the admin home container can delete script tasks.',
            });
            break;
          }
          if (
            !getActiveTaskRunForTask(data.taskId) &&
            getRunningTaskIds().includes(data.taskId)
          ) {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error:
                'Task is running. Wait for it to finish before cancelling.',
            });
            break;
          }
          if (!Number.isInteger(data.expectedRevision)) {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error: 'expected_revision is required. Call list_tasks first.',
            });
            break;
          }
          const mutation = softDeleteTaskWithRevision(
            data.taskId,
            data.expectedRevision!,
          );
          if (mutation.status === 'conflict') {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              code: 'TASK_REVISION_CONFLICT',
              error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
              task: mutation.task,
            });
            break;
          }
          if (mutation.status === 'active_run') {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              code: 'TASK_HAS_ACTIVE_RUN',
              error: 'Task is running. Stop the current run before deleting.',
              runId: mutation.run.id,
            });
            break;
          }
          if (mutation.status === 'not_found') {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error: 'Task not found.',
            });
            break;
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          notifyTaskSchedulerChanged();
          writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
            success: true,
            taskId: data.taskId,
            revision: mutation.task.revision,
          });
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
          writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
            success: false,
            error: task
              ? 'Not authorized to cancel this task.'
              : 'Task not found.',
          });
        }
      } else {
        writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
      }
      break;

    case 'update_task': {
      const failUpdate = (error: string): void => {
        logger.warn(
          { sourceGroup, taskId: data.taskId, error },
          'update_task rejected',
        );
        writeTaskResult(tasksDir, 'update_task', data.requestId, {
          success: false,
          error,
        });
      };
      if (!data.taskId) {
        failUpdate('Missing task_id.');
        break;
      }
      if (!Number.isInteger(data.expectedRevision)) {
        failUpdate('expected_revision is required. Call list_tasks first.');
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task) {
        failUpdate('Task not found.');
        break;
      }
      // 授权：本组，或本工作区属主同样拥有的组。与 pause/cancel 同款，
      // 走 REST 面同一套 canAccessGroup，admin home 不再是全局旁路。
      if (!ipcActorCanManageTask(task)) {
        failUpdate('Not authorized to update this task.');
        break;
      }
      const patch: Parameters<typeof updateTask>[1] = {};
      if (data.execution_type !== undefined) {
        if (data.execution_type === 'script' && !isAdminHome) {
          failUpdate('Only the admin home container can set script execution.');
          break;
        }
        patch.execution_type =
          data.execution_type === 'script' ? 'script' : 'agent';
      }
      if (data.execution_mode !== undefined) {
        if (data.execution_mode === 'host' && !isAdminHome) {
          failUpdate(
            'Only the admin home container can set host execution mode.',
          );
          break;
        }
        patch.execution_mode =
          data.execution_mode === 'host' ? 'host' : 'container';
      }
      // An update must not be a way around the create-time bound.
      if (
        typeof data.prompt === 'string' &&
        data.prompt.length > MAX_TASK_PROMPT_LENGTH
      ) {
        failUpdate(
          `prompt exceeds the maximum length of ${MAX_TASK_PROMPT_LENGTH} characters.`,
        );
        break;
      }
      if (
        typeof data.script_command === 'string' &&
        data.script_command.length > MAX_TASK_SCRIPT_COMMAND_LENGTH
      ) {
        failUpdate(
          `script_command exceeds the maximum length of ${MAX_TASK_SCRIPT_COMMAND_LENGTH} characters.`,
        );
        break;
      }
      if (data.prompt !== undefined) patch.prompt = data.prompt;
      if (data.script_command !== undefined)
        patch.script_command = data.script_command;
      if (data.context_mode !== undefined) {
        patch.context_mode =
          data.context_mode === 'group' ? 'group' : 'isolated';
      }
      // schedule 变更 → 用 now 锚点重算 next_run
      let updatedNextRun = task.next_run;
      if (
        data.schedule_type !== undefined ||
        data.schedule_value !== undefined
      ) {
        const newType = (data.schedule_type ?? task.schedule_type) as
          | 'cron'
          | 'interval'
          | 'once';
        const newValue = data.schedule_value ?? task.schedule_value;
        try {
          updatedNextRun = computeNextRunForSchedule(newType, newValue);
        } catch (err) {
          failUpdate(
            `Invalid schedule: ${err instanceof Error ? err.message : String(err)}`,
          );
          break;
        }
        patch.schedule_type = newType;
        patch.schedule_value = newValue;
        patch.next_run = updatedNextRun;
        // 改了 schedule 的已完成 once 任务，复活为 active
        if (task.status === 'completed') patch.status = 'active';
      }
      // 与 schedule_task 一致：最终为 script 执行的任务必须有 script_command，
      // 否则每次触发都会在 script 空命令分支静默失败，而 agent 收到的却是 success。
      const finalExecType = patch.execution_type ?? task.execution_type;
      const finalExecutionMode = patch.execution_mode ?? task.execution_mode;
      if (finalExecType === 'script') {
        const finalScript = patch.script_command ?? task.script_command;
        if (!finalScript || !finalScript.trim()) {
          failUpdate('Script execution requires a non-empty script_command.');
          break;
        }
        if (finalExecutionMode !== 'host') {
          failUpdate(SCRIPT_TASK_HOST_REQUIRED_ERROR);
          break;
        }
      } else {
        const finalPrompt = patch.prompt ?? task.prompt;
        if (!finalPrompt.trim()) {
          failUpdate('Agent execution requires a non-empty prompt.');
          break;
        }
      }
      if (finalExecutionMode === 'host') {
        const targetGroup =
          registeredGroups[task.chat_jid] ?? getRegisteredGroup(task.chat_jid);
        if (!targetGroup || targetGroup.executionMode !== 'host') {
          failUpdate(
            'Target workspace runs in container mode; host execution is not allowed.',
          );
          break;
        }
      }
      const mutation = updateTaskWithRevision(
        data.taskId,
        data.expectedRevision!,
        patch,
      );
      if (mutation.status === 'conflict') {
        writeTaskResult(tasksDir, 'update_task', data.requestId, {
          success: false,
          code: 'TASK_REVISION_CONFLICT',
          error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
          task: mutation.task,
        });
        break;
      }
      if (mutation.status === 'not_found') {
        failUpdate('Task not found.');
        break;
      }
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task updated via IPC');
      notifyTaskSchedulerChanged();
      writeTaskResult(tasksDir, 'update_task', data.requestId, {
        success: true,
        taskId: data.taskId,
        nextRun: updatedNextRun,
        revision: mutation.task.revision,
      });
      break;
    }

    case 'run_task_now': {
      if (!data.taskId) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || task.deleted_at) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Task not found.',
        });
        break;
      }
      if (!ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Not authorized to run this task.',
        });
        break;
      }
      if (task.execution_type === 'script' && !isAdminHome) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Only the admin home container can run script tasks.',
        });
        break;
      }
      const runPolicyError = getScriptTaskHostExecutionError(
        task,
        registeredGroups,
      );
      if (runPolicyError) {
        updateTaskWithRevision(task.id, task.revision, {
          status: 'paused',
          next_run: null,
        });
        notifyTaskSchedulerChanged();
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: runPolicyError,
        });
        break;
      }
      const trigger = getWebDeps()?.triggerTaskRun;
      if (!trigger) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Scheduler not available.',
        });
        break;
      }
      const result = trigger(
        data.taskId,
        data.idempotencyKey ?? data.requestId,
      );
      writeTaskResult(tasksDir, 'run_task_now', data.requestId, result);
      break;
    }

    case 'stop_task_run': {
      if (!data.runId) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Missing run_id.',
        });
        break;
      }
      const run = getTaskRunById(data.runId);
      const task = run ? getTaskById(run.task_id) : undefined;
      if (!run || !task) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Task run not found.',
        });
        break;
      }
      if (!ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Not authorized to stop this run.',
        });
        break;
      }
      if (task.execution_type === 'script' && !isAdminHome) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Only the admin home container can stop script task runs.',
        });
        break;
      }
      const cancel = getWebDeps()?.cancelTaskRun;
      if (!cancel) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Run cancellation is not available.',
        });
        break;
      }
      writeTaskResult(
        tasksDir,
        'stop_task_run',
        data.requestId,
        cancel(data.runId),
      );
      break;
    }

    case 'restore_task': {
      if (!data.taskId || !Number.isInteger(data.expectedRevision)) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'task_id and expected_revision are required.',
        });
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || !task.deleted_at) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Deleted task not found.',
        });
        break;
      }
      if (!ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Not authorized to restore this task.',
        });
        break;
      }
      if (task.execution_type === 'script' && !isAdminHome) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Only the admin home container can restore script tasks.',
        });
        break;
      }
      const restorePolicyError = getScriptTaskHostExecutionError(
        task,
        registeredGroups,
      );
      if (restorePolicyError) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: restorePolicyError,
        });
        break;
      }
      const mutation = restoreTaskWithRevision(task.id, data.expectedRevision!);
      if (mutation.status === 'conflict') {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          code: 'TASK_REVISION_CONFLICT',
          error: `Task changed; current revision is ${mutation.task.revision}.`,
          task: mutation.task,
        });
      } else if (mutation.status === 'updated') {
        notifyTaskSchedulerChanged();
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: true,
          taskId: task.id,
          revision: mutation.task.revision,
        });
      } else {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Deleted task not found.',
        });
      }
      break;
    }

    case 'list_task_runs': {
      if (!data.taskId) {
        writeTaskResult(tasksDir, 'list_task_runs', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || !ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'list_task_runs', data.requestId, {
          success: false,
          error: 'Task not found or not authorized.',
        });
        break;
      }
      const limit = Math.min(Math.max(data.limit ?? 20, 1), 50);
      writeTaskResult(tasksDir, 'list_task_runs', data.requestId, {
        success: true,
        runs: getMergedTaskRunHistory(task.id, limit),
      });
      break;
    }

    case 'list_tasks':
      if (data.requestId) {
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected list_tasks request with invalid requestId',
          );
          break;
        }
        // 用请求所在的 tasksDir（可能是会话子 agent / isolated 任务的嵌套 root），
        // 而非按 sourceGroup 重算主 root，否则嵌套场景回执读不到。
        const listTasksDir = tasksDir;
        const listTasksDirResolved = path.resolve(listTasksDir);
        const resultFileName = `list_tasks_result_${requestId}.json`;
        const resultFilePath = path.resolve(listTasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${listTasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected list_tasks request with unsafe result file path',
          );
          break;
        }

        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        try {
          const allTasks = data.includeDeleted
            ? [...getAllTasks(), ...getDeletedTasks()]
            : getAllTasks();
          // Visibility follows the same ACL as mutation: own workspace plus
          // groups this workspace's owner also owns. A task's `prompt` is user
          // content, so admin home must not enumerate other tenants' rows.
          const filteredTasks = allTasks.filter((t) =>
            ipcActorCanManageTask(t),
          );
          const taskList = filteredTasks.map((t) => ({
            id: t.id,
            groupFolder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
            revision: t.revision,
            deleted_at: t.deleted_at,
            current_run: getActiveTaskRunForTask(t.id) ?? null,
          }));
          const resultData = JSON.stringify({ success: true, tasks: taskList });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.writeFileSync(tmpPath, resultData);
          fs.renameSync(tmpPath, resultFilePath);
          logger.debug(
            { sourceGroup, taskCount: taskList.length },
            'Task list sent via IPC',
          );
        } catch (err) {
          const errorResult = JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          logger.error({ sourceGroup, err }, 'Failed to list tasks via IPC');
        }
      }
      break;

    case 'discord_get_history':
    case 'discord_get_channel_info':
    case 'discord_get_server_info':
      await handleDiscordIpcRequest(
        data,
        sourceGroup,
        sourceGroupEntry,
        isAdminHome,
      );
      break;

    case 'feishu_capability': {
      const startedAt = Date.now();
      try {
        if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
          throw new Error('Invalid Feishu capability requestId');
        }
        if (!data.inputTurnId) {
          throw new Error('Feishu capability inputTurnId is required');
        }
        const allowedOperations = new Set<FeishuCapabilityOperation>([
          'get_chat',
          'list_members',
          'get_user',
          'get_history',
          'send_card',
          'add_reaction',
          'remove_reaction',
          'edit_message',
          'recall_message',
          'api_request',
        ]);
        if (
          !data.operation ||
          !allowedOperations.has(data.operation as FeishuCapabilityOperation)
        ) {
          throw new Error('Unknown Feishu capability operation');
        }
        const scope = channelTurnScope(sourceGroup, ipcAgentId);
        const activeTurn = activeChannelTurns.require(scope, data.inputTurnId);
        const request: FeishuCapabilityRequest = {
          operation: data.operation as FeishuCapabilityOperation,
          params: data.params,
        };
        // Runaway-loop fuse, sharing send_message's budget. `send_card` is the
        // only capability that emits new user-visible content, and it is the
        // only one recorded against the turn — so it is the only one gated.
        // Reactions, edits and recalls act on existing messages.
        if (
          request.operation === 'send_card' &&
          !canDeliverTurnUtterance(sourceGroup, ipcAgentId, data.inputTurnId)
        ) {
          logger.warn(
            {
              sourceGroup,
              agentId: ipcAgentId,
              inputTurnId: data.inputTurnId,
            },
            'Suppressed IPC feishu send_card: per-turn reply limit reached',
          );
          throw new Error(REPLY_LIMIT_REACHED_ERROR);
        }
        let result;
        if (isFeishuCapabilityMutation(request)) {
          const outboxScope = activeChannelOutboxScopes.resolveInput(
            scope,
            data.inputTurnId,
            activeTurn.sourceJid,
          );
          if (!outboxScope) {
            throw new Error(
              'Exact durable scope for this Feishu mutation is unavailable; operation suppressed.',
            );
          }
          const mutation = await deliverFeishuCapabilityMutation({
            ...outboxScope,
            requestId: data.requestId,
            request,
            owner: `happyclaw-feishu-capability:${process.pid}:${outboxScope.turnRunId}`,
            execute: () =>
              imManager.executeFeishuCapability(
                activeTurn.sourceJid,
                activeTurn.context,
                request,
              ),
          });
          if (mutation.delivery.status !== 'delivered') {
            throw new Error(
              mutation.delivery.status === 'uncertain'
                ? 'Feishu mutation delivery is uncertain; do not retry automatically. An operator must confirm the provider result.'
                : mutation.delivery.error ||
                    `Feishu mutation did not complete (${mutation.delivery.status}).`,
            );
          }
          result =
            mutation.result ??
            ({
              operation: request.operation,
              data: {
                deliveryStatus: 'already_delivered',
                providerReceipt:
                  mutation.delivery.receipt?.providerMessageId ?? null,
              },
            } satisfies Awaited<
              ReturnType<typeof imManager.executeFeishuCapability>
            >);
        } else {
          result = await imManager.executeFeishuCapability(
            activeTurn.sourceJid,
            activeTurn.context,
            request,
          );
        }
        // `send_card` is the only capability that emits new user-visible
        // content, so it is the only one that counts as speech for turn
        // settlement. Reactions, edits and recalls act on existing messages.
        if (
          request.operation === 'send_card' &&
          typeof data.inputTurnId === 'string' &&
          data.inputTurnId
        ) {
          activeTurnOutputs.recordDeliveredUtterance({
            scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
            inputTurnId: data.inputTurnId,
          });
        }
        writeTaskResult(tasksDir, 'feishu_capability', data.requestId, {
          success: true,
          ...result,
        });
        logger.info(
          {
            sourceGroup,
            agentId: ipcAgentId,
            operation: request.operation,
            channelAccountId: activeTurn.context.channelAccountId,
            chatId: activeTurn.context.chat.id,
            inputTurnId: data.inputTurnId,
            durationMs: Date.now() - startedAt,
          },
          'Feishu capability executed through bound Bot',
        );
      } catch (error) {
        writeTaskResult(tasksDir, 'feishu_capability', data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn(
          {
            sourceGroup,
            agentId: ipcAgentId,
            operation: data.operation,
            inputTurnId: data.inputTurnId,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          'Feishu capability request rejected or failed',
        );
      }
      break;
    }

    case 'refresh_groups':
      // Only admin home group can request a refresh
      if (isAdminHome) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only admin home group can register new groups
      if (!isAdminHome) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder) {
        // Inherit created_by from the source group so onNewChat won't re-route
        const sourceEntry = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const execMode =
          data.executionMode === 'host' || data.executionMode === 'container'
            ? data.executionMode
            : undefined;
        try {
          registerGroup(data.jid, {
            name: data.name,
            folder: data.folder,
            added_at: new Date().toISOString(),
            containerConfig: data.containerConfig,
            created_by: sourceEntry?.created_by,
            executionMode: execMode,
          });
        } catch (err) {
          // registerGroup 校验 folder 名时会抛错。IPC 来源不可信（agent 进程
          // 可能被 prompt 注入），不要把异常冒泡到主消息循环。
          logger.warn(
            { jid: data.jid, folder: data.folder, err },
            'register_group rejected by validation',
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'install_skill':
      if (data.package && data.requestId) {
        const pkg = data.package;
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected install_skill request with invalid requestId',
          );
          break;
        }
        const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const tasksDirResolved = path.resolve(tasksDir);
        const resultFileName = `install_skill_result_${requestId}.json`;
        const resultFilePath = path.resolve(tasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected install_skill request with unsafe result file path',
          );
          break;
        }

        // Find the user who owns this group
        const sourceGroupForSkill = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const userId = sourceGroupForSkill?.created_by;

        if (!userId) {
          logger.warn(
            { sourceGroup },
            'Cannot install skill: no user associated with group',
          );
          const errorResult = JSON.stringify({
            success: false,
            error: 'No user associated with this group',
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          break;
        }

        try {
          const result = await installSkillForUser(userId, pkg);
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, JSON.stringify(result));
          fs.renameSync(tmpPath, resultFilePath);
          logger.info(
            { sourceGroup, userId, pkg, success: result.success },
            'Skill installation via IPC completed',
          );
        } catch (err) {
          const errorResult = JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          logger.error(
            { sourceGroup, userId, pkg, err },
            'Skill installation via IPC failed',
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid install_skill request - missing required fields',
        );
      }
      break;

    case 'uninstall_skill':
      if (data.skillId && data.requestId) {
        const skillId = data.skillId;
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected uninstall_skill request with invalid requestId',
          );
          break;
        }
        const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const tasksDirResolved = path.resolve(tasksDir);
        const resultFileName = `uninstall_skill_result_${requestId}.json`;
        const resultFilePath = path.resolve(tasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected uninstall_skill request with unsafe result file path',
          );
          break;
        }

        const sourceGroupForUninstall = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const userId = sourceGroupForUninstall?.created_by;

        if (!userId) {
          logger.warn(
            { sourceGroup },
            'Cannot uninstall skill: no user associated with group',
          );
          const errorResult = JSON.stringify({
            success: false,
            error: 'No user associated with this group',
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          break;
        }

        const result = await deleteSkillForUser(userId, skillId);
        const tmpPath = `${resultFilePath}.tmp`;
        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(result));
        fs.renameSync(tmpPath, resultFilePath);
        logger.info(
          { sourceGroup, userId, skillId, success: result.success },
          'Skill uninstall via IPC completed',
        );
      } else {
        logger.warn(
          { data },
          'Invalid uninstall_skill request - missing required fields',
        );
      }
      break;

    case 'send_file':
      const finishSendFile = (success: boolean, error?: string): void => {
        writeTaskResult(tasksDir, 'send_file', data.requestId, {
          success,
          ...(error ? { error } : {}),
        });
      };
      logger.debug(
        { data, sourceGroup, isAdminHome, isHome },
        'processTaskIpc send_file reached',
      );
      if (data.chatJid && data.filePath && data.fileName) {
        if (
          durableTaskRunId &&
          !taskRunAcceptsLateIpcOutput(durableTaskRunId)
        ) {
          finishSendFile(false, 'Task run was cancelled before file delivery.');
          break;
        }
        // Cross-group authorization check (same as send_message)
        const targetGroup = getIpcDeliveryTargetGroup(data.chatJid);
        if (
          !canSendCrossGroupMessage(
            isAdminHome,
            isHome,
            sourceGroup,
            sourceGroupEntry,
            targetGroup,
          )
        ) {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC send_file attempt blocked',
          );
          finishSendFile(false, 'Unauthorized file delivery target.');
          break;
        }

        try {
          // Resolve to workspace path - IPC sends relative paths from workspace/group
          const fullPath = path.join(GROUPS_DIR, sourceGroup, data.filePath);

          // Path traversal protection: ensure resolved path stays within workspace
          let resolvedPath = path.resolve(fullPath);
          const safeRoot = path.resolve(GROUPS_DIR, sourceGroup) + path.sep;
          if (!resolvedPath.startsWith(safeRoot)) {
            logger.warn(
              { sourceGroup, filePath: data.filePath, resolvedPath },
              'Path traversal attempt blocked in send_file IPC',
            );
            finishSendFile(false, 'Invalid file path.');
            break;
          }

          if (!fs.existsSync(resolvedPath)) {
            // Fallback: search in downloads subdirs (DingTalk/Telegram files land here)
            const downloadsDir = path.join(
              GROUPS_DIR,
              sourceGroup,
              'downloads',
            );
            const fileName = data.fileName || path.basename(data.filePath);
            const foundPath = fs.existsSync(downloadsDir)
              ? findFileInSubdirs(downloadsDir, fileName)
              : null;
            if (foundPath) {
              logger.info(
                { originalPath: resolvedPath, foundPath },
                'send_file: fell back to downloads subdirectory',
              );
              resolvedPath = foundPath;
            } else {
              const warnMsg = `⚠️ 文件 "${data.fileName}" 未找到（路径 "${data.filePath}" 不存在）。请引导用户确认正确的文件路径，或使用 'send_file' 时提供正确的相对路径。`;
              broadcastToWebClients(sourceGroup, warnMsg);
              // Also notify via DingTalk for conversation agents bound to IM
              const imRoute = resolveImRoute({
                ipcAgentId,
                isHome,
                chatJid: data.chatJid,
                sourceGroup,
              });
              if (imRoute) {
                try {
                  const ref = channelOutboxRefForInput(
                    channelTurnScope(sourceGroup, ipcAgentId),
                    imRoute,
                    data.inputTurnId,
                    `ipc-file-not-found:${data.requestId ?? data.filePath}`,
                  );
                  if (ref) {
                    await sendImWithRetry(imRoute, warnMsg, [], ref);
                  } else if (ipcTaskId || data.isScheduledTask) {
                    // Scheduled tasks use a separate durable receipt ledger;
                    // retain the legacy notification until that branch records
                    // its task-scoped failure below.
                    await imManager.sendMessage(imRoute, warnMsg);
                  } else {
                    logger.error(
                      { sourceGroup, agentId: ipcAgentId, imRoute },
                      'Suppressed file-not-found warning without exact channel Turn scope',
                    );
                  }
                } catch {
                  // ignore
                }
              }
              logger.warn(
                { filePath: data.filePath, resolvedPath },
                'send_file: file not found',
              );
              finishSendFile(false, 'File not found.');
              break;
            }
          }

          const fileRoutingDecision = ipcAgentId
            ? { mode: 'none' as const }
            : resolveTaskRoutingDecision(
                data,
                ipcTaskId,
                !!sourceGroupEntry?.created_by,
                { getTaskById, getChannelType },
              );
          const regularFileImRoute =
            fileRoutingDecision.mode === 'none'
              ? resolveImRoute({
                  ipcAgentId,
                  isHome,
                  chatJid: data.chatJid,
                  sourceGroup,
                })
              : null;
          if (regularFileImRoute || fileRoutingDecision.mode !== 'none') {
            // Symlink-escape protection: the lexical startsWith check above does
            // not stop a symlink (inside the workspace) pointing at host/other-user
            // files. Re-verify the final path (original OR downloads fallback)
            // resolves inside the workspace before reading it for delivery.
            const sendRoot = path.resolve(GROUPS_DIR, sourceGroup);
            if (!isRealpathInside(resolvedPath, sendRoot)) {
              logger.warn(
                { sourceGroup, filePath: data.filePath, resolvedPath },
                'Symlink traversal attempt blocked in send_file IPC',
              );
              finishSendFile(false, 'Invalid file path.');
              break;
            }
            const imFileName = data.fileName || path.basename(resolvedPath);
            if (fileRoutingDecision.mode === 'direct') {
              const targetJid = fileRoutingDecision.taskChatJid;
              const delivery = await settleAndRecordTaskIpcDeliveries(
                durableTaskRunId,
                [
                  {
                    channel: getChannelType(targetJid) ?? targetJid,
                    payload: {
                      kind: 'im_file',
                      targetJid,
                      workspaceFolder: sourceGroup,
                      filePath: data.filePath,
                      fileName: imFileName,
                    },
                    deliver: () =>
                      sendTaskFileWithRetry(
                        targetJid,
                        resolvedPath,
                        imFileName,
                      ),
                  },
                ],
              );
              const sent =
                delivery.accepted && delivery.receipt.status === 'success';
              if (!sent) {
                broadcastToWebClients(
                  sourceGroup,
                  `⚠️ 文件 "${data.fileName}" 发送失败，请稍后重试。`,
                );
              }
              finishSendFile(
                sent,
                sent
                  ? undefined
                  : delivery.receipt.error || 'File delivery failed.',
              );
            } else if (fileRoutingDecision.mode === 'broadcast') {
              const attempts: TaskNotificationDeliveryAttempt[] = [];
              broadcastToOwnerIMChannels(
                sourceGroupEntry!.created_by!,
                broadcastFolder,
                new Set<string>(),
                (jid) => {
                  attempts.push({
                    channel: getChannelType(jid) ?? jid,
                    payload: {
                      kind: 'im_file',
                      targetJid: jid,
                      workspaceFolder: sourceGroup,
                      filePath: data.filePath!,
                      fileName: imFileName,
                    },
                    deliver: () =>
                      sendTaskFileWithRetry(jid, resolvedPath, imFileName),
                  });
                },
                fileRoutingDecision.notifyChannels,
              );
              const delivery = await settleAndRecordTaskIpcDeliveries(
                durableTaskRunId,
                attempts,
              );
              const sent =
                delivery.accepted &&
                (delivery.receipt.status === 'success' ||
                  delivery.receipt.status === 'skipped');
              finishSendFile(
                sent,
                sent
                  ? undefined
                  : delivery.receipt.error || 'File delivery failed.',
              );
            } else if (
              regularFileImRoute &&
              !canDeliverTurnUtterance(
                sourceGroup,
                ipcAgentId,
                data.inputTurnId,
              )
            ) {
              // Runaway-loop fuse, sharing send_message's budget. A delivered
              // file is user-visible speech and is recorded against the turn,
              // so it must be gated by the same bound.
              logger.warn(
                {
                  sourceGroup,
                  agentId: ipcAgentId,
                  inputTurnId: data.inputTurnId,
                },
                'Suppressed IPC send_file: per-turn reply limit reached',
              );
              finishSendFile(false, REPLY_LIMIT_REACHED_ERROR);
            } else if (regularFileImRoute) {
              const regularFileOutboxRef = channelOutboxRefForInput(
                channelTurnScope(sourceGroup, ipcAgentId),
                regularFileImRoute,
                data.inputTurnId,
                `ipc-file:${data.requestId ?? ipcTaskId ?? data.filePath}`,
              );
              const durableScopedFile = Boolean(regularFileOutboxRef);
              const sent = await sendTaskFileWithRetry(
                regularFileImRoute,
                resolvedPath,
                imFileName,
                regularFileOutboxRef,
              );
              if (!sent) {
                const failMsg = durableScopedFile
                  ? `⚠️ 文件 "${data.fileName}" 的投递结果待确认，系统不会自动重发，以免产生重复文件。`
                  : `⚠️ 文件 "${data.fileName}" 发送失败，请稍后重试。`;
                broadcastToWebClients(sourceGroup, failMsg);
                if (!durableScopedFile) {
                  try {
                    await imManager.sendMessage(regularFileImRoute, failMsg);
                  } catch {
                    // ignore — failure notification itself failing should not crash
                  }
                }
              }
              // A delivered file is user-visible speech; record it so the turn
              // is not treated as silent and replayed.
              if (
                sent &&
                typeof data.inputTurnId === 'string' &&
                data.inputTurnId
              ) {
                activeTurnOutputs.recordDeliveredUtterance({
                  scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
                  inputTurnId: data.inputTurnId,
                });
              }
              finishSendFile(
                sent,
                sent
                  ? undefined
                  : durableScopedFile
                    ? 'File delivery outcome is uncertain; do not retry automatically.'
                    : 'File delivery failed.',
              );
            }
          } else {
            logger.debug(
              { chatJid: data.chatJid, sourceGroup },
              'No IM route for send_file, skipped IM delivery',
            );
            // Notify the user that file delivery to IM was skipped
            const skipMsg = `⚠️ 文件 "${data.fileName}" 未发送到 IM 通道（当前会话无 IM 路由绑定，文件仅保存在工作区）。`;
            broadcastToWebClients(data.chatJid ?? sourceGroup, skipMsg);
            finishSendFile(
              false,
              'No IM route is available for file delivery.',
            );
          }
          logger.info(
            {
              sourceGroup,
              chatJid: data.chatJid,
              fileName: data.fileName,
              imRoute:
                fileRoutingDecision.mode === 'direct'
                  ? fileRoutingDecision.taskChatJid
                  : regularFileImRoute,
              taskRoutingMode: fileRoutingDecision.mode,
            },
            'File sent via IPC',
          );
        } catch (err) {
          logger.error({ err, data }, 'Failed to send file via IPC');
          finishSendFile(
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid send_file request - missing required fields',
        );
        finishSendFile(false, 'Invalid send_file request.');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Handle Discord-specific IPC requests (history, channel info, server info).
 * Writes a result file `{type}_result_{requestId}.json` back to the source group's tasks dir.
 * Authorization: target chatJid must be owned by sourceGroup's user (or admin home for cross-group).
 */
async function handleDiscordIpcRequest(
  data: {
    type: string;
    chatJid?: string;
    requestId?: string;
    limit?: number;
    before?: string;
  },
  sourceGroup: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  isAdminHome: boolean,
): Promise<void> {
  const requestId = data.requestId;
  if (!requestId || !SAFE_REQUEST_ID_RE.test(requestId)) {
    logger.warn(
      { sourceGroup, type: data.type, requestId },
      'Rejected Discord IPC request with invalid requestId',
    );
    return;
  }

  const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
  const tasksDirResolved = path.resolve(tasksDir);
  const resultFileName = `${data.type}_result_${requestId}.json`;
  const resultFilePath = path.resolve(tasksDir, resultFileName);
  if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
    logger.warn(
      { sourceGroup, type: data.type, resultFilePath },
      'Rejected Discord IPC request with unsafe result file path',
    );
    return;
  }
  fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });

  const writeResult = (payload: object): void => {
    const tmpPath = `${resultFilePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, resultFilePath);
  };

  try {
    const chatJid = data.chatJid;
    if (!chatJid || !chatJid.startsWith('discord:')) {
      writeResult({
        success: false,
        error: 'chatJid must be a Discord JID (discord:*)',
      });
      return;
    }

    // Authorization: read-only Discord queries — admin home, same folder, or
    // same owner is enough. We don't require sourceGroup to be `is_home` like
    // cross-group sends do, because querying channel/history info doesn't
    // write into another workspace.
    const targetGroup = registeredGroups[chatJid];
    const ownerOk =
      isAdminHome ||
      (targetGroup && targetGroup.folder === sourceGroup) ||
      (targetGroup &&
        sourceGroupEntry?.created_by != null &&
        targetGroup.created_by === sourceGroupEntry.created_by);
    if (!targetGroup || !ownerOk) {
      writeResult({
        success: false,
        error: `Not authorized to access Discord chat ${chatJid}`,
      });
      return;
    }

    if (data.type === 'discord_get_history') {
      const messages = await imManager.getDiscordHistory(chatJid, {
        limit: data.limit,
        before: data.before,
      });
      // Strip authorId (Discord user Snowflake) before sending to agent.
      // authorId + authorName uniquely identifies a user even after rename;
      // letting it reach the agent risks cross-channel forwarding into 3rd-
      // party LLM logs. Formatted output already only shows authorName.
      const sanitized = messages.map(({ authorId: _id, ...rest }) => rest);
      writeResult({ success: true, messages: sanitized });
    } else if (data.type === 'discord_get_channel_info') {
      const channel = await imManager.getDiscordChannelInfo(chatJid);
      writeResult({ success: true, channel });
    } else if (data.type === 'discord_get_server_info') {
      const guild = await imManager.getDiscordGuildInfo(chatJid);
      writeResult({ success: true, guild });
    } else {
      writeResult({ success: false, error: `Unknown type: ${data.type}` });
    }
  } catch (err) {
    logger.error(
      { sourceGroup, type: data.type, err },
      'Discord IPC request failed',
    );
    writeResult({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Process messages for a user-created conversation agent.
 * Similar to processGroupMessages but uses agent-specific session/IPC and virtual JID.
 * The agent process stays alive for idleTimeout, cycling idle→running.
 */
async function processAgentConversation(
  chatJid: string,
  agentId: string,
): Promise<void | boolean> {
  const agent = getAgent(agentId);
  if (!agent || (agent.kind !== 'conversation' && agent.kind !== 'spawn')) {
    logger.warn(
      { chatJid, agentId },
      'processAgentConversation: agent not found or not a conversation/spawn',
    );
    return;
  }

  let group = registeredGroups[chatJid];
  if (!group) {
    registeredGroups = getAllRegisteredGroups();
    group = registeredGroups[chatJid];
  }
  if (!group) return;

  const { effectiveGroup } = resolveEffectiveGroup(group);

  const virtualChatJid = `${chatJid}#agent:${agentId}`;
  const virtualJid = virtualChatJid; // used as queue key
  const agentBuilderScope = agentBuilderTurnScope(
    effectiveGroup.folder,
    agentId,
  );

  // Get pending messages
  const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
  let missedMessages = getMessagesSince(virtualChatJid, sinceCursor);

  // Owner gate (single chokepoint for all 5 call sites: normal dispatch,
  // IM-restart recovery, unconsumed-IPC recovery, /spawn). The main message
  // loop's owner gate is bypassed for target_agent_id groups (they `continue`
  // before it), so conversation-agent traffic only reaches this gate. When the
  // owner is disabled/deleted, advance the cursor past the pending messages so
  // they aren't replayed, then drop. See `src/owner-gate.ts` for rationale.
  if (effectiveGroup.created_by) {
    const ownerGate = checkOwnerActive(getUserById(effectiveGroup.created_by));
    if (!ownerGate.allowed) {
      completeOutOfBandMessages(virtualChatJid, missedMessages);
      await clearStandaloneProcessingIndicatorsForMessages(
        virtualChatJid,
        missedMessages,
      );
      logger.info(
        {
          chatJid,
          agentId,
          userId: effectiveGroup.created_by,
          ownerStatus: ownerGate.status,
        },
        'Dropping agent conversation: owner is not active',
      );
      return;
    }
  }
  if (missedMessages.length === 0) {
    // Spawn agents are fire-and-forget: if no messages are found (race condition
    // or cursor already advanced), mark as error so they don't stay idle forever.
    if (agent.kind === 'spawn' && agent.status === 'idle') {
      updateAgentStatus(agentId, 'error', '未找到待处理消息');
      broadcastAgentStatus(
        chatJid,
        agentId,
        'error',
        agent.name,
        agent.prompt,
        '未找到待处理消息',
      );
      logger.warn(
        { chatJid, agentId },
        'Spawn agent had no pending messages, marked as error',
      );
    }
    return;
  }

  const isHome = !!effectiveGroup.is_home;
  const effectiveOwner = effectiveGroup.created_by
    ? getUserById(effectiveGroup.created_by)
    : undefined;
  const isAdminHome = isHome && effectiveOwner?.role === 'admin';

  // Plugin command expander (DMI commands) — agent conversation cold start.
  // Replies go to virtualChatJid so the agent UI tab routes them correctly;
  // cursor advancement also uses the virtual JID since that's the read key.
  {
    const fallbackExpandCtx = buildExpandContext(
      virtualChatJid,
      effectiveGroup,
      effectiveGroup.created_by,
    );
    if (fallbackExpandCtx) {
      const { toSend, replies } = await expandMessagesIfNeeded(
        missedMessages,
        fallbackExpandCtx,
        undefined,
        persistPluginExpansion,
      );
      // Same crash-safe split as processGroupMessages (#18 P2-bug-2):
      // hold the recovery cursor when toSend still has work pending.
      const advanceReplyCursor =
        toSend.length === 0
          ? completeOutOfBandMessage
          : advanceNextPullCursorOnly;
      // Resolve IM target so plugin replies fan out to the originating IM
      // channel (#20 P1-1). Per-reply: prefer that message's source_jid;
      // otherwise fall back to the agent's last_im_jid, but only if its
      // channel is currently connected (stale jids would just retry-fail).
      const persistedAgentImJid = (() => {
        const agentRow = getAgent(agentId);
        const candidate = agentRow?.last_im_jid;
        if (
          candidate &&
          getChannelType(candidate) &&
          imManager.isChannelAvailableForJid(candidate)
        ) {
          return candidate;
        }
        return null;
      })();
      let agentPluginRepliesAcknowledged = true;
      for (const r of replies) {
        const perMsgImJid =
          r.originalMsg.source_jid && getChannelType(r.originalMsg.source_jid)
            ? r.originalMsg.source_jid
            : persistedAgentImJid;
        const delivery = await sendPluginExpanderReply(virtualChatJid, r.text, {
          originalMessageId: r.originalMsg.id,
          groupFolder: effectiveGroup.folder,
          imRouteJid: perMsgImJid,
          agentId,
        });
        if (!delivery.acknowledged) {
          agentPluginRepliesAcknowledged = false;
          break;
        }
        if (perMsgImJid) {
          await clearStandaloneProcessingIndicator(
            virtualChatJid,
            perMsgImJid,
            r.originalMsg.id,
          );
        }
        advanceReplyCursor(virtualChatJid, {
          timestamp: r.originalMsg.timestamp,
          id: r.originalMsg.id,
        });
      }
      if (!agentPluginRepliesAcknowledged) return false;
      if (toSend.length === 0) {
        // Spawn agents are fire-and-forget: if expansion consumed all
        // messages with replies, mark as completed so the agent slot is freed.
        if (agent.kind === 'spawn' && agent.status === 'idle') {
          updateAgentStatus(agentId, 'completed');
          broadcastAgentStatus(
            chatJid,
            agentId,
            'completed',
            agent.name,
            agent.prompt,
          );
        }
        return;
      }
      missedMessages = toSend;
    }
  }

  // The batch runtime id is needed before the rest of the conversation setup.
  // Keep this declaration above startBatch so startup recovery cannot hit the
  // temporal dead zone while rebuilding an agent turn.
  const lastProcessed = missedMessages[missedMessages.length - 1];
  activeAgentBuilderTurns.startBatch(
    agentBuilderScope,
    missedMessages.map((message) => ({
      chatJid: virtualChatJid,
      messageId: message.id,
      runtimeTurnId: lastProcessed.id,
      scheduledTaskId: message.task_id ?? null,
    })),
  );

  // Update agent status → running
  updateAgentStatus(agentId, 'running');
  broadcastAgentStatus(chatJid, agentId, 'running', agent.name, agent.prompt);

  const agentProfile = resolveEffectiveAgentProfile(
    getAgentProfileForWorkspace(
      effectiveGroup.folder,
      effectiveGroup.created_by,
    ),
  );
  const interactionMode = resolveRuntimeInteractionMode(
    getWorkspaceInteractionMode(effectiveGroup.folder),
    { agentKind: agent.kind },
  );
  const resetForAgentProfile = resetConversationSessionForAgentProfileMismatch(
    effectiveGroup,
    agentId,
    agentProfile,
  );

  // Get or use agent-specific session before building the prompt. If the
  // session was cleared by provider/model switching, inject persisted HappyClaw
  // chat history so the new model does not mistake the fresh SDK session for
  // an empty conversation.
  const sessionId = getSession(effectiveGroup.folder, agentId) || undefined;
  let currentAgentSessionId = sessionId;
  // Inject history when the SDK session is fresh, or when a proactive provider
  // switch (sticky binding unhealthy/disabled) will clear the existing session
  // inside the runner — otherwise the new provider's first turn loses context.
  const startsFreshSession =
    !sessionId ||
    resetForAgentProfile ||
    willClearSessionOnProviderSwitch(effectiveGroup.folder, agentId);
  let historyContext: ReturnType<typeof buildRecentConversationHistoryContext> =
    null;
  if (startsFreshSession) {
    historyContext = buildRecentConversationHistoryContext(
      virtualChatJid,
      new Set(missedMessages.map((m) => m.id)),
      {
        limit: 30,
        maxMessageLength: 700,
        intro: resetForAgentProfile
          ? '检测到当前 workspace 切换或更新了顶层 AgentProfile 身份提示词，当前 agent 的底层模型 session 已重置。以下是 HappyClaw 保存的最近对话记录，供你在新身份下延续上下文。'
          : '检测到当前 agent 的底层模型 session 是新的（可能因为切换 provider/model 或恢复失败）。以下是 HappyClaw 保存的最近对话记录，供你延续上下文。',
      },
    );
    if (historyContext) {
      logger.info(
        { chatJid, agentId, historyCount: historyContext.count },
        'Agent fresh session: injected recent conversation history into prompt',
      );
    }
  }
  const activeSessionReferencedMessageIds = startsFreshSession
    ? new Set<string>()
    : collectPersistedReferencedMessageIds(virtualChatJid, missedMessages);
  const knownReferencedMessageIds = historyContext
    ? new Set(historyContext.messageIds)
    : activeSessionReferencedMessageIds;
  let prompt =
    (historyContext?.context ?? '') +
    formatMessages(missedMessages, {
      knownMessageIds: knownReferencedMessageIds,
    });
  const images = collectMessageImages(virtualChatJid, missedMessages, {
    knownMessageIds: activeSessionReferencedMessageIds,
  });
  const imagesForAgent = images.length > 0 ? images : undefined;
  // For agent conversations, route reply to IM based on the most recent
  // message's source.  Unlike the main conversation (#99), agent conversations
  // are explicitly bound to IM groups, so the user expects replies to go back
  // to the IM channel they last messaged from — even if older messages in
  // the batch originated from the web (e.g. after a /clear).
  const lastSourceJid = missedMessages[missedMessages.length - 1]?.source_jid;
  const incomingAgentOwner =
    lastSourceJid && getChannelType(lastSourceJid) !== null
      ? lastSourceJid
      : null;
  const agentRow = getAgent(agentId);
  const persistedAgentOwner =
    getSessionChannelOwner(effectiveGroup.folder, agentId) ??
    agentRow?.last_im_jid ??
    null;
  let replySourceImJid = resolveStickyChannelOwner(
    persistedAgentOwner,
    incomingAgentOwner,
  );

  // Persist once so restarts and later Web/other-IM input keep the first
  // concrete channel/account/thread identity for this logical Session.
  if (!persistedAgentOwner && replySourceImJid) {
    replySourceImJid = setSessionChannelOwnerOnce(
      effectiveGroup.folder,
      agentId,
      replySourceImJid,
    );
    if (!agentRow?.last_im_jid) {
      updateAgentLastImJid(agentId, replySourceImJid);
    }
  }
  if (replySourceImJid) {
    // Publish to activeImReplyRoutes so send_file/send_image IPC can route to IM.
    // Only use virtualChatJid key (per-agent) — folder-level key would collide
    // when multiple auto_im agents share the same workspace folder.
    activeImReplyRoutes.set(virtualChatJid, replySourceImJid);
  }

  updateAgentContextInfo(agentId, {
    last_active_at:
      missedMessages[missedMessages.length - 1]?.timestamp ||
      new Date().toISOString(),
  });

  // ── Feishu Streaming Card (conversation agent) ──
  // Unlike processGroupMessages which falls back to chatJid, conversation agents
  // only stream when the message originates from an IM channel (replySourceImJid).
  // Web-only interactions don't need a Feishu streaming card.
  // Use agent-scoped key to avoid colliding with the main session's streaming card (#242).
  const streamingSessionJid = replySourceImJid
    ? `${replySourceImJid}#agent:${agentId}`
    : undefined;
  const healthyAgentCompletedInputTurns = new Set<string>();
  const agentProcessingIndicatorJidsByInput = new Map<string, string>();
  const agentProcessingIndicatorInputsByCompletion = new Map<string, string[]>([
    [
      lastProcessed.id,
      [...new Set(missedMessages.map((message) => message.id))],
    ],
  ]);
  const agentProcessingTypingLeaseIdsByCompletion = new Map<string, string>([
    [lastProcessed.id, lastProcessed.id],
  ]);
  for (const message of missedMessages) {
    const indicatorJid =
      message.source_jid && getChannelType(message.source_jid)
        ? message.source_jid
        : replySourceImJid;
    if (!indicatorJid) continue;
    agentProcessingIndicatorJidsByInput.set(message.id, indicatorJid);
    trackProcessingIndicator(virtualChatJid, message.id, indicatorJid);
  }
  const clearAgentProcessingIndicatorForInput = async (
    inputTurnId: string,
  ): Promise<void> => {
    const exactInputIds = agentProcessingIndicatorInputsByCompletion.get(
      inputTurnId,
    ) ?? [inputTurnId];
    const typingLeaseId =
      agentProcessingTypingLeaseIdsByCompletion.get(inputTurnId) ?? inputTurnId;
    let typingCleared = false;
    await clearTrackedTypingIndicator(
      virtualChatJid,
      typingLeaseId,
      agentProcessingIndicatorJidsByInput.get(exactInputIds[0]) ??
        virtualChatJid,
    ).then(
      () => {
        typingCleared = true;
      },
      (err) => {
        logger.debug(
          { err, chatJid, agentId, inputTurnId, typingLeaseId },
          'Failed to clear exact agent processing typing lease',
        );
      },
    );
    if (typingCleared) {
      agentProcessingTypingLeaseIdsByCompletion.delete(inputTurnId);
    }
    const failedExactInputIds: string[] = [];
    for (const exactInputId of new Set(exactInputIds)) {
      const indicatorJid =
        agentProcessingIndicatorJidsByInput.get(exactInputId);
      if (!indicatorJid) continue;
      let ackCleared = false;
      await imManager.clearAckReaction(indicatorJid, exactInputId).then(
        () => {
          ackCleared = true;
        },
        (err) => {
          logger.debug(
            {
              err,
              chatJid,
              agentId,
              inputTurnId: exactInputId,
              indicatorJid,
            },
            'Failed to clear exact agent processing indicator',
          );
        },
      );
      if (ackCleared) {
        agentProcessingIndicatorJidsByInput.delete(exactInputId);
        untrackProcessingIndicator(virtualChatJid, exactInputId);
      } else {
        failedExactInputIds.push(exactInputId);
      }
    }
    if (failedExactInputIds.length > 0) {
      agentProcessingIndicatorInputsByCompletion.set(
        inputTurnId,
        failedExactInputIds,
      );
    } else {
      agentProcessingIndicatorInputsByCompletion.delete(inputTurnId);
    }
  };
  const initialAgentTypingTransportJid = replySourceImJid ?? virtualChatJid;
  const initialAgentTypingReady = setTyping(
    virtualChatJid,
    true,
    lastProcessed.id,
    initialAgentTypingTransportJid,
  );
  trackTypingIndicator(
    virtualChatJid,
    lastProcessed.id,
    initialAgentTypingTransportJid,
    initialAgentTypingReady,
  );
  await initialAgentTypingReady;
  let activeAgentInputTurnId = lastProcessed.id;
  const agentStreamingAddress = replySourceImJid
    ? parseChannelAddress(replySourceImJid)
    : null;
  const agentStreamingGroup = replySourceImJid
    ? getRegisteredGroup(channelConversationJid(replySourceImJid))
    : undefined;
  const agentStreamingAccountId =
    agentStreamingAddress?.channelAccountId ??
    agentStreamingGroup?.channel_account_id;
  let agentChannelTurnRuntime =
    replySourceImJid && agentStreamingAddress && agentStreamingAccountId
      ? ChannelTurnRuntime.start({
          provider: agentStreamingAddress.provider,
          accountId: agentStreamingAccountId,
          sourceJid: replySourceImJid,
          chatId: agentStreamingAddress.externalChatId,
          rootId: agentStreamingAddress.rootMessageId,
          threadId: agentStreamingAddress.threadId,
          externalMessageId: lastProcessed.id,
          agentId,
          sessionId,
        })
      : undefined;
  const agentChannelTurnRuntimes = new Map<string, ChannelTurnRuntime>();
  if (agentChannelTurnRuntime) {
    agentChannelTurnRuntimes.set(lastProcessed.id, agentChannelTurnRuntime);
  }
  const completeAgentChannelRuntimesForOutput = async (
    result: ContainerOutput,
  ): Promise<boolean> => {
    if (!result.inputTurnCompleted) return false;
    let allCompleted = true;
    const inputIds = result.ipcReceipts?.length
      ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
      : [result.inputTurnId ?? lastProcessed.id];
    for (const inputId of inputIds) {
      healthyAgentCompletedInputTurns.add(inputId);
      const runtime = agentChannelTurnRuntimes.get(inputId);
      if (!runtime) {
        await clearAgentProcessingIndicatorForInput(inputId);
        continue;
      }
      const uncertainDelivery = getUncertainChannelOutboxForTurn(runtime.runId);
      if (uncertainDelivery) {
        agentDeliveryNeedsManualReconciliation = true;
        const interrupted = runtime.interrupt(
          `Channel delivery ${uncertainDelivery.id} is uncertain; manual reconciliation required`,
        );
        const exactScope = agentChannelOutboxScopesByInput.get(inputId);
        const notified = exactScope?.chatId
          ? await deliverChannelManualReconciliationNotice({
              logicalChatJid: virtualChatJid,
              scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
              targetJid: exactScope.sourceJid,
              runtime,
              agentId,
              presentation:
                interactionMode === 'proactive' ? 'native' : 'default',
              route: { ...exactScope, chatId: exactScope.chatId },
            })
          : false;
        if (interrupted && notified) {
          await clearAgentProcessingIndicatorForInput(inputId);
          runtime.dispose();
          agentChannelTurnRuntimes.delete(inputId);
        } else {
          allCompleted = false;
        }
        continue;
      }
      const utteranceDelivered =
        agentPhysicalDeliveryAckByInput.get(inputId) === true;
      if (publishesFrameworkAnswer(interactionMode) && !utteranceDelivered) {
        allCompleted = false;
        logger.error(
          { chatJid, agentId, inputTurnId: inputId, runId: runtime.runId },
          'Refusing to complete agent input without exact physical delivery ACK',
        );
        continue;
      }
      const completed =
        runtime.markFinalizing() &&
        runtime.complete({
          cursorCommitted: true,
          replyDelivered: utteranceDelivered,
          silent: !utteranceDelivered,
          inputTurnId: inputId,
        });
      if (completed) {
        // Retain exact scope until runner finally; see main-path comment.
        await clearAgentProcessingIndicatorForInput(inputId);
        runtime.dispose();
        agentChannelTurnRuntimes.delete(inputId);
      } else {
        allCompleted = false;
        logger.error(
          {
            chatJid,
            agentId,
            inputTurnId: inputId,
            runId: runtime.runId,
            durabilityFailure: runtime.hasDurabilityFailure,
            lostFence: runtime.hasLostFence,
          },
          'Completed agent input could not terminalize its channel turn ledger',
        );
      }
    }
    return allCompleted;
  };
  const agentScopeForOutput = (
    result: ContainerOutput,
  ): {
    inputId: string;
    scope?: ActiveChannelOutboxScope;
    rejected: boolean;
  } => {
    const inputIds = result.ipcReceipts?.length
      ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
      : [];
    const inputId = resolveContainerOutputInputTurnId(result, lastProcessed.id);
    return {
      inputId,
      scope: agentChannelOutboxScopesByInput.get(inputId),
      rejected: inputIds.some((id) => rejectedAgentInputTurns.has(id)),
    };
  };
  if (
    agentChannelTurnRuntime &&
    agentChannelTurnRuntime.executionDisposition !== 'execute'
  ) {
    const disposition = agentChannelTurnRuntime.executionDisposition;
    if (
      disposition === 'manual_reconciliation' &&
      agentStreamingAddress &&
      agentStreamingAccountId &&
      replySourceImJid
    ) {
      const notified = await deliverChannelManualReconciliationNotice({
        logicalChatJid: virtualChatJid,
        scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
        targetJid: replySourceImJid,
        runtime: agentChannelTurnRuntime,
        agentId,
        presentation: interactionMode === 'proactive' ? 'native' : 'default',
        route: {
          provider: agentStreamingAddress.provider,
          accountId: agentStreamingAccountId,
          sourceJid: replySourceImJid,
          chatId: agentStreamingAddress.externalChatId,
          rootId: agentStreamingAddress.rootMessageId,
          threadId: agentStreamingAddress.threadId,
        },
      });
      agentChannelTurnRuntime.dispose();
      activeImReplyRoutes.delete(virtualChatJid);
      updateAgentStatus(agentId, 'idle');
      await clearAgentProcessingIndicatorForInput(lastProcessed.id);
      if (!notified) return false;
      advanceCursors(virtualChatJid, {
        timestamp: lastProcessed.timestamp,
        id: lastProcessed.id,
      });
      return true;
    }
    agentChannelTurnRuntime.dispose();
    activeImReplyRoutes.delete(virtualChatJid);
    updateAgentStatus(
      agentId,
      agent.kind === 'spawn' && disposition === 'skip_terminal'
        ? 'completed'
        : 'idle',
    );
    if (disposition === 'skip_terminal') {
      await clearAgentProcessingIndicatorForInput(lastProcessed.id);
      advanceCursors(virtualChatJid, {
        timestamp: lastProcessed.timestamp,
        id: lastProcessed.id,
      });
      return true;
    }
    logger.info(
      { chatJid, agentId, turnRunId: agentChannelTurnRuntime.runId },
      'Agent channel turn is already leased; deferring duplicate execution',
    );
    return false;
  }
  const agentRetryAttempt = queue.getRetryCount(virtualChatJid);
  let activeAgentDurableCardLifecycle =
    publishesFrameworkAnswer(interactionMode) &&
    agentRetryAttempt === 0 &&
    agentStreamingAddress?.provider === 'feishu'
      ? agentChannelTurnRuntime?.reserveStreamingCard()
      : undefined;
  if (
    publishesFrameworkAnswer(interactionMode) &&
    agentChannelTurnRuntime &&
    agentStreamingAddress?.provider === 'feishu' &&
    agentRetryAttempt === 0 &&
    !activeAgentDurableCardLifecycle
  ) {
    agentChannelTurnRuntime.retry('Duplicate streaming card reservation');
    agentChannelTurnRuntime.dispose();
    activeImReplyRoutes.delete(virtualChatJid);
    updateAgentStatus(agentId, 'idle');
    return false;
  }
  let agentChannelOutboxScope: ActiveChannelOutboxScope | undefined;
  const agentChannelOutboxScopesByInput = new Map<
    string,
    ActiveChannelOutboxScope
  >();
  const rejectedAgentInputTurns = new Set<string>();
  let agentStreamingSession =
    publishesFrameworkAnswer(interactionMode) && replySourceImJid
      ? await imManager.createStreamingSession(
          replySourceImJid,
          (messageId) =>
            registerMessageIdMapping(messageId, streamingSessionJid!),
          activeAgentDurableCardLifecycle,
        )
      : undefined;
  const agentStreamingSessionsByInput = new Map<
    string,
    { session: NonNullable<typeof agentStreamingSession>; jid: string }
  >();
  let agentStreamingAccText = '';
  let agentStreamInterrupted = false;
  let agentStreamSteered = false;
  let agentInterruptFinalized = false;
  // Mirrors the main session's `output.status === 'closed'` handling: set when
  // the container drained mid-query so the finally block finalizes the card as
  // "reconnecting" instead of leaving a zombie 生成中 card.
  let agentClosed = false;
  // ── 卡片挂起完成机制（与主路径 runContainerAgent 对齐）──
  // Sub-Agent 路径首条回复后本就不再向 IM 发消息（isFirstReply 门控），挂起
  // 机制在这里同时修复了"后台任务汇总只入库、飞书永远看不到"的消息丢失。
  let heldAgentParts: string[] = [];
  // Keep the running Workflow projection across the held acknowledgement
  // turn. Otherwise sdk_final clears the browser's live task card while the
  // actual SDK Workflow continues in the background.
  let activeAgentWorkflowRuns: NonNullable<StreamEvent['workflowRun']>[] = [];
  let completedAgentWorkflowRuns: NonNullable<StreamEvent['workflowRun']>[] =
    [];
  let heldAgentUsage: HeldUsageTotals | null = null;
  let pendingAgentLedgerUsageBatch: HeldUsageTotals | null = null;
  // 定稿后等待最终 usage 事件做合并补丁（Sub 路径 session 不轮换，引用即当前卡）
  let heldAgentUsagePatchPending = false;
  // 挂起序列的 DB 合并锚点（全渠道一条回复）：序列内所有 turn 复用同一
  // 消息 id / turnId，INSERT OR REPLACE 覆盖同一行。与卡片存在性无关。
  let heldAgentDbMsgId: string | null = null;
  let heldAgentDbTurnId: string | null = null;
  const heldAgentBaseText = (): string =>
    heldAgentParts.length > 0
      ? heldAgentParts.join(HELD_TURN_DIVIDER) + HELD_TURN_DIVIDER
      : '';
  // 挂起序列异常收口：给合并行追加说明注记并广播（对齐主路径 finalizeHeldDbMessage）
  const finalizeHeldAgentDbMessage = (
    note: string | null,
    reason: 'interrupted' | 'truncated',
    warning = true,
  ): void => {
    if (!heldAgentDbMsgId || heldAgentParts.length === 0) return;
    const suffix = note ? `\n\n> ${warning ? '⚠️ ' : ''}${note}` : '';
    const joined = heldAgentParts.join(HELD_TURN_DIVIDER) + suffix;
    const msgId = heldAgentDbMsgId;
    const tid = heldAgentDbTurnId;
    heldAgentDbMsgId = null;
    heldAgentDbTurnId = null;
    try {
      const timestamp = new Date().toISOString();
      storeMessageDirect(
        msgId,
        virtualChatJid,
        'happyclaw-agent',
        ASSISTANT_NAME,
        joined,
        timestamp,
        true,
        {
          meta: {
            turnId: tid ?? undefined,
            sessionId: currentAgentSessionId,
            sourceKind: 'sdk_final',
            finalizationReason: reason,
          },
        },
      );
      broadcastNewMessage(
        virtualChatJid,
        {
          id: msgId,
          chat_jid: virtualChatJid,
          sender: 'happyclaw-agent',
          sender_name: ASSISTANT_NAME,
          content: joined,
          timestamp,
          is_from_me: true,
          turn_id: tid,
          session_id: currentAgentSessionId,
          sdk_message_uuid: null,
          source_kind: 'sdk_final',
          finalization_reason: reason,
        },
        agentId,
      );
    } catch (err) {
      logger.warn(
        { err, chatJid, agentId },
        'Failed to finalize held agent DB message',
      );
    }
  };
  if (agentStreamingSession && streamingSessionJid) {
    registerStreamingSession(streamingSessionJid, agentStreamingSession);
    agentStreamingSessionsByInput.set(lastProcessed.id, {
      session: agentStreamingSession,
      jid: streamingSessionJid,
    });
    logger.debug(
      { chatJid, agentId },
      'Streaming card session created for conversation agent',
    );
  }
  const rollbackIdleAgentCardReservation = (inputTurnId: string): boolean => {
    const projection =
      agentStreamingSessionsByInput.get(inputTurnId) ??
      (inputTurnId === lastProcessed.id &&
      agentStreamingSession &&
      streamingSessionJid
        ? { session: agentStreamingSession, jid: streamingSessionJid }
        : undefined);
    const runtime = agentChannelTurnRuntimes.get(inputTurnId);
    if (projection?.session.isActive()) return false;
    if (!runtime?.rollbackUnpublishedStreamingCardReservation()) {
      projection?.session.setThinking();
      return false;
    }
    projection?.session.dispose();
    if (projection) unregisterStreamingSession(projection.jid);
    agentStreamingSessionsByInput.delete(inputTurnId);
    if (projection?.session === agentStreamingSession) {
      agentStreamingSession = undefined;
      activeAgentDurableCardLifecycle = undefined;
    }
    logger.info(
      { chatJid, agentId, inputTurnId },
      'Rolled back unpublished agent streaming card after provider failure',
    );
    return true;
  };
  interface AdmittedWarmAgentInput {
    sourceJid: string | null;
    imJid: string | null;
    runtime?: ChannelTurnRuntime;
    scope?: ActiveChannelOutboxScope;
    lifecycle?: typeof activeAgentDurableCardLifecycle;
  }
  const admittedWarmAgentInputs = new Map<string, AdmittedWarmAgentInput>();
  const agentAdmissionKey = channelTurnScope(effectiveGroup.folder, agentId);
  const agentTurnOutputCoordinators = new Map<string, TurnOutputCoordinator>();
  const bindAgentTurnOutputCoordinator = (
    inputTurnId: string,
  ): TurnOutputCoordinator => {
    const existing = agentTurnOutputCoordinators.get(inputTurnId);
    if (existing) return existing;
    const coordinator = activeTurnOutputs.bind(agentAdmissionKey, inputTurnId, {
      onProgress: (text) => {
        const projection = agentStreamingSessionsByInput.get(inputTurnId);
        if (projection?.session.isActive()) {
          projection.session.setThinking();
          projection.session.setSystemStatus(text.slice(0, 160));
          projection.session.pushRecentEvent(
            `🔄 ${text.replace(/\s+/g, ' ').slice(0, 80)}`,
          );
        }
        broadcastStreamEvent(
          chatJid,
          {
            eventType: 'status',
            agentScope: 'system',
            statusText: text.slice(0, 160),
            summary: text.slice(0, 500),
            isSynthetic: true,
            displayLevel: 'primary',
            turnId: inputTurnId,
            sessionId: currentAgentSessionId,
          },
          agentId,
        );
        return true;
      },
      onFinalCandidate: (text) => {
        agentStreamingAccText = text;
        const projection = agentStreamingSessionsByInput.get(inputTurnId);
        if (projection?.session.isActive()) {
          projection.session.append(heldAgentBaseText() + text);
          projection.session.setSystemStatus('正在完成最终回复…');
        }
        return true;
      },
      onUtteranceDelivered: () => {
        if (interactionMode !== 'proactive') return;
        agentPhysicalDeliveryAckByInput.set(inputTurnId, true);
        agentReplySentByInput.set(inputTurnId, true);
      },
    });
    agentTurnOutputCoordinators.set(inputTurnId, coordinator);
    return coordinator;
  };
  const finalizeProactiveAgentOutputCoordinators = (
    output: ContainerOutput,
  ): void => {
    const inputIds = output.ipcReceipts?.length
      ? output.ipcReceipts.map((receipt) => receipt.deliveryId)
      : [output.inputTurnId ?? lastProcessed.id];
    for (const inputId of inputIds) {
      const coordinator = agentTurnOutputCoordinators.get(inputId);
      if (!coordinator) continue;
      coordinator.markFinalized();
      activeTurnOutputs.unbind(agentAdmissionKey, inputId, coordinator);
      agentTurnOutputCoordinators.delete(inputId);
    }
    // Proactive output has no framework-owned answer/held lane. Reset any
    // legacy warm-process residue at the durable input completion boundary.
    agentStreamingAccText = '';
    heldAgentParts = [];
    heldAgentUsage = null;
    heldAgentUsagePatchPending = false;
    heldAgentDbMsgId = null;
    heldAgentDbTurnId = null;
    activeAgentWorkflowRuns = [];
    completedAgentWorkflowRuns = [];
  };
  bindAgentTurnOutputCoordinator(lastProcessed.id);
  activeRouteAdmissions.set(
    agentAdmissionKey,
    (newSourceJid, inputTurnId, inputCursor, coveredInputs) => {
      if (admittedWarmAgentInputs.has(inputTurnId)) return false;
      const targetSourceJid = resolveStickyChannelOwner(
        replySourceImJid,
        newSourceJid,
      );
      let nextRuntime: ChannelTurnRuntime | undefined;
      let nextScope: ActiveChannelOutboxScope | undefined;
      let nextLifecycle: typeof activeAgentDurableCardLifecycle;
      if (targetSourceJid) {
        const nextAddress = parseChannelAddress(targetSourceJid);
        const nextGroup = nextAddress
          ? getRegisteredGroup(channelConversationJid(targetSourceJid))
          : undefined;
        const nextAccountId =
          nextAddress?.channelAccountId ?? nextGroup?.channel_account_id;
        if (!nextAddress || !nextAccountId) return false;
        nextRuntime = ChannelTurnRuntime.start({
          provider: nextAddress.provider,
          accountId: nextAccountId,
          sourceJid: targetSourceJid,
          chatId: nextAddress.externalChatId,
          rootId: nextAddress.rootMessageId,
          threadId: nextAddress.threadId,
          externalMessageId: inputCursor?.id ?? inputTurnId,
          agentId,
          sessionId: currentAgentSessionId,
        });
        if (nextRuntime.executionDisposition !== 'execute') {
          nextRuntime.dispose();
          return false;
        }
        nextLifecycle =
          publishesFrameworkAnswer(interactionMode) &&
          nextAddress.provider === 'feishu'
            ? nextRuntime.reserveStreamingCard()
            : undefined;
        if (
          publishesFrameworkAnswer(interactionMode) &&
          nextAddress.provider === 'feishu' &&
          !nextLifecycle
        ) {
          nextRuntime.retry('Unable to reserve warm agent card');
          nextRuntime.dispose();
          return false;
        }
        nextScope = bindChannelOutboxScope(agentAdmissionKey, nextRuntime, {
          provider: nextAddress.provider,
          accountId: nextAccountId,
          sourceJid: targetSourceJid,
          chatId: nextAddress.externalChatId,
          rootId: nextAddress.rootMessageId,
          threadId: nextAddress.threadId,
        });
        agentChannelTurnRuntimes.set(inputTurnId, nextRuntime);
        agentChannelOutboxScopesByInput.set(inputTurnId, nextScope);
      }
      admittedWarmAgentInputs.set(inputTurnId, {
        sourceJid: newSourceJid,
        imJid: targetSourceJid,
        runtime: nextRuntime,
        scope: nextScope,
        lifecycle: nextLifecycle,
      });
      agentAnyReplyProjectedByInput.set(inputTurnId, false);
      agentGenuineReplyDeliveredByInput.set(inputTurnId, false);
      const exactInputs =
        coveredInputs && coveredInputs.length > 0
          ? coveredInputs
          : [{ id: inputTurnId, sourceJid: newSourceJid ?? undefined }];
      const exactInputIds = [...new Set(exactInputs.map((input) => input.id))];
      agentProcessingIndicatorInputsByCompletion.set(
        inputTurnId,
        exactInputIds,
      );
      agentProcessingTypingLeaseIdsByCompletion.set(inputTurnId, inputTurnId);
      const fallbackProcessingIndicatorJid =
        newSourceJid && getChannelType(newSourceJid)
          ? newSourceJid
          : targetSourceJid;
      for (const exactInput of exactInputs) {
        const processingIndicatorJid =
          exactInput.sourceJid && getChannelType(exactInput.sourceJid)
            ? exactInput.sourceJid
            : fallbackProcessingIndicatorJid;
        if (processingIndicatorJid) {
          agentProcessingIndicatorJidsByInput.set(
            exactInput.id,
            processingIndicatorJid,
          );
          trackProcessingIndicator(
            virtualChatJid,
            exactInput.id,
            processingIndicatorJid,
          );
        }
      }
      return {
        rollback: () => {
          const admitted = admittedWarmAgentInputs.get(inputTurnId);
          if (!admitted) return;
          admittedWarmAgentInputs.delete(inputTurnId);
          agentChannelTurnRuntimes.delete(inputTurnId);
          agentChannelOutboxScopesByInput.delete(inputTurnId);
          agentAnyReplyProjectedByInput.delete(inputTurnId);
          agentGenuineReplyDeliveredByInput.delete(inputTurnId);
          activeChannelOutboxScopes.unbind(agentAdmissionKey, admitted.scope);
          if (admitted.runtime) {
            const cardRolledBack = admitted.lifecycle
              ? admitted.runtime.rollbackUnpublishedStreamingCardReservation()
              : true;
            if (cardRolledBack) {
              admitted.runtime.retry(
                'IPC publish failed after warm agent admission',
              );
            } else {
              admitted.runtime.interrupt(
                'Warm agent admission could not safely roll back its unpublished card',
              );
            }
            admitted.runtime.dispose();
          }
        },
      };
    },
  );
  // 用户在挂起期间发来新消息 → 先定稿旧卡、开新卡（注入点在 web.ts /
  // 消息循环，经 activeHeldCardFinalizers 以 virtualChatJid 为键触达）。
  activeHeldCardFinalizers.set(virtualChatJid, (newSourceJid, inputTurnId) => {
    const admittedInput = inputTurnId
      ? admittedWarmAgentInputs.get(inputTurnId)
      : undefined;
    if (inputTurnId && !admittedInput) return;
    const admittedAgentLifecycle = admittedInput?.lifecycle;
    const agentInputAdmitted = !!admittedInput;
    let targetSourceJid =
      admittedInput?.imJid ??
      resolveStickyChannelOwner(replySourceImJid, newSourceJid ?? null);
    if (!replySourceImJid && targetSourceJid) {
      targetSourceJid = setSessionChannelOwnerOnce(
        effectiveGroup.folder,
        agentId,
        targetSourceJid,
      );
      if (!getAgent(agentId)?.last_im_jid) {
        updateAgentLastImJid(agentId, targetSourceJid);
      }
    }
    if (inputTurnId) {
      activeAgentInputTurnId = inputTurnId;
      bindAgentTurnOutputCoordinator(inputTurnId);
      lastAgentReplyMsgId = undefined;
      lastAgentReplyText = undefined;
      agentReplySentByInput.set(inputTurnId, false);
      agentAnyReplyProjectedByInput.set(inputTurnId, false);
      agentPhysicalDeliveryAckByInput.set(inputTurnId, false);
      const typingTransportJid = targetSourceJid ?? virtualChatJid;
      const typingReady = setTyping(
        virtualChatJid,
        true,
        inputTurnId,
        typingTransportJid,
      );
      trackTypingIndicator(
        virtualChatJid,
        inputTurnId,
        typingTransportJid,
        typingReady,
      );
    }
    if (inputTurnId && targetSourceJid) {
      agentChannelTurnRuntime = admittedInput?.runtime;
      agentChannelOutboxScope = admittedInput?.scope;
      activeAgentDurableCardLifecycle = admittedInput?.lifecycle;
      replySourceImJid = targetSourceJid;
      activeImReplyRoutes.set(virtualChatJid, targetSourceJid);
    }
    // Reservation is durable, but projection activation belongs to the first
    // runner output carrying this inputTurnId. Keep A's card untouched while
    // B is merely queued/published.
    if (agentInputAdmitted) return;
    const previousAgentSession = agentStreamingSession;
    agentStreamingSession = undefined;
    if (streamingSessionJid) {
      unregisterStreamingSession(streamingSessionJid);
    }
    void (async () => {
      if (heldAgentParts.length > 0) {
        const txt = heldAgentParts.join(HELD_TURN_DIVIDER);
        heldAgentParts = [];
        heldAgentUsage = null;
        heldAgentDbMsgId = null;
        heldAgentDbTurnId = null;
        if (previousAgentSession?.isActive()) {
          try {
            await previousAgentSession.complete(txt);
          } catch {
            await previousAgentSession.abort('').catch(() => {});
          }
        }
      } else if (previousAgentSession?.isActive()) {
        await previousAgentSession.abort('新消息已开始').catch(() => {});
      }
      previousAgentSession?.dispose();
      agentStreamingAccText = '';
      agentStreamingSession =
        targetSourceJid && inputTurnId && agentInputAdmitted
          ? await imManager
              .createStreamingSession(
                targetSourceJid,
                (messageId) =>
                  registerMessageIdMapping(messageId, streamingSessionJid!),
                admittedAgentLifecycle,
              )
              .catch(() => undefined)
          : undefined;
      if (agentStreamingSession && streamingSessionJid) {
        registerStreamingSession(streamingSessionJid, agentStreamingSession);
        if (inputTurnId) {
          agentStreamingSessionsByInput.set(inputTurnId, {
            session: agentStreamingSession,
            jid: streamingSessionJid,
          });
        }
      }
    })().catch((err) => {
      logger.warn(
        { err, chatJid, agentId, inputTurnId },
        'Failed to rotate agent streaming card on new message',
      );
    });
  });

  const activateAgentProjectionForInput = async (
    inputTurnId: string | undefined,
  ): Promise<void> => {
    if (!inputTurnId) return;
    const existing = agentStreamingSessionsByInput.get(inputTurnId);
    if (existing) {
      agentStreamingSession = existing.session;
      return;
    }
    const admitted = admittedWarmAgentInputs.get(inputTurnId);
    if (!admitted?.imJid || !admitted.lifecycle || !streamingSessionJid) return;
    const session = await imManager
      .createStreamingSession(
        admitted.imJid,
        (messageId) => registerMessageIdMapping(messageId, streamingSessionJid),
        admitted.lifecycle,
      )
      .catch((error) => {
        logger.error(
          { error, chatJid, agentId, inputTurnId },
          'Failed to activate pre-admitted agent streaming projection',
        );
        return undefined;
      });
    if (!session) return;
    agentStreamingSessionsByInput.set(inputTurnId, {
      session,
      jid: streamingSessionJid,
    });
    registerStreamingSession(streamingSessionJid, session);
    agentStreamingSession = session;
    agentStreamingAccText = '';
  };

  // Track idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const agentRunnerIdleCloseMs = resolveRunnerLivenessTimeouts({
    executionTimeoutMs:
      effectiveGroup.containerConfig?.timeout ??
      getSystemSettings().containerTimeout,
    idleTimeoutMs: getSystemSettings().idleTimeout,
  }).idleCloseMs;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { agentId, chatJid },
        'Agent conversation idle timeout, closing stdin',
      );
      queue.closeStdin(virtualJid);
    }, agentRunnerIdleCloseMs);
  };

  const cursorCommittedInputTurns = new Set<string>();
  let retryUnfinishedTurn = false;
  let agentProviderFailoverPending = false;
  let agentDeliveryNeedsManualReconciliation = false;
  let agentDeterministicTerminalError: string | null = null;
  let hadError = false;
  let lastError = '';
  let lastAgentReplyMsgId: string | undefined;
  let lastAgentReplyText: string | undefined;
  const agentReplySentByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  const agentAnyReplyProjectedByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  const agentGenuineReplyDeliveredByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  const agentPhysicalDeliveryAckByInput = new Map<string, boolean>([
    [lastProcessed.id, false],
  ]);
  const proactiveAgentTailNoticesDelivered = new Set<string>();
  const notifyProactiveAgentTailInterruption = async (
    inputTurnId: string,
  ): Promise<boolean> => {
    if (
      proactiveAgentTailNoticesDelivered.has(inputTurnId) ||
      !shouldSendProactiveTailInterruptionNotice({
        mode: interactionMode,
        utteranceDelivered:
          agentPhysicalDeliveryAckByInput.get(inputTurnId) === true,
        runnerFailed: true,
        healthyInputTurnCompleted:
          healthyAgentCompletedInputTurns.has(inputTurnId),
      })
    ) {
      return false;
    }
    proactiveAgentTailNoticesDelivered.add(inputTurnId);
    const scope = agentChannelOutboxScopesByInput.get(inputTurnId);
    return deliverProactiveTailInterruptionNotice({
      logicalChatJid: virtualChatJid,
      scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
      inputTurnId,
      agentId,
      targetJid: scope?.sourceJid ?? replySourceImJid,
      scope,
    });
  };
  const currentAgentSourceJid = lastProcessed.source_jid || chatJid;
  const currentAgentChannelContext = resolveBatchChannelContext(
    missedMessages,
    chatJid,
    agentId,
  );
  bindActiveChannelTurn(
    channelTurnScope(effectiveGroup.folder, agentId),
    lastProcessed.id,
    currentAgentChannelContext,
  );
  const isCursorCommitted = (inputTurnId = activeAgentInputTurnId): boolean =>
    cursorCommittedInputTurns.has(inputTurnId);
  const commitCursor = (inputTurnId = activeAgentInputTurnId): void => {
    if (isCursorCommitted(inputTurnId)) return;
    advanceCursors(virtualChatJid, {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    });
    flushAcknowledgedIpcForJid(virtualChatJid);
    cursorCommittedInputTurns.add(inputTurnId);
  };

  const wrappedOnOutput = async (output: ContainerOutput) => {
    // #547: warm-lifecycle bookkeeping — mark activity, and flag query-idle on
    // a substantive result / interruption so the runner can be kept warm.
    queue.markRunnerActivity(virtualJid);
    const isInterruptStatus =
      output.status === 'stream' &&
      output.streamEvent?.eventType === 'status' &&
      output.streamEvent.statusText === 'interrupted';
    const isUsageEvent =
      output.status === 'stream' && output.streamEvent?.eventType === 'usage';
    if (
      !isInterruptStatus &&
      !isUsageEvent &&
      steeringTransitions.shouldSuppressOutput(
        virtualChatJid,
        output.turnId || output.streamEvent?.turnId,
      )
    ) {
      logger.info(
        {
          chatJid,
          agentId,
          virtualChatJid,
          turnId: output.turnId || output.streamEvent?.turnId,
          status: output.status,
          eventType: output.streamEvent?.eventType,
        },
        'Superseded agent turn output suppressed during steer transition',
      );
      return;
    }
    await activateAgentProjectionForInput(output.inputTurnId);
    if (
      output.ipcReceipts?.length &&
      (!output.providerFailure || output.providerFailureTerminal === true)
    ) {
      queue.acknowledgeIpcDeliveries(
        virtualJid,
        output.ipcReceipts,
        commitIpcDeliveryReceipts,
      );
    }
    if (output.inputTurnCompleted) {
      const completedInputTurnIds = output.ipcReceipts?.length
        ? output.ipcReceipts.map((receipt) => receipt.deliveryId)
        : [output.inputTurnId ?? lastProcessed.id];
      for (const inputTurnId of completedInputTurnIds) {
        healthyAgentCompletedInputTurns.add(inputTurnId);
      }
      const completedInputs = output.ipcReceipts?.length
        ? output.ipcReceipts.flatMap((receipt) =>
            (receipt.coveredCursors ?? [receipt.cursor]).map((cursor) => ({
              chatJid: receipt.chatJid,
              messageId: cursor.id,
            })),
          )
        : [{ chatJid: virtualChatJid, messageId: lastProcessed.id }];
      activeAgentBuilderTurns.clearCompleted(
        agentBuilderScope,
        completedInputs,
      );
    }
    if (
      output.queryIdle === true ||
      (output.status === 'stream' &&
        output.streamEvent?.eventType === 'status' &&
        output.streamEvent.statusText === 'interrupted')
    ) {
      queue.markRunnerQueryIdle(virtualJid);
    }

    // #549: a provider switch surfaced as a failure clears the agent session so
    // the next turn starts fresh on the newly-selected provider.
    if (output.providerFailure) {
      try {
        deleteSession(effectiveGroup.folder, agentId);
        currentAgentSessionId = undefined;
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId, folder: effectiveGroup.folder },
          'Failed to clear agent session after provider failure',
        );
      }
    }

    // Container drained/_closed the in-flight query — remember it so the finally
    // block finalizes the card (the message will be retried) instead of leaving
    // a zombie 生成中 card.
    if (output.status === 'closed') agentClosed = true;

    // Track session
    if (
      output.newSessionId &&
      output.status !== 'error' &&
      !output.providerFailure
    ) {
      setSession(effectiveGroup.folder, output.newSessionId, agentId, {
        agentProfileId: agentProfile?.id,
        agentProfileVersion: agentProfile?.version,
        identityHash: agentProfile?.identity_hash,
      });
      currentAgentSessionId = output.newSessionId;
    }

    // Stream events
    if (output.status === 'stream' && output.streamEvent) {
      if (output.streamEvent.workflowRun) {
        const run = output.streamEvent.workflowRun;
        activeAgentWorkflowRuns = [
          ...activeAgentWorkflowRuns.filter(
            (item) => item.taskId !== run.taskId,
          ),
          run,
        ];
        if (run.status !== 'running') {
          completedAgentWorkflowRuns = [
            ...completedAgentWorkflowRuns.filter(
              (item) => item.taskId !== run.taskId,
            ),
            run,
          ];
        }
      }
      // ── 截断续写触顶信号（机器标记，不广播不展示）──
      if (
        output.streamEvent.eventType === 'status' &&
        output.streamEvent.statusText === TRUNCATION_EXHAUSTED_STATUS
      ) {
        if (heldAgentParts.length > 0) {
          finalizeHeldAgentDbMessage(
            '自动续写未能完成（上游连续断流），以上为已生成内容',
            'truncated',
          );
          heldAgentParts = [];
          heldAgentUsage = null;
          if (agentStreamingSession?.isActive()) {
            await agentStreamingSession
              .abort('自动续写未能完成（上游连续断流），以上为已生成内容')
              .catch(() => {});
          }
        }
        return;
      }
      // Keep live Web/Feishu cost on the same Kaboo ledger authority as the
      // persisted usage page. The later write is replay-safe on eventId.
      if (
        output.streamEvent.eventType === 'usage' &&
        output.streamEvent.usage
      ) {
        try {
          const accounting = writeUsageRecords({
            userId:
              effectiveGroup.created_by ||
              registeredGroups[chatJid]?.created_by ||
              'system',
            groupFolder: effectiveGroup.folder,
            agentId,
            messageId: lastAgentReplyMsgId,
            source: chatJid.split(':', 1)[0] || 'unknown',
            usage: output.streamEvent.usage,
          });
          output.streamEvent.usage.costUSD =
            accounting.providerEstimatedCostUSD;
        } catch (err) {
          logger.warn(
            { err, chatJid, agentId },
            'Failed to normalize agent usage cost before stream delivery',
          );
        }
        const ledgerUsage = output.streamEvent.usage;
        pendingAgentLedgerUsageBatch = mergeHeldUsage(
          pendingAgentLedgerUsageBatch,
          ledgerUsage,
        );
        const batchIndex = Math.max(0, ledgerUsage.batchIndex || 0);
        const batchCount = Math.max(1, ledgerUsage.batchCount || 1);
        if (batchIndex < batchCount - 1) return;
        output.streamEvent.usage = {
          ...pendingAgentLedgerUsageBatch,
          eventId: ledgerUsage.eventId,
          batchIndex,
          batchCount,
        };
        pendingAgentLedgerUsageBatch = null;
      }
      const agentStreamInputTurnId = output.inputTurnId ?? lastProcessed.id;
      // Native-message mode has no framework-owned Assistant answer lane.
      // Keeping hidden deltas out of the reducer also prevents a later empty
      // success from resurrecting them into the virtual Web conversation.
      const agentAnswerProjection = publishesFrameworkAnswer(interactionMode)
        ? (
            agentTurnOutputCoordinators.get(agentStreamInputTurnId) ??
            bindAgentTurnOutputCoordinator(agentStreamInputTurnId)
          ).reduceStreamEvent(output.streamEvent)
        : null;
      if (agentAnswerProjection?.visibleAnswerChanged) {
        agentStreamingAccText = agentAnswerProjection.visibleAnswerText;
      }
      if (shouldBroadcastSdkStreamEvent(interactionMode, output.streamEvent)) {
        broadcastStreamEvent(chatJid, output.streamEvent, agentId);
      }

      // ── Feed stream events into Feishu streaming card ──
      if (agentStreamingSession) {
        const se = output.streamEvent;
        if (
          agentAnswerProjection?.visibleAnswerChanged &&
          agentStreamingSession.isActive()
        ) {
          agentStreamingSession.append(
            heldAgentBaseText() + agentAnswerProjection.visibleAnswerText,
          );
        }
        if (se.eventType === 'usage' && se.usage && heldAgentParts.length > 0) {
          // 挂起中：累计 usage 增量，不喂卡（定稿后合并补丁）
          heldAgentUsage = mergeHeldUsage(heldAgentUsage, se.usage);
        } else if (
          se.eventType === 'usage' &&
          se.usage &&
          heldAgentUsagePatchPending
        ) {
          // 挂起回合刚定稿：合并挂起期累计 + 最终 turn 的 usage 打到卡上
          heldAgentUsagePatchPending = false;
          const merged = heldAgentUsage
            ? mergeHeldUsage(heldAgentUsage, se.usage)
            : se.usage;
          heldAgentUsage = null;
          void agentStreamingSession.patchUsageNote(merged);
        } else if (!(se.eventType === 'text_delta' && !se.parentToolUseId)) {
          feedStreamEventToCard(
            agentStreamingSession,
            se,
            heldAgentBaseText() + agentStreamingAccText,
            buildWebTraceUrl(
              effectiveGroup.folder,
              se.turnId || lastProcessed.id,
            ),
          );
        }
      }

      // ── 中断时立即保存已输出内容 ──
      if (
        output.streamEvent.eventType === 'status' &&
        output.streamEvent.statusText === 'interrupted'
      ) {
        const steered = resolveSteeringInterrupt(
          virtualChatJid,
          output.streamEvent.turnId || output.turnId,
        );
        agentStreamInterrupted = true;
        agentStreamSteered ||= steered;
        // 引导是正常换向：干净收束已有内容；显式停止才显示中性停止状态。
        if (heldAgentParts.length > 0) {
          const heldText = heldAgentParts.join(HELD_TURN_DIVIDER);
          finalizeHeldAgentDbMessage(
            steered ? null : '已停止',
            'interrupted',
            false,
          );
          heldAgentParts = [];
          heldAgentUsage = null;
          if (agentStreamingSession?.isActive()) {
            if (steered) {
              await agentStreamingSession.complete(heldText).catch(() => {});
            } else {
              await agentStreamingSession.abort('已停止').catch(() => {});
            }
          }
        }
        if (
          publishesFrameworkAnswer(interactionMode) &&
          !isCursorCommitted(output.inputTurnId ?? activeAgentInputTurnId)
        ) {
          const interruptedText = steered
            ? buildSteeredReply(agentStreamingAccText)
            : buildStoppedReply(agentStreamingAccText);
          try {
            if (agentStreamingSession?.isActive()) {
              if (steered) {
                await agentStreamingSession
                  .complete(agentStreamingAccText)
                  .catch(() => {});
              } else {
                await agentStreamingSession.abort('已停止').catch(() => {});
              }
            }
            if (interruptedText) {
              const msgId = crypto.randomUUID();
              const timestamp = new Date().toISOString();
              ensureChatExists(virtualChatJid);
              const persistedMsgId = storeMessageDirect(
                msgId,
                virtualChatJid,
                'happyclaw-agent',
                ASSISTANT_NAME,
                interruptedText,
                timestamp,
                true,
                {
                  meta: {
                    turnId: output.streamEvent.turnId || lastProcessed.id,
                    sessionId:
                      output.streamEvent.sessionId || currentAgentSessionId,
                    sourceKind: 'interrupt_partial',
                    finalizationReason: 'interrupted',
                  },
                },
              );
              broadcastNewMessage(
                virtualChatJid,
                {
                  id: persistedMsgId,
                  chat_jid: virtualChatJid,
                  sender: 'happyclaw-agent',
                  sender_name: ASSISTANT_NAME,
                  content: interruptedText,
                  timestamp,
                  is_from_me: true,
                  turn_id: output.streamEvent.turnId || lastProcessed.id,
                  session_id:
                    output.streamEvent.sessionId || currentAgentSessionId,
                  sdk_message_uuid: null,
                  source_kind: 'interrupt_partial',
                  finalization_reason: 'interrupted',
                },
                agentId,
              );
            }
            agentInterruptFinalized = true;
            clearStreamingSnapshot(virtualChatJid);
            agentStreamingAccText = '';
            // A deliberate stop/steer owns the superseded input: it must not
            // be rediscovered from DB history after the warm runner settles.
            commitCursor(output.inputTurnId ?? activeAgentInputTurnId);
          } catch (err) {
            logger.warn(
              { err, chatJid, agentId },
              'Failed to save interrupted agent text on status event',
            );
          }
        }
      }

      // Persist token usage for agent conversations
      if (
        output.streamEvent.eventType === 'usage' &&
        output.streamEvent.usage
      ) {
        try {
          // Sub-Agent 的 effectiveGroup 可能没有 created_by，从父群组继承
          writeUsageRecords({
            userId:
              effectiveGroup.created_by ||
              registeredGroups[chatJid]?.created_by ||
              'system',
            groupFolder: effectiveGroup.folder,
            agentId,
            messageId: lastAgentReplyMsgId,
            source: chatJid.split(':', 1)[0] || 'unknown',
            usage: output.streamEvent.usage,
          });
          if (lastAgentReplyMsgId) {
            rebuildMessageTokenUsageFromLedger(
              virtualChatJid,
              effectiveGroup.folder,
              lastAgentReplyMsgId,
            );
          } else {
            updateLatestMessageTokenUsage(
              virtualChatJid,
              JSON.stringify(output.streamEvent.usage),
              undefined,
              output.streamEvent.usage.costUSD,
            );
          }
        } catch (err) {
          logger.warn(
            { err, chatJid, agentId },
            'Failed to persist agent conversation token usage',
          );
        }
      }

      // Reset idle timer on stream events so long-running tool calls
      // don't get killed while the agent is actively working.
      resetIdleTimer();
      return;
    }

    if (!publishesFrameworkAnswer(interactionMode) && !output.providerFailure) {
      const proactiveInputId = resolveContainerOutputInputTurnId(
        output,
        lastProcessed.id,
      );
      if (output.proactiveFinalCandidate?.trim()) {
        const outputScope =
          agentChannelOutboxScopesByInput.get(proactiveInputId);
        const recovery = await recoverProactiveFinalCandidate({
          registry: activeTurnOutputs,
          scopeKey: agentAdmissionKey,
          inputTurnId: proactiveInputId,
          inputTurnCompleted: output.inputTurnCompleted,
          candidate: output.proactiveFinalCandidate,
          canDeliver: () =>
            canDeliverTurnUtterance(
              effectiveGroup.folder,
              agentId,
              proactiveInputId,
            ),
          deliver: (text) =>
            deliverProactiveFinalFallback({
              logicalChatJid: virtualChatJid,
              scopeKey: agentAdmissionKey,
              inputTurnId: proactiveInputId,
              text,
              sessionId: currentAgentSessionId,
              agentId,
              targetJid: outputScope?.sourceJid ?? replySourceImJid,
              scope: outputScope,
            }),
        });
        if (recovery.projected) {
          agentReplySentByInput.set(proactiveInputId, true);
          agentAnyReplyProjectedByInput.set(proactiveInputId, true);
        }
        if (recovery.targetDelivered) {
          agentPhysicalDeliveryAckByInput.set(proactiveInputId, true);
          agentGenuineReplyDeliveredByInput.set(proactiveInputId, true);
        }
        logger[recovery.projected ? 'warn' : 'info'](
          {
            chatJid,
            agentId,
            inputTurnId: proactiveInputId,
            recoveryReason: recovery.reason,
            deliveryPath: recovery.path,
            targetDelivered: recovery.targetDelivered,
          },
          recovery.projected
            ? 'Recovered Proactive agent SDK final that was not sent through send_message'
            : 'Proactive agent SDK final recovery not required',
        );
      }
      output.result = null;
      if (
        isProactiveControlPlaneSuccess({
          mode: interactionMode,
          status: output.status,
          providerFailure: output.providerFailure,
        })
      ) {
        if (output.inputTurnCompleted) {
          if (await completeAgentChannelRuntimesForOutput(output)) {
            commitCursor(
              resolveContainerOutputInputTurnId(output, lastProcessed.id),
            );
          }
          finalizeProactiveAgentOutputCoordinators(output);
          broadcastStreamEvent(
            chatJid,
            {
              eventType: 'status',
              statusText: 'idle',
              turnId: output.inputTurnId ?? lastProcessed.id,
              sessionId: currentAgentSessionId,
            },
            agentId,
          );
        }
        resetIdleTimer();
        // All successful Proactive outputs are lifecycle data. This covers
        // background-task interim results and SIGTERM session snapshots too.
        return;
      }
    }

    // Provider failures remain invisible while another healthy provider can
    // replay the durable input. Only pool exhaustion becomes a terminal reply.
    if (output.providerFailure) {
      const providerFailureInputId = resolveContainerOutputInputTurnId(
        output,
        lastProcessed.id,
      );
      rollbackIdleAgentCardReservation(providerFailureInputId);
      if (output.providerFailureTerminal !== true) {
        agentProviderFailoverPending = true;
        retryUnfinishedTurn = !healthyAgentCompletedInputTurns.has(
          providerFailureInputId,
        );
        logger.warn(
          { chatJid, agentId, inputTurnId: providerFailureInputId },
          'Agent provider failure kept retryable for failover',
        );
        resetIdleTimer();
        return;
      }
      output.result = PROVIDER_FAILURE_USER_NOTICE;
      logger.warn(
        {
          chatJid,
          agentId,
        },
        'Provider failure surfaced to user',
      );
    }

    if (
      shouldResolveFrameworkPrimaryAnswer({
        mode: interactionMode,
        status: output.status,
        sourceKind: output.sourceKind,
        providerFailure: output.providerFailure,
      })
    ) {
      const resultInputTurnId = resolveContainerOutputInputTurnId(
        output,
        lastProcessed.id,
      );
      const projectionDecision = decideAssistantPrimaryProjection({
        canonicalInputTurnId: resultInputTurnId,
        status: output.status,
        result: output.result,
        sourceKind: output.sourceKind,
        inputTurnId: output.inputTurnId,
        ipcReceiptCount: output.ipcReceipts?.length,
        inputTurnCompleted: output.inputTurnCompleted,
        finalizationReason: output.finalizationReason,
        pendingBgTasks: output.pendingBgTasks,
        sdkMessageUuid: output.sdkMessageUuid,
        primaryAlreadyProjected:
          agentGenuineReplyDeliveredByInput.get(resultInputTurnId) === true,
        anyReplyProjected:
          agentAnyReplyProjectedByInput.get(resultInputTurnId) === true,
      });
      if (!projectionDecision.project) {
        output.result = null;
        if (
          output.inputTurnCompleted &&
          (await completeAgentChannelRuntimesForOutput(output))
        ) {
          commitCursor(resultInputTurnId);
        }
        logger.info(
          {
            chatJid,
            agentId,
            inputTurnId: resultInputTurnId,
            reason: projectionDecision.reason,
          },
          'Conversation Assistant terminal output handled as lifecycle-only',
        );
        resetIdleTimer();
        return;
      }
      const coordinator =
        agentTurnOutputCoordinators.get(resultInputTurnId) ??
        bindAgentTurnOutputCoordinator(resultInputTurnId);
      output.result = coordinator.resolvePrimaryAnswer(output.result).text;
    }

    // Agent reply
    if (output.result) {
      const outputAgentScope = agentScopeForOutput(output);
      if (outputAgentScope.rejected) {
        hadError = true;
        logger.error(
          { chatJid, agentId, inputTurnId: outputAgentScope.inputId },
          'Suppressing agent output for a warm input that failed durable admission',
        );
        return;
      }
      const outputAgentCardProjection = agentStreamingSessionsByInput.get(
        outputAgentScope.inputId,
      );
      const outputAgentStreamingSession = outputAgentCardProjection?.session;
      const outputAgentReplySourceJid =
        outputAgentScope.scope?.sourceJid ?? replySourceImJid;
      if (outputAgentReplySourceJid && !outputAgentScope.scope) {
        hadError = true;
        logger.error(
          { chatJid, agentId, inputTurnId: outputAgentScope.inputId },
          'Suppressing agent IM output without an exact durable turn scope',
        );
        return;
      }
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      let text = stripAgentInternalTags(raw);
      if (
        output.sourceKind === 'overflow_partial' ||
        output.sourceKind === 'compact_partial'
      ) {
        // Spawn agents are fire-and-forget: context compression is an internal
        // detail. Don't append the "上下文压缩中" suffix — it confuses users
        // seeing the Feishu card suddenly change to a warning.
        if (agent.kind !== 'spawn') {
          text = buildOverflowPartialReply(text);
        }
      }
      // Suppress system-maintenance noise from auto_continue outputs (issue #275).
      // Short acknowledgements ("OK", "已更新 CLAUDE.md") that leak from the
      // compaction pipeline are dropped; substantive continuations pass through.
      if (
        output.sourceKind === 'auto_continue' &&
        isSystemMaintenanceNoise(text)
      ) {
        logger.info(
          { chatJid, agentId, textLen: text.length },
          'auto_continue output suppressed (system maintenance noise)',
        );
        return;
      }
      if (text) {
        // ── 挂起判定（消息级，与卡片存在性解耦，对齐主路径）──
        const isPartialOutput =
          output.sourceKind === 'compact_partial' ||
          output.sourceKind === 'overflow_partial';
        const holdReason: 'bg_tasks' | 'truncated' | null =
          output.finalizationReason === 'truncated' || isPartialOutput
            ? 'truncated'
            : (output.pendingBgTasks ?? 0) > 0
              ? 'bg_tasks'
              : null;
        // 状态提示追加进正文（DB / Web / 卡片转录一致可见）
        if (output.finalizationReason === 'truncated') {
          text += '\n\n> ⚠️ 回复在生成中被上游截断，正在自动续写…';
        } else if ((output.pendingBgTasks ?? 0) > 0) {
          text += `\n\n> ⏳ ${output.pendingBgTasks} 个后台任务运行中，完成后将继续汇总`;
        }
        if (!holdReason) text = stripRedundantCompletionPreamble(text);
        heldAgentUsagePatchPending = false;
        const isFirstReply = !(
          agentReplySentByInput.get(outputAgentScope.inputId) ?? false
        );
        // ── 挂起序列 DB 合并：全渠道一条回复 ──
        // 序列内所有 turn 复用第一个 held turn 的消息 id 与 turnId，
        // INSERT OR REPLACE 覆盖同一行，正文为按时间序拼接的全量内容；
        // Web 端按消息 id 原地替换气泡。
        const heldBaseForDb = heldAgentBaseText();
        const inHeldSeq = holdReason !== null || heldAgentDbMsgId !== null;
        const msgId = heldAgentDbMsgId ?? crypto.randomUUID();
        // Keep progress visible while held, then replace it with the final
        // answer so process narration never becomes part of the conclusion.
        const dbText = holdReason ? heldBaseForDb + text : text;
        const dbTurnId = inHeldSeq
          ? heldAgentDbTurnId || outputAgentScope.inputId
          : outputAgentScope.inputId;
        lastAgentReplyMsgId = msgId;
        lastAgentReplyText = dbText;
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happyclaw-agent',
          ASSISTANT_NAME,
          dbText,
          timestamp,
          true,
          {
            meta: {
              turnId: dbTurnId,
              sessionId: output.sessionId || currentAgentSessionId,
              sdkMessageUuid: output.sdkMessageUuid,
              sourceKind: output.sourceKind || 'sdk_final',
              finalizationReason: output.finalizationReason || 'completed',
            },
          },
        );
        if (holdReason) {
          heldAgentDbMsgId = persistedMsgId;
          heldAgentDbTurnId = dbTurnId;
        } else {
          heldAgentDbMsgId = null;
          heldAgentDbTurnId = null;
        }
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happyclaw-agent',
            sender_name: ASSISTANT_NAME,
            content: dbText,
            timestamp,
            is_from_me: true,
            turn_id: dbTurnId,
            session_id: output.sessionId || currentAgentSessionId,
            sdk_message_uuid: output.sdkMessageUuid ?? null,
            source_kind: output.sourceKind || 'sdk_final',
            finalization_reason: output.finalizationReason || 'completed',
            workflow_runs: holdReason
              ? activeAgentWorkflowRuns
              : completedAgentWorkflowRuns,
          },
          agentId,
        );
        // Persistence/Web projection is independent from physical IM ACK.
        // A held Feishu card deliberately has no final delivery ACK yet, but
        // its canonical DB/Web checkpoint must still block a trailing
        // session-only success from resurrecting the same SDK candidate.
        agentAnyReplyProjectedByInput.set(outputAgentScope.inputId, true);
        if (!holdReason) {
          activeAgentWorkflowRuns = [];
          completedAgentWorkflowRuns = [];
        }

        // Async LLM title upgrade after the first substantive reply.
        if (isFirstReply && agent.kind === 'conversation') {
          const fresh = getAgent(agentId);
          if (fresh?.title_source === 'auto_pending') {
            void generateAndApplyLLMTitle(agentId, chatJid, virtualChatJid);
          }
        }

        const localImagePaths = extractLocalImImagePaths(
          text,
          effectiveGroup.folder,
        );

        // ── Complete or hold Feishu streaming card, or fall back to static ──
        let streamingCardHandledIM = false;
        let agentCardAttachmentsDelivered = true;
        let agentStaticImDelivered = false;
        let pendingAgentCardCompletion:
          | NonNullable<typeof outputAgentStreamingSession>
          | undefined;
        if (holdReason) {
          // 挂起：不定稿，正文进 heldAgentParts，有卡片则状态行提示，后续
          // turn 的流式增量继续追加到同一张卡（Sub 路径 session 本就不轮换）。
          heldAgentParts.push(text);
          agentStreamingAccText = '';
          if (outputAgentStreamingSession?.isActive()) {
            streamingCardHandledIM = true;
            const holdNote =
              holdReason === 'truncated'
                ? '检测到上游断流，自动续写中…'
                : `${output.pendingBgTasks} 个后台任务运行中，完成后将继续汇总`;
            outputAgentStreamingSession.setSystemStatus(holdNote);
            if (
              outputAgentStreamingSession instanceof StreamingCardController
            ) {
              outputAgentStreamingSession.setHeldOpen(
                holdReason === 'bg_tasks' ? (output.pendingBgTasks ?? 0) : null,
              );
            }
          }
          logger.info(
            {
              chatJid,
              agentId,
              holdReason,
              pendingBgTasks: output.pendingBgTasks,
              heldParts: heldAgentParts.length,
              cardActive: streamingCardHandledIM,
            },
            'Agent reply held open (background tasks / truncation continue)',
          );
        } else if (outputAgentStreamingSession?.isActive()) {
          // Provisional only: DB/Web persistence above is durable, but the
          // provider card must remain active until every local attachment has
          // a physical, exact-turn Outbox ACK.
          pendingAgentCardCompletion = outputAgentStreamingSession;
          streamingCardHandledIM = true;
        }

        // Provider cards cannot embed local filesystem images. Deliver each
        // attachment through the same exact input Turn Outbox and require all
        // physical ACKs before the Turn/cursor may complete.
        if (
          streamingCardHandledIM &&
          localImagePaths.length > 0 &&
          outputAgentReplySourceJid
        ) {
          for (
            let imageIndex = 0;
            imageIndex < localImagePaths.length;
            imageIndex++
          ) {
            const imagePath = localImagePaths[imageIndex];
            try {
              if (!outputAgentScope.scope) {
                agentCardAttachmentsDelivered = false;
                logger.error(
                  { chatJid, agentId, imagePath },
                  'Suppressed agent card image without an exact durable turn scope',
                );
                continue;
              }
              const imageBuffer = await fs.promises.readFile(imagePath);
              const delivered = await sendTaskImageWithRetry(
                outputAgentReplySourceJid,
                imageBuffer,
                detectImageMimeType(imageBuffer),
                undefined,
                path.basename(imagePath),
                {
                  scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
                  scopeToken: outputAgentScope.scope.token,
                  operationKey: `agent-streaming-card-image:${outputAgentScope.inputId}:${imageIndex}`,
                  ordinalSlot: `agent-streaming-card-image:${imageIndex}`,
                },
              );
              if (!delivered) agentCardAttachmentsDelivered = false;
            } catch (error) {
              agentCardAttachmentsDelivered = false;
              logger.warn(
                { error, chatJid, agentId, imagePath },
                'Agent streaming-card image delivery failed',
              );
            }
          }
        }

        if (pendingAgentCardCompletion) {
          const cardFinalization = await finalizeChannelCardAfterDelivery(
            pendingAgentCardCompletion,
            text,
            agentCardAttachmentsDelivered,
            agentCardAttachmentsDelivered
              ? '回复投递未确认，已切换为消息发送'
              : '附件投递未确认，已切换为消息发送',
          );
          const cardCompleted = cardFinalization.acknowledged;
          if (cardCompleted) {
            // 定稿后等最终 usage 事件做合并补丁（挂起期累计 + 最终 turn）
            heldAgentUsagePatchPending = true;
            heldAgentParts = [];
          } else if (cardFinalization.error) {
            logger.warn(
              { err: cardFinalization.error, chatJid, agentId },
              'Agent streaming card final ACK failed, falling back to exact static delivery',
            );
            heldAgentParts = [];
            heldAgentUsage = null;
          } else {
            logger.error(
              { chatJid, agentId, inputTurnId: outputAgentScope.inputId },
              'Agent streaming card remains unfinished because an attachment was not physically ACKed',
            );
          }
          streamingCardHandledIM = cardCompleted;
          if (cardCompleted) {
            agentStreamingSessionsByInput.delete(outputAgentScope.inputId);
            if (outputAgentStreamingSession === agentStreamingSession) {
              if (outputAgentCardProjection) {
                unregisterStreamingSession(outputAgentCardProjection.jid);
              }
              agentStreamingSession = undefined;
              activeAgentDurableCardLifecycle = undefined;
            }
          }
        }

        if (
          outputAgentReplySourceJid &&
          !streamingCardHandledIM &&
          isFirstReply
        ) {
          // Only send the FIRST substantive reply to IM. Subsequent results
          // (SDK Task completions) are stored in DB but not spammed to IM.
          agentStaticImDelivered = await sendImWithRetry(
            outputAgentReplySourceJid,
            text,
            localImagePaths,
            outputAgentScope.scope
              ? {
                  scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
                  scopeToken: outputAgentScope.scope.token,
                  operationKey: `agent:${agentId}:${lastProcessed.id}:${output.sdkMessageUuid || crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)}`,
                }
              : undefined,
          );
          if (agentStaticImDelivered) {
            logger.info(
              {
                chatJid,
                agentId,
                replySourceImJid: outputAgentReplySourceJid,
                sourceKind: output.sourceKind,
                textLen: text.length,
              },
              'Agent conversation: static IM message sent',
            );
          } else {
            logger.error(
              {
                chatJid,
                agentId,
                replySourceImJid,
                sourceKind: output.sourceKind,
              },
              'Agent conversation: IM send failed after all retries, message lost',
            );
          }
        } else if (!replySourceImJid) {
          logger.debug(
            { chatJid, agentId, sourceKind: output.sourceKind },
            'Agent conversation: no replySourceImJid, skip IM delivery',
          );
        }

        // Optional mirror mode for linked IM channels
        let agentMirrorDeliveryAcknowledged = true;
        for (const [imJid, g] of Object.entries(registeredGroups)) {
          if (g.target_agent_id !== agentId || imJid === replySourceImJid)
            continue;
          if (g.reply_policy !== 'mirror') continue;
          if (!getChannelType(imJid)) continue;
          const mirrorRuntime = agentChannelTurnRuntimes.get(
            outputAgentScope.inputId,
          );
          const mirrorAddress = parseChannelAddress(imJid);
          const mirrorAccountId =
            mirrorAddress?.channelAccountId ?? g.channel_account_id;
          if (!mirrorRuntime || !mirrorAddress || !mirrorAccountId) {
            agentMirrorDeliveryAcknowledged = false;
            logger.error(
              {
                chatJid,
                agentId,
                imJid,
                inputTurnId: outputAgentScope.inputId,
              },
              'Suppressed agent mirror delivery without an exact durable source turn',
            );
            continue;
          }
          const mirrorScope = bindChannelOutboxScope(
            agentAdmissionKey,
            mirrorRuntime,
            {
              provider: mirrorAddress.provider,
              accountId: mirrorAccountId,
              sourceJid: imJid,
              chatId: mirrorAddress.externalChatId,
              rootId: mirrorAddress.rootMessageId,
              threadId: mirrorAddress.threadId,
            },
          );
          agentChannelOutboxScopesByInput.set(
            `${outputAgentScope.inputId}:mirror:${imJid}`,
            mirrorScope,
          );
          const delivered = await sendImWithRetry(
            imJid,
            text,
            localImagePaths,
            {
              scopeKey: agentAdmissionKey,
              scopeToken: mirrorScope.token,
              operationKey: `agent-mirror:${agentId}:${outputAgentScope.inputId}:${imJid}:${output.sdkMessageUuid || crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)}`,
              ordinalSlot: `mirror:${imJid}`,
            },
          );
          agentMirrorDeliveryAcknowledged &&= delivered;
        }

        const agentReplyDeliveryAcknowledged =
          (!outputAgentReplySourceJid ||
            agentPhysicalDeliveryAckByInput.get(outputAgentScope.inputId) ===
              true ||
            (streamingCardHandledIM &&
              !holdReason &&
              agentCardAttachmentsDelivered) ||
            agentStaticImDelivered) &&
          agentMirrorDeliveryAcknowledged;
        if (agentReplyDeliveryAcknowledged) {
          const acknowledgedInputIds = output.ipcReceipts?.length
            ? output.ipcReceipts.map((receipt) => receipt.deliveryId)
            : [output.inputTurnId ?? lastProcessed.id];
          for (const inputId of acknowledgedInputIds) {
            agentPhysicalDeliveryAckByInput.set(inputId, true);
            agentReplySentByInput.set(inputId, true);
            if (
              !holdReason &&
              isGenuineReplyResult({
                holdReason,
                sourceKind: output.sourceKind,
                finalizationReason: output.finalizationReason,
              })
            ) {
              agentGenuineReplyDeliveredByInput.set(inputId, true);
              agentTurnOutputCoordinators.get(inputId)?.markFinalized();
            }
          }
        }

        if (
          output.inputTurnCompleted &&
          (await completeAgentChannelRuntimesForOutput(output))
        ) {
          commitCursor(
            resolveContainerOutputInputTurnId(output, lastProcessed.id),
          );
        }
        resetIdleTimer();

        // Per-turn snapshot cleanup — mirror of the main path (clearStreamingSnapshot
        // after each substantive reply). Conversation agents stay warm for
        // IDLE_TIMEOUT; without this, refreshing the page during the warm window
        // restores a zombie「生成中」spinner from the stale agent snapshot. Skip
        // partials (intermediate compression outputs, not the final reply).
        if (
          !holdReason &&
          output.sourceKind !== 'overflow_partial' &&
          output.sourceKind !== 'compact_partial'
        ) {
          clearStreamingSnapshot(virtualChatJid);
        }

        // Spawn agents are fire-and-forget: close after first reply to free process slot.
        // Conversation agents stay warm and are reclaimed by IDLE_TIMEOUT — closing them
        // after every reply would cold-start the runner each turn (seconds in container mode).
        // A post-reply tool call that hangs is handled runner-side by the post-result
        // interrupt fallback, not by tearing down a warm conversation runner here.
        // Skip for overflow_partial/compact_partial — those are intermediate context
        // compression outputs, not the final result; closing now would kill the agent
        // before it finishes the actual task.
        if (
          agent.kind === 'spawn' &&
          text &&
          output.sourceKind !== 'overflow_partial' &&
          output.sourceKind !== 'compact_partial' &&
          // 有未 settle 的后台任务 / 截断待续写时不能关流——关流会连坐杀掉
          // 还在跑的任务（runner 侧同理保持 query 存活）。等最终 result 再关。
          (output.pendingBgTasks ?? 0) === 0 &&
          output.finalizationReason !== 'truncated'
        ) {
          logger.info(
            { agentId, chatJid },
            'Spawn agent replied, sending close signal',
          );
          queue.closeStdin(virtualChatJid);
        }
      }
    }

    if (output.status === 'error') {
      hadError = true;
      if (output.error) lastError = output.error;
    }
  };

  ipcWatcherManager?.watchGroup(effectiveGroup.folder);
  try {
    agentChannelOutboxScope =
      agentChannelTurnRuntime &&
      replySourceImJid &&
      agentStreamingAddress &&
      agentStreamingAccountId
        ? bindChannelOutboxScope(
            channelTurnScope(effectiveGroup.folder, agentId),
            agentChannelTurnRuntime,
            {
              provider: agentStreamingAddress.provider,
              accountId: agentStreamingAccountId,
              sourceJid: replySourceImJid,
              chatId: agentStreamingAddress.externalChatId,
              rootId: agentStreamingAddress.rootMessageId,
              threadId: agentStreamingAddress.threadId,
            },
          )
        : undefined;
    if (agentChannelOutboxScope) {
      agentChannelOutboxScopesByInput.set(
        lastProcessed.id,
        agentChannelOutboxScope,
      );
    }
    const executionMode = effectiveGroup.executionMode || 'container';
    const feishuCliAccountId =
      executionMode === 'container'
        ? resolveFeishuCliBoundAccountId({
            channelContext: currentAgentChannelContext,
            workspaceChannelAccountId: effectiveGroup.channel_account_id,
          })
        : null;
    const onProcessCb = (
      proc: ChildProcess,
      identifier: string,
      selectedProviderId: string | null,
    ) => {
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(virtualJid, proc, {
        containerName,
        groupFolder: effectiveGroup.folder,
        displayName: identifier,
        agentId,
        selectedProviderId,
        feishuCliAccountId,
      });
    };

    const happyClawOwnerProfile = resolveHappyClawOwnerProfileForTurn({
      group: effectiveGroup,
      profile: agentProfile,
      turnId: lastProcessed.id,
      isScheduledTask: Boolean(lastProcessed.task_id),
      runtimeAgentId: agentId,
      runtimeAgentKind: agent.kind,
    });
    const happyClawOwnerProfileEnabled = isHappyClawOwnerProfileRuntimeEligible(
      {
        group: effectiveGroup,
        profile: agentProfile,
        turnId: lastProcessed.id,
        isScheduledTask: Boolean(lastProcessed.task_id),
        runtimeAgentId: agentId,
        runtimeAgentKind: agent.kind,
      },
    );
    const containerInput: ContainerInput = {
      prompt,
      sessionId,
      turnId: lastProcessed.id,
      queryRunId: queue.getActiveQueryId(virtualJid) ?? undefined,
      groupFolder: effectiveGroup.folder,
      chatJid,
      interactionMode,
      currentSourceJid: currentAgentSourceJid,
      channelContext: currentAgentChannelContext,
      isMain: isAdminHome,
      isHome,
      isAdminHome,
      agentBuilderEnabled:
        agent.kind === 'conversation' && agentProfile?.is_default === true,
      happyClawBootstrapPending:
        happyClawOwnerProfile?.onboarding.state === 'pending' ||
        happyClawOwnerProfile?.onboarding.state === 'claimed',
      happyClawOwnerProfile,
      happyClawOwnerProfileEnabled,
      agentId,
      agentName: agent.name,
      images: imagesForAgent,
      agentProfile: toContainerAgentProfile(agentProfile),
    };

    // Write tasks/groups snapshots
    const tasks = getAllTasks();
    writeTasksSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );
    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );

    const ownerHomeFolder = resolveOwnerHomeFolder(effectiveGroup);

    let output: ContainerOutput;
    if (executionMode === 'host') {
      const currentOwner = effectiveGroup.created_by
        ? getUserById(effectiveGroup.created_by)
        : undefined;
      if (!canExecuteOnHost(currentOwner)) {
        logger.warn(
          {
            chatJid,
            agentId,
            groupFolder: effectiveGroup.folder,
            ownerId: effectiveGroup.created_by,
          },
          'Blocked host conversation execution for non-admin owner',
        );
        throw new Error(HOST_EXECUTION_FORBIDDEN_ERROR);
      }
      output = await runAgentWithModelFallback(
        runHostAgent,
        effectiveGroup,
        containerInput,
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    } else {
      output = await runAgentWithModelFallback(
        runContainerAgent,
        effectiveGroup,
        containerInput,
        onProcessCb,
        wrappedOnOutput,
        ownerHomeFolder,
      );
    }

    // Finalize session
    if (
      output.newSessionId &&
      output.status !== 'error' &&
      !output.providerFailure
    ) {
      setSession(effectiveGroup.folder, output.newSessionId, agentId, {
        agentProfileId: agentProfile?.id,
        agentProfileVersion: agentProfile?.version,
        identityHash: agentProfile?.identity_hash,
      });
    }

    // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）
    const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
    if (
      (output.status === 'error' || hadError) &&
      errorForReset.includes('unrecoverable_transcript:')
    ) {
      const detail = (lastError || output.error || '').replace(
        /.*unrecoverable_transcript:\s*/,
        '',
      );
      logger.warn(
        { chatJid, agentId, folder: effectiveGroup.folder, error: detail },
        'Unrecoverable transcript error in conversation agent, auto-resetting session',
      );

      await clearSessionRuntimeFiles(effectiveGroup.folder, agentId);
      try {
        deleteSession(effectiveGroup.folder, agentId);
      } catch (err) {
        logger.error(
          { chatJid, agentId, folder: effectiveGroup.folder, err },
          'Failed to clear agent session state during auto-reset',
        );
      }

      sendSystemMessage(
        virtualChatJid,
        'context_reset',
        `会话已自动重置：${detail}`,
      );
      agentDeterministicTerminalError = `Unrecoverable transcript reset: ${detail}`;
      commitCursor();
      await clearAgentProcessingIndicatorForInput(activeAgentInputTurnId);
    }

    // Only commit cursor if a reply was actually sent.  Without a reply the
    // messages haven't been "processed" — leaving the cursor behind lets the
    // recovery logic pick them up after a restart.
    const activeAgentInputPhysicallyAcknowledged =
      agentPhysicalDeliveryAckByInput.get(activeAgentInputTurnId) === true;
    const activeAgentInputHealthy = healthyAgentCompletedInputTurns.has(
      activeAgentInputTurnId,
    );
    if (activeAgentInputPhysicallyAcknowledged && activeAgentInputHealthy) {
      commitCursor();
    }

    const stopDisposition = queue.getRecentStopDisposition(
      effectiveGroup.folder,
    );
    if (stopDisposition === 'discard') {
      const turnOutcome = resolveTurnOutcome({
        status: output.status,
        healthyInputTurnCompleted: activeAgentInputHealthy,
        cursorCommitted: isCursorCommitted(),
        replyDelivered: activeAgentInputPhysicallyAcknowledged,
        stopRequested: true,
      });
      if (turnOutcome.cursor === 'commit') commitCursor();
      logger.info(
        { chatJid, agentId, turnOutcome },
        'Explicit stop discarded the interrupted agent input without replay',
      );
    } else if (output.status === 'closed') {
      const turnOutcome = resolveTurnOutcome({
        status: output.status,
        healthyInputTurnCompleted: activeAgentInputHealthy,
        cursorCommitted: isCursorCommitted(),
        replyDelivered: activeAgentInputPhysicallyAcknowledged,
      });
      if (turnOutcome.cursor === 'commit') commitCursor();
      retryUnfinishedTurn = turnOutcome.kind === 'retryable';
      logger[retryUnfinishedTurn ? 'warn' : 'info'](
        { chatJid, agentId, turnOutcome },
        retryUnfinishedTurn
          ? 'Conversation agent closed during an unfinished turn; scheduling replay'
          : 'Conversation agent close resolved without replay',
      );
    }
    if (
      interactionMode === 'proactive' &&
      (output.status === 'error' || hadError)
    ) {
      const utteranceDelivered =
        agentPhysicalDeliveryAckByInput.get(activeAgentInputTurnId) === true;
      if (utteranceDelivered) {
        commitCursor();
        retryUnfinishedTurn = false;
      } else {
        retryUnfinishedTurn = true;
      }
    }
  } catch (err) {
    hadError = true;
    logger.error({ agentId, chatJid, err }, 'Agent conversation error');
    // stopGroup may terminate the child before runContainerAgent can return a
    // terminal ContainerOutput. Preserve ordinary Stop's discard contract even
    // on that throw path; mutation-preserve stops deliberately keep the cursor.
    if (queue.getRecentStopDisposition(effectiveGroup.folder) === 'discard') {
      commitCursor();
    } else if (interactionMode === 'proactive') {
      const utteranceDelivered =
        agentPhysicalDeliveryAckByInput.get(activeAgentInputTurnId) === true;
      if (utteranceDelivered) commitCursor();
      retryUnfinishedTurn = !utteranceDelivered;
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);

    const wasInterrupted =
      publishesFrameworkAnswer(interactionMode) &&
      agentStreamInterrupted &&
      !agentInterruptFinalized &&
      !isCursorCommitted();
    const wasSteered = wasInterrupted && agentStreamSteered;

    // ── Streaming card cleanup ──
    activeHeldCardFinalizers.delete(virtualChatJid);
    activeRouteAdmissions.delete(agentAdmissionKey);
    for (const [inputTurnId, coordinator] of agentTurnOutputCoordinators) {
      activeTurnOutputs.unbind(agentAdmissionKey, inputTurnId, coordinator);
    }
    if (agentStreamingSession) {
      if (agentStreamingSession.isActive()) {
        // Symmetric with the main session's five-way finalize (index.ts ~3804):
        // every "card built but never completed" path must finalize so the card
        // can't get stuck at 生成中 (zombie card).
        if (heldAgentParts.length > 0) {
          // 挂起收口：后台任务未等到 settle 进程就结束了。DB 合并行补注记 +
          // 卡片定稿「已中断」+ 原因，不留僵尸「后台任务运行中」卡。
          const heldNote = hadError
            ? '处理出错，后台任务可能未完成'
            : '后台任务未全部完成，会话已结束';
          finalizeHeldAgentDbMessage(heldNote, 'interrupted');
          heldAgentParts = [];
          heldAgentUsage = null;
          await agentStreamingSession.abort(heldNote).catch(() => {});
        } else if (agentProviderFailoverPending) {
          await agentStreamingSession
            .abort('模型服务切换中，正在重试')
            .catch(() => {});
        } else if (hadError) {
          await agentStreamingSession.abort('处理出错').catch(() => {});
        } else if (wasInterrupted) {
          if (wasSteered) {
            await agentStreamingSession
              .complete(agentStreamingAccText)
              .catch(() => {});
          } else {
            await agentStreamingSession.abort('已停止').catch(() => {});
          }
        } else if (agentClosed) {
          // Container drained/_closed the in-flight query; the message will be
          // retried, so just finalize the card (区别于"已中断"：系统侧打断重试).
          await agentStreamingSession
            .abort('连接已切换，正在重试')
            .catch(() => {});
        } else if (!isCursorCommitted()) {
          // Silent-success: the agent replied only via the send_message
          // side-channel or produced an empty result, so the card was never
          // completed. complete() 收口 (空正文由 buildStructuredFinalCard 兜底)
          // 而非裸 dispose 留下「生成中」僵尸卡。
          try {
            await agentStreamingSession.complete(agentStreamingAccText);
          } catch (err) {
            logger.warn(
              { err, chatJid, agentId },
              'Agent streaming card silent-success finalize failed, disposing',
            );
            agentStreamingSession.dispose();
          }
        } else {
          agentStreamingSession.dispose();
        }
      }
      if (streamingSessionJid) {
        unregisterStreamingSession(streamingSessionJid);
      }
    }

    // ── 无卡片场景（纯 Web agent 会话）的挂起序列 DB 收口 ──
    // 上方卡片分支已处理的场景 parts 已清空，此处天然跳过。
    if (heldAgentParts.length > 0) {
      finalizeHeldAgentDbMessage(
        hadError
          ? '处理出错，后台任务可能未完成'
          : '后台任务未全部完成，会话已结束',
        'interrupted',
      );
      heldAgentParts = [];
      heldAgentUsage = null;
    }

    if (agentChannelTurnRuntimes.size > 0) {
      let allAgentManualNoticesAcknowledged = true;
      const explicitDiscard =
        queue.getRecentStopDisposition(effectiveGroup.folder) === 'discard';
      for (const [inputTurnId, runtime] of agentChannelTurnRuntimes) {
        const utteranceDelivered =
          agentPhysicalDeliveryAckByInput.get(inputTurnId) === true;
        const healthyInputCompleted =
          healthyAgentCompletedInputTurns.has(inputTurnId);
        const uncertainDelivery = getUncertainChannelOutboxForTurn(
          runtime.runId,
        );
        let settled: boolean;
        let terminal = false;
        if (uncertainDelivery) {
          agentDeliveryNeedsManualReconciliation = true;
          settled = runtime.interrupt(
            `Channel delivery ${uncertainDelivery.id} is uncertain; manual reconciliation required`,
          );
          const exactScope = agentChannelOutboxScopesByInput.get(inputTurnId);
          const notified = exactScope?.chatId
            ? await deliverChannelManualReconciliationNotice({
                logicalChatJid: virtualChatJid,
                scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
                targetJid: exactScope.sourceJid,
                runtime,
                agentId,
                presentation:
                  interactionMode === 'proactive' ? 'native' : 'default',
                route: { ...exactScope, chatId: exactScope.chatId },
              })
            : false;
          if (!notified) allAgentManualNoticesAcknowledged = false;
          terminal = settled;
        } else if (explicitDiscard) {
          settled = runtime.cancel('Input discarded by explicit stop');
          terminal = settled;
        } else if (agentDeterministicTerminalError) {
          settled = runtime.fail(agentDeterministicTerminalError);
          terminal = settled;
        } else if (
          healthyInputCompleted &&
          (interactionMode === 'proactive' || utteranceDelivered)
        ) {
          settled =
            runtime.markFinalizing() &&
            runtime.complete({
              cursorCommitted: isCursorCommitted(inputTurnId),
              replyDelivered: utteranceDelivered,
              silent: interactionMode === 'proactive' && !utteranceDelivered,
              inputTurnId,
            });
          terminal = settled;
        } else if (interactionMode === 'proactive' && utteranceDelivered) {
          settled = runtime.fail(
            lastError ||
              (agentClosed
                ? 'Agent connection closed after native delivery'
                : 'Agent failed after native delivery'),
          );
          terminal = settled;
          if (settled) {
            commitCursor(inputTurnId);
            retryUnfinishedTurn = false;
            await notifyProactiveAgentTailInterruption(inputTurnId);
          }
        } else {
          settled = runtime.retry(
            lastError ||
              (agentClosed
                ? 'Agent connection closed before completing input turn'
                : wasInterrupted
                  ? 'Agent interrupted before completing input turn'
                  : 'Agent execution ended before completing input turn'),
          );
        }
        if (!settled) {
          logger.error(
            {
              chatJid,
              agentId,
              inputTurnId,
              runId: runtime.runId,
              durabilityFailure: runtime.hasDurabilityFailure,
              lostFence: runtime.hasLostFence,
            },
            'Agent channel turn cleanup did not reach a durable state',
          );
        }
        if (terminal) {
          await clearAgentProcessingIndicatorForInput(inputTurnId);
        }
        runtime.dispose();
      }
      agentChannelTurnRuntimes.clear();
      if (agentDeliveryNeedsManualReconciliation) {
        if (allAgentManualNoticesAcknowledged) {
          commitCursor();
          retryUnfinishedTurn = false;
        } else {
          retryUnfinishedTurn = true;
        }
      }
    }

    if (
      interactionMode === 'proactive' &&
      !agentDeliveryNeedsManualReconciliation &&
      agentPhysicalDeliveryAckByInput.get(activeAgentInputTurnId) === true
    ) {
      // A native utterance is an irreversible user-visible side effect. If the
      // runner faults afterwards, replaying the input would duplicate it.
      commitCursor();
      retryUnfinishedTurn = false;
      if (!healthyAgentCompletedInputTurns.has(activeAgentInputTurnId)) {
        await notifyProactiveAgentTailInterruption(activeAgentInputTurnId);
      }
      await clearAgentProcessingIndicatorForInput(activeAgentInputTurnId);
    }

    // ── 保存中断内容 ──
    if (wasInterrupted) {
      const interruptedText = wasSteered
        ? buildSteeredReply(agentStreamingAccText)
        : buildStoppedReply(agentStreamingAccText);
      try {
        if (interruptedText) {
          const msgId = crypto.randomUUID();
          const timestamp = new Date().toISOString();
          ensureChatExists(virtualChatJid);
          const persistedMsgId = storeMessageDirect(
            msgId,
            virtualChatJid,
            'happyclaw-agent',
            ASSISTANT_NAME,
            interruptedText,
            timestamp,
            true,
            {
              meta: {
                turnId: lastProcessed.id,
                sessionId: currentAgentSessionId,
                sourceKind: 'interrupt_partial',
                finalizationReason: 'interrupted',
              },
            },
          );
          broadcastNewMessage(
            virtualChatJid,
            {
              id: persistedMsgId,
              chat_jid: virtualChatJid,
              sender: 'happyclaw-agent',
              sender_name: ASSISTANT_NAME,
              content: interruptedText,
              timestamp,
              is_from_me: true,
              turn_id: lastProcessed.id,
              session_id: currentAgentSessionId,
              sdk_message_uuid: null,
              source_kind: 'interrupt_partial',
              finalization_reason: 'interrupted',
            },
            agentId,
          );
        }
        agentInterruptFinalized = true;
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId },
          'Failed to save interrupted agent text',
        );
      }
    }

    // ── 兜底：进程异常退出导致累积文本未持久化 ──
    if (
      publishesFrameworkAnswer(interactionMode) &&
      !isCursorCommitted() &&
      agentStreamingAccText.trim()
    ) {
      try {
        const partialReply = buildInterruptedReply(agentStreamingAccText);
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        const persistedMsgId = storeMessageDirect(
          msgId,
          virtualChatJid,
          'happyclaw-agent',
          ASSISTANT_NAME,
          partialReply,
          timestamp,
          true,
          {
            meta: {
              turnId: lastProcessed.id,
              sessionId: currentAgentSessionId,
              sourceKind: 'interrupt_partial',
              finalizationReason: 'error',
            },
          },
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: persistedMsgId,
            chat_jid: virtualChatJid,
            sender: 'happyclaw-agent',
            sender_name: ASSISTANT_NAME,
            content: partialReply,
            timestamp,
            is_from_me: true,
            turn_id: lastProcessed.id,
            session_id: currentAgentSessionId,
            sdk_message_uuid: null,
            source_kind: 'interrupt_partial',
            finalization_reason: 'error',
          },
          agentId,
        );
        // Fallback: send accumulated streaming text to IM when output.result is null
        // (agent-runner streams all text via text_delta, never sets result field)
        logger.info({
          chatJid,
          agentId,
          replySourceImJid,
          accLen: agentStreamingAccText.length,
          cursorCommitted: isCursorCommitted(),
        });
        if (replySourceImJid) {
          const localImagePaths = extractLocalImImagePaths(
            partialReply,
            effectiveGroup.folder,
          );
          logger.info(
            { replySourceImJid, textLen: partialReply.length },
            'agent partial reply ready',
          );
          const imSent = await sendImWithRetry(
            replySourceImJid,
            partialReply,
            localImagePaths,
            {
              scopeKey: channelTurnScope(effectiveGroup.folder, agentId),
              scopeToken:
                agentChannelOutboxScopesByInput.get(lastProcessed.id)?.token ??
                `missing:${lastProcessed.id}`,
              operationKey: `agent:${agentId}:${lastProcessed.id}:partial-fallback`,
            },
          );
          logger.info({ replySourceImJid, imSent }, 'agent IM reply sent');
        } else {
          logger.warn(
            { chatJid, agentId },
            'Partial reply: no replySourceImJid found, skipping IM send',
          );
        }
      } catch (err) {
        logger.warn(
          { err, chatJid, agentId },
          'Failed to save interrupted partial agent text',
        );
      }
    }

    // ── Spawn result injection: write final output back to the source chat ──
    if (
      agent.kind === 'spawn' &&
      agent.spawned_from_jid &&
      lastAgentReplyText
    ) {
      try {
        const resultText = lastAgentReplyText;
        const injectId = crypto.randomUUID();
        const injectTs = new Date().toISOString();
        ensureChatExists(agent.spawned_from_jid);
        storeMessageDirect(
          injectId,
          agent.spawned_from_jid,
          'happyclaw-agent',
          ASSISTANT_NAME,
          resultText,
          injectTs,
          true,
        );
        broadcastNewMessage(agent.spawned_from_jid, {
          id: injectId,
          chat_jid: agent.spawned_from_jid,
          sender: 'happyclaw-agent',
          sender_name: ASSISTANT_NAME,
          content: resultText,
          timestamp: injectTs,
          is_from_me: true,
        });
        logger.info(
          {
            agentId,
            spawned_from_jid: agent.spawned_from_jid,
            textLen: lastAgentReplyText.length,
          },
          'Spawn result injected back to source chat',
        );
      } catch (err) {
        logger.error(
          { agentId, err },
          'Failed to inject spawn result back to source chat',
        );
      }
    }

    // Process ended → set status back to idle (conversation agents persist).
    // Spawn agents are fire-and-forget: mark as completed (or error) so they
    // don't accumulate in the active agent list.
    // MUST be inside finally so status is reset even on unhandled exceptions (#227).
    const endStatus =
      agent.kind === 'spawn' ? (hadError ? 'error' : 'completed') : 'idle';
    updateAgentStatus(agentId, endStatus, hadError ? lastError : undefined);
    broadcastAgentStatus(
      chatJid,
      agentId,
      endStatus,
      agent.name,
      agent.prompt,
      hadError ? lastError : undefined,
    );

    activeImReplyRoutes.delete(virtualChatJid);
    for (const scope of new Set(agentChannelOutboxScopesByInput.values())) {
      activeChannelOutboxScopes.unbind(
        channelTurnScope(effectiveGroup.folder, agentId),
        scope,
      );
    }
    if (
      shouldSendProactiveTailInterruptionNotice({
        mode: interactionMode,
        utteranceDelivered:
          agentPhysicalDeliveryAckByInput.get(activeAgentInputTurnId) === true,
        runnerFailed: hadError || agentClosed,
        healthyInputTurnCompleted: healthyAgentCompletedInputTurns.has(
          activeAgentInputTurnId,
        ),
      })
    ) {
      await notifyProactiveAgentTailInterruption(activeAgentInputTurnId);
    }
    activeAgentBuilderTurns.delete(agentBuilderScope);
    activeChannelTurns.delete(channelTurnScope(effectiveGroup.folder, agentId));
    ipcWatcherManager?.unwatchGroup(effectiveGroup.folder);
  }

  return !retryUnfinishedTurn;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('happyclaw running');

  while (!shuttingDown) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newCursor } = getNewMessages(jids, globalMessageCursor);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        globalMessageCursor = newCursor;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          let group = registeredGroups[chatJid];
          if (!group) {
            const dbGroup = getRegisteredGroup(chatJid);
            if (dbGroup) {
              registeredGroups[chatJid] = dbGroup;
              group = dbGroup;
            }
          }
          if (!group) {
            await clearStandaloneProcessingIndicatorsForMessages(
              chatJid,
              groupMessages,
            );
            continue;
          }

          // Skip groups with target_agent_id — their messages are routed
          // to conversation agents at IM ingestion time (feishu.ts/telegram.ts)
          if (group.target_agent_id) continue;

          // Owner gate + billing share a single owner lookup. Owner status
          // check first: drop messages from groups whose owner is
          // disabled/deleted (see `src/owner-gate.ts`); billing quota check
          // second.
          if (group.created_by) {
            const owner = getUserById(group.created_by);
            const ownerGate = checkOwnerActive(owner);
            if (!ownerGate.allowed) {
              completeOutOfBandMessages(chatJid, groupMessages);
              await clearStandaloneProcessingIndicatorsForMessages(
                chatJid,
                groupMessages,
              );
              logger.info(
                {
                  chatJid,
                  userId: group.created_by,
                  ownerStatus: ownerGate.status,
                },
                'Dropping message: group owner is not active',
              );
              continue;
            }

            // Billing quota check before processing
            if (owner && owner.role !== 'admin') {
              const accessResult = checkBillingAccessFresh(
                group.created_by,
                owner.role,
              );
              if (!accessResult.allowed) {
                logger.info(
                  {
                    chatJid,
                    userId: group.created_by,
                    reason: accessResult.reason,
                    blockType: accessResult.blockType,
                    exceededWindow: accessResult.exceededWindow,
                  },
                  'Billing access denied, blocking message processing',
                );
                const sysMsg = formatBillingAccessDeniedMessage(accessResult);

                // Notify IM channel if the message came from an IM source
                const lastInput = groupMessages[groupMessages.length - 1];
                const lastSourceJid = lastInput?.source_jid;
                const imSourceJid = lastSourceJid || chatJid;
                if (getChannelType(imSourceJid)) {
                  const route = resolveDurableChannelRoute(imSourceJid);
                  const acknowledged =
                    route && lastInput
                      ? await deliverIndependentChannelSystemNotice({
                          logicalChatJid: chatJid,
                          scopeKey: channelTurnScope(group.folder),
                          targetJid: imSourceJid,
                          originalInputTurnId: lastInput.id,
                          originalRunId: `billing:${lastInput.id}`,
                          noticeKey: 'billing-denied',
                          text: sysMsg,
                          sender: '__billing__',
                          route,
                        })
                      : false;
                  if (!acknowledged) {
                    logger.warn(
                      { jid: imSourceJid, messageId: lastInput?.id },
                      'Quota notice not acknowledged; preserving input cursor for retry',
                    );
                    continue;
                  }
                } else {
                  sendBillingDeniedMessage(chatJid, sysMsg);
                }

                // Advance only after Web persistence or strict native ACK.
                completeOutOfBandMessages(chatJid, groupMessages);
                await clearStandaloneProcessingIndicatorsForMessages(
                  chatJid,
                  groupMessages,
                );
                continue;
              }
            }
          }

          // Pull all messages since lastAgentTimestamp to preserve full context.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || EMPTY_CURSOR,
          );
          let messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          // The receipt covers the exact pre-expansion DB batch. Plugin replies
          // removed from `messagesToSend` below are already handled out-of-band,
          // so a healthy agent result for the remainder may safely commit the
          // full batch, but never an unrelated cursor inserted inside its range.
          const deliveryTarget = createIpcDeliveryTarget(
            chatJid,
            messagesToSend,
          );
          const { effectiveGroup: activeEffectiveGroup } =
            resolveEffectiveGroup(group);
          const warmChannelContext = resolveBatchChannelContext(
            messagesToSend,
            chatJid,
          );
          const requiredFeishuCliAccountId =
            (activeEffectiveGroup.executionMode || 'container') === 'container'
              ? resolveFeishuCliBoundAccountId({
                  channelContext: warmChannelContext,
                  workspaceChannelAccountId:
                    activeEffectiveGroup.channel_account_id,
                })
              : null;

          // Plugin expansion may execute inline commands inside the active
          // container. Reject a cross-Bot warm path before expansion so even
          // those commands cannot observe the previous Bot's credentials.
          if (
            queue.requiresFeishuCliContainerRestart(chatJid, {
              feishuCliAccountId: requiredFeishuCliAccountId,
            })
          ) {
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          // Plugin command expander (DMI commands) — same as cold-start path.
          // Active-runner IPC injection: replies advance the cursor without
          // touching the running agent; full-reply batches skip sendMessage().
          //
          // Resolve effectiveGroup so sibling-JID groups (home main + non-home
          // child sharing a folder) inherit executionMode / customCwd /
          // created_by from the home sibling — without this, plugin expansion
          // returns null on the non-home sibling and DMI commands stop working
          // once a runner is up (#18 P2-bug-3).
          {
            const fallbackExpandCtx = buildExpandContext(
              chatJid,
              activeEffectiveGroup,
              activeEffectiveGroup.created_by,
            );
            if (fallbackExpandCtx) {
              const { toSend, replies } = await expandMessagesIfNeeded(
                messagesToSend,
                fallbackExpandCtx,
                undefined,
                persistPluginExpansion,
              );
              // Hold the recovery cursor while toSend still has work pending
              // (#18 P2-bug-2 also applies on the active path).
              const advanceReplyCursor =
                toSend.length === 0
                  ? completeOutOfBandMessage
                  : advanceNextPullCursorOnly;
              // IM fan-out (#20 P1-1): if chatJid itself is an IM channel
              // we route to itself; otherwise prefer the originating message's
              // source_jid (mixed batches retain individual user routing).
              const directImReply = getChannelType(chatJid) !== null;
              let warmPluginRepliesAcknowledged = true;
              for (const r of replies) {
                let imRouteJid: string | null = null;
                if (directImReply) {
                  imRouteJid = chatJid;
                } else if (
                  r.originalMsg.source_jid &&
                  getChannelType(r.originalMsg.source_jid)
                ) {
                  imRouteJid = r.originalMsg.source_jid;
                }
                const delivery = await sendPluginExpanderReply(
                  chatJid,
                  r.text,
                  {
                    originalMessageId: r.originalMsg.id,
                    groupFolder: activeEffectiveGroup.folder,
                    imRouteJid,
                  },
                );
                if (!delivery.acknowledged) {
                  warmPluginRepliesAcknowledged = false;
                  break;
                }
                if (imRouteJid) {
                  await clearStandaloneProcessingIndicator(
                    chatJid,
                    imRouteJid,
                    r.originalMsg.id,
                  );
                }
                advanceReplyCursor(chatJid, {
                  timestamp: r.originalMsg.timestamp,
                  id: r.originalMsg.id,
                });
              }
              if (!warmPluginRepliesAcknowledged) {
                queue.enqueueMessageCheck(chatJid);
                continue;
              }
              if (toSend.length === 0) {
                continue;
              }
              messagesToSend = toSend;
            }
          }

          // Home and non-home groups now share the same IPC injection path.
          // Reply routing is dynamically updated via activeRouteUpdaters when
          // the message is successfully injected, so we no longer need to kill
          // the process for home groups.

          const knownReferencedMessageIds =
            collectPersistedReferencedMessageIds(chatJid, messagesToSend);
          const formatted = formatMessages(messagesToSend, {
            knownMessageIds: knownReferencedMessageIds,
          });

          const images = collectMessageImages(chatJid, messagesToSend, {
            knownMessageIds: knownReferencedMessageIds,
          });
          const imagesForAgent = images.length > 0 ? images : undefined;

          if (group.created_by) {
            learnDirectMessageOwners(group.created_by, messagesToSend);
          }

          // Determine the IM source JID for route update on successful injection
          const lastSourceJidForRoute =
            messagesToSend[messagesToSend.length - 1]?.source_jid || chatJid;

          // Propagate scheduled-task identity into the running agent. Group-mode
          // tasks inject their prompt as a normal message; when a runner is
          // already active this IPC path (not the cold-start runContainerAgent
          // path) handles delivery, so it must carry task_id too — otherwise the
          // task's send_message output loses task attribution and the host skips
          // the notify_channels broadcast (riba2534/happyclaw#559).
          const injectionTaskId = extractLastTaskId(messagesToSend);

          const sendResult = queue.sendMessage(
            chatJid,
            formatted,
            imagesForAgent,
            (receipt) => {
              // IPC write succeeded — update reply route for the running agent
              if (receipt) {
                activeAgentBuilderTurns.enqueueBatch(
                  group.folder,
                  (receipt.coveredCursors ?? [receipt.cursor]).map(
                    (cursor) => ({
                      chatJid: receipt.chatJid,
                      messageId: cursor.id,
                      runtimeTurnId: receipt.deliveryId,
                      scheduledTaskId: injectionTaskId ?? null,
                    }),
                  ),
                );
                grantWorkspaceMemoryTurnToCurrentRunner(
                  {
                    groupFolder: group.folder,
                    agentId: null,
                    taskRunId: null,
                  },
                  receipt.deliveryId,
                );
                bindActiveChannelTurn(
                  channelTurnScope(group.folder),
                  receipt.deliveryId,
                  warmChannelContext,
                );
              }
              invokeActiveRouteUpdater(
                group.folder,
                lastSourceJidForRoute,
                receipt?.deliveryId,
                receipt?.cursor,
              );
            },
            lastSourceJidForRoute,
            injectionTaskId,
            deliveryTarget,
            warmChannelContext,
            (receipt) =>
              invokeActiveRouteAdmission(
                group.folder,
                lastSourceJidForRoute,
                receipt,
              ),
            { feishuCliAccountId: requiredFeishuCliAccountId },
          );
          if (sendResult === 'sent' && deliveryTarget) {
            logger.debug(
              {
                chatJid,
                count: messagesToSend.length,
                imageCount: images.length,
              },
              'Piped messages to active container',
            );
            // advanceNextPullCursorOnly (not direct assignment) so an earlier
            // reply already pushed past this batch terminal is not regressed,
            // which would cause it to be re-pulled and replayed on the next
            // poll (#18 P1-bug-1).
            advanceNextPullCursorOnly(chatJid, deliveryTarget.cursor);
          } else {
            // no_active — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    stuckRunnerCheckCounter++;
    if (stuckRunnerCheckCounter >= STUCK_RUNNER_CHECK_INTERVAL_POLLS) {
      stuckRunnerCheckCounter = 0;
      await recoverStuckPendingGroups();
    }

    await interruptibleSleep(POLL_INTERVAL);
  }
}

/**
 * Check if a process tree has actively working descendant processes.
 * Returns true if any descendant (not just direct children) is consuming
 * CPU (> 0.5%), indicating real work rather than a network-blocked hang.
 */
async function hasActiveCpuDescendants(pid: number): Promise<boolean> {
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pcpu='], {
      timeout: 3000,
    });

    const children = new Map<number, number[]>();
    const cpuByPid = new Map<number, number>();
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const p = parseInt(parts[0], 10);
      const pp = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      if (isNaN(p) || isNaN(pp)) continue;
      if (!children.has(pp)) children.set(pp, []);
      children.get(pp)!.push(p);
      cpuByPid.set(p, cpu);
    }

    // Walk the full descendant tree (not just direct children)
    const stack = [pid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const kids = children.get(current);
      if (!kids) continue;
      for (const kid of kids) {
        if ((cpuByPid.get(kid) ?? 0) > 0.5) return true;
        stack.push(kid);
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function recoverStuckPendingGroups(): Promise<void> {
  const stuckGroups = queue.getStuckPendingGroups(STUCK_RUNNER_IDLE_MS);
  for (const { jid, idleMs } of stuckGroups) {
    const pid = queue.getRunnerPid(jid);
    if (pid && (await hasActiveCpuDescendants(pid))) {
      logger.info(
        { chatJid: jid, idleMs, pid },
        'Runner idle but has CPU-active child processes; skipping restart',
      );
      continue;
    }

    logger.warn(
      { chatJid: jid, idleMs },
      'Runner has pending messages but no activity; restarting',
    );
    queue.restartGroup(jid).catch((err) => {
      logger.error(
        { chatJid: jid, err },
        'Failed to restart stuck runner with pending messages',
      );
    });
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 *
 * Uses `lastCommittedCursor` (updated only in commitCursor when an agent
 * actually finishes processing) rather than `lastAgentTimestamp` (which
 * advances when IPC injection succeeds).  This correctly detects messages
 * that were IPC-injected but never processed because the service was
 * killed before the agent could handle them.
 *
 * When pending messages are found, the group's SDK session is cleared to
 * prevent the "session ghost" bug: if the previous agent was killed mid-
 * response (SIGKILL / crash), the SDK session is left in a dirty state.
 * Resuming it would cause the agent to complete the OLD interrupted work
 * instead of processing the NEW pending messages, sending irrelevant
 * replies to the user.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const committedCursor = lastCommittedCursor[chatJid];
    const pullCursor = lastAgentTimestamp[chatJid];
    const pullWasAhead =
      !!pullCursor &&
      (!committedCursor || isCursorAfter(pullCursor, committedCursor));
    if (pullWasAhead) {
      clearPersistedIpcDeliveriesForChats(new Set([chatJid]));
      rewindNextPullCursorToCommitted(chatJid);
      logger.warn(
        {
          chatJid,
          pullCursor,
          committedCursor: committedCursor || EMPTY_CURSOR,
        },
        'Startup recovery rewound next-pull cursor past uncommitted IPC delivery',
      );
    }
    // With no committed cursor and no evidence of an IPC-ahead state, leave a
    // fresh/legacy group to the normal poller rather than replaying all history.
    if (
      !shouldRecoverPendingHistory(
        !!committedCursor,
        pullWasAhead,
        startupRecoveredDeliveryJids.has(chatJid),
      )
    )
      continue;
    const sinceCursor = committedCursor || EMPTY_CURSOR;

    const pending = getMessagesSince(chatJid, sinceCursor);
    if (pending.length > 0) {
      // Clear stale session to avoid "session ghost" — the agent will start
      // a fresh conversation and process the pending messages cleanly.
      if (sessions[group.folder]) {
        logger.info(
          { group: group.name, folder: group.folder },
          'Recovery: clearing stale session to prevent session ghost',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      recoveryGroups.add(chatJid);
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Startup recovery for conversation agents.
 * After restart, running conversation agents have dead processes.
 * Reset their status and re-trigger processing if they have pending messages.
 */
function recoverConversationAgents(): void {
  // Archive long-inactive sessions first so restart recovery only walks the
  // genuinely live set; production grew this monotonically (51 → 73 in three
  // days) because conversation agents had no inactivity terminal state.
  const archived = archiveInactiveConversationAgents(
    new Date(
      Date.now() - CONVERSATION_AGENT_ARCHIVE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
  );
  if (archived > 0) {
    logger.info(
      { archived, retentionDays: CONVERSATION_AGENT_ARCHIVE_DAYS },
      'Recovery: archived inactive conversation agents',
    );
  }
  const agents = listActiveConversationAgents();
  if (agents.length === 0) return;

  logger.info(
    { count: agents.length },
    'Recovery: found active conversation agents from previous session',
  );

  for (const agent of agents) {
    try {
      const chatJid = agent.chat_jid;
      const agentId = agent.id;

      // Reset running → idle (process is dead)
      if (agent.status === 'running') {
        updateAgentStatus(agentId, 'idle');
        broadcastAgentStatus(
          chatJid,
          agentId,
          'idle',
          agent.name,
          agent.prompt,
          agent.result_summary ?? undefined,
          agent.kind,
        );
      }

      // Check for pending messages on the virtual JID
      const virtualChatJid = `${chatJid}#agent:${agentId}`;
      const committedCursor = lastCommittedCursor[virtualChatJid];
      const pullCursor = lastAgentTimestamp[virtualChatJid];
      const pullWasAhead =
        !!pullCursor &&
        (!committedCursor || isCursorAfter(pullCursor, committedCursor));
      if (pullWasAhead) {
        clearPersistedIpcDeliveriesForChats(new Set([virtualChatJid]));
        rewindNextPullCursorToCommitted(virtualChatJid);
        logger.warn(
          {
            virtualChatJid,
            pullCursor,
            committedCursor: committedCursor || EMPTY_CURSOR,
          },
          'Startup recovery rewound conversation-agent IPC delivery',
        );
      }
      const sinceCursor = committedCursor || EMPTY_CURSOR;
      const pending = getMessagesSince(virtualChatJid, sinceCursor);

      if (pending.length > 0) {
        logger.info(
          { agentId, agentName: agent.name, pendingCount: pending.length },
          'Recovery: re-triggering conversation agent with pending messages',
        );

        // Store a system notice so the user sees something in the chat
        const now = new Date().toISOString();
        const noticeId = `system-recover-${agentId}-${Date.now()}`;
        storeMessageDirect(
          noticeId,
          virtualChatJid,
          'system',
          ASSISTANT_NAME,
          '服务已重启，正在恢复上次未完成的任务...',
          now,
          true,
        );
        broadcastNewMessage(virtualChatJid, {
          id: noticeId,
          chat_jid: virtualChatJid,
          sender: 'system',
          sender_name: ASSISTANT_NAME,
          content: '服务已重启，正在恢复上次未完成的任务...',
          timestamp: now,
          is_from_me: true,
          source_jid: virtualChatJid,
        });

        // Enqueue the agent conversation for processing
        const taskId = `agent-recover:${agentId}:${Date.now()}`;
        queue.enqueueTask(virtualChatJid, taskId, async () => {
          return processAgentConversation(chatJid, agentId);
        });
      }
    } catch (err) {
      logger.error(
        { err, agentId: agent.id, groupFolder: agent.group_folder },
        'Recovery: failed to recover conversation agent, skipping',
      );
    }
  }
}

function recoverStartupTypedIpcDeliveries(): void {
  let chatJids = new Set<string>();
  const receipts = discardStartupTypedIpcDeliveries(
    path.join(DATA_DIR, 'ipc'),
    (claims) => {
      chatJids = new Set(claims.map((receipt) => receipt.chatJid));
      for (const chatJid of chatJids) {
        startupRecoveredDeliveryJids.add(chatJid);
        rewindNextPullCursorToCommitted(chatJid);
      }
    },
  );
  if (receipts.length > 0) {
    logger.warn(
      { deliveryCount: receipts.length, chatJids: [...chatJids] },
      'Startup removed typed IPC deliveries and rewound them for DB replay',
    );
  }
}

async function ensureDockerRunning(): Promise<void> {
  // Skip all Docker checks when no groups use container mode
  if (!hasContainerModeGroups()) {
    logger.info('All groups use host execution mode, skipping Docker checks');
    return;
  }

  if (!(await isDockerAvailable())) {
    logger.warn(
      'Docker is not available — container-mode workspaces will fail at message time. ' +
        'Start Docker if you need container execution (macOS: Docker Desktop, Linux: sudo systemctl start docker).',
    );
    return;
  }
  logger.debug('Docker daemon is running');

  // Kill orphaned host agent-runner processes from previous runs
  try {
    const { stdout: psOut } = await execFileAsync(
      'pgrep',
      ['-f', 'node.*container/agent-runner/dist/index\\.js'],
      { timeout: 5000 },
    );
    const pids = (typeof psOut === 'string' ? psOut : String(psOut))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid && !isNaN(pid));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    if (pids.length > 0) {
      logger.info(
        { count: pids.length, pids },
        'Killed orphaned host agent-runner processes',
      );
    }
  } catch (err: any) {
    // pgrep exits 1 when no matches — that's fine
    if (err?.code !== 1) {
      logger.warn({ err }, 'Failed to clean up orphaned host processes');
    }
  }

  // Kill and clean up orphaned happyclaw containers from previous runs
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '--filter', 'name=happyclaw-', '--format', '{{.Names}}'],
      { timeout: 10000 },
    );
    const output = typeof stdout === 'string' ? stdout : String(stdout);
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        await execFileAsync('docker', ['stop', name], { timeout: 10000 });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/**
 * Build the onNewChat callback for IM connections.
 * Feishu/Telegram chats auto-register to the user's home group folder.
 *
 * When the same IM app is transferred between users (e.g., admin disables
 * their channel and a member enables the same credentials), existing chats
 * are re-routed to the new user's home folder on first message receipt.
 *
 * In multi-bot setups where the same human talks to multiple bots (each owned
 * by a different HappyClaw user), re-routing is skipped — the chat stays with
 * its original owner as long as that owner still has an active connection on
 * the **same channel type** (feishu/telegram/qq/wechat).
 */
function buildOnNewChat(
  userId: string,
  homeFolder: string,
  getOwnerOpenId?: () => string | undefined,
): (chatJid: string, chatName: string) => void {
  return (chatJid, chatName) => {
    const existing = registeredGroups[chatJid];
    if (existing) {
      // Already owned by this user — update name if changed (IM channel may now have real group name)
      if (existing.created_by === userId) {
        const trimmed = chatName.trim();
        if (trimmed && existing.name !== trimmed) {
          existing.name = trimmed;
          setRegisteredGroup(chatJid, existing);
          registeredGroups[chatJid] = existing;
          logger.debug(
            { chatJid, chatName: trimmed },
            'Updated IM group name (buildOnNewChat)',
          );
          if (existing.target_agent_id) {
            const agent = getAgent(existing.target_agent_id);
            if (agent?.source_kind === 'auto_im') {
              updateAgentContextInfo(existing.target_agent_id, {
                name: trimmed,
              });
              updateChatName(
                `${agent.chat_jid}#agent:${existing.target_agent_id}`,
                trimmed,
              );
            }
          }
        }
        const channelType = getChannelType(chatJid);
        const isolationConfig = getUserContextIsolationConfig(
          userId,
          channelType,
          { getUserFeishuConfig },
        );
        if (isolationConfig.enabled) {
          ensureAutoImConversationBinding(
            chatJid,
            existing,
            userId,
            trimmed || existing.name || chatJid,
          );
        }
        return;
      }

      // Don't override groups with explicit IM routing configured.
      if (existing.target_agent_id || existing.target_main_jid) return;

      // Backfill missing created_by without changing folder binding.
      // Legacy IM groups may have NULL created_by after migration;
      // we should claim ownership but preserve the user's chosen folder.
      if (!existing.created_by) {
        existing.created_by = userId;
        setRegisteredGroup(chatJid, existing);
        registeredGroups[chatJid] = existing;
        logger.info(
          { chatJid, chatName, userId, folder: existing.folder },
          'Backfilled created_by for IM chat (preserved existing folder)',
        );
        return;
      }

      // Different user's connection now owns this IM app.
      // Two possible scenarios:
      //   1. Credential transfer: admin disables their Feishu channel, member
      //      enables the same appId → re-route chat to the new user.
      //   2. Multi-bot setup: same human talks to multiple bots, each owned by
      //      a different HappyClaw user → do NOT re-route.
      //
      // Distinguish by checking whether the previous owner still has an active
      // connection on the SAME channel type.  Checking all channel types would
      // produce false positives (e.g., admin's Telegram is still online while
      // their Feishu app was transferred → skip re-route incorrectly).
      if (!existing.is_home) {
        const previousOwner = existing.created_by;
        const channelType = getChannelType(chatJid);
        const previousOwnerStillConnected = channelType
          ? imManager
              .getConnectedChannelTypes(previousOwner)
              .includes(channelType)
          : false;

        if (previousOwnerStillConnected) {
          // Multi-bot: previous owner still has the same channel type active
          logger.debug(
            {
              chatJid,
              chatName,
              userId,
              channelType,
              existingOwner: previousOwner,
              existingFolder: existing.folder,
            },
            'Skipped IM chat re-route (previous owner still connected on same channel type)',
          );
        } else {
          // Credential transfer: previous owner no longer connected on this channel
          const previousFolder = existing.folder;
          Object.assign(existing, releaseOwner(existing), {
            folder: homeFolder,
            created_by: userId,
            // Trust belongs to the previous HappyClaw user's channel binding,
            // not merely to the provider chat id. Never carry that trust into
            // the new user's Agent Builder authorization boundary.
            owner_claim_source: 'transfer_reset' as const,
            sender_allowlist: getOwnerOpenId ? [] : undefined,
            audience_mode: getOwnerOpenId ? 'owner_only' : 'everyone',
          });
          setRegisteredGroup(chatJid, existing);
          registeredGroups[chatJid] = existing;
          logger.info(
            {
              chatJid,
              chatName,
              userId,
              homeFolder,
              previousFolder,
              previousOwner,
              channelType,
            },
            'Re-routed IM chat to new user (IM credentials transferred)',
          );
        }
      }
      return;
    }
    const ownerOpenId = getOwnerOpenId?.();
    const ownerUser = getUserById(userId);
    const groupDefaults = resolveImGroupDefaults({
      ownerDefaultRequireMention: ownerUser?.default_require_mention,
    });
    registerGroup(chatJid, {
      name: chatName,
      folder: homeFolder,
      added_at: new Date().toISOString(),
      created_by: userId,
      owner_im_id: ownerOpenId,
      owner_claim_source: ownerOpenId ? 'auto_feishu' : undefined,
      // Only Feishu path (getOwnerOpenId provided) opts into the default
      // allowlist lock. Other channels leave allowlist unrestricted.
      sender_allowlist: getOwnerOpenId
        ? ownerOpenId
          ? [ownerOpenId]
          : []
        : undefined,
      audience_mode: getOwnerOpenId ? 'owner_only' : 'everyone',
      require_mention: groupDefaults.requireMention,
    });
    logger.info(
      {
        chatJid,
        chatName,
        userId,
        homeFolder,
        requireMention: groupDefaults.requireMention,
      },
      'Auto-registered IM chat',
    );

    const channelType = getChannelType(chatJid);
    const isolationConfig = getUserContextIsolationConfig(userId, channelType, {
      getUserFeishuConfig,
    });
    if (isolationConfig.enabled) {
      const registered = registeredGroups[chatJid]!;
      ensureAutoImConversationBinding(chatJid, registered, userId, chatName);
    }
  };
}

function resolveAutoImWorkspace(
  folder: string,
): { jid: string; folder: string } | null {
  const jids = getJidsByFolder(folder);
  for (const jid of jids) {
    if (!jid.startsWith('web:')) continue;
    const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (group) return { jid, folder: group.folder };
  }
  return null;
}

function createAutoImConversationAgent(input: {
  userId: string;
  sourceJid: string;
  groupFolder: string;
  name: string;
}): { agentId: string; workspaceJid: string; workspaceFolder: string } | null {
  const workspace = resolveAutoImWorkspace(input.groupFolder);
  if (!workspace) {
    logger.warn(
      {
        userId: input.userId,
        sourceJid: input.sourceJid,
        groupFolder: input.groupFolder,
      },
      'Cannot create auto IM conversation agent: workspace not found',
    );
    return null;
  }

  const agentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const agentName = input.name || input.sourceJid;
  createAgent({
    id: agentId,
    group_folder: workspace.folder,
    chat_jid: workspace.jid,
    name: agentName,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: input.userId,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: input.sourceJid,
    spawned_from_jid: null,
    source_kind: 'auto_im',
    last_active_at: now,
  });
  ensureAgentDirectories(workspace.folder, agentId);
  const virtualChatJid = `${workspace.jid}#agent:${agentId}`;
  ensureChatExists(virtualChatJid);
  updateChatName(virtualChatJid, agentName);
  updateAgentLastImJid(agentId, input.sourceJid);
  broadcastAgentStatus(
    workspace.jid,
    agentId,
    'idle',
    agentName,
    '',
    undefined,
    'conversation',
  );

  logger.info(
    { sourceJid: input.sourceJid, agentId, userId: input.userId },
    'Auto-created isolated conversation agent for Feishu IM chat',
  );
  return {
    agentId,
    workspaceJid: workspace.jid,
    workspaceFolder: workspace.folder,
  };
}

function ensureAutoImConversationBinding(
  jid: string,
  group: RegisteredGroup,
  userId: string,
  name: string,
): boolean {
  if (group.target_main_jid) return false;
  if (group.target_agent_id) {
    const existingAgent = getAgent(group.target_agent_id);
    if (existingAgent?.source_kind === 'auto_im') {
      ensureAgentDirectories(existingAgent.group_folder, existingAgent.id);
      updateAgentLastImJid(existingAgent.id, jid);
      return false;
    }
    return false;
  }

  const created = createAutoImConversationAgent({
    userId,
    sourceJid: jid,
    groupFolder: group.folder,
    name: name || group.name || jid,
  });
  if (!created) return false;

  group.target_agent_id = created.agentId;
  setRegisteredGroup(jid, group);
  registeredGroups[jid] = group;
  return true;
}

/**
 * Batch-apply autoIsolateContext toggle for a user's existing Feishu IM chats.
 * enable=true:  create conversation agents for unbound Feishu chats
 * enable=false: remove auto_im agent bindings (manual bindings untouched)
 */
function applyAutoIsolateContext(userId: string, enable: boolean): number {
  return applyAutoIsolateContextForGroups(userId, enable, {
    groups: getAllRegisteredGroups(),
    channelType: 'feishu',
    getChannelType,
    getAgent,
    ensureBinding: ensureAutoImConversationBinding,
    setGroup: (jid, group) => {
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
    },
    deleteAgent,
    broadcastAgentRemoved,
  });
}

/**
 * Record the Feishu owner's open_id (auto-detected from a P2P DM) and
 * unstick any of this user's groups whose `sender_allowlist=[]` —
 * the "owner-locked trap" that buildOnNewChat creates when a group is
 * registered before the owner has DM'd the bot.
 */
function learnFeishuOwner(
  userId: string,
  senderOpenId: string,
  ownerRef: { value: string | undefined },
): void {
  const ownerOpenId = ownerRef.value ?? senderOpenId;
  if (!ownerRef.value) {
    ownerRef.value = senderOpenId;
    saveFeishuOwnerOpenId(userId, senderOpenId);
  }
  const backfilled = backfillEmptyAllowlistsForUser(userId, ownerOpenId);
  for (const jid of backfilled) {
    const fresh = getRegisteredGroup(jid);
    if (fresh) registeredGroups[jid] = fresh;
  }
  logger.info(
    { userId, senderOpenId, ownerOpenId, backfilledCount: backfilled.length },
    'Feishu owner open_id auto-detected from P2P message',
  );
}

/**
 * Build the onBotRemovedFromGroup callback.
 * When bot is removed from a Feishu group or the group is disbanded,
 * clear any IM binding (agent or main conversation).
 */
function buildOnBotRemovedFromGroup(): (chatJid: string) => void {
  return (chatJid: string) => {
    removeImGroupRecord(
      chatJid,
      'Auto-removed IM group: bot removed or group disbanded',
    );
  };
}

/**
 * Build Telegram-specific bot-added-to-group handler.
 * Auto-registers the group (via buildOnNewChat) then sends a welcome message
 * guiding the user to bind or create a workspace.
 */
function buildTelegramBotAddedHandler(
  userId: string,
  homeFolder: string,
): (chatJid: string, chatName: string) => void {
  const onNewChat = buildOnNewChat(userId, homeFolder);
  return (chatJid: string, chatName: string) => {
    onNewChat(chatJid, chatName);
    const welcome =
      `已加入「${chatName}」！当前绑定到默认工作区。\n\n` +
      `/new <名称> — 新建工作区并绑定此群\n` +
      `/bind <工作区> — 绑定到已有工作区\n` +
      `/list — 查看所有工作区\n\n` +
      `也可以直接发消息，我会在默认工作区回复。`;
    imManager
      .sendMessage(chatJid, welcome)
      .catch((err) =>
        logger.warn(
          { chatJid, err },
          'Failed to send Telegram group welcome message',
        ),
      );
  };
}

/**
 * Build the onBotAddedToGroup handler for Feishu connections.
 * Registers the new group (locked by default) and sends a one-time welcome message.
 */
function buildFeishuBotAddedHandler(
  userId: string,
  homeFolder: string,
  getOwnerOpenId?: () => string | undefined,
): (chatJid: string, chatName: string) => void {
  const onNewChat = buildOnNewChat(userId, homeFolder, getOwnerOpenId);
  return (chatJid: string, chatName: string) => {
    const isNew = !registeredGroups[chatJid] && !getRegisteredGroup(chatJid);
    onNewChat(chatJid, chatName);
    if (isNew) {
      // 文案分支:仅在飞书路径(传入 getOwnerOpenId,DM 可学到 ownerOpenId 并启用 allowlist)
      // 才提示「已启用发言者白名单」+「私信识别 owner」。通用路径(dingtalk/discord/whatsapp
      // 不传 getOwnerOpenId)实际未启用白名单,DM 也没有 learnFeishuOwner 通道,引导用
      // /owner_mention 在群内自我认领。
      let welcome: string;
      if (getOwnerOpenId) {
        const ownerKnown = !!getOwnerOpenId();
        welcome =
          `已加入「${chatName}」。\n\n` +
          `当前群聊已启用发言者白名单,仅 bot owner 可触发我。\n` +
          (ownerKnown
            ? `Owner 已自动从私聊中识别。\n`
            : `请先向机器人发一条私信,系统将自动识别您的 owner 身份。\n`) +
          `\n/allow @成员 — 将群成员加入白名单\n` +
          `/disallow @成员 — 从白名单移除成员\n` +
          `/allowlist — 查看白名单`;
      } else {
        welcome =
          `已加入「${chatName}」。\n\n` +
          `机器人已加入群组。请由 owner 在群内发送 /owner_mention 自我认领,命令将永久绑定该身份。\n\n` +
          `/owner_mention — 认领工作区 owner\n` +
          `/list — 查看所有工作区\n` +
          `/new <名称> — 新建工作区并绑定此群`;
      }
      imManager
        .sendMessage(chatJid, welcome)
        .catch((err) =>
          logger.warn({ chatJid, err }, 'Failed to send group welcome message'),
        );
    }
  };
}

function buildIsChatAuthorized(
  userId: string,
  expectedAccountId?: string,
  allowLegacyUnscoped = false,
): (jid: string) => boolean {
  return (jid) => {
    const parsed = parseChannelAddress(jid);
    const scopedAccountId = parsed?.channelAccountId;
    const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (!group) return false;

    if (expectedAccountId) {
      const account = getChannelAccount(expectedAccountId);
      return matchesChannelAccountAuthorization({
        scopedAccountId,
        groupOwnerUserId: group.created_by,
        groupAccountId: group.channel_account_id,
        userId,
        expectedAccountId,
        expectedAccountOwnerUserId: account?.owner_user_id,
        expectedAccountIsLegacyDefault: account?.is_legacy_default,
        allowLegacyUnscoped,
      });
    }

    // Compatibility-only direct connectors never accept an account-scoped JID.
    // If a historical row already names an account, it must be this user's
    // projected legacy default rather than an arbitrary first-class bot.
    const account = group.channel_account_id
      ? getChannelAccount(group.channel_account_id)
      : undefined;
    return matchesChannelAccountAuthorization({
      scopedAccountId,
      groupOwnerUserId: group.created_by,
      groupAccountId: group.channel_account_id,
      userId,
      expectedAccountOwnerUserId: account?.owner_user_id,
      expectedAccountIsLegacyDefault: account?.is_legacy_default,
    });
  };
}

function resolveWorkspaceJid(targetMainJid: string): string | null {
  let effectiveJid = targetMainJid;
  if (
    !registeredGroups[effectiveJid] &&
    !getRegisteredGroup(effectiveJid) &&
    effectiveJid.startsWith('web:')
  ) {
    const folder = effectiveJid.slice(4);
    const jids = getJidsByFolder(folder);
    for (const j of jids) {
      if (j.startsWith('web:')) {
        effectiveJid = j;
        break;
      }
    }
  }
  return registeredGroups[effectiveJid] || getRegisteredGroup(effectiveJid)
    ? effectiveJid
    : null;
}

function buildOnPairAttempt(
  userId: string,
  accountId?: string,
  defaultWorkspaceJid?: string,
  allowLegacyUnscopedCode = false,
): (jid: string, chatName: string, code: string) => Promise<boolean> {
  return async (jid, chatName, code) => {
    const result = verifyPairingCode(code);
    if (!result) return false;
    if (result.userId !== userId) return false;
    if (result.accountId) {
      if (result.accountId !== accountId) return false;
    } else if (accountId && !allowLegacyUnscopedCode) {
      return false;
    }
    const parsed = parseChannelAddress(jid);
    if (accountId) {
      const account = getChannelAccount(accountId);
      if (!account || account.owner_user_id !== userId) return false;
    }
    const existingGroup = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (
      !matchesChannelPairTarget({
        scopedAccountId: parsed?.channelAccountId,
        existingGroupAccountId: existingGroup?.channel_account_id,
        expectedAccountId: accountId,
        allowLegacyUnscoped: allowLegacyUnscopedCode,
      })
    ) {
      return false;
    }
    const pairingUserHome = getUserHomeGroup(result.userId);
    if (!pairingUserHome) return false;
    buildOnNewChat(result.userId, pairingUserHome.folder)(jid, chatName);
    const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (group) {
      const fallbackWorkspaceJid = defaultWorkspaceJid ?? pairingUserHome.jid;
      const updated = accountId
        ? applyChannelAccountRegistrationFallback(
            group,
            accountId,
            fallbackWorkspaceJid,
          )
        : {
            ...group,
            ...(group.target_main_jid || group.target_agent_id
              ? {}
              : { target_main_jid: fallbackWorkspaceJid }),
          };
      const pairedOwnerImId = ownerImIdFromDirectConversationJid(jid);
      const paired = pairedOwnerImId
        ? claimOwner(
            updated,
            pairedOwnerImId,
            updated.owner_claim_source === 'configured'
              ? 'configured'
              : 'trusted_direct',
          )
        : updated;
      setRegisteredGroup(jid, paired);
      registeredGroups[jid] = paired;
    }
    return true;
  };
}

/**
 * Resolve or create a conversation session for a provider-native thread.
 * Creates the agent + binding on first message; updates activity on subsequent messages.
 * Side effects: DB writes, WS broadcasts, directory creation.
 */
function resolveOrCreateNativeThreadAgent(
  chatJid: string,
  workspaceJid: string,
  workspace: RegisteredGroup,
  group: RegisteredGroup,
  nativeContext: NativeThreadContext,
): { effectiveJid: string; agentId: string; sourceJid: string } {
  const now = new Date().toISOString();
  const threadId = nativeContext.contextId;
  const rootMessageId = nativeContext.rootMessageId;
  const routeJid = buildNativeThreadRouteJid(chatJid, threadId, rootMessageId);
  const nextTitle = nativeContext.title;
  let binding = getImContextBinding(chatJid, 'thread', threadId);
  let agent =
    binding?.agent_id != null ? getAgent(binding.agent_id) : undefined;

  if (!binding || !agent || agent.chat_jid !== workspaceJid) {
    const agentId = crypto.randomUUID();
    const agentName = binding?.title || nextTitle;
    const newAgent: SubAgent = {
      id: agentId,
      group_folder: workspace.folder,
      chat_jid: workspaceJid,
      name: agentName,
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: workspace.created_by || group.created_by || null,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: routeJid,
      spawned_from_jid: null,
      source_kind: 'native_thread',
      thread_id: threadId,
      root_message_id: rootMessageId,
      title_source: 'native_root',
      last_active_at: now,
    };
    createAgent(newAgent);
    ensureAgentDirectories(workspace.folder, agentId);
    const virtualChatJid = `${workspaceJid}#agent:${agentId}`;
    ensureChatExists(virtualChatJid);
    updateChatName(virtualChatJid, agentName);
    updateAgentLastImJid(agentId, routeJid);
    broadcastAgentStatus(
      workspaceJid,
      agentId,
      'idle',
      agentName,
      '',
      undefined,
      'conversation',
    );
    binding = {
      source_jid: chatJid,
      context_type: 'thread',
      context_id: threadId,
      workspace_jid: workspaceJid,
      agent_id: agentId,
      root_message_id: rootMessageId,
      title: agentName,
      last_active_at: now,
      created_at: now,
      updated_at: now,
    };
    upsertImContextBinding(binding);
    agent = newAgent;
  }

  const resolvedTitle = binding.title || nextTitle;
  // Skip redundant writes for steady-state messages (only update timestamps)
  const titleChanged = resolvedTitle !== binding.title;
  const rootChanged = rootMessageId !== binding.root_message_id;
  if (titleChanged || rootChanged) {
    upsertImContextBinding({
      ...binding,
      root_message_id: rootMessageId,
      title: resolvedTitle,
      last_active_at: now,
      updated_at: now,
    });
    updateAgentContextInfo(binding.agent_id, {
      name: resolvedTitle,
      last_active_at: now,
      ...(rootChanged ? { root_message_id: rootMessageId } : {}),
    });
    updateChatName(`${workspaceJid}#agent:${binding.agent_id}`, resolvedTitle);
  } else {
    // Lightweight: only touch activity timestamps
    touchImContextBindingActivity(chatJid, 'thread', threadId, now);
    updateAgentContextInfo(binding.agent_id, { last_active_at: now });
  }
  updateAgentLastImJid(binding.agent_id, routeJid);
  return {
    effectiveJid: `${workspaceJid}#agent:${binding.agent_id}`,
    agentId: binding.agent_id,
    sourceJid: routeJid,
  };
}

function isUsableFeishuContextBinding(
  binding: ReturnType<typeof getImContextBinding>,
  expectedWorkspaceJid: string | null,
): binding is NonNullable<typeof binding> {
  if (!binding || !expectedWorkspaceJid) return false;
  const agent = getAgent(binding.agent_id);
  return (
    binding.workspace_jid === expectedWorkspaceJid &&
    agent?.chat_jid === expectedWorkspaceJid
  );
}

function findActiveFeishuContext(
  chatJid: string,
  group: RegisteredGroup,
  messageMeta: ChannelMessageMeta,
): ActiveFeishuContext | undefined {
  const expectedWorkspaceJid = group.target_main_jid
    ? resolveWorkspaceJid(group.target_main_jid)
    : null;
  if (!expectedWorkspaceJid) return undefined;

  const candidateIds = Array.from(
    new Set(
      [messageMeta.contextId, messageMeta.threadId, messageMeta.rootId].filter(
        (value): value is string => !!value,
      ),
    ),
  );
  for (const contextId of candidateIds) {
    const binding = getImContextBinding(chatJid, 'thread', contextId);
    if (isUsableFeishuContextBinding(binding, expectedWorkspaceJid)) {
      return {
        contextId: binding.context_id,
        rootMessageId:
          binding.root_message_id || messageMeta.rootId || contextId,
      };
    }
  }

  if (messageMeta.rootId) {
    const binding = getImContextBindingByRootMessageId(
      chatJid,
      'thread',
      messageMeta.rootId,
    );
    if (isUsableFeishuContextBinding(binding, expectedWorkspaceJid)) {
      return {
        contextId: binding.context_id,
        rootMessageId: binding.root_message_id || messageMeta.rootId,
      };
    }
  }
  return undefined;
}

/**
 * Context-aware Feishu activation plan used before mention gating. Reading an
 * existing binding is side-effect free; a new conversation agent is only
 * created later, after the gate has accepted the message.
 */
function resolveFeishuConversationPlanForMessage(
  chatJid: string,
  messageMeta: ChannelMessageMeta,
): FeishuConversationPlan {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  const chatMode =
    group?.feishu_chat_mode === 'topic' ||
    group?.feishu_group_message_type === 'thread'
      ? 'topic'
      : (group?.feishu_chat_mode ??
        (messageMeta.chatType === 'p2p' ? 'p2p' : 'group'));
  const activationMode = group?.activation_mode ?? 'auto';
  const mentionRequired = feishuRequiresMention(
    activationMode,
    group?.require_mention,
  );
  const activeContext =
    group && (chatMode === 'topic' || mentionRequired)
      ? findActiveFeishuContext(chatJid, group, messageMeta)
      : undefined;

  return resolveFeishuConversationPlan({
    chatType: messageMeta.chatType,
    chatMode,
    activationMode,
    requireMention: group?.require_mention,
    mentionedBot: messageMeta.mentionedBot === true,
    messageId: messageMeta.messageId || '',
    threadId: messageMeta.threadId,
    rootId: messageMeta.rootId,
    activeContext,
  });
}

function ensureNativeContextChannelMount(
  chatJid: string,
  group: RegisteredGroup,
): RegisteredGroup | null {
  // A Feishu ordinary group in mention mode uses thread_map for isolated
  // sessions, but it is not itself a native topic container. Do not persist a
  // false capability marker merely because one message opened a topic.
  const persistNativeCapability =
    getChannelType(chatJid) !== 'feishu' ||
    group.feishu_chat_mode === 'topic' ||
    group.feishu_group_message_type === 'thread';
  let routableGroup = group;
  if (
    !persistNativeCapability &&
    group.target_agent_id &&
    getChannelType(chatJid) === 'feishu'
  ) {
    // Compatibility migration for configurations created before mention mode
    // meant "one session per activated topic". A fixed session cannot hold
    // multiple topic sessions, so promote it to that session's workspace on
    // the first accepted mention instead of silently dropping the message.
    const previousSession = getAgent(group.target_agent_id);
    const workspaceJid = previousSession?.chat_jid;
    if (workspaceJid && getRegisteredGroup(workspaceJid)) {
      routableGroup = buildWorkspaceMountUpdate(
        group,
        workspaceJid,
        'thread_map',
        {
          activationMode: group.activation_mode,
          ownerImId: group.owner_im_id ?? null,
        },
      );
      setRegisteredGroup(chatJid, routableGroup);
      registeredGroups[chatJid] = routableGroup;
      logger.info(
        { chatJid, previousSessionId: group.target_agent_id, workspaceJid },
        'Promoted legacy fixed-session Feishu mention binding to workspace thread map',
      );
    }
  }
  const detectedGroup: RegisteredGroup = persistNativeCapability
    ? { ...routableGroup, native_context_type: 'thread' }
    : routableGroup;
  const upgrade = upgradeNativeContextChannelMount(chatJid, detectedGroup);
  if (upgrade.status === 'conflict') {
    // Persist capability detection for diagnostics/UI while retaining the
    // prior binding. Returning null is the fail-closed routing signal.
    setRegisteredGroup(chatJid, detectedGroup);
    registeredGroups[chatJid] = detectedGroup;
    logger.error(
      {
        chatJid,
        reason: upgrade.reason,
        conflictingJid:
          'conflictingJid' in upgrade ? upgrade.conflictingJid : undefined,
      },
      'Native-context channel mount upgrade rejected; dropping message',
    );
    return null;
  }

  let updated = upgrade.updated;
  if (
    persistNativeCapability &&
    ((upgrade.status === 'unchanged' &&
      group.native_context_type !== 'thread') ||
      updated.native_context_type !== 'thread')
  ) {
    updated = { ...updated, native_context_type: 'thread' };
    setRegisteredGroup(chatJid, updated);
  }
  registeredGroups[chatJid] = updated;
  markThreadMapWorkspace(updated.target_main_jid);
  return updated;
}

function buildOnNativeContextDetected(): (
  chatJid: string,
  contextType: 'thread',
) => boolean {
  return (chatJid, contextType) => {
    if (contextType !== 'thread') return false;
    const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) return false;
    return ensureNativeContextChannelMount(chatJid, group) !== null;
  };
}

/**
 * Build callback that resolves an IM chatJid to a bound target JID.
 * Supports both conversation agent binding (target_agent_id) and
 * workspace main conversation binding (target_main_jid).
 * Returns null if the chatJid has no binding configured.
 */
function buildResolveEffectiveChatJid(): (
  chatJid: string,
  messageMeta?: ChannelMessageMeta,
) => {
  effectiveJid: string;
  agentId: string | null;
  sourceJid?: string;
} | null {
  return (chatJid: string, messageMeta) => {
    let group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    if (!group) {
      logger.debug({ chatJid }, 'resolveEffectiveChatJid: group not found');
      return null;
    }

    const channelType = getChannelType(chatJid);
    const nativeThread =
      channelType === 'feishu' && messageMeta?.nativeContextType !== 'thread'
        ? null
        : resolveNativeThreadContext(messageMeta);
    const nativeThreadDetected =
      !!nativeThread &&
      (messageMeta?.nativeContextType === 'thread' ||
        (channelType === 'telegram' && !!messageMeta?.threadId));
    if (nativeThreadDetected) {
      const upgraded = ensureNativeContextChannelMount(chatJid, group);
      if (!upgraded) return null;
      group = upgraded;
    }

    const mount = getChannelMount(chatJid);
    if (mount) {
      const mountedTarget = resolveChannelMountTarget(mount, {
        getAgent,
        getRegisteredGroup: (jid) =>
          registeredGroups[jid] ?? getRegisteredGroup(jid),
      });
      if (mountedTarget.status === 'stale') {
        logger.warn(
          {
            chatJid,
            reason: mountedTarget.reason,
            sessionId: mountedTarget.sessionId,
            workspaceJid: mountedTarget.workspaceJid,
          },
          'resolveEffectiveChatJid: stale channel_mounts row, message will not route',
        );
        return null;
      }
      if (mountedTarget.workspaceMismatch) {
        logger.warn(
          { chatJid, ...mountedTarget.workspaceMismatch },
          'resolveEffectiveChatJid: channel_mounts workspace differs from session owner, using session owner workspace',
        );
      }
      if (mountedTarget.agentId) {
        return {
          effectiveJid: mountedTarget.effectiveJid,
          agentId: mountedTarget.agentId,
        };
      }

      if (mount.routing_mode === 'thread_map' && nativeThread) {
        return resolveOrCreateNativeThreadAgent(
          chatJid,
          mountedTarget.workspaceJid,
          mountedTarget.workspace,
          group,
          nativeThread,
        );
      }

      return { effectiveJid: mountedTarget.effectiveJid, agentId: null };
    }

    // Agent binding takes priority
    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      if (!agent) {
        logger.warn(
          { chatJid, targetAgentId: group.target_agent_id },
          'resolveEffectiveChatJid: agent not found for target_agent_id',
        );
        return null;
      }
      // Use the agent's actual chat_jid (the workspace's registered JID) as the
      // base for the virtual JID.  Previously we constructed web:${folder} which
      // doesn't match any registered group for non-main workspaces (folder ≠ JID).
      const effectiveJid = `${agent.chat_jid}#agent:${group.target_agent_id}`;
      return { effectiveJid, agentId: group.target_agent_id };
    }

    if (
      group.binding_mode === 'thread_map' &&
      group.target_main_jid &&
      nativeThread
    ) {
      const workspaceJid = resolveWorkspaceJid(group.target_main_jid);
      if (!workspaceJid) {
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'thread_map resolveWorkspaceJid returned null — stale target_main_jid',
        );
        return null;
      }
      const workspace =
        registeredGroups[workspaceJid] ?? getRegisteredGroup(workspaceJid);
      if (!workspace) return null;

      return resolveOrCreateNativeThreadAgent(
        chatJid,
        workspaceJid,
        workspace,
        group,
        nativeThread,
      );
    }

    // Main conversation binding
    if (group.target_main_jid) {
      const effectiveJid = resolveWorkspaceJid(group.target_main_jid);
      if (!effectiveJid) {
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'resolveWorkspaceJid returned null — target_main_jid is stale or missing, message will not route to workspace',
        );
        return null;
      }
      return { effectiveJid, agentId: null };
    }

    logger.debug(
      {
        chatJid,
        targetAgentId: group.target_agent_id,
        targetMainJid: group.target_main_jid,
      },
      'resolveEffectiveChatJid: no binding found',
    );
    return null;
  };
}

/**
 * Build callback that triggers processAgentConversation when an IM message is routed to an agent.
 */
function buildOnAgentMessage(): (baseChatJid: string, agentId: string) => void {
  return (baseChatJid: string, agentId: string) => {
    // The IM sockets deliberately remain connected while graceful shutdown
    // drains/stops Agent loops and finalizes their cards. Reject new intake at
    // this boundary so the live connection cannot enqueue a fresh run during
    // that drain window.
    if (shuttingDown) return;
    const group =
      registeredGroups[baseChatJid] ?? getRegisteredGroup(baseChatJid);
    if (!group) {
      logger.warn({ baseChatJid, agentId });
      return;
    }

    // Use the agent's actual chat_jid (the workspace's registered JID) as the
    // base.  Previously we used web:${folder} which doesn't match any registered
    // group for non-main workspaces (their JID is web:{uuid}, not web:{folder}).
    const agent = getAgent(agentId);
    const homeChatJid = agent?.chat_jid || `web:${group.folder}`;
    const virtualChatJid = `${homeChatJid}#agent:${agentId}`;

    // Fetch pending messages
    const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
    const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);

    // IM messages must force-restart the agent process so reply routing
    // (replySourceImJid) is recalculated from the latest batch.  This mirrors
    // the home-folder force-restart for the main conversation.
    const lastSourceJid = missedMessages[missedMessages.length - 1]?.source_jid;
    const isImSource =
      !!lastSourceJid && getChannelType(lastSourceJid) !== null;

    if (isImSource) {
      // Force close running process then enqueue fresh start.
      // Use a stable taskId so rapid-fire IM messages deduplicate into a
      // single queued restart instead of N separate restarts.
      logger.info({ virtualChatJid, taskId: `agent-im-restart:${agentId}` });
      queue.closeStdin(virtualChatJid);
      const taskId = `agent-im-restart:${agentId}`;
      logger.debug(
        { virtualChatJid, taskId },
        'Agent IM restart: closing stdin and enqueuing task',
      );
      queue.enqueueTask(virtualChatJid, taskId, async () => {
        logger.debug(
          { homeChatJid, agentId },
          'Agent IM restart: starting processAgentConversation',
        );
        logger.info(
          { homeChatJid, agentId, taskId },
          'sub-agent task IPC received',
        );
        try {
          return await processAgentConversation(homeChatJid, agentId);
        } catch (err) {
          logger.error(
            { err, homeChatJid, agentId },
            'Agent IM restart: processAgentConversation failed',
          );
        }
      });
    } else {
      // Web-origin: try to pipe into running agent process
      logger.debug(
        {
          virtualChatJid,
          missedMessages: missedMessages.length,
          isImSource,
        },
        'Web-origin missed messages: attempting to pipe into running agent',
      );
      const knownReferencedMessageIds = collectPersistedReferencedMessageIds(
        virtualChatJid,
        missedMessages,
      );
      const formatted =
        missedMessages.length > 0
          ? formatMessages(missedMessages, {
              knownMessageIds: knownReferencedMessageIds,
            })
          : '';
      const images = collectMessageImages(virtualChatJid, missedMessages, {
        knownMessageIds: knownReferencedMessageIds,
      });
      const imagesForAgent = images.length > 0 ? images : undefined;

      const lastAgentSourceJid =
        missedMessages[missedMessages.length - 1]?.source_jid || virtualChatJid;
      const deliveryTarget = createIpcDeliveryTarget(
        virtualChatJid,
        missedMessages,
      );
      const sendResult = formatted
        ? queue.sendMessage(
            virtualChatJid,
            formatted,
            imagesForAgent,
            (receipt) => {
              // 用户消息注入成功 → 挂起中的 agent 卡先定稿轮换
              activeHeldCardFinalizers.get(virtualChatJid)?.(
                lastAgentSourceJid,
                receipt?.deliveryId,
              );
              if (receipt) {
                activeAgentBuilderTurns.enqueueBatch(
                  agentBuilderTurnScope(
                    agent?.group_folder ?? group.folder,
                    agentId,
                  ),
                  (receipt.coveredCursors ?? [receipt.cursor]).map(
                    (cursor) => ({
                      chatJid: receipt.chatJid,
                      messageId: cursor.id,
                      runtimeTurnId: receipt.deliveryId,
                      scheduledTaskId: null,
                    }),
                  ),
                );
                grantWorkspaceMemoryTurnToCurrentRunner(
                  {
                    groupFolder: agent?.group_folder ?? group.folder,
                    agentId,
                    taskRunId: null,
                  },
                  receipt.deliveryId,
                );
              }
            },
            lastAgentSourceJid,
            undefined,
            deliveryTarget,
            undefined,
            (receipt) =>
              invokeActiveRouteAdmission(
                agent?.group_folder ?? group.folder,
                lastAgentSourceJid,
                receipt,
                agentId,
              ),
          )
        : 'no_active';
      if (sendResult === 'sent' && deliveryTarget) {
        advanceNextPullCursorOnly(virtualChatJid, deliveryTarget.cursor);
      }
      if (sendResult === 'no_active') {
        const taskId = `agent-conv:${agentId}:${Date.now()}`;
        queue.enqueueTask(virtualChatJid, taskId, async () => {
          return processAgentConversation(homeChatJid, agentId);
        });
      }
    }
    logger.info(
      {
        baseChatJid,
        homeChatJid,
        agentId,
        messageCount: missedMessages.length,
      },
      'IM message triggered agent conversation processing',
    );
  };
}

/**
 * Mention gating callback: when bot is NOT @mentioned in a group chat,
 * return true to process the message anyway, false to drop it.
 *
 * @param senderImId - 发送者的 IM 标识符（如飞书 open_id），用于 owner_mentioned 模式
 */
function shouldProcessGroupMessage(
  chatJid: string,
  senderImId?: string,
): boolean {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return false;

  // activation_mode 直接存在 IM 群组自身的 registered_groups 记录上（绑定时设置），
  // 无需追溯 target_main_jid
  const mode = group.activation_mode ?? 'auto';

  switch (mode) {
    case 'always':
      return true; // 群聊不需要 @bot
    case 'when_mentioned':
      return false; // 必须 @bot
    case 'owner_mentioned':
      return false; // 需要 @bot，且后续还需检查 sender 是否为 owner
    case 'disabled':
      return false; // 忽略所有消息（在调用方处理 disabled 的 DM 忽略）
    case 'auto':
    default:
      // 兼容旧行为：require_mention defaults to false; if true → only process @mentions
      return group.require_mention !== true;
  }
}

/**
 * 检查发送者是否为群组 owner（用于 owner_mentioned 模式）。
 * 当 activation_mode 为 'owner_mentioned' 且 bot 被 @mention 时调用。
 * owner_im_id 通过 /owner_mention 命令设置，确保身份准确。
 */
function isGroupOwnerMessage(chatJid: string, senderImId?: string): boolean {
  if (!senderImId) return false;
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return false;
  if (group.activation_mode !== 'owner_mentioned') return true; // 非 owner_mentioned 模式不检查
  if (!group.owner_im_id) return false; // 未设置 owner，拒绝所有（需要先执行 /owner_mention）
  return group.owner_im_id === senderImId;
}

/**
 * 群聊发言者白名单检查。
 * sender_allowlist 为 null/undefined 时不限制（默认），为空数组时无人可触发，
 * 为字符串数组时仅列表中的 open_id 可触发。
 */
function isSenderAllowedInGroup(chatJid: string, senderImId?: string): boolean {
  const conversationJid = channelConversationJid(
    stripVirtualJidSuffix(chatJid),
  );
  const group =
    registeredGroups[conversationJid] ?? getRegisteredGroup(conversationJid);
  // The first Feishu DM is also the trusted owner-discovery event. Let an
  // unknown chat reach admission only if there is no known account owner yet,
  // or this sender already matches that owner.
  if (!group) {
    if (getChannelType(conversationJid) !== 'feishu') return false;
    const accountId = parseChannelAddress(conversationJid)?.channelAccountId;
    const account = accountId ? getChannelAccount(accountId) : undefined;
    const knownOwner = account
      ? getUserFeishuConfig(account.owner_user_id)?.ownerOpenId
      : undefined;
    return isUnknownFeishuSenderAllowed(knownOwner, senderImId);
  }

  // The explicit response audience is evaluated for p2p, ordinary groups and
  // every topic message. It is deliberately independent from mention policy.
  if (effectiveAudienceMode(group) === 'owner_only') {
    return isSenderAllowedByAudience(group, senderImId);
  }

  // v58 Feishu uses the explicit two-state audience policy as the source of
  // truth. Legacy allowlists are retained only for migration/audit and for
  // other connectors that still expose multi-member allowlists.
  if (getChannelType(conversationJid) === 'feishu') return true;

  // Keep the legacy multi-member allowlist as an additional restriction for
  // existing installations. New UI only exposes everyone/owner-only.
  const allowlist = group.sender_allowlist;
  if (allowlist === undefined || allowlist === null) return true;
  if (!senderImId) return false;
  return allowlist.includes(senderImId);
}

function handleIncomingFollowUp(input: {
  targetJid: string;
  sourceJid: string;
  messageId: string;
  senderImId: string;
  requestedMode?: FollowUpMode;
  repliedToActiveCard: boolean;
}): import('./types.js').FollowUpDisposition {
  const activeRunId = queue.getActiveQueryId(input.targetJid);
  if (!activeRunId) return { disposition: 'started' };
  const mode = resolveFeishuFollowUpMode(
    input.requestedMode,
    input.repliedToActiveCard,
  );
  setMessageFollowUp(input.targetJid, input.messageId, {
    mode,
    status: 'queued',
    runId: activeRunId,
  });
  if (mode === 'steer') {
    const result = promoteFollowUp(
      input.targetJid,
      input.messageId,
      activeRunId,
    );
    if (result.ok) {
      return { disposition: 'steered', runId: activeRunId };
    }
  }
  const position =
    listQueuedFollowUps(input.targetJid).findIndex(
      (item) => item.id === input.messageId,
    ) + 1;
  return {
    disposition: 'queued',
    runId: activeRunId,
    position: Math.max(position, 1),
  };
}

async function handleFollowUpCardAction(input: {
  sourceJid: string;
  targetJid: string;
  messageId: string;
  action: import('./types.js').FollowUpAction;
  expectedRunId: string;
  operatorImId: string;
}): Promise<FollowUpActionResult> {
  const item = getQueuedFollowUp(input.targetJid, input.messageId);
  if (!item) return { ok: false, message: '这条排队消息已被处理或取消。' };
  if (
    !input.operatorImId ||
    item.sender !== input.operatorImId ||
    !isSenderAllowedInGroup(input.sourceJid, input.operatorImId)
  ) {
    return { ok: false, message: '只有这条消息的发送者可以操作它。' };
  }
  if (input.action === 'cancel') {
    return cancelFollowUp(input.targetJid, input.messageId);
  }
  if (input.action === 'steer') {
    return promoteFollowUp(
      input.targetJid,
      input.messageId,
      input.expectedRunId,
    );
  }
  return interruptAndRunFollowUp(
    input.targetJid,
    input.messageId,
    input.expectedRunId,
  );
}

/**
 * 飞书流式卡片按钮中断回调。
 * 仅由飞书卡片按钮触发，不涉及自动关键词检测。
 */
function handleCardInterrupt(
  chatJid: string,
  operatorImId: string,
): FollowUpActionResult {
  if (!operatorImId) {
    return { ok: false, message: '无法验证操作者身份，未执行中断。' };
  }
  const sourceChatJid = channelConversationJid(stripVirtualJidSuffix(chatJid));
  if (
    getChannelType(sourceChatJid) === 'feishu' &&
    !isSenderAllowedInGroup(sourceChatJid, operatorImId)
  ) {
    return { ok: false, message: '你没有中断这个会话的权限。' };
  }
  const interrupted = queue.interruptQuery(chatJid);
  if (!interrupted) {
    return { ok: false, message: '当前回复已经结束，无需中断。' };
  }
  logger.info({ chatJid, operatorImId }, 'Card interrupt: query interrupted');

  const session = getStreamingSession(chatJid);
  if (session?.isActive()) {
    session.abort('已停止').catch((err) => {
      logger.debug({ err, chatJid }, 'Failed to abort streaming card');
    });
  }
  return { ok: true, state: 'interrupting', message: '已停止当前回复。' };
}

function resolveChannelAccountWorkspace(account: ChannelAccount): {
  jid: string;
  folder: string;
} | null {
  return resolveChannelAccountFallbackWorkspace(account, {
    getGroup: getRegisteredGroup,
    getHome: getUserHomeGroup,
  });
}

async function disconnectChannelAccountById(accountId: string): Promise<void> {
  const account = getChannelAccount(accountId);
  if (!account) return;
  await imManager.disconnectUserChannelAccount(
    account.owner_user_id,
    account.provider,
    account.id,
  );
  updateChannelAccountStatus(account.id, 'disconnected');
}

async function reloadChannelAccountById(accountId: string): Promise<boolean> {
  const account = getChannelAccount(accountId);
  if (!account) return false;
  await imManager.disconnectUserChannelAccount(
    account.owner_user_id,
    account.provider,
    account.id,
  );
  if (!account.enabled) {
    updateChannelAccountStatus(account.id, 'disconnected');
    return false;
  }
  const secret = loadChannelAccountSecret(account.secret_ref);
  const workspace = resolveChannelAccountWorkspace(account);
  if (!secret || !workspace) {
    updateChannelAccountStatus(
      account.id,
      'error',
      !secret ? 'Credentials are missing' : 'Default workspace is missing',
    );
    return false;
  }

  updateChannelAccountStatus(account.id, 'connecting');
  const baseOnNewChat = buildOnNewChat(
    account.owner_user_id,
    workspace.folder,
    account.provider === 'feishu'
      ? () => secret.ownerOpenId || undefined
      : undefined,
  );
  const onNewChat = (jid: string, name: string) => {
    baseOnNewChat(jid, name);
    const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (!group) return;
    const updated = applyChannelAccountRegistrationFallback(
      group,
      account.id,
      workspace.jid,
    );
    // Steady-state inbound messages resolve to an already-attached group;
    // rewriting an identical row on every message was pure write amplification.
    if (updated === group) return;
    setRegisteredGroup(jid, updated);
    registeredGroups[jid] = updated;
  };
  const common = {
    accountId: account.id,
    scopeIncomingJids: !account.is_legacy_default,
    ignoreMessagesBefore: Date.now(),
    onCommand: handleCommand,
    resolveGroupFolder: (jid: string) => resolveEffectiveFolder(jid),
    resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
    onAgentMessage: buildOnAgentMessage(),
    onNativeContextDetected: buildOnNativeContextDetected(),
    onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
  };

  try {
    let connected = false;
    if (account.provider === 'feishu') {
      connected = await imManager.connectUserFeishu(
        account.owner_user_id,
        {
          appId: secret.appId || '',
          appSecret: secret.appSecret || '',
          enabled: true,
        },
        onNewChat,
        {
          ...common,
          onBotAddedToGroup: onNewChat,
          shouldProcessGroupMessage,
          resolveFeishuConversationPlan:
            resolveFeishuConversationPlanForMessage,
          isGroupOwnerMessage,
          isSenderAllowedInGroup,
          onFollowUpMessage: handleIncomingFollowUp,
          onFollowUpCardAction: handleFollowUpCardAction,
          onCardInterrupt: handleCardInterrupt,
          onP2pSender: (senderOpenId: string) => {
            // First valid DM claims this bot. Never let a later arbitrary DM
            // replace the account owner.
            if (!senderOpenId) return;
            const ownerOpenId = secret.ownerOpenId ?? senderOpenId;
            if (!secret.ownerOpenId) {
              secret.ownerOpenId = senderOpenId;
              saveChannelAccountSecret(account.secret_ref, secret);
              if (account.is_legacy_default) {
                saveFeishuOwnerOpenId(account.owner_user_id, senderOpenId);
              }
            }
            for (const jid of backfillEmptyAllowlistsForChannelAccount(
              account.owner_user_id,
              account.id,
              ownerOpenId,
            )) {
              const fresh = getRegisteredGroup(jid);
              if (fresh) registeredGroups[jid] = fresh;
            }
          },
        },
      );
    } else if (account.provider === 'telegram') {
      connected = await imManager.connectUserTelegram(
        account.owner_user_id,
        {
          botToken: secret.botToken || '',
          proxyUrl: secret.proxyUrl,
          enabled: true,
        },
        onNewChat,
        buildIsChatAuthorized(
          account.owner_user_id,
          account.id,
          account.is_legacy_default,
        ),
        buildOnPairAttempt(
          account.owner_user_id,
          account.id,
          workspace.jid,
          account.is_legacy_default,
        ),
        { ...common, onBotAddedToGroup: onNewChat },
      );
    } else if (account.provider === 'qq') {
      connected = await imManager.connectUserQQ(
        account.owner_user_id,
        { appId: secret.appId || '', appSecret: secret.appSecret || '' },
        onNewChat,
        buildIsChatAuthorized(
          account.owner_user_id,
          account.id,
          account.is_legacy_default,
        ),
        buildOnPairAttempt(
          account.owner_user_id,
          account.id,
          workspace.jid,
          account.is_legacy_default,
        ),
        common,
      );
    } else if (account.provider === 'wechat') {
      const bypassProxy = secret.bypassProxy !== 'false';
      connected = await imManager.connectUserWeChat(
        account.owner_user_id,
        {
          botToken: secret.botToken || '',
          ilinkBotId: secret.ilinkBotId || '',
          baseUrl: secret.baseUrl,
          cdnBaseUrl: secret.cdnBaseUrl,
          getUpdatesBuf: secret.getUpdatesBuf,
          bypassProxy,
        },
        onNewChat,
        {
          ...common,
          // A durable cursor is a replay boundary. Do not discard replayed
          // messages after a crash merely because they predate this process.
          ignoreMessagesBefore: secret.getUpdatesBuf
            ? undefined
            : common.ignoreMessagesBefore,
          isChatAuthorized: buildIsChatAuthorized(
            account.owner_user_id,
            account.id,
            account.is_legacy_default,
          ),
          onPairAttempt: buildOnPairAttempt(
            account.owner_user_id,
            account.id,
            workspace.jid,
            account.is_legacy_default,
          ),
          onConnectionStateChange: (state) => {
            if (state.status === 'connected') {
              updateChannelAccountAuthStatus(account.id, 'authorized');
              updateChannelAccountStatus(account.id, 'connected');
            } else if (state.status === 'connecting') {
              updateChannelAccountStatus(account.id, 'connecting');
            } else if (state.status === 'reconnecting') {
              updateChannelAccountStatus(
                account.id,
                'reconnecting',
                state.error,
              );
            } else if (state.status === 'expired') {
              updateChannelAccountAuthStatus(
                account.id,
                'revoked',
                state.error,
              );
              updateChannelAccountStatus(
                account.id,
                'disconnected',
                state.error,
              );
            } else {
              // A normal transport stop preserves reusable authorization.
              updateChannelAccountStatus(
                account.id,
                'disconnected',
                state.error,
              );
            }
            const latest = getChannelAccount(account.id);
            if (latest) {
              broadcastChannelAccountStatus(account.owner_user_id, account.id, {
                transportStatus: latest.transport_status,
                lastError: latest.last_error,
                connectedAt: latest.connected_at,
                errorCode: state.errorCode,
                consecutiveFailures: state.consecutiveFailures,
                nextRetryMs: state.nextRetryMs,
              });
            }
          },
          onUpdatesBuf: (cursor: string) => {
            if (!cursor || secret.getUpdatesBuf === cursor) return;
            const latestSecret =
              loadChannelAccountSecret(account.secret_ref) ?? secret;
            if (latestSecret.getUpdatesBuf === cursor) {
              secret.getUpdatesBuf = cursor;
              return;
            }
            secret.getUpdatesBuf = cursor;
            saveChannelAccountSecret(account.secret_ref, {
              ...latestSecret,
              getUpdatesBuf: cursor,
            });
            if (account.is_legacy_default) {
              const legacy = getUserWeChatConfig(account.owner_user_id);
              if (legacy && legacy.getUpdatesBuf !== cursor) {
                saveUserWeChatConfig(account.owner_user_id, {
                  ...legacy,
                  getUpdatesBuf: cursor,
                });
              }
            }
          },
        },
      );
    } else if (account.provider === 'dingtalk') {
      connected = await imManager.connectUserDingTalk(
        account.owner_user_id,
        {
          clientId: secret.clientId || '',
          clientSecret: secret.clientSecret || '',
          streamingMode: secret.streamingMode === 'text' ? 'text' : 'card',
        },
        onNewChat,
        {
          ...common,
          isChatAuthorized: buildIsChatAuthorized(
            account.owner_user_id,
            account.id,
            account.is_legacy_default,
          ),
          onPairAttempt: buildOnPairAttempt(
            account.owner_user_id,
            account.id,
            workspace.jid,
            account.is_legacy_default,
          ),
          onBotAddedToGroup: onNewChat,
          shouldProcessGroupMessage,
          isGroupOwnerMessage,
          resolveRegisteredGroup: getRegisteredGroup,
        },
      );
    } else if (account.provider === 'discord') {
      connected = await imManager.connectUserDiscord(
        account.owner_user_id,
        {
          botToken: secret.botToken || '',
          streamingMode: secret.streamingMode === 'edit' ? 'edit' : 'off',
        },
        onNewChat,
        {
          ...common,
          isChatAuthorized: buildIsChatAuthorized(
            account.owner_user_id,
            account.id,
            account.is_legacy_default,
          ),
          onPairAttempt: buildOnPairAttempt(
            account.owner_user_id,
            account.id,
            workspace.jid,
            account.is_legacy_default,
          ),
          onBotAddedToGroup: onNewChat,
          shouldProcessGroupMessage,
          isGroupOwnerMessage,
        },
      );
    } else {
      if (account.is_legacy_default) {
        migrateLegacyWhatsAppAuthDir(
          DATA_DIR,
          account.owner_user_id,
          secret.accountId,
          account.id,
        );
      }
      connected = await imManager.connectUserWhatsApp(
        account.owner_user_id,
        {
          accountId: account.id,
          phoneNumber: secret.phoneNumber,
          enabled: true,
        },
        onNewChat,
        {
          ...common,
          isChatAuthorized: buildIsChatAuthorized(
            account.owner_user_id,
            account.id,
            account.is_legacy_default,
          ),
          onPairAttempt: buildOnPairAttempt(
            account.owner_user_id,
            account.id,
            workspace.jid,
            account.is_legacy_default,
          ),
          onBotAddedToGroup: onNewChat,
          shouldProcessGroupMessage,
          isGroupOwnerMessage,
          onConnectionUpdate: (uid, connectedAccountId, state) => {
            if (state.status === 'connected') {
              updateChannelAccountAuthStatus(account.id, 'authorized');
              updateChannelAccountStatus(account.id, 'connected');
            } else if (state.status === 'qr' || state.status === 'connecting') {
              updateChannelAccountAuthStatus(account.id, 'awaiting_scan');
              updateChannelAccountStatus(account.id, 'connecting');
            } else if (state.status === 'logged_out') {
              updateChannelAccountAuthStatus(
                account.id,
                'revoked',
                state.error,
              );
              updateChannelAccountStatus(
                account.id,
                'disconnected',
                state.error,
              );
            } else {
              updateChannelAccountStatus(
                account.id,
                'disconnected',
                state.error,
              );
            }
            broadcastWhatsAppStatus(uid, connectedAccountId, state);
          },
        },
      );
    }
    if (account.provider === 'whatsapp') {
      // Baileys returns after the socket is created, before QR authorization
      // and before connection.update('open'). The callback above is the only
      // source allowed to publish transport=connected.
      if (!connected) {
        updateChannelAccountStatus(account.id, 'error', 'Connection failed');
      }
    } else if (account.provider === 'wechat') {
      // connectUserWeChat returns once the local poller is retained. Its
      // connection-state callback is the sole authority for connecting,
      // connected and reconnecting transport states.
      if (!connected) {
        updateChannelAccountStatus(account.id, 'error', '微信轮询启动失败');
      }
    } else {
      updateChannelAccountStatus(
        account.id,
        connected ? 'connected' : 'error',
        connected ? null : 'Connection failed',
      );
      if (connected && account.provider === 'feishu') {
        ensureFeishuSyncScheduler();
      }
    }
    return connected;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateChannelAccountStatus(account.id, 'error', message.slice(0, 1000));
    logger.warn(
      { error, accountId: account.id, provider: account.provider },
      'Channel account connection failed',
    );
    return false;
  }
}

function syncLegacyConfigToDefaultChannelAccount(
  userId: string,
  channel:
    | 'feishu'
    | 'telegram'
    | 'qq'
    | 'wechat'
    | 'dingtalk'
    | 'discord'
    | 'whatsapp',
): ChannelAccount | null {
  if (channel === 'feishu') {
    const value = getUserFeishuConfig(userId);
    return value
      ? syncDefaultChannelAccountCredentials({
          ownerUserId: userId,
          provider: channel,
          name: '默认飞书',
          enabled: value.enabled !== false,
          secret: {
            appId: value.appId,
            appSecret: value.appSecret,
            ownerOpenId: value.ownerOpenId,
          },
        })
      : null;
  }
  if (channel === 'telegram') {
    const value = getUserTelegramConfig(userId);
    return value
      ? syncDefaultChannelAccountCredentials({
          ownerUserId: userId,
          provider: channel,
          name: '默认 Telegram',
          enabled: value.enabled !== false,
          secret: {
            botToken: value.botToken,
            proxyUrl: value.proxyUrl || getTelegramProviderConfig().proxyUrl,
          },
        })
      : null;
  }
  if (channel === 'qq') {
    const value = getUserQQConfig(userId);
    return value
      ? syncDefaultChannelAccountCredentials({
          ownerUserId: userId,
          provider: channel,
          name: '默认 QQ',
          enabled: value.enabled !== false,
          secret: { appId: value.appId, appSecret: value.appSecret },
        })
      : null;
  }
  if (channel === 'wechat') {
    const value = getUserWeChatConfig(userId);
    return value
      ? syncDefaultChannelAccountCredentials({
          ownerUserId: userId,
          provider: channel,
          name: '默认微信',
          enabled: value.enabled !== false,
          secret: {
            botToken: value.botToken,
            ilinkBotId: value.ilinkBotId,
            baseUrl: value.baseUrl,
            cdnBaseUrl: value.cdnBaseUrl,
            getUpdatesBuf: value.getUpdatesBuf,
            bypassProxy: String(value.bypassProxy ?? true),
          },
        })
      : null;
  }
  if (channel === 'dingtalk') {
    const value = getUserDingTalkConfig(userId);
    return value
      ? syncDefaultChannelAccountCredentials({
          ownerUserId: userId,
          provider: channel,
          name: '默认钉钉',
          enabled: value.enabled !== false,
          secret: {
            clientId: value.clientId,
            clientSecret: value.clientSecret,
            streamingMode: value.streamingMode,
          },
        })
      : null;
  }
  if (channel === 'discord') {
    const value = getUserDiscordConfig(userId);
    return value
      ? syncDefaultChannelAccountCredentials({
          ownerUserId: userId,
          provider: channel,
          name: '默认 Discord',
          enabled: value.enabled !== false,
          secret: {
            botToken: value.botToken,
            streamingMode: value.streamingMode,
          },
        })
      : null;
  }
  const value = getUserWhatsAppConfig(userId);
  return value
    ? syncDefaultChannelAccountCredentials({
        ownerUserId: userId,
        provider: channel,
        name: '默认 WhatsApp',
        enabled: value.enabled !== false,
        secret: {
          accountId: value.accountId,
          phoneNumber: value.phoneNumber,
        },
      })
    : null;
}

function movePathWithFallback(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    // Cross-device rename fallback.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * One-shot migration: move legacy top-level directories into data/.
 * - store/messages.db* → data/db/messages.db*
 * - groups/            → data/groups/
 * Also supports partial migrations (old+new paths both exist).
 */
function migrateDataDirectories(): void {
  const projectRoot = process.cwd();

  // 1. Migrate store/ → data/db/
  const oldStoreDir = path.join(projectRoot, 'store');
  if (fs.existsSync(oldStoreDir)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Move messages.db and WAL files
    for (const file of ['messages.db', 'messages.db-wal', 'messages.db-shm']) {
      const src = path.join(oldStoreDir, file);
      const dst = path.join(STORE_DIR, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        movePathWithFallback(src, dst);
        logger.info({ src, dst }, 'Migrated database file');
      }
    }
    // Remove old store/ if empty
    try {
      fs.rmdirSync(oldStoreDir);
    } catch {
      // Not empty — leave it
    }
  }

  // 2. Migrate groups/ → data/groups/
  const oldGroupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(oldGroupsDir)) {
    fs.mkdirSync(path.dirname(GROUPS_DIR), { recursive: true });
    if (!fs.existsSync(GROUPS_DIR)) {
      movePathWithFallback(oldGroupsDir, GROUPS_DIR);
      logger.info(
        { src: oldGroupsDir, dst: GROUPS_DIR },
        'Migrated groups directory',
      );
    } else {
      // Partial migration: move missing entries one-by-one.
      const entries = fs.readdirSync(oldGroupsDir, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(oldGroupsDir, entry.name);
        const dst = path.join(GROUPS_DIR, entry.name);
        if (!fs.existsSync(dst)) {
          movePathWithFallback(src, dst);
          logger.info({ src, dst }, 'Migrated legacy group entry');
        }
      }
      try {
        fs.rmdirSync(oldGroupsDir);
      } catch {
        // Not empty — leave it
      }
    }
  }
}

async function main(): Promise<void> {
  migrateDataDirectories();
  initDatabase();
  logger.info('Database initialized');

  const migratedAutoCompactProfiles = migrateAgentProfileAutoCompactWindow(
    getLegacySystemAutoCompactWindow(),
  );
  if (migratedAutoCompactProfiles > 0) {
    logger.info(
      { migrated: migratedAutoCompactProfiles },
      'Migrated system auto compact threshold to Agent profiles',
    );
  }

  // Clean up stale completed agents (task + spawn, older than 1 hour) to prevent DB bloat
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cleaned = deleteCompletedAgents(oneHourAgo);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale completed agents');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale task agents');
  }

  // After process restart there cannot be truly running SDK tasks.
  // Mark all persisted running tasks as error to avoid stale "running" tabs.
  try {
    const marked = markAllRunningTaskAgentsAsError();
    if (marked > 0) {
      logger.warn(
        { marked },
        'Marked stale running task agents as error at startup',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark stale running tasks at startup');
  }

  // Spawn agents (from /sw) lose their in-memory task callbacks on restart.
  // Mark idle/running spawn agents as error so they don't render as "正在思考...".
  try {
    const marked = markStaleSpawnAgentsAsError();
    if (marked > 0) {
      logger.warn({ marked }, 'Marked stale spawn agents as error at startup');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark stale spawn agents at startup');
  }

  // Migrate system-level IM config → admin's per-user config (one-time)
  migrateSystemIMToPerUser();

  loadState();

  // Plugin catalog scan: one shot 5s after startup + every 1h thereafter.
  // Disabled when SystemSettings.pluginAutoScan = false; admin can still
  // trigger via POST /api/plugins/catalog/scan. scanHostMarketplaces has
  // an in-flight Promise mutex, so UI button / startup / periodic timer
  // can overlap safely.
  // NOTE: this runs once at startup; runtime toggle requires restart.
  let startupPluginScanTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicPluginScanInterval: ReturnType<typeof setInterval> | null = null;
  let channelReliabilityRecoveryLoop: ReturnType<
    typeof startChannelReliabilityRecoveryLoop
  > | null = null;
  let unsubscribeChannelReadyRecovery: (() => void) | null = null;
  if (getSystemSettings().pluginAutoScan) {
    startupPluginScanTimer = setTimeout(() => {
      scanHostMarketplaces().catch((err) =>
        logger.warn({ err }, 'startup plugin catalog scan failed'),
      );
    }, 5000);

    periodicPluginScanInterval = setInterval(
      () => {
        scanHostMarketplaces().catch((err) =>
          logger.warn({ err }, 'periodic plugin catalog scan failed'),
        );
      },
      60 * 60 * 1000,
    );
  } else {
    logger.info(
      'Plugin catalog auto-scan disabled by SystemSettings.pluginAutoScan',
    );
  }

  // --- Channel reload helpers (hot-reload on config save) ---

  // Graceful shutdown handlers
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn('Force exit (second signal)');
      process.exit(1);
    }
    shutdownInProgress = true;
    shuttingDown = true;
    // Stop every account-scoped inbound callback immediately while retaining
    // the live clients for card finalization and other shutdown-time outbound
    // acknowledgements. disconnectAll runs only after those are settled.
    imManager.pauseInbound();
    logger.info({ signal }, 'Shutdown signal received, cleaning up...');

    // Force exit after 30s if graceful shutdown hangs.
    // Must be longer than queue.shutdown() grace period (15s) plus container
    // force-stop time (~10s) to avoid killing the process while agents are
    // still shutting down gracefully.
    const forceExitTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timed out, force exiting');
      process.exit(1);
    }, 30_000);
    forceExitTimer.unref();

    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    if (startupPluginScanTimer) clearTimeout(startupPluginScanTimer);
    if (periodicPluginScanInterval) clearInterval(periodicPluginScanInterval);
    channelReliabilityRecoveryLoop?.stop();
    channelReliabilityRecoveryLoop = null;
    unsubscribeChannelReadyRecovery?.();
    unsubscribeChannelReadyRecovery = null;

    // Phase 0: stop materializing new occurrences and drain scheduler-owned
    // detached work (script runs, notification retries) that the group queue
    // does not track. Delivery stays available throughout so those can settle.
    await stopSchedulerLoop().catch((err) =>
      logger.warn({ err }, 'Error stopping scheduler loop'),
    );

    try {
      shutdownTerminals();
    } catch (err) {
      logger.warn({ err }, 'Error shutting down terminals');
    }

    // Phase 1: stop external/web intake and drain or stop every Agent loop.
    // Keep IM transports connected through this phase: active runs may still
    // need the authenticated Feishu client to finalize their current card.
    await Promise.allSettled([
      shutdownWebServer().catch((err) =>
        logger.warn({ err }, 'Error shutting down web server'),
      ),
      queue
        .shutdown(15_000)
        .catch((err) => logger.warn({ err }, 'Error shutting down queue')),
    ]);

    // IPC watchers are the *outbound* consumer, so they must outlive the drain
    // above. Closing them first left messages an agent wrote during its grace
    // period unconsumed on disk until the next boot, by which point their run
    // had already been marked failed.
    try {
      ipcWatcherManager?.closeAll();
    } catch (err) {
      logger.warn({ err }, 'Error closing IPC watchers');
    }

    // Agent output is now quiescent. Persist any partial text that did not
    // reach a normal result before touching the external card lifecycle.
    stopStreamingBuffer();
    saveInterruptedStreamingMessages();

    // Phase 2: terminalize every remaining card while the Feishu clients are
    // still connected. Do not race this with disconnectAll: that race was the
    // source of orphan 「生成中」cards after otherwise graceful restarts.
    await abortAllStreamingSessions('服务维护中').catch((err) =>
      logger.warn({ err }, 'Error aborting streaming sessions'),
    );

    // Phase 3: only after card finalization has settled may transports release
    // their clients/tokens.
    await imManager
      .disconnectAll()
      .catch((err) =>
        logger.warn({ err }, 'Error disconnecting IM connections'),
      );

    clearTimeout(forceExitTimer);

    try {
      closeDatabase();
    } catch (err) {
      logger.warn({ err }, 'Error closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Reload Feishu connection for a specific user (hot-reload on config save)
  const reloadFeishuConnection = async (config: {
    appId: string;
    appSecret: string;
    enabled?: boolean;
  }): Promise<boolean> => {
    // Find admin user's home folder (legacy global config routes to admin)
    const adminUsers = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Feishu reload');
      return false;
    }

    const defaultAccount = syncDefaultChannelAccountCredentials({
      ownerUserId: adminUser.id,
      provider: 'feishu',
      name: '默认飞书',
      enabled: config.enabled !== false,
      secret: { appId: config.appId, appSecret: config.appSecret },
    });
    if (!defaultAccount.enabled) {
      await disconnectChannelAccountById(defaultAccount.id);
      return false;
    }
    const connected = await reloadChannelAccountById(defaultAccount.id);
    if (connected && !feishuSyncInterval) {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Group sync after Feishu reconnect failed'),
      );
      feishuSyncInterval = setInterval(() => {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Periodic group sync failed'),
        );
      }, GROUP_SYNC_INTERVAL_MS);
    }
    return connected;
  };

  const reloadTelegramConnection = async (config: {
    botToken: string;
    proxyUrl?: string;
    enabled?: boolean;
  }): Promise<boolean> => {
    // Find admin user
    const adminUsers = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Telegram reload');
      return false;
    }

    const defaultAccount = syncDefaultChannelAccountCredentials({
      ownerUserId: adminUser.id,
      provider: 'telegram',
      name: '默认 Telegram',
      enabled: config.enabled !== false,
      secret: { botToken: config.botToken, proxyUrl: config.proxyUrl },
    });
    if (!defaultAccount.enabled) {
      await disconnectChannelAccountById(defaultAccount.id);
      return false;
    }
    return reloadChannelAccountById(defaultAccount.id);
  };

  // Reload a per-user IM channel (hot-reload on user-im config save)
  const reloadUserIMConfig = async (
    userId: string,
    channel:
      | 'feishu'
      | 'telegram'
      | 'qq'
      | 'wechat'
      | 'dingtalk'
      | 'discord'
      | 'whatsapp',
  ): Promise<boolean> => {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup) {
      logger.warn(
        { userId, channel },
        'No home group found for user IM reload',
      );
      return false;
    }
    const homeFolder = homeGroup.folder;
    const ignoreMessagesBefore = Date.now();
    const onNewChat = buildOnNewChat(userId, homeFolder);

    // Old per-provider config routes are a compatibility facade over the
    // default first-class account. Never start a second legacy connector.
    const projectedAccount = syncLegacyConfigToDefaultChannelAccount(
      userId,
      channel,
    );
    if (projectedAccount) {
      if (!projectedAccount.enabled) {
        await disconnectChannelAccountById(projectedAccount.id);
        return false;
      }
      return reloadChannelAccountById(projectedAccount.id);
    }

    if (channel === 'feishu') {
      await imManager.disconnectUserFeishu(userId);
      const config = getUserFeishuConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.appId &&
        config.appSecret
      ) {
        const reloadOwnerRef = { value: config.ownerOpenId ?? undefined };
        const getReloadOwnerOpenId = () => reloadOwnerRef.value;
        const onReloadP2pSender = (senderOpenId: string) =>
          learnFeishuOwner(userId, senderOpenId, reloadOwnerRef);
        const onNewChat = buildOnNewChat(
          userId,
          homeFolder,
          getReloadOwnerOpenId,
        );
        const connected = await imManager.connectUserFeishu(
          userId,
          config,
          onNewChat,
          {
            ignoreMessagesBefore,
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildFeishuBotAddedHandler(
              userId,
              homeFolder,
              getReloadOwnerOpenId,
            ),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            resolveFeishuConversationPlan:
              resolveFeishuConversationPlanForMessage,
            isGroupOwnerMessage,
            isSenderAllowedInGroup,
            onFollowUpMessage: handleIncomingFollowUp,
            onFollowUpCardAction: handleFollowUpCardAction,
            onCardInterrupt: handleCardInterrupt,
            onP2pSender: onReloadP2pSender,
          },
        );
        logger.info(
          { userId, connected },
          'User Feishu connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Feishu channel disabled via hot-reload');
      return false;
    } else if (channel === 'telegram') {
      await imManager.disconnectUserTelegram(userId);
      const config = getUserTelegramConfig(userId);
      const globalTelegramConfig = getTelegramProviderConfig();
      if (config && config.enabled !== false && config.botToken) {
        const connected = await imManager.connectUserTelegram(
          userId,
          {
            ...config,
            proxyUrl: config.proxyUrl || globalTelegramConfig.proxyUrl,
          },
          onNewChat,
          buildIsChatAuthorized(userId),
          buildOnPairAttempt(userId),
          {
            onCommand: handleCommand,
            ignoreMessagesBefore,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onNativeContextDetected: buildOnNativeContextDetected(),
            onBotAddedToGroup: buildTelegramBotAddedHandler(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
          },
        );
        logger.info(
          { userId, connected },
          'User Telegram connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Telegram channel disabled via hot-reload');
      return false;
    } else if (channel === 'qq') {
      await imManager.disconnectUserQQ(userId);
      const config = getUserQQConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.appId &&
        config.appSecret
      ) {
        const connected = await imManager.connectUserQQ(
          userId,
          config,
          onNewChat,
          buildIsChatAuthorized(userId),
          buildOnPairAttempt(userId),
          {
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
          },
        );
        logger.info({ userId, connected }, 'User QQ connection hot-reloaded');
        return connected;
      }
      logger.info({ userId }, 'User QQ channel disabled via hot-reload');
      return false;
    } else if (channel === 'dingtalk') {
      await imManager.disconnectUserDingTalk(userId);
      const config = getUserDingTalkConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.clientId &&
        config.clientSecret
      ) {
        const connected = await imManager.connectUserDingTalk(
          userId,
          config,
          onNewChat,
          {
            isChatAuthorized: buildIsChatAuthorized(userId),
            onPairAttempt: buildOnPairAttempt(userId),
            ignoreMessagesBefore,
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildOnNewChat(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            isGroupOwnerMessage,
            resolveRegisteredGroup: getRegisteredGroup,
          },
        );
        logger.info(
          { userId, connected },
          'User DingTalk connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User DingTalk channel disabled via hot-reload');
      return false;
    } else if (channel === 'discord') {
      await imManager.disconnectUserDiscord(userId);
      const config = getUserDiscordConfig(userId);
      if (config && config.enabled !== false && config.botToken) {
        const connected = await imManager.connectUserDiscord(
          userId,
          config,
          onNewChat,
          {
            isChatAuthorized: buildIsChatAuthorized(userId),
            onPairAttempt: buildOnPairAttempt(userId),
            ignoreMessagesBefore,
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildOnNewChat(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            isGroupOwnerMessage,
          },
        );
        logger.info(
          { userId, connected },
          'User Discord connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Discord channel disabled via hot-reload');
      return false;
    } else if (channel === 'wechat') {
      await imManager.disconnectUserWeChat(userId);
      const config = getUserWeChatConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.botToken &&
        config.ilinkBotId
      ) {
        const connected = await imManager.connectUserWeChat(
          userId,
          {
            botToken: config.botToken,
            ilinkBotId: config.ilinkBotId,
            baseUrl: config.baseUrl,
            cdnBaseUrl: config.cdnBaseUrl,
            getUpdatesBuf: config.getUpdatesBuf,
            bypassProxy: config.bypassProxy,
          },
          onNewChat,
          {
            isChatAuthorized: buildIsChatAuthorized(userId),
            onPairAttempt: buildOnPairAttempt(userId),
            // With a durable cursor, replay is intentional recovery and must
            // not be filtered by a new-process timestamp.
            ignoreMessagesBefore: config.getUpdatesBuf ? undefined : Date.now(),
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onUpdatesBuf: (cursor: string) => {
              if (!cursor) return;
              const latest = getUserWeChatConfig(userId);
              if (!latest || latest.getUpdatesBuf === cursor) return;
              saveUserWeChatConfig(userId, {
                ...latest,
                getUpdatesBuf: cursor,
              });
            },
          },
        );
        logger.info(
          { userId, connected },
          'User WeChat connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User WeChat channel disabled via hot-reload');
      return false;
    } else {
      // WhatsApp (Baileys)
      await imManager.disconnectUserWhatsApp(userId);
      const config = getUserWhatsAppConfig(userId);
      if (config && config.enabled !== false) {
        const connected = await imManager.connectUserWhatsApp(
          userId,
          {
            accountId: config.accountId,
            phoneNumber: config.phoneNumber,
            enabled: config.enabled,
          },
          onNewChat,
          {
            isChatAuthorized: buildIsChatAuthorized(userId),
            onPairAttempt: buildOnPairAttempt(userId),
            ignoreMessagesBefore: Date.now(),
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildOnNewChat(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            isGroupOwnerMessage,
            onConnectionUpdate: (uid, accountId, state) => {
              broadcastWhatsAppStatus(uid, accountId, state);
            },
          },
        );
        logger.info(
          { userId, connected },
          'User WhatsApp connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User WhatsApp channel disabled via hot-reload');
      return false;
    }
  };

  // Reconnect all of a user's IM channels from persisted config — symmetric
  // counterpart to disconnectAllUserChannels (called on admin re-enable/
  // restore). Reuses reloadUserIMConfig per channel: it reads each channel's
  // saved config and only connects the enabled ones, so disabled channels stay
  // down without extra branching here.
  const reconnectUserIMChannels = async (userId: string): Promise<void> => {
    // 解封：disconnectAllUserChannels 把 user 标 sealed 后，所有 connectChannel
    // 都被拒。re-enable / restore 用户时必须先解封否则 reload 全部失败。
    imManager.markUserReconnectable(userId);
    const channels: Array<
      | 'feishu'
      | 'telegram'
      | 'qq'
      | 'wechat'
      | 'dingtalk'
      | 'discord'
      | 'whatsapp'
    > = [
      'feishu',
      'telegram',
      'qq',
      'wechat',
      'dingtalk',
      'discord',
      'whatsapp',
    ];
    await Promise.allSettled(
      channels.map((channel) => reloadUserIMConfig(userId, channel)),
    );
    // reloadUserIMConfig projects and reconnects only the legacy-compatible
    // default for each provider. A user may own additional first-class Bot
    // accounts; reconnect those as well after the projection is complete.
    const additionalAccounts = listChannelAccountsForUser(userId).filter(
      (account) => account.enabled && !account.is_legacy_default,
    );
    const accountResults = await Promise.allSettled(
      additionalAccounts.map((account) => reloadChannelAccountById(account.id)),
    );
    const failedAccountIds = accountResults.flatMap((result, index) =>
      result.status === 'rejected' || result.value === false
        ? [additionalAccounts[index].id]
        : [],
    );
    if (failedAccountIds.length > 0) {
      logger.warn(
        { userId, failedAccountIds },
        'Some first-class IM channel accounts failed to reconnect after user re-enable',
      );
    }
    logger.info(
      { userId, additionalAccounts: additionalAccounts.length },
      'Reconnected user IM channels after re-enable',
    );
  };

  // Start Web server early so frontend auth/API isn't blocked by Feishu readiness.
  startWebServer({
    queue,
    getRegisteredGroups: () => registeredGroups,
    sessions,
    getSessions: () => sessions,
    processGroupMessages,
    ensureTerminalContainerStarted,
    formatMessages,
    getLastAgentTimestamp: () => lastAgentTimestamp,
    setLastAgentTimestamp: setCursors,
    advanceCursors,
    advanceNextPullCursorOnly,
    completeOutOfBandMessage,
    advanceGlobalCursor: (cursor: MessageCursor) => {
      if (isCursorAfter(cursor, globalMessageCursor)) {
        globalMessageCursor = cursor;
        saveState();
      }
    },
    hasEarlierPendingMessages: hasEarlierPendingMessage,
    reloadFeishuConnection,
    reloadTelegramConnection,
    reloadUserIMConfig,
    reconnectUserIMChannels,
    reloadChannelAccount: reloadChannelAccountById,
    disconnectChannelAccount: disconnectChannelAccountById,
    testChannelAccount: testChannelAccountCredentials,
    isChannelAccountConnected: (accountId: string) => {
      const account = getChannelAccount(accountId);
      return account
        ? imManager.isChannelAccountConnected(
            account.owner_user_id,
            account.provider,
            account.id,
          )
        : false;
    },
    isFeishuConnected: () => imManager.isAnyFeishuConnected(),
    isTelegramConnected: () => imManager.isAnyTelegramConnected(),
    isUserFeishuConnected: (userId: string) =>
      imManager.isFeishuConnected(userId),
    isUserTelegramConnected: (userId: string) =>
      imManager.isTelegramConnected(userId),
    isUserQQConnected: (userId: string) => imManager.isQQConnected(userId),
    isUserWeChatConnected: (userId: string) =>
      imManager.isWeChatConnected(userId),
    isUserDingTalkConnected: (userId: string) =>
      imManager.isDingTalkConnected(userId),
    isUserDiscordConnected: (userId: string) =>
      imManager.isDiscordConnected(userId),
    isUserWhatsAppConnected: (userId: string) =>
      imManager.isWhatsAppConnected(userId),
    getUserWhatsAppState: (userId: string, accountId?: string) =>
      imManager.getUserWhatsAppState(userId, accountId),
    logoutUserWhatsApp: (userId: string, accountId?: string) =>
      imManager.logoutUserWhatsApp(userId, accountId),
    processAgentConversation,
    getFeishuChatInfo: (userId: string, chatId: string) =>
      imManager.getFeishuChatInfo(userId, chatId),
    getChannelChatInfo: (jid: string) => imManager.getChatInfo(jid),
    syncUserImGroups: async (userId: string) => ({
      feishuAccounts: await imManager.syncAllFeishuGroups(userId),
    }),
    clearImFailCounts: (jid: string) => {
      imHealthCheckFailCounts.delete(jid);
    },
    removeImGroupRecord,
    preAdmitReplyRoute: (
      folder: string,
      sourceJid: string | null,
      receipt: IpcDeliveryReceipt | undefined,
      runtimeAgentId?: string,
    ) => invokeActiveRouteAdmission(folder, sourceJid, receipt, runtimeAgentId),
    updateReplyRoute: (
      folder: string,
      sourceJid: string | null,
      inputTurnId?: string,
      inputCursor?: MessageCursor,
      inputChatJid?: string,
      inputTaskId?: string,
      runtimeAgentId?: string,
    ) => {
      if (inputCursor && inputChatJid) {
        activeAgentBuilderTurns.enqueueBatch(
          agentBuilderTurnScope(folder, runtimeAgentId),
          [
            {
              chatJid: inputChatJid,
              messageId: inputCursor.id,
              runtimeTurnId: inputTurnId ?? inputCursor.id,
              scheduledTaskId: inputTaskId ?? null,
            },
          ],
        );
        if (inputTurnId) {
          grantWorkspaceMemoryTurnToCurrentRunner(
            {
              groupFolder: folder,
              agentId: runtimeAgentId ?? null,
              taskRunId: null,
            },
            inputTurnId,
          );
        }
      }
      if (inputTurnId) {
        const scope = channelTurnScope(folder, runtimeAgentId);
        const persistedContext =
          sourceJid && inputCursor && inputChatJid
            ? getMessageChannelTurnContext(inputChatJid, inputCursor.id)
            : null;
        const context =
          persistedContext && persistedContext.sourceJid === sourceJid
            ? {
                ...persistedContext,
                targetJid: inputChatJid,
                workspaceJid: inputChatJid,
                sessionAgentId: runtimeAgentId ?? null,
              }
            : undefined;
        bindActiveChannelTurn(scope, inputTurnId, context);
      }
      if (runtimeAgentId) {
        const agentRuntimeKey = inputChatJid?.includes('#agent:')
          ? inputChatJid
          : `web:${folder}#agent:${runtimeAgentId}`;
        activeHeldCardFinalizers.get(agentRuntimeKey)?.(sourceJid, inputTurnId);
        return;
      }
      invokeActiveRouteUpdater(folder, sourceJid, inputTurnId, inputCursor);
    },
    finalizeHeldCard: (key: string) => {
      activeHeldCardFinalizers.get(key)?.();
    },
    handleSpawnCommand,
    applyAutoIsolateContext: (userId: string, enable: boolean) =>
      applyAutoIsolateContext(userId, enable),
    resolveEffectiveGroup,
    promoteFollowUp,
    cancelFollowUp,
    editFollowUp,
    reorderFollowUp,
    interruptAndRunFollowUp,
  });

  // Clean expired sessions every hour
  setInterval(
    () => {
      try {
        const expiredIds = getExpiredSessionIds();
        for (const id of expiredIds) invalidateSessionCache(id);
        const deleted = deleteExpiredSessions();
        if (deleted > 0) {
          logger.info({ deleted }, 'Cleaned expired user sessions');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to clean expired sessions');
      }
    },
    60 * 60 * 1000,
  );

  // Periodically clean completed agents (task + spawn, every 10 minutes)
  setInterval(
    () => {
      try {
        const tenMinutesAgo = new Date(
          Date.now() - 10 * 60 * 1000,
        ).toISOString();
        const archived = archiveInactiveConversationAgents(
          new Date(
            Date.now() - CONVERSATION_AGENT_ARCHIVE_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString(),
        );
        const cleaned = deleteCompletedAgents(tenMinutesAgo);
        const prunedCursors = pruneCursorState();
        if (cleaned > 0 || archived > 0 || prunedCursors > 0) {
          logger.info(
            { cleaned, archived, prunedCursors },
            'Periodic cleanup: removed completed agents',
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Failed periodic task agent cleanup');
      }
    },
    10 * 60 * 1000,
  );

  // Billing: check expired subscriptions every hour
  setInterval(
    () => {
      checkAndExpireSubscriptions();
    },
    60 * 60 * 1000,
  );

  // Billing: reconcile monthly usage every 6 hours
  setInterval(
    () => {
      if (!isBillingEnabled()) return;
      try {
        const month = new Date().toISOString().slice(0, 7);
        // Reconcile all non-admin users with pagination
        let page = 1;
        const pageSize = 200;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = listUsers({ status: 'active', pageSize, page });
          for (const u of batch.users) {
            if (u.role === 'admin') continue;
            reconcileMonthlyUsage(u.id, month);
          }
          if (batch.users.length < pageSize) break;
          page++;
        }
      } catch (err) {
        logger.error({ err }, 'Failed to run monthly usage reconciliation');
      }
    },
    6 * 60 * 60 * 1000,
  );

  // Billing: cleanup old daily_usage and billing_audit_log every 24 hours
  setInterval(
    () => {
      try {
        const deletedDaily = cleanupOldDailyUsage();
        const deletedAudit = cleanupOldBillingAuditLog();
        if (deletedDaily > 0 || deletedAudit > 0) {
          logger.info(
            { deletedDaily, deletedAudit },
            'Cleaned up old billing data',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cleanup old billing data');
      }
    },
    24 * 60 * 60 * 1000,
  );

  // Channel reliability retention. Every Feishu message writes 8-12 rows
  // (inbox/turn/outbox/card) that carry full payload and snapshot JSON; the
  // store ships a two-stage cleanup (dehydrate payloads, then delete terminal
  // rows) that was never wired to a timer. Payloads clear after 7 days,
  // terminal rows after 30 (matching task_runs retention; both exceed every
  // provider replay window). The first pass runs shortly after startup so
  // frequently-restarted deployments are not exempt from retention.
  const runChannelReliabilityCleanup = (): void => {
    try {
      const result = cleanupChannelReliability({
        payloadsBefore: new Date(
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        recordsBefore: new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
      const total = Object.values(result).reduce((sum, n) => sum + n, 0);
      if (total > 0) {
        logger.info(result, 'Channel reliability retention pass completed');
      }
    } catch (err) {
      logger.error({ err }, 'Failed channel reliability retention pass');
    }
  };
  setTimeout(runChannelReliabilityCleanup, 5 * 60 * 1000);
  setInterval(runChannelReliabilityCleanup, 24 * 60 * 60 * 1000);

  await ensureDockerRunning();

  queue.setProcessMessagesFn(processGroupMessages);
  queue.setOnQueryIdle((chatJid) => {
    dispatchQueuedFollowUpFamily(chatJid);
  });
  queue.setHostModeChecker((groupJid: string) => {
    const baseJid = stripVirtualJidSuffix(groupJid);

    let group = registeredGroups[baseJid];
    if (!group) {
      const dbGroup = getRegisteredGroup(baseJid);
      if (dbGroup) {
        registeredGroups[baseJid] = dbGroup;
        group = dbGroup;
      }
    }
    if (!group) return false;

    const { effectiveGroup } = resolveEffectiveGroup(group);
    return effectiveGroup.executionMode === 'host';
  });
  queue.setSerializationKeyResolver((groupJid: string) => {
    // Agent virtual JIDs: {chatJid}#agent:{agentId} → separate serialization key
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) {
      const baseJid = groupJid.slice(0, agentSep);
      const agentId = groupJid.slice(agentSep + 7);
      const group = registeredGroups[baseJid];
      const folder = group?.folder || baseJid;
      return `${folder}#${agentId}`;
    }
    // Task virtual JIDs: {chatJid}#task:{taskId} → separate serialization key
    const taskSep = groupJid.indexOf('#task:');
    if (taskSep >= 0) {
      const baseJid = groupJid.slice(0, taskSep);
      const taskId = groupJid.slice(taskSep + 6);
      const group = registeredGroups[baseJid];
      return `${group?.folder || baseJid}#task:${taskId}`;
    }
    const group = registeredGroups[groupJid];
    return group?.folder || groupJid;
  });
  queue.setOnMaxRetriesExceeded(
    async (groupJid: string, snapshot: MessageRetrySnapshot | null) => {
      try {
        const group =
          registeredGroups[groupJid] ?? getRegisteredGroup(groupJid);
        const name = group?.name || groupJid;
        const error = `${name} 处理失败，已达最大重试次数`;
        if (group && snapshot?.coveredCursors.length) {
          // Use only the immutable batch read by the final failed attempt.
          // A prompt arriving while this callback runs belongs to a future
          // attempt and must not be marked failed or consumed here.
          const exactMessages: Array<
            NonNullable<ReturnType<typeof getAgentBuilderInputMessage>>
          > = [];
          for (const cursor of snapshot.coveredCursors) {
            const message = getAgentBuilderInputMessage(groupJid, cursor.id);
            if (message) exactMessages.push(message);
          }
          const runs = resolveScheduledGroupRunsForOutput({
            chatJid: groupJid,
            fallbackInputTurnId: snapshot.cursor.id,
            coldMessages: exactMessages,
            output: { inputTurnId: snapshot.cursor.id },
            getMessage: (targetJid, messageId) =>
              getAgentBuilderInputMessage(targetJid, messageId),
            getRun: getTaskRunById,
          });
          const durable = await projectTerminalScheduledGroupRuns({
            runs,
            chatJid: groupJid,
            workspaceFolder: resolveEffectiveGroup(group).effectiveGroup.folder,
            status: 'failed',
            error,
          });
          if (durable) {
            // Retry exhaustion terminates this immutable final-attempt batch,
            // including any ordinary inputs coalesced before its upper bound.
            // Commit the whole bounded snapshot so crash recovery cannot
            // replay the old scheduler prompt; later messages sort after this
            // cursor and remain pending.
            advanceCursors(groupJid, snapshot.cursor);
          }
        }
        sendSystemMessage(groupJid, 'agent_max_retries', error);
      } finally {
        await clearTrackedProcessingIndicators(groupJid);
      }
    },
  );
  // Billing: user-level concurrent container limit
  queue.setUserConcurrentLimitChecker((groupJid: string) => {
    if (!isBillingEnabled()) return { allowed: true };
    const baseJid = stripVirtualJidSuffix(groupJid);
    const group = registeredGroups[baseJid];
    if (!group?.created_by) return { allowed: true };
    const owner = getUserById(group.created_by);
    if (!owner || owner.role === 'admin') return { allowed: true };
    const limit = getUserConcurrentContainerLimit(owner.id, owner.role);
    if (limit == null) return { allowed: true };
    // Count active containers for this user (including task virtual JIDs)
    let userActive = 0;
    for (const [jid, g] of Object.entries(registeredGroups)) {
      if (g.created_by !== owner.id) continue;
      if (queue.hasDirectActiveRunner(jid)) userActive++;
      userActive += queue.countActiveTaskRunners(jid);
    }
    return { allowed: userActive < limit };
  });
  // Recovery: when agent process exits with unconsumed IPC messages,
  // re-enqueue processAgentConversation to pick them up. See issue #240.
  queue.setOnUnconsumedAgentIpc((groupJid: string, agentId: string) => {
    // Extract base chat JID from virtual JID (e.g. web:main#agent:abc → web:main)
    const baseChatJid = groupJid.includes('#agent:')
      ? groupJid.split('#agent:')[0]
      : groupJid;
    const agent = getAgent(agentId);
    const homeChatJid = agent?.chat_jid || baseChatJid;
    const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
    const taskId = `agent-ipc-recovery:${agentId}:${Date.now()}`;
    queue.enqueueTask(virtualChatJid, taskId, async () => {
      return processAgentConversation(homeChatJid, agentId);
    });
  });
  queue.setOnUnacknowledgedIpcDeliveries(
    (runnerJid: string, receipts: IpcDeliveryReceipt[]) => {
      const chatJids = new Set(receipts.map((receipt) => receipt.chatJid));
      clearPersistedIpcDeliveriesForChats(chatJids);
      for (const deliveryJid of chatJids) {
        rewindNextPullCursorToCommitted(deliveryJid);
        const agentSep = deliveryJid.indexOf('#agent:');
        if (agentSep < 0) {
          recoveryGroups.add(deliveryJid);
          queue.enqueueMessageCheck(deliveryJid);
          continue;
        }
        const baseChatJid = deliveryJid.slice(0, agentSep);
        const agentId = deliveryJid.slice(agentSep + '#agent:'.length);
        const agent = getAgent(agentId);
        const homeChatJid = agent?.chat_jid || baseChatJid;
        const virtualChatJid = `${homeChatJid}#agent:${agentId}`;
        queue.enqueueTask(
          virtualChatJid,
          `agent-delivery-recovery:${agentId}`,
          async () => {
            return processAgentConversation(homeChatJid, agentId);
          },
        );
      }
      logger.warn(
        { runnerJid, deliveryCount: receipts.length, chatJids: [...chatJids] },
        'Rewound unacknowledged IPC deliveries for DB replay',
      );
    },
  );
  queue.setIpcDeliveryCommitEligibilityChecker(
    (receipt: IpcDeliveryReceipt) => !hasUncoveredPendingMessage(receipt),
  );
  queue.setOnAbandonedIpcDeliveries(
    (runnerJid: string, receipts: IpcDeliveryReceipt[]) => {
      // Explicit Stop/delete is a user-requested terminal action. Advance the
      // durable cursors for every accepted delivery so exit recovery cannot
      // resurrect cancelled work.
      commitIpcDeliveryReceipts(receipts);
      logger.info(
        { runnerJid, deliveryCount: receipts.length },
        'Abandoned IPC deliveries after explicit runner stop',
      );
    },
  );
  // A restart has no live query that can emit an idle transition. Release one
  // durable item per chat into the normal cold-start path; the remaining items
  // stay queued and are promoted one-by-one after each completed query.
  recoverDurableFollowUps();
  const schedulerDeps: import('./task-scheduler.js').SchedulerDependencies = {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (
      groupJid,
      proc,
      containerName,
      groupFolder,
      displayName,
      taskRunId,
      selectedProviderId,
    ) =>
      queue.registerProcess(groupJid, proc, {
        containerName,
        groupFolder,
        displayName,
        taskRunId,
        selectedProviderId,
      }),
    sendMessage: async (jid, text, options) => {
      const outcome = await sendMessageWithOutcome(jid, text, options);
      if (!outcome.targetDelivered) {
        throw new Error(`Scheduled-task target did not acknowledge: ${jid}`);
      }
      return outcome.messageId;
    },
    broadcastStreamEvent,
    onWorkspaceCreated: broadcastGroupCreated,
    storePromptMessage: (
      chatJid,
      senderId,
      senderName,
      text,
      taskId,
      taskRunId,
    ) => {
      const msgId = taskRunId
        ? scheduledGroupPromptMessageId(taskRunId)
        : crypto.randomUUID();
      const now = new Date().toISOString();
      ensureChatExists(chatJid);
      storeMessageDirect(
        msgId,
        chatJid,
        senderId,
        senderName,
        text,
        now,
        false,
        {
          meta: { sourceKind: 'scheduled_task_prompt', taskId },
        },
      );
      broadcastNewMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: text,
        timestamp: now,
        is_from_me: false,
      });
      return msgId;
    },
    storeGroupPromptAndDeliverRun: (input) => {
      const msgId = storeScheduledGroupPromptAndCompleteRun({
        runId: input.run.id,
        taskId: input.taskId,
        leaseOwner: input.run.lease_owner,
        leaseToken: input.run.lease_token,
        messageId: input.messageId,
        chatJid: input.chatJid,
        senderId: input.senderId,
        senderName: input.senderName,
        text: input.text,
        queuedResult: input.queuedResult,
      });
      const now = new Date().toISOString();
      broadcastNewMessage(input.chatJid, {
        id: msgId,
        chat_jid: input.chatJid,
        sender: input.senderId,
        sender_name: input.senderName,
        content: input.text,
        timestamp: now,
        is_from_me: false,
      });
      return msgId;
    },
    storeResultAndNotify: async (chatJid, text, options) => {
      if (!options.skipStore) {
        const outcome = await sendMessageWithOutcome(chatJid, text, {
          messageId: options.messageId,
          sendToIM: false,
          source: 'scheduled_task',
          messageMeta: {
            sourceKind: options.sourceKind || 'sdk_final',
          },
        });
        if (!outcome.webProjected || !outcome.messageId) {
          throw new Error(
            `Scheduled-task workspace result was not persisted and broadcast: ${chatJid}`,
          );
        }
      }

      if (!options.ownerId) return;
      const ownerHome = getUserHomeGroup(options.ownerId);
      const broadcastFolder = options.workspaceFolder ?? ownerHome?.folder;
      if (!broadcastFolder) {
        return {
          status: 'skipped',
          summary: {
            attempted: 0,
            succeeded: 0,
            failed: 0,
            failed_channels: [],
          },
        };
      }

      const localImages = extractLocalImImagePaths(text, broadcastFolder);
      // Only a strict connector ACK may suppress the source channel fallback.
      // Merely having an IM-shaped chatJid is insufficient: the generic Web
      // persistence path can succeed after the physical connector failed.
      const alreadySent = new Set<string>();
      if (options.sourceAlreadyDelivered && getChannelType(chatJid)) {
        alreadySent.add(chatJid);
      }
      const deliveries: Array<{ channel: string; result: Promise<boolean> }> =
        [];
      // A task records the exact place it was scheduled from. Deliver there
      // first: the previous behaviour resolved the target by scanning the
      // owner's groups and taking the first folder match, with no ORDER BY, so
      // a failure notice for a task bound to one chat could surface in another.
      const boundRoute = options.deliveryRouteJid;
      if (
        boundRoute &&
        getChannelType(boundRoute) &&
        !alreadySent.has(boundRoute)
      ) {
        alreadySent.add(boundRoute);
        deliveries.push({
          channel: getChannelType(boundRoute) ?? boundRoute,
          result: sendImWithRetry(boundRoute, text, localImages),
        });
      }
      // Fan-out is opt-in. Without an explicit `notify_channels` the notice
      // goes only to the binding; it used to reach every channel type the owner
      // had connected in that workspace, so a task created in Feishu also
      // notified Telegram.
      if (options.notifyChannels && options.notifyChannels.length > 0) {
        broadcastToOwnerIMChannels(
          options.ownerId,
          broadcastFolder,
          alreadySent,
          (jid) => {
            deliveries.push({
              // Notification retries filter on channel type, not the concrete
              // binding jid. Keep the concrete jid only as a defensive fallback.
              channel: getChannelType(jid) ?? jid,
              result: sendImWithRetry(jid, text, localImages),
            });
          },
          options.notifyChannels,
        );
      }
      if (deliveries.length === 0) {
        return {
          status: 'skipped',
          summary: {
            attempted: 0,
            succeeded: 0,
            failed: 0,
            failed_channels: [],
          },
        };
      }

      const outcomes = await Promise.all(
        deliveries.map(async (delivery) => ({
          channel: delivery.channel,
          success: await delivery.result,
        })),
      );
      const failedChannels = outcomes
        .filter((outcome) => !outcome.success)
        .map((outcome) => outcome.channel);
      const succeeded = outcomes.length - failedChannels.length;
      return {
        status:
          failedChannels.length === 0
            ? 'success'
            : succeeded > 0
              ? 'partial_failed'
              : 'failed',
        summary: {
          attempted: outcomes.length,
          succeeded,
          failed: failedChannels.length,
          failed_channels: failedChannels,
        },
        error:
          failedChannels.length > 0
            ? `通知发送失败：${failedChannels.join(', ')}`
            : null,
      };
    },
    retryTaskNotification: async (payload) => {
      const targetJid =
        'targetJid' in payload ? payload.targetJid : payload.chatJid;
      const channel = getChannelType(targetJid) ?? targetJid;
      let success = false;
      let error: string | null = null;
      try {
        if (payload.kind === 'im_message') {
          success = await sendImWithRetry(
            payload.targetJid,
            payload.text,
            payload.localImagePaths,
          );
        } else if (payload.kind === 'im_image' || payload.kind === 'im_file') {
          const workspaceRoot = path.resolve(
            GROUPS_DIR,
            payload.workspaceFolder,
          );
          const resolvedPath = path.resolve(workspaceRoot, payload.filePath);
          if (
            resolvedPath !== workspaceRoot &&
            !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)
          ) {
            throw new Error('Persisted notification path left its workspace');
          }
          if (!isRealpathInside(resolvedPath, workspaceRoot)) {
            throw new Error('Persisted notification file is unavailable');
          }
          if (payload.kind === 'im_image') {
            success = await sendTaskImageWithRetry(
              payload.targetJid,
              fs.readFileSync(resolvedPath),
              payload.mimeType,
              payload.caption,
              payload.fileName,
            );
          } else {
            success = await sendTaskFileWithRetry(
              payload.targetJid,
              resolvedPath,
              payload.fileName,
            );
          }
        } else {
          throw new Error(
            `Unsupported direct notification kind: ${payload.kind}`,
          );
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (!success && !error)
        error = `Notification delivery failed: ${channel}`;
      return {
        status: success ? 'success' : 'failed',
        summary: {
          attempted: 1,
          succeeded: success ? 1 : 0,
          failed: success ? 0 : 1,
          failed_channels: success ? [] : [channel],
        },
        error,
      };
    },
    assistantName: ASSISTANT_NAME,
  };
  startSchedulerLoop(schedulerDeps);

  // Inject triggerTaskRun into WebDeps (schedulerDeps must exist first)
  const webDeps = getWebDeps();
  if (webDeps) {
    webDeps.triggerTaskRun = (taskId: string, idempotencyKey?: string) =>
      triggerTaskNow(taskId, schedulerDeps, idempotencyKey);
    webDeps.cancelTaskRun = (runId: string) => cancelTaskRunNow(runId);
    webDeps.waitForTaskRunsToStop = (runIds: string[], timeoutMs?: number) =>
      waitForTaskRunsToStop(runIds, timeoutMs);
  }

  // --- IM Connection Pool: connect per-user IM channels ---
  // Load global IM config (backward compat: used for admin if no per-user config exists)
  const globalFeishuConfig = getFeishuProviderConfigWithSource();
  const globalTelegramConfig = getTelegramProviderConfigWithSource();

  // Paginate through all active users (listUsers caps at 200 per page)
  let allActiveUsers: typeof listUsers extends (...args: any) => {
    users: infer U;
  }
    ? U
    : never = [];
  {
    let page = 1;
    while (true) {
      const result = listUsers({ status: 'active', page, pageSize: 200 });
      allActiveUsers = allActiveUsers.concat(result.users);
      if (allActiveUsers.length >= result.total) break;
      page++;
    }
  }

  // Register admin users for fallback IM routing
  for (const user of allActiveUsers) {
    if (user.role === 'admin') imManager.registerAdminUser(user.id);
  }

  let anyFeishuConnected = false;

  // Project each user's legacy singleton configs concurrently. Connections are
  // opened exactly once by the first-class account pass below.
  await Promise.allSettled(
    allActiveUsers.map(async (user) => {
      const homeGroup = getUserHomeGroup(user.id);
      if (!homeGroup) return;

      // Per-user IM config takes precedence; fall back to global config for admin
      const userFeishu = getUserFeishuConfig(user.id);
      const userTelegram = getUserTelegramConfig(user.id);
      const userQQ = getUserQQConfig(user.id);
      const userWeChat = getUserWeChatConfig(user.id);
      const userDingTalk = getUserDingTalkConfig(user.id);
      const userDiscord = getUserDiscordConfig(user.id);
      const userWhatsApp = getUserWhatsAppConfig(user.id);

      // Determine effective Feishu config: per-user > global (admin only)
      let effectiveFeishu: FeishuConnectConfig | null = null;
      if (userFeishu && userFeishu.appId && userFeishu.appSecret) {
        effectiveFeishu = {
          appId: userFeishu.appId,
          appSecret: userFeishu.appSecret,
          enabled: userFeishu.enabled,
        };
      } else if (
        user.role === 'admin' &&
        globalFeishuConfig.source !== 'none'
      ) {
        const gc = globalFeishuConfig.config;
        effectiveFeishu = {
          appId: gc.appId,
          appSecret: gc.appSecret,
          enabled: gc.enabled,
        };
      }

      // Determine effective Telegram config: per-user > global (admin only)
      let effectiveTelegram: TelegramConnectConfig | null = null;
      if (userTelegram && userTelegram.botToken) {
        effectiveTelegram = {
          botToken: userTelegram.botToken,
          proxyUrl:
            userTelegram.proxyUrl || globalTelegramConfig.config.proxyUrl,
          enabled: userTelegram.enabled,
        };
      } else if (
        user.role === 'admin' &&
        globalTelegramConfig.source !== 'none'
      ) {
        const gc = globalTelegramConfig.config;
        effectiveTelegram = {
          botToken: gc.botToken,
          proxyUrl: gc.proxyUrl,
          enabled: gc.enabled,
        };
      }

      // Determine effective QQ config: per-user only (no global fallback)
      let effectiveQQ: QQConnectConfig | null = null;
      if (userQQ && userQQ.appId && userQQ.appSecret) {
        effectiveQQ = {
          appId: userQQ.appId,
          appSecret: userQQ.appSecret,
          enabled: userQQ.enabled,
        };
      }

      // Determine effective WeChat config: per-user only (no global fallback)
      let effectiveWeChat: WeChatConnectConfig | null = null;
      if (userWeChat && userWeChat.botToken && userWeChat.ilinkBotId) {
        effectiveWeChat = {
          botToken: userWeChat.botToken,
          ilinkBotId: userWeChat.ilinkBotId,
          baseUrl: userWeChat.baseUrl,
          cdnBaseUrl: userWeChat.cdnBaseUrl,
          getUpdatesBuf: userWeChat.getUpdatesBuf,
          bypassProxy: userWeChat.bypassProxy,
          enabled: userWeChat.enabled,
        };
      }

      // Determine effective DingTalk config: per-user only (no global fallback)
      let effectiveDingTalk: DingTalkConnectConfig | null = null;
      if (userDingTalk && userDingTalk.clientId && userDingTalk.clientSecret) {
        effectiveDingTalk = {
          clientId: userDingTalk.clientId,
          clientSecret: userDingTalk.clientSecret,
          enabled: userDingTalk.enabled,
        };
      }

      // Determine effective Discord config: per-user only (no global fallback)
      let effectiveDiscord: DiscordConnectConfig | null = null;
      if (userDiscord && userDiscord.botToken) {
        effectiveDiscord = {
          botToken: userDiscord.botToken,
          enabled: userDiscord.enabled,
          streamingMode: userDiscord.streamingMode,
        };
      }

      // Determine effective WhatsApp config: per-user only, skeleton always disabled by default
      let effectiveWhatsApp: WhatsAppConnectConfig | null = null;
      if (userWhatsApp && userWhatsApp.enabled) {
        effectiveWhatsApp = {
          accountId: userWhatsApp.accountId,
          phoneNumber: userWhatsApp.phoneNumber,
          enabled: userWhatsApp.enabled,
        };
      }

      try {
        if (effectiveFeishu) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'feishu',
            name: '默认飞书',
            enabled: effectiveFeishu.enabled !== false,
            secret: {
              appId: effectiveFeishu.appId,
              appSecret: effectiveFeishu.appSecret,
              ownerOpenId: userFeishu?.ownerOpenId,
            },
          });
        }
        if (effectiveTelegram) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'telegram',
            name: '默认 Telegram',
            enabled: effectiveTelegram.enabled !== false,
            secret: {
              botToken: effectiveTelegram.botToken,
              proxyUrl: effectiveTelegram.proxyUrl,
            },
          });
        }
        if (effectiveQQ) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'qq',
            name: '默认 QQ',
            enabled: effectiveQQ.enabled !== false,
            secret: {
              appId: effectiveQQ.appId,
              appSecret: effectiveQQ.appSecret,
            },
          });
        }
        if (effectiveWeChat) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'wechat',
            name: '默认微信',
            enabled: effectiveWeChat.enabled !== false,
            secret: {
              botToken: effectiveWeChat.botToken,
              ilinkBotId: effectiveWeChat.ilinkBotId,
              baseUrl: effectiveWeChat.baseUrl,
              cdnBaseUrl: effectiveWeChat.cdnBaseUrl,
              getUpdatesBuf: effectiveWeChat.getUpdatesBuf,
              bypassProxy: String(userWeChat?.bypassProxy ?? true),
            },
          });
        }
        if (effectiveDingTalk) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'dingtalk',
            name: '默认钉钉',
            enabled: effectiveDingTalk.enabled !== false,
            secret: {
              clientId: effectiveDingTalk.clientId,
              clientSecret: effectiveDingTalk.clientSecret,
            },
          });
        }
        if (effectiveDiscord) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'discord',
            name: '默认 Discord',
            enabled: effectiveDiscord.enabled !== false,
            secret: {
              botToken: effectiveDiscord.botToken,
              streamingMode: effectiveDiscord.streamingMode,
            },
          });
        }
        if (effectiveWhatsApp) {
          ensureLegacyDefaultChannelAccount({
            ownerUserId: user.id,
            provider: 'whatsapp',
            name: '默认 WhatsApp',
            enabled: effectiveWhatsApp.enabled !== false,
            secret: {
              accountId: effectiveWhatsApp.accountId,
              phoneNumber: effectiveWhatsApp.phoneNumber,
            },
          });
        }
      } catch (err) {
        logger.error(
          { userId: user.id, err },
          'Failed to migrate legacy IM config into channel accounts',
        );
      }
    }),
  );

  // Single startup path: after legacy singleton configs are projected, only
  // first-class accounts connect. This prevents the same credentials from
  // running once as `provider` and again as `provider\0accountId`.
  // Feishu records its durable Inbox before invoking these callbacks. Keep
  // execution paused while transports connect and old provider cards are
  // reconciled; messages arriving in this window remain queued for retry.
  imManager.deferInbound();
  await Promise.allSettled(
    listEnabledChannelAccounts().map((account) =>
      reloadChannelAccountById(account.id),
    ),
  );
  anyFeishuConnected = imManager.isAnyFeishuConnected();

  // Recovery order is intentional and forms a correctness boundary:
  // exact Bot account ready -> close cards left live by the old process ->
  // invalidate expired execution fences -> only then resume Agent work.
  // Starting the message loop earlier can create a second active card for the
  // same logical turn while the provider still shows the old one as running.
  await reconcileChannelReliabilityOnStartup(imManager);
  const outboxRecovery = reconcileChannelOutboxDeliveries();
  if (outboxRecovery.uncertain > 0) {
    logger.warn(
      outboxRecovery,
      'Channel outbox contains uncertain sends; automatic replay is blocked',
    );
  } else if (outboxRecovery.retryable > 0) {
    logger.info(
      outboxRecovery,
      'Channel outbox recovered retryable pre-send work',
    );
  }
  channelReliabilityRecoveryLoop =
    startChannelReliabilityRecoveryLoop(imManager);
  unsubscribeChannelReadyRecovery = imManager.onChannelReady(() => {
    void channelReliabilityRecoveryLoop?.trigger();
  });
  imManager.resumeDeferredInbound();
  recoverStreamingBuffer();
  recoverStartupTypedIpcDeliveries();
  recoverPendingMessages();
  recoverConversationAgents();
  startIpcWatcher();
  startStreamingBuffer();
  startMessageLoop();

  // Start Feishu group sync if any connection is active
  if (anyFeishuConnected) {
    ensureFeishuSyncScheduler();
  } else if (
    globalFeishuConfig.config.enabled !== false &&
    globalFeishuConfig.source !== 'none'
  ) {
    logger.warn(
      'Feishu is not connected. Configure credentials in Settings to enable Feishu sync.',
    );
  }

  // Run health check once on startup to clean up orphaned bindings, then periodically
  void checkImBindingsHealth().then(() => {
    // After health check, ensure auto_im agents exist for users with autoIsolateContext enabled
    const groups = getAllRegisteredGroups();
    const userIds = new Set<string>();
    for (const [jid, group] of Object.entries(groups)) {
      if (getChannelType(jid) === 'feishu' && group.created_by) {
        userIds.add(group.created_by);
      }
    }
    for (const uid of userIds) {
      const isolationConfig = getUserContextIsolationConfig(uid, 'feishu', {
        getUserFeishuConfig,
      });
      if (isolationConfig.enabled) {
        const migrated = applyAutoIsolateContext(uid, true);
        if (migrated > 0) {
          logger.info(
            { userId: uid, migrated },
            'Startup: restored auto_im agents for user with autoIsolateContext enabled',
          );
        }
      }
    }
  });
  const IM_BINDING_HEALTH_CHECK_INTERVAL = 30 * 60 * 1000; // 30 min
  setInterval(() => {
    void checkImBindingsHealth();
  }, IM_BINDING_HEALTH_CHECK_INTERVAL);
}

async function checkImBindingsHealth(): Promise<void> {
  const boundEntries: Array<{ jid: string; group: RegisteredGroup }> = [];
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.target_agent_id || group.target_main_jid) {
      boundEntries.push({ jid, group });
    }
  }

  if (boundEntries.length === 0) return;
  logger.debug(
    { count: boundEntries.length },
    'Running IM binding health check',
  );

  for (const { jid, group } of boundEntries) {
    // Check for orphaned target_main_jid — target workspace no longer exists
    if (group.target_main_jid) {
      const targetGroup =
        registeredGroups[group.target_main_jid] ??
        getRegisteredGroup(group.target_main_jid);
      if (!targetGroup) {
        const restored = unbindImGroup(
          jid,
          `Orphaned main conversation binding: target ${group.target_main_jid} no longer exists`,
        );
        if (!restored) {
          logger.warn(
            { jid, targetMainJid: group.target_main_jid },
            'Health check kept orphaned main binding because default restore was unavailable',
          );
        }
        continue;
      }
    }

    // Check for orphaned target_agent_id — agent no longer exists
    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      if (!agent) {
        // For auto_im agents, re-create instead of unbinding if toggle is still on
        const userId = group.created_by;
        const channelType = getChannelType(jid);
        if (userId && channelType) {
          const isolationConfig = getUserContextIsolationConfig(
            userId,
            channelType,
            {
              getUserFeishuConfig,
            },
          );
          if (isolationConfig.enabled) {
            const unbound: RegisteredGroup = {
              ...group,
              target_agent_id: undefined,
            };
            if (
              ensureAutoImConversationBinding(
                jid,
                unbound,
                userId,
                group.name || jid,
              )
            ) {
              logger.info(
                { jid, userId },
                'Health check: re-created auto_im agent (previous agent lost)',
              );
              continue;
            }
          }
        }
        const restored = unbindImGroup(
          jid,
          `Orphaned agent binding: agent ${group.target_agent_id} no longer exists`,
        );
        if (!restored) {
          logger.warn(
            { jid, agentId: group.target_agent_id },
            'Health check kept orphaned session binding because default restore was unavailable',
          );
        }
        continue;
      }
    }

    try {
      const info = await imManager.getChatInfo(jid);
      if (info === undefined) {
        // Channel doesn't support getChatInfo (e.g. Telegram, QQ) — skip reachability check
        continue;
      }
      if (info === null) {
        // Chat not reachable — could be temporary (connection down, API permission issue)
        const count = (imHealthCheckFailCounts.get(jid) ?? 0) + 1;
        imHealthCheckFailCounts.set(jid, count);
        if (count >= IM_HEALTH_CHECK_FAIL_THRESHOLD) {
          removeImGroupRecord(
            jid,
            'IM group not reachable after multiple checks, auto-removing',
          );
        } else {
          logger.debug(
            {
              jid,
              failCount: count,
              threshold: IM_HEALTH_CHECK_FAIL_THRESHOLD,
            },
            'IM health check failed, will retry before unbinding',
          );
        }
      } else {
        // Chat is reachable — reset failure counter
        imHealthCheckFailCounts.delete(jid);
      }
    } catch (err) {
      // API error — could be temporary, don't unbind on single failure
      logger.debug({ jid, err }, 'IM binding health check failed for group');
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start happyclaw');
  process.exit(1);
});
