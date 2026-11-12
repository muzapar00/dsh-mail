#!/usr/bin/env bash
# 建一个隔离的 DSH 测试 profile（**绝不碰 ~/.dsh 的 web profile，也不重启 3080 进程**）。
#
# 做的事：
#   1. DSH_HOME=/tmp/dsh-maildev；
#   2. 从 ~/.dsh/profiles/web 复制 profile 清单（排除 node_modules），
#      node_modules 不复制、改为"符号链接拼装目录"指向 web profile 的真实包（299MB，零拷贝）；
#   3. 复制 ~/.dsh/.credentials.yaml 到测试 home（600；只有浏览器会话签名 secret 与模型凭据，
#      测试进程会用它，但所有读写都落在 /tmp/dsh-maildev，不会写真实 home）；
#   4. 把 probes/host/probe-plugin 和 dsh-mailbox 本体检链接进 profile node_modules；
#   5. 往 profile 清单里加 dsh-mailprobe bundle；dsh-mailbox 默认**不加**（插件还没写完时会启动失败），
#      加 --with-mailbox 才加入。
#
# 用法：
#   probes/host/setup-test-profile.sh                 # 只带探针插件
#   probes/host/setup-test-profile.sh --with-mailbox  # 同时加载 dsh-mailbox bundle
#   FORCE=1 probes/host/setup-test-profile.sh         # 已有目录时重建
set -euo pipefail

SRC_HOME="${SRC_HOME:-$HOME/.dsh}"
SRC_PROFILE="${SRC_PROFILE:-$SRC_HOME/profiles/web}"
TEST_HOME="${TEST_HOME:-/tmp/dsh-maildev}"
PROFILE_NAME="${PROFILE_NAME:-maildev}"
WORKSPACE="${WORKSPACE:-/home/mzpr00/root_workspace_for_deepseek_harness}"
MAILBOX_DIR="$WORKSPACE/dsh-mailbox"
PROBE_DIR="$MAILBOX_DIR/probes/host/probe-plugin"
WITH_MAILBOX=0

for arg in "$@"; do
  case "$arg" in
    --with-mailbox) WITH_MAILBOX=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── 安全闸：只允许 /tmp 下的测试 home / profile，绝不允许真实 ~/.dsh ──────────
