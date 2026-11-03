import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { isIpcTaskResultFile } from '../src/ipc-delivery-recovery.js';
import { WORK_IPC_TYPES } from '../src/work-items.js';

const runnerSrc = path.join(process.cwd(), 'container', 'agent-runner', 'src');

function runnerSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return runnerSourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function stringValue(node: ts.Node | undefined): string | null {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function parseRunnerSources(): ts.SourceFile[] {
  return runnerSourceFiles(runnerSrc).map((file) =>
    ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    ),
  );
}

/** String-literal members of every `type X = 'a' | 'b'` alias in the runner. */
function collectLiteralUnions(sources: ts.SourceFile[]): Map<string, string[]> {
  const unions = new Map<string, string[]>();
  for (const source of sources) {
    visit(source, (node) => {
      if (!ts.isTypeAliasDeclaration(node) || !ts.isUnionTypeNode(node.type)) {
        return;
      }
      const members = node.type.types.flatMap((member) =>
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
          ? [member.literal.text]
          : [],
      );
      if (members.length > 0) unions.set(node.name.text, members);
    });
  }
  return unions;
}

/**
 * Tool factories that receive the poller as a callback and pass it
 * `${request.type}_result`, mapped to the union of their request types.
 */
const CALLBACK_RESULT_TYPES: Record<string, string> = {
  createAutomationTools: 'AutomationIpcType',
};

/**
 * Contract: every result prefix the runner polls for in its tasks/ directory
 * (`pollIpcResult(<tasks dir>, request, '<type>_result', …)`) must be
 * classified as a host result, never as a request the watcher may consume.
 * Prefixes are string literals, module constants, or `${type}_result` inside a
 * helper whose literal `type` arguments are collected from its call sites,
 * or the `resultPrefix` parameter of a callback handed to a tool factory.
 */
function collectTaskResultPrefixes(): string[] {
  const prefixes = new Set<string>();
  const sources = parseRunnerSources();
  const unions = collectLiteralUnions(sources);
  for (const source of sources) {
    const constants = new Map<string, string>();
    const literalCallArgs = new Map<string, string[]>();
    const polls: ts.CallExpression[] = [];
    visit(source, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const value = stringValue(node.initializer);
        if (value !== null) constants.set(node.name.text, value);
      }
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
        return;
      }
      if (node.expression.text === 'pollIpcResult') polls.push(node);
      const first = stringValue(node.arguments[0]);
      if (first !== null) {
        const values = literalCallArgs.get(node.expression.text) ?? [];
        values.push(first);
        literalCallArgs.set(node.expression.text, values);
      }
    });

    for (const call of polls) {
      const [requestDir, , prefixArg, , resultDir] = call.arguments;
      if (!/tasks/i.test((resultDir ?? requestDir).getText(source))) continue;
      const literal = stringValue(prefixArg);
      if (literal !== null) {
        prefixes.add(literal);
        continue;
      }
      if (ts.isIdentifier(prefixArg) && constants.has(prefixArg.text)) {
        prefixes.add(constants.get(prefixArg.text)!);
        continue;
      }
      const callbackFactory = ts.isIdentifier(prefixArg)
        ? callbackFactoryOf(call, prefixArg.text)
        : null;
      // The work tools' types are a const array (WORK_IPC_TYPES), not a
      // literal union the scan can read. Their sender is passed straight to
      // createWorkTools, or declared once as a WorkIpcCall and shared by the
      // team and delegation tools.
      if (
        callbackFactory === 'createWorkTools' ||
        (ts.isIdentifier(prefixArg) &&
          declaredCallbackType(call, prefixArg.text) === 'WorkIpcCall')
      ) {
        for (const type of WORK_IPC_TYPES) prefixes.add(`${type}_result`);
        continue;
      }
      if (callbackFactory && CALLBACK_RESULT_TYPES[callbackFactory]) {
        const types = unions.get(CALLBACK_RESULT_TYPES[callbackFactory]) ?? [];
        expect(
          types.length,
          `no request types found for ${callbackFactory}`,
        ).toBeGreaterThan(0);
        for (const type of types) prefixes.add(`${type}_result`);
        continue;
      }
      if (
        ts.isTemplateExpression(prefixArg) &&
        prefixArg.head.text === '' &&
        prefixArg.templateSpans.length === 1 &&
        ts.isIdentifier(prefixArg.templateSpans[0].expression)
      ) {
        // `${type}_result` inside `const helper = async (type, …) => …`.
        let owner: ts.Node | undefined = call.parent;
        while (owner && !ts.isArrowFunction(owner)) owner = owner.parent;
        const helper =
          owner && ts.isVariableDeclaration(owner.parent)
            ? owner.parent.name.getText(source)
            : null;
        const types = helper ? (literalCallArgs.get(helper) ?? []) : [];
        expect(
          types.length,
          `no literal call sites found for ${helper ?? 'unknown helper'}`,
        ).toBeGreaterThan(0);
        const suffix = prefixArg.templateSpans[0].literal.text;
        for (const type of types) prefixes.add(`${type}${suffix}`);
        continue;
      }
      throw new Error(
        `Unresolvable pollIpcResult prefix in ${path.relative(runnerSrc, source.fileName)}: ${prefixArg.getText(source)}`,
      );
    }
  }
  return [...prefixes].sort();
}

