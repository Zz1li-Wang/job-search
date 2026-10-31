import { mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import type { PrivateFileStore } from '../application/ports.js';

/** 本地可信根目录不可由用户写入；键限定UUID，拒绝目录穿越和符号链接。 */
export function createPrivateFileStore(directory: string): PrivateFileStore {
  const root = resolve(directory);
  function location(key: string): string {
    if (
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
        key,
      )
    )
      throw Error('非法私有文件标识');
    return join(root, key);
  }
  return {
    async put(key, content) {
      const path = location(key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content);
      } catch (error) {
        await unlink(path);
        throw error;
      } finally {
        await handle.close();
      }
    },
    async read(key) {
      const handle = await open(
        location(key),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    async delete(key) {
      try {
        await unlink(location(key));
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    },
  };
}
