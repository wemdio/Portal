import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface FnsExactApplyTarget {
  host: string;
  port: number;
  database: string;
  table: string;
}

export interface FnsExactApplyCheckpoint {
  version: 1;
  planFingerprint: string;
  expectedPreviewFingerprint: string;
  target: FnsExactApplyTarget;
  pageSize: number;
  cursorId: string | null;
  committedRows: number;
}

export interface FnsExactApplyCheckpointStore {
  load(): Promise<FnsExactApplyCheckpoint | null>;
  save(checkpoint: FnsExactApplyCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

function isErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function parseCheckpoint(value: unknown): FnsExactApplyCheckpoint {
  if (!isRecord(value)) {
    throw new Error('checkpoint must be a JSON object');
  }

  if (value.version !== 1) {
    throw new Error('version must equal 1');
  }

  requireNonEmptyString(value.planFingerprint, 'planFingerprint');
  requireNonEmptyString(
    value.expectedPreviewFingerprint,
    'expectedPreviewFingerprint',
  );

  if (!isRecord(value.target)) {
    throw new Error('target must be a JSON object');
  }

  requireNonEmptyString(value.target.host, 'target.host');
  if (
    !Number.isInteger(value.target.port)
    || (value.target.port as number) < 1
    || (value.target.port as number) > 65_535
  ) {
    throw new Error('target.port must be an integer between 1 and 65535');
  }
  requireNonEmptyString(value.target.database, 'target.database');
  requireNonEmptyString(value.target.table, 'target.table');

  if (!Number.isSafeInteger(value.pageSize) || (value.pageSize as number) < 1) {
    throw new Error('pageSize must be a positive integer');
  }

  if (
    value.cursorId !== null
    && (
      typeof value.cursorId !== 'string'
      || !/^(0|[1-9]\d*)$/.test(value.cursorId)
    )
  ) {
    throw new Error('cursorId must be null or a non-negative integer string');
  }

  if (
    !Number.isSafeInteger(value.committedRows)
    || (value.committedRows as number) < 0
  ) {
    throw new Error('committedRows must be a non-negative integer');
  }

  return {
    version: 1,
    planFingerprint: value.planFingerprint,
    expectedPreviewFingerprint: value.expectedPreviewFingerprint,
    target: {
      host: value.target.host,
      port: value.target.port as number,
      database: value.target.database,
      table: value.target.table,
    },
    pageSize: value.pageSize as number,
    cursorId: value.cursorId,
    committedRows: value.committedRows as number,
  };
}

export class FileFnsExactApplyCheckpointStore
implements FnsExactApplyCheckpointStore {
  private readonly checkpointPath: string;

  constructor(checkpointPath: string) {
    if (typeof checkpointPath !== 'string' || checkpointPath.trim() === '') {
      throw new Error('Checkpoint path must be a non-empty string');
    }

    this.checkpointPath = resolve(checkpointPath);
  }

  async load(): Promise<FnsExactApplyCheckpoint | null> {
    let checkpointJson: string;
    try {
      checkpointJson = await readFile(this.checkpointPath, 'utf8');
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }

    try {
      return parseCheckpoint(JSON.parse(checkpointJson) as unknown);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid FNS exact apply checkpoint at "${this.checkpointPath}": ${detail}`,
        { cause: error },
      );
    }
  }

  async save(checkpoint: FnsExactApplyCheckpoint): Promise<void> {
    const validatedCheckpoint = parseCheckpoint(checkpoint);
    const parentDirectory = dirname(this.checkpointPath);
    await mkdir(parentDirectory, { recursive: true });

    const tempPath = join(
      parentDirectory,
      `.${basename(this.checkpointPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let tempHandle: FileHandle | null = null;
    let movedIntoPlace = false;

    try {
      tempHandle = await open(tempPath, 'wx', 0o600);
      await tempHandle.writeFile(
        `${JSON.stringify(validatedCheckpoint, null, 2)}\n`,
        'utf8',
      );
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = null;

      await this.renameTempFile(tempPath, this.checkpointPath);
      movedIntoPlace = true;
    } catch (error) {
      const cleanupErrors: unknown[] = [];

      if (tempHandle !== null) {
        try {
          await tempHandle.close();
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }

      if (!movedIntoPlace) {
        try {
          await unlink(tempPath);
        } catch (unlinkError) {
          if (!isErrorWithCode(unlinkError, 'ENOENT')) {
            cleanupErrors.push(unlinkError);
          }
        }
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Failed to save FNS exact apply checkpoint at "${this.checkpointPath}" and clean up its temp file`,
        );
      }

      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.checkpointPath);
    } catch (error) {
      if (!isErrorWithCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  protected async renameTempFile(
    tempPath: string,
    checkpointPath: string,
  ): Promise<void> {
    await rename(tempPath, checkpointPath);
  }
}
