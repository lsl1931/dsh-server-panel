// 极简 WebSocket 服务端：dsh 的 HTTP 载体只给到 upgrade 事件与原始 socket，
// 这里自己完成握手与帧编解码。零依赖，只覆盖终端需要的部分：
// 文本帧、分片、ping/pong、close，消息上限保护。
//
// 不协商 permessage-deflate（不发 Sec-WebSocket-Extensions），因此无需压缩实现。

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 计算 Sec-WebSocket-Accept。 */
export function computeAccept(key) {
  return createHash("sha1").update(String(key) + GUID).digest("base64");
}

/** 服务器 → 客户端：不加掩码。 */
export function encodeFrame(payload, opcode = OPCODE.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * 客户端 → 服务器：带掩码。返回 { frames, rest }；rest 是半个帧的残余字节。
 * 超过 maxPayload 时返回 { error }，由调用方关闭连接。
 */
export function decodeFrames(buffer, maxPayload = 4 * 1024 * 1024) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const byte0 = buffer[offset];
    const byte1 = buffer[offset + 1];
    const fin = (byte0 & 0x80) !== 0;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let length = byte1 & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { frames, rest: Buffer.alloc(0), error: "帧过大" };
      length = Number(big);
      cursor += 8;
    }
    if (length > maxPayload) return { frames, rest: Buffer.alloc(0), error: "帧超过上限" };
    let maskKey = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      maskKey = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
    }
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * 把一个已 upgrade 的 socket 包成对等端。
 * @param {import('node:stream').Duplex} socket
 * @param {{ onMessage?: (text: string, binary: boolean) => void, onClose?: () => void, maxPayload?: number, onProtocolError?: (reason: string) => void }} handlers
 */
export function createPeer(socket, handlers = {}) {
  const maxPayload = handlers.maxPayload ?? 4 * 1024 * 1024;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let error = null;
  const fragments = [];
  let fragmentOpcode = null;

  const emitClose = () => {
    if (closed) return;
    closed = true;
    socket.removeAllListeners("data");
    handlers.onClose?.();
  };

  const sendRaw = (payload, opcode) => {
    if (closed || socket.destroyed) return;
    try {
      socket.write(encodeFrame(payload, opcode));
    } catch {
      emitClose();
    }
  };

  const fail = (reason) => {
    error = reason;
    handlers.onProtocolError?.(reason);
    sendClose(1002, reason);
    socket.end();
    emitClose();
  };

  function sendClose(code = 1000, reason = "") {
    if (closed || socket.destroyed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      socket.write(encodeFrame(payload, OPCODE.CLOSE));
    } catch {
      // 忽略：对端已消失。
    }
  }

  function handleFrame(frame) {
    if (frame.opcode === OPCODE.PING) {
      sendRaw(frame.payload, OPCODE.PONG);
      return;
    }
    if (frame.opcode === OPCODE.PONG) return;
    if (frame.opcode === OPCODE.CLOSE) {
      sendClose(1000);
      socket.end();
      emitClose();
      return;
    }
    if (frame.opcode === OPCODE.TEXT || frame.opcode === OPCODE.BINARY) {
      if (fragmentOpcode !== null) return fail("分片序列非法");
      if (frame.fin) {
        handlers.onMessage?.(frame.payload.toString("utf8"), frame.opcode === OPCODE.BINARY);
        return;
      }
      fragmentOpcode = frame.opcode;
      fragments.push(frame.payload);
      return;
    }
    if (frame.opcode === OPCODE.CONTINUATION) {
      if (fragmentOpcode === null) return fail("意外的续帧");
      fragments.push(frame.payload);
      const total = fragments.reduce((sum, part) => sum + part.length, 0);
      if (total > maxPayload) return fail("分片消息过大");
      if (frame.fin) {
        const merged = Buffer.concat(fragments);
        const opcode = fragmentOpcode;
        fragments.length = 0;
        fragmentOpcode = null;
        handlers.onMessage?.(merged.toString("utf8"), opcode === OPCODE.BINARY);
      }
      return;
    }
    return fail("未知 opcode " + frame.opcode);
  }

  socket.on("data", (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest, error: decodeError } = decodeFrames(buffer, maxPayload);
    buffer = rest;
    if (decodeError) return fail(decodeError);
    for (const frame of frames) {
      if (closed) return;
      handleFrame(frame);
    }
  });
  socket.on("close", emitClose);
  socket.on("end", emitClose);
  socket.on("error", emitClose);

  return {
    sendText: (text) => sendRaw(text, OPCODE.TEXT),
    sendJson: (value) => sendRaw(JSON.stringify(value), OPCODE.TEXT),
    sendPing: () => sendRaw(Buffer.alloc(0), OPCODE.PING),
    close: (code, reason) => {
      sendClose(code ?? 1000, reason ?? "");
      socket.end();
      emitClose();
    },
    get closed() {
      return closed;
    },
    get error() {
      return error;
    },
  };
}

/**
 * 完成 HTTP 101 握手；失败返回 false（调用方负责销毁 socket）。
 */
export function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const version = String(req.headers["sec-websocket-version"] ?? "");
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || !key || version !== "13") return false;
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + computeAccept(key),
      "\r\n",
    ].join("\r\n"),
  );
  return true;
}
