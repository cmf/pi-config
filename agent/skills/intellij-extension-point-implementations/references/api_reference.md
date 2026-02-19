# IntelliJ Platform Explorer API Notes

Use these endpoints from `https://plugins.jetbrains.com`.

## 1) Find plugins that register an extension point

POST `/api/search/graphql`

GraphQL query template:

```graphql
{ plugins(search: {
    max: 20,
    offset: 0,
    filters: [
      { field: "fields.extensionPoints", value: "com.intellij.lang.formatter.restriction" },
      { field: "hasSource", value: "true" },
      { field: "family", value: "intellij" }
    ],
    sortBy: UPDATE_DATE
  }) {
    total,
    plugins {
      id,
      name,
      xmlId,
      sourceCodeUrl,
      link,
      lastUpdateDate
    }
  }
}
```

## 2) Get concrete extension implementations for one plugin

GET `/api/plugins/{pluginId}/extension-points`

Filter by `interfaceName == <extension-point-fqn>`.

## 3) Build source-code search URLs for implementation classes (optional)

POST `/api/source-code-search`

JSON body:

```json
{
  "repositoryUrl": "https://github.com/intellij-solidity/intellij-solidity/",
  "targets": ["me.serce.solidity.ide.formatting.SolidityFormattingRestriction"]
}
```

Response includes `sourceCodeSearchUrls`.

## 4) Execute source-code searches and resolve to `{path, rawUrl}` (optional)

For GitHub repositories (`https://github.com/<owner>/<repo>`):

1. Use `/api/source-code-search` output URLs (query usually based on short class name)
2. Execute search via GitHub code search API:
   - `GET https://api.github.com/search/code?q={query}+repo:{owner}/{repo}`
3. Convert each path to raw URL:
   - `https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/{path}`
4. If code search API returns no items (for example unauthenticated), fall back to repository tree filtering:
   - `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1`

The script returns those hits under `searchRawFiles` as objects with `path` and `rawUrl`.

Note: GitHub code search requires authentication for many environments. Use `GITHUB_TOKEN` for reliable results.

## 5) Fetch raw implementation file content (optional)

When `--fetch-github-raw` is enabled, the script also fetches raw contents for matched implementation class files and returns them under `githubRawFiles`.
