---
name: fetch
description: Fetch web page content via Exa API. Use when needing to retrieve the full text content of specific URLs - documentation pages, articles, or any web content where the URL is already known.
---

## How to Fetch

Use the `exa-fetch` script in this directory:

```bash
exa-fetch URL...
```

### Options

- `--help` - Show usage information

### Examples

```bash
# Fetch a single page
exa-fetch https://plugins.jetbrains.com/docs/intellij/coroutine-scopes.html

# Fetch multiple pages
exa-fetch https://example.com/page1 https://example.com/page2
```

## Response Format

For each URL, the output shows:

1. **URL** - The page URL
2. **Title** - As an h1 heading
3. **Text** - The full page content in markdown

Multiple pages are separated by `---`.
