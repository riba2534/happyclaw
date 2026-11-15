/**
 * Shared fixtures for the automation core tests: a fake runtime that records
 * every call, a controllable clock and workspace seeding. Each test file
 * mocks config/logger itself (vi.mock is hoisted per file) and passes its
 * db module in.
 */
import os from 'node:os';

import type { Automation } from '../src/automation.js';
import type {
  AutomationRuntimeDeps,
  AutomationWsEvent,
  InjectAutomationInputRequest,
} from '../src/automation-contract.js';

export interface FakeRuntime {
  deps: AutomationRuntimeDeps;
  sessions: Set<string>;
  pendingInputs: Set<string>;
  injected: Array<InjectAutomationInputRequest & { inputMessageId: string }>;
  created: Array<{
    sessionJid: string;
    title: string;
    automationId: string;
  }>;
  archived: string[];
  deleted: string[];
  /** Sessions an automation stopped giving its model (sessionJid). */
  released: string[];
  cancelled: Array<{ sessionJid: string; inputMessageId: string }>;
  notices: Array<{ routeJid: string; text: string }>;
  scripts: Array<{ sessionJid: string; text: string }>;
  events: AutomationWsEvent[];
}

export function createFakeRuntime(
  overrides: Partial<AutomationRuntimeDeps> = {},
): FakeRuntime {
  let seq = 0;
  const runtime: FakeRuntime = {
    sessions: new Set(),
    pendingInputs: new Set(),
    injected: [],
    created: [],
    archived: [],
    deleted: [],
    released: [],
    cancelled: [],
    notices: [],
    scripts: [],
    events: [],
    deps: undefined as unknown as AutomationRuntimeDeps,
  };
  runtime.deps = {
    async injectAutomationInput(req) {
      const inputMessageId = `msg-${++seq}`;
      runtime.injected.push({ ...req, inputMessageId });
      runtime.pendingInputs.add(inputMessageId);
      return { inputMessageId };
    },
    async createAutomationSession({ automation, title }) {
      const sessionJid = `${automation.workspaceJid}#agent:s${++seq}`;
      runtime.sessions.add(sessionJid);
      runtime.created.push({ sessionJid, title, automationId: automation.id });
      return { sessionJid };
    },
    sessionExists: (jid) => runtime.sessions.has(jid),
    listAutomationSessions: (automationId) =>
      runtime.created
        .filter(
          (c) =>
            c.automationId === automationId &&
            runtime.sessions.has(c.sessionJid),
        )
        .reverse()
        .map((c) => ({
          sessionJid: c.sessionJid,
          archived: runtime.archived.includes(c.sessionJid),
        })),
    resolveDeliveryRoute: ({ preferredRouteJid }) => preferredRouteJid,
    releaseAutomationSessionModel({ sessionJid }) {
      runtime.released.push(sessionJid);
    },
    async archiveAutomationSession(jid) {
      runtime.archived.push(jid);
    },
    async deleteAutomationSession(jid) {
      runtime.deleted.push(jid);
      runtime.sessions.delete(jid);
    },
    async cancelAutomationInput(req) {
      runtime.cancelled.push(req);
      runtime.pendingInputs.delete(req.inputMessageId);
    },
    async sendAutomationNotice({ routeJid, text }) {
      runtime.notices.push({ routeJid, text });
    },
    async postScriptOutput({ sessionJid, text }) {
      runtime.scripts.push({ sessionJid, text });
    },
    checkBilling: () => ({ ok: true }),
    allowsHostCommands: () => true,
    resolveWorkdir: () => os.tmpdir(),
    isAutomationInputPending: ({ inputMessageId }) =>
      runtime.pendingInputs.has(inputMessageId),
    broadcast: (event) => runtime.events.push(event),
    ...overrides,
  };
  return runtime;
}

export class FakeClock {
  constructor(public ms: number) {}
  now = () => new Date(this.ms);
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

interface DbModule {
  setRegisteredGroup(jid: string, group: never): void;
}

export function seedWorkspace(
  db: DbModule,
  options: {
    jid: string;
    owner: string;
    host?: boolean;
    name?: string;
  },
): void {
  db.setRegisteredGroup(options.jid, {
    name: options.name ?? `WS ${options.jid}`,
    folder: options.jid.slice('web:'.length),
    added_at: new Date().toISOString(),
    executionMode: options.host ? 'host' : 'container',
    created_by: options.owner,
    is_home: false,
  } as never);
}

export function draft(
  overrides: Partial<Automation> & Record<string, unknown> = {},
) {
  return {
    name: '日报',
    prompt: '整理今天的进展',
    schedule: { kind: 'cron' as const, cronExpr: '0 9 * * *' },
    sessionMode: 'fresh' as const,
    ...overrides,
  };
}
