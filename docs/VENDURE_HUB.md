# Vendure Hub listing (draft — not submitted)

**Name:** Spraay Payouts: USDC batch payouts on Base
**Package:** `@plagtech/vendure-spraay-plugin`
**Author:** Plagtech
**License:** MIT
**Repository:** https://github.com/plagtech/vendure-spraay-plugin
**Category:** Payments / Marketplace
**Vendure compatibility:** `^3.6.0-0` (tested on 3.6.5 and 3.8.0)

## Short description

Admin-approved, noncustodial USDC payouts to up to 200 sellers per transaction on Base, with on-chain verification and duplicate-payment protection.

## Long description

Multi-vendor Vendure marketplaces can record what each seller is owed and pay sellers in batches through the Spraay batch contract on Base.

Batches need explicit administrator approval, with optional four-eyes approval. The merchant's own wallet signs each payout; the plugin never holds keys. Sellers are marked paid only after the receipt, calldata, contract event and every USDC transfer have been verified at a configurable confirmation depth.

Built-in recovery covers reverted, dropped, replaced and stuck transactions. Duplicate payments are prevented with idempotency keys, line locking, pinned nonces and a per-sender lock, and a duplicate execution that somehow happens anyway is detected.

## Key features

- Batches of up to 200 recipients, with lines combined per seller address
- Exact integer USDC amounts (6 decimals) from end to end
- Separate permissions for viewing, managing and approving payouts
- Gateway responses are checked against the approved batch before anything is signed
- Audit log for every state change
- Read-only scheduled reconciliation

## Requirements

- A Base mainnet RPC endpoint
- A merchant-controlled EOA funded with USDC
- An x402-capable fetch for Spraay gateway fees

## Screenshots

None yet. v1 has no Dashboard UI; the workflow runs through the Admin API.
