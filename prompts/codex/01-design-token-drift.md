# Codex 01: design-token drift

You are working in the three.ws repo. Read `AGENTS.md` and `CLAUDE.md` first and follow them.
Then read `DESIGN-TOKENS.md` so you know the token set.

## Setup: work in your own worktree

Other agents edit `main` in the shared checkout at the same time, so do not work there:

```bash
cd /workspaces/three.ws
git worktree add -b codex/design-tokens /workspaces/wt-codex-tokens main
cp -al node_modules /workspaces/wt-codex-tokens/node_modules
cd /workspaces/wt-codex-tokens
```

Do all work and commits inside `/workspaces/wt-codex-tokens` on the `codex/design-tokens` branch.

## Goal

The platform's CSS has drifted off its design tokens: pages hardcode hex colors that already
exist as CSS variables, so theme changes and dark mode miss them. Put colors back on tokens.

## Part 1: make the gate green (small, do this first)

`npm run audit:tokens` currently fails:

```
design-token drift increased: 3 hardcoded token-hexes (baseline 0).
  public/sonar.css: 3 (was 0)
  #4ade80 -> var(--success)
  #f87171 -> var(--danger)
```

Replace those hexes in `public/sonar.css` with the variables the audit names. Re-run
`npm run audit:tokens` until it exits 0. Commit that alone, e.g.
`fix(sonar): use the success and danger tokens instead of hardcoded hex`.

## Part 2: sweep the rest, one directory per commit

1. Find hardcoded hexes that EXACTLY equal a canonical token value (the audit script,
   `scripts/audit-token-drift.mjs`, shows how it maps hex to token; reuse its logic, do not
   invent a new mapping).
2. Work one directory or page at a time (for example `public/`, then `src/`, then `pages/`).
   Replace exact matches with `var(--token)`.
3. Leave a hex alone when it is NOT an exact token value, or when a file deliberately re-themes a
   token. For a deliberate re-theme, define the token locally in that file's theme layer instead.
   Never change what a color looks like; this is a refactor, not a redesign.
4. Skip generated or vendored output: `dist/`, `dist-lib/`, `node_modules/`, anything under
   `*/build/`, minified files, and third-party CSS.
5. After each directory: run `npm run audit:tokens`, then
   `npm run check:rules -- --paths <files you changed>`, then commit only those paths with a
   specific message such as `refactor(css): move public/ page colors onto design tokens`.
6. Keep a running count in your final report: raw exact-token hexes before and after.

## Hard limits

- No visual changes. If you are unsure whether a swap changes rendering, leave it.
- No `git push`, no deploy, no edits outside CSS/HTML/JS styling code.
- Do not touch `data/changelog.json` for this; it is an internal refactor.
- No em-dash or en-dash characters anywhere, including commit messages.

## Finish

Stop when you run out of exact-match hexes or session budget. Report: commits made (hash and
subject), hex count before and after, any file you skipped and why. Leave the branch unpushed;
the owner merges it.
