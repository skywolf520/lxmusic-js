// 洛雪音源插件 — 音源管理处理器
// 翻译自 Go 源码: plugins/songloft-plugin-lxmusic/handlers/source.go

import { parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import type { SourceManager } from '../source/manager';
import type { RuntimeManager } from '../engine/manager';
// 直接使用 globalThis.fetch（真异步），不再依赖 utils/http 中已删除的 fetchSync。
import { successResponse, successWithWarning, errorResponse } from './response';

/** 解析请求体（兼容 Uint8Array 和 string） */
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

/** 运行时加载失败的统一警告文案 */
const LOAD_WARN_MSG = "音源已保存，但运行时加载失败: 脚本可能未调用 lx.send('inited', ...) 或初始化使用了不支持的异步模式";

/** 获取 body 原始字符串 */
function getBodyString(req: HTTPRequest): string {
  if (!req.body) return '';
  if (typeof req.body === 'string') return req.body;
  // Uint8Array → string（分块避免栈溢出）
  const arr = req.body as Uint8Array;
  const chunkSize = 8192;
  let result = '';
  for (let i = 0; i < arr.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, arr.length);
    const chunk = arr.subarray(i, end);
    result += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return result;
}

/** case-insensitive header 查找 */
function getHeader(headers: Record<string, string>, name: string): string {
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return '';
}

/**
 * latin1 字节串 → UTF-8 文本。
 *
 * 为什么需要：multipart body 和 ZIP 文件名里的字节都是 UTF-8 编码的中文，
 * 但 getBodyString / extractZipJSFiles 把字节用 String.fromCharCode 拼成 latin1 字符串
 * （这是 multipart/ZIP 解析必须的——按字节匹配 boundary、charCodeAt 取头部字段）。
 * 所以拿到的 filename 是 latin1 字符串，需要把每个字符的 charCode（其实就是原字节）
 * 重新按 UTF-8 解码才能正确显示中文。
 */
function latin1ToUtf8(s: string): string {
  if (!s) return s;
  // 全 ASCII 时直接返回
  let allAscii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) { allAscii = false; break; }
  }
  if (allAscii) return s;
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return s; // 解码失败则保留原样，避免把上传的纯 latin1 文件名丢失
  }
}

/**
 * macOS 自带打包的 zip 会包含 __MACOSX/ 元数据目录和 ._xxx AppleDouble 文件，
 * 这些不是真音源，跳过避免误导入。
 */
function isMacOSXMetadata(filename: string): boolean {
  if (!filename) return true;
  if (filename.indexOf('__MACOSX/') >= 0) return true;
  // ._xxx 是 AppleDouble resource fork
  const base = filename.split('/').pop() || filename;
  if (base.startsWith('._')) return true;
  // .DS_Store
  if (base === '.DS_Store') return true;
  return false;
}

/** 从 multipart form data 中提取上传的文件 */
function parseMultipartFile(body: string, boundary: string): { filename: string; content: string } | null {
  const delimiter = '--' + boundary;

  const parts = body.split(delimiter);
  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue;

    // 查找 header/body 分隔符
    const sepIdx = part.indexOf('\r\n\r\n');
    if (sepIdx === -1) continue;

    const headers = part.substring(0, sepIdx);
    let content = part.substring(sepIdx + 4);

    // 移除末尾 CRLF
    if (content.endsWith('\r\n')) {
      content = content.slice(0, -2);
    }

    // 提取 filename。注意 content 也是 latin1 字节串（每字符 = 1 UTF-8 字节）：
    // 对单文件 .js 上传需 latin1ToUtf8 让 parseMetadata 拿到正确中文；
    // 对 .zip 上传保持 latin1，因为 ZIP 解析按字节读取 header（charCodeAt）。
    const match = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    if (match && match[2]) {
      const filename = latin1ToUtf8(match[2]);
      const decoded = filename.toLowerCase().endsWith('.zip') ? content : latin1ToUtf8(content);
      return { filename, content: decoded };
    }
  }

  return null;
}

/**
 * ZIP 解析器（支持 STORE 和 DEFLATE，兼容 data descriptor）
 * 通过 Central Directory 解析，避免 data descriptor 导致 compressedSize=0 的问题。
 * 从 ZIP 内容中提取所有 .js 文件
 */
