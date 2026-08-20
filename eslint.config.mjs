import antfu from '@antfu/eslint-config'

export default antfu({
  // The repo's two agent-brief docs (LAYERS_AGENT_BRIEFS.md, REVIEW.md) carry
  // intentionally fragmentary TypeScript snippets — contract fragments, not
  // parseable code — so those files are excluded from linting rather than
  // disabling markdown linting for the whole repo.
  ignores: ['LAYERS_AGENT_BRIEFS.md', 'REVIEW.md'],
})
