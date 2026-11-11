#!/usr/bin/env bash
# 给已安装的 dsh 载荷打上 `protectedPaths` 契约补丁（v0.5.0 只读硬化的宿主半）。
#
#   bash scripts/patch-host.sh            # 真打（先备份，锚点不中即失败，不半打）
#   DRY=1 bash scripts/patch-host.sh      # 只校验锚点与目标，不落盘
#   bash scripts/patch-host.sh --revert   # 从最近的备份还原
#   PAYLOAD=/path/to/repo bash scripts/patch-host.sh
#
# 为什么需要补丁：0.2.2-rc.1 的 policy 只能「追加整目录可写」，没有「可写目录里
# 某子树只读」的表达。三个执行层（bwrap / Landlock / Seatbelt）与 fs 围栏全部从
# `workspaceWritableRoots()` 派生，所以补丁必须打在这三处消费点 + policy 服务上，
# 并由 resolve() 返回 `protectedPathsSupported: true` 作为能力声明。
#
# 补丁只做减法：没有 `protectedPaths` 的 policy 行为与原来逐字节一致，因此不带
# 副根的会话不受影响。载荷升级会覆盖这些文件，升级后重跑本脚本。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVERT=0
[ "${1:-}" = "--revert" ] && REVERT=1

find_payload() {
  local root="${DSH_DESKTOP_ROOT:-$HOME/.local/share/dsh-desktop}"
  ls -d "$root"/*/ 2>/dev/null | sort -V | tail -1 | sed 's:/*$::'
}

PAYLOAD="${PAYLOAD:-$(find_payload)}"
if [ -n "${PAYLOAD:-}" ] && [ -d "$PAYLOAD/repo/packages" ]; then
  REPO="$PAYLOAD/repo"
elif [ -n "${PAYLOAD:-}" ] && [ -d "$PAYLOAD/packages/sandbox" ]; then
  # 也接受直接指向 repo 目录（影子副本、源码树）
  REPO="$PAYLOAD"
else
  echo "错误：找不到载荷目录（设置 PAYLOAD=…）" >&2
  exit 1
fi
DRY="${DRY:-0}"

say() { printf '%s\n' "$*"; }

say "载荷 : $REPO"
say "模式 : $([ "$DRY" = "1" ] && echo 预览 || { [ "$REVERT" = "1" ] && echo 还原 || echo 打补丁; })"

REPO="$REPO" DRY="$DRY" REVERT="$REVERT" node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const repo = process.env.REPO
const dry = process.env.DRY === '1'
const revert = process.env.REVERT === '1'
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

const HELPERS = `
/**
* Absolute, existing paths that must stay READ-ONLY even though they sit inside
* a writable root. The policy only ever subtracts here; nothing is granted.
* Missing paths are dropped: binding a nonexistent source aborts the whole
* confined command, and an absent directory needs no protection yet.
* @param policy - the file-effect policy to read the guarded paths from.
* @returns canonical, deduplicated guarded paths inside the writable roots.
*/
function protectedPaths(policy) {
	if (policy.mode !== "workspace-write") return [];
	const declared = policy.protectedPaths;
	if (!Array.isArray(declared) || declared.length === 0) return [];
	const roots = workspaceWritableRoots(policy);
	const out = [];
	for (const entry of declared) {
		if (typeof entry !== "string" || !entry.startsWith("/") || entry.includes("\\0")) continue;
		const physical = canonicalPath(entry);
		try {
			statSync(physical);
		} catch {
			continue;
		}
		if (!roots.some((root) => physical !== root && physical.startsWith(root.endsWith(sep) ? root : root + sep))) continue;
		out.push(physical);
	}
	return [...new Set(out)];
}
/**
* Whether a write to \`target\` falls inside one of the policy's guarded paths.
* @param policy - the file-effect policy that carries \`protectedPaths\`.
* @param target - an already canonical target path.
* @returns true when the write must be refused.
*/
function isPathProtected(policy, target) {
	if (policy.mode !== "workspace-write") return false;
	const declared = policy.protectedPaths;
	if (!Array.isArray(declared) || declared.length === 0) return false;
	const physical = canonicalPath(target);
	return protectedPaths(policy).some((entry) => physical === entry || physical.startsWith(entry.endsWith(sep) ? entry : entry + sep));
}
`

const EDITS = [
  {
    file: 'packages/sandbox/sandbox/lib/index.js',
    pairs: [
      ['import { resolve } from "node:path";', 'import { resolve, sep } from "node:path";'],
      [
        `\treturn [...new Set([
\t\t...workspaceWritableRoots(policy),
\t\tcanonicalPath("/tmp"),
\t\tcanonicalPath(tmpdir())
\t])];
}`,
        `\treturn [...new Set([
\t\t...workspaceWritableRoots(policy),
\t\tcanonicalPath("/tmp"),
\t\tcanonicalPath(tmpdir())
\t])];
}` + HELPERS,
      ],
      ['workspaceWritableRoots, writableRoots };', 'workspaceWritableRoots, writableRoots, protectedPaths, isPathProtected };'],
    ],
  },
  {
    file: 'packages/sandbox/sandbox-local/lib/index.js',
    pairs: [
      [
        'import { SandboxProvider, SandboxUnavailableError, SandboxUnsupportedPolicyError, canonicalPath, workspaceWritableRoots, writableRoots } from "@deepseek-ai/dsh-sandbox";',
        'import { SandboxProvider, SandboxUnavailableError, SandboxUnsupportedPolicyError, canonicalPath, protectedPaths, workspaceWritableRoots, writableRoots } from "@deepseek-ai/dsh-sandbox";',
      ],
      [
        `\t\targs.push("--tmpfs", "/tmp");
