import { checkMcp } from './check-mcp.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HTTP_METHODS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Options',
  'Head',
  'All',
]);
function literalArgument(expression) {
  const argument = expression.arguments[0];
  if (!argument) return '';
  if (!ts.isStringLiteral(argument)) throw Error('接口路径必须可静态检查');
  return argument.text;
}
function decorators(node, tree) {
  return (ts.getDecorators(node) ?? []).flatMap((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression)
      ? [{ name: expression.expression.getText(tree), expression }]
      : [];
  });
}
export async function checkInterfaces(
  root = fileURLToPath(new URL('..', import.meta.url)),
) {
  const registry = JSON.parse(
    await readFile(resolve(root, 'tests/interface-registry.json'), 'utf8'),
  );
  const actual = new Set();
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'generated'].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = await readFile(path, 'utf8');
        const file = relative(root, path).replaceAll('\\', '/');
        const tree = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node) {
          if (ts.isClassDeclaration(node)) {
            const controller = decorators(node, tree).find(
              (d) => d.name === 'Controller',
            );
            if (controller) {
              const prefix = literalArgument(controller.expression);
              const services = file.startsWith('packages/observability/')
                ? ['api', 'agent']
                : [file.split('/')[1]];
              if (
                services.some((service) => !['api', 'agent'].includes(service))
              )
                throw Error('HTTP入口必须归属明确服务');
              for (const member of node.members) {
                if (!ts.isMethodDeclaration(member)) continue;
                for (const decorator of decorators(member, tree).filter((d) =>
                  HTTP_METHODS.has(d.name),
                )) {
                  const route =
                    '/' +
                    [prefix, literalArgument(decorator.expression)]
                      .filter(Boolean)
                      .join('/')
                      .replace(/^\/+|\/+$/g, '');
                  for (const service of services)
                    actual.add(
                      `${service}:${decorator.name.toUpperCase()}:${route}`,
                    );
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(tree);
      }
    }
  }
  await scan(resolve(root, 'apps'));
  await scan(resolve(root, 'packages'));
  const registered = new Set();
  const ids = new Set();
  for (const entry of registry) {
    const key = `${entry.service}:${entry.method}:${entry.path}`;
    if (registered.has(key) || ids.has(entry.id)) throw Error('接口清单重复');
    registered.add(key);
    ids.add(entry.id);
    if (!actual.has(key)) throw Error('接口清单与实现不一致');
    const source = await readFile(resolve(root, entry.test), 'utf8');
    const tree = ts.createSourceFile(
      entry.test,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    let hasTest = false;
    function findTest(node) {
      if (
        ts.isCallExpression(node) &&
        ['it', 'test'].includes(node.expression.getText(tree))
      ) {
        const name = node.arguments[0];
        if (name && ts.isStringLiteral(name) && name.text === entry.testName)
          hasTest = true;
      }
      ts.forEachChild(node, findTest);
    }
    findTest(tree);
    if (!hasTest) throw Error('缺少指定可执行接口测试');
  }
  for (const key of actual)
    if (!registered.has(key)) throw Error('已实现接口未关联测试');
  return registry.length;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    `接口测试清单通过：${await checkInterfaces()}个HTTP操作、${await checkMcp()}个MCP工具`,
  );
