#!/usr/bin/env bash
# verify-1c-connector: дымовой прогон 1С-коннектора на подложной 1С, без сети и без реальных баз.
#
#   verify.sh all      # deps, doctor, затем smoke и тесты репо параллельно, итог ALL (обычный вызов)
#   verify.sh deps     # node_modules из package-lock (npm ci --ignore-scripts, сначала из кэша)
#   verify.sh doctor   # только чтение: node, зависимости, mcpb офлайн, порты тестов свободны
#   verify.sh smoke    # smoke.mjs: главный путь, только чтение, ошибки, утечки, сборка .mcpb
#   verify.sh tests    # существующий набор npm test (tests/run-tests.mjs), разбор строки ИТОГО
#   verify.sh props    # тесты на правила (tests/props.mjs --quick) и сравнение с редакцией для ChatGPT (tests/differential.mjs)
#
# Переменные: VERIFY_OUT (корень доказательств, по умолчанию C:/Users/xaoc/1c-connector-out/verify-evidence),
#             DIFF_OTHER_REPO (репозиторий 1c-chatgpt-connector для сравнения, по умолчанию соседняя папка;
#             не нашёлся: props падает, если не задано DIFF_ALLOW_SKIP=1),
#             MCPB_CLI (путь к dist/cli/cli.js пакета @anthropic-ai/mcpb, если его нет в npx-кэше).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"
to_win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
REPO="$(to_win "$REPO")"
OUT_ROOT="${VERIFY_OUT:-C:/Users/xaoc/1c-connector-out/verify-evidence}"
TEST_PORTS="8766 2224 2225"   # заняты tests/run-tests.mjs (жёстко в тестах репо)

run_dir() {
  if [ -z "${RUN_DIR:-}" ]; then
    RUN_DIR="$OUT_ROOT/$(date +%Y%m%d-%H%M%S)-$(git -C "$REPO" rev-parse --short HEAD)"
    mkdir -p "$RUN_DIR"
    {
      echo "branch=$(git -C "$REPO" branch --show-current) sha=$(git -C "$REPO" rev-parse --short HEAD) node=$(node -v)"
      echo "dirty_files:"; git -C "$REPO" status --short | head -50
    } > "$RUN_DIR/meta.txt"
  fi
}

cmd_deps() {
  if [ -f "$REPO/node_modules/@modelcontextprotocol/sdk/package.json" ] && [ "$REPO/node_modules/.package-lock.json" -nt "$REPO/package-lock.json" ]; then
    echo "deps: node_modules на месте"; return 0
  fi
  local t0=$SECONDS
  (cd "$REPO" && npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null)
  echo "deps: npm ci за $((SECONDS - t0)) с"
}

cmd_doctor() {
  local bad=0
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] && echo "node $(node -v)" || { echo "FAIL: нужен node 18+, сейчас $(node -v)"; bad=1; }
  [ -f "$REPO/node_modules/@modelcontextprotocol/sdk/package.json" ] || { echo "FAIL: нет node_modules, запустите verify.sh deps"; bad=1; }
  local mcpb="${MCPB_CLI:-}"
  if [ -z "$mcpb" ]; then mcpb="$(ls -d "$(to_win "${LOCALAPPDATA:-$HOME/.npm}")"/npm-cache/_npx/*/node_modules/@anthropic-ai/mcpb/dist/cli/cli.js 2>/dev/null | head -1 || true)"; fi
  [ -n "$mcpb" ] && echo "mcpb: $mcpb ($(node "$mcpb" --version))" || { echo "FAIL: mcpb офлайн не найден. Один раз с сетью: npx -y @anthropic-ai/mcpb --version (или MCPB_CLI)"; bad=1; }
  for p in $TEST_PORTS; do
    if node -e "const s=require('net').createServer().once('error',()=>process.exit(1)).listen($p,'127.0.0.1',()=>s.close(()=>process.exit(0)))"; then :; else
      echo "FAIL: порт 127.0.0.1:$p занят (нужен тестам репо). Возможно, остался процесс прошлого прогона: node tests/mock*.mjs"; bad=1; fi
  done
  [ $bad -eq 0 ] && echo "DOCTOR OK" || { echo "DOCTOR FAILED"; return 1; }
}

cmd_smoke() {
  run_dir
  local t0=$SECONDS rc=0
  node "$SKILL_DIR/smoke.mjs" "$RUN_DIR" > "$RUN_DIR/smoke.log" 2>&1 || rc=$?
  grep -E '^(FAIL|SMOKE)|^     ' "$RUN_DIR/smoke.log" || true
  echo "smoke: $((SECONDS - t0)) с, код $rc"
  return "$rc"
}

