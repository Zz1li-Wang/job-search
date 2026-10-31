import { createHash, randomUUID, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
import { createPersistence } from '../persistence.js';
import { createSnapshotStore, createExportStore } from './files.js';
import { createSourceReader, type NetworkSettings } from './source.js';
import { createIngestionServices } from '../../application/ingestion/index.js';
import type {
  SourceReader,
  IngestionDependencies,
} from '../../application/ingestion/ports.js';
export interface IngestionRuntimeSettings {
  databaseUrl: string;
  privateRoot: string;
  exportRoot: string;
  operatorReference: string;
  network: NetworkSettings;
}
/** 组合端口与适配器，测试来源只由测试入口代码注入。 */
export function createIngestionRuntime(
  settings: IngestionRuntimeSettings,
  overrides: { source?: SourceReader; now?: () => Date } = {},
) {
  const persistence = createPersistence(settings.databaseUrl);
  const source =
    overrides.source ??
    createSourceReader(
      {
        unitOfWork: persistence.unitOfWork,
        repositories: persistence.ingestion,
      },
      settings.network,
    );
  const dependencies: IngestionDependencies = {
    unitOfWork: persistence.unitOfWork,
    repositories: persistence.ingestion,
    repeatableRead: persistence.repeatableRead,
    source,
    files: createSnapshotStore(join(settings.privateRoot, 'source-snapshots')),
    exports: createExportStore(settings.exportRoot),
    operatorReference: settings.operatorReference,
    networkEnabled: settings.network.enabled,
    digest: (value) => createHash('sha256').update(value).digest('hex'),
    id: randomUUID,
    now: overrides.now ?? (() => new Date()),
    jitter: () => randomInt(0, 201) / 1000,
  };
  return {
    services: createIngestionServices(dependencies),
    dependencies,
    persistence,
    close: persistence.close,
  };
}
/** Cookie文件不打印，只有获准Worker调用此函数；API不加载外部凭据。 */
export async function readSourceCookie(
  file: string,
): Promise<string | undefined> {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw Error('来源配置必须是0600私有文件');
    const cookie = parseEnv(await readFile(file, 'utf8')).SOURCE_COOKIE;
    if (cookie && /[\r\n]/.test(cookie)) throw Error('来源配置无效');
    return cookie || undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw Error('来源配置不可读取或权限无效');
  }
}
