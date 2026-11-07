// DSH GitHub 镜像 MITM 反代（多上游回退版）
// 作用：把发往 github 家族域名的 HTTPS 在本地解密，改写成 <上游前缀>https://<原域名><路径> 再转发；
//       非 github 域名一律按普通 CONNECT 隧道直连，不碰其它站点。
//
// 上游：环境变量 RELAY_UPSTREAMS（逗号分隔，从左到右为优先级）
//       默认 https://ghfast.top/,https://gh-proxy.com/,https://ghproxy.net/
// 回退：单次尝试超时（RELAY_ATTEMPT_TIMEOUT_MS，默认 15000）、连接错误、5xx、429 → 换下一个
// 记忆：成功过的上游在本进程内提到最前（重启回到默认顺序）
// 监听：RELAY_HOST（默认 127.0.0.1）、RELAY_PORT（默认 8899）
// 观测：GET http://127.0.0.1:8899/__relay/status 返回当前顺序与超时配置
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CERT_DIR = process.env.RELAY_CERT_DIR || path.join(__dirname, 'certs')
const LOG_DIR = process.env.RELAY_LOG_DIR || path.join(__dirname, 'logs')
const LISTEN_HOST = process.env.RELAY_HOST || '127.0.0.1'
const LISTEN_PORT = Number(process.env.RELAY_PORT || 8899)
const ATTEMPT_TIMEOUT_MS = Number(process.env.RELAY_ATTEMPT_TIMEOUT_MS || 15000)
const MAX_BODY_BYTES = Number(process.env.RELAY_MAX_BODY_BYTES || 67108864)

const DEFAULT_UPSTREAMS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/']
const UPSTREAMS = (process.env.RELAY_UPSTREAMS || DEFAULT_UPSTREAMS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.endsWith('/') ? s : s + '/'))

let order = UPSTREAMS.slice()

const MITM_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'gist.github.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'media.githubusercontent.com',
  'githubusercontent.com',
])

fs.mkdirSync(LOG_DIR, { recursive: true })
const logFile = path.join(LOG_DIR, 'proxy-' + new Date().toISOString().slice(0, 10) + '.log')
function log(...args) {
  fs.appendFile(logFile, '[' + new Date().toISOString() + '] ' + args.join(' ') + '\n', () => {})
}

const secureContext = tls.createSecureContext({
  key: fs.readFileSync(path.join(CERT_DIR, 'leaf.key.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'leaf.crt.pem')),
})

function buildUpstreamUrl(prefix, host, reqUrl) {
  return prefix + 'https://' + host + reqUrl
}

function rememberPrefix(prefix) {
  if (order[0] === prefix) return
  order = [prefix].concat(order.filter((p) => p !== prefix))
  log('ORDER ' + order.join(' -> '))
}

function readBody(req, cb) {
  const chunks = []
  let size = 0
  let done = false
  req.on('data', (c) => {
    size += c.length
    if (size > MAX_BODY_BYTES) {
      if (!done) { done = true; cb(new Error('request body too large')) }
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks)) } })
  req.on('error', (err) => { if (!done) { done = true; cb(err) } })
}

function fail(ctx, code, msg) {
  if (ctx.res.headersSent) { ctx.res.destroy(); return }
  ctx.res.writeHead(code, { 'content-type': 'text/plain' })
  ctx.res.end('mitm: ' + msg)
  log('FAIL ' + ctx.method + ' ' + ctx.host + ctx.reqUrl + ' :: ' + msg)
}

function requestModule(url) {
  return url.protocol === 'http:' ? http : https
}

