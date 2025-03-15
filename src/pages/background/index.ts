import { Order, fetchOrders } from '@root/src/shared/api/amazonApi';
import reloadOnUpdate from 'virtual:reload-on-update-in-background-script';
import 'webextension-polyfill';
import { MonarchTransaction, getTransactions, updateMonarchTransaction } from '@root/src/shared/api/monarchApi';
import progressStorage, { ProgressPhase, updateProgress } from '@root/src/shared/storages/progressStorage';
import transactionStorage, { TransactionStatus } from '@root/src/shared/storages/transactionStorage';
import { matchTransactions } from '@root/src/shared/api/matchUtil';
import appStorage, { AuthStatus, FailureReason, LastSync } from '@root/src/shared/storages/appStorage';
import { Action } from '@root/src/shared/types';
import debugStorage, { debugLog } from '@root/src/shared/storages/debugStorage';

reloadOnUpdate('pages/background');

async function checkAlarm() {
  const alarm = await chrome.alarms.get('sync-alarm');

  if (!alarm) {
    const { lastSync } = await appStorage.get();
    const lastTime = new Date(lastSync?.time || 0);
    const sinceLastSync = Date.now() - lastTime.getTime() / (1000 * 60);
    const delayInMinutes = Math.max(0, 24 * 60 - sinceLastSync);

    await chrome.alarms.create('sync-alarm', {
      delayInMinutes: delayInMinutes,
      periodInMinutes: 24 * 60,
    });
  }
}

// Setup alarms for syncing
checkAlarm();
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'sync-alarm') {
    const { amazonStatus, monarchStatus, options } = await appStorage.get();
    if (options.syncEnabled && amazonStatus === AuthStatus.Success && monarchStatus === AuthStatus.Success) {
      await handleFullSync(undefined, () => {});
    }
  }
});

// Repopulate Monarch key when the tab is visited and the user is logged in
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab?.url?.startsWith('chrome://')) {
    return true;
  }
  if (changeInfo.url) {
    const url = new URL(changeInfo.url);
    if (url.hostname === 'app.monarchmoney.com') {
      const appData = await appStorage.get();
      const lastAuth = new Date(appData.lastMonarchAuth);
      if (
        !appData.monarchKey ||
        appData.monarchStatus !== AuthStatus.Success ||
        lastAuth < new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)
      ) {
        // Execute script in the current tab
        const result = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => localStorage['persist:root'],
        });
        try {
          // Add detailed logging for debugging
          await debugLog(`Raw localStorage result length: ${result[0].result?.length || 0}`);

          const parsedRoot = JSON.parse(result[0].result);
          await debugLog(`Parsed root keys: ${Object.keys(parsedRoot).join(', ')}`);

          const parsedUser = JSON.parse(parsedRoot.user);
          await debugLog(`Parsed user keys: ${Object.keys(parsedUser).join(', ')}`);

          const key = parsedUser.token;
          await debugLog(`Extracted token (first 10 chars): ${key?.substring(0, 10) || 'no token'}...`);

          if (key) {
            await appStorage.patch({ monarchKey: key, lastMonarchAuth: Date.now(), monarchStatus: AuthStatus.Success });
            await debugLog('Successfully stored Monarch token');
          } else {
            await appStorage.patch({ monarchStatus: AuthStatus.NotLoggedIn });
            await debugLog('No token found in localStorage');
          }
        } catch (ex) {
          await appStorage.patch({ monarchStatus: AuthStatus.Failure });
          await debugLog(`Error parsing localStorage: ${ex instanceof Error ? ex.message : String(ex)}`);
        }
      }
    }
  }
});

type Payload = {
  year?: string;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab?.url?.startsWith('chrome://')) {
    return true;
  }

  if (message.action === Action.DryRun) {
    handleDryRun(message.payload, sendResponse);
  } else if (message.action === Action.FullSync) {
    handleFullSync(message.payload, sendResponse);
  } else {
    console.warn(`Unknown action: ${message.action}`);
  }

  return true; // indicates we will send a response asynchronously
});

