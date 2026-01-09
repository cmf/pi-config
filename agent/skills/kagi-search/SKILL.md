---
name: kagi-search
description: Web search and content extraction via Kagi Search API. Use for searching documentation, facts, or any web content.
---

## How to Search

Use the `kagi-search` script in this directory:

```bash
kagi-search [OPTIONS] QUERY...
```

### Options

- `--limit N` - Limit the number of results
- `--help` - Show usage information

### Examples

```bash
# Basic search
kagi-search clojure repl development

# Limit results
kagi-search --limit 5 intellij plugin kotlin

# Search with phrases
kagi-search "exact phrase" other words
```

## Response Format

The formatted output shows:

1. **Search Results**: Title (as heading), URL, and snippet (if available)
2. **Related Searches**: List of related search terms (when returned by API)
