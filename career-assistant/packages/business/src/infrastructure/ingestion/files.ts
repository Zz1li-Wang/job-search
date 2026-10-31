import {
  readdir,
  lstat,
  mkdir,
  open,
  rename,
  readFile,
  unlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPrivateFileStore } from '../private-files.js';
import type {
  SnapshotStore,
  ExportStore,
} from '../../application/ingestion/ports.js';
const uuid =
  /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export function createSnapshotStore(root: string): SnapshotStore {
  const files = createPrivateFileStore(root);
  return {
    ...files,
    async exists(key) {
      if (!uuid.test(key)) return false;
      try {
        const stat = await lstat(join(resolve(root), key));
        return stat.isFile() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    },
    async listOlderThan(date, limit) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return [];
        throw error;
      }
      const keys: string[] = [];
      for (const name of names) {
        if (!uuid.test(name)) continue;
        const stat = await lstat(join(root, name));
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtime < date)
          keys.push(name);
        if (keys.length >= limit) break;
      }
      return keys;
    },
  };
}
export function createExportStore(root: string): ExportStore {
  function path(id: string) {
    if (!uuid.test(id)) throw Error('非法导出标识');
    return join(resolve(root), id + '.json');
  }
  return {
    async write(id, content) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = path(randomUUID());
      const handle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path(id));
      } catch (error) {
        await unlink(temporary);
        throw error;
      }
    },
    async read(id) {
      return readFile(path(id), 'utf8');
    },
  };
}
