#!/usr/bin/env bash
# 对隔离测试 profile 跑一轮 host-API 实测，逐条打印 PASS/FAIL 与证据。
#
# 前置：setup-test-profile.sh + start-test-profile.sh（默认端口 3101，可 PORT= 覆盖）。
# 用法：probes/host/http-probe.sh [port]
# 输出：每条实验的 HTTP 状态/关键 JSON 字段；结束时打印汇总。不修改任何真实配置。
set -uo pipefail

TEST_HOME="${TEST_HOME:-/tmp/dsh-maildev}"
PORT="${1:-${PORT:-3101}}"
B="http://127.0.0.1:$PORT"
URL_FILE="$TEST_HOME/logs/url.txt"
COOKIE_JAR="$TEST_HOME/logs/cookies.txt"
PASS=0
FAIL=0

if ! curl -s -m 2 -o /dev/null "$B/mailprobe/diag"; then
  echo "test server not reachable at $B (start it first: PORT=$PORT probes/host/start-test-profile.sh)" >&2
  exit 2
fi
if [ ! -f "$URL_FILE" ]; then
  echo "missing tokenized URL file: $URL_FILE" >&2
  exit 2
fi

# ── 小工具 ──────────────────────────────────────────────────────────────────
json() {
  python3 -c '
import sys, json
d = json.load(sys.stdin)
v = eval(sys.argv[1])
if v is None:
    print("None")
elif isinstance(v, str):
    print(v)
else:
    print(str(v))
' "$1" 2>/dev/null || echo '<parse-error>'
}

# expect STATUS LABEL EXPECTED ACTUAL
expect() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); printf 'PASS  %-58s %s\n' "$label" "$actual"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL  %-58s expected=%s actual=%s\n' "$label" "$expected" "$actual"
  fi
}

code_get() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$@"; }
body_get() { curl -s -m 5 "$@"; }

echo "=================================================================="
echo " host-API probe against $B  (DSH_HOME=$TEST_HOME)"
echo "=================================================================="

# ── 实验 0：探针本身 ───────────────────────────────────────────────────────
echo; echo "-- 0. probe plugin alive (diag)"
diag="$(body_get "$B/mailprobe/diag")"
expect "diag ok" "True" "$(printf '%s' "$diag" | json "d['ok']")"
expect "webServer port" "$PORT" "$(printf '%s' "$diag" | json "d['host']['port']")"
expect "connection.fetch.register" "function" "$(printf '%s' "$diag" | json "d['services']['connectionFetch']['register']")"
expect "duplicate web route (contract)" "True" "$(printf '%s' "$diag" | json "d['probeState']['contractChecks']['duplicateWebRoute']['threw']")"
expect "bad fetch path (contract)" "True" "$(printf '%s' "$diag" | json "d['probeState']['contractChecks']['badFetchPath']['threw']")"
expect "duplicate fetch path (contract)" "True" "$(printf '%s' "$diag" | json "d['probeState']['contractChecks']['duplicateFetchPath']['threw']")"

# ── 实验 A：ctx.webServer.register 自建路由 → 不经宿主鉴权 ─────────────────
echo; echo "-- A. ctx.webServer.register route has NO host auth"
a_status="$(code_get "$B/mailprobe/plain")"
a_body="$(body_get "$B/mailprobe/plain")"
expect "webServer route without cookie -> status" "200" "$a_status"
expect "webServer route reports reachedWithoutHostAuth" "True" "$(printf '%s' "$a_body" | json "d['reachedWithoutHostAuth']")"
expect "webServer route sees no cookie" "False" "$(printf '%s' "$a_body" | json "d['request']['cookieHeaderPresent']")"
expect "requestRejection(no cookie) (would be 401)" "401" "$(printf '%s' "$a_body" | json "d['judgement']['requestRejection']")"
expect "admit(no cookie) rejection" "401" "$(printf '%s' "$a_body" | json "d['judgement']['admit']['rejection']")"

# ── 实验 B：用 token URL 换浏览器 cookie ────────────────────────────────────
echo; echo "-- B. browser login cookie from tokenized URL"
token_url="$(cat "$URL_FILE")"
rm -f "$COOKIE_JAR"
b_code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" "$token_url")"
expect "GET /?token=... -> 303" "303" "$b_code"
expect "cookie jar holds dsh-auth-* (HttpOnly)" "1" "$(grep -c 'dsh-auth-' "$COOKIE_JAR" 2>/dev/null || true)"

