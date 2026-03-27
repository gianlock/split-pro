import { SplitType, type User } from '@prisma/client';
import { ArrowRightIcon, Zap } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'sonner';

import { DEFAULT_CATEGORY } from '~/lib/category';
import { api } from '~/utils/api';
import { BigMath } from '~/utils/numbers';

import { useSession } from 'next-auth/react';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import type { MinimalBalance } from '~/types/balance.types';
import { EntityAvatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { CurrencyInput } from '../ui/currency-input';
import { AppDrawer } from '../ui/drawer';
import { FriendBalance } from './FriendBalance';
import { LightningPayment } from './LightningPayment';

type ViewMode = 'balance-select' | 'settle' | 'lightning';

export const SettleUp: React.FC<
  React.PropsWithChildren<{
    balances?: MinimalBalance[];
    friend: User;
  }>
> = ({ children, balances, friend }) => {
  const { t, displayName, getCurrencyHelpersCached } = useTranslationWithUtils();
  const { data } = useSession();
  const currentUser = data?.user;

  const { data: lightningEnabled } = api.lightning.isEnabled.useQuery(undefined, {
    staleTime: Infinity,
  });
  const { data: receiverLightningAddress } = api.lightning.getUserLightningAddress.useQuery(
    { userId: friend.id },
    { enabled: Boolean(lightningEnabled?.enabled) },
  );

  if (!currentUser) {
    return null;
  }

  if (!balances) {
    return (
      <Button size="sm" variant="outline" responsiveIcon disabled>
        <span className="xs:inline hidden">{t('actions.settle_up')}</span>
      </Button>
    );
  }

  const [balanceToSettle, setBalanceToSettle] = useState<MinimalBalance | undefined>(
    1 < balances.length ? undefined : balances[0],
  );
  const [amount, setAmount] = useState<bigint>(
    1 < balances.length ? 0n : BigMath.abs(balances[0]?.amount ?? 0n),
  );
  const [amountStr, setAmountStr] = useState<string>(
    getCurrencyHelpersCached(balanceToSettle?.currency ?? '').toUIString(amount),
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    1 < balances.length ? 'balance-select' : 'settle',
  );

  const isCurrentUserPaying = 0 > (balanceToSettle?.amount ?? 0);
  const canPayWithLightning =
    lightningEnabled?.enabled && receiverLightningAddress?.address && isCurrentUserPaying;

  function onSelectBalance(balance: MinimalBalance) {
    setBalanceToSettle(balance);
    setAmount(BigMath.abs(balance.amount));
    setAmountStr(
      getCurrencyHelpersCached(balance.currency).toUIString(BigMath.abs(balance.amount)),
    );
    setViewMode('settle');
  }

  const addExpenseMutation = api.expense.addOrEditExpense.useMutation();
  const utils = api.useUtils();

  const saveExpense = React.useCallback(() => {
    if (!balanceToSettle || !amount || !currentUser) {
      return;
    }

    addExpenseMutation.mutate(
      {
        name: t('ui.settle_up_name'),
        currency: balanceToSettle.currency,
        amount,
        splitType: SplitType.SETTLEMENT,
        participants: [
          {
            userId: currentUser.id,
            amount: isCurrentUserPaying ? amount : -amount,
          },
          {
            userId: friend.id,
            amount: isCurrentUserPaying ? -amount : amount,
          },
        ],
        paidBy: isCurrentUserPaying ? currentUser.id : friend.id,
        category: DEFAULT_CATEGORY,
        groupId: balanceToSettle.groupId,
      },
      {
        onSuccess: () => {
          utils.user.invalidate().catch(console.error);
          utils.expense.invalidate().catch(console.error);
          toast.success(t('ui.settlement'));
        },
        onError: (error) => {
          console.error('Error while saving expense:', error);
          toast.error(t('errors.saving_expense'));
        },
      },
    );
  }, [
    balanceToSettle,
    amount,
    currentUser,
    isCurrentUserPaying,
    friend,
    addExpenseMutation,
    utils,
    t,
  ]);

  const onCurrencyInputValueChange = React.useCallback(
    ({ strValue, bigIntValue }: { strValue?: string; bigIntValue?: bigint }) => {
      if (strValue !== undefined) {
        setAmountStr(strValue);
      }
      if (bigIntValue !== undefined) {
        setAmount(bigIntValue);
      }
    },
    [],
  );

  const onBackClick = React.useCallback(() => {
    if (viewMode === 'lightning') {
      setViewMode('settle');
    } else if (balanceToSettle) {
      setBalanceToSettle(undefined);
      setViewMode('balance-select');
    }
  }, [viewMode, balanceToSettle]);

  const getDrawerTitle = () => {
    if (viewMode === 'lightning') {
      return 'Pay with Lightning';
    }
    if (balanceToSettle) {
      return t('ui.settle_up_name');
    }
    return t('ui.select_balance');
  };

  return (
    <AppDrawer
      trigger={children}
      disableTrigger={!balances?.length}
      leftAction={t('actions.back')}
      leftActionOnClick={onBackClick}
      shouldCloseOnLeftAction={false}
      title={getDrawerTitle()}
      className="h-[70vh]"
      actionTitle={viewMode === 'lightning' ? undefined : t('actions.save')}
      actionDisabled={!balanceToSettle || !amount || viewMode === 'lightning'}
      actionOnClick={saveExpense}
      shouldCloseOnAction={viewMode !== 'lightning'}
    >
      {viewMode === 'balance-select' ? (
        <div>
          {balances?.map((b) => (
            <div
              key={`${b.friendId}-${b.currency}-${b.groupId ?? 'null'}`}
              onClick={() => onSelectBalance(b)}
              className="cursor-pointer px-4 py-2"
            >
              <FriendBalance user={friend} balance={b} groupName={b.groupName} />
            </div>
          ))}
        </div>
      ) : viewMode === 'lightning' && balanceToSettle ? (
        <LightningPayment
          amount={amount}
          currency={balanceToSettle.currency}
          receiverUserId={friend.id}
          receiverName={displayName(friend)}
          receiverLightningAddress={receiverLightningAddress?.address}
          onManualSettle={() => {
            saveExpense();
            setViewMode('settle');
          }}
          onCancel={() => setViewMode('settle')}
        />
      ) : (
        <div className="flex flex-col items-center gap-6 pt-10">
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-5">
              <EntityAvatar entity={isCurrentUserPaying ? currentUser : friend} />
              <ArrowRightIcon className="h-6 w-6 text-gray-600" />
              <EntityAvatar entity={isCurrentUserPaying ? friend : currentUser} />
            </div>
            <p className="mt-2 text-center text-sm text-gray-400">
              {isCurrentUserPaying
                ? `${t('actors.you')} ${t('ui.expense.you.pay')} ${displayName(friend)}`
                : `${displayName(friend)} ${t('ui.expense.user.pay')} ${t('actors.you')}`}
            </p>
            {balanceToSettle?.groupName ? (
              <p className="mt-1 text-center text-xs text-gray-500">{balanceToSettle.groupName}</p>
            ) : null}
          </div>
          <CurrencyInput
            currency={balanceToSettle?.currency ?? ''}
            strValue={amountStr}
            className="mx-auto mt-4 w-[150px] text-center text-lg"
            onValueChange={onCurrencyInputValueChange}
          />

          {canPayWithLightning && (
            <Button variant="outline" onClick={() => setViewMode('lightning')} className="mt-4">
              <Zap className="mr-2 h-4 w-4 text-yellow-500" />
              Pay with Lightning
            </Button>
          )}
        </div>
      )}
    </AppDrawer>
  );
};
