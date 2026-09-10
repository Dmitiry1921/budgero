import { afterEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import path from 'node:path';
import { WebDatabaseAdapter } from '../src/database/web-adapter.js';
import { migrations } from '../src/database/migrations.js';

function adapterFixture(): WebDatabaseAdapter {
  return Object.assign(Object.create(WebDatabaseAdapter.prototype) as WebDatabaseAdapter, {
    dbFilename: 'synthetic-save.db',
    backup: () => new Uint8Array([1, 2, 3]),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('explicit browser database persistence', () => {
  it('rejects saving when browser storage is unavailable', async () => {
    vi.stubGlobal('navigator', { storage: {} });
    await expect(adapterFixture().saveToOPFSPublic()).rejects.toThrow('could not be saved locally');
  });

  it.each(['directory', 'open', 'write', 'close'] as const)(
    'propagates a storage failure during %s instead of reporting a saved budget',
    async (stage) => {
      const failure = new DOMException('Storage quota exceeded', 'QuotaExceededError');
      const abort = vi.fn(async () => undefined);
      const stream = {
        write: vi.fn(async () => {
          if (stage === 'write') throw failure;
        }),
        close: vi.fn(async () => {
          if (stage === 'close') throw failure;
        }),
        abort,
      };
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: async () => {
            if (stage === 'directory') throw failure;
            return {
              getFileHandle: async () => ({
                createWritable: async () => {
                  if (stage === 'open') throw failure;
                  return stream;
                },
              }),
            };
          },
        },
      });
      await expect(adapterFixture().saveToOPFSPublic()).rejects.toBe(failure);
      expect(abort).toHaveBeenCalledTimes(stage === 'write' || stage === 'close' ? 1 : 0);
      if (stage === 'write') expect(stream.close).not.toHaveBeenCalled();
    }
  );

  it('reports success after the exported bytes are written and closed', async () => {
    const writes: Blob[] = [];
    const close = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getFileHandle: async () => ({
            createWritable: async () => ({
              write: async (blob: Blob) => {
                writes.push(blob);
              },
              close,
            }),
          }),
        }),
      },
    });
    await adapterFixture().saveToOPFSPublic();
    expect(close).toHaveBeenCalledOnce();
    expect(new Uint8Array(await writes[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

const sqlPromise = initSqlJs({
  locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
});

async function restoreFixture() {
  const SQL = await sqlPromise;
  const original = new SQL.Database();
  original.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('original')");
  const source = new SQL.Database();
  source.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('replacement')");
  const bytes = source.export();
  source.close();
  const candidates: Database[] = [];
  const candidateCloses: ReturnType<typeof vi.spyOn>[] = [];
  const adapter = Object.assign(Object.create(WebDatabaseAdapter.prototype) as WebDatabaseAdapter, {
    dbFilename: 'synthetic-restore.db',
    db: original,
    SQL: {
      Database: class extends SQL.Database {
        constructor(data?: Uint8Array) {
          super(data);
          candidates.push(this);
          candidateCloses.push(vi.spyOn(this, 'close'));
        }
      },
    },
    fkCheckCounter: 0,
    fkSuspended: false,
  });
  return { SQL, adapter, original, candidates, candidateCloses, bytes };
}

function installWriter(write: (blob: Blob) => Promise<void>, close = async () => undefined) {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => ({ write, close, abort: async () => undefined }),
        }),
      }),
    },
  });
}

describe.each(['restore', 'restoreAndMigrate'] as const)('atomic browser %s', (method) => {
  it.each(['write', 'close'] as const)(
    'keeps the original database usable when storage %s fails',
    async (stage) => {
      const { adapter, original, candidateCloses, bytes } = await restoreFixture();
      const originalClose = vi.spyOn(original, 'close');
      const failure = new Error('synthetic storage failure');
      installWriter(
        async () => {
          if (stage === 'write') throw failure;
        },
        async () => {
          if (stage === 'close') throw failure;
        }
      );
      try {
        await expect(adapter[method](bytes)).rejects.toBe(failure);
        expect(adapter.exec('SELECT value FROM marker')[0].values).toEqual([['original']]);
        adapter.exec("INSERT INTO marker VALUES ('still usable')");
        expect(originalClose).not.toHaveBeenCalled();
        expect(candidateCloses[0]).toHaveBeenCalledOnce();
      } finally {
        adapter.close();
      }
    }
  );

  it('switches databases only after persistence finishes and enables foreign keys', async () => {
    const { SQL, adapter, original, candidateCloses, bytes } = await restoreFixture();
    const originalClose = vi.spyOn(original, 'close');
    let releaseWrite!: () => void;
    let notifyWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      notifyWrite = resolve;
    });
    let persisted: Blob | undefined;
    installWriter(async (blob) => {
      persisted = blob;
      notifyWrite();
      await writeGate;
    });
    try {
      const restoring = adapter[method](bytes);
      await writeStarted;
      expect(adapter.exec('SELECT value FROM marker')[0].values).toEqual([['original']]);
      expect(originalClose).not.toHaveBeenCalled();
      releaseWrite();
      await restoring;
      expect(adapter.exec('SELECT value FROM marker')[0].values).toEqual([['replacement']]);
      expect(adapter.exec('PRAGMA foreign_keys')[0].values).toEqual([[1]]);
      expect(originalClose).toHaveBeenCalledOnce();
      expect(candidateCloses[0]).not.toHaveBeenCalled();
      const disk = new SQL.Database(new Uint8Array(await persisted!.arrayBuffer()));
      try {
        expect(disk.exec('SELECT value FROM marker')[0].values).toEqual([['replacement']]);
        if (method === 'restoreAndMigrate') {
          expect(disk.exec('SELECT MAX(version) FROM schema_migrations')[0].values).toEqual([
            [Math.max(...migrations.map((migration) => migration.version))],
          ]);
        }
      } finally {
        disk.close();
      }
    } finally {
      releaseWrite();
      adapter.close();
    }
  });
});

it('preserves the live database and closes the candidate when backup migration is rejected', async () => {
  const { SQL, adapter, original, candidateCloses } = await restoreFixture();
  const future = new SQL.Database();
  future.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (999999)'
  );
  const bytes = future.export();
  future.close();
  const originalClose = vi.spyOn(original, 'close');
  const write = vi.fn(async (_blob: Blob) => undefined);
  installWriter(write);
  try {
    await expect(adapter.restoreAndMigrate(bytes)).rejects.toMatchObject({
      code: 'DB_NEWER_THAN_APP',
    });
    expect(adapter.exec('SELECT value FROM marker')[0].values).toEqual([['original']]);
    expect(originalClose).not.toHaveBeenCalled();
    expect(candidateCloses[0]).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  } finally {
    adapter.close();
  }
});
