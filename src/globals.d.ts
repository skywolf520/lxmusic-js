// 声明 QuickJS 运行时由 Go 宿主注入的全局桥接函数。
// HTTP 请求统一通过 globalThis.fetch（真异步）；同步桥接已从 runtime 移除。
//
// Router / songloft.* 的异步类型由 @songloft/plugin-sdk 原生支持，
// 本文件不再需要 module augmentation。

/// <reference types="@songloft/plugin-sdk" />

/** SHA256 哈希计算 */
declare function __go_crypto_sha256(data: string): string;

/** 二进制数据编码转换 (如 utf8 -> hex) */
declare function __go_buffer_from(data: string, encoding: string): string;

/** 二进制数据解码转换 (如 hex -> utf8) */
declare function __go_buffer_to_string(dataHex: string, encoding: string): string;

export {};