function extractZipJSFiles(content: string): Array<{ filename: string; content: string }> {
  const files: Array<{ filename: string; content: string }> = [];
  const len = content.length;

  // 1. 查找 End of Central Directory Record (EOCD)
  //    签名: PK\x05\x06 (0x06054b50)，位于文件末尾附近（最多 65535+22 字节的注释）
  let eocdOffset = -1;
  const searchStart = Math.max(0, len - 65557); // 22(EOCD min size) + 65535(max comment)
  for (let i = len - 22; i >= searchStart; i--) {
    if (content.charCodeAt(i) === 0x50 && content.charCodeAt(i + 1) === 0x4b &&
        content.charCodeAt(i + 2) === 0x05 && content.charCodeAt(i + 3) === 0x06) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    songloft.log.warn('ZIP 解析: 未找到 End of Central Directory Record');
    // Fallback: 尝试从 local file headers 解析（兼容简单 ZIP）
    return extractZipJSFilesFromLocal(content);
  }

  // 2. 解析 EOCD
  const cdEntries = content.charCodeAt(eocdOffset + 10) | (content.charCodeAt(eocdOffset + 11) << 8);
  const cdSize = content.charCodeAt(eocdOffset + 12) | (content.charCodeAt(eocdOffset + 13) << 8) |
                 (content.charCodeAt(eocdOffset + 14) << 16) | ((content.charCodeAt(eocdOffset + 15) << 24) >>> 0);
  const cdOffset = content.charCodeAt(eocdOffset + 16) | (content.charCodeAt(eocdOffset + 17) << 8) |
                   (content.charCodeAt(eocdOffset + 18) << 16) | ((content.charCodeAt(eocdOffset + 19) << 24) >>> 0);

  songloft.log.info(`ZIP EOCD: entries=${cdEntries}, cdSize=${cdSize}, cdOffset=${cdOffset}, fileLen=${len}`);

  if (cdOffset + cdSize > len) {
    songloft.log.warn('ZIP 解析: Central Directory 偏移超出文件范围');
    return extractZipJSFilesFromLocal(content);
  }

  // 3. 遍历 Central Directory 条目
  let offset = cdOffset;
  for (let entry = 0; entry < cdEntries && offset + 46 <= len; entry++) {
    // Central Directory entry 签名: PK\x01\x02
    if (content.charCodeAt(offset) !== 0x50 || content.charCodeAt(offset + 1) !== 0x4b ||
        content.charCodeAt(offset + 2) !== 0x01 || content.charCodeAt(offset + 3) !== 0x02) {
      songloft.log.warn(`ZIP 解析: Central Directory 条目 #${entry} 签名无效 @offset=${offset}`);
      break;
    }

    const compressionMethod = content.charCodeAt(offset + 10) | (content.charCodeAt(offset + 11) << 8);
    const compressedSize = content.charCodeAt(offset + 20) | (content.charCodeAt(offset + 21) << 8) |
                           (content.charCodeAt(offset + 22) << 16) | ((content.charCodeAt(offset + 23) << 24) >>> 0);
    const filenameLength = content.charCodeAt(offset + 28) | (content.charCodeAt(offset + 29) << 8);
    const extraFieldLength = content.charCodeAt(offset + 30) | (content.charCodeAt(offset + 31) << 8);
    const commentLength = content.charCodeAt(offset + 32) | (content.charCodeAt(offset + 33) << 8);
    const localHeaderOffset = content.charCodeAt(offset + 42) | (content.charCodeAt(offset + 43) << 8) |
                              (content.charCodeAt(offset + 44) << 16) | ((content.charCodeAt(offset + 45) << 24) >>> 0);

    const rawFilename = content.substring(offset + 46, offset + 46 + filenameLength);
    const filename = latin1ToUtf8(rawFilename);

    // 跳过目录条目、macOS 元数据 (__MACOSX/, ._xxx, .DS_Store) 和非 .js
    const isDir = filename.endsWith('/');
    const isMeta = isMacOSXMetadata(filename);
    const isJS = filename.toLowerCase().endsWith('.js');

    if (isDir || isMeta || !isJS || compressedSize <= 0) {
      // 下一个 Central Directory 条目
      offset += 46 + filenameLength + extraFieldLength + commentLength;
      continue;
    }

    songloft.log.info(`ZIP entry #${entry}: "${filename}" method=${compressionMethod} compSize=${compressedSize}`);

    // 从 local file header 获取实际数据偏移（需要读取 local header 的 filename 和 extra 长度）
    if (localHeaderOffset + 30 <= len) {
      const localFilenameLen = content.charCodeAt(localHeaderOffset + 26) | (content.charCodeAt(localHeaderOffset + 27) << 8);
      const localExtraLen = content.charCodeAt(localHeaderOffset + 28) | (content.charCodeAt(localHeaderOffset + 29) << 8);
      const dataOffset = localHeaderOffset + 30 + localFilenameLen + localExtraLen;

      if (dataOffset + compressedSize <= len) {
        if (compressionMethod === 0) {
          // STORE — fileContent 是 latin1 字节串（每个字符 = 1 UTF-8 字节），
          // 转 UTF-8 再交给下游 parseMetadata，避免 @name 等字段被双重编码。
          const rawContent = content.substring(dataOffset, dataOffset + compressedSize);
          const fileContent = latin1ToUtf8(rawContent);
          files.push({ filename: filename.split('/').pop() || filename, content: fileContent });
        } else if (compressionMethod === 8) {
          // DEFLATE
          let dataHex = '';
          for (let i = dataOffset; i < dataOffset + compressedSize; i++) {
            const byte = content.charCodeAt(i);
            dataHex += (byte < 16 ? '0' : '') + byte.toString(16);
          }
          const resultHex = __go_raw_inflate(dataHex);
          if (resultHex) {
            let rawContent = '';
            for (let i = 0; i < resultHex.length; i += 2) {
              rawContent += String.fromCharCode(parseInt(resultHex.substring(i, i + 2), 16));
            }
            const fileContent = latin1ToUtf8(rawContent);
            files.push({ filename: filename.split('/').pop() || filename, content: fileContent });
          } else {
            songloft.log.warn(`ZIP 解析: "${filename}" DEFLATE 解压失败`);
          }
        } else {
          songloft.log.warn(`ZIP 解析: "${filename}" 使用不支持的压缩(method=${compressionMethod})，跳过`);
        }
      } else {
        songloft.log.warn(`ZIP 解析: "${filename}" 数据超出文件范围`);
      }
    }

    // 下一个 Central Directory 条目
    offset += 46 + filenameLength + extraFieldLength + commentLength;
  }

  return files;
}

