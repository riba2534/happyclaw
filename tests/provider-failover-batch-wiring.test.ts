import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const source = ts.createSourceFile(
  'src/index.ts',
  fs.readFileSync('src/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function collect<T extends ts.Node>(
  root: ts.Node,
  match: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function productionFunction(name: string): ts.FunctionDeclaration {
  const found = collect(
    source,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return collect(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(source) === name,
  );
}

function propertyValue(object: ts.Expression, name: string): ts.Expression {
  expect(ts.isObjectLiteralExpression(object)).toBe(true);
  const property = (object as ts.ObjectLiteralExpression).properties.find(
    (node) => node.name?.getText(source) === name,
  );
  expect(property).toBeDefined();
  if (ts.isShorthandPropertyAssignment(property!)) return property.name;
  expect(ts.isPropertyAssignment(property!)).toBe(true);
  return (property as ts.PropertyAssignment).initializer;
}

function evaluate(
  expression: ts.Expression,
  globals: Record<string, unknown>,
): unknown {
  // Execute the exact production argument/property expression. No copy of the
  // batch mapping is maintained here, and unrelated trailing arguments may evolve.
  return vm.runInNewContext(`(${expression.getText(source)})`, globals);
}

const selectedMessages = [
  { id: 'first-selected' },
  { id: 'second-selected' },
  { id: 'last-selected' },
];
const expectedIds = selectedMessages.map((message) => message.id);

describe('provider failover cold-run batch wiring', () => {
  test('conversation agents put the whole selected batch on their shared cold-run input', () => {
    const declarations = collect(
      productionFunction('processAgentConversation'),
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'containerInput',
    );
    expect(declarations).toHaveLength(1);
    const expression = propertyValue(
      declarations[0].initializer!,
      'currentBatchMessageIds',
    );
    expect(evaluate(expression, { missedMessages: selectedMessages })).toEqual(
      expectedIds,
    );
  });
});
