#!/usr/bin/env bash
# 把同一个分支同时推到 origin 的每条 push URL（Forgejo + GitHub），每条腿独立重试。
#
#   bash scripts/push-both.sh              # 推 master
#   bash scripts/push-both.sh <branch>
#   TRIES=8 SLEEP=5 bash scripts/push-both.sh
#
# 为什么不用 `git push` 自带的双 pushurl：两条腿里任何一条被网络/代理掐掉，整条命令
# 都返回失败，而另一条其实可能已经成功；事后还得自己判断哪边落后。这里逐条推、
# 逐条用 ls-remote 校验，失败只落在那一条腿上，且重试到同步或次数用尽。
set -uo pipefail

BRANCH="${1:-master}"
TRIES="${TRIES:-6}"
SLEEP="${SLEEP:-3}"

# 沙箱里 OpenSSH 会把宿主机的 root 属主读成 nobody，进而对 /etc/ssh/ssh_config.d/*
# 报 Bad owner or permissions（宿主机无此问题）；固定 -F 指向用户自己的 config。
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -F $HOME/.ssh/config -o BatchMode=yes -o IdentitiesOnly=yes}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

mapfile -t URLS < <(git remote get-url --push --all origin 2>/dev/null)
if [ "${#URLS[@]}" -eq 0 ]; then
  echo "错误：origin 没有 push URL" >&2
  exit 1
fi

LOCAL="$(git rev-parse "$BRANCH" 2>/dev/null)" || { echo "错误：本地没有分支 $BRANCH" >&2; exit 1; }
SHORT="${LOCAL:0:7}"
echo "分支 $BRANCH → $SHORT，目标 ${#URLS[@]} 个（每条最多 $TRIES 次）"

failed=0
for url in "${URLS[@]}"; do
  label="$(printf '%s' "$url" | sed -E 's#^[a-z+]*://([^@/]*@)?##; s#/$##')"
  synced=0
  for attempt in $(seq 1 "$TRIES"); do
    out="$(git push "$url" "$BRANCH" 2>&1)"
    rc=$?
    remote="$(git ls-remote "$url" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
    if [ "$remote" = "$LOCAL" ]; then
      state="$(printf '%s' "$out" | grep -qE 'up-to-date|Everything up-to-date' && echo '已是最新' || echo '已更新')"
      echo "  ✓ $label  $state（第 $attempt 次）"
      synced=1
      break
    fi
    reason="$(printf '%s' "$out" | tail -1)"
    echo "  … $label  第 $attempt 次未同步：${reason:-rc=$rc}"
    [ "$attempt" -lt "$TRIES" ] && sleep "$SLEEP"
  done
  if [ "$synced" -eq 0 ]; then
    echo "  ✗ $label  重试用尽，远端仍不是 $SHORT" >&2
    failed=$((failed + 1))
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "有 $failed 条腿没推上去；网络恢复后重跑本脚本即可（幂等）。" >&2
  exit 1
fi
echo "全部同步：$SHORT"
