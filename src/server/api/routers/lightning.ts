import { TRPCError } from '@trpc/server';
import { NostrWebLNProvider } from '@getalby/sdk';
import { z } from 'zod';

import { env } from '~/env';
import { CURRENCIES, type CurrencyCode } from '~/lib/currency';
import { createTRPCRouter, protectedProcedure } from '~/server/api/trpc';
import { db } from '~/server/db';
import { fiatToSats, formatSats } from '~/server/lightning/conversion';
import {
  createInvoiceViaLNURL,
  resolveLightningAddress,
  validateLightningAddress,
} from '~/server/lightning/lnurl';
import { lookupInvoiceViaNWC } from '~/server/lightning/nwc';

const LIGHTNING_FEATURE_ENABLED = env.LIGHTNING_ENABLED;

export const lightningRouter = createTRPCRouter({
  /**
   * Check if Lightning payments are enabled on this instance.
   */
  isEnabled: protectedProcedure.query(() => ({
    enabled: LIGHTNING_FEATURE_ENABLED,
  })),

  /**
   * Get the current user's Lightning Address.
   */
  getMyLightningAddress: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { lightningAddress: true },
    });

    return { address: user.lightningAddress };
  }),

  /**
   * Get another user's Lightning Address (for settlement payments).
   */
  getUserLightningAddress: protectedProcedure
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const user = await db.user.findUnique({
        where: { id: input.userId },
        select: { lightningAddress: true },
      });

      return { address: user?.lightningAddress ?? null };
    }),

  /**
   * Set or update the current user's Lightning Address.
   * Validates the address by resolving it via LNURL-PAY before saving.
   */
  setLightningAddress: protectedProcedure
    .input(
      z.object({
        address: z.string().trim().min(1),
        skipValidation: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const address = input.address;

      if (!address.includes('@')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid Lightning Address format. Expected: user@domain.com',
        });
      }

      // Validate by resolving the address (unless skipping for testing)
      if (!input.skipValidation) {
        const isValid = await validateLightningAddress(address);
        if (!isValid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Could not resolve Lightning Address. Please check and try again.',
          });
        }
      }

      await db.user.update({
        where: { id: ctx.session.user.id },
        data: { lightningAddress: address },
      });

      return { success: true, address };
    }),

  /**
   * Clear the current user's Lightning Address.
   */
  clearLightningAddress: protectedProcedure.mutation(async ({ ctx }) => {
    await db.user.update({
      where: { id: ctx.session.user.id },
      data: { lightningAddress: null },
    });

    return { success: true };
  }),

  /**
   * Create a Lightning invoice for a settlement payment.
   * Resolves the receiver's Lightning Address, converts fiat to sats,
   * and creates an invoice via LNURL-PAY.
   *
   * Returns the BOLT11 invoice and sats amount for the payer.
   */
  createInvoice: protectedProcedure
    .input(
      z.object({
        amountCents: z.bigint(),
        currency: z.string(),
        toUserId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Get the receiver's Lightning Address
      const receiver = await db.user.findUnique({
        where: { id: input.toUserId },
        select: { lightningAddress: true, name: true },
      });

      if (!receiver?.lightningAddress) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Receiver does not have a Lightning Address configured.',
        });
      }

      // Convert fiat to satoshis
      const currencyInfo = CURRENCIES[input.currency as CurrencyCode];
      if (!currencyInfo) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Unsupported currency: ${input.currency}`,
        });
      }

      const amountSats = await fiatToSats(
        input.amountCents,
        currencyInfo.decimalDigits,
        input.currency,
      );

      // Try to resolve Lightning Address and create real invoice
      let invoice = '';
      try {
        const lnurlParams = await resolveLightningAddress(receiver.lightningAddress);
        const amountMsats = Number(amountSats) * 1000;
        const invoiceResponse = await createInvoiceViaLNURL(
          lnurlParams.callback,
          amountMsats,
          `SplitPro settlement from ${ctx.session.user.name ?? ctx.session.user.email}`,
        );
        invoice = invoiceResponse.pr;
      } catch (error) {
        // In development, create a mock invoice for testing
        if (env.NODE_ENV === 'development') {
          console.warn(`LNURL failed for ${receiver.lightningAddress}, using mock invoice`);
          invoice = `lnbc${Math.round(Number(amountSats) / 1000)}n1${Date.now().toString(36)}`;
        } else {
          throw error;
        }
      }

      // Store the pending payment with payer/receiver info
      const payment = await db.lightningPayment.create({
        data: {
          invoice,
          amountSats,
          amountCents: input.amountCents,
          currency: input.currency,
          payerId: ctx.session.user.id,
          receiverId: input.toUserId,
          status: 'pending',
        },
      });

      return {
        paymentId: payment.id,
        invoice,
        amountSats: amountSats.toString(),
        satsFormatted: formatSats(amountSats),
        receiverName: receiver.name,
        receiverAddress: receiver.lightningAddress,
      };
    }),

  /**
   * Pay a Lightning invoice using the user's NWC wallet.
   * This enables one-click payments without manual confirmation.
   */
  payViaNWC: protectedProcedure
    .input(
      z.object({
        paymentId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Get the payment
      const payment = await db.lightningPayment.findUnique({
        where: { id: input.paymentId },
        include: {
          payer: {
            select: { nwcConnectionString: true },
          },
        },
      });

      if (!payment) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Payment not found.',
        });
      }

      if (payment.status === 'paid') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Payment already completed.',
        });
      }

      // Verify the payer is the current user
      if (payment.payerId !== ctx.session.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the payer can pay this invoice.',
        });
      }

      // Check if payer has NWC wallet connected
      if (!payment.payer?.nwcConnectionString) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No Lightning wallet connected. Please connect a wallet first.',
        });
      }

      if (!payment.invoice) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No invoice to pay.',
        });
      }

      try {
        // Pay the invoice using NWC
        const provider = new NostrWebLNProvider({
          nostrWalletConnectUrl: payment.payer.nwcConnectionString,
        });

        await provider.enable();

        const paymentResult = await provider.sendPayment(payment.invoice);

        // Update payment status
        await db.lightningPayment.update({
          where: { id: payment.id },
          data: { status: 'paid' },
        });

        // Create a SETTLEMENT expense (same logic as webhook)
        const { SplitType } = await import('@prisma/client');
        const { DEFAULT_CATEGORY } = await import('~/lib/category');

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

        // Send push notification for the settlement
        try {
          const { sendExpensePushNotification } =
            await import('~/server/api/services/notificationService');
          sendExpensePushNotification(expense.id).catch(console.error);
        } catch (notificationError) {
          console.error('Failed to send settlement notification:', notificationError);
        }

        return {
          success: true,
          status: 'paid',
          preimage: paymentResult.preimage,
          expenseId: expense.id,
        };
      } catch (error) {
        console.error('NWC payment error:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Payment failed',
        });
      }
    }),

  /**
   * Check the status of a Lightning payment.
   */
  getPaymentStatus: protectedProcedure
    .input(z.object({ paymentId: z.string() }))
    .query(async ({ input }) => {
      const payment = await db.lightningPayment.findUnique({
        where: { id: input.paymentId },
        select: {
          id: true,
          status: true,
          amountSats: true,
          createdAt: true,
        },
      });

      if (!payment) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Payment not found.',
        });
      }

      return {
        id: payment.id,
        status: payment.status,
        amountSats: payment.amountSats.toString(),
        satsFormatted: formatSats(payment.amountSats),
        createdAt: payment.createdAt,
      };
    }),

  /**
   * Get the NWC connection status for the current user.
   */
  getNWCStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { nwcConnectionString: true },
    });

    return { connected: Boolean(user.nwcConnectionString) };
  }),

  /**
   * Save an NWC connection string for the current user.
   */
  connectNWC: protectedProcedure
    .input(z.object({ connectionString: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Validate NWC connection string format
      if (!input.connectionString.startsWith('nostr+walletconnect://')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid NWC connection string format.',
        });
      }

      await db.user.update({
        where: { id: ctx.session.user.id },
        data: { nwcConnectionString: input.connectionString },
      });

      return { success: true };
    }),

  /**
   * Disconnect the current user's NWC wallet.
   */
  disconnectNWC: protectedProcedure.mutation(async ({ ctx }) => {
    await db.user.update({
      where: { id: ctx.session.user.id },
      data: { nwcConnectionString: null },
    });

    return { success: true };
  }),
});
