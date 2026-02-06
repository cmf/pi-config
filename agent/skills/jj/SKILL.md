---
name: jj
description: Practical, non-interactive guidance for working with the Jujutsu (jj) VCS in colocated Git repos
---

# Jujutsu (jj) Skill

Use this when working in a repo with `.jj/` or when the user mentions jj/Jujutsu. Repos are colocated with Git, but **use jj commands by default**; only use git if jj has no equivalent.

## Non-Interactive Rules (Required)
Always use non-interactive forms to avoid editor prompts.

**Always include `-m` for message-based commands:**
```bash
jj desc -m "message"
jj new -m "message"
jj squash -m "message"
jj commit -m "message"
```

**Avoid interactive/diff-editor commands:**
- Avoid: `jj diffedit`, `jj split` (no filesets), `jj resolve` (interactive), `jj squash -i`, `jj restore -i`, any `--tool` option.
- Prefer:
  - `jj split -m "msg" <files>`
  - `jj resolve --list` then edit conflict markers manually and `jj squash`
  - `jj restore <files>`

## Core Concepts
- **Working copy is a commit (`@`)**; no staging area.
- **Commits are mutable**; refine freely with squash/split/absorb.
- **Change IDs** are stable across rewrites; **Commit IDs** change with content.
- **Conflicts don’t block**; can resolve later.
- **Operations log** enables undo/redo and full repo restore.

## Essential Commands
```bash
jj st                         # Status
jj diff --git --color=never    # Working copy diff (always use git-style for clarity)
jj log -r <revset> [-p]        # History
jj show -r <rev>               # Show revision
jj new [-m "msg"] [<base>]    # New commit
jj edit <rev>                  # Edit existing commit
jj desc -r <rev> -m "msg"     # Update description
jj squash                      # Move changes into parent
jj split -r <rev> <paths> -m "msg"  # Split commit
jj absorb                      # Auto-distribute changes into ancestors
jj abandon <rev>               # Drop commit
jj restore <files>             # Discard changes to files
```

## Diff formatting (Critical for AI/harnesses)

`jj diff` defaults to an inline/word-diff format (`:color-words`) that relies on ANSI styling.
If ANSI codes are stripped (common in logs / agent harnesses), edits can appear as *merged tokens*
like `status: openclosed`, which can mislead an agent into thinking files are corrupted.

**Rules:**
- When you need to *read/interpret* diffs in an agent loop, prefer:
  - `jj diff --git --color=never`
- Avoid using the default inline format in transcripts.

## Revsets / Filesets / Templates
JJ uses DSLs for selection and output.

**Revsets (examples):**
```bash
@, @-, @--              # Working copy, parent, grandparent
::@                     # Ancestors
@::                     # Descendants
conflicted()            # Revisions with conflicts
mine()                  # Your changes
change_id(abc)          # Change ID prefix lookup
A | B, A & B, A ~ B      # Union, intersection, difference
```

**Filesets:** regular paths are valid filesets; globs are default.
```bash
jj diff --git --color=never 'src/*.rs'        # Glob by default
jj diff --git --color=never 'cwd:"src/*.rs"'  # Literal path when needed
```

## Common Pitfalls

0) **Diff output can be misleading if ANSI styles are stripped**

If you see “corrupted-looking” lines like `openclosed`, it’s usually the inline diff formatter.
Re-run with:

```bash
jj diff --git --color=never
```

Or set it permanently:

```bash
jj config set --user ui.diff-formatter :git
```

1) **Use `-r` not `--revisions`:**
```bash
jj log -r xyz          # ✅
jj log --revisions xyz # ❌
```

2) **Use `--no-edit` for parallel branches:**
```bash
jj new parent -m "A"; jj new -m "B"                             # ❌ B is child of A!
jj new --no-edit parent -m "A"; jj new --no-edit parent -m "B"  # ✅ both children of parent
```

3) **Quote revsets in the shell:**
```bash
jj log -r 'description(substring:"[todo]")'
```

4) **Use `-o`/`--onto` instead of `-d`/`--destination`:**
```bash
jj rebase -s xyz -o main   # ✅
jj rebase -s xyz -d main   # ⚠️ deprecated
```

5) **Symbol expressions are stricter:**
```bash
jj log -r abc              # ❌ if ambiguous
jj log -r 'change_id(abc)' # ✅ explicit prefix lookup
jj log -r 'bookmarks(abc)' # ✅ bookmark name patterns
```

6) **Glob patterns are default in filesets:**
```bash
jj diff --git --color=never 'src/*.rs'         # glob
jj diff --git --color=never 'cwd:"src/*.rs"'   # literal path
```

## Bookmarks (Branches)
```bash
jj bookmark create name
jj bookmark move name -r <rev>
jj bookmark list
jj bookmark delete name
```

**Reminder:** bookmarks do not auto-advance. Move them before pushing.

## Git Integration (Colocated Repos)
- Prefer jj for all version control operations.
- Use git only when jj lacks an equivalent.
- When pushing, use jj’s git subcommands:
```bash
jj git push -b <bookmark>
jj git fetch
```

## Operations Log / Recovery
```bash
jj undo                   # Undo last operation (repeatable)
jj redo                   # Redo undone operation
jj op log                 # List operations
jj op restore <op-id>     # Restore full repo to operation
```

## Workspaces
```bash
jj workspace add <path> --name <name>
jj workspace list
jj workspace root
jj workspace forget <name>  # then rm -rf <path>
jj workspace update-stale
```
**Gotcha:** ignored files (e.g., `.env`, `node_modules`) are not shared.

## Tips
- Prefer **change IDs** in commands for stability.
- Quote revsets in the shell: `jj log -r 'description(substring:"fix")'`.
- `jj help -k revsets|filesets|templates` for detailed syntax.
- `jj help -k bookmarks` (bookmarks vs git branches, push/fetch)
- `jj help -k workspaces`
- `jj help -k rebase`
- `jj <command> --help` for command-specific flags
