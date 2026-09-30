import type { CopyArgs } from '../database/types.js'
import type { PayloadRequest } from '../types/index.js'

import { APIError } from '../errors/index.js'
import { ValidationError } from '../errors/ValidationError.js'
import { commitTransaction } from '../utilities/commitTransaction.js'
import { initTransaction } from '../utilities/initTransaction.js'
import { isolateObjectProperty } from '../utilities/isolateObjectProperty.js'
import { killTransaction } from '../utilities/killTransaction.js'
import { branchChangesCollectionSlug, branchDocIDField, branchField } from './types.js'

type Args = {
  branch: string
  collectionSlug: string
  data: Record<string, unknown>
  /** The canonical document this row represents, for the recovery read on conflict. */
  docID: number | string
  /**
   * Runs only when this call creates the row, inside the same transaction
   * as the row create — typically the accompanying
   * `payload-branch-changes` entry. Never called on the losing side, whose
   * caller already created (or is creating) its own.
   */
  onCreated: (req: PayloadRequest, shadow: Record<string, unknown>) => Promise<unknown>
  /** Whether this helper may roll back and replace the request's existing transaction. */
  ownsAmbientTransaction?: boolean
  req: PayloadRequest
  /** Copies an exact logical source document instead of creating from data alone. */
  source?: CopyArgs['source']
  /** Uses the request's existing transaction and leaves commit or rollback to its owner. */
  useAmbientTransaction?: boolean
}

const isShadowUniquenessError = (error: unknown): error is ValidationError =>
  error instanceof ValidationError &&
  error.data.errors.some(({ path }) =>
    path
      .split(',')
      .map((fieldPath) => fieldPath.trim())
      .some(
        (fieldPath) =>
          fieldPath === branchDocIDField ||
          fieldPath === '_branch_doc_id' ||
          fieldPath === '_branchdocid_id' ||
          fieldPath === 'documentID' ||
          fieldPath === branchField,
      ),
  )

const isTransientTransactionError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const labeledError = error as {
    errorLabels?: string[]
    hasErrorLabel?: (label: string) => boolean
  }

  return (
    labeledError.hasErrorLabel?.('TransientTransactionError') === true ||
    labeledError.errorLabels?.includes('TransientTransactionError') === true
  )
}

const isRecoverableConcurrentShadowError = (error: unknown): boolean =>
  isShadowUniquenessError(error) || isTransientTransactionError(error)

const competingShadowReadDelayMilliseconds = 25
const maximumCompetingShadowReadAttempts = 20

const findCompetingShadow = async ({
  branch,
  collectionSlug,
  docID,
  req,
}: {
  branch: string
  collectionSlug: string
  docID: number | string
  req: PayloadRequest
}): Promise<null | Record<string, unknown>> => {
  const recoveryReq = isolateObjectProperty(req, ['transactionID'])

  delete recoveryReq.transactionID

  // MongoDB does not expose an in-progress transaction's write until it commits.
  // The losing conflict can surface first, so allow the winning transaction a
  // short, bounded period to become visible.
  for (let attempt = 0; attempt < maximumCompetingShadowReadAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, competingShadowReadDelayMilliseconds))
    }

    const winner = (await req.payload.db.findOne({
      branch: false,
      collection: collectionSlug,
      req: recoveryReq,
      where: {
        and: [{ [branchField]: { equals: branch } }, { [branchDocIDField]: { equals: docID } }],
      },
    })) as null | Record<string, unknown>

    if (winner) {
      const change = await req.payload.db.findOne({
        collection: branchChangesCollectionSlug,
        req: recoveryReq,
        where: {
          and: [
            { branch: { equals: branch } },
            { collectionSlug: { equals: collectionSlug } },
            { documentID: { equals: String(docID) } },
          ],
        },
      })

      if (!change) {
        throw new APIError(
          `The ${collectionSlug} branch row for document ${String(docID)} has no change record.`,
          409,
        )
      }

      return winner
    }
  }

  return null
}

