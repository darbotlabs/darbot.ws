# Pump.fun upstream watch

This is the operating contract for keeping three.ws current with the official
Pump.fun npm packages and public repositories.

## The check

Run it locally whenever a Pump.fun dependency is in question, and before any
wave of SDK work:

```bash
npm run pump:watch
```

The command discovers every current `@pump-fun/*` npm package, compares their
`latest` tags and every public repository under `pump-fun` with
`data/pump-upstream-baseline.json`. A new package, package version, removed
package, new repository, removed repository, or repository push exits with
status 2 and prints a review report. Nothing runs it on a schedule: this repo
uses no GitHub Actions, and the check writes its baseline back into the repo, so
it belongs in a local run that a human reviews and commits. Dependabot
separately opens dependency pull requests for `@pump-fun/*`.

After reviewing and integrating an upstream change, acknowledge the exact
state in the same pull request:

```bash
npm run pump:watch -- --accept
```

IDL refreshes are deterministic and use the official public docs first:

```bash
npm run pump:refresh-idls
```

## Current upstream feature boundary

`@pump-fun/pump-sdk 2.0.0` adds protocol-native holder-reward coins, deprecates
cashback for new launches, consolidates creator/fee changes into the CTO flow,
and expands bonding-curve, global, trade, and admin event layouts.
`@pump-fun/pump-swap-sdk 1.20.0` adds current quote-mint-aware fee collection,
canonical pool derivation, and pricing/state support.

three.ws exposes holder-reward creation through connected-wallet, autonomous
agent-wallet, and x402 paid launch paths. Its fee inspector identifies the
holder-rewards destination and does not present creator-only claim or delegation
controls for those coins.