/**
 * `const sender: <Type> = (request, <param>) => pollIpcResult(…, <param>)`:
 * the declared type of `sender` when `param` is a parameter of the arrow.
 */
function declaredCallbackType(call: ts.Node, param: string): string | null {
  let owner: ts.Node | undefined = call.parent;
  while (owner && !ts.isArrowFunction(owner)) owner = owner.parent;
  if (
    !owner ||
    !owner.parameters.some(
      (p) => ts.isIdentifier(p.name) && p.name.text === param,
    )
  ) {
    return null;
  }
  const declaration = owner.parent;
  return ts.isVariableDeclaration(declaration) && declaration.type
    ? declaration.type.getText()
    : null;
}

/**
 * `factory((request, <param>) => pollIpcResult(…, <param>))`: the name of
 * `factory` when `param` is a parameter of the enclosing arrow function.
 */
function callbackFactoryOf(call: ts.Node, param: string): string | null {
  let owner: ts.Node | undefined = call.parent;
  while (owner && !ts.isArrowFunction(owner)) owner = owner.parent;
  if (
    !owner ||
    !owner.parameters.some(
      (p) => ts.isIdentifier(p.name) && p.name.text === param,
    )
  ) {
    return null;
  }
  const factory = owner.parent;
  return ts.isCallExpression(factory) && ts.isIdentifier(factory.expression)
    ? factory.expression.text
    : null;
}

// Same shape as the runner's newRequestId() / writeIpcFile() names.
function runnerRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('task IPC result files are never consumed as requests', () => {
  const prefixes = collectTaskResultPrefixes();

  test('the runner contract scan finds the tasks/ result prefixes', () => {
    // Guards the scanner itself: these tools previously self-reaped their ACK.
    expect(prefixes).toEqual(
      expect.arrayContaining([
        'fresh_window_result',
        'feishu_capability_result',
        'agent_profile_list_result',
        'workspace_memory_result',
        'happyclaw_owner_profile_result',
        'automation_create_result',
        'automation_notify_current_run_result',
        'work_route_result',
        'work_report_result',
      ]),
    );
  });

  test('automation tools poll `${request.type}_result`', () => {
    // CALLBACK_RESULT_TYPES assumes this naming; fail loudly if it changes.
    const source = fs.readFileSync(
      path.join(runnerSrc, 'automation-tools.ts'),
      'utf8',
    );
    expect(source).toContain('call(request, `${request.type}_result`)');
  });

  test('every runner-polled result file is classified as a host result', () => {
    const unrecognized = prefixes.filter(
      (prefix) => !isIpcTaskResultFile(`${prefix}_${runnerRequestId()}.json`),
    );
    expect(unrecognized).toEqual([]);
  });

  test('runner request files and temp writes are not results', () => {
    expect(isIpcTaskResultFile(`${runnerRequestId()}.json`)).toBe(false);
    expect(
      isIpcTaskResultFile(
        `fresh_window_result_${runnerRequestId()}.json.1234.tmp`,
      ),
    ).toBe(false);
    expect(isIpcTaskResultFile('fresh_window.json')).toBe(false);
  });
});
