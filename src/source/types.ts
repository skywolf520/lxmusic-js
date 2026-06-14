// 洛雪音源插件 — 音源类型定义

/** 音源信息 */
export interface SourceInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  filename: string;
  importedAt: string;
  enabled: boolean;
}

/** 从 JS 文件头部 JSDoc 解析的元数据 */
export interface SourceMetadata {
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
}

/** 音源索引（用于持久化） */
export interface SourceIndex {
  version: string;
  sources: SourceInfo[];
}

/** 音源配置 */
export interface SourceConfig {
  sources: Record<string, SourceEntry>;
}

/** 音源条目 */
export interface SourceEntry {
  name: string;
  type: string;
  actions: string[];
  qualitys: string[];
}
