import { expect, test, vi } from 'vitest'

import type { PayloadRequest } from '../types/index.js'

import { ValidationError } from '../errors/ValidationError.js'
import { createShadowRow } from './createShadowRow.js'

const branch = 'feature'
const collectionSlug = 'posts'
const data = { _branch: branch, _branchDocID: 'main-id', title: 'Shadow' }
const docID = 'main-id'
const shadow = { ...data, id: 'shadow-id' }

test('should use database copy for a shadow with an explicit source', async () => {
  const copy = vi.fn().mockResolvedValue(shadow)
  const create = vi.fn()
  const onCreated = vi.fn().mockResolvedValue(undefined)
  const req = {
    payload: {
      db: {
        beginTransaction: vi.fn().mockResolvedValue('copy-transaction'),
        commitTransaction: vi.fn().mockResolvedValue(undefined),
        copy,
        create,
        rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated,
      req,
      source: { branch: 'main', id: docID },
    }),
  ).resolves.toBe(shadow)

  const copyReq = copy.mock.calls[0]![0].req as PayloadRequest

  expect(copy).toHaveBeenCalledWith({
    collection: collectionSlug,
    data,
    destination: { branch },
    req: copyReq,
    source: { branch: 'main', id: docID },
  })
  expect(create).not.toHaveBeenCalled()
  expect(onCreated).toHaveBeenCalledWith(copyReq, shadow)
})

test('should recover a competing database copy after a uniqueness failure', async () => {
  const copyError = new ValidationError({
    collection: collectionSlug,
    errors: [{ message: 'Value must be unique', path: '_branchDocID' }],
  })
  const create = vi.fn()
  const req = {
    payload: {
      db: {
        copy: vi.fn().mockRejectedValue(copyError),
        create,
        findOne: vi.fn().mockResolvedValue(shadow),
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: vi.fn(),
      req,
      source: { branch: 'main', id: docID },
    }),
  ).resolves.toBe(shadow)

  expect(create).not.toHaveBeenCalled()
})

test('should recover a competing database copy after a transient transaction conflict', async () => {
  const copyError = {
    hasErrorLabel: (label: string) => label === 'TransientTransactionError',
    message: 'Please retry your operation or multi-document transaction.',
  }
  const req = {
    payload: {
      db: {
        copy: vi.fn().mockRejectedValue(copyError),
        findOne: vi.fn().mockResolvedValue(shadow),
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: vi.fn(),
      req,
      source: { branch: 'main', id: docID },
    }),
  ).resolves.toBe(shadow)
})

test('should wait for a competing shadow transaction to become visible', async () => {
  const copyError = {
    hasErrorLabel: (label: string) => label === 'TransientTransactionError',
    message: 'Please retry your operation or multi-document transaction.',
  }
  const findOne = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(shadow)
  const req = {
    payload: {
      db: {
        copy: vi.fn().mockRejectedValue(copyError),
        findOne,
      },
    },
    transactionID: 'caller-transaction',
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: vi.fn(),
      req,
      source: { branch: 'main', id: docID },
    }),
  ).resolves.toBe(shadow)

  expect(findOne).toHaveBeenCalledTimes(6)
  expect((findOne.mock.calls[0]![0] as { req: PayloadRequest }).req.transactionID).toBeUndefined()
  expect(req.transactionID).toBe('caller-transaction')
})

