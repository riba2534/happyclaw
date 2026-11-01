import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

import { isAutomationTurnInput } from '../../src/agent-builder-turn-auth.js';
import * as automationLedger from '../../src/automation-run-ledger.js';
import { canDeleteAcknowledgedIpcSource } from '../../src/host-ipc-output-router.js';
import { WORK_IPC_TYPES } from '../../src/work-items.js';
import { readTeamInput } from '../../src/team-gate.js';

// Execute whole production functions with explicit dependencies, without
// importing index.ts (which starts the server). No routing/cursor algorithm is
// copied into the harness. Missing globals fail normally instead of becoming
// permissive mocks, and tests assert observable effects rather than source text.
const sources = new Map<string, ts.SourceFile>();
function readSource(location: URL): ts.SourceFile {
  const key = location.href;
  let source = sources.get(key);
  if (!source) {
    source = ts.createSourceFile(
      key,
      fs.readFileSync(location, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    sources.set(key, source);
  }
  return source;
}
const compiled = new Map<string, vm.Script>();

function unique(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one production function, found ${matches.length}`,
    );
  }
  return matches[0];
}

function isNamedDeclaration(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.VariableDeclaration
  | ts.ClassDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

// Declarations by name, per root: index.ts is large, and walking all of it
// for every lookup made each harness cost about a second.
const declarationIndexes = new WeakMap<ts.Node, Map<string, ts.Node[]>>();

function named(
  name: string,
  source: ts.SourceFile,
  root: ts.Node = source,
): ts.Node {
  let index = declarationIndexes.get(root);
  if (!index) {
    const built = new Map<string, ts.Node[]>();
    const visit = (node: ts.Node): void => {
      if (isNamedDeclaration(node) && node.name) {
        const key = node.name.getText(source);
        const list = built.get(key);
        if (list) list.push(node);
        else built.set(key, [node]);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    declarationIndexes.set(root, built);
    index = built;
  }
  const matches = index.get(name) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one production function, found ${matches.length}`,
    );
  }
  return matches[0];
}

/**
 * Automation bookkeeping every turn path touches. A test that is not about
 * automations runs with no automation inputs, so these stay inert; a test
 * may override any of them.
 */
function automationDefaults(): Record<string, unknown> {
  return {
    ...automationLedger,
    isAutomationTurnInput,
    canDeleteAcknowledgedIpcSource,
    automationTurns: new automationLedger.AutomationTurnTracker(),
    coldImRouteHeld: false,
    rememberAutomationRuns: () => {},
    settleCurrentAutomationRun: () => {},
    UNSETTLED_RUN_OUTCOME: { status: 'interrupted', error: 'unsettled' },
    // Team mode: no session has a team role and no message a team decision.
    isWorkIpcType: (type: unknown) =>
      (WORK_IPC_TYPES as readonly unknown[]).includes(type),
    resolveTeamRole: () => null,
    teamLaneOf: () => null,
    // processAgentConversation's own: extracted callbacks close over it.
    teamRole: null,
    resolveTeamRoute: () => null,
    afterTeamMessageStored: () => {},
    followupCopyIdsOf: () => [],
    readTeamInput,
    onTeamMessageStored: () => {},
    // utils.ts reads config at import; tests mock config, so not imported.
    agentIdOfJid: (jid: string) =>
      jid.includes('#agent:') ? jid.split('#agent:')[1] || null : null,
    getAgentBuilderInputMessage: () => null,
    // Session lane bookkeeping a test of another concern runs without:
    // sub-agent checkpoints, IPC reply acknowledgement, the billing push and
    // the OOM counter.
    runningSubagentTasksByLane: new Map(),
    trackSubagentTaskEvent: () => {},
    nonSubagentTaskIds: new Set(),
    subagentTaskInputMessageId: () => '',
    activeIpcReplyTurnTrackers: new Map(),
    agentIpcReplyTracker: { inputTurnId: '', delivered: false },
    broadcastOwnerBillingUsage: () => {},
    clearSessionOomExits: () => {},
  };
}

/** index.ts helpers for automation inputs, installed unless a test provides them. */
const AUTOMATION_SOURCE_HELPERS = [
  'isUnattendedInput',
  'dropNonReplayableInputs',
  'withdrawQueuedInput',
  'withdrawQueuedInputsOfEndedRuns',
  'automationRunIdForInput',
  'createReplyStreamingSession',
  // Team mode helpers every connector and /break path reaches.
  'breakLane',
  'onImMessagePersisted',
];

const HOST_INDEX = new URL('../../src/index.ts', import.meta.url);

export function createRuntimeSourceHarness(
  globals: Record<string, unknown>,
  location = HOST_INDEX,
) {
  const source = readSource(location);
  const provided = new Set(Object.keys(globals));
  for (const [name, value] of Object.entries(automationDefaults())) {
    if (!provided.has(name)) globals[name] = value;
  }
  const context = vm.createContext(globals);
  function installNode(
    name: string,
    node: ts.Node,
    wrap = (code: string) => code,
  ): void {
    const key = `${source.fileName}:${name}:${node.pos}`;
    let script = compiled.get(key);
    if (!script) {
      const expression = ts.isVariableDeclaration(node)
        ? node.initializer!
        : node;
      const js = ts.transpileModule(
        `globalThis[${JSON.stringify(name)}] = (${wrap(expression.getText(source).replace(/^export\s+/, ''))});`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText;
      script = new vm.Script(js, { filename: `index.ts:${name}` });
      compiled.set(key, script);
    }
    script.runInContext(context);
  }
  if (location.href === HOST_INDEX.href) {
    for (const name of AUTOMATION_SOURCE_HELPERS) {
      if (!provided.has(name)) installNode(name, named(name, source));
    }
  }
  return {
    globals,
    install(name: string, owner?: string): void {
      installNode(
        name,
        named(name, source, owner ? named(owner, source) : source),
      );
    },
    /** Install the argument of the unique `callee(...)` call in `owner`. */
    installCallArgument(
      name: string,
      owner: string,
      callee: string,
      index: number,
    ): void {
      const call = unique(
        named(owner, source),
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === callee,
      ) as ts.CallExpression;
      installNode(name, call.arguments[index]);
    },
    /**
     * Install `owner`'s top-level statements from the unique `if (condition)`
     * to the end of its body as a function returning what they return: the
     * verdict a run reaches once that state is set.
     */
    installTail(name: string, owner: string, condition: string): void {
      const fn = named(owner, source) as ts.FunctionDeclaration;
      const statement = unique(
        fn,
        (node) =>
          ts.isIfStatement(node) &&
          node.parent === fn.body &&
          node.expression.getText(source) === condition,
      );
      const statements = fn.body!.statements;
      const tail = statements.slice(
        statements.indexOf(statement as ts.Statement),
      );
      const body = tail.map((s) => s.getText(source)).join('\n');
      // A tail that awaits installs as an async function.
      const arrow = /\bawait\b/.test(body) ? 'async () =>' : '() =>';
      installNode(name, statement, () => `${arrow} {\n${body}\n}`);
    },
    /**
     * Install the `finally` block of `owner`'s top-level try statement as an
     * async function, so its cleanup runs against the provided state.
     */
    installFinally(name: string, owner: string): void {
      const fn = named(owner, source) as ts.FunctionDeclaration;
      const statement = unique(
        fn,
        (node) =>
          ts.isTryStatement(node) &&
          node.finallyBlock !== undefined &&
          node.parent === fn.body,
      ) as ts.TryStatement;
      installNode(
        name,
        statement.finallyBlock!,
        (block) => `async () => ${block}`,
      );
    },
  };
}
