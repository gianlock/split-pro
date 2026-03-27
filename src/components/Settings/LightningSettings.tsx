import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api } from '~/utils/api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ConnectLightningWallet } from '../Friend/ConnectLightningWallet';

export const LightningSettings: React.FC = () => {
  const { data: enabled } = api.lightning.isEnabled.useQuery();
  const { data: currentAddress, refetch } = api.lightning.getMyLightningAddress.useQuery(
    undefined,
    { enabled: Boolean(enabled?.enabled) },
  );
  const { data: nwcStatus } = api.lightning.getNWCStatus.useQuery(undefined, {
    enabled: Boolean(enabled?.enabled),
  });

  const setMutation = api.lightning.setLightningAddress.useMutation();
  const clearMutation = api.lightning.clearLightningAddress.useMutation();
  const disconnectNWCMutation = api.lightning.disconnectNWC.useMutation();

  const [addressInput, setAddressInput] = useState(currentAddress?.address ?? '');
  const [isValidating, setIsValidating] = useState(false);

  const [skipValidation, setSkipValidation] = useState(false);

  const onSave = useCallback(async () => {
    if (!addressInput.trim()) {
      toast.error('Please enter a Lightning Address');
      return;
    }

    setIsValidating(true);
    try {
      await setMutation.mutateAsync({
        address: addressInput.trim(),
        skipValidation,
      });
      toast.success('Lightning Address saved!');
      await refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save Lightning Address';
      toast.error(message);
    } finally {
      setIsValidating(false);
    }
  }, [addressInput, setMutation, refetch, skipValidation]);

  const onClear = useCallback(async () => {
    try {
      await clearMutation.mutateAsync();
      toast.success('Lightning Address removed');
      setAddressInput('');
      await refetch();
    } catch {
      toast.error('Failed to remove Lightning Address');
    }
  }, [clearMutation, refetch]);

  const onDisconnectNWC = useCallback(async () => {
    try {
      await disconnectNWCMutation.mutateAsync();
      toast.success('Lightning wallet disconnected');
    } catch {
      toast.error('Failed to disconnect wallet');
    }
  }, [disconnectNWCMutation]);

  if (!enabled?.enabled) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Lightning Address</label>
        <p className="text-muted-foreground mb-2 text-xs">
          Receive Lightning payments for expense settlements
        </p>

        {currentAddress?.address ? (
          <div className="space-y-2">
            <div className="bg-muted flex items-center justify-between rounded-md p-3">
              <span className="font-mono text-sm">{currentAddress.address}</span>
              <Button variant="ghost" size="sm" onClick={onClear} loading={clearMutation.isPending}>
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Input
              type="text"
              placeholder="yourname@getalby.com"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
            />
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={skipValidation}
                onChange={(e) => setSkipValidation(e.target.checked)}
                className="rounded"
              />
              Skip validation (for test addresses)
            </label>
            <Button
              onClick={onSave}
              disabled={!addressInput.trim()}
              loading={setMutation.isPending || isValidating}
              className="w-full"
            >
              Save Lightning Address
            </Button>
          </div>
        )}
      </div>

      <div className="border-t pt-4">
        <label className="text-sm font-medium">Connected Wallet</label>
        <p className="text-muted-foreground mb-2 text-xs">
          Connect a Lightning wallet for one-click payments
        </p>

        {nwcStatus?.connected ? (
          <div className="bg-muted flex items-center justify-between rounded-md p-3">
            <span className="text-sm">Lightning wallet connected</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDisconnectNWC}
              loading={disconnectNWCMutation.isPending}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <ConnectLightningWallet />
        )}
      </div>
    </div>
  );
};
