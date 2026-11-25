/**
 * The reader keeps a learner's highlights by saving its own rendered markup in browser storage and putting it
 * back on the next visit. Storage is not a trusted source: anything able to write it once would otherwise have its
 * markup run on every later visit. Only what the reader itself produces is let back in: text, the block elements it
 * builds, highlight spans, and the `class` attribute. Any other element is replaced by its text; any other attribute
 * (event handlers, `style`, `src`, `href`) is dropped.
 */
const READER_ELEMENTS = new Set(['DIV', 'TABLE', 'TBODY', 'TR', 'TD', 'H2', 'P', 'SPAN', 'BR']);

export function savedReaderMarkup(saved: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = saved; // inert: a template's content runs no script and loads nothing
  const elements = Array.from(template.content.querySelectorAll('*'));
  for (const element of elements) {
    if (!template.content.contains(element)) continue; // already removed together with a parent
    if (!READER_ELEMENTS.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent ?? ''));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name !== 'class') element.removeAttribute(attribute.name);
    }
  }
  return template.content;
}