# ── 实验 C：同样请求带上 cookie 后 connection 判定放行 ─────────────────────
echo; echo "-- C. same webServer route with cookie: requestRejection/admit"
c_body="$(body_get -b "$COOKIE_JAR" "$B/mailprobe/plain")"
expect "requestRejection(with cookie) = null(放行)" "None" "$(printf '%s' "$c_body" | json "d['judgement']['requestRejection']")"
expect "admit principal kind" "owner" "$(printf '%s' "$c_body" | json "d['judgement']['admit']['principal']['kind']")"

# ── 实验 D：connection.fetch.register 的 /api 精确路由强制宿主鉴权 ─────────
echo; echo "-- D. ctx.connection.fetch.register('/api/mailprobe') host auth"
d_no_cookie="$(code_get "$B/api/mailprobe")"
d_with_cookie="$(code_get -b "$COOKIE_JAR" "$B/api/mailprobe")"
expect "GET /api/mailprobe no cookie -> 401" "401" "$d_no_cookie"
expect "GET /api/mailprobe with cookie -> 200" "200" "$d_with_cookie"
expect "GET unknown /api/* with cookie -> 404" "404" "$(code_get -b "$COOKIE_JAR" "$B/api/does-not-exist")"
expect "GET unknown /api/* no cookie -> 401" "401" "$(code_get "$B/api/does-not-exist")"

echo; echo "-- E. cross-site fences (with a valid cookie!)"
expect "Origin: http://evil.example -> 403" "403" "$(code_get -b "$COOKIE_JAR" -H 'Origin: http://evil.example' "$B/api/mailprobe")"
expect "Sec-Fetch-Site: cross-site -> 403" "403" "$(code_get -b "$COOKIE_JAR" -H 'Sec-Fetch-Site: cross-site' "$B/api/mailprobe")"
expect "Origin same-authority -> 200" "200" "$(code_get -b "$COOKIE_JAR" -H "Origin: $B" "$B/api/mailprobe")"
expect "forged Host header -> 403/401" "403" "$(code_get -b "$COOKIE_JAR" -H 'Host: evil.example' "$B/api/mailprobe")"

echo; echo "-- F. authenticated POST body echo"
f_body="$(curl -s -m 5 -b "$COOKIE_JAR" -H 'content-type: application/json' -H 'x-dsh-mailbox: 1' -X POST -d '{"action":"health"}' "$B/api/mailprobe")"
expect "POST /api/mailprobe bodyBytes" "19" "$(printf '%s' "$f_body" | json "d['bodyBytes']")"
expect "POST custom header forwarded to handler" "1" "$(printf '%s' "$f_body" | json "d['headers']['customHeader']")"

# ── 实验 G：webServer handler 抛异常 → 宿主回 400（无响应体） ──────────────
echo; echo "-- G. webServer handler throw -> 400"
expect "GET /mailprobe/throw -> 400" "400" "$(code_get "$B/mailprobe/throw")"

# ── 实验 H：webServer handler 自己读 body + 1MB 上限 ───────────────────────
echo; echo "-- H. webServer handler body reading / own limit"
h_body="$(curl -s -m 5 -X POST -d 'hello-body' "$B/mailprobe/plain")"
expect "POST /mailprobe/plain echoes body" "hello-body" "$(printf '%s' "$h_body" | json "d['bodyText']")"
python3 -c 'open("/tmp/mailprobe-big.bin","w").write("x"*1200000)'
expect "POST 1.2MB body -> 413" "413" "$(code_get -X POST --data-binary @/tmp/mailprobe-big.bin "$B/mailprobe/plain")"
rm -f /tmp/mailprobe-big.bin

# ── 实验 I：工具热注册/注销 + 重名冲突 ─────────────────────────────────────
echo; echo "-- I. ctx.tools.register hot swap + name collision"
body_get "$B/mailprobe/tool?on=0" >/dev/null
i_off="$(body_get "$B/mailprobe/diag" | json "'mail_probe_status' in d['registeredToolNames']")"
body_get "$B/mailprobe/tool?on=1" >/dev/null
i_on="$(body_get "$B/mailprobe/diag" | json "'mail_probe_status' in d['registeredToolNames']")"
i_dup="$(body_get "$B/mailprobe/tool?on=dup" | json "d['duplicateThrew']")"
expect "tool absent after disposer()" "False" "$i_off"
expect "tool present after re-register" "True" "$i_on"
expect "duplicate tool registration throws" "True" "$i_dup"

