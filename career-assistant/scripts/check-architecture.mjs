import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowed = {
  web: ['contracts'],
  api: ['business', 'config', 'observability', 'contracts'],
  agent: ['agent-core', 'config', 'observability', 'contracts'],
  worker: ['business', 'config', 'observability', 'contracts'],
  contracts: [],
  config: [],
  business: ['contracts'],
  'agent-core': ['contracts', 'config'],
  observability: ['contracts'],
  testing: [],
};
export function validateImport(file, specifier) {
  const segments = file.replaceAll('\\', '/').split('/');
  const owner = segments[1];
  if (!owner || !(owner in allowed)) return '未知源码所属包';
  if (specifier.startsWith('@career/')) {
    const target = specifier.slice('@career/'.length);
    if (target.includes('/') || !allowed[owner].includes(target))
      return '跨包依赖越界';
  }
  if (specifier.startsWith('.')) {
    const target = resolve(root, dirname(file), specifier);
    const boundary = resolve(root, segments[0], owner) + '/';
    if (!target.startsWith(boundary)) return '跨包相对路径访问';
    if (
      (file.includes('/application/') || file.includes('/domain/')) &&
      target.includes('/infrastructure/')
    )
      return '应用或领域依赖基础设施';
  }
  if (
    /prisma|^pg$/.test(specifier) &&
    !file.includes('/infrastructure/') &&
    owner !== 'testing'
  )
    return 'ORM或数据库访问越界';
  if (owner === 'agent-core' && /nestjs|prisma|^pg$/.test(specifier))
    return 'Agent Core依赖业务框架或数据库';
  return undefined;
}
export async function checkArchitecture() {
  let files = 0;
  const failures = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['dist', 'generated', 'node_modules'].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        files++;
        const file = relative(root, path);
        const tree = ts.createSourceFile(
          file,
          await readFile(path, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node) {
          let specifier;
          if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
          )
            specifier = node.moduleSpecifier.text;
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              node.expression.getText(tree) === 'require')
          ) {
            if (
              node.arguments.length !== 1 ||
              !ts.isStringLiteral(node.arguments[0])
            )
              failures.push(`${file}:禁止动态构造导入路径`);
            else specifier = node.arguments[0].text;
          }
          if (specifier) {
            const violation = validateImport(file, specifier);
            if (violation) failures.push(`${file}: ${violation}`);
          }
          ts.forEachChild(node, visit);
        }
        visit(tree);
      }
    }
  }
  await scan(resolve(root, 'apps'));
  await scan(resolve(root, 'packages'));
  if (failures.length) throw Error(failures.join('\n'));
  return files;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(`架构边界通过：${await checkArchitecture()}个源码文件`);