\t\tfor (const root of workspaceWritableRoots(policy)) args.push("--bind", root, root);
\t}`,
        `\t\targs.push("--tmpfs", "/tmp");
\t\tfor (const root of workspaceWritableRoots(policy)) args.push("--bind", root, root);
\t\t/* A later mount wins: re-bind each guarded subtree read-only. */
\t\tfor (const guarded of protectedPaths(policy)) args.push("--ro-bind", guarded, guarded);
\t}`,
      ],
      [
        `\tconst readWrite = ["/dev/null"];
\tif (policy.mode === "workspace-write") readWrite.push("/tmp", ...workspaceWritableRoots(policy));`,
        `\tconst readWrite = ["/dev/null"];
\tif (policy.mode === "workspace-write") {
\t\t/* Landlock grants cannot subtract rights from a descendant, so a root that
\t\tholds a guarded path is dropped entirely (fail closed). */
\t\tconst guarded = protectedPaths(policy);
\t\tconst grantable = workspaceWritableRoots(policy).filter((root) => !guarded.some((entry) => entry.startsWith(root.endsWith("/") ? root : root + "/")));
\t\treadWrite.push("/tmp", ...grantable);
\t}`,
      ],
      [
        `\tconst roots = writableRoots(policy);
\tif (roots.length > 0) forms.push(\`(allow file-write* \${roots.map((root) => \`(subpath \${sbplString(root)})\`).join(" ")})\`);`,
        `\tconst roots = writableRoots(policy);
\tif (roots.length > 0) forms.push(\`(allow file-write* \${roots.map((root) => \`(subpath \${sbplString(root)})\`).join(" ")})\`);
\tfor (const guarded of protectedPaths(policy)) forms.push(\`(deny file-write* (subpath \${sbplString(guarded)}))\`);`,
      ],
    ],
  },
  {
    file: 'packages/fs/fs-sandbox/lib/index.js',
    pairs: [
      ['import { writableRoots } from "@deepseek-ai/dsh-sandbox";', 'import { isPathProtected, writableRoots } from "@deepseek-ai/dsh-sandbox";'],
      [
        '\t\tif (!contained) throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");\n\t\treturn fresh;',
        '\t\tif (!contained) throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");\n\t\tif (isPathProtected(policy, fresh.targetKey)) throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode (protected path)`, "FS_SANDBOX_DENIED");\n\t\treturn fresh;',
      ],
    ],
  },
  {
    file: 'packages/sandbox/sandbox-policy/lib/index.js',
    pairs: [
      [
        '\t\t\tworkspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),\n\t\t\t...this.additionalWritableRoots === void 0 ? {} : { additionalWritableRoots: this.additionalWritableRoots },',
        '\t\t\tworkspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),\n\t\t\t...this.additionalWritableRoots === void 0 ? {} : { additionalWritableRoots: this.additionalWritableRoots },\n\t\t\t/* Capability marker: a plugin may only claim protected subtrees when the host advertises this. */\n\t\t\tprotectedPathsSupported: true,',
      ],
    ],
  },
]

