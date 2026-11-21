/**
 * `@agentdeck/store-file` —— `Store` 端口的文件存储实现（v1）。
 *
 * 这是**适配器**：领域层只认识 `@agentdeck/domain` 里的 `Store` 接口，
 * 不知道底下是文件还是数据库。换存储实现时，只有本包需要重写。
 */

export {
  FileStore,
  openFileStore,
  STORE_FORMAT_VERSION,
  type CompactionReport,
  type LogStorageReport,
  type FileStoreOptions,
} from './file-store.ts'
export { JsonlLog, type LogEntry } from './log.ts'
export {
  MIGRATIONS,
  MigrationLedger,
  migrationsPath,
  type MigrationKey,
  type MigrationRecord,
  type MigrationSpec,
} from './migrations.ts'
/** D228：`owner.kind === 'agent'` 那一种独有技能的目录（装配处要用它拼解析函数）。 */
export { agentExclusiveSkillsDir } from './agent-dirs.ts'
export { BlobStore } from './blobs.ts'
export { MessageLog } from './messages.ts'
export { acquireLock, LockHeldError, lockPath, type LockInfo } from './lock.ts'
export { Mutex, pruneUndefined } from './mutex.ts'
export {
  AppendHandle,
  atomicWrite,
  ensureDir,
  readBytesOrNull,
  readJsonOrNull,
  sha256Hex,
} from './fs-utils.ts'
