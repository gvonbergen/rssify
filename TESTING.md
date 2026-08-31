# Testing RSSify

RSSify uses the Node.js built-in `node:test` runner and `node:assert/strict`; no new test framework, coverage package, or other dependency is required. The suite runs TypeScript directly on the supported Node 25 runtime.

## Run locally

```sh
npm ci                 # first checkout or after lockfile changes
npm run typecheck
npm test
```

`npm test` sets `TZ=UTC` so cron and date assertions are deterministic. Tests use temporary directories and in-memory/mock HTTP boundaries. They do not read the repository's `.env`, `config.yaml`, `data/`, or logs, make external network calls, or leave state behind.

## Extending the suite

- Add a `test/*.test.ts` file using `test()` from `node:test` and strict assertions.
- Prefer testing exported pure helpers directly. Use injected backend objects for scraper tests rather than network calls.
- For persistence and route tests, use `makeTempDir()` / `openTempDb()` from `test/helpers.ts`; close databases and remove temporary directories in `finally` blocks.
- Keep route tests at the Hono `app.request()` boundary. This exercises HTTP status, headers, and response bodies without binding a port.
- Include malformed input, missing records, empty input, Unicode, and cleanup/isolation cases where they are relevant.
- If a test needs a new seam, keep it behavior-preserving and document the reason in the source comment.

The GitHub Actions workflow runs `npm ci`, `npm run typecheck`, and `npm test` on Node 25 for pushes and pull requests.
