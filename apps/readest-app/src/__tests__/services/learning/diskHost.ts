import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import type { AppService, BaseDir } from '@/types/system';

export function createDiskHost(
  root: string,
  options: { failWrites?: () => boolean } = {},
): Pick<AppService, 'openDatabase' | 'createDir' | 'exists' | 'readFile' | 'writeFile'> {
  const resolve = (path: string, base: BaseDir) => {
    if (base !== 'Data') throw new Error('Test host only exposes its isolated Data directory');
    return join(root, 'Readest', path);
  };
  return {
    async createDir(path, base) {
      await mkdir(resolve(path, base), { recursive: true });
    },
    async openDatabase(_schema, path, base) {
      const db = await NodeDatabaseService.open(resolve(path, base));
      return {
        async execute(sql, params) {
          if (options.failWrites?.()) throw new Error('DISK_FULL');
          return db.execute(sql, params);
        },
        async batch(statements) {
          if (options.failWrites?.()) throw new Error('DISK_FULL');
          return db.batch(statements);
        },
        select: db.select.bind(db),
        close: db.close.bind(db),
      };
    },
    async exists(path, base) {
      try {
        await access(resolve(path, base));
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async readFile(path, base, mode) {
      const bytes = await readFile(resolve(path, base));
      return mode === 'text' ? bytes.toString('utf8') : Uint8Array.from(bytes).buffer;
    },
    async writeFile(path, base, content) {
      const bytes =
        typeof content === 'string'
          ? content
          : new Uint8Array(content instanceof ArrayBuffer ? content : await content.arrayBuffer());
      await writeFile(resolve(path, base), bytes);
    },
  };
}