cmd_tests() {
  run_dir
  local t0=$SECONDS tmp
  # временные HOME тестов (c1home-*) пишем в свою папку и удаляем; тесты репо всегда выходят с кодом 0,
  # поэтому итог берём из строки «ИТОГО: N прошло, M упало»
  tmp="$(mktemp -d)"
  (cd "$REPO" && TMP="$(to_win "$tmp")" TEMP="$(to_win "$tmp")" TMPDIR="$tmp" node tests/run-tests.mjs) > "$RUN_DIR/tests.log" 2>&1 || true
  rm -rf "$tmp"
  local line; line="$(grep -a 'ИТОГО:' "$RUN_DIR/tests.log" | tail -1)"
  grep -a '^✘' -A1 "$RUN_DIR/tests.log" || true
  echo "tests: ${line:-нет строки ИТОГО} за $((SECONDS - t0)) с"
  [[ "$line" =~ ИТОГО:\ ([0-9]+)\ прошло,\ 0\ упало ]] && [ "${BASH_REMATCH[1]}" -gt 0 ]
}

cmd_props() {
  # тесты на правила (fast-check, короткий режим) и сравнение с редакцией для ChatGPT (соседний репозиторий
  # или DIFF_OTHER_REPO); если соседа нет, сравнение пишет «пропущено», это видно в итоге
  run_dir
  local t0=$SECONDS rc=0
  (cd "$REPO" && node tests/props.mjs --quick) > "$RUN_DIR/props.log" 2>&1 || rc=1
  (cd "$REPO" && node tests/differential.mjs) > "$RUN_DIR/differential.log" 2>&1 || rc=1
  # сравнение без второй редакции ничего не доказывает: «пропущено» считаем провалом, если не разрешили явно
  if grep -aq '^СРАВНЕНИЕ: пропущено' "$RUN_DIR/differential.log" && [ "${DIFF_ALLOW_SKIP:-}" != 1 ]; then
    echo "FAIL: сравнение редакций пропущено, второй репозиторий не найден. Задайте DIFF_OTHER_REPO=<путь к 1c-chatgpt-connector> (или DIFF_ALLOW_SKIP=1)"; rc=1
  fi
  grep -a -h '^✘' -A4 "$RUN_DIR/props.log" "$RUN_DIR/differential.log" || true
  grep -a '^Сравнение:' "$RUN_DIR/differential.log" | tail -1 || true
  echo "props: $(grep -a '^СВОЙСТВА:' "$RUN_DIR/props.log" | tail -1); $(grep -a '^СРАВНЕНИЕ:' "$RUN_DIR/differential.log" | tail -1); $((SECONDS - t0)) с"
  return "$rc"
}

cmd_all() {
  local t0=$SECONDS rc_s=0 rc_t=0 rc_p=0
  cmd_deps
  cmd_doctor
  run_dir
  cmd_tests > "$RUN_DIR/tests.summary" 2>&1 &
  local tp=$!
  cmd_props > "$RUN_DIR/props.summary" 2>&1 &
  local pp=$!
  cmd_smoke || rc_s=$?
  wait "$tp" || rc_t=$?
  wait "$pp" || rc_p=$?
  cat "$RUN_DIR/tests.summary" "$RUN_DIR/props.summary"
  local sm; sm="$(grep -a '^SMOKE:' "$RUN_DIR/smoke.log" | tail -1)"
  local ts; ts="$(grep -a 'ИТОГО:' "$RUN_DIR/tests.log" | tail -1)"
  local ps; ps="$(grep -a '^props:' "$RUN_DIR/props.summary" | tail -1)"
  echo "доказательства: $RUN_DIR"
  if [ $rc_s -eq 0 ] && [ $rc_t -eq 0 ] && [ $rc_p -eq 0 ]; then
    echo "ALL OK: $sm; тесты репо $ts; $ps; всего $((SECONDS - t0)) с"
  else
    echo "ALL FAILED (smoke=$rc_s tests=$rc_t props=$rc_p): $sm; тесты репо $ts; $ps; всего $((SECONDS - t0)) с"; return 1
  fi
}

case "${1:-}" in
  deps) cmd_deps ;;
  doctor) cmd_doctor ;;
  smoke) cmd_smoke ;;
  tests) cmd_tests ;;
  props) cmd_props ;;
  all) cmd_all ;;
  *) echo "использование: verify.sh all|deps|doctor|smoke|tests|props"; exit 2 ;;
esac
