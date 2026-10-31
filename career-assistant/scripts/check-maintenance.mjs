import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('apps/worker/src/cli.ts', root), 'utf8');
const tree = ts.createSourceFile(
  'cli.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const actual = new Set();
function visit(node) {
  if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression))
    actual.add(node.expression.text);
  ts.forEachChild(node, visit);
}
visit(tree);
const registry = JSON.parse(
  await readFile(new URL('tests/maintenance-registry.json', root), 'utf8'),
);
const seen = new Set();
for (const entry of registry) {
  if (seen.has(entry.command) || !actual.has(entry.command))
    throw Error('维护命令清单重复或与实现不一致');
  seen.add(entry.command);
  const test = await readFile(new URL(entry.test, root), 'utf8');
  const parsed = ts.createSourceFile(
    entry.test,
    test,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  function match(node) {
    if (
      ts.isCallExpression(node) &&
      ['it', 'test'].includes(node.expression.getText(parsed)) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === entry.testName
    )
      found = true;
    ts.forEachChild(node, match);
  }
  match(parsed);
  if (!found) throw Error('维护命令缺少关联测试');
}
if (actual.size !== seen.size) throw Error('存在未登记维护命令');
console.log(`维护命令测试清单通过：${seen.size}个操作`);