/**
 * Creates a branch's shadow row for a document, safe against two concurrent
 * first-edits of the same document on the same branch racing to create it.
 *
 * The unique index on `(_branchDocID, _branch)` is what turns the losing side
 * into a rejection instead of a second, duplicate shadow row — but the create
 * runs in a transaction of its own, isolated from the caller's, rather than
 * the caller's ambient one. A losing race has to recover with a plain read,
 * and Postgres refuses any further command on a transaction once one
 * statement inside it fails — including that read — until it is rolled back.
 * A transaction of its own can be rolled back and moved past without
 * disturbing the write the caller is in the middle of.
 *
 * A branch operation can opt into creating the shadow and registry in the
 * request's existing transaction. When the operation owns that transaction,
 * a concurrent first-edit loss rolls it back and starts a replacement. A
 * caller-owned transaction is never committed, rolled back or replaced here.
 */
export const createShadowRow = async ({
  branch,
  collectionSlug,
  data,
  docID,
  onCreated,
  ownsAmbientTransaction = true,
  req,
  source,
  useAmbientTransaction = false,
}: Args): Promise<Record<string, unknown>> => {
  if (useAmbientTransaction) {
    const ambient = isolateObjectProperty(req, ['file'])
    const transactionID = await ambient.transactionID

    if (!transactionID) {
      throw new Error('Ambient shadow creation requires an active transaction.')
    }

    try {
      const shadow = await createShadowContent({
        branch,
        collectionSlug,
        data,
        req: ambient,
        source,
      })

      await onCreated(ambient, shadow)

      return shadow
    } catch (error) {
      if (!ownsAmbientTransaction || !isRecoverableConcurrentShadowError(error)) {
        throw error
      }

      await killTransaction(req)

      const winner = await findCompetingShadow({ branch, collectionSlug, docID, req })

      if (!winner || !(await initTransaction(req))) {
        throw error
      }

      return winner
    }
  }

  // Registry writes use the same request so that they share the branch fork's transaction.
  // A nested Local API create clears `req.file` when no file is supplied, so isolate that
  // property as well or an upload replacement disappears before the real branch update runs.
  const isolated = isolateObjectProperty(req, ['file', 'transactionID'])

  delete isolated.transactionID

  const shouldCommit = await initTransaction(isolated)
  let shadow: Record<string, unknown>

  try {
    shadow = await createShadowContent({
      branch,
      collectionSlug,
      data,
      req: isolated,
      source,
    })
  } catch (error) {
    await killTransaction(isolated)

    if (!isRecoverableConcurrentShadowError(error)) {
      throw error
    }

    const winner = await findCompetingShadow({ branch, collectionSlug, docID, req })

    if (!winner) {
      throw error
    }

    return winner
  }

  try {
    await onCreated(isolated, shadow)

    if (shouldCommit) {
      await commitTransaction(isolated)
    }

    return shadow
  } catch (error) {
    await killTransaction(isolated)

    if (shouldCommit && isRecoverableConcurrentShadowError(error)) {
      const winner = await findCompetingShadow({ branch, collectionSlug, docID, req })

      if (winner) {
        return winner
      }
    }

    const shadowID = shadow.id

    if (!shouldCommit && (typeof shadowID === 'string' || typeof shadowID === 'number')) {
      try {
        await isolated.payload.db.deleteOne({
          branch: false,
          collection: collectionSlug,
          req: isolated,
          where: { id: { equals: shadowID } },
        })
      } catch {
        // The callback error remains the reason this operation failed.
      }
    }

    throw error
  }
}

const createShadowContent = async ({
  branch,
  collectionSlug,
  data,
  req,
  source,
}: {
  branch: string
  collectionSlug: string
  data: Record<string, unknown>
  req: PayloadRequest
  source?: CopyArgs['source']
}): Promise<Record<string, unknown>> => {
  if (source) {
    return req.payload.db.copy({
      collection: collectionSlug,
      data,
      destination: { branch },
      req,
      source,
    }) as Promise<Record<string, unknown>>
  }

  return req.payload.db.create({
    collection: collectionSlug,
    data,
    req,
  }) as Promise<Record<string, unknown>>
}