const MARK = 'protectedPathsSupported: true'

function backups(dir, file) {
  const base = path.basename(file)
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.pre-multi-root-hardening-`))
}

if (revert) {
  let restored = 0
  for (const edit of EDITS) {
    const dir = path.dirname(path.join(repo, edit.file))
    const candidates = backups(dir, edit.file).sort()
    if (candidates.length === 0) {
      console.log(`跳过 ${edit.file}（没有备份）`)
      continue
    }
    const source = path.join(dir, candidates[candidates.length - 1])
    if (!dry) {
      fs.chmodSync(source, 0o444)
      fs.copyFileSync(source, path.join(repo, edit.file))
      fs.chmodSync(path.join(repo, edit.file), 0o444)
    }
    console.log(`${dry ? '将还原' : '已还原'} ${edit.file} ← ${path.basename(source)}`)
    restored += 1
  }
  console.log(`完成：${restored} 个文件`)
  process.exit(0)
}

// Idempotence: the marker in the policy service means the contract is present.
const policyPath = path.join(repo, 'packages/sandbox/sandbox-policy/lib/index.js')
if (fs.readFileSync(policyPath, 'utf8').includes(MARK)) {
  console.log('已打过补丁（policy 服务里已有 protectedPathsSupported），无需重复。')
  process.exit(0)
}

const staged = []
for (const edit of EDITS) {
  const target = path.join(repo, edit.file)
  let text = fs.readFileSync(target, 'utf8')
  for (const [old, replacement] of edit.pairs) {
    const hits = text.split(old).length - 1
    if (hits !== 1) {
      console.error(`错误：锚点在 ${edit.file} 命中 ${hits} 次（载荷版本变了？）——未做任何修改`)
      process.exit(1)
    }
    text = text.replace(old, replacement)
  }
  staged.push({ target, text })
}

for (const { target, text } of staged) {
  const dir = path.dirname(target)
  const backup = `${target}.pre-multi-root-hardening-${stamp}`
  fs.chmodSync(dir, 0o755)
  if (dry) {
    const temp = path.join(require('node:os').tmpdir(), `dry-${path.basename(target)}`)
    fs.writeFileSync(temp, text)
    execFileSync(process.execPath, ['--check', temp], { stdio: 'inherit' })
    fs.unlinkSync(temp)
    console.log(`将修改 ${path.relative(repo, target)}（锚点全部命中，语法通过）`)
    continue
  }
  // `.mjs` because `node --check` decides module-ness by extension for temp
  // files with no package.json in scope.
  const temp = `${target}.tmp-${process.pid}.mjs`
  fs.writeFileSync(temp, text)
  fs.chmodSync(temp, 0o644)
  try {
    execFileSync(process.execPath, ['--check', temp], { stdio: 'inherit' })
  } catch (error) {
    fs.rmSync(temp, { force: true })
    console.error(`错误：${path.relative(repo, target)} 补丁后语法检查失败——未落盘`)
    process.exit(1)
  }
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(target, backup)
    fs.chmodSync(backup, 0o444)
  }
  fs.renameSync(temp, target)
  fs.chmodSync(dir, 0o555)
  console.log(`已修改 ${path.relative(repo, target)}（备份 ${path.basename(backup)}）`)
}

console.log(dry ? '预览完成：未落盘。' : '完成：重启桌面后生效。')
NODE
