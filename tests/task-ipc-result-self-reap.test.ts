import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { isIpcTaskResultFile } from '../src/ipc-delivery-recovery.js';

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

/**
 * Contract: every result prefix the runner polls for in its tasks/ directory
 * (`pollIpcResult(<tasks dir>, request, '<type>_result', …)`) must be
 * classified as a host result, never as a request the watcher may consume.
 * Prefixes are string literals, module constants, or `${type}_result` inside a
 * helper whose literal `type` arguments are collected from its call sites.
 */
function collectTaskResultPrefixes(): string[] {
  const prefixes = new Set<string>();
  for (const file of runnerSourceFiles(runnerSrc)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
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
        `Unresolvable pollIpcResult prefix in ${path.relative(runnerSrc, file)}: ${prefixArg.getText(source)}`,
      );
    }
  }
  return [...prefixes].sort();
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
        'schedule_task_result',
      ]),
    );
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