/**
 * Fallback: 从 Local File Headers 解析 ZIP（不支持 data descriptor）
 */
function extractZipJSFilesFromLocal(content: string): Array<{ filename: string; content: string }> {
  const files: Array<{ filename: string; content: string }> = [];
  let offset = 0;

  while (offset + 30 <= content.length) {
    if (content.charCodeAt(offset) !== 0x50 || content.charCodeAt(offset + 1) !== 0x4b ||
        content.charCodeAt(offset + 2) !== 0x03 || content.charCodeAt(offset + 3) !== 0x04) {
      break;
    }

    const compressionMethod = content.charCodeAt(offset + 8) | (content.charCodeAt(offset + 9) << 8);
    const compressedSize = content.charCodeAt(offset + 18) | (content.charCodeAt(offset + 19) << 8) |
                           (content.charCodeAt(offset + 20) << 16) | ((content.charCodeAt(offset + 21) << 24) >>> 0);
    const filenameLength = content.charCodeAt(offset + 26) | (content.charCodeAt(offset + 27) << 8);
    const extraFieldLength = content.charCodeAt(offset + 28) | (content.charCodeAt(offset + 29) << 8);

    const rawFilename = content.substring(offset + 30, offset + 30 + filenameLength);
    const filename = latin1ToUtf8(rawFilename);
    const dataOffset = offset + 30 + filenameLength + extraFieldLength;

    const isDir = filename.endsWith('/');
    const isMeta = isMacOSXMetadata(filename);
    const isJS = filename.toLowerCase().endsWith('.js');

    if (!isDir && !isMeta && isJS && compressedSize > 0) {
      songloft.log.info(`ZIP local entry: "${filename}" method=${compressionMethod} compSize=${compressedSize}`);

      if (compressionMethod === 0) {
        // STORE — 转 UTF-8（理由同 extractZipJSFiles）
        const rawContent = content.substring(dataOffset, dataOffset + compressedSize);
        const fileContent = latin1ToUtf8(rawContent);
        files.push({ filename: filename.split('/').pop() || filename, content: fileContent });
      } else if (compressionMethod === 8) {
        let dataHex = '';
        for (let i = dataOffset; i < dataOffset + compressedSize; i++) {
          const byte = content.charCodeAt(i);
          dataHex += (byte < 16 ? '0' : '') + byte.toString(16);
        }
        const resultHex = __go_raw_inflate(dataHex);
        if (resultHex) {
          let rawContent = '';
          for (let i = 0; i < resultHex.length; i += 2) {
            rawContent += String.fromCharCode(parseInt(resultHex.substring(i, i + 2), 16));
          }
          const fileContent = latin1ToUtf8(rawContent);
          files.push({ filename: filename.split('/').pop() || filename, content: fileContent });
        } else {
          songloft.log.warn(`ZIP 解析: "${filename}" DEFLATE 解压失败`);
        }
      } else {
        songloft.log.warn(`ZIP 解析: "${filename}" 使用不支持的压缩(method=${compressionMethod})，跳过`);
      }
    }

    offset = dataOffset + compressedSize;
  }

  return files;
}

