import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Loader2, Zap } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';

import { api } from '~/utils/api';
import { Button } from '../ui/button';

interface LightningPaymentProps {
  amount: bigint;
  currency: string;
  receiverUserId: number;
  receiverName: string;
  receiverLightningAddress?: string | null;
  onManualSettle: () => void;
  onCancel: () => void;
}

export const LightningPayment: React.FC<LightningPaymentProps> = ({
  amount,
  currency,
  receiverUserId,
  receiverName,
  receiverLightningAddress,
  onManualSettle,
  onCancel,
}) => {
  const [paymentState, setPaymentState] = useState<
    'ready' | 'loading' | 'waiting' | 'paid' | 'error'
  >('ready');
  const [paymentData, setPaymentData] = useState<{
    paymentId: string;
    invoice: string;
    amountSats: string;
    satsFormatted: string;
    receiverAddress: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isPayingViaNWC, setIsPayingViaNWC] = useState(false);

  // Format fiat amount for display
  const formattedFiat = (Number(amount) / 100).toFixed(2);

  const createInvoiceMutation = api.lightning.createInvoice.useMutation();
  const payViaNWCMutation = api.lightning.payViaNWC.useMutation();
  const { data: nwcStatus } = api.lightning.getNWCStatus.useQuery();

  // Poll for payment status using check-payment endpoint
  const checkPaymentStatus = useCallback(async () => {
    if (!paymentData?.paymentId || paymentState !== 'waiting') {
      return;
    }

    try {
      const res = await fetch('/api/lightning/check-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: paymentData.paymentId }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.paid) {
          setPaymentState('paid');
          toast.success('Payment detected!');
        }
      }
    } catch (error) {
      console.error('Check payment error:', error);
    }
  }, [paymentData?.paymentId, paymentState]);

  // Poll for payment status every 5 seconds
  useEffect(() => {
    if (paymentState !== 'waiting') {
      return;
    }

    const interval = setInterval(checkPaymentStatus, 5000);
    // Also check immediately
    void checkPaymentStatus();

    return () => clearInterval(interval);
  }, [checkPaymentStatus, paymentState]);

  const onCreateInvoice = useCallback(async () => {
    if (!receiverLightningAddress) {
      setErrorMessage('Receiver has no Lightning Address configured');
      setPaymentState('error');
      return;
    }

    setPaymentState('loading');
    try {
      const result = await createInvoiceMutation.mutateAsync({
        amountCents: amount,
        currency,
        toUserId: receiverUserId,
      });
      setPaymentData({
        paymentId: result.paymentId,
        invoice: result.invoice,
        amountSats: result.amountSats,
        satsFormatted: result.satsFormatted,
        receiverAddress: result.receiverAddress,
      });
      setPaymentState('waiting');
    } catch (error) {
      console.error('Failed to create invoice:', error);
      const message = error instanceof Error ? error.message : 'Failed to create invoice';
      setErrorMessage(message);
      setPaymentState('error');
    }
  }, [amount, currency, receiverUserId, receiverLightningAddress, createInvoiceMutation]);

  const onPayViaNWC = useCallback(async () => {
    if (!receiverLightningAddress) {
      setErrorMessage('Receiver has no Lightning Address configured');
      setPaymentState('error');
      return;
    }

    setIsPayingViaNWC(true);
    try {
      // First create the invoice
      const result = await createInvoiceMutation.mutateAsync({
        amountCents: amount,
        currency,
        toUserId: receiverUserId,
      });
      setPaymentData({
        paymentId: result.paymentId,
        invoice: result.invoice,
        amountSats: result.amountSats,
        satsFormatted: result.satsFormatted,
        receiverAddress: result.receiverAddress,
      });

      // Then pay via NWC
      const paymentResult = await payViaNWCMutation.mutateAsync({
        paymentId: result.paymentId,
      });

      if (paymentResult.success) {
        setPaymentState('paid');
        toast.success('Payment sent via Lightning wallet!');
      }
    } catch (error) {
      console.error('NWC payment failed:', error);
      const message = error instanceof Error ? error.message : 'Payment failed';
      setErrorMessage(message);
      setPaymentState('error');
    } finally {
      setIsPayingViaNWC(false);
    }
  }, [
    amount,
    currency,
    receiverUserId,
    receiverLightningAddress,
    createInvoiceMutation,
    payViaNWCMutation,
  ]);

  const onCopyInvoice = useCallback(() => {
    if (paymentData?.invoice) {
      navigator.clipboard.writeText(paymentData.invoice).then(
        () => toast.success('Invoice copied to clipboard'),
        () => toast.error('Failed to copy invoice'),
      );
    }
  }, [paymentData]);

  const onOpenWallet = useCallback(() => {
    if (paymentData?.invoice) {
      window.open(`lightning:${paymentData.invoice}`, '_blank');
    }
  }, [paymentData]);

  const confirmPayment = useCallback(async () => {
    if (!paymentData?.paymentId) {
      return;
    }

    try {
      const res = await fetch('/api/test/confirm-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: paymentData.paymentId }),
      });
      if (res.ok) {
        setPaymentState('paid');
        toast.success('Payment confirmed!');
      } else {
        toast.error('Failed to confirm payment');
      }
    } catch {
      toast.error('Failed to confirm payment');
    }
  }, [paymentData]);

  if (paymentState === 'paid') {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <CheckCircle2 className="h-16 w-16 text-emerald-500" />
        <div className="text-center">
          <p className="text-lg font-semibold">Payment Sent!</p>
          <p className="text-muted-foreground text-sm">
            {paymentData?.satsFormatted ?? 'Paid'} sent to {receiverName}
          </p>
        </div>
        <Button onClick={onCancel} className="mt-4">
          Done
        </Button>
      </div>
    );
  }

  if (paymentState === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <AlertCircle className="text-destructive h-12 w-12" />
        <p className="text-destructive text-center text-sm">{errorMessage}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onManualSettle}>
            Settle Manually
          </Button>
        </div>
      </div>
    );
  }

  if (paymentState === 'loading' || isPayingViaNWC) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        <p className="text-muted-foreground text-sm">
          {isPayingViaNWC ? 'Paying via Lightning wallet...' : 'Creating invoice...'}
        </p>
      </div>
    );
  }

  if (paymentState === 'waiting' && paymentData) {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="rounded-xl bg-white p-4">
          <QRCodeSVG value={paymentData.invoice} size={200} level="M" includeMargin />
        </div>

        <div className="text-center">
          <p className="text-2xl font-bold">
            {currency} {formattedFiat}
          </p>
          <p className="text-muted-foreground text-lg">{paymentData.satsFormatted}</p>
          <p className="text-muted-foreground mt-1 text-xs">{paymentData.receiverAddress}</p>
        </div>

        <div className="flex w-full flex-col gap-2">
          <Button onClick={onOpenWallet} className="w-full">
            <Zap className="mr-2 h-4 w-4" />
            Open in Wallet
          </Button>
          <Button variant="outline" className="w-full" onClick={onCopyInvoice}>
            <Copy className="mr-2 h-4 w-4" />
            Copy Invoice
          </Button>
        </div>

        <div className="w-full space-y-2 border-t pt-4">
          <p className="text-muted-foreground text-center text-xs">
            After paying from your Lightning wallet:
          </p>
          <Button variant="default" onClick={confirmPayment} className="w-full">
            ✓ I Paid - Confirm Settlement
          </Button>
        </div>

        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          Auto-checking payment status...
        </div>
      </div>
    );
  }

  // Ready state
  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div className="text-center">
        <p className="text-3xl font-bold">
          {currency} {formattedFiat}
        </p>
        <p className="text-muted-foreground text-sm">
          Amount will be converted to sats at current rate
        </p>
      </div>

      <div className="bg-muted w-full rounded-lg p-3 text-center">
        <p className="text-muted-foreground text-sm">Pay to</p>
        <p className="font-medium">{receiverName}</p>
        {receiverLightningAddress && (
          <p className="text-muted-foreground mt-1 font-mono text-xs">{receiverLightningAddress}</p>
        )}
      </div>

      <div className="flex w-full flex-col gap-2">
        {receiverLightningAddress ? (
          <>
            {/* Pay with NWC (one-click) if wallet is connected */}
            {nwcStatus?.connected && (
              <Button onClick={onPayViaNWC} className="w-full" size="lg" disabled={isPayingViaNWC}>
                <Zap className="mr-2 h-5 w-5" />
                Pay with Connected Wallet
              </Button>
            )}

            {/* Pay with QR Code */}
            <Button
              onClick={onCreateInvoice}
              className="w-full"
              variant={nwcStatus?.connected ? 'outline' : 'default'}
              size={nwcStatus?.connected ? 'default' : 'lg'}
            >
              <Zap className="mr-2 h-5 w-5" />
              {nwcStatus?.connected ? 'Show QR Code' : 'Pay with Lightning'}
            </Button>

            <Button
              variant="outline"
              className="w-full"
              onClick={() =>
                navigator.clipboard
                  .writeText(receiverLightningAddress)
                  .then(() => toast.success('Address copied'))
              }
            >
              Copy Lightning Address
            </Button>
          </>
        ) : (
          <div className="text-muted-foreground py-4 text-center text-sm">
            {receiverName} has not set up a Lightning Address.
          </div>
        )}

        <div className="mt-2 border-t pt-2">
          <Button variant="ghost" className="w-full" onClick={onManualSettle}>
            Settle Manually Instead
          </Button>
        </div>
      </div>
    </div>
  );
};
