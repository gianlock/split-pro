import type { NextApiRequest, NextApiResponse } from 'next';
import { SplitType } from '@prisma/client';

import { db } from '~/server/db';
import { DEFAULT_CATEGORY } from '~/lib/category';

/**
 * Test-only endpoint to simulate Lightning payment confirmation.
 * Usage: POST /api/test/confirm-payment with { paymentId: "..." }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Only allow in development
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Not found' });
  }

  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: 'paymentId required' });
  }

  try {
    const payment = await db.lightningPayment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({ error: `Payment already ${payment.status}` });
    }

    // Update payment status to paid
    await db.lightningPayment.update({
      where: { id: payment.id },
      data: { status: 'paid' },
    });

    // Create a SETTLEMENT expense
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

    // Link expense to payment
    await db.lightningPayment.update({
      where: { id: payment.id },
      data: { expenseId: expense.id },
    });

    // Create expense participants (settlement)
    await db.expenseParticipant.create({
      data: {
        userId: payment.payerId,
        expenseId: expense.id,
        amount: payment.amountCents,
      },
    });

    await db.expenseParticipant.create({
      data: {
        userId: payment.receiverId,
        expenseId: expense.id,
        amount: -payment.amountCents,
      },
    });

    console.log(
      `Test: Lightning payment ${payment.id} confirmed. Settlement expense ${expense.id} created.`,
    );

    // Send push notification for the settlement
    try {
      const { sendExpensePushNotification } =
        await import('~/server/api/services/notificationService');
      sendExpensePushNotification(expense.id).catch(console.error);
    } catch (error) {
      console.error('Failed to send settlement notification:', error);
    }

    return res.status(200).json({
      success: true,
      paymentId: payment.id,
      status: 'paid',
      expenseId: expense.id,
    });
  } catch (error) {
    console.error('Test payment confirmation error:', error);
    return res.status(500).json({ error: 'Failed to confirm payment' });
  }
}
