#!/usr/bin/env node
// ghfetch.cjs — github.sh 的 node 传输器（GET / DL / PROBE）
//
// 为什么要自己写，不用 fetch：
//   1) 本机 getaddrinfo 冷缓存可能 ~12 s（实测 example.com 11 s），fetch/undici 只能走 getaddrinfo。
//      这里先用 dns.Resolver 直接问 192.168.0.1 / 119.29.29.29 / 223.5.5.5 / 8.8.8.8（5–120 ms），
//      再把 IP 通过 https.request 的 lookup 选项钉住 —— 完全不碰系统解析器。
//      实测冷缓存下同一个 2.12 MiB release 资产，旧 fetch 12130 ms 后失败，这里 2.4–2.7 s 拿全。
//   2) Accept 必须随目标变。API 资产端点 /releases/assets/<id> 不带 application/octet-stream
//      时会回 1470 字节的资产元数据 JSON —— 存成 zip 还会报成功。
//   3) 一个域名解析出多个 IP 时，**并发抢跑**：谁先回响应头谁赢，其余立刻掐掉。
//      release-assets 的 4 个 IP 里常年有一个不能用（实测 0 字节，或只有 0.18 MB/s），
//      串行「试第一个 → 等超时 → 试第二个」会把一条命令拖成几十秒。
//
// 用法：
//   ghfetch.cjs GET   <url> [token]         → stdout 正文
//   ghfetch.cjs DL    <url> <out> [token]   → 写文件
//   ghfetch.cjs PROBE <url>                 → stdout "<code> <bytes>"
// 环境：PC1_DNS_SERVERS 覆盖解析器列表（空格分隔）；PC1_ACCEPT 覆盖 Accept；
//       PC1_TIMEOUT 覆盖单次请求超时毫秒数（默认 GET/DL 30000，PROBE 8000）。
"use strict";
// 被 head/管道截断时不要抛 EPIPE 崩掉整条命令（github.sh 会用它取 PROBE 结果）
process.stdout.on("error", e => { if (e && e.code === "EPIPE") process.exit(0); });
const dns = require("dns");
const https = require("https");
const fs = require("fs");

const SERVERS = (process.env.PC1_DNS_SERVERS || "192.168.0.1 119.29.29.29 223.5.5.5 8.8.8.8")
  .split(/\s+/).filter(Boolean);
const cache = new Map();

function resolveFast(host) {
  if (cache.has(host)) return Promise.resolve(cache.get(host));
  return new Promise(resolve => {
    let i = 0;
    const next = () => {
      if (i >= SERVERS.length) { cache.set(host, []); return resolve([]); }
      const r = new dns.Resolver({ timeout: 2000, tries: 1 });
      r.setServers([SERVERS[i++]]);
      r.resolve4(host, (e, a) => {
        if (!e && a && a.length) { cache.set(host, a); resolve(a); }
        else next();
      });
    };
    next();
  });
}

function acceptFor(url) {
  if (process.env.PC1_ACCEPT) return process.env.PC1_ACCEPT;
  if (/\/releases\/assets\//.test(new URL(url).pathname)) return "application/octet-stream";
  return "application/vnd.github+json";
}

// token 只发给 api.github.com；跟到 release-assets 的预签名 URL 时必须摘掉它。
function headersFor(tok, url) {
  const u = new URL(url);
  const h = { "User-Agent": "pc1-ghfetch", Accept: acceptFor(url) };
  if (tok && u.hostname === "api.github.com") h.Authorization = "Bearer " + tok;
  return h;
}

// 单个 IP 的一次请求。成功后 resolve 响应流；onRq 立刻拿到「掐断这次请求」的函数，
// 抢跑时要靠它把输家掐掉（拿不到响应头就一直挂着，否则会把进程吊到超时）。
function request(url, tok, ip, timeoutMs, depth, onRq) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const opt = { method: "GET", headers: headersFor(tok, url) };
    if (ip) {
      // Node 20+ 默认 autoSelectFamily，会以 {all:true} 调 lookup 并要数组；
      // 只返回字符串会炸 "Invalid IP address: undefined"。
      opt.lookup = (name, o, cb) => {
        if (o && o.all) cb(null, [{ address: ip, family: 4 }]);
        else cb(null, ip, 4);
      };
    }
    const rq = https.request(u, opt, res => {
      const sc = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(sc) && res.headers.location && depth < 8) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        // 跳转后 host 变了：重新解析并重新抢跑，token 由 headersFor 按 host 摘掉。
        return openAny(nextUrl, tok, timeoutMs, depth + 1).then(resolve, reject);
      }
      resolve(res);
    });
    if (onRq) onRq(() => { try { rq.destroy(); } catch (_) {} });
    rq.setTimeout(timeoutMs, () => rq.destroy(new Error("timeout " + timeoutMs + "ms")));
    rq.on("error", reject);
    rq.end();
  });
}

// 同一 host 的每个 IP 各起一个请求，谁先回响应头谁赢；输家立刻掐掉。
// 只有 1 个 IP（绝大多数域名）时就是一次普通请求，没有额外开销。
async function openAny(url, tok, timeoutMs, depth) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = await resolveFast(host);
  const tries = ips.length ? ips : [null];
  if (tries.length === 1) return request(url, tok, tries[0], timeoutMs, depth);

  return new Promise((resolve, reject) => {
    const aborts = [];
    let done = false, failed = 0;
    for (const ip of tries) {
      const box = { abort: () => {} };
      aborts.push(box);
      request(url, tok, ip, timeoutMs, depth, fn => { box.abort = fn; }).then(
        res => {
          if (done) { try { res.resume(); } catch (_) {} box.abort(); return; }
          done = true;
          for (const b of aborts) if (b !== box) b.abort();
          resolve(res);
        },
        e => {
          box.abort = () => {};
          if (++failed === tries.length && !done) { done = true; reject(e); }
        }
      );
    }
  });
}

function drain(res) {
  return new Promise((res2, rej) => {
    const chunks = [];
    res.on("data", d => chunks.push(d));
    res.on("end", () => res2(Buffer.concat(chunks)));
    res.on("error", rej);
  });
}

(async () => {
  const [mode, url, arg3, arg4] = process.argv.slice(2);
  if (!mode || !url) {
    process.stderr.write("usage: ghfetch.cjs GET|DL|PROBE <url> [out|token] [token]\n");
    process.exit(2);
  }
  const timeoutMs = Number(process.env.PC1_TIMEOUT || 0) || (mode === "PROBE" ? 8000 : 30000);
  try {
    if (mode === "PROBE") {
      const r = await openAny(url, "", timeoutMs, 0);
      const b = await drain(r);
      process.stdout.write(r.statusCode + " " + b.length);
      return;
    }
    if (mode === "DL") {
      if (!arg3) { process.stderr.write("DL 需要输出路径\n"); process.exit(2); }
      const r = await openAny(url, arg4 || "", timeoutMs, 0);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        process.stderr.write("http " + r.statusCode + "\n");
        process.exit(1);
      }
      const b = await drain(r);
      fs.writeFileSync(arg3, b);
      return;
    }
    const r = await openAny(url, arg3 || "", timeoutMs, 0);
    const b = await drain(r);
    if (r.statusCode < 200 || r.statusCode >= 300) {
      process.stderr.write("http " + r.statusCode + "\n");
      process.exit(1);
    }
    process.stdout.write(b);
  } catch (e) {
    process.stderr.write(String((e && e.message) || e) + "\n");
    process.exit(1);
  }
})();
