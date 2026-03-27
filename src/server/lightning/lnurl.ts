/**
 * Lightning Address (LNURL-PAY) utilities
 *
 * Resolves Lightning Addresses and creates invoices via the LNURL-PAY protocol.
 */

const _LNURLPAY_METADATA = '[["text/plain","SplitPro expense settlement"]]';

export interface LNURLPayParams {
  tag: 'payRequest';
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  commentAllowed?: number;
}

export interface LNURLInvoiceResponse {
  pr: string;
  routes: unknown[];
}

/**
 * Resolve a Lightning Address (user@domain.com) to its LNURL-PAY parameters.
 * Fetches https://{domain}/.well-known/lnurlp/{user}
 */
export async function resolveLightningAddress(address: string): Promise<LNURLPayParams> {
  if (!address.includes('@')) {
    throw new Error('Invalid Lightning Address format. Expected: user@domain.com');
  }

  const [localPart, domain] = address.split('@');
  if (!localPart || !domain) {
    throw new Error('Invalid Lightning Address format. Expected: user@domain.com');
  }

  const url = `https://${domain}/.well-known/lnurlp/${localPart}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve Lightning Address: HTTP ${response.status}`);
  }

  const data = (await response.json()) as LNURLPayParams;

  if (data.tag !== 'payRequest') {
    throw new Error('Invalid LNURL-PAY response: expected tag "payRequest"');
  }

  return data;
}

/**
 * Create a BOLT11 invoice via an LNURL-PAY callback.
 *
 * @param callback - The callback URL from LNURLPayParams
 * @param amountMsats - Amount in millisatoshis
 * @param comment - Optional comment for the invoice
 */
export async function createInvoiceViaLNURL(
  callback: string,
  amountMsats: number,
  comment?: string,
): Promise<LNURLInvoiceResponse> {
  const url = new URL(callback);
  url.searchParams.set('amount', amountMsats.toString());
  if (comment) {
    url.searchParams.set('comment', comment);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create invoice via LNURL-PAY: HTTP ${response.status} - ${body}`);
  }

  const data = (await response.json()) as LNURLInvoiceResponse;

  if (!data.pr) {
    throw new Error('Invalid LNURL-PAY invoice response: missing "pr" field');
  }

  return data;
}

/**
 * Validate a Lightning Address by resolving it.
 * Returns true if the address is valid and reachable.
 */
export async function validateLightningAddress(address: string): Promise<boolean> {
  try {
    const params = await resolveLightningAddress(address);
    return params.minSendable > 0 && params.maxSendable >= params.minSendable;
  } catch {
    return false;
  }
}

/**
 * Decode a BOLT11 invoice to extract the amount in millisatoshis.
 * Simple regex-based decoder for common invoice formats.
 *
 * Returns the amount in millisatoshis, or null if not specified.
 */
export function decodeInvoiceAmount(bolt11: string): number | null {
  // BOLT11 format: lnbc{amount}{multiplier}...
  // Examples: lnbc50n1... (50 nanobitcoin), lnbc1m1... (1 millibitcoin)
  const match = bolt11.match(/^lnbc(\d+)([pnum])?/);
  if (!match) {
    return null;
  }

  const amount = parseInt(match[1]!, 10);
  const multiplier = match[2];

  // Multipliers: p=10^-12, n=10^-9, u=10^-6, m=10^-3 (of BTC)
  // Convert to millisatoshis: 1 BTC = 1,000,000,000,000 millisatoshis
  const multipliers: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
  };

  const multiplierValue = multiplier ? multipliers[multiplier] : undefined;
  if (multiplierValue === undefined) {
    return null;
  }

  const btcAmount = amount * multiplierValue;
  return Math.round(btcAmount * 1e12); // Convert BTC to millisatoshis
}
