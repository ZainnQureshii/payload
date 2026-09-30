import { buildConfigWithDefaults } from '../buildConfigWithDefaults.js'
import { mergeSecuritySpy } from './mergeSecuritySpy.js'

export const mergeSecurityEditorEmail = 'merge-security-editor@example.com'
export const mergeSecurityPagesSlug = 'merge-security-pages'
export const mergeSecurityPostsSlug = 'merge-security-posts'
export const mergeSecurityTrashEditorEmail = 'merge-security-trash-editor@example.com'

export default buildConfigWithDefaults({
  config: {
    branching: true,
    collections: [
      {
        slug: mergeSecurityPagesSlug,
        access: {
          create: ({ req }) =>
            req.user?.email !== mergeSecurityEditorEmail || mergeSecuritySpy.allowPageCreate,
          delete: ({ req }) => req.user?.email !== mergeSecurityTrashEditorEmail,
          read: ({ req }) => req.user?.email !== mergeSecurityEditorEmail,
          update: ({ req }) => req.user?.email !== mergeSecurityEditorEmail,
        },
        admin: { useAsTitle: 'title' },
        fields: [{ name: 'title', type: 'text' }],
        trash: true,
        versions: false,
      },
      {
        slug: mergeSecurityPostsSlug,
        admin: { useAsTitle: 'title' },
        fields: [{ name: 'title', type: 'text' }],
        hooks: {
          beforeChange: [
            ({ data, operation }) => {
              if (operation === 'create' && data?.title === mergeSecuritySpy.rejectedPostTitle) {
                throw new Error('Rejected by create hook')
              }
            },
          ],
        },
        versions: false,
      },
    ],
  },
  suite: 'branching-merge-security',
})
