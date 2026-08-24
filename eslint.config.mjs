import antfu from '@antfu/eslint-config'

export default antfu({
  // The agent-brief docs carry intentionally fragmentary TypeScript snippets —
  // contract fragments, not parseable code — so those files are excluded from
  // linting rather than disabling markdown linting for the whole repo.
  //
  // The mindmap briefs additionally quote r-node source verbatim, which is
  // written in r-node's house style (double quotes, semicolons). Reformatting
  // those samples to this repo's style would make them stop matching the file
  // they are telling an agent to port.
  ignores: [
    'LAYERS_AGENT_BRIEFS.md',
    'REVIEW.md',
    'MINDMAP_NATIVE_AGENT_BRIEF.md',
    'MINDMAP_TILE_AGENT_BRIEF.md',
    'LAYER_CANVAS_AGENT_BRIEF.md',
  ],
})
