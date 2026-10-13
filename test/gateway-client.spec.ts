import { describe, expect, it } from 'vitest';

import {
    SpraayGatewayClient,
    SpraayGatewayError,
    SpraayGatewayPaymentRequiredError,
} from '../src/gateway/spraay-gateway.client';

import { gatewayResponse } from './fixtures';

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init?: RequestInit }> = []) {
    return async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
}

describe('SpraayGatewayClient', () => {
    it('posts the documented body to /api/v1/batch/execute, pinned to USDC on base', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const client = new SpraayGatewayClient({ baseUrl: 'https://gw.example/', fetch: fakeFetch(200, gatewayResponse(), calls) });
        await client.execute({ recipients: ['0xA'], amounts: ['1'], sender: '0xS' });
        expect(calls[0].url).toBe('https://gw.example/api/v1/batch/execute');
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            token: 'USDC',
            recipients: ['0xA'],
            amounts: ['1'],
            sender: '0xS',
            chain: 'base',
        });
    });

    it('uses /api/v1/batch/estimate for estimates', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const client = new SpraayGatewayClient({ fetch: fakeFetch(200, { success: true, suggestedGasLimit: '230000' }, calls) });
        const res = await client.estimate({ recipients: ['0xA'], amounts: ['1'], sender: '0xS' });
        expect(calls[0].url).toBe('https://gateway.spraay.app/api/v1/batch/estimate');
        expect(res.suggestedGasLimit).toBe('230000');
    });

    it('turns 402 into an actionable x402 error', async () => {
        const client = new SpraayGatewayClient({ fetch: fakeFetch(402, { x402Version: 2, error: 'Payment required' }) });
        await expect(client.execute({ recipients: [], amounts: [], sender: '' })).rejects.toBeInstanceOf(
            SpraayGatewayPaymentRequiredError,
        );
    });

    it('surfaces gateway 400 messages and refuses non-success bodies', async () => {
        const bad = new SpraayGatewayClient({ fetch: fakeFetch(400, { error: 'Maximum 200 recipients' }) });
        await expect(bad.execute({ recipients: [], amounts: [], sender: '' })).rejects.toThrow(/Maximum 200 recipients/);
        const odd = new SpraayGatewayClient({ fetch: fakeFetch(200, { success: false }) });
        await expect(odd.execute({ recipients: [], amounts: [], sender: '' })).rejects.toBeInstanceOf(SpraayGatewayError);
        const html = new SpraayGatewayClient({ fetch: fakeFetch(200, '<html>') });
        await expect(html.execute({ recipients: [], amounts: [], sender: '' })).rejects.toThrow(/non-JSON/);
    });

    it('wraps network failures', async () => {
        const client = new SpraayGatewayClient({
            fetch: async () => {
                throw new Error('ECONNRESET');
            },
        });
        await expect(client.execute({ recipients: [], amounts: [], sender: '' })).rejects.toThrow(/ECONNRESET/);
    });
});
