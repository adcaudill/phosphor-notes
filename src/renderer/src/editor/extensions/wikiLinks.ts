import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  MatchDecorator
} from "@codemirror/view";

// 1. Define the Style
// We add a CSS class 'cm-wiki-link' to the matches
const wikiLinkDecorator = new MatchDecorator({
  regexp: /\[\[(.*?)\]\]/g,
  decoration: (match) => {
    // 'match[1]' is the text inside the brackets
    return Decoration.mark({
      tagName: "span",
      class: "cm-wiki-link", // We will style this in CSS
      attributes: {
        "data-link-target": match[1] // Store the filename in the DOM
      }
    });
  }
});

// 2. Create the View Plugin
export const wikiLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = wikiLinkDecorator.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = wikiLinkDecorator.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (v) => v.decorations
  }
);
