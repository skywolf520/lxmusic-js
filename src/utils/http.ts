// 洛雪音源插件 — HTTP 工具（真异步：基于 globalThis.fetch）

/// <reference types="@songloft/plugin-sdk" />

/**
 * 调用 Songloft 宿主 API（异步版）。自动携带 JWT Token 认证。
 * @param method - HTTP 方法
 * @param path - API 路径（如 /api/v1/songs）
 * @param body - 请求体（将被 JSON 序列化）
 * @returns Promise，resolve 为解析后的 JSON
 */
export async function callHostAPI<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const hostUrl = await songloft.plugin.getHostUrl();
  if (!hostUrl) {
    throw new Error('Host URL not available from songloft.plugin.getHostUrl()');
  }

  const token = await songloft.plugin.getToken();
  if (!token) {
    throw new Error('Plugin token not available from songloft.plugin.getToken()');
  }

  const url = hostUrl + path;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };

  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  const resp = await fetch(url, { method, headers, body: bodyStr });
  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`Host API error ${resp.status} ${method} ${path}: ${text}`);
  }

  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}
