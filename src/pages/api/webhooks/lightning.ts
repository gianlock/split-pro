import type { NextApiRequest, NextApiResponse } from 'next';
import { SplitType } from '@prisma/client';
import crypto from 'crypto';

import { db } from '~/server/db';
import { env } from '~/env';
import { DEFAULT_CATEGORY } from '~/lib/category';

/**
 * Webhook endpoint for Lightning payment confirmations.
 *
 * When a payment is confirmed, this handler:
 * 1. Updates the LightningPayment status to "paid"
 * 2. Creates a SETTLEMENT expense to record the settlement
 *
 * Supports authentication via:
 * - HMAC-SHA256 signature in X-Signature header (for Alby, LNbits, etc.)
 * - Webhook secret in Authorization header or query param
 * - Unauthenticated (for development/testing only)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify webhook signature if secret is configured
    if (env.LIGHTNING_WEBHOOK_SECRET) {
      const signature = req.headers['x-signature'] as string | undefined;
      const authHeader = req.headers.authorization;
      const querySecret = req.query.secret as string | undefined;

      let isValid = false;

      // Check HMAC signature (x-signature header)
      if (signature && req.body) {
        const expectedSignature = crypto
          .createHmac('sha256', env.LIGHTNING_WEBHOOK_SECRET)
          .update(JSON.stringify(req.body))
          .digest('hex');
        isValid = signature === expectedSignature || signature === `sha256=${expectedSignature}`;
      }

      // Check Bearer token (Authorization header)
      if (!isValid && authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        isValid = token === env.LIGHTNING_WEBHOOK_SECRET;
      }

      // Check query param (some services use this)
      if (!isValid && querySecret) {
        isValid = querySecret === env.LIGHTNING_WEBHOOK_SECRET;
      }

      if (!isValid) {
        console.warn('Webhook signature verification failed');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.warn('LIGHTNING_WEBHOOK_SECRET not configured in production');
    }

    const {
      paymentHash,
      status,
      invoice,
      paymentId,
      preimage: _preimage,
    } = req.body as {
      paymentHash?: string;
      status?: string;
      invoice?: string;
      paymentId?: string;
      preimage?: string;
    };

    // Find the LightningPayment by ID, payment hash, or invoice
    let payment = null;

    if (paymentId) {
      payment = await db.lightningPayment.findUnique({ where: { id: paymentId } });
    } else if (paymentHash || invoice) {
      payment = await db.lightningPayment.findFirst({
        where: {
          OR: [paymentHash ? { paymentHash } : undefined, invoice ? { invoice } : undefined].filter(
            Boolean,
          ) as { paymentHash: string }[] | { invoice: string }[],
        },
      });
    }

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Only update if transitioning to paid from pending
    if (status === 'paid' && payment.status === 'pending') {
      // Update payment status
      await db.lightningPayment.update({
        where: { id: payment.id },
        data: {
          status: 'paid',
          paymentHash: paymentHash ?? payment.paymentHash,
        },
      });

      // Create a SETTLEMENT expense to record this payment
      const expense = await db.expense.create({
        data: {
          name: 'Settlement (Lightning)',
          amount: Number(payment.amountCents),
          currency: payment.currency,
          splitType: SplitType.SETTLEMENT,
          paidBy: payment.payerId,
          addedBy: payment.payerId,
          category: DEFAULT_CATEGORY,
          expenseDate: new Date(),
          updatedAt: new Date(),
          groupId: payment.groupId,
        },
      });

      // Link the expense to the payment
      await db.lightningPayment.update({
        where: { id: payment.id },
        data: { expenseId: expense.id },
      });

      // Create expense participants (settlement: payer paid for receiver)
      await db.expenseParticipant.create({
        data: {
          userId: payment.payerId,
          expenseId: expense.id,
          amount: payment.amountCents, // Payer is owed this amount
        },
      });

      await db.expenseParticipant.create({
        data: {
          userId: payment.receiverId,
          expenseId: expense.id,
          amount: -payment.amountCents, // Receiver owes this amount
        },
      });

      console.log(
        `Lightning payment ${payment.id} confirmed. Settlement expense ${expense.id} created.`,
      );

      // Send push notification for the settlement
      try {
        const { sendExpensePushNotification } =
          await import('~/server/api/services/notificationService');
        sendExpensePushNotification(expense.id).catch(console.error);
      } catch (error) {
        console.error('Failed to send settlement notification:', error);
      }
    } else if (status === 'failed') {
      await db.lightningPayment.update({
        where: { id: payment.id },
        data: { status: 'failed' },
      });
    }

    return res.status(200).json({
      success: true,
      paymentId: payment.id,
      status: status ?? payment.status,
    });
  } catch (error) {
    console.error('Lightning webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
