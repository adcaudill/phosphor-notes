/**
 * A CSS length for `n` character columns of editor text.
 *
 * Not plain `ch`: the editor sets a letter-spacing (main.css, .cm-content),
 * so each character advances by `1ch` plus that spacing. Sizing by bare `ch`
 * made anything positioned by column - hanging indents, nesting guides, the
 * task checkbox's reserved width - drift left of the text it lines up with,
 * by the spacing times the column count. `--editor-column` is defined next
 * to the letter-spacing it accounts for; `1ch` is the fallback outside the
 * editor.
 */
export function editorColumns(n: number): string {
  return `calc(${n} * var(--editor-column, 1ch))`;
}
