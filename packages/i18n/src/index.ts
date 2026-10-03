export {
  DEFAULT_LOCALE,
  LOCALE_LABEL,
  LOCALES,
  isLocale,
  type Locale,
} from './locale.ts'
export {
  placeholdersOf,
  renderText,
  type TextCatalog,
  type TextEntry,
  type TextParams,
} from './text.ts'
export { webText, type WebTextId } from './web/index.ts'
/** 远端管理页（跑在 4518 上的那个只读控制台）的文案。 */
export { remoteText, type RemoteTextId } from './remote/index.ts'
