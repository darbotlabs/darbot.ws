# Atomic: Solana Transaction V1 inspector

[Atomic](/atomic) is three.ws's read-only flight recorder for Solana transactions. It accepts either a confirmed mainnet signature or signed wire bytes and returns the same normalized inspection for legacy, V0, and V1 transactions.

It is built for two jobs:

- Developers can see whether a payload needs V1's 4,096-byte envelope.
- Wallets, relayers, and fee sponsors can read the limits they are actually agreeing to before they co-sign.

Atomic never signs, simulates, or broadcasts a transaction.

## What changed in V1

Legacy and V0 transactions are limited to 1,232 bytes. V1 raises the ceiling to 4,096 bytes and puts the version discriminator at byte zero (`0x81`). V1 does not use address lookup tables.

The important security change is the resource budget. Legacy and V0 carry limits in Compute Budget program instructions. V1 carries them in `transactionConfig` at fixed positions in the message. A sponsor that keeps scanning Compute Budget instructions sees no effective cap on a V1 transaction.

V1 also makes two limits explicit:

- `computeUnitLimit`
- `loadedAccountsDataSizeLimit`

Their V1 defaults are zero. A V1 sender must set both for a transaction that executes and loads account data. Heap size retains its 32 KiB default, and a priority fee remains optional.

## Inspect a confirmed transaction

Open `/atomic`, leave **On-chain signature** selected, and paste a Solana mainnet transaction signature. The report shows:

- exact signed wire size and headroom;
- whether it crosses the old 1,232-byte wall;
- transaction version, signature count, inline accounts, and instruction count;
- normalized compute, account-data, heap, and priority-fee limits;
- confirmed compute consumption when the RPC supplies it;
- a sponsor assessment that calls out missing V1 limits.

The signature is stored in the page URL, so the inspection can be shared.

## Inspect a handoff before co-signing

Select **Base64 wire** and paste the base64 string passed between a builder, wallet, relayer, facilitator, or paymaster. The API decodes it without contacting an RPC.

```bash
curl https://three.ws/api/solana/atomic \
  -H 'content-type: application/json' \
  -d '{"transaction":"BASE64_SIGNED_TRANSACTION"}'
```

The response is JSON-safe. Priority fees and other wide integers are returned as numbers when they fit safely, otherwise as decimal strings.

## API

### Mainnet activation status

```bash
curl https://three.ws/api/solana/atomic
```

This reads the `txv1` feature account and the current confirmed slot through the rotating three.ws RPC rail. The response includes the activation slot and both wire limits.

### Confirmed signature

```bash
curl 'https://three.ws/api/solana/atomic?signature=SOLANA_SIGNATURE'
```

The RPC request always passes `maxSupportedTransactionVersion: 1`. Confirmed results are cached because their wire bytes and metadata are immutable.

### Raw transaction

```http
POST /api/solana/atomic
Content-Type: application/json

{ "transaction": "BASE64_SIGNED_TRANSACTION" }
```

The raw path is not cached and does not send the transaction to Solana.

## Platform compatibility

Every three.ws Solana transaction read now opts into version 1. The web app and API dependency floor is `@solana/kit` 8.3 and `@solana/web3.js` 1.99, so direct readers can decode V1 rather than rejecting it as an unsupported transaction version.

New senders should use `@solana/kit` 8 or later, build with `createTransactionMessage({ version: 1 })`, set the transaction config explicitly, check wallet V1 capability, and only then request a signature.

## Sources

- [Solana Transaction V1 guide](https://solana.com/docs/core/transactions/versioned-transactions)
- [SIMD-0385: Transaction V1 format](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md)
- [SIMD-0296: larger transactions](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0296-larger-transactions.md)
- [Runnable V1 examples](https://github.com/solana-foundation/transaction-v1-examples)
