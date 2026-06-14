// 洛雪音源插件 — 设置 API 处理器
// GET  /api/config — 读取当前配置
// POST /api/config — 更新配置（部分更新）

/// <reference types="@songloft/plugin-sdk" />

import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { getConfig, saveConfig, type LxMusicConfig } from '../config';
import { successResponse, errorResponse } from './response';

/** 解析请求体 */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

const VALID_PLATFORMS = ['kg', 'kw', 'tx', 'wy', 'mg'];
const VALID_QUALITIES = ['128k', '320k', 'flac'];

export function registerSettingsHandlers(router: Router): void {

  // GET /api/config — 读取当前配置
  router.get('/api/config', async () => {
    const config = await getConfig();
    return successResponse(config);
  });

  // POST /api/config — 更新配置（部分更新，只覆盖传入的字段）
  router.post('/api/config', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const current = await getConfig();

    // 合并 defaultPlatforms
    if (body.defaultPlatforms !== undefined) {
      if (!Array.isArray(body.defaultPlatforms)) {
        return errorResponse(400, 'defaultPlatforms 必须是数组');
      }
      const filtered = body.defaultPlatforms.filter((p: string) => VALID_PLATFORMS.includes(p));
      if (filtered.length === 0) {
        return errorResponse(400, '至少选择一个有效平台');
      }
      current.defaultPlatforms = filtered;
    }

    // 合并 defaultQuality
    if (body.defaultQuality !== undefined) {
      const q = String(body.defaultQuality).trim();
      if (!VALID_QUALITIES.includes(q)) {
        return errorResponse(400, `无效的音质值，可选: ${VALID_QUALITIES.join(', ')}`);
      }
      current.defaultQuality = q;
    }

    await saveConfig(current);
    songloft.log.info(`配置已更新: platforms=${current.defaultPlatforms.join(',')}, quality=${current.defaultQuality}`);
    return successResponse(current);
  });
}
