import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
export async function checkMcp(
  root = fileURLToPath(new URL('..', import.meta.url)),
) {
  const source = await readFile(
      resolve(root, 'apps/api/src/chat/module.ts'),
      'utf8',
    ),
    tree = ts.createSourceFile(
      'module.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    ),
    actual = new Set();
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'register' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      actual.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const entries = JSON.parse(
      await readFile(resolve(root, 'tests/mcp-registry.json'), 'utf8'),
    ),
    registered = new Set();
  for (const entry of entries) {
    if (registered.has(entry.name) || !actual.has(entry.name))
      throw Error('MCP工具清单重复或与实现不一致');
    registered.add(entry.name);
    const test = await readFile(resolve(root, entry.test), 'utf8');
    const testTree = ts.createSourceFile(
      entry.test,
      test,
      ts.ScriptTarget.Latest,
      true,
    );
    let found = false;
    function testVisit(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(testTree) === 'it' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === entry.testName
      )
        found = true;
      ts.forEachChild(node, testVisit);
    }
    testVisit(testTree);
    if (!found) throw Error('MCP工具缺少指定测试');
  }
  for (const name of actual)
    if (!registered.has(name)) throw Error('MCP工具未关联测试');
  return registered.size;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(`MCP测试清单通过：${await checkMcp()}个工具`);
