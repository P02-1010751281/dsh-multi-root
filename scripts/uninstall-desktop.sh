#!/usr/bin/env bash
# 从桌面 profile 移除 dsh-multi-root。幂等；不负责把 dsh-multi-folder 装回来。
#
#   bash uninstall-desktop.sh
#   DRY=1 bash uninstall-desktop.sh
#   SKIP_PNPM=1 bash uninstall-desktop.sh
set -euo pipefail

PROFILE_DIR="${PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
DRY="${DRY:-0}"
SKIP_PNPM="${SKIP_PNPM:-0}"
PKG="$PROFILE_DIR/package.json"
LOCK="$PROFILE_DIR/pnpm-lock.yaml"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
backup() {
  local src="$1" dest="$1.pre-$2-$STAMP"
  [ -e "$src" ] || return 0
  while [ -e "$dest" ]; do dest="$1.pre-$2-$STAMP-$$"; STAMP="$STAMP-$$"; done
  cp -p "$src" "$dest" && say "备份     : $(basename "$dest")"
}

[ -f "$PKG" ] || die "找不到 $PKG（PROFILE_DIR 指错？）"
command -v node >/dev/null || die "需要 node"

say "profile : $PROFILE_DIR"
say "模式     : $([ "$DRY" = "1" ] && echo 预览 || echo 执行)"

if [ "$DRY" != "1" ]; then
  backup "$PKG" unmulti-root
  backup "$LOCK" unmulti-root
fi

node - "$PKG" "$DRY" <<'NODE'
const fs = require('node:fs')
const [pkgPath, dry] = process.argv.slice(2)
const doc = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const changes = []
if (doc.dependencies !== undefined && 'dsh-multi-root' in doc.dependencies) {
  delete doc.dependencies['dsh-multi-root']
  changes.push('依赖 - dsh-multi-root')
}
const bundles = doc.dsh?.profile?.bundles ?? []
const index = bundles.indexOf('dsh-multi-root')
if (index >= 0) {
  bundles.splice(index, 1)
  changes.push('bundles - dsh-multi-root')
}
if (changes.length === 0) {
  console.log('无需改动：本来就没装。')
  process.exit(0)
}
console.log('计划改动：')
for (const line of changes) console.log(`  ${line}`)
if (dry === '1') process.exit(0)
const temp = `${pkgPath}.tmp-${process.pid}`
fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
fs.renameSync(temp, pkgPath)
console.log('已写入 package.json')
NODE

if [ "$DRY" = "1" ]; then
  say "预览结束，未写入任何文件。"
  exit 0
fi

if [ "$SKIP_PNPM" != "1" ]; then
  say "同步 node_modules（pnpm install）…"
  ( cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile ) || say "pnpm install 失败（清单已改，可手工 pnpm install 收尾）"
fi

say "完成。重启桌面端后生效。"
