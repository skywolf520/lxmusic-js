// 洛雪音源插件 — 歌单处理器
// 翻译自 Go 源码: plugins/songloft-plugin-lxmusic/handlers/songlist.go

import { parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import type { Registry } from '@songloft/musicsdk/dist/index.js';
import { successResponse, errorResponse } from './response';

/**
 * 注册歌单相关路由
 * GET /api/songlist/tags   → 获取标签
 * GET /api/songlist/list   → 获取歌单列表
 * GET /api/songlist/detail → 获取歌单详情
 * GET /api/songlist/search → 搜索歌单
 * GET /api/songlist/sorts  → 获取排序选项
 */
export function registerSonglistHandlers(
  router: Router,
  registry: Registry,
): void {

  // GET /api/songlist/tags — 获取指定平台的歌单标签
  router.get('/api/songlist/tags', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const sourceID = query.source_id;

    if (!sourceID) return errorResponse(400, '缺少 source_id 参数');

    const provider = registry.getSongListProvider(sourceID);
    if (!provider) return errorResponse(400, '不支持的平台: ' + sourceID);

    try {
      const result = await provider.getTags();
      return successResponse(result);
    } catch (e: any) {
      songloft.log.error(`获取歌单标签失败: source_id=${sourceID}, error=${e.message || e}`);
      return errorResponse(500, '获取标签失败: ' + (e.message || String(e)));
    }
  });

  // GET /api/songlist/list — 获取歌单列表
  router.get('/api/songlist/list', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const sourceID = query.source_id;

    if (!sourceID) return errorResponse(400, '缺少 source_id 参数');

    const provider = registry.getSongListProvider(sourceID);
    if (!provider) return errorResponse(400, '不支持的平台: ' + sourceID);

    const sortID = query.sort_id || '';
    const tagID = query.tag_id || '';
    let page = parseInt(query.page, 10);
    if (isNaN(page) || page < 1) page = 1;

    try {
      const result = await provider.getList(sortID, tagID, page);
      return successResponse(result);
    } catch (e: any) {
      songloft.log.error(`获取歌单列表失败: source_id=${sourceID}, error=${e.message || e}`);
      return errorResponse(500, '获取歌单列表失败: ' + (e.message || String(e)));
    }
  });

  // GET /api/songlist/detail — 获取歌单详情
  router.get('/api/songlist/detail', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const sourceID = query.source_id;

    if (!sourceID) return errorResponse(400, '缺少 source_id 参数');

    const provider = registry.getSongListProvider(sourceID);
    if (!provider) return errorResponse(400, '不支持的平台: ' + sourceID);

    const id = query.id;
    if (!id) return errorResponse(400, '缺少 id 参数');

    let page = parseInt(query.page, 10);
    if (isNaN(page) || page < 1) page = 1;

    try {
      const result = await provider.getListDetail(id, page);
      return successResponse(result);
    } catch (e: any) {
      songloft.log.error(`获取歌单详情失败: source_id=${sourceID}, id=${id}, error=${e.message || e}`);
      return errorResponse(500, '获取歌单详情失败: ' + (e.message || String(e)));
    }
  });

  // GET /api/songlist/search — 搜索歌单
  router.get('/api/songlist/search', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const sourceID = query.source_id;

    if (!sourceID) return errorResponse(400, '缺少 source_id 参数');

    const provider = registry.getSongListProvider(sourceID);
    if (!provider) return errorResponse(400, '不支持的平台: ' + sourceID);

    const keyword = query.keyword;
    if (!keyword) return errorResponse(400, '缺少 keyword 参数');

    let page = parseInt(query.page, 10);
    if (isNaN(page) || page < 1) page = 1;

    let limit = parseInt(query.limit, 10);
    if (isNaN(limit) || limit <= 0) limit = 20;

    try {
      const result = await provider.searchSongList(keyword, page, limit);
      return successResponse(result);
    } catch (e: any) {
      songloft.log.error(`搜索歌单失败: source_id=${sourceID}, keyword=${keyword}, error=${e.message || e}`);
      return errorResponse(500, '搜索歌单失败: ' + (e.message || String(e)));
    }
  });

  // GET /api/songlist/sorts — 获取排序选项
  router.get('/api/songlist/sorts', (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const sourceID = query.source_id;

    if (!sourceID) return errorResponse(400, '缺少 source_id 参数');

    const provider = registry.getSongListProvider(sourceID);
    if (!provider) return errorResponse(400, '不支持的平台: ' + sourceID);

    try {
      const sortList = provider.getSortList();
      return successResponse(sortList);
    } catch (e: any) {
      songloft.log.error(`获取排序选项失败: source_id=${sourceID}, error=${e.message || e}`);
      return errorResponse(500, '获取排序选项失败: ' + (e.message || String(e)));
    }
  });
}
