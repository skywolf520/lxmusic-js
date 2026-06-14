// 洛雪音源插件 — JSDoc 元数据解析
// 从 Go 版 source/parser.go 翻译

import type { SourceMetadata } from './types';

// JSDoc 注释块正则: 匹配 /** ... */ 或 /*! ... */
const JSDOC_PATTERN = /\/\*[!*][\s\S]*?\*\//;

/** 各标签的正则表达式 */
const TAG_PATTERNS: Record<keyof SourceMetadata, RegExp> = {
  name: /@name\s+(.+)/,
  version: /@version\s+(.+)/,
  description: /@description\s+(.+)/,
  author: /@author\s+(.+)/,
  homepage: /@homepage\s+(.+)/,
};

/**
 * 解析 JS 文件头部的 JSDoc 注释块，提取元数据
 * @param content - JS 文件内容
 * @returns 解析出的元数据（可能部分字段为空）
 */
export function parseMetadata(content: string): Partial<SourceMetadata> {
  const metadata: Partial<SourceMetadata> = {};

  // 查找第一个 JSDoc 注释块
  const match = content.match(JSDOC_PATTERN);
  if (!match) {
    // 没有找到 JSDoc 注释块，返回空元数据
    return metadata;
  }

  const block = match[0];

  // 解析各标签
  for (const [tag, pattern] of Object.entries(TAG_PATTERNS) as Array<[keyof SourceMetadata, RegExp]>) {
    const m = block.match(pattern);
    if (m && m[1]) {
      metadata[tag] = m[1].trim();
    }
  }

  return metadata;
}

/**
 * 从文件名推断音源名称
 * 例如: "netease.js" -> "netease", "qq-music.js" -> "qq-music"
 */
export function inferNameFromFilename(filename: string): string {
  // 去除扩展名
  let name = filename.replace(/\.js$/i, '');
  // 去除路径，只保留文件名
  const slashIdx = name.lastIndexOf('/');
  if (slashIdx >= 0) {
    name = name.slice(slashIdx + 1);
  }
  return name;
}

/**
 * 验证 JS 文件内容是否合法
 * 检查内容不为空且是合法文本
 */
export function validateJSContent(content: string): boolean {
  // 检查内容不为空
  if (!content || content.trim().length === 0) {
    return false;
  }
  return true;
}
