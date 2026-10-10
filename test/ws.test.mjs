import { Duplex } from "node:stream";
import { acceptUpgrade, computeAccept, createPeer, decodeFrames, encodeFrame, OPCODE } from "../src/ws.js";
import { eq, ok, summary, test, testAsync } from "./harness.mjs";

console.log("ws(WebSocket)");

/** 造一个客户端帧（带掩码，符合 RFC 6455 客户端要求）。 */
function clientFrame(text, opcode = OPCODE.TEXT, fin = true) {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** 既能写、又能被 push 数据触发 data 事件的假 socket。 */
function fakeSocket() {
  const written = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(Buffer.from(chunk));
      cb();
    },
  });
  socket.written = written;
  socket.text = () => Buffer.concat(written).toString("utf8");
  return socket;
}

test("握手：RFC 6455 示例向量", () => {
  eq(computeAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("encodeFrame：三种长度档位与小端序头", () => {
  eq(encodeFrame("hi").subarray(0, 2), Buffer.from([0x81, 2]));
  const medium = encodeFrame("x".repeat(300));
  eq(medium[0], 0x81);
  eq(medium[1], 126);
  eq(medium.readUInt16BE(2), 300);
  const large = encodeFrame("y".repeat(70000));
  eq(large[1], 127);
  eq(Number(large.readBigUInt64BE(2)), 70000);
});

test("decodeFrames：解掩码、半帧返回 rest", () => {
  const one = clientFrame("hello");
  const { frames, rest } = decodeFrames(one);
  eq(frames.length, 1);
  eq(frames[0].payload.toString("utf8"), "hello");
  eq(rest.length, 0);

  const cut = one.subarray(0, one.length - 2);
  const partial = decodeFrames(cut);
  eq(partial.frames.length, 0);
  eq(partial.rest.length, cut.length, "半个帧要原样留着");
});

test("decodeFrames：超上限报错", () => {
  const big = clientFrame("z".repeat(2000));
  const r = decodeFrames(big, 100);
  ok(r.error, "应当报错");
});

await testAsync("acceptUpgrade：校验版本与升级头", async () => {
  const socket = fakeSocket();
  ok(acceptUpgrade({ headers: { upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } }, socket));
  ok(socket.text().includes("101 Switching Protocols"));
  ok(socket.text().includes("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));

  const bad = fakeSocket();
  ok(!acceptUpgrade({ headers: { upgrade: "websocket", "sec-websocket-key": "x", "sec-websocket-version": "8" } }, bad), "版本不对要拒绝");
  ok(!acceptUpgrade({ headers: {} }, bad), "缺头要拒绝");
});

/** 等一个事件循环：Duplex 的 push → 'data' 是异步派发的。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

await testAsync("peer：文本消息、分片、ping/pong、close", async () => {
  const socket = fakeSocket();
  const messages = [];
  let closed = false;
  const peer = createPeer(socket, {
    onMessage: (text) => messages.push(text),
    onClose: () => {
      closed = true;
    },
  });

  socket.push(clientFrame("hello"));
  await tick();
  ok(closed === false);
  eq(messages, ["hello"]);

  // 分片：TEXT(no fin) + CONTINUATION(fin)
  socket.push(clientFrame("分", OPCODE.TEXT, false));
  socket.push(clientFrame("片", OPCODE.CONTINUATION, true));
  await tick();
  eq(messages, ["hello", "分片"]);

  // ping → 自动 pong
  socket.push(clientFrame("", OPCODE.PING));
  await tick();
  const written = Buffer.concat(socket.written);
  ok(written.includes(0x8a), "应当回 pong");

  peer.sendJson({ t: "ok" });
  ok(socket.text().includes('{"t":"ok"}'), "服务端发送的是未掩码文本帧");

  socket.push(clientFrame("", OPCODE.CLOSE));
  await tick();
  eq(closed, true);
});

await testAsync("peer：非法续帧关闭连接", async () => {
  const socket = fakeSocket();
  const errors = [];
  let closed = false;
  createPeer(socket, {
    onProtocolError: (reason) => errors.push(reason),
    onClose: () => {
      closed = true;
    },
  });
  socket.push(clientFrame("孤儿续帧", OPCODE.CONTINUATION, true));
  await tick();
  eq(closed, true);
  eq(errors.length, 1);
});

summary();
