import React, { useEffect, useRef, useMemo, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, KeyBinding } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { wikiLinkPlugin } from '../editor/extensions/wikiLinks';
import { imagePreviewPlugin } from '../editor/extensions/imagePreview';
import { taskCheckboxPlugin, cycleTaskStatus } from '../editor/extensions/taskCheckbox';
import { dateIndicatorPlugin } from '../editor/extensions/dateIndicator';
import { typewriterScrollPlugin } from '../editor/extensions/typewriter';
import { dimmingPlugin, suppressDimmingEffect } from '../editor/extensions/dimming';
import { createGrammarLint } from '../editor/extensions/grammar';
import { smartTypographyExtension } from '../editor/extensions/smartTypography';
import { createOutlinerKeymap } from '../editor/extensions/outlinerKeymap';
import { createSearchExtension, createSearchAPI } from '../editor/extensions/search';
import { useSettings } from '../hooks/useSettings';
import { pdfWidgetPlugin } from '../editor/extensions/pdfWidget';
import { SearchPanel } from './SearchPanel';
import {
  extractFrontmatter,
  reconstructDocument,
  type Frontmatter
} from '../utils/frontmatterUtils';

// Dark mode highlight style with proper color contrast
const darkModeHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.heading1, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.heading2, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.heading3, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.processingInstruction, color: '#b0b0b0' }, // For --- and similar
  { tag: t.punctuation, color: '#b0b0b0' },
  { tag: t.quote, color: '#78716c', fontStyle: 'italic' },
  { tag: t.link, color: '#60a5fa' },
  { tag: t.url, color: '#4ade80' },
  { tag: t.emphasis, color: '#ecf0f1', fontStyle: 'italic' },
  { tag: t.strong, color: '#ecf0f1', fontWeight: 'bold' },
  { tag: t.strikethrough, color: '#6b7280', textDecoration: 'line-through' },
  { tag: t.meta, color: '#b0b0b0' },
  { tag: t.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.atom, color: '#b0b0b0' },
  { tag: t.keyword, color: '#b0b0b0' },
  { tag: t.string, color: '#f87171' },
  { tag: t.variableName, color: '#ecf0f1' }
]);

interface EditorProps {
  initialDoc: string;
  onChange: (doc: string) => void;
  onLinkClick?: (link: string) => void;
  enableDimming?: boolean;
  onSearchOpen?: (isOpen: boolean) => void;
  currentFile?: string | null;
}

