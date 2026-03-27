import { NostrWebLNProvider } from '@getalby/sdk';

export interface NWCInvoiceLookupResult {
  paid: boolean;
  preimage?: string;
  amountMsats?: number;
}

/**
 * Lookup an invoice using Nostr Wallet Connect (NWC).
 *
 * Uses the receiver's NWC connection string to check if an invoice has been paid.
 * This allows automatic payment detection when the receiver has an NWC wallet connected.
 *
 * @param nwcConnectionString - The receiver's NWC connection string
 * @param invoice - The BOLT11 invoice to check
 * @returns Whether the invoice has been paid and optional preimage
 */
export async function lookupInvoiceViaNWC(
  nwcConnectionString: string,
  invoice: string,
): Promise<NWCInvoiceLookupResult> {
  if (!nwcConnectionString || !invoice) {
    throw new Error('NWC connection string and invoice are required');
  }

  try {
    const provider = new NostrWebLNProvider({
      nostrWalletConnectUrl: nwcConnectionString,
    });

    await provider.enable();

    // LookupInvoice returns the invoice details including payment status
    const invoiceInfo = await provider.lookupInvoice({ invoice });

    // Note: NostrWebLNProvider in @getalby/sdk v7 doesn't have disconnect()
    // The connection is managed internally

    if (invoiceInfo?.paid) {
      return {
        paid: true,
        preimage: invoiceInfo.preimage,
        amountMsats: invoiceInfo.amount,
      };
    }

    return { paid: false };
  } catch (error) {
    console.error('NWC lookupInvoice error:', error);
    // Return not paid rather than throwing - invoice might just be unpaid
    return { paid: false };
  }
}

/**
 * Check if an NWC connection string is valid by attempting to connect
 * and get the wallet info.
 */
export async function validateNWCConnection(nwcConnectionString: string): Promise<boolean> {
  if (!nwcConnectionString.startsWith('nostr+walletconnect://')) {
    return false;
  }

  try {
    const provider = new NostrWebLNProvider({
      nostrWalletConnectUrl: nwcConnectionString,
    });

    await provider.enable();

    // Try to get wallet info to verify connection works
    const balance = await provider.getBalance();

    // Note: NostrWebLNProvider in @getalby/sdk v7 doesn't have disconnect()
    // The connection is managed internally

    return typeof balance === 'number' && balance >= 0;
  } catch (error) {
    console.error('NWC validation error:', error);
    return false;
  }
}
