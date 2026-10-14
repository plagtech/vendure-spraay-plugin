import { getAddress, isAddress, zeroAddress } from 'viem';

import { USDC_DECIMALS } from './constants';

const RAW_INTEGER = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Thrown when a payout amount or address fails validation.
 *
 * @category Services
 */
export class SpraayValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpraayValidationError';
    }
}

/**
 * Parses a raw base-unit amount (USDC has 6 decimals, so "1500000" = 1.50 USDC).
 * Only canonical, positive integer strings are accepted: no decimals, no exponent,
 * no leading zeros, no signs, no whitespace. This keeps amounts exact end to end.
 *
 * @category Services
 */
export function parseRawAmount(value: string, label = 'amount'): bigint {
    if (typeof value !== 'string' || !RAW_INTEGER.test(value)) {
        throw new SpraayValidationError(
            `${label} must be a positive integer string in raw USDC base units (6 decimals, e.g. "1500000" = 1.50 USDC); got "${String(value)}"`,
        );
    }
    const parsed = BigInt(value);
    if (parsed <= 0n) {
        throw new SpraayValidationError(`${label} must be greater than zero`);
    }
    if (parsed > UINT256_MAX) {
        throw new SpraayValidationError(`${label} exceeds uint256`);
    }
    return parsed;
}

/**
 * Mirrors SprayContract: `feeAmount = (totalAmount * feeBps) / 10000` (integer division).
 *
 * @category Services
 */
export function computeProtocolFee(totalRaw: bigint, feeBps: bigint): bigint {
    return (totalRaw * feeBps) / 10_000n;
}

/**
 * Display-only helper. Never used for arithmetic.
 *
 * @category Services
 */
export function formatUsdc(raw: bigint): string {
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const base = 10n ** BigInt(USDC_DECIMALS);
    const whole = abs / base;
    const fraction = (abs % base).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString()}${fraction ? '.' + fraction : ''}`;
}

/**
 * Returns the EIP-55 checksummed address or throws. Rejects the zero address (the contract would revert).
 *
 * @category Services
 */
export function normalizeAddress(value: string, label = 'address'): `0x${string}` {
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
        throw new SpraayValidationError(`${label} is not a valid EVM address: "${String(value)}"`);
    }
    const checksummed = getAddress(value);
    if (checksummed === zeroAddress) {
        throw new SpraayValidationError(`${label} must not be the zero address`);
    }
    return checksummed;
}

/**
 * Case-insensitive EVM address comparison.
 *
 * @category Services
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
