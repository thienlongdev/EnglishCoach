/**
 * Utility to calculate pixel coordinates of a character position or caret inside a <textarea>.
 * Uses an offscreen mirror DOM element with identical computed styles to account for:
 * - font metrics (family, size, weight, line-height)
 * - padding and borders
 * - word-wrapping and letter spacing
 * - textarea scroll offset and bounding client rect
 * - responsive layout width
 */

export interface TextareaCoordinates {
  top: number;       // offset relative to inner content
  left: number;      // offset relative to inner content
  lineHeight: number;
}

export interface SelectionAnchorCoordinates {
  x: number;         // viewport clientX for floating pill
  y: number;         // viewport clientY for floating pill
  anchorY: number;   // viewport clientY at bottom of line (for popover anchoring)
}

const PROPERTIES_TO_COPY = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'MozTabSize',
  'whiteSpace',
  'wordWrap',
  'wordBreak',
  'overflowWrap',
] as const;

/**
 * Returns caret pixel coordinates relative to the top-left of the textarea content.
 */
export function getTextareaCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number
): TextareaCoordinates {
  if (typeof window === 'undefined' || !element) {
    return { top: 0, left: 0, lineHeight: 24 };
  }

  const div = document.createElement('div');
  div.id = 'input-textarea-caret-position-mirror-div';
  document.body.appendChild(div);

  const style = div.style;
  const computed = window.getComputedStyle(element);

  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';
  style.overflowWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.pointerEvents = 'none';
  style.top = '0px';
  style.left = '-9999px';

  PROPERTIES_TO_COPY.forEach((prop) => {
    // @ts-ignore
    style[prop] = computed[prop];
  });

  if (computed.boxSizing === 'border-box') {
    style.width = `${element.offsetWidth}px`;
  } else {
    style.width = `${element.clientWidth}px`;
  }

  // Preceding content
  div.textContent = element.value.substring(0, position);

  // Marker span
  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);

  const parsedLineHeight = parseInt(computed.lineHeight, 10);
  const lineHeight = isNaN(parsedLineHeight) ? 24 : parsedLineHeight;

  const top = span.offsetTop + parseInt(computed.borderTopWidth, 10);
  const left = span.offsetLeft + parseInt(computed.borderLeftWidth, 10);

  document.body.removeChild(div);

  return { top, left, lineHeight };
}

/**
 * Calculates viewport client coordinates (x, y) to anchor the floating "Dịch" pill
 * and subsequent dictionary popover for a selected range in a textarea.
 */
export function getTextareaSelectionAnchor(
  element: HTMLTextAreaElement,
  start: number,
  end: number
): SelectionAnchorCoordinates {
  const startCoord = getTextareaCaretCoordinates(element, start);
  const endCoord = getTextareaCaretCoordinates(element, end);
  const rect = element.getBoundingClientRect();

  let midX: number;
  let topY: number;

  if (startCoord.top === endCoord.top) {
    // Selection is on the same line: place horizontally in the middle of selected text
    midX = rect.left + (startCoord.left + endCoord.left) / 2 - element.scrollLeft;
    topY = rect.top + startCoord.top - element.scrollTop;
  } else {
    // Multi-line selection: place near end of selection
    midX = rect.left + endCoord.left - element.scrollLeft;
    topY = rect.top + endCoord.top - element.scrollTop;
  }

  const lineHeight = startCoord.lineHeight;
  const anchorY = topY + lineHeight;

  // Place floating pill ~36px above the top of the selected text
  let pillY = topY - 36;
  // If too close to top of viewport or top of textarea, flip to display below selection line
  if (pillY < 12 || pillY < rect.top - 40) {
    pillY = topY + lineHeight + 8;
  }

  // Clamp horizontally so the pill stays within screen margins
  const pillX = Math.max(50, Math.min(window.innerWidth - 50, midX));

  return {
    x: pillX,
    y: pillY,
    anchorY
  };
}