// i = 当前试到第几个上游；失败就 i+1（真正的回退）
function tryUpstream(i, ctx) {
  if (i >= order.length) { fail(ctx, 502, 'all upstreams failed'); return }
  const prefix = order[i]
  let target
  try {
    target = new URL(buildUpstreamUrl(prefix, ctx.host, ctx.reqUrl))
  } catch (e) {
    tryUpstream(i + 1, ctx)
    return
  }
  const headers = Object.assign({}, ctx.headers, { host: target.host })
  let timer = null
  let up
  try {
    up = requestModule(target).request(target, { method: ctx.method, headers }, (upRes) => {
    clearTimeout(timer)
    const code = upRes.statusCode || 0
    if ((code >= 500 || code === 429) && i + 1 < order.length) {
      log('RETRY ' + ctx.host + ctx.reqUrl + ' :: ' + prefix + ' -> ' + code)
      upRes.resume()
      tryUpstream(i + 1, ctx)
      return
    }
    if (code < 500) rememberPrefix(prefix)
    const out = Object.assign({}, upRes.headers)
    delete out['transfer-encoding']
    delete out['content-encoding']
    delete out.connection
    out.connection = 'keep-alive'
    ctx.res.writeHead(code, out)
    upRes.pipe(ctx.res)
    upRes.on('end', () => {
      log('MITM ' + ctx.method + ' ' + ctx.host + ctx.reqUrl + ' -> ' + code + ' ' + (Date.now() - ctx.started) + 'ms via ' + prefix)
    })
    upRes.on('error', (err) => {
      log('MITM ERR ' + ctx.host + ctx.reqUrl + ' body :: ' + err.message)
      ctx.res.destroy()
    })
  })
  } catch (e) {
    log('RETRY ' + ctx.host + ctx.reqUrl + ' :: ' + prefix + ' :: ' + e.message)
    tryUpstream(i + 1, ctx)
    return
  }
  timer = setTimeout(() => {
    up.destroy(new Error('attempt timeout ' + ATTEMPT_TIMEOUT_MS + 'ms'))
  }, ATTEMPT_TIMEOUT_MS)
  up.on('error', (err) => {
    clearTimeout(timer)
    if (ctx.res.headersSent) {
      log('MITM ERR ' + ctx.host + ctx.reqUrl + ' after headers :: ' + err.message)
      ctx.res.destroy()
      return
    }
    log('RETRY ' + ctx.host + ctx.reqUrl + ' :: ' + prefix + ' :: ' + err.message)
    tryUpstream(i + 1, ctx)
  })
  if (ctx.body && ctx.body.length) up.write(ctx.body)
  up.end()
}

function handleMitmRequest(req, res) {
  const host = (req.headers.host || 'github.com').split(':')[0]
  if (!MITM_HOSTS.has(host)) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('mitm: unexpected host ' + host)
    return
  }
  const started = Date.now()
  readBody(req, (err, body) => {
    if (err) {
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end('mitm: ' + err.message)
      return
    }
    const headers = Object.assign({}, req.headers)
    delete headers.host
    delete headers['proxy-connection']
    delete headers.connection
    delete headers['accept-encoding']
    tryUpstream(0, { host, reqUrl: req.url || '/', method: req.method, headers, body, res, started })
  })
}

const innerServer = http.createServer(handleMitmRequest)

const PAC_TEXT = [
  'function FindProxyForURL(url, host) {',
  '  var h = (host || "").toLowerCase();',
  '  var hosts = ' + JSON.stringify(Array.from(MITM_HOSTS)) + ';',
  '  for (var i = 0; i < hosts.length; i++) {',
  '    var d = hosts[i];',
  '    if (h === d || h.slice(-(d.length + 1)) === "." + d) {',
  '      return "PROXY ' + LISTEN_HOST + ':' + LISTEN_PORT + '; DIRECT";',
  '    }',
  '  }',
  '  return "PROXY ' + LISTEN_HOST + ':' + LISTEN_PORT + '";',
  '}',
].join('\n')

const proxy = http.createServer((req, res) => {
  const url = req.url || ''
  if (url === '/proxy.pac' || url === '/pac') {
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' })
    res.end(PAC_TEXT)
    return
  }
  if (url === '/__relay/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, listen: LISTEN_HOST + ':' + LISTEN_PORT, order, timeoutMs: ATTEMPT_TIMEOUT_MS }, null, 2))
    return
  }
  let target = null
  try { target = new URL(url) } catch (e) { target = null }
  if (!target) {
    if (req.headers.host && MITM_HOSTS.has(req.headers.host.split(':')[0])) {
      handleMitmRequest(req, res)
      return
    }
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('relay: expected absolute URL or proxy request')
    return
  }
  if (MITM_HOSTS.has(target.hostname)) {
    handleMitmRequest(req, res)
    return
  }
  const up = http.request({
    host: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: target.pathname + target.search,
    headers: Object.assign({}, req.headers, { host: target.host }),
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)
  })
  up.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('relay: ' + err.message)
  })
  req.pipe(up)
})

proxy.on('connect', (req, clientSocket, head) => {
  const parts = (req.url || '').split(':')
  const host = (parts[0] || '').toLowerCase()
  if (!MITM_HOSTS.has(host)) {
    const targetPort = Number(parts[1] || 443)
    const upstreamSocket = net.connect(targetPort, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })
    upstreamSocket.on('error', () => {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch (e) {}
    })
    return
  }
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    secureContext,
    ALPNProtocols: ['http/1.1'],
  })
  tlsSocket.on('error', (err) => log('TLS ERR ' + host + ' :: ' + err.message))
  if (head && head.length) tlsSocket.unshift(head)
  innerServer.emit('connection', tlsSocket)
})

proxy.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log('LISTEN ' + LISTEN_HOST + ':' + LISTEN_PORT + ' upstreams=' + order.join(',') + ' timeout=' + ATTEMPT_TIMEOUT_MS + 'ms')
})

process.on('uncaughtException', (err) => log('UNCAUGHT ' + (err && err.stack ? err.stack : String(err))))