async function inProgress() {
  const progress = await progressStorage.get();
  return progress.phase !== ProgressPhase.Complete && progress.phase !== ProgressPhase.Idle;
}

async function handleDryRun(payload: Payload | undefined, sendResponse: (args: unknown) => void) {
  if (await inProgress()) {
    sendResponse({ success: false });
    return;
  }
  if (await downloadAndStoreTransactions(payload?.year, true)) {
    sendResponse({ success: true });
    return;
  }
  sendResponse({ success: false });
}

async function handleFullSync(payload: Payload | undefined, sendResponse: (args: unknown) => void) {
  if (await inProgress()) {
    sendResponse({ success: false });
    return;
  }
  if (await downloadAndStoreTransactions(payload?.year, false)) {
    if (await updateMonarchTransactions()) {
      sendResponse({ success: true });
      return;
    }
  }
  sendResponse({ success: false });
}

async function logSyncComplete(payload: Partial<LastSync>) {
  await debugLog('Sync complete');
  await progressStorage.patch({ phase: ProgressPhase.Complete });
  await appStorage.patch({
    lastSync: {
      time: Date.now(),
      amazonOrders: payload.amazonOrders ?? 0,
      monarchTransactions: payload.monarchTransactions ?? 0,
      transactionsUpdated: payload.transactionsUpdated ?? 0,
      success: payload.success ?? false,
      failureReason: payload.failureReason,
      dryRun: payload.dryRun ?? false,
    },
  });
}

async function refreshMonarchToken() {
  await debugLog('Attempting to refresh Monarch token...');

  // Find a Monarch tab if one exists
  const monarchTabs = await chrome.tabs.query({ url: 'https://app.monarchmoney.com/*' });

  if (monarchTabs.length > 0 && monarchTabs[0].id !== undefined) {
    const tabId = monarchTabs[0].id;

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => localStorage['persist:root'],
      });

      // Add detailed logging for debugging the token
      if (result[0].result) {
        await debugLog(`Raw localStorage result length: ${result[0].result.length}`);

        const parsedRoot = JSON.parse(result[0].result);
        await debugLog(`Parsed root keys: ${Object.keys(parsedRoot).join(', ')}`);

        const parsedUser = JSON.parse(parsedRoot.user);
        await debugLog(`Parsed user keys: ${Object.keys(parsedUser).join(', ')}`);

        const key = parsedUser.token;
        await debugLog(`Extracted token (first 10 chars): ${key?.substring(0, 10) || 'no token'}...`);

        if (key) {
          await appStorage.patch({ monarchKey: key, lastMonarchAuth: Date.now(), monarchStatus: AuthStatus.Success });
          await debugLog('Successfully refreshed Monarch token');
          return true;
        }
      } else {
        await debugLog('No result from script execution');
      }
    } catch (ex) {
      await debugLog(`Failed to refresh token: ${ex instanceof Error ? ex.message : String(ex)}`);
    }
  } else {
    await debugLog('No open Monarch tabs found for token refresh or tab ID was undefined');
  }

  return false;
}

