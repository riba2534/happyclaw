import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute whole production functions with explicit dependencies, without
// importing index.ts (which starts the server). No routing/cursor algorithm is
// copied into the harness. Missing globals fail normally instead of becoming
// permissive mocks, and tests assert observable effects rather than source text.
const source = ts.createSourceFile(
  'src/index.ts',
  fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
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

function named(name: string, root: ts.Node = source): ts.Node {
  return unique(
    root,
    (node) =>
      (ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name?.getText(source) === name,
  );
}

export function createRuntimeSourceHarness(globals: Record<string, unknown>) {
  const context = vm.createContext(globals);
  function installNode(name: string, node: ts.Node): void {
    const key = `${name}:${node.pos}`;
    let script = compiled.get(key);
    if (!script) {
      const expression = ts.isVariableDeclaration(node)
        ? node.initializer!
        : node;
      const js = ts.transpileModule(
        `globalThis[${JSON.stringify(name)}] = (${expression.getText(source)});`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText;
      script = new vm.Script(js, { filename: `index.ts:${name}` });
      compiled.set(key, script);
    }
    script.runInContext(context);
  }
  return {
    globals,
    install(name: string, owner?: string): void {
      installNode(name, named(name, owner ? named(owner) : source));
    },
    installMainOutput(): void {
      const call = unique(
        named('processGroupMessages'),
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 'runAgent',
      ) as ts.CallExpression;
      installNode('handleMainOutput', call.arguments[4]);
    },
    /** Install the argument of the unique `callee(...)` call in `owner`. */
    installCallArgument(
      name: string,
      owner: string,
      callee: string,
      index: number,
    ): void {
      const call = unique(
        named(owner),
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(source) === callee,
      ) as ts.CallExpression;
      installNode(name, call.arguments[index]);
    },
  };
}
