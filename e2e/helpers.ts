import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    createPublicClient,
    createWalletClient,
    Hex,
    http,
    parseTransaction,
    PublicClient,
    WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { erc20Abi } from '../src/chain/abi';
import { SPRAAY_BATCH_CONTRACT_BASE, USDC_BASE } from '../src/constants';

/** Anvil's well-known default account #0. Only ever used against a local fork. */
export const MERCHANT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const merchant = privateKeyToAccount(MERCHANT_KEY);

export function findAnvil(): string | undefined {
    const candidates = [
        process.env.ANVIL_PATH,
        path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil'),
        'anvil',
    ].filter(Boolean) as string[];
    return candidates.find(c => c === 'anvil' || fs.existsSync(c));
}

export async function startAnvilFork(port: number, forkUrl = process.env.BASE_FORK_URL ?? 'https://mainnet.base.org') {
    const bin = findAnvil();
    if (!bin) throw new Error('anvil not found (install Foundry or set ANVIL_PATH)');
    const proc: ChildProcess = spawn(bin, ['--fork-url', forkUrl, '--port', String(port), '--silent'], { stdio: 'ignore' });
    const rpcUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
            });
            if (res.ok) break;
        } catch {
            // not up yet
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { rpcUrl, stop: () => proc.kill() };
}

/**
 * Stands in for the merchant's own wallet (a browser wallet, hardware wallet, Safe signer…).
 * The plugin only ever sees the *signed* bytes produced here.
 */
export class MerchantWallet {
    readonly publicClient: PublicClient;
    readonly walletClient: WalletClient;
    readonly address = merchant.address;

    constructor(readonly rpcUrl: string) {
        this.publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) }) as PublicClient;
        this.walletClient = createWalletClient({ account: merchant, chain: base, transport: http(rpcUrl) });
    }

    async rpc(method: string, params: unknown[] = []) {
        return this.publicClient.request({ method: method as any, params: params as any });
    }

    async dealUsdc(to: string, amount: bigint) {
        await this.rpc('anvil_dealERC20', [to, USDC_BASE, '0x' + amount.toString(16)]);
    }

    async mine(blocks: number) {
        await this.rpc('anvil_mine', ['0x' + blocks.toString(16)]);
    }

    async setAutomine(enabled: boolean) {
        await this.rpc('evm_setAutomine', [enabled]);
    }

    usdcBalance(owner: string) {
        return this.publicClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Hex] });
    }

    allowance(owner: string = this.address) {
        return this.publicClient.readContract({
            address: USDC_BASE,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner as Hex, SPRAAY_BATCH_CONTRACT_BASE],
        });
    }

    /** Signs a SpraayTransactionRequest exactly as given (pinned nonce and gas when present). */
    async sign(request: { to: string; data: string; value: string; chainId: number; nonce?: number | null; gas?: string | null }, overrides: Record<string, unknown> = {}) {
        const prepared = await this.walletClient.prepareTransactionRequest({
            account: merchant,
            chain: base,
            to: request.to as Hex,
            data: request.data as Hex,
            value: BigInt(request.value),
            ...(request.nonce != null ? { nonce: request.nonce } : {}),
            ...(request.gas ? { gas: BigInt(request.gas) } : {}),
            ...overrides,
        } as any);
        return merchant.signTransaction(prepared as any);
    }

    async broadcast(raw: Hex) {
        return this.publicClient.sendRawTransaction({ serializedTransaction: raw });
    }

    async signAndSend(request: Parameters<MerchantWallet['sign']>[0], overrides: Record<string, unknown> = {}) {
        const raw = await this.sign(request, overrides);
        const hash = await this.broadcast(raw);
        await this.publicClient.waitForTransactionReceipt({ hash });
        return { raw, hash, nonce: parseTransaction(raw).nonce };
    }

    async approve(amount: bigint) {
        const { encodeApproveCalldata } = await import('../src/chain/calldata');
        return this.signAndSend({ to: USDC_BASE, data: encodeApproveCalldata(SPRAAY_BATCH_CONTRACT_BASE, amount), value: '0', chainId: 8453 });
    }
}

export const initialData = {
    defaultLanguage: 'en' as any,
    defaultZone: 'Europe',
    taxRates: [],
    shippingMethods: [],
    paymentMethods: [],
    countries: [{ name: 'United Kingdom', code: 'GB', zone: 'Europe' }],
    collections: [],
};
