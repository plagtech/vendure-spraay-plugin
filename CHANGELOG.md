# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- `SpraayPayoutPlugin` for Vendure `^3.6.0-0`, pinned to Base mainnet and USDC.
- Payout lines with unique idempotency keys; batches of up to 200 recipients, combined per address.
- Approval tied to the batch content hash, with optional four-eyes approval (`requireDistinctApprover`).
- Integration with the Spraay gateway's `POST /api/v1/batch/execute` and `POST /api/v1/batch/estimate`, x402 through a pluggable `gatewayFetch`.
- Gateway response verification: calldata, contract, chain, value, gas limit, and allowance checked against the live `feeBps()`.
- Noncustodial signing: allowance requests, signing requests with a pinned nonce, verification of signed bytes, relaying after the hash is committed, and reporting of self-broadcast hashes.
- Settlement verification: receipt, calldata, `SprayTokenExecuted` event and USDC `Transfer` logs at a configurable confirmation depth.
- Recovery: detection of reverted, dropped, replaced and unreported transactions; nonce-burn cancellation; duplicate-execution detection; a `NEEDS_REVIEW` workflow.
- Per-sender lock, audit log, and a read-only scheduled reconciliation task.
- Unit tests, e2e tests on an anvil fork of Base mainnet, and a local demo.
