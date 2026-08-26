#!/usr/bin/env bash
# 统计 dsh-backup 收到的真实用户反馈数。
# 口径：排除作者 xiaoyuyu6420 自己的发言；同一用户在同一来源只按内容条数计（一条评论/回复/issue = 一条反馈）。
# 来源：
#   1. xiaoyuyu6420/dsh-backup 的 issues（含关闭）正文 + 评论
#   2. xiaoyuyu6420/dsh-backup 的 discussions 帖子 + 评论 + 回复
#   3. deepseek-ai/deepseek-harness discussion #4644（自荐帖）的评论 + 回复
#   4. dshoneys/awesome-dshoneys issue #19（投稿）的评论
# 输出：JSON（stdout），含 total / perSource / users
set -euo pipefail

AUTHOR="xiaoyuyu6420"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- 1. 本仓库 issues（正文 + 评论）---
gh api graphql -f query='
{
  repository(owner: "xiaoyuyu6420", name: "dsh-backup") {
    issues(first: 100, states: [OPEN, CLOSED]) {
      nodes {
        number author { login }
        comments(first: 100) { nodes { author { login } } }
      }
    }
  }
}' --jq '.data.repository.issues.nodes[] | {number, author: .author.login,
     commenters: [.comments.nodes[].author.login]}' > "$tmp/issues.jsonl"

# --- 2. 本仓库 discussions（帖子 + 评论 + 回复）---
gh api graphql -f query='
{
  repository(owner: "xiaoyuyu6420", name: "dsh-backup") {
    discussions(first: 100) {
      nodes {
        number author { login }
        comments(first: 100) { nodes { author { login } replies(first: 20) { nodes { author { login } } } } }
      }
    }
  }
}' --jq '.data.repository.discussions.nodes[] | {number, author: .author.login,
     comments: [.comments.nodes[] | {author: .author.login, repliers: [.replies.nodes[].author.login]}]}' > "$tmp/discussions.jsonl"

# --- 3. 官方仓库自荐帖 #4644 的评论 + 回复 ---
gh api graphql -f query='
{
  repository(owner: "deepseek-ai", name: "deepseek-harness") {
    discussion(number: 4644) {
      comments(first: 100) { nodes { author { login } replies(first: 20) { nodes { author { login } } } } }
    }
  }
}' --jq '.data.repository.discussion.comments.nodes[] | {author: .author.login,
     repliers: [.replies.nodes[].author.login]}' > "$tmp/showpost.jsonl" 2>/dev/null || echo -n > "$tmp/showpost.jsonl"

# --- 4. dshoneys 投稿 issue #19 的评论 ---
gh api repos/dshoneys/awesome-dshoneys/issues/19/comments --jq '.[] | {author: .user.login}' > "$tmp/dshoneys.jsonl" 2>/dev/null || echo -n > "$tmp/dshoneys.jsonl"

python3 - "$tmp" "$AUTHOR" <<'PYEOF'
import json, sys, subprocess, datetime

tmp, author = sys.argv[1], sys.argv[2]
sources = {}
users = {}  # login -> set of sources

def add(src, login, n=1):
    if not login or login == author or login in ("github-actions", "github-actions[bot]", "vercel[bot]", "renovate[bot]"):
        return
    sources[src] = sources.get(src, 0) + n
    users.setdefault(login, set()).add(src)

# issues：正文 1 条 + 每条非作者评论 1 条
for line in open(f"{tmp}/issues.jsonl"):
    if not line.strip(): continue
    d = json.loads(line)
    add("dsh-backup issues", d["author"], 1)
    for c in d.get("commenters", []):
        add("dsh-backup issues", c, 1)

# discussions：他人开的帖子算 1，每条评论/回复算 1
for line in open(f"{tmp}/discussions.jsonl"):
    if not line.strip(): continue
    d = json.loads(line)
    add("dsh-backup discussions", d["author"], 1)
    for c in d.get("comments", []):
        add("dsh-backup discussions", c["author"], 1)
        for r in c.get("repliers", []):
            add("dsh-backup discussions", r, 1)

# 官方自荐帖
for line in open(f"{tmp}/showpost.jsonl"):
    if not line.strip(): continue
    d = json.loads(line)
    add("official show post #4644", d["author"], 1)
    for r in d.get("repliers", []):
        add("official show post #4644", r, 1)

# dshoneys 投稿
for line in open(f"{tmp}/dshoneys.jsonl"):
    if not line.strip(): continue
    d = json.loads(line)
    add("dshoneys #19", d["author"], 1)

total = sum(sources.values())
out = {
    "counted_at": datetime.datetime.now().isoformat(timespec="seconds"),
    "total": total,
    "goal": 200,
    "per_source": sources,
    "distinct_users": len(users),
    "users": {u: sorted(s) for u, s in sorted(users.items())},
}
print(json.dumps(out, ensure_ascii=False, indent=2))
PYEOF
