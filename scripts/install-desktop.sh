#!/usr/bin/env bash
# 把 dsh-multi-root 装进桌面 profile，并移除互斥的 dsh-multi-folder。
#
#   bash install-desktop.sh            # 真装（会备份 + 跑 pnpm install）
#   DRY=1 bash install-desktop.sh      # 只打印计划，不落盘
#   SKIP_PNPM=1 bash install-desktop.sh # 只改清单，不跑 pnpm（测试用）
#
# 幂等：重复跑不会重复追加、不会更糟。
# 回滚：bash uninstall-desktop.sh（本脚本不负责把 dsh-multi-folder 装回去）。
set -euo pipefail

PROFILE_DIR="${PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PLUGIN_PATH="${PLUGIN_PATH:-$HOME/Projects/dsh-multi-root}"
DRY="${DRY:-0}"
SKIP_PNPM="${SKIP_PNPM:-0}"
PKG="$PROFILE_DIR/package.json"
LOCK="$PROFILE_DIR/pnpm-lock.yaml"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
# 备份从不覆盖：同名已存在就换一个后缀。
backup() {
  local src="$1" dest="$1.pre-$2-$STAMP"
  [ -e "$src" ] || return 0
  while [ -e "$dest" ]; do dest="$1.pre-$2-$STAMP-$$"; STAMP="$STAMP-$$"; done
  cp -p "$src" "$dest" && say "备份     : $(basename "$dest")"
}

[ -f "$PKG" ] || die "找不到 $PKG（PROFILE_DIR 指错？）"
[ -f "$PLUGIN_PATH/package.json" ] || die "找不到 $PLUGIN_PATH/package.json（PLUGIN_PATH 指错？）"
command -v node >/dev/null || die "需要 node"
[ "$DRY" = "1" ] || [ -w "$PKG" ] || die "$PKG 不可写"

say "profile : $PROFILE_DIR"
say "插件     : $PLUGIN_PATH"
say "模式     : $([ "$DRY" = "1" ] && echo 预览 || echo 执行)"

if [ "$DRY" != "1" ]; then
  backup "$PKG" multi-root
  backup "$LOCK" multi-root
fi

node - "$PKG" "$PLUGIN_PATH" "$DRY" <<'NODE'
const fs = require('node:fs')
const [pkgPath, pluginPath, dry] = process.argv.slice(2)
const doc = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
doc.dependencies ??= {}
doc.dsh ??= {}
doc.dsh.profile ??= {}
doc.dsh.profile.bundles ??= []
const changes = []

if ('dsh-multi-folder' in doc.dependencies) {
  delete doc.dependencies['dsh-multi-folder']
  changes.push('依赖 - dsh-multi-folder（与多根插件互斥）')
}
const folderIndex = doc.dsh.profile.bundles.indexOf('dsh-multi-folder')
if (folderIndex >= 0) {
  doc.dsh.profile.bundles.splice(folderIndex, 1)
  changes.push('bundles - dsh-multi-folder')
}
const wanted = `link:${pluginPath}`
if (doc.dependencies['dsh-multi-root'] !== wanted) {
  doc.dependencies['dsh-multi-root'] = wanted
  changes.push(`依赖 + dsh-multi-root → ${wanted}`)
}
if (!doc.dsh.profile.bundles.includes('dsh-multi-root')) {
  doc.dsh.profile.bundles.push('dsh-multi-root')
  changes.push('bundles + dsh-multi-root（末位）')
}

if (changes.length === 0) {
  console.log('无需改动：已经装好。')
  process.exit(0)
}
console.log('计划改动：')
for (const line of changes) console.log(`  ${line}`)
console.log(`  deps ${Object.keys(doc.dependencies).length} 项，bundles ${doc.dsh.profile.bundles.length} 项，末位 ${doc.dsh.profile.bundles.at(-1)}`)
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
  ( cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile ) || die "pnpm install 失败；清单已备份，可用 uninstall-desktop.sh 或备份回滚"
fi

if [ "$SKIP_PNPM" = "1" ]; then
  say "SKIP_PNPM=1：未同步 node_modules，跳过链接校验。"
  exit 0
fi

node -e '
const fs = require("node:fs")
const path = require("node:path")
const dir = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
if (!pkg.dsh.profile.bundles.includes("dsh-multi-root")) throw new Error("bundles 里没有 dsh-multi-root")
if (pkg.dependencies["dsh-multi-root"] === undefined) throw new Error("dependencies 里没有 dsh-multi-root")
const target = path.join(dir, "node_modules", "dsh-multi-root", "package.json")
if (!fs.existsSync(target)) throw new Error("node_modules 里没有链接到插件：" + target)
const linked = JSON.parse(fs.readFileSync(target, "utf8"))
console.log(`校验通过：node_modules/dsh-multi-root → ${linked.name}@${linked.version}`)
' "$PROFILE_DIR" || die "安装后校验失败"

say ""
say "完成。重启桌面端让插件生效："
say "  kill -TERM \$(pgrep -f 'dsh-desktop' | head -1)"
say "  setsid nohup ~/.local/bin/dsh-desktop >/tmp/dsh-desktop-\$(date +%s).log 2>&1 &"
say ""
say "重启后在目标项目的会话里（例：app-a）："
say "  /roots add /srv/work/apps/app-b"
