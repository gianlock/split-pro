import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth';
import { db } from '~/server/db';
import { lookupInvoiceViaNWC } from '~/server/lightning/nwc';

/**
 * Check if a Lightning invoice has been paid using NWC (Nostr Wallet Connect).
 *
 * This endpoint uses the receiver's NWC connection to check invoice status.
 * The receiver must have an NWC wallet connected for automatic detection.
 * Otherwise, the user must manually confirm payment via the UI.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerAuthSession({ req, res });
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: 'paymentId required' });
  }

  try {
    // Find the payment
    const payment = await db.lightningPayment.findUnique({
      where: { id: paymentId },
      include: {
        receiver: {
          select: { nwcConnectionString: true, name: true },
        },
      },
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status === 'paid') {
      return res.status(200).json({ paid: true, status: 'paid' });
    }

    // Try to check via NWC if receiver has wallet connected
    if (payment.receiver?.nwcConnectionString && payment.invoice) {
      try {
        const nwcResult = await lookupInvoiceViaNWC(
          payment.receiver.nwcConnectionString,
          payment.invoice,
        );

        if (nwcResult.paid) {
          // Update payment status to paid
          await db.lightningPayment.update({
            where: { id: paymentId },
            data: { status: 'paid' },
          });

          return res.status(200).json({
            paid: true,
            status: 'paid',
            preimage: nwcResult.preimage,
            message: 'Payment detected via NWC!',
          });
        }
      } catch (nwcError) {
        console.error('NWC lookup failed:', nwcError);
        // Continue to return pending status
      }
    }

    // Return current status - payment not yet detected
    return res.status(200).json({
      paid: false,
      status: payment.status,
      invoice: payment.invoice,
      hasNwcConnection: Boolean(payment.receiver?.nwcConnectionString),
      message: payment.receiver?.nwcConnectionString
        ? 'Payment not yet detected. Checking via NWC...'
        : 'Payment not yet detected. Receiver has no NWC wallet connected.',
    });
  } catch (error) {
    console.error('Check payment error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
