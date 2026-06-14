// 洛雪音源运行时引擎 — SourceRuntime（基于 songloft.jsenv 子环境）
//
// 每个音源在自己的子 QuickJS VM 内运行，与父插件完全隔离。
// 跨音源真并行（通过 RuntimeManager 的 executeParallel 竞速），
// 同音源串行（jsenv 内部 mutex）。
//
// 流程参考 plugins/songloft-plugin-lxmusic/engine/runtime.go：
//   create():  jsenv.create + execute(注入 scriptInfo) + executeWait(脚本, 等 inited)
//   getMusicUrl(): executeWait(lx._dispatch, 等 dispatchResult/dispatchError)

/// <reference types="@songloft/plugin-sdk" />

import type { SongloftJSEnvCall } from '@songloft/plugin-sdk';
import type { SourceConfig, RuntimeStats, ScriptInfo } from './types';
import { LX_PRELUDE_JS } from './lx_prelude';

const JSDOC_PATTERN = /\/\*[!*][\s\S]*?\*\//;
const TAG_PATTERNS: Record<keyof ScriptInfo, RegExp> = {
  name: /@name\s+(.+)/,
  version: /@version\s+(.+)/,
  description: /@description\s+(.+)/,
  author: /@author\s+(.+)/,
  homepage: /@homepage\s+(.+)/,
};

function parseScriptInfo(script: string): ScriptInfo {
  const info: ScriptInfo = { name: '', description: '', version: '', author: '', homepage: '' };
  const match = script.match(JSDOC_PATTERN);
  if (!match) return info;
  const block = match[0];
  for (const [tag, pattern] of Object.entries(TAG_PATTERNS) as Array<[keyof ScriptInfo, RegExp]>) {
    const m = block.match(pattern);
    if (m && m[1]) info[tag] = m[1].trim();
  }
  return info;
}

/** 把任意字符串安全编码成 JS 字符串字面量 */
function jsString(s: string): string {
  return JSON.stringify(s);
}

/** 把 sourceID 转成只含安全字符的 envName 后缀（中文等非 ASCII 编码成 hex） */
function envSafeID(sourceID: string): string {
  // 子 env 命名规则：name 不能含 :: 和 /，本函数额外把所有非字母数字下划线短横线压成 _，
  // 中文字符压成 hex 编码避免极端情况。
  let out = '';
  for (let i = 0; i < sourceID.length; i++) {
    const ch = sourceID.charCodeAt(i);
    if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || ch === 0x5f || ch === 0x2d) {
      out += sourceID[i];
    } else {
      out += '_' + ch.toString(16);
    }
  }
  return out;
}

/** 全局请求 ID 计数器（同进程唯一） */
let reqCounter = 0;
function nextReqID(): string {
  reqCounter++;
  return `req_${reqCounter}`;
}

export class SourceRuntime {
  private envName: string;
  private sourceID: string;
  private config: SourceConfig;
  private stats: RuntimeStats;
  private scriptInfo: ScriptInfo;

  private constructor(envName: string, sourceID: string, config: SourceConfig, scriptInfo: ScriptInfo) {
    this.envName = envName;
    this.sourceID = sourceID;
    this.config = config;
    this.stats = { totalCalls: 0, successCalls: 0 };
    this.scriptInfo = scriptInfo;
  }

  /**
   * 创建并初始化一个音源运行时
   *
   * @param sourceID 音源唯一标识
   * @param script   音源 JS 脚本内容
   * @param _pluginID 兼容签名，已未使用（pluginID 在桥接侧自动绑定）
   * @returns SourceRuntime 实例，失败返回 null
   */
  static async create(sourceID: string, script: string, _pluginID: number): Promise<SourceRuntime | null> {
    const envName = `lx_${envSafeID(sourceID)}`;

    // 1. 创建子 env，注入 lx prelude
    try {
      await songloft.jsenv.create(envName, LX_PRELUDE_JS);
    } catch (e: any) {
      songloft.log.error(`SourceRuntime[${sourceID}]: jsenv.create failed: ${e?.message || e}`);
      return null;
    }

    // 2. 注入脚本元数据
    // rawScript 必须填实际脚本源码：部分音源（如 flower）在初始化阶段会 md5(rawScript)
    // 跟远端 hash 对比做完整性校验，rawScript=""会导致校验失败 → 抛 unhandled rejection →
    // 永远不发 inited 事件 → executeWait 30s 超时。
    const scriptInfo = parseScriptInfo(script);
    const injectCode =
      `globalThis.lx.currentScriptInfo = {` +
      `name:${jsString(scriptInfo.name)},` +
      `description:${jsString(scriptInfo.description)},` +
      `version:${jsString(scriptInfo.version)},` +
      `author:${jsString(scriptInfo.author)},` +
      `homepage:${jsString(scriptInfo.homepage)},` +
      `rawScript:${jsString(script)}};`;

    const inj = await songloft.jsenv.execute(envName, injectCode, 5000);
    if (inj.error) {
      songloft.log.error(`SourceRuntime[${sourceID}]: inject scriptInfo failed: ${inj.error}`);
      await songloft.jsenv.destroy(envName);
      return null;
    }

    // 3. 执行用户脚本，等 inited 事件
    const ev = await songloft.jsenv.executeWait(envName, script, 30000, ['inited']);
    if (ev.error) {
      songloft.log.error(`SourceRuntime[${sourceID}]: script eval failed: ${ev.error}`);
      await songloft.jsenv.destroy(envName);
      return null;
    }

    const initedEvt = ev.events.find(e => e.name === 'inited');
    if (!initedEvt) {
      songloft.log.error(`SourceRuntime[${sourceID}]: script did not call lx.send('inited', ...)`);
      await songloft.jsenv.destroy(envName);
      return null;
    }

    let cfg: SourceConfig | null = null;
    try {
      const parsed = JSON.parse(initedEvt.data);
      // 支持两种结构：{sources: ...} 或直接 SourceConfig
      cfg = parsed && parsed.sources ? { sources: parsed.sources } : (parsed as SourceConfig);
    } catch (e: any) {
      songloft.log.error(`SourceRuntime[${sourceID}]: parse inited data failed: ${e?.message || e}`);
      await songloft.jsenv.destroy(envName);
      return null;
    }

    if (!cfg || !cfg.sources || Object.keys(cfg.sources).length === 0) {
      songloft.log.error(`SourceRuntime[${sourceID}]: inited 中无 sources`);
      await songloft.jsenv.destroy(envName);
      return null;
    }

    songloft.log.info(
      `SourceRuntime[${sourceID}]: created, envName=${envName}, sources=${Object.keys(cfg.sources).length}`
    );

    return new SourceRuntime(envName, sourceID, cfg, scriptInfo);
  }

