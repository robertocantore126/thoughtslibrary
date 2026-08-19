import DOMPurify from 'dompurify'
import { marked } from 'marked'
import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
})

/**
 * Render a note's Markdown source to sanitized HTML.
 *
 * `breaks: true` turns single newlines into line breaks, so notes written
 * without blank lines (the way most people jot notes) still display line
 * by line instead of collapsing into one paragraph.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) {
    return ''
  }

  const html = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  })

  const sanitized = DOMPurify.sanitize(html)
  return sanitized.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=')
}

/**
 * Convert the HTML produced by the rich-text notes editor back to Markdown
 * so notes keep being stored as plain Markdown strings.
 */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}

/**
 * Strip common Markdown markers so notes read as plain text in exports
 * (e.g. the PDF export) without showing raw `**` / `#` / `[]()` syntax.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^-{2,}$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
