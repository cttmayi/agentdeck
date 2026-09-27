/**
 * `@agentdeck/store-sqlite` —— `Store` 端口的 SQLite 实现（v2）。
 *
 * 与 `@agentdeck/store-file` 是**同一端口的两套实现**：领域层只认识
 * `@agentdeck/domain` 里的 `Store` 接口，不知道底下是文件还是数据库。
 *
 * 选择它的理由：单文件、事务原子性、内容寻址之外的并发安全都由 SQLite
 * 承担（`node:sqlite` 是 Node 内置模块，不引入任何第三方依赖）。
 */

export {
  SqliteStore,
  openSqliteStore,
  sqliteStorePath,
  SQLITE_FILE_NAME,
  SQLITE_STORE_FORMAT_VERSION,
  type SqliteStoreOptions,
} from './sqlite-store.ts'