test('should create the shadow and registry in an ambient transaction without resolving it', async () => {
  const callerFile = { name: 'upload.txt' }
  const commitTransaction = vi.fn()
  const create = vi.fn().mockResolvedValue(shadow)
  const onCreated = vi.fn().mockImplementation((createReq: PayloadRequest) => {
    delete createReq.file

    return Promise.resolve()
  })
  const rollbackTransaction = vi.fn()
  const req = {
    file: callerFile,
    payload: {
      db: {
        beginTransaction: vi.fn(),
        commitTransaction,
        create,
        rollbackTransaction,
      },
    },
    transactionID: 'operation-transaction',
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated,
      req,
      useAmbientTransaction: true,
    }),
  ).resolves.toBe(shadow)

  const ambientReq = create.mock.calls[0]![0].req as PayloadRequest

  expect(create).toHaveBeenCalledWith({
    collection: collectionSlug,
    data,
    req: ambientReq,
  })
  expect(ambientReq).not.toBe(req)
  expect(ambientReq.transactionID).toBe('operation-transaction')
  expect(onCreated).toHaveBeenCalledWith(ambientReq, shadow)
  expect(commitTransaction).not.toHaveBeenCalled()
  expect(rollbackTransaction).not.toHaveBeenCalled()
  expect(req.file).toBe(callerFile)
  expect(req.transactionID).toBe('operation-transaction')
})

test('should restart an ambient transaction after recovering a competing shadow', async () => {
  const createError = new ValidationError({
    collection: collectionSlug,
    errors: [{ message: 'Value must be unique', path: '_branchDocID' }],
  })
  const beginTransaction = vi.fn().mockResolvedValue('replacement-transaction')
  const findOne = vi.fn().mockResolvedValue(shadow)
  const rollbackTransaction = vi.fn().mockResolvedValue(undefined)
  const req = {
    payload: {
      db: {
        beginTransaction,
        create: vi.fn().mockRejectedValue(createError),
        findOne,
        rollbackTransaction,
      },
    },
    transactionID: 'operation-transaction',
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: vi.fn(),
      req,
      useAmbientTransaction: true,
    }),
  ).resolves.toBe(shadow)

  expect(rollbackTransaction).toHaveBeenCalledWith('operation-transaction')
  expect(findOne).toHaveBeenCalledOnce()
  expect(beginTransaction).toHaveBeenCalledOnce()
  expect(req.transactionID).toBe('replacement-transaction')
})

test('should restart an ambient transaction after a competing change record wins', async () => {
  const changeError = new ValidationError({
    collection: 'payload-branch-changes',
    errors: [{ message: 'Value must be unique', path: 'documentID' }],
  })
  const beginTransaction = vi.fn().mockResolvedValue('replacement-transaction')
  const findOne = vi.fn().mockResolvedValue(shadow)
  const rollbackTransaction = vi.fn().mockResolvedValue(undefined)
  const req = {
    payload: {
      db: {
        beginTransaction,
        create: vi.fn().mockResolvedValue(shadow),
        findOne,
        rollbackTransaction,
      },
    },
    transactionID: 'operation-transaction',
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: vi.fn().mockRejectedValue(changeError),
      req,
      useAmbientTransaction: true,
    }),
  ).resolves.toBe(shadow)

  expect(rollbackTransaction).toHaveBeenCalledWith('operation-transaction')
  expect(findOne).toHaveBeenCalledOnce()
  expect(beginTransaction).toHaveBeenCalledOnce()
  expect(req.transactionID).toBe('replacement-transaction')
})

test('should leave an ambient transaction owner to handle an onCreated failure', async () => {
  const onCreatedError = new Error('registry create failed')
  const deleteOne = vi.fn()
  const rollbackTransaction = vi.fn()
  const req = {
    payload: {
      db: {
        create: vi.fn().mockResolvedValue(shadow),
        deleteOne,
        rollbackTransaction,
      },
    },
    transactionID: 'operation-transaction',
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.reject(onCreatedError),
      req,
      useAmbientTransaction: true,
    }),
  ).rejects.toBe(onCreatedError)

  expect(deleteOne).not.toHaveBeenCalled()
  expect(rollbackTransaction).not.toHaveBeenCalled()
  expect(req.transactionID).toBe('operation-transaction')
})

