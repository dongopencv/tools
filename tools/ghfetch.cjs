#!/usr/bin/env node
// ghfetch.cjs — github.sh 的 node 传输器（GET / DL / PROBE）
//
// 为什么不直接用 fetch：本机 getaddrinfo 冷缓存要 ~12 s（实测 example.com / baidu.com 同样 12 s，
// 是 OS 解析栈的问题，不是 GitHub），而 fetch/undici 只能走 getaddrinfo。这里改成
// 先用 dns.Resolver 直接问 192.168.0.1 / 119.29.29.29 / 223.5.5.5 / 8.8.8.8（5–120 ms），
// 再把 IP 通过 https.request 的 lookup 选项钉住 —— 完全不碰系统解析器。
// 实测：冷缓存下同一个 2.12 MiB release 资产，旧 fetch 12130 ms 后失败，这里 2432–2731 ms 拿全。
//
// 另一件事：Accept 必须随目标变。API 资产端点 /releases/assets/<id> 不带
// application/octet-stream 时会回 1470 字节的资产元数据 JSON —— 存成 zip 还会报成功。
//
// 用法：
//   ghfetch.cjs GET   <url> [token]         → stdout 正文
//   ghfetch.cjs DL    <url> <out> [token]   → 写文件
//   ghfetch.cjs PROBE <url>                 → stdout "<code> <bytes>"
// 环境：PC1_DNS_SERVERS 覆盖解析器列表（空格分隔），PC1_ACCEPT 覆盖 Accept
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
      if (i >= SERVERS.length) { cache.set(host, null); return resolve(null); }
      const r = new dns.Resolver({ timeout: 2000, tries: 1 });
      r.setServers([SERVERS[i++]]);
      r.resolve4(host, (e, a) => {
        if (!e && a && a.length) { cache.set(host, a[0]); resolve(a[0]); }
        else next();
      });
    };
    next();
  });
}

// token 只发给 api.github.com；跟到 release-assets 的预签名 URL 时必须摘掉它。
function sendHeaders(tok, url) {
  const u = new URL(url);
  const h = { "User-Agent": "pc1-ghfetch", Accept: acceptFor(url) };
  if (tok && u.hostname === "api.github.com") h.Authorization = "Bearer " + tok;
  return h;
}

function acceptFor(url) {
  if (process.env.PC1_ACCEPT) return process.env.PC1_ACCEPT;
  if (/\/releases\/assets\//.test(new URL(url).pathname)) return "application/octet-stream";
  return "application/vnd.github+json";
}

async function open(url, tok, depth) {
  const u = new URL(url);
  const h = {};
  const base = sendHeaders(tok, url);
  Object.assign(h, base);
  if (depth > 0) { delete h.Authorization; h.Accept = acceptFor(url); }
  const ip = await resolveFast(u.hostname.replace(/^\[|\]$/g, ""));
  return new Promise((resolve, reject) => {
    const opt = { method: "GET", headers: h };
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
        return open(new URL(res.headers.location, url).toString(), tok, depth + 1).then(resolve, reject);
      }
      resolve(res);
    });
    rq.setTimeout(30000, () => rq.destroy(new Error("timeout 30s")));
    rq.on("error", reject);
    rq.end();
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
  try {
    if (mode === "PROBE") {
      const r = await open(url, "", 0);
      const b = await drain(r);
      process.stdout.write(r.statusCode + " " + b.length);
      return;
    }
    if (mode === "DL") {
      if (!arg3) { process.stderr.write("DL 需要输出路径\n"); process.exit(2); }
      const r = await open(url, arg4 || "", 0);
      if (r.statusCode < 200 || r.statusCode >= 300) {
        process.stderr.write("http " + r.statusCode + "\n");
        process.exit(1);
      }
      const b = await drain(r);
      fs.writeFileSync(arg3, b);
      return;
    }
    const r = await open(url, arg3 || "", 0);
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
