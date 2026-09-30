import type { MarkRequired } from 'ts-essentials'

import type { PayloadRequest } from '../types/index.js'

import {
  clearTransactionRollbackCallbacks,
  runTransactionCommitCallbacks,
} from './transactionCallbacks.js'

/**
 * complete a transaction calling adapter db.commitTransaction and delete the transactionID from req
 */
export async function commitTransaction(
  req: MarkRequired<Partial<PayloadRequest>, 'payload'>,
): Promise<void> {
  const { payload, transactionID } = req
  const resolvedTransactionID = await transactionID!

  await payload.db.commitTransaction(resolvedTransactionID)
  delete req.transactionID
  clearTransactionRollbackCallbacks({ req, transactionID: resolvedTransactionID })

  try {
    await runTransactionCommitCallbacks({ req, transactionID: resolvedTransactionID })
  } catch (err) {
    payload.logger.error({ err, msg: 'A post-commit cleanup task failed.' })
  }
}