test('should rethrow an onCreated failure when transactions are unavailable', async () => {
  const onCreatedError = new Error('registry create failed')
  const deleteOne = vi.fn().mockResolvedValue(shadow)
  const findOne = vi.fn().mockResolvedValue(shadow)
  const req = {
    payload: {
      db: {
        create: vi.fn().mockResolvedValue(shadow),
        deleteOne,
        findOne,
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.reject(onCreatedError),
      req,
    }),
  ).rejects.toBe(onCreatedError)

  expect(findOne).not.toHaveBeenCalled()
  expect(deleteOne).toHaveBeenCalledWith({
    branch: false,
    collection: collectionSlug,
    req: expect.anything(),
    where: { id: { equals: shadow.id } },
  })
})

test('should preserve an onCreated failure when shadow cleanup also fails', async () => {
  const cleanupError = new Error('shadow cleanup failed')
  const onCreatedError = new Error('registry create failed')
  const deleteOne = vi.fn().mockRejectedValue(cleanupError)
  const req = {
    payload: {
      db: {
        create: vi.fn().mockResolvedValue(shadow),
        deleteOne,
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.reject(onCreatedError),
      req,
    }),
  ).rejects.toBe(onCreatedError)

  expect(deleteOne).toHaveBeenCalledWith({
    branch: false,
    collection: collectionSlug,
    req: expect.anything(),
    where: { id: { equals: shadow.id } },
  })
})

test('should rethrow a non-validation create failure when a shadow row is visible', async () => {
  const createError = new Error('database unavailable')
  const findOne = vi.fn().mockResolvedValue(shadow)
  const req = {
    payload: {
      db: {
        create: vi.fn().mockRejectedValue(createError),
        findOne,
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.resolve(),
      req,
    }),
  ).rejects.toBe(createError)

  expect(findOne).not.toHaveBeenCalled()
})

test('should rethrow an unrelated validation create failure when a shadow row is visible', async () => {
  const createError = new ValidationError({
    collection: collectionSlug,
    errors: [{ message: 'Value is invalid', path: 'title' }],
  })
  const findOne = vi.fn().mockResolvedValue(shadow)
  const req = {
    payload: {
      db: {
        create: vi.fn().mockRejectedValue(createError),
        findOne,
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.resolve(),
      req,
    }),
  ).rejects.toBe(createError)

  expect(findOne).not.toHaveBeenCalled()
})

test.each([
  '_branchDocID',
  '_branch_doc_id',
  '_branchdocid_id',
  '_branchdocid_id, _branch',
  '_branch',
])('should return a competing shadow row after a %s uniqueness failure', async (path) => {
  const createError = new ValidationError({
    collection: collectionSlug,
    errors: [{ message: 'Value must be unique', path }],
  })
  const req = {
    payload: {
      db: {
        create: vi.fn().mockRejectedValue(createError),
        findOne: vi.fn().mockResolvedValue(shadow),
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.resolve(),
      req,
    }),
  ).resolves.toBe(shadow)
})

test('should rethrow a commit failure when the created shadow row is visible', async () => {
  const commitError = new Error('commit failed')
  const findOne = vi.fn().mockResolvedValue(shadow)
  const req = {
    payload: {
      db: {
        beginTransaction: vi.fn().mockResolvedValue('transaction-id'),
        commitTransaction: vi.fn().mockRejectedValue(commitError),
        create: vi.fn().mockResolvedValue(shadow),
        findOne,
        rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.resolve(),
      req,
    }),
  ).rejects.toBe(commitError)

  expect(findOne).not.toHaveBeenCalled()
})

test('should recover a competing shadow when a transient conflict surfaces on commit', async () => {
  const commitError = {
    errorLabels: ['TransientTransactionError'],
    message: 'Please retry your operation or multi-document transaction.',
  }
  const req = {
    payload: {
      db: {
        beginTransaction: vi.fn().mockResolvedValue('transaction-id'),
        commitTransaction: vi.fn().mockRejectedValue(commitError),
        create: vi.fn().mockResolvedValue(shadow),
        findOne: vi.fn().mockResolvedValue(shadow),
        rollbackTransaction: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as PayloadRequest

  await expect(
    createShadowRow({
      branch,
      collectionSlug,
      data,
      docID,
      onCreated: () => Promise.resolve(),
      req,
    }),
  ).resolves.toBe(shadow)
})
