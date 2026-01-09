---
name: tickets
description: Guide for how to use the tk ticket tracking system
---

# Ticket System Usage Guide

This documents how to use **tk**, a git-backed ticket tracker. Tickets are markdown files with YAML frontmatter stored in `.tickets/` inside a project.

Run `tk help` for the full command reference.

## Task Workspaces

When working in a jj task workspace (under `~/.workspaces`), use `tk-current` to view the current ticket:

```bash
tk-current    # Outputs the full path to the in-progress ticket file
```

This verifies you're in a valid task workspace and that exactly one ticket is in progress. Use the path to read or update the ticket file as you work.

## Track All Work With Tickets

BEFORE starting any task:

1. Check for existing tickets: `tk ls` or `tk ready`
2. If none exists, create one: `tk create "Title" -d "Description..."`
3. Start work: `tk start <id>`

WHILE working:

4. Update the ticket file as you work - add analysis, progress notes, check off items
5. Commit code changes together with ticket file updates in the same commit

WHEN completing:

6. Add a `## Summary of Changes` section describing what was done
7. Close the ticket: `tk close <id>`

## Finding Work

```bash
# List all tickets
tk ls

# List tickets ready to work on (open/in_progress with all deps closed)
tk ready

# List blocked tickets (have unresolved dependencies)
tk blocked

# List recently closed tickets
tk closed

# View a specific ticket
tk show <id>

# Query tickets as JSON (requires jq)
tk query                           # All tickets as JSON
tk query 'select(.status=="open")' # Filter with jq
```

## Creating Tickets

```bash
tk create "Title"
tk create "Title" -d "Description text"
tk create "Title" -t bug -p 1              # Type and priority
tk create "Title" --parent <id>            # Set parent ticket
```

Options:
- `-d, --description` - Description text
- `-t, --type` - bug|feature|task|epic|chore (default: task)
- `-p, --priority` - 0-4, 0=highest (default: 2)
- `-a, --assignee` - Assignee name
- `--parent` - Parent ticket ID
- `--design` - Design notes
- `--acceptance` - Acceptance criteria
- `--external-ref` - External reference (e.g., gh-123)

## Managing Status

Valid statuses: `open`, `in_progress`, `closed`

```bash
tk start <id>              # Set to in_progress
tk close <id>              # Set to closed
tk reopen <id>             # Set to open
tk status <id> <status>    # Set arbitrary status
```

## Dependencies

```bash
tk dep <id> <dep-id>       # id depends on dep-id
tk undep <id> <dep-id>     # Remove dependency
tk dep tree <id>           # Show dependency tree
```

## Links (Symmetric Relationships)

```bash
tk link <id> <id> [id...]  # Link tickets together
tk unlink <id> <target-id> # Remove link
```

## Editing Tickets

```bash
tk show <id>               # Display ticket contents
tk edit <id>               # Open in $EDITOR
tk add-note <id> "text"    # Append timestamped note
echo "note" | tk add-note <id>  # Note from stdin
```

## Partial ID Matching

All commands support partial ID matching:
```bash
tk show 5c4                # Matches nw-5c46
tk close 5c4               # Same ticket
```

## Ticket File Structure

Tickets are markdown files with YAML frontmatter. Edit directly with `tk edit <id>` or your editor.

```markdown
---
id: xx-1234
title: Example ticket
status: open
deps: []
links: []
created: 2026-01-07T12:00:00Z
type: task
priority: 2
assignee: name
parent: xx-5678
---
# Example ticket

Description text goes here immediately after the title heading.
This is set by `-d, --description` on create.

## Design

Design notes go here. Set by `--design` on create.

## Acceptance Criteria

Acceptance criteria go here. Set by `--acceptance` on create.

## Notes

Add notes via `tk add-note <id> "text"`.
Each note is timestamped automatically.
```

When updating tickets manually:
- **Description**: Write directly below the `# Title` heading, before any `##` sections
- **Design**: Add/update the `## Design` section
- **Acceptance Criteria**: Add/update the `## Acceptance Criteria` section
- **Notes**: Use `tk add-note`
- **Progress/Analysis**: Add custom sections like `## Analysis`, `## Progress`, `## Summary of Changes` as needed