/**
 * 注册音源管理相关路由
 * GET    /api/sources            → 列出所有音源
 * POST   /api/sources/import     → 导入音源文件（multipart form）
 * POST   /api/sources/import-url → 从 URL 导入音源
 * DELETE /api/sources            → 删除音源
 * PUT    /api/sources/toggle     → 启用/禁用音源
 */
export function registerSourceHandlers(
  router: Router,
  sourceManager: SourceManager,
  runtimeManager: RuntimeManager,
  pluginID: number,
): void {
  // ZIP 批量异步加载队列：handler 闭包内的全局状态。
  // - batchQueue: 等待加载的源 id
  // - batchCurrentId: 当前正在加载的源 id（loadSource 同步阻塞 5-10s，期间值有效）
  // - batchRunning: 是否还有未处理项（含正在加载的项）
  // 前端轮询 GET /api/sources，按 batch_current_id / batch_pending_ids 给每张卡片渲染状态。
  const batchQueue: string[] = [];
  let batchCurrentId = '';
  let batchRunning = false;

  async function runBatchLoader(): Promise<void> {
    if (batchQueue.length === 0) {
      batchRunning = false;
      batchCurrentId = '';
      songloft.log.info('[batch-import] 全部异步加载完成');
      return;
    }
    batchRunning = true;
    const id = batchQueue.shift()!;
    batchCurrentId = id;
    try {
      const script = await sourceManager.getSourceScript(id);
      if (!script) {
        songloft.log.warn(`[batch-import] 脚本不存在: id=${id}`);
      } else if (await runtimeManager.loadSource(id, script, pluginID)) {
        try { await sourceManager.enableSource(id); } catch { /* 已被删除则跳过 */ }
        songloft.log.info(`[batch-import] 加载成功: id=${id}`);
      } else {
        songloft.log.warn(`[batch-import] 加载失败: id=${id}`);
      }
    } catch (e: any) {
      songloft.log.warn(`[batch-import] 加载异常: id=${id}, error=${e?.message || e}`);
    }
    batchCurrentId = '';
    // 1000ms 延迟：确保 Go 端 processExpiredTimers 循环退出（捕获 now 时 deadline 在未来），
    // 给其他 HTTP 请求（如前端轮询 /api/sources）让出 env 锁。
    setTimeout(() => { void runBatchLoader(); }, 1000);
  }

  function scheduleBatchLoad(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) batchQueue.push(id);
    if (!batchRunning) {
      batchRunning = true;
      setTimeout(() => { void runBatchLoader(); }, 100);
    }
  }

  // GET /api/sources — 列出所有音源
  router.get('/api/sources', () => {
    const sources = sourceManager.listSources();

    // 构建响应（包含 Enabled 和 Platforms 字段，不含 Script）
    const items = sources.map(s => {
      let platforms: string[] = [];
      const runtime = runtimeManager.getRuntime(s.id);
      if (runtime) {
        const config = runtime.getConfig();
        if (config && config.sources) {
          platforms = Object.keys(config.sources);
        }
      }

      return {
        id: s.id,
        name: s.name,
        version: s.version,
        description: s.description,
        author: s.author,
        filename: s.filename,
        imported_at: s.importedAt,
        enabled: s.enabled,
        platforms,
      };
    });

    return successResponse({
      list: items,
      has_enabled: runtimeManager.count() > 0,
      loading: batchQueue.length + (batchRunning ? 1 : 0), // 前端轮询直到为 0 即停止
      batch_current_id: batchCurrentId,
      batch_pending_ids: batchQueue.slice(),
    });
  });

  // POST /api/sources/import — 导入音源文件
  router.post('/api/sources/import', async (req: HTTPRequest) => {
    // 调试日志：body 基本信息
    const bodyType = typeof req.body;
    const bodyLen = req.body ? ((req.body as any).length ?? 0) : 0;
    songloft.log.info(`[import] body type=${bodyType}, length=${bodyLen}`);

    // 提取 Content-Type boundary
    const contentType = getHeader(req.headers, 'Content-Type');
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!boundaryMatch) {
      return errorResponse(400, '无效的请求格式: 缺少 multipart boundary');
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    songloft.log.info(`[import] boundary="${boundary}"`);

    // 获取 body 字符串
    const bodyStr = getBodyString(req);
    if (!bodyStr) {
      return errorResponse(400, '请上传文件');
    }
    songloft.log.info(`[import] bodyStr length=${bodyStr.length}, first20codes=[${Array.from({length: Math.min(20, bodyStr.length)}, (_, i) => bodyStr.charCodeAt(i)).join(',')}]`);

    // 解析 multipart form 提取文件
    const file = parseMultipartFile(bodyStr, boundary);
    if (!file) {
      return errorResponse(400, '请上传文件');
    }

    const filename = file.filename;
    songloft.log.info(`收到文件上传: filename=${filename}, size=${file.content.length}`);
    // 调试：打印 ZIP 文件头字节
    if (file.content.length >= 4) {
      const hdr = [file.content.charCodeAt(0), file.content.charCodeAt(1), file.content.charCodeAt(2), file.content.charCodeAt(3)];
      songloft.log.info(`[import] file header bytes: [${hdr.map(b => '0x' + b.toString(16)).join(', ')}]`);
    }

    const lowerFilename = filename.toLowerCase();

    if (lowerFilename.endsWith('.js')) {
      // 导入单个 JS 文件
      try {
        const info = await sourceManager.importFromJS(filename, file.content);
        // 如果音源默认启用，自动加载到 RuntimeManager
        let loadFailed = false;
        if (info.enabled) {
          const script = await sourceManager.getSourceScript(info.id);
          if (script) {
            if (!(await runtimeManager.loadSource(info.id, script, pluginID))) {
              songloft.log.warn(`自动加载音源失败: id=${info.id}`);
              loadFailed = true;
            }
          }
        }
        return loadFailed ? successWithWarning(info, LOAD_WARN_MSG) : successResponse(info);
      } catch (e: any) {
        songloft.log.error(`导入 JS 文件失败: ${e.message || e}`);
        return errorResponse(400, '导入失败: ' + (e.message || String(e)));
      }

    } else if (lowerFilename.endsWith('.zip')) {
      // 导入 ZIP 文件
      try {
        const jsFiles = extractZipJSFiles(file.content);
        if (jsFiles.length === 0) {
          return errorResponse(400, 'ZIP 中未找到可导入的 .js 文件');
        }

        // 批量导入：所有源以 enabled=false 持久化，立即返回；
        // 后台 setTimeout 链逐个加载，成功则 enableSource。
        // 每源 init 平均 5-10s，N 个串行不阻塞 HTTP 响应（让锁机制驱动）。
        // 前端轮询 GET /api/sources 的 loading 字段直到为 0。
        const importedSources = await sourceManager.importFromZIP(jsFiles);
        scheduleBatchLoad(importedSources.map(s => s.id));

        return successWithWarning(
          importedSources,
          `已导入 ${importedSources.length} 个音源，后台正在逐个加载，加载成功的会自动开启开关。`
        );
      } catch (e: any) {
        songloft.log.error(`导入 ZIP 文件失败: ${e.message || e}`);
        return errorResponse(400, '导入失败: ' + (e.message || String(e)));
      }

    } else {
      return errorResponse(400, '不支持的文件格式，请上传 .js 或 .zip 文件');
    }
  });

  // POST /api/sources/import-url — 从 URL 导入音源
  router.post('/api/sources/import-url', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const url: string = body.url || '';

    if (!url) {
      return errorResponse(400, '缺少 url 参数');
    }

    // 验证 URL 格式
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return errorResponse(400, 'URL 必须以 http:// 或 https:// 开头');
    }

    songloft.log.info(`开始从 URL 下载音源: url=${url}`);

    // 下载文件（真异步 fetch）
    let content: string;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'songloft-plugin-lxmusic/1.0' },
      });

      if (!resp.ok) {
        return errorResponse(502, '下载失败，远程服务器返回状态码: ' + resp.status);
      }

      content = await resp.text();
    } catch (e: any) {
      songloft.log.error(`下载文件失败: ${e.message || e}`);
      return errorResponse(502, '下载文件失败: ' + (e.message || String(e)));
    }

    // 从 URL 路径提取文件名
    let filename: string;
    try {
      const urlPath = url.split('?')[0].split('#')[0];
      const segments = urlPath.split('/');
      filename = segments[segments.length - 1] || 'source.js';
    } catch {
      filename = 'source.js';
    }
    if (!filename || filename === '.' || filename === '/') {
      filename = 'source.js';
    }
    // 确保以 .js 结尾
    if (!filename.toLowerCase().endsWith('.js')) {
      filename += '.js';
    }

    songloft.log.info(`下载完成: filename=${filename}, size=${content.length}`);

    // 复用导入逻辑
    try {
      const info = await sourceManager.importFromJS(filename, content);

      // 如果音源默认启用，自动加载
      let loadFailed = false;
      if (info.enabled) {
        const script = await sourceManager.getSourceScript(info.id);
        if (script) {
          if (!(await runtimeManager.loadSource(info.id, script, pluginID))) {
            songloft.log.warn(`自动加载音源失败: id=${info.id}`);
            loadFailed = true;
          }
        }
      }

      return loadFailed ? successWithWarning(info, LOAD_WARN_MSG) : successResponse(info);
    } catch (e: any) {
      songloft.log.error(`导入 JS 文件失败: ${e.message || e}`);
      return errorResponse(400, '导入失败: ' + (e.message || String(e)));
    }
  });

  // DELETE /api/sources — 删除音源
  router.delete('/api/sources', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const id = query.id;

    if (!id) {
      return errorResponse(400, '缺少 id 参数');
    }

    // 删除前先从 RuntimeManager 卸载
    await runtimeManager.unloadSource(id);

    try {
      await sourceManager.deleteSource(id);
    } catch (e: any) {
      songloft.log.error(`删除音源失败: id=${id}, error=${e.message || e}`);
      return errorResponse(404, '删除失败: ' + (e.message || String(e)));
    }

    return successResponse(null);
  });

  // PUT /api/sources/toggle — 启用/禁用音源
  router.put('/api/sources/toggle', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const id: string = body.id || '';
    const enabled: boolean = !!body.enabled;

    if (!id) {
      return errorResponse(400, '缺少 id 参数');
    }

    if (enabled) {
      // 启用音源
      try {
        await sourceManager.enableSource(id);
      } catch (e: any) {
        return errorResponse(404, '启用音源失败: ' + (e.message || String(e)));
      }

      // 加载到 RuntimeManager
      const script = await sourceManager.getSourceScript(id);
      if (!script) {
        return errorResponse(500, '获取音源脚本失败');
      }

      if (!(await runtimeManager.loadSource(id, script, pluginID))) {
        // 加载失败，回滚启用状态
        try { await sourceManager.disableSource(id); } catch { /* ignore */ }
        return errorResponse(500, '加载音源失败');
      }

      songloft.log.info(`音源已启用并加载: id=${id}`);
    } else {
      // 禁用音源
      try {
        await sourceManager.disableSource(id);
      } catch (e: any) {
        return errorResponse(404, '禁用音源失败: ' + (e.message || String(e)));
      }

      // 从 RuntimeManager 卸载
      await runtimeManager.unloadSource(id);

      songloft.log.info(`音源已禁用并卸载: id=${id}`);
    }

    return successResponse(null);
  });
}
