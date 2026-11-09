import { MAX_HALL_PROMPT, type HallReply } from './hall.js';
import { brandedTitle, card, displayText } from './ui.js';

const PAGE_SIZE = 2_400;
const MAX_PAGES = 10;

// Scan complete Markdown destinations (including balanced URL parentheses) and bare links.
// Splitting one in the middle can turn a citation into a link to the wrong address.
function sourceLinks(text: string): { start: number; end: number }[] {
  const tokens = /\[(?:\\[^\r\n]|[^\]\\\r\n]){1,200}\]\(<?https?:\/\/|https?:\/\/[^\s<>]+/gi;
  const spans: { start: number; end: number }[] = [];
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    if (!match[0].startsWith('[')) { spans.push({ start: match.index, end: tokens.lastIndex }); continue; }
    let depth = 1;
    let end = tokens.lastIndex;
    let angle = /\]\(<https?:\/\/$/i.test(match[0]);
    for (; end < text.length; end++) {
      const character = text[end]!;
      if (/[\r\n]/.test(character) || (!angle && /\s/.test(character))) break;
      if (character === '\\') end++;
      else if (angle) { if (character === '>') angle = false; }
      else if (character === '(') depth++;
      else if (character === ')' && --depth === 0) break;
    }
    if (depth === 0) {
      spans.push({ start: match.index, end: end + 1 });
      tokens.lastIndex = end + 1;
    } else tokens.lastIndex = match.index + match[0].toLowerCase().lastIndexOf('http');
  }
  return spans;
}

function answerPages(text: string, firstSize: number): string[] {
  // Very long citations cannot fit on a card. Render them as inert text without
  // requiring file attachments or cutting a live link at an arbitrary boundary.
  for (const span of sourceLinks(text).filter(link => link.end - link.start > PAGE_SIZE - 48).reverse()) {
    const literal = displayText(text.slice(span.start, span.end), span.end - span.start);
    text = text.slice(0, span.start) + literal + text.slice(span.end);
  }
  const links = sourceLinks(text);
  const pages: string[] = [];
  let offset = 0;
  let fence: string | null = null;
  while (offset < text.length && pages.length < MAX_PAGES) {
    const prefix = fence === null ? '' : `\`\`\`${fence}\n`;
    const limit = (pages.length ? PAGE_SIZE : firstSize) - prefix.length - 5;
    let end = Math.min(offset + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > offset + limit / 2) end = newline + 1;
      else {
        const space = text.lastIndexOf(' ', end - 1);
        if (space > offset + limit * 0.85) end = space + 1;
      }
      const crossing = links.find(link => link.start < end && end < link.end);
      if (crossing) {
        if (crossing.start === offset) {
          pages.push('The answer continues on the next card.');
          continue;
        }
        end = crossing.start;
      }
      if (/[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
      // Keep escape pairs together if a link had to be rendered literally.
      const slashes = /\\+$/.exec(text.slice(offset, end))?.[0].length ?? 0;
      if (slashes % 2) end--;
    }
    const part = text.slice(offset, end);
    for (const match of part.matchAll(/^```([^\r\n`]*)/gm)) {
      if (match.index === 0 && offset && text[offset - 1] !== '\n') continue;
      const language = match[1]?.trim() ?? '';
      fence = fence !== null ? null : /^[\w#+.-]{0,32}$/.test(language) ? language : 'text';
    }
    pages.push(prefix + part + (fence === null ? '' : '\n```'));
    offset = end;
  }
  if (offset < text.length) pages.push('This reply reached the Discord display limit. Ask a follow-up for the rest.');
  return pages;
}

export function hallCards(prompt: string, answer: HallReply, emoji: string) {
  const question = displayText(prompt, MAX_HALL_PROMPT);
  const reply = answer.reply.trim()
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/<(?=@[!&]?\d|#\d|a?:[\w]+:\d|t:-?\d|\/[^:\n]+:\d)/g, '‹')
    .replace(/(^|\s)@(everyone|here)\b/g, '$1@\u200b$2') || 'No displayable text was returned.';
  const body = reply + (answer.truncated ? '\n\n*Hall reached its reply limit. Ask a follow-up to continue.*' : '');
  const pages = answerPages(body, PAGE_SIZE - question.length);
  const status = ['hallAI', answer.webSearch && 'Web search used', answer.contextFresh && 'Fresh context',
    answer.safety === 'checked' && 'Safety checked', answer.safety === 'redirected' && 'Safer direction',
    answer.safety === 'support' && 'Support'].filter(Boolean).join(' • ');
  return pages.map((page, index) => card(brandedTitle(index ? 'hallAI · continued' : 'hallAI', emoji), '', [
    ...(index ? [] : [{ name: 'Your question', value: question }]),
    { name: index ? 'Answer continued' : 'Answer', value: page },
  ], { footer: status + (pages.length > 1 ? ` • ${index + 1}/${pages.length}` : '') }));
}
