// 洛雪音源插件 — 音源管理器
// 从 Go 版 source/manager.go 翻译核心逻辑

import type { SourceInfo } from './types';
import { SourceStorage } from './storage';
import { parseMetadata, inferNameFromFilename, validateJSContent } from './parser';

/**
 * 音源管理器
 * 负责音源的导入、删除、启用/禁用、持久化等操作
 *
 * 注意：构造器只初始化空状态，必须通过 await mgr.init() 加载持久化数据
 *      （songloft.storage.* 现为 Promise，构造器无法 await）。
 */
export class SourceManager {
  private sources: Map<string, SourceInfo>;
  private storage: SourceStorage;

  constructor() {
    this.sources = new Map();
    this.storage = new SourceStorage();
  }

  /** 从存储加载音源索引（onInit 时调用一次） */
  async init(): Promise<void> {
    await this.loadFromStorage();
  }

  /**
   * 从 JS 文件导入音源
   * 如果已存在同名音源，会先删除旧的再导入新的
   * @param filename - 原始文件名
   * @param content - JS 文件内容
   * @param defaultEnabled - 默认是否启用（ZIP 批量导入传 false，由 handler 异步加载成功后再开启）
   * @returns 导入成功的 SourceInfo
   */
  async importFromJS(filename: string, content: string, defaultEnabled: boolean = true): Promise<SourceInfo> {
    // 1. 校验 JS 内容
    if (!validateJSContent(content)) {
      throw new Error('Invalid javascript: empty or invalid content');
    }

    // 2. 解析元数据
    const metadata = parseMetadata(content);

    // 3. 如果没有 @name，从文件名推断
    const name = metadata.name || inferNameFromFilename(filename);

    // 4. 检查是否存在同名音源，如果存在则删除旧的
    const existingID = this.findByName(name);
    if (existingID) {
      songloft.log.info(`发现同名音源，删除旧的: name=${name}, id=${existingID}`);
      await this.deleteSource(existingID);
    }

    // 5. 生成唯一 ID
    const id = this.generateID(name);

    // 6. 创建 SourceInfo
    const info: SourceInfo = {
      id,
      name,
      version: metadata.version || '',
      description: metadata.description || '',
      author: metadata.author || '',
      homepage: metadata.homepage || '',
      filename,
      importedAt: new Date().toISOString(),
      enabled: defaultEnabled,
    };

    // 7. 存入 map
    this.sources.set(id, info);

    // 8. 持久化保存
    await this.storage.saveScript(id, content);
    await this.saveIndex();

    songloft.log.info(`音源导入成功: id=${id}, name=${name}, filename=${filename}`);
    return info;
  }

  /**
   * 从 ZIP 文件导入音源
   * 注意：QuickJS 环境不支持复杂 ZIP 库，此方法由 handler 层预解析后
   * 逐文件调用 importFromJS 实现
   * @param files - 解析后的文件列表 [{filename, content}]
   * @returns 所有成功导入的 SourceInfo 列表
   */
  async importFromZIP(files: Array<{ filename: string; content: string }>): Promise<SourceInfo[]> {
    const imported: SourceInfo[] = [];

    for (const file of files) {
      // 只处理 .js 文件
      if (!file.filename.toLowerCase().endsWith('.js')) {
        continue;
      }

      try {
        // 默认 enabled=false：批量导入逐个加载耗时较长（每源 5-10s），
        // handler 层用 setTimeout 链异步加载，加载成功后再 enableSource。
        const info = await this.importFromJS(file.filename, file.content, false);
        imported.push(info);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        songloft.log.warn(`导入音源失败: filename=${file.filename}, error=${errMsg}`);
      }
    }

    songloft.log.info(`ZIP 导入完成: total=${imported.length}`);
    return imported;
  }

  /**
   * 启用音源
   */
  async enableSource(id: string): Promise<void> {
    const info = this.sources.get(id);
    if (!info) {
      throw new Error(`Source not found: ${id}`);
    }
    if (info.enabled) return; // 已经启用

    info.enabled = true;
    await this.saveIndex();
    songloft.log.info(`音源已启用: id=${id}`);
  }

  /**
   * 禁用音源
   */
  async disableSource(id: string): Promise<void> {
    const info = this.sources.get(id);
    if (!info) {
      throw new Error(`Source not found: ${id}`);
    }
    if (!info.enabled) return; // 已经禁用

    info.enabled = false;
    await this.saveIndex();
    songloft.log.info(`音源已禁用: id=${id}`);
  }

  /**
   * 删除音源
   */
  async deleteSource(id: string): Promise<void> {
    if (!this.sources.has(id)) {
      throw new Error(`Source not found: ${id}`);
    }

    this.sources.delete(id);
    await this.storage.deleteScript(id);
    await this.saveIndex();
    songloft.log.info(`音源已删除: id=${id}`);
  }

  /**
   * 列出所有已导入的音源
   */
  listSources(): SourceInfo[] {
    return Array.from(this.sources.values());
  }

  /**
   * 获取所有已启用的音源
   */
  getEnabledSources(): SourceInfo[] {
    return Array.from(this.sources.values()).filter(s => s.enabled);
  }

  /**
   * 获取音源的 JS 脚本内容
   */
  async getSourceScript(id: string): Promise<string | null> {
    if (!this.sources.has(id)) return null;
    return await this.storage.loadScript(id);
  }

  /**
   * 按 ID 获取音源
   */
  getSource(id: string): SourceInfo | undefined {
    return this.sources.get(id);
  }

  /**
   * 根据名称查找音源 ID
   */
  private findByName(name: string): string | null {
    for (const [id, info] of this.sources) {
      if (info.name === name) return id;
    }
    return null;
  }

  /**
   * 生成唯一 ID
   * 使用 name 的 slug 形式，如果重复则添加计数器后缀
   */
  private generateID(name: string): string {
    let slug = this.toSlug(name);
    if (!slug) slug = 'source';

    // 检查是否已存在
    let id = slug;
    let counter = 1;
    while (this.sources.has(id)) {
      counter++;
      id = `${slug}_${counter}`;
    }

    return id;
  }

  /**
   * 将名称转换为 slug 形式
   * 例如: "My Source" -> "my-source", "网易云" -> "网易云"
   */
  private toSlug(name: string): string {
    let slug = name.toLowerCase();
    slug = slug.replace(/ /g, '-');
    // 移除特殊字符（保留字母、数字、横线、下划线、中文字符）
    let result = '';
    for (const ch of slug) {
      const code = ch.charCodeAt(0);
      if (
        (code >= 97 && code <= 122) || // a-z
        (code >= 48 && code <= 57) ||  // 0-9
        code === 45 || // -
        code === 95 || // _
        code >= 0x4e00 // CJK characters
      ) {
        result += ch;
      }
    }
    return result;
  }

  /**
   * 从存储加载已持久化的音源索引
   */
  private async loadFromStorage(): Promise<void> {
    const sources = await this.storage.loadIndex();
    for (const info of sources) {
      this.sources.set(info.id, info);
    }
    if (sources.length > 0) {
      songloft.log.info(`已从存储加载音源: count=${sources.length}`);
    }
  }

  /**
   * 保存音源索引到存储
   */
  private async saveIndex(): Promise<void> {
    const sources = Array.from(this.sources.values());
    await this.storage.saveIndex(sources);
  }
}