  /** 检查此音源是否支持某平台 */
  supportsPlatform(platform: string): boolean {
    return platform in this.config.sources;
  }

  /** 检查是否支持某平台的某 action */
  supportsAction(platform: string, action: string): boolean {
    const entry = this.config.sources[platform];
    if (!entry) return false;
    return entry.actions.indexOf(action) >= 0;
  }

  /** 此音源支持的所有平台列表 */
  getSupportedPlatforms(): string[] {
    return Object.keys(this.config.sources);
  }

  /** 单源 getMusicUrl（顺序场景）；并发竞速场景请用 buildDispatchCall + RuntimeManager.executeParallel */
  async getMusicUrl(source: string, quality: string, musicInfo: Record<string, unknown>): Promise<string | null> {
    const { call, reqId } = this.buildDispatchCall(source, quality, musicInfo);
    const r = await songloft.jsenv.executeWait(call.name, call.code, call.timeoutMs ?? 30000, call.waitEvents ?? []);
    if (r.error) {
      songloft.log.warn(`SourceRuntime[${this.sourceID}]: dispatch failed: ${r.error}`);
      return null;
    }
    return SourceRuntime.extractURLFromEvents(r.events, reqId);
  }

  /** 给 RuntimeManager.executeParallel 用的调用描述构造器 */
  buildDispatchCall(
    source: string,
    quality: string,
    musicInfo: Record<string, unknown>
  ): { call: SongloftJSEnvCall; reqId: string } {
    const reqId = nextReqID();
    const payload = JSON.stringify({
      source,
      action: 'musicUrl',
      info: { musicInfo, type: quality },
    });
    const code = `lx._dispatch(${JSON.stringify(reqId)}, "request", ${payload});`;
    return {
      reqId,
      call: {
        name: this.envName,
        code,
        timeoutMs: 30000,
        waitEvents: ['dispatchResult', 'dispatchError'],
      },
    };
  }

  /**
   * 从 events 中提取 dispatchResult / dispatchError 并返回 URL（或 null）
   * 命中规则：data.id === reqId
   */
  static extractURLFromEvents(events: Array<{ name: string; data: string }>, reqId: string): string | null {
    for (const evt of events) {
      let parsed: any;
      try { parsed = JSON.parse(evt.data); } catch { continue; }
      if (!parsed || parsed.id !== reqId) continue;
      if (evt.name === 'dispatchResult') {
        const v = parsed.result;
        if (typeof v === 'string' && v !== '') return v;
        if (v && typeof v === 'object' && typeof v.url === 'string' && v.url !== '') return v.url;
        return null;
      }
      if (evt.name === 'dispatchError') {
        return null;
      }
    }
    return null;
  }

  recordSuccess(): void {
    this.stats.totalCalls++;
    this.stats.successCalls++;
  }

  recordFailure(): void {
    this.stats.totalCalls++;
  }

  successRate(): number {
    if (this.stats.totalCalls === 0) return 0.5;
    return this.stats.successCalls / this.stats.totalCalls;
  }

  getSourceID(): string { return this.sourceID; }
  getConfig(): SourceConfig { return this.config; }
  getScriptInfo(): ScriptInfo { return this.scriptInfo; }
  getStats(): RuntimeStats { return { ...this.stats }; }
  getEnvName(): string { return this.envName; }

  async destroy(): Promise<void> {
    try { await songloft.jsenv.destroy(this.envName); } catch (_) { /* best-effort */ }
    songloft.log.info(`SourceRuntime[${this.sourceID}]: destroyed (envName=${this.envName})`);
  }
}
