---
name: intellij-extension-point-implementations
description: Find public IntelliJ plugin implementations of extension points using JetBrains Marketplace APIs. Use when asked to discover which plugins implement a specific extension point, extract implementation class names, or generate source-code search links.
---

Use this skill to map an IntelliJ extension point to real plugin implementations.

## Quick start

Run the bundled script:

```bash
scripts/find_ep_impls.sh <extension-point-fqn>
```

Example:

```bash
scripts/find_ep_impls.sh com.intellij.lang.formatter.restriction
```

The script returns JSON with:
- `marketplaceMatches`: number of plugin matches from GraphQL search
- `pluginFilter`: active plugin filter (or `null`)
- `results[].plugin`: plugin metadata
- `results[].implementations`: extension declarations filtered to the requested interface
- `results[].searchRawFiles`: resolved search hits as `{path, rawUrl}` objects (for example implementation, tests, and registration XML files when found)
- `results[].githubRawFiles`: optional raw source files keyed by implementation class (when `--fetch-github-raw` is used and the repository is on GitHub)

## Parameters

```bash
scripts/find_ep_impls.sh <extension-point-fqn> [--max N] [--offset N] [--plugin NAME_OR_ID_OR_XMLID] [--fetch-github-raw] [--raw-max-bytes N]
```

- `--max`: page size for marketplace search (default `20`)
- `--offset`: pagination offset (default `0`)
- `--plugin`: filter by plugin name substring, exact plugin id, or exact plugin xmlId
- `--fetch-github-raw`: for GitHub repositories, resolve implementation classes to raw source files
- `--raw-max-bytes`: truncate raw file content in output to this many bytes (default `12000`)

Set `GITHUB_TOKEN` to enable GitHub code search API for `searchRawFiles` when unauthenticated search is restricted.

Use pagination when you need more than one page of results.

## Manual fallback (curl only)

If script execution fails or needs debugging, follow `references/api_reference.md` for raw curl requests:
1. GraphQL search (`/api/search/graphql`) on `fields.extensionPoints`
2. Per-plugin details (`/api/plugins/{id}/extension-points`)
3. Optional code search URLs (`/api/source-code-search`)
4. Optional search-hit resolution to `{path, rawUrl}` using GitHub search API and GitHub tree fallback
5. Optional GitHub raw fetch (GitHub REST `repos/{owner}/{repo}/git/trees/{branch}?recursive=1` + `raw.githubusercontent.com`)
