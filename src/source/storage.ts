// 洛雪音源插件 — 音源存储
// 基于 songloft.storage 持久化，从 Go 版 source/storage.go 翻译

/// <reference types="@songloft/plugin-sdk" />

import type { SourceInfo, SourceIndex } from './types';

const INDEX_KEY = 'source_index';
const SCRIPT_KEY_PREFIX = 'source_script_';

/**
 * 音源存储
 * 使用 songloft.storage 进行持久化
 * - 脚本存储: key = `source_script_{id}`
 * - 索引存储: key = `source_index`
 *
 * 注意：所有方法均为 async（songloft.storage.* 现为 Promise 返回）。
 */
export class SourceStorage {
  /**
   * 保存 JS 脚本内容
   */
  async saveScript(id: string, content: string): Promise<void> {
    await songloft.storage.set(SCRIPT_KEY_PREFIX + id, content);
  }

  /**
   * 加载 JS 脚本内容
   */
  async loadScript(id: string): Promise<string | null> {
    const data = await songloft.storage.get(SCRIPT_KEY_PREFIX + id);
    if (typeof data === 'string') return data;
    return null;
  }

  /**
   * 删除 JS 脚本
   */
  async deleteScript(id: string): Promise<void> {
    await songloft.storage.delete(SCRIPT_KEY_PREFIX + id);
  }

  /**
   * 保存音源索引
   */
  async saveIndex(sources: SourceInfo[]): Promise<void> {
    const index: SourceIndex = {
      version: '1.0',
      sources,
    };
    await songloft.storage.set(INDEX_KEY, index);
  }

  /**
   * 加载音源索引，不存在返回空列表
   */
  async loadIndex(): Promise<SourceInfo[]> {
    const raw = (await songloft.storage.get(INDEX_KEY)) as SourceIndex | null;
    if (!raw || !raw.sources) return [];
    return raw.sources;
  }
}
