#!/usr/bin/env bash
# 重新生成中转站（8899 MITM）用的 CA 与 leaf 证书。
#
# 为什么必须有个脚本：现在的 certs/ 里只有 ca.crt.pem，没有 CA 私钥，
# leaf 到期（2028-11-02）时无法用同一个 CA 重签，只能造一套新 CA 再装进信任库。
# 没有脚本，那天的处置方式就是现场手搓 openssl——手搓的东西没人记得参数。
#
# 用法：
#   bash tools/relay/gen-certs.sh --dry-run   # 只看会生成什么、现有证书还剩多久
#   bash tools/relay/gen-certs.sh             # 生成到 ./certs-new/（不覆盖现有证书）
#   bash tools/relay/gen-certs.sh --out DIR   # 指定输出目录
#
# 生成后脚本不代做的部分（要管理员权限、会动系统信任库）：
#   1. certutil -addstore -f Root ca.crt.pem        # 装新 CA
#   2. certutil -store Root "DSH GitHub Mirror CA"  # 找到旧 CA 并 delstore
#   3. cp ca.crt.pem leaf.crt.pem leaf.key.pem /c/Users/Admin/dsh-mirror-proxy/certs/
#   4. bash tools/relay/deploy.sh
#   5. 显式信任旧 CA 的客户端（curl --cacert / NODE_EXTRA_CA_CERTS）同步换路径
#
# 环境变量：CERT_DAYS（leaf 天数，默认 825）、CERT_CN（leaf CN，默认 github.com）
set -uo pipefail

OUT_DIR=""
DRY=0
DAYS="${CERT_DAYS:-825}"
CN="${CERT_CN:-github.com}"
CERT_DIR_DEFAULT="/c/Users/Admin/dsh-mirror-proxy/certs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --out)     OUT_DIR="${2:-}"; shift 2 ;;
    *)         echo "[fail] 未知参数: $1" >&2; exit 1 ;;
  esac
done
OUT_DIR="${OUT_DIR:-./certs-new}"

die()  { echo "[fail] $*" >&2; exit 1; }
info() { echo "[..] $*"; }
ok()   { echo "[ok] $*"; }

command -v openssl >/dev/null 2>&1 || die "没有 openssl"

# 坑 1：git-bash（MSYS）会把 -subj 的 "/CN=..." 当路径改写，变成
#   C:/Users/.../bash-win32-x64/CN=DSH GitHub Mirror CA
# openssl 于是报 "subject name is expected to be in the format /type0=value0/..."。
# 解法：写成 //CN=...（双斜杠只被吃掉一层转换）。
# 注意不能用 MSYS_NO_PATHCONV=1：它连文件路径转换一起关掉，
# 原生 openssl 就读不到 /c/Users/... 形式的 -in 参数（实测报「找不到指定路径」）。

# leaf 必须覆盖 server.mjs 里 MITM_HOSTS 的全部域名，否则那些域名的 TLS 会失败
SANS=(github.com "*.github.com" api.github.com codeload.github.com gist.github.com \
      github.githubassets.com raw.githubusercontent.com objects.githubusercontent.com \
      avatars.githubusercontent.com user-images.githubusercontent.com camo.githubusercontent.com \
      media.githubusercontent.com "*.githubusercontent.com")

echo "=== 现有证书有效期"
for f in "$CERT_DIR_DEFAULT/ca.crt.pem" "$CERT_DIR_DEFAULT/leaf.crt.pem"; do
  [[ -f "$f" ]] || { info "$f 不存在"; continue; }
  end=$(openssl x509 -in "$f" -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -n "$end" ]]; then
    left=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
    info "$(basename "$f"): 到期 $end（还剩 $left 天）"
  else
    info "$(basename "$f"): 读不出有效期"
  fi
done
if [[ -f "$CERT_DIR_DEFAULT/ca.key.pem" ]]; then
  info "CA 私钥: 存在（可以原地重签 leaf）"
else
  info "CA 私钥: 不存在 → 到期只能换一套新 CA"
fi

if (( DRY )); then
  echo "--- 会做的事 ---"
  echo "1. 在 $OUT_DIR 生成 ca.key.pem / ca.crt.pem（CN=DSH GitHub Mirror CA，10 年）"
  echo "2. 用该 CA 签 leaf（CN=$CN，$DAYS 天）"
  echo "3. SAN 覆盖 ${#SANS[@]} 条：${SANS[*]}"
  echo "4. 校验 leaf 的 issuer 与 SAN"
  exit 0
fi

mkdir -p "$OUT_DIR" || die "建不了 $OUT_DIR"
cd "$OUT_DIR" || die "进不去 $OUT_DIR"

info "1/4 生成 CA（10 年）"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout ca.key.pem -out ca.crt.pem \
  -subj "//CN=DSH GitHub Mirror CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1 || die "CA 生成失败"

info "2/4 生成 leaf 私钥与 CSR"
openssl req -newkey rsa:2048 -nodes -sha256 -keyout leaf.key.pem -out leaf.csr \
  -subj "//CN=$CN" >/dev/null 2>&1 || die "leaf CSR 失败"

# 坑 2：SAN 必须每个域名单独带 DNS: 前缀。用 IFS=, 拼再 sed 一次只会给第一个加前缀，
# openssl 报 "v2i_GENERAL_NAME_ex:missing value"。
SAN_LINE=""
for d in "${SANS[@]}"; do
  [[ -n "$SAN_LINE" ]] && SAN_LINE="$SAN_LINE,"
  SAN_LINE="${SAN_LINE}DNS:$d"
done

info "3/4 用该 CA 签 leaf（$DAYS 天）"
{ echo "subjectAltName=$SAN_LINE"
  echo "basicConstraints=CA:FALSE"
  echo "keyUsage=critical,digitalSignature,keyEncipherment"
  echo "extendedKeyUsage=serverAuth"
} > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.crt.pem -CAkey ca.key.pem -CAcreateserial \
  -days "$DAYS" -sha256 -extfile leaf.ext -out leaf.crt.pem >/dev/null 2>&1 || die "leaf 签名失败"

info "4/4 自检"
openssl x509 -in leaf.crt.pem -noout -issuer -subject -enddate | sed "s/^/  /"
echo "  SAN: $(openssl x509 -in leaf.crt.pem -noout -ext subjectAltName 2>/dev/null | tail -1 | cut -c1-150)"
openssl verify -CAfile ca.crt.pem leaf.crt.pem >/dev/null 2>&1 \
  && ok "leaf 用 ca.crt.pem 验证通过" || die "leaf 验证失败"

rm -f leaf.csr leaf.ext
chmod 600 ca.key.pem leaf.key.pem 2>/dev/null

ok "证书已生成在 $(pwd)"
echo "下一步（需管理员，脚本不代做）："
echo "  1. certutil -addstore -f Root ca.crt.pem"
echo "  2. certutil -store Root \"DSH GitHub Mirror CA\"   # 找到旧条目后 delstore"
echo "  3. cp ca.crt.pem leaf.crt.pem leaf.key.pem $CERT_DIR_DEFAULT/"
echo "  4. bash tools/relay/deploy.sh"
