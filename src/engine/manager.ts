// 洛雪音源运行时引擎 — RuntimeManager
// 从 Go 版 plugins/songloft-plugin-lxmusic/engine/manager.go 翻译
// 管理多个 SourceRuntime，支持按平台索引和按成功率顺序尝试获取 URL

/// <reference types="@songloft/plugin-sdk" />

import { SourceRuntime } from './runtime';

/**
 * RuntimeManager — 管理所有已加载的音源运行时
 *
 * 功能：
 * - 加载/卸载/重载音源
 * - 按平台维护反向索引（快速查找支持特定平台的音源）
 * - 按成功率排序，顺序尝试多个音源获取播放 URL
 */
export class RuntimeManager {
  /** sourceID → SourceRuntime */
  private runtimes: Map<string, SourceRuntime>;
  /** platform → 支持该平台的 runtime 列表 */
  private platformIndex: Map<string, SourceRuntime[]>;

  constructor() {
    this.runtimes = new Map();
    this.platformIndex = new Map();
  }

  /**
   * 加载音源运行时
   * 如果已存在同 ID 的音源，先卸载旧的再加载新的
   *
   * @param sourceID - 音源唯一标识
   * @param script - 音源 JS 脚本内容
   * @param pluginID - 插件 ID
   * @returns 是否加载成功
   */
  async loadSource(sourceID: string, script: string, pluginID: number): Promise<boolean> {
    // 如果已存在，先卸载
    if (this.runtimes.has(sourceID)) {
      await this.unloadSource(sourceID);
    }

    const runtime = await SourceRuntime.create(sourceID, script, pluginID);
    if (!runtime) {
      songloft.log.error(`RuntimeManager: failed to load source: ${sourceID}`);
      return false;
    }

    this.runtimes.set(sourceID, runtime);
    this.addToPlatformIndex(runtime);
    songloft.log.info(`RuntimeManager: source loaded: ${sourceID}`);
    return true;
  }

  /**
   * 卸载音源运行时
   */
  async unloadSource(sourceID: string): Promise<void> {
    const runtime = this.runtimes.get(sourceID);
    if (!runtime) return;

    this.removeFromPlatformIndex(runtime);
    await runtime.destroy();
    this.runtimes.delete(sourceID);
    songloft.log.info(`RuntimeManager: source unloaded: ${sourceID}`);
  }

  /**
   * 重新加载音源
   */
  async reloadSource(sourceID: string, script: string, pluginID: number): Promise<boolean> {
    await this.unloadSource(sourceID);
    return await this.loadSource(sourceID, script, pluginID);
  }

