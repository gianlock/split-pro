import React, { useCallback, useState } from 'react';
import { QrCode, X, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '~/utils/api';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface ConnectLightningWalletProps {
  onConnected?: () => void;
}

/**
 * Component to connect a Lightning wallet via Nostr Wallet Connect (NWC).
 *
 * Users paste their NWC connection string from Alby Hub, Zeus, or other
 * NWC-compatible wallets.
 */
export const ConnectLightningWallet: React.FC<ConnectLightningWalletProps> = ({ onConnected }) => {
  const { data: nwcStatus, refetch: refetchStatus } = api.lightning.getNWCStatus.useQuery();
  const connectMutation = api.lightning.connectNWC.useMutation();
  const disconnectMutation = api.lightning.disconnectNWC.useMutation();

  const [showInput, setShowInput] = useState(false);
  const [connectionString, setConnectionString] = useState('');

  const onConnect = useCallback(async () => {
    if (!connectionString.startsWith('nostr+walletconnect://')) {
      toast.error('Invalid connection string. Must start with nostr+walletconnect://');
      return;
    }

    try {
      await connectMutation.mutateAsync({ connectionString });
      toast.success('Lightning wallet connected!');
      await refetchStatus();
      setConnectionString('');
      setShowInput(false);
      onConnected?.();
    } catch {
      toast.error('Failed to connect wallet');
    }
  }, [connectionString, connectMutation, refetchStatus, onConnected]);

  const onDisconnect = useCallback(async () => {
    try {
      await disconnectMutation.mutateAsync();
      toast.success('Lightning wallet disconnected');
    } catch {
      toast.error('Failed to disconnect wallet');
    }
  }, [disconnectMutation]);

  if (nwcStatus?.connected) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-emerald-600">
          <Zap className="h-4 w-4" />
          Wallet connected
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          loading={disconnectMutation.isPending}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (showInput) {
    return (
      <div className="flex flex-col gap-2">
        <Input
          type="text"
          placeholder="nostr+walletconnect://..."
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          className="font-mono text-sm"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!connectionString}
            loading={connectMutation.isPending}
          >
            Connect
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowInput(false)}>
            Cancel
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Get your NWC string from{' '}
          <a href="https://nwc.dev" target="_blank" rel="noopener noreferrer" className="underline">
            nwc.dev
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => setShowInput(true)}>
        <QrCode className="mr-2 h-4 w-4" />
        Paste NWC String
      </Button>
    </div>
  );
};