export const Editor: React.FC<EditorProps> = ({
  initialDoc,
  onChange,
  onLinkClick,
  enableDimming = false,
  onSearchOpen,
  currentFile
}) => {
  const { settings } = useSettings();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onLinkClickRef = useRef(onLinkClick);
  const frontmatterRef = useRef<Frontmatter | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchAPI, setSearchAPI] = useState<ReturnType<typeof createSearchAPI> | null>(null);

  // Extract frontmatter and content, memoized to avoid re-extraction on every render
  const { frontmatter, content } = useMemo(() => extractFrontmatter(initialDoc), [initialDoc]);

  // Determine if this is an outliner mode document
  const isOutlinerMode = useMemo(() => {
    if (!frontmatter || !frontmatter.content) return false;
    return frontmatter.content.mode === 'outliner';
  }, [frontmatter]);

  // Update the frontmatter ref whenever extraction changes
  useEffect(() => {
    frontmatterRef.current = frontmatter;
  }, [frontmatter]);

  // Keep refs up-to-date so CodeMirror listeners call the latest handlers
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  useEffect(() => {
    if (!editorRef.current) return;

    // Build the keymap based on journal mode
    const baseKeymap = [
      ...defaultKeymap,
      ...historyKeymap,
      {
        key: 'Mod-Enter',
        run: cycleTaskStatus
      } as KeyBinding,
      {
        key: 'Mod-f',
        run: () => {
          setShowSearch((prev) => !prev);
          return true;
        }
      } as KeyBinding
    ];

    const finalKeymap = isOutlinerMode ? [...createOutlinerKeymap(), ...baseKeymap] : baseKeymap;

    // 1. Define the Initial State (use only the content, without frontmatter)
    const startState = EditorState.create({
      doc: content,
      extensions: [
        keymap.of([...closeBracketsKeymap, ...finalKeymap]), // include close-brackets keymap first
        EditorView.lineWrapping, // Soft wrap long lines
        markdown(), // Markdown syntax support
        markdownLanguage.data.of({
          closeBrackets: { brackets: ['[', '{', '`', '```', '*', '**', '_', '__'] }
        }),
        closeBrackets(), // Automatic bracket closing
        ...(settings.enableSmartTypography ? [smartTypographyExtension()] : []), // Smart quotes/dashes/symbols
        history(), // Undo/Redo stack
        syntaxHighlighting(darkModeHighlightStyle), // Use custom dark mode colors
        taskCheckboxPlugin, // Task checkboxes
        dateIndicatorPlugin, // Date pill indicators
        typewriterScrollPlugin, // Typewriter scrolling (cursor centered)
        createGrammarLint({
          checkPassiveVoice: settings.checkPassiveVoice,
          checkSimplification: settings.checkSimplification,
          checkInclusiveLanguage: settings.checkInclusiveLanguage,
          checkReadability: settings.checkReadability,
          checkProfanities: settings.checkProfanities,
          checkCliches: settings.checkCliches,
          checkIntensify: settings.checkIntensify
        }), // Grammar and style checking
        ...(enableDimming ? [dimmingPlugin] : []), // Paragraph dimming (optional)
        createSearchExtension(), // Search functionality

        // 2. Listener for changes (call latest handler via ref, reconstruct with frontmatter)
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            try {
              const contentOnly = update.state.doc.toString();
              const fullDoc = reconstructDocument(frontmatterRef.current, contentOnly);
              onChangeRef.current(fullDoc);
            } catch (e) {
              console.error(e);
            }
          }
        }),

        // 3. Visual Styling (Minimalist Theme)
        EditorView.theme(
          {
            '&': { height: '100%', fontSize: '16px' },
            '.cm-scroller': { fontFamily: "Menlo, Monaco, 'Courier New', monospace" },
            '.cm-content': {
              caretColor: '#569cd6',
              maxWidth: '800px',
              margin: '0 auto',
              padding: '40px'
            },
            '&.cm-focused': { outline: 'none' }
          },
          { dark: true }
        ),
        // Wiki link plugin and click handler
        wikiLinkPlugin,
        imagePreviewPlugin,
        pdfWidgetPlugin,
        EditorView.domEventHandlers({
          paste: (event, view) => {
            const items = event.clipboardData?.items;
            if (!items) return false;

            const insertAsset = async (file: File): Promise<void> => {
              const buffer = await file.arrayBuffer();
              const filename = await window.phosphor.saveAsset(buffer, file.name);
              const text = `![[${filename}]]`;
              view.dispatch(view.state.replaceSelection(text));
            };

            for (const item of items) {
              const file = item.getAsFile();
              if (!file) continue;

              const isImage = file.type.startsWith('image/');
              const isPdf = file.type === 'application/pdf';
              if (!isImage && !isPdf) continue;

              event.preventDefault();
              insertAsset(file).catch((err) => console.error('Failed to save asset:', err));
              return true;
            }
            return false;
          },
          drop: (event, view) => {
            const files = event.dataTransfer?.files;
            if (!files) return false;

            const insertAssetAtPosition = async (file: File, pos: number): Promise<void> => {
              const buffer = await file.arrayBuffer();
              const filename = await window.phosphor.saveAsset(buffer, file.name);
              const text = `![[${filename}]]`;
              view.dispatch({
                changes: {
                  from: pos,
                  insert: text
                }
              });
            };

            for (const file of files) {
              const isImage = file.type.startsWith('image/');
              const isPdf = file.type === 'application/pdf';
              if (!isImage && !isPdf) continue;

              event.preventDefault();

              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null) return true;

              insertAssetAtPosition(file, pos).catch((err) =>
                console.error('Failed to save asset:', err)
              );

              return true;
            }
            return false;
          },
          click: (event) => {
            try {
              const target = event.target as HTMLElement | null;

              // Handle wiki link clicks
              const linkEl =
                target?.closest && (target.closest('.cm-wiki-link') as HTMLElement | null);
              if (linkEl) {
                const linkTarget = linkEl.getAttribute('data-link-target') || undefined;
                console.debug('Wiki link clicked:', linkTarget);
                if (linkTarget && typeof onLinkClickRef.current === 'function') {
                  event.preventDefault();
                  // Notify main process to update graph for both the current file and the target file
                  if (currentFile) {
                    window.phosphor
                      .notifyWikilinkClicked(currentFile, linkTarget)
                      .catch((err) => console.error('Failed to notify wikilink click:', err));
                  }
                  onLinkClickRef.current(linkTarget);
                  return true;
                }
              }
            } catch (err) {
              console.error('Error handling click', err);
            }
            return false;
          }
        })
      ]
    });

    // 4. Create the View
    const view = new EditorView({
      state: startState,
      parent: editorRef.current
    });

    viewRef.current = view;

    // Initialize search API after view is created
    setSearchAPI(() => createSearchAPI(view));

    // Enable spell checking on CodeMirror's content element
    const contentEl = view.contentDOM;
    if (contentEl) {
      contentEl.spellcheck = true;
    }

    // Cleanup on unmount
    return () => {
      view.destroy();
    };
  }, [
    content,
    enableDimming,
    isOutlinerMode,
    settings.checkPassiveVoice,
    settings.checkSimplification,
    settings.checkInclusiveLanguage,
    settings.checkReadability,
    settings.checkProfanities,
    settings.checkCliches,
    settings.checkIntensify,
    settings.enableSmartTypography,
    currentFile
  ]); // Re-create editor when content, mode, or grammar settings change

  // Handle external updates (e.g. clicking a different file in sidebar)
  useEffect(() => {
    if (viewRef.current && content !== viewRef.current.state.doc.toString()) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: content
        }
      });
    }
  }, [content]);

  // Notify parent about search panel visibility
  useEffect(() => {
    if (onSearchOpen) {
      onSearchOpen(showSearch);
    }
  }, [showSearch, onSearchOpen]);

  // Disable dimming when search is open
  useEffect(() => {
    if (viewRef.current && enableDimming) {
      // Suppress dimming when search is open, unsuppress when closed
      viewRef.current.dispatch({
        effects: suppressDimmingEffect.of(showSearch)
      });
    }
  }, [showSearch, enableDimming]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div
        ref={editorRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
        className="editor-container"
        spellCheck="true"
      />
      {showSearch && <SearchPanel searchAPI={searchAPI} onClose={() => setShowSearch(false)} />}
    </div>
  );
};