case "$TEST_HOME" in
  /tmp/*) ;;
  *) echo "refusing TEST_HOME outside /tmp: $TEST_HOME" >&2; exit 3 ;;
esac
case "$TEST_HOME" in
  *".dsh"|"$HOME/.dsh"|"$HOME/.dsh/"*) echo "refusing TEST_HOME that points at the real DSH home" >&2; exit 3 ;;
esac
PROFILE_DIR="$TEST_HOME/profiles/$PROFILE_NAME"
case "$PROFILE_DIR" in
  /tmp/*/profiles/*) ;;
  *) echo "refusing PROFILE_DIR: $PROFILE_DIR" >&2; exit 3 ;;
esac

if [ ! -f "$SRC_PROFILE/package.json" ]; then
  echo "source profile not found: $SRC_PROFILE/package.json" >&2
  exit 4
fi
if [ ! -f "$MAILBOX_DIR/package.json" ] || [ ! -f "$PROBE_DIR/index.js" ]; then
  echo "missing mailbox/probe sources under $WORKSPACE" >&2
  exit 4
fi

if [ -d "$TEST_HOME" ]; then
  if [ "${FORCE:-0}" != "1" ]; then
    echo "test home already exists: $TEST_HOME (set FORCE=1 to rebuild)" >&2
    exit 5
  fi
  echo "removing previous test home: $TEST_HOME"
  rm -rf -- "$TEST_HOME"
fi

mkdir -p "$PROFILE_DIR/node_modules" "$TEST_HOME/workspace" "$TEST_HOME/logs"
chmod 700 "$TEST_HOME"

# ── profile 清单：复制除 node_modules 之外的全部内容（cordis.patch.yml 等） ──
echo "copying profile manifest from $SRC_PROFILE"
(cd "$SRC_PROFILE" && tar --exclude=./node_modules --exclude=node_modules -cf - .) | (cd "$PROFILE_DIR" && tar -xf -)

# ── node_modules：逐个顶层条目符号链接到 web profile 的真实包（零拷贝） ──────
echo "linking node_modules entries from $SRC_PROFILE/node_modules"
find "$SRC_PROFILE/node_modules" -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d '' entry; do
  base="$(basename "$entry")"
  ln -sfn "$entry" "$PROFILE_DIR/node_modules/$base"
done

# 探针插件与 dsh-mailbox 本体的链接
ln -sfn "$PROBE_DIR" "$PROFILE_DIR/node_modules/dsh-mailprobe"
ln -sfn "$MAILBOX_DIR" "$PROFILE_DIR/node_modules/dsh-mailbox"
echo "linked dsh-mailprobe -> $PROBE_DIR"
echo "linked dsh-mailbox  -> $MAILBOX_DIR"

# ── credentials：只拷到测试 home（600），保证浏览器会话 cookie 签名可用 ──────
if [ -f "$SRC_HOME/.credentials.yaml" ]; then
  cp -a "$SRC_HOME/.credentials.yaml" "$TEST_HOME/.credentials.yaml"
  chmod 600 "$TEST_HOME/.credentials.yaml"
  echo "copied .credentials.yaml to $TEST_HOME (mode 600)"
else
  echo "warning: no $SRC_HOME/.credentials.yaml; browser auth will mint its own record" >&2
fi

# ── profile package.json：加依赖 + bundle 顺序 ──────────────────────────────
echo "patching profile package.json"
MAILBOX_BUNDLE=0
[ "$WITH_MAILBOX" = "1" ] && MAILBOX_BUNDLE=1
WITH_MAILBOX="$WITH_MAILBOX" PROBE_DIR="$PROBE_DIR" MAILBOX_DIR="$MAILBOX_DIR" \
  PROFILE_DIR="$PROFILE_DIR" PROFILE_NAME="$PROFILE_NAME" node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.PROFILE_DIR + '/package.json';
const manifest = JSON.parse(readFileSync(file, 'utf8'));
manifest.name = 'dsh-profile-' + process.env.PROFILE_NAME;
manifest.dependencies = {
  ...manifest.dependencies,
  'dsh-mailprobe': 'link:' + process.env.PROBE_DIR,
  'dsh-mailbox': 'link:' + process.env.MAILBOX_DIR,
};
const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
const next = bundles.filter((name) => name !== 'dsh-mailprobe' && name !== 'dsh-mailbox');
next.push('dsh-mailprobe');
if (process.env.WITH_MAILBOX === '1') next.push('dsh-mailbox');
manifest.dsh = { ...manifest.dsh, profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } };
writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log('bundles: ' + next.join(', '));
EOF

# ── 启动掩护：确保测试 profile 的 home patch 为空（避免把真实 home 的覆盖带进来） ─
if [ -f "$SRC_HOME/cordis.patch.yml" ]; then
  echo "note: real home has cordis.patch.yml; test home keeps its own (not copied)"
fi
printf "[]\n" > "$TEST_HOME/cordis.patch.yml"

cat <<SUMMARY

test profile ready
  DSH_HOME          $TEST_HOME
  profile           $PROFILE_DIR
  probe bundle      dsh-mailprobe  (endpoints /mailprobe/*, /api/mailprobe)
  mailbox bundle    $([ "$MAILBOX_BUNDLE" = "1" ] && echo 'enabled' || echo 'not in bundles (pass --with-mailbox)')
  credentials       $TEST_HOME/.credentials.yaml
  start with        DSH_HOME=$TEST_HOME $(dirname "$0")/start-test-profile.sh
SUMMARY