async function downloadAndStoreTransactions(yearString?: string, dryRun: boolean = false) {
  await debugStorage.set({ logs: [] });

  const appData = await appStorage.get();
  const year = yearString ? parseInt(yearString) : undefined;

  // Try to refresh the token first
  await refreshMonarchToken();

  // Get updated app data after refresh attempt
  const updatedAppData = await appStorage.get();

  if (!updatedAppData.monarchKey) {
    await logSyncComplete({ success: false, failureReason: FailureReason.NoMonarchAuth });
    return false;
  }

  await updateProgress(ProgressPhase.AmazonPageScan, 0, 0);

  let orders: Order[];
  try {
    await debugLog('Fetching Amazon orders');
    orders = await fetchOrders(year);
  } catch (e) {
    await debugLog(e);
    await logSyncComplete({ success: false, failureReason: FailureReason.AmazonError });
    return false;
  }

  if (!orders || orders.length === 0) {
    await debugLog('No Amazon orders found');
    await logSyncComplete({ success: false, failureReason: FailureReason.NoAmazonOrders });
    return false;
  }
  await transactionStorage.patch({
    orders: orders,
  });

  await progressStorage.patch({ phase: ProgressPhase.MonarchDownload, total: 1, complete: 0 });

  let startDate: Date;
  let endDate: Date;
  if (year) {
    startDate = new Date(year - 1, 11, 23);
    endDate = new Date(year + 1, 0, 8);
  } else {
    startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3);
    startDate.setDate(startDate.getDate() - 8);
    endDate = new Date();
    endDate.setDate(startDate.getDate() + 8);
  }

  // Use updatedAppData instead of appData for the API call
  let monarchTransactions: MonarchTransaction[];
  try {
    await debugLog('Fetching Monarch transactions');
    // Make sure we're using the refreshed token from updatedAppData
    monarchTransactions = await getTransactions(
      updatedAppData.monarchKey,
      updatedAppData.options.amazonMerchant,
      startDate,
      endDate,
    );
    if (!monarchTransactions || monarchTransactions.length === 0) {
      await debugLog('No Monarch transactions found');
      await logSyncComplete({ success: false, failureReason: FailureReason.NoMonarchTransactions });
      return false;
    }
  } catch (ex) {
    await debugLog(`Monarch API error: ${ex instanceof Error ? ex.message : String(ex)}`);

    // Check for auth errors specifically and update the status
    if (ex instanceof Error && ex.message.includes('401')) {
      await debugLog('Monarch authentication failed - token is invalid');
      await appStorage.patch({ monarchStatus: AuthStatus.NotLoggedIn });
      await logSyncComplete({ success: false, failureReason: FailureReason.NoMonarchAuth });
      return false;
    }

    // Other error handling...
    await logSyncComplete({ success: false, failureReason: FailureReason.MonarchError });
    return false;
  }

  await transactionStorage.patch({
    result: TransactionStatus.Success,
    transactions: monarchTransactions,
  });

  if (dryRun) {
    const matches = matchTransactions(monarchTransactions, orders, appData.options.overrideTransactions);
    await logSyncComplete({
      success: true,
      dryRun: true,
      amazonOrders: orders.length,
      monarchTransactions: monarchTransactions.length,
      transactionsUpdated: matches.length,
    });
    return true;
  }

  return true;
}

async function updateMonarchTransactions() {
  await progressStorage.patch({ phase: ProgressPhase.MonarchUpload, total: 0, complete: 0 });

  const transactions = await transactionStorage.get();
  const appData = await appStorage.get();

  if (!appData.monarchKey) {
    await logSyncComplete({
      success: false,
      failureReason: FailureReason.NoMonarchAuth,
      amazonOrders: transactions.orders.length,
      monarchTransactions: transactions.transactions.length,
    });
    return false;
  }

  const matches = matchTransactions(
    transactions.transactions,
    transactions.orders,
    appData.options.overrideTransactions,
  );

  for (const data of matches) {
    const itemString = data.items
      .filter(item => {
        if (!item.price) {
          debugLog(`item ${item.title} has an unknown price.`);
          return false;
        }
        return true;
      })
      .map(item => {
        return item.quantity + 'x ' + item.title + ' - $' + item.price.toFixed(2);
      })
      .join('\n\n')
      .trim();
    if (itemString.length === 0) {
      await debugLog('No items found for transaction ' + data.monarch.id);
      continue;
    }
    if (data.monarch.notes === itemString) {
      await debugLog('Transaction ' + data.monarch.id + ' already has correct note');
      continue;
    }

    updateMonarchTransaction(appData.monarchKey, data.monarch.id, itemString);
    await debugLog('Updated transaction ' + data.monarch.id + ' with note ' + itemString);
    await progressStorage.patch({
      total: matches.length,
      complete: matches.indexOf(data) + 1,
    });
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await logSyncComplete({
    success: true,
    amazonOrders: transactions.orders.length,
    monarchTransactions: transactions.transactions.length,
    transactionsUpdated: matches.length,
  });
  await progressStorage.patch({ phase: ProgressPhase.Complete });

  return true;
}
