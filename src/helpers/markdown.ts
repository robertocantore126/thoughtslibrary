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

// Preserve inline formatting that Markdown has no syntax for (underline, text
// color, highlight) as raw HTML. Turndown's default rules drop those tags, so
// the stored Markdown would silently lose them on the next re-render.
turndown.addRule('underline', {
  filter: node => node.nodeName === 'U',
  replacement: content => `<u>${content}</u>`,
})

turndown.addRule('fontColor', {
  filter: node => node.nodeName === 'FONT' && node.hasAttribute('color'),
  replacement: (content, node) => {
    const element = node as HTMLElement
    const color = element.getAttribute('color') || ''
    // Chromium can merge a highlight into the same <font> element, so keep
    // any color declarations it carries alongside the text color.
    const kept = String(element.getAttribute('style') || '')
      .split(';')
      .map(part => part.trim())
      .filter(part => /^(?:color|background-color)\s*:/i.test(part))
      .join('; ')
    const style = kept ? `${kept}; color: ${color}` : `color: ${color}`
    return `<span style="${style}">${content}</span>`
  },
})

turndown.addRule('styledSpan', {
  filter: node => node.nodeName === 'SPAN' && node.hasAttribute('style'),
  replacement: (content, node) => {
    // Keep only the color declarations this editor can produce.
    const kept = String((node as HTMLElement).getAttribute('style') || '')
      .split(';')
      .map(part => part.trim())
      .filter(part => /^(?:color|background-color)\s*:/i.test(part))
      .join('; ')
    if (!kept) {
      return content
    }
    return `<span style="${kept}">${content}</span>`
  },
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
