import { debugLog } from '@root/src/shared/storages/debugStorage';

export type MonarchTransaction = {
  id: string;
  amount: number;
  date: string;
  notes: string;
};

export async function updateMonarchTransaction(authKey: string, id: string, note: string) {
  const body = {
    operationName: 'Web_TransactionDrawerUpdateTransaction',
    variables: {
      input: {
        id: id,
        notes: note,
      },
    },
    query: `
      mutation Web_TransactionDrawerUpdateTransaction($input: UpdateTransactionMutationInput!) {
        updateTransaction(input: $input) {
          transaction {
            id
            amount
            pending
            date
          }
          errors {
            fieldErrors {
              field
              messages
            }
            message
            code
          }
        }
      }
    `,
  };

  await graphQLRequest(authKey, body);
}

export async function getTransactions(
  authKey: string,
  merchant: string,
  startDate?: Date,
  endDate?: Date,
): Promise<MonarchTransaction[]> {
  const body = {
    operationName: 'Web_GetTransactionsList',
    variables: {
      orderBy: 'date',
      limit: 1000,
      filters: {
        search: merchant,
        categories: [],
        accounts: [],
        startDate: startDate?.toISOString().split('T')[0] ?? undefined,
        endDate: endDate?.toISOString().split('T')[0] ?? undefined,
        tags: [],
      },
    },
    query: `
      query Web_GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
        allTransactions(filters: $filters) {
          totalCount
          results(offset: $offset, limit: $limit, orderBy: $orderBy) {
            id
            amount
            pending
            date
            notes
          }
        }
      }
    `,
  };

  try {
    // Log the request we're making
    await debugLog(
      `Making Monarch request with merchant: ${merchant}, date range: ${startDate?.toISOString() || 'none'} - ${
        endDate?.toISOString() || 'none'
      }`,
    );
    await debugLog(`Auth key (first 10 chars): ${authKey.substring(0, 10)}...`);

    const result = await graphQLRequest(authKey, body);

    // Debug the raw response with more detailed information
    await debugLog(`Monarch API HTTP status succeeded`);

    // Capture the full response type
    await debugLog(`Response type: ${typeof result}, is null: ${result === null}, is array: ${Array.isArray(result)}`);

    // If result is defined, log more structure information
    if (result) {
      await debugLog(`Response keys: ${Object.keys(result).join(', ')}`);

      // Full response data - careful with large responses
      try {
        const responseStr = JSON.stringify(result);
        await debugLog(`Full response (first 2000 chars): ${responseStr.substring(0, 2000)}...`);
      } catch (jsonErr) {
        await debugLog(`Could not stringify response: ${String(jsonErr)}`);
      }
    }

    // Check for specific error conditions
    if (!result) {
      throw new Error('Empty response from Monarch API');
    }

    if (result.errors) {
      await debugLog(`GraphQL errors found: ${JSON.stringify(result.errors)}`);
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    if (!result.data) {
      await debugLog(`Missing data field. Response structure: ${Object.keys(result).join(', ')}`);
      throw new Error(`Missing data field in response: ${JSON.stringify(result)}`);
    }

    if (!result.data.allTransactions) {
      await debugLog(`Missing allTransactions. Data keys: ${Object.keys(result.data).join(', ')}`);
      throw new Error(`Missing allTransactions in response data: ${JSON.stringify(result.data)}`);
    }

    return result.data.allTransactions.results || [];
  } catch (error) {
    console.error('Error fetching Monarch transactions:', error);

    // Log detailed error information
    if (error instanceof Error) {
      await debugLog(`Error name: ${error.name}`);
      await debugLog(`Error message: ${error.message}`);
      await debugLog(`Error stack: ${error.stack}`);

      // Check for network errors
      if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
        await debugLog('Appears to be a network error - check your internet connection or Monarch API endpoint');
      }
    }

    // Re-throw with more context
    throw new Error(
      `Failed to get transactions from Monarch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function graphQLRequest(authKey: string, body: unknown) {
  try {
    await debugLog('Starting GraphQL request to Monarch API...');

    // Check if the token already has "Token " prefix
    const tokenHeader = authKey.startsWith('Token ') ? authKey : `Token ${authKey}`;
    await debugLog(`Using authorization header: ${tokenHeader.substring(0, 16)}...`);

    const response = await fetch('https://api.monarchmoney.com/graphql', {
      headers: {
        authorization: tokenHeader,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        origin: 'https://app.monarchmoney.com',
        referer: 'https://app.monarchmoney.com/',
      },
      body: JSON.stringify(body),
      method: 'POST',
      credentials: 'include', // Include cookies in case they're needed
    });

    // Log HTTP status
    await debugLog(`Monarch API HTTP status: ${response.status} (${response.statusText})`);

    if (!response.ok) {
      await debugLog(`HTTP error response: ${response.status} ${response.statusText}`);

      // Try to get error details from response body if possible
      try {
        const errorText = await response.text();
        await debugLog(`Error response body: ${errorText.substring(0, 1000)}...`);
      } catch (textErr) {
        await debugLog(`Could not read error response body: ${String(textErr)}`);
      }

      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    const jsonResult = await response.json();
    return jsonResult;
  } catch (error) {
    console.error('GraphQL request failed:', error);
    await debugLog(`GraphQL request failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
