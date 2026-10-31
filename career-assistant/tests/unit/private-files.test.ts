import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPrivateFileStore } from '@career/business';

describe('私有文件端口', () => {
  it('私有权限、重复创建拒绝、读取与幂等删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'career-files-'));
    try {
      const files = createPrivateFileStore(root);
      const key = randomUUID();
      await files.put(key, Buffer.from('fictional resume'));
      expect(Buffer.from(await files.read(key)).toString()).toBe(
        'fictional resume',
      );
      expect((await stat(join(root, key))).mode & 0o777).toBe(0o600);
      await expect(files.put(key, Buffer.from('overwrite'))).rejects.toThrow();
      await files.delete(key);
      await files.delete(key);
      await expect(files.read(key)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('目录穿越和符号链接无法读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'career-files-'));
    try {
      const files = createPrivateFileStore(root);
      const key = randomUUID();
      await expect(files.read('../outside')).rejects.toThrow('非法');
      await expect(files.put('../outside', Buffer.from('x'))).rejects.toThrow(
        '非法',
      );
      await expect(files.delete('../outside')).rejects.toThrow('非法');
      await symlink('/etc/hostname', join(root, key));
      await expect(files.read(key)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