  /**
   * 获取播放 URL（多源顺序尝试）
   *
   * Go 版使用 ExecuteJSParallel 并行获取，JS 单线程环境改为：
   * 1. 从 platformIndex 获取支持该平台的 runtime 列表
   * 2. 按 successRate() 降序排序
   * 3. 依次尝试每个 runtime 获取 URL
   * 4. 记录成功/失败统计
   * 5. 返回首个成功结果
   *
   * @param platform - 来源平台（如 "kw", "tx", "wy"）
   * @param quality - 音质（如 "128k", "320k", "flac"）
   * @param musicInfo - 歌曲信息
   * @returns 播放 URL，全部失败返回 null
   */
  async getMusicUrl(platform: string, quality: string, musicInfo: Record<string, unknown>): Promise<string | null> {
    if (this.runtimes.size === 0) {
      songloft.log.warn('RuntimeManager.getMusicUrl: no source loaded');
      return null;
    }

    const candidates = this.platformIndex.get(platform);
    if (!candidates || candidates.length === 0) {
      songloft.log.warn(`RuntimeManager.getMusicUrl: platform not supported: ${platform}`);
      return null;
    }

    // 按成功率降序排序（创建副本避免修改原数组）
    const sorted = candidates.slice().sort((a, b) => b.successRate() - a.successRate());

    songloft.log.info(
      `RuntimeManager.getMusicUrl: trying ${sorted.length} sources for platform=${platform} quality=${quality} (parallel=3)`
    );

    // 组装并行调用：每个候选 runtime 一个 ParallelCall + 配套 reqId
    const calls = [];
    const reqIds: string[] = [];
    for (const runtime of sorted) {
      const { call, reqId } = runtime.buildDispatchCall(platform, quality, musicInfo);
      calls.push(call);
      reqIds.push(reqId);
    }

    const par = await songloft.jsenv.executeParallel(calls, 3);
    const idx = par.successIndex;

    if (idx < 0 || idx >= sorted.length) {
      // 全部失败
      for (const r of sorted) r.recordFailure();
      const errPreview = (par.errors && par.errors.length > 0) ? par.errors.join(' | ') : 'no result';
      songloft.log.warn(
        `RuntimeManager.getMusicUrl: all ${sorted.length} sources failed for platform=${platform}: ${errPreview}`
      );
      return null;
    }

    // 胜出者：从 result.events 找 dispatchResult.id === reqIds[idx]
    const winner = sorted[idx];
    const events = par.result?.events ?? [];
    const url = SourceRuntime.extractURLFromEvents(events, reqIds[idx]);

    if (url) {
      winner.recordSuccess();
      // 其余记失败（参与了竞速但没胜出）
      for (let i = 0; i < sorted.length; i++) {
        if (i !== idx) sorted[i].recordFailure();
      }
      songloft.log.info(
        `RuntimeManager.getMusicUrl: success from source=${winner.getSourceID()} (index=${idx})`
      );
      return url;
    }

    // executeParallel 返回成功但没拿到匹配的 dispatchResult — 当作失败
    for (const r of sorted) r.recordFailure();
    songloft.log.warn(
      `RuntimeManager.getMusicUrl: parallel returned successIndex=${idx} but no matching dispatchResult`
    );
    return null;
  }

  /**
   * 获取指定音源支持的平台列表
   */
  getSourcePlatforms(sourceID: string): string[] {
    const runtime = this.runtimes.get(sourceID);
    if (!runtime) return [];
    return runtime.getSupportedPlatforms();
  }

  /**
   * 获取指定运行时
   */
  getRuntime(sourceID: string): SourceRuntime | undefined {
    return this.runtimes.get(sourceID);
  }

  /**
   * 检查某音源是否已加载
   */
  isLoaded(sourceID: string): boolean {
    return this.runtimes.has(sourceID);
  }

  /**
   * 返回所有已加载的音源 ID 列表
   */
  loadedSources(): string[] {
    return Array.from(this.runtimes.keys());
  }

  /**
   * 返回已加载的音源数量
   */
  count(): number {
    return this.runtimes.size;
  }

  /**
   * 获取所有支持的平台列表
   */
  getSupportedPlatforms(): string[] {
    return Array.from(this.platformIndex.keys());
  }

  /**
   * 关闭所有运行时
   */
  async close(): Promise<void> {
    for (const [id, runtime] of this.runtimes) {
      await runtime.destroy();
      this.runtimes.delete(id);
    }
    this.platformIndex.clear();
    songloft.log.info('RuntimeManager: all runtimes closed');
  }

  // --- 内部方法 ---

  /**
   * 将 runtime 添加到其支持的所有平台索引中
   */
  private addToPlatformIndex(runtime: SourceRuntime): void {
    const platforms = runtime.getSupportedPlatforms();
    for (const platform of platforms) {
      const list = this.platformIndex.get(platform) || [];
      list.push(runtime);
      this.platformIndex.set(platform, list);
    }
  }

  /**
   * 从所有平台索引中移除指定 runtime
   */
  private removeFromPlatformIndex(runtime: SourceRuntime): void {
    const platforms = runtime.getSupportedPlatforms();
    for (const platform of platforms) {
      const list = this.platformIndex.get(platform);
      if (!list) continue;

      const idx = list.findIndex(r => r.getSourceID() === runtime.getSourceID());
      if (idx >= 0) {
        list.splice(idx, 1);
      }

      if (list.length === 0) {
        this.platformIndex.delete(platform);
      }
    }
  }
}
