import type { Where } from 'payload'

/**
 * The `where` for a branch's upcoming scheduled merges.
 *
 * Kept separate from the server function so client components can build the
 * read query without importing server-only access and error dependencies.
 */
export const buildUpcomingMergeWhere = ({ branchSlug }: { branchSlug: string }): Where => ({
  and: [
    { taskSlug: { equals: 'scheduleMerge' } },
    { completedAt: { exists: false } },
    { processingUntil: { exists: false } },
    { waitUntil: { greater_than: new Date() } },
    { 'input.branch': { equals: branchSlug } },
  ],
})