# ── 实验 J：systemPrompt.section 热注册/注销 + assemble 可见 + 重名冲突 ─────
echo; echo "-- J. ctx.systemPrompt.section hot swap + assemble"
j_on="$(body_get "$B/mailprobe/prompt?on=1")"
expect "probe section present in assemble()" "True" "$(printf '%s' "$j_on" | json "'plugin:mailprobe' in (d['assemble']['sectionNames'] or [])")"
expect "assemble resolves section text" "True" "$(printf '%s' "$j_on" | json "'MAILPROBE_SECTION' in (d['assemble']['probeSectionText'] or '')")"
body_get "$B/mailprobe/prompt?on=0" >/dev/null
j_off="$(body_get "$B/mailprobe/prompt?on=1")"
j_dup="$(body_get "$B/mailprobe/prompt?on=dup" | json "d['duplicateThrew']")"
expect "section re-registered after dispose" "True" "$(printf '%s' "$j_off" | json "'plugin:mailprobe' in (d['assemble']['sectionNames'] or [])")"
expect "duplicate section registration throws" "True" "$j_dup"

# ── 实验 K：agents 会话枚举 + 通知注入 + 让 AI 起一轮 ─────────────────────
echo; echo "-- K. agents/sessionController: enumerate, inject, followup"
k_create="$(curl -s -m 20 -X POST -H 'content-type: application/json' -d '{"op":"create"}' "$B/mailprobe/session")"
k_sid="$(printf '%s' "$k_create" | json "d.get('sessionId')")"
expect "agents.create() creates session V4" "True" "$(printf '%s' "$k_create" | json "d['header']['version'] == 4")"
k_list="$(curl -s -m 20 -X POST -H 'content-type: application/json' -d '{"op":"controller-list"}' "$B/mailprobe/session")"
k_seen="$(printf '%s' "$k_list" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(any(i.get("sessionId") for i in d.get("items") or []))' 2>/dev/null || echo '<parse-error>')"
expect "sessionController.list() sees a live row" "True" "$k_seen"
k_inject="$(curl -s -m 20 -X POST -H 'content-type: application/json' -d '{"op":"inject","text":"您有新的来信，请查收。","summary":"1 封新邮件"}' "$B/mailprobe/session")"
expect "agent.inject() -> durable inbox splice" "1" "$(printf '%s' "$k_inject" | json "d['after']['nextStep']")"
expect "injected message id present" "True" "$(printf '%s' "$k_inject" | json "bool(d['message']['id'])")"
expect "injected source kind" "plugin:dsh-mailbox" "$(printf '%s' "$k_inject" | json "d['message']['source']['kind']")"
expect "injected source form" "notice" "$(printf '%s' "$k_inject" | json "d['message']['source']['form']")"
k_follow="$(curl -s -m 40 -X POST -H 'content-type: application/json' -d '{"op":"followup","text":"您有新的来信，请查收。","summary":"1 封新邮件","settleMs":2500}' "$B/mailprobe/session")"
expect "agent.followup() -> status running seen" "True" "$(printf '%s' "$k_follow" | json "any(e['kind']=='agent/status' and e['status']=='running' for e in d['agentEvents'])")"
expect "followup starts a turn (step/start)" "True" "$(printf '%s' "$k_follow" | json "any(e['type']=='step/start' for e in (d.get('eventsTail') or []))")"
expect "followup message persisted as user/message" "True" "$(printf '%s' "$k_follow" | json "any(e['type']=='user/message' and (e.get('data') or {}).get('source',{}).get('kind')=='plugin:dsh-mailbox' for e in (d.get('eventsTail') or []))")"
k_prompt="$(curl -s -m 40 -X POST -H 'content-type: application/json' -d '{"op":"prompt","text":"controller 探针","settleMs":2500}' "$B/mailprobe/session")"
expect "sessionController.prompt accepted" "True" "$(printf '%s' "$k_prompt" | json "d.get('promptAccepted')")"
expect "controller prompt source.kind == user (attribution lost)" "True" "$(printf '%s' "$k_prompt" | json "any(e['type']=='user/message' and (e.get('data') or {}).get('source',{}).get('kind')=='user' for e in (d.get('eventsTail') or []))")"
k_dispose="$(curl -s -m 20 -X POST -H 'content-type: application/json' -d '{"op":"dispose"}' "$B/mailprobe/session")"
expect "agent.handle.dispose()" "True" "$(printf '%s' "$k_dispose" | json "d.get('disposed')")"

# ── 汇总 ───────────────────────────────────────────────────────────────────
echo
echo "=================================================================="
echo " RESULT: $PASS passed, $FAIL failed"
echo "=================================================================="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
