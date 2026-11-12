import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { PaneId } from "../model/workspace";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, Dispatch, SetStateAction } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { getMarkRange } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  HelpCircle,
  Keyboard,
  ListMusic,
  Minus,
  Music2,
  PanelRight,
  Plus,
  Redo2,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reading, SyllableOverride, ReadingIntegrity } from "../editor/Reading";
import {
  ProsodyAnalysis,
  analysisKey,
  countLabel,
  REASONS,
} from "../editor/Analysis";
import {
  TagCompletion,
  completionKey,
  acceptCompletion,
} from "../editor/TagCompletion";
import type { Completion } from "../editor/TagCompletion";
import {
  analyzeDocument,
  countMora,
  TAG_PRESETS,
  parseTagLine,
} from "../analysis";
import { normalizeTagName } from "../analysis/tags";
import {
  createLyricsFile,
  parseLyricsFile,
} from "../model/document";
import type { LyricsFile } from "../model/document";
import { downloadNative, downloadText } from "../storage/files";
import { assertWholeReadingRanges, captureReadingTarget } from '../search/target';
import type { ReadingCandidate, ReadingSearchTarget } from '../search/types';
import { ReadingSearchDialog } from './ReadingSearchDialog';
import { ReadingLibraryDialog } from './ReadingLibraryDialog';
import { importReadingMemory, recordAcceptedReading } from '../storage/readingMemory';
import { createReadingMemory, serializeReadingMemory, type AcceptedReading } from '../model/readingMemory';
import { captureBatchReadingTarget, MAX_BATCH_SELECTION_LENGTH, type BatchReadingTarget } from '../search/batch';
import { BatchReadingDialog, type BatchReadingChoice } from './BatchReadingDialog';
import { applyBatchReadings } from '../editor/BatchReading';

function IconButton({
  icon: Icon,
  children,
  ...props
}: {
  icon: LucideIcon;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props}>
      <Icon size={17} strokeWidth={1.8} />
      {children}
    </button>
  );
}

type SelectionInfo = {
  from: number;
  to: number;
  text: string;
  reading: string;
  syllables: number | null;
  multiLine: boolean;
};
const emptySelection: SelectionInfo = {
  from: 1,
  to: 1,
  text: "",
  reading: "",
  syllables: null,
  multiLine: false,
};

export type PaneCommand = 'new' | 'open' | 'save' | 'exportText' | 'undo' | 'redo' | 'selectAll' | 'reading' | 'searchReading' | 'batchReading' | 'readingLibrary' | 'tags' | 'help' | 'zoomIn' | 'zoomOut' | 'zoomReset';
export interface PaneBinding {
  editor: Editor;
  focusRange: (from: number, to?: number) => void;
  runCommand: (command: PaneCommand) => void;
}
export interface ChromeSlots { top: HTMLElement; toolbar: HTMLElement; structure: HTMLElement; inspector: HTMLElement; footer: HTMLElement }
interface EditorPaneProps {
  paneId: PaneId; file: LyricsFile; setFile: Dispatch<SetStateAction<LyricsFile>>;
  active: boolean; hidden: boolean; slots: ChromeSlots;
  saveStatus: 'pending'|'saved'|'error';
  onActivate: (id: PaneId) => void;
  onReady: (id: PaneId, binding: PaneBinding|null) => void;
  onComposing: (id: PaneId, value: boolean) => void;
  onOpen: (file: LyricsFile) => Promise<void>;
  onOpenWorkspace: (raw: string) => Promise<void>;
  onSaveWorkspace: () => void;
}
export function EditorPane({ paneId, file, setFile, active, hidden, slots, saveStatus, onActivate, onReady, onComposing, onOpen, onOpenWorkspace, onSaveWorkspace }: EditorPaneProps) {
  const initial = useRef(file).current;
  const fileRef = useRef(file);
  fileRef.current = file;
  const [analysis, setAnalysis] = useState(() =>
    analyzeDocument(initial.editorDocument, initial.settings.tagOverrides),
  );
  const [selection, setSelection] = useState<SelectionInfo>(emptySelection);
  const [reading, setReading] = useState("");
  const [syllables, setSyllables] = useState("1");
  const [readingMode, setReadingMode] = useState<"kana" | "english">("kana");
  const [message, setMessage] = useState("");
  const [modal, setModal] = useState<"help" | "tags" | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [searchSession, setSearchSession] = useState<{ target: ReadingSearchTarget; doc: ProseMirrorNode; from: number; to: number; stale: boolean } | null>(null);
  const [batchSession, setBatchSession] = useState<{ target: BatchReadingTarget; doc: ProseMirrorNode; stale: boolean } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [rememberManual, setRememberManual] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [completionPosition, setCompletionPosition] = useState({
    left: 0,
    top: 0,
  });
  const inputFile = useRef<HTMLInputElement>(null);
  const readingInput = useRef<HTMLInputElement>(null);
  const exportWrapper = useRef<HTMLDivElement>(null);
  const modalElement = useRef<HTMLElement>(null);
  const compositionRef = useRef(false);
  const commandRef = useRef<(command: PaneCommand) => void>(() => {});

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        link: false,
        underline: false,
        trailingNode: false,
      }),
      Reading,
      SyllableOverride,
      ReadingIntegrity,
      ProsodyAnalysis.configure({
        getOverrides: () => fileRef.current.settings.tagOverrides,
      }),
      TagCompletion,
    ],
    content: initial.editorDocument,
    editorProps: {
      attributes: {
        class: "lyrics-editor",
        spellcheck: "false",
        "aria-label": "歌詞エディター",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleKeyDown: (view, event) => {
        if (
          event.altKey &&
          event.key.toLowerCase() === "r" &&
          !event.isComposing &&
          event.keyCode !== 229 &&
          !view.composing &&
          !compositionRef.current
        ) {
          event.preventDefault();
          readingInput.current?.focus();
          return true;
        }
        return false;
      },
    },
    onTransaction: ({ editor: current, transaction }) => {
      if (transaction.docChanged || transaction.getMeta('compositionFrozen') === true) {
        setSearchSession(previous => previous && !previous.stale ? { ...previous, stale: true } : previous);
        setBatchSession(previous => previous && !previous.stale ? { ...previous, stale: true } : previous);
      }
      const derived = analysisKey.getState(current.state);
      compositionRef.current = derived?.frozen ?? false;
      onComposing(paneId, compositionRef.current);
      if (derived && !derived.frozen) setAnalysis(derived.analysis);
      if (
        !derived?.frozen &&
        (transaction.docChanged ||
          transaction.getMeta("compositionFrozen") === false)
      ) {
        const editorDocument = current.getJSON();
        setFile((old) => ({
          ...old,
          editorDocument,
          updatedAt: new Date().toISOString(),
        }));
      }
      const nextCompletion = completionKey.getState(current.state) ?? null;
      setCompletion(derived?.frozen ? null : nextCompletion);
      if (nextCompletion && !derived?.frozen) {
        const coords = current.view.coordsAtPos(nextCompletion.from);
        setCompletionPosition({
          left: Math.min(coords.left, window.innerWidth - 330),
          top: Math.min(coords.bottom + 10, window.innerHeight - 350),
        });
      }
      let { from, to } = current.state.selection;
      if (from === to) {
        for (const name of ["rubyReading", "syllableOverride"]) {
          const range = getMarkRange(
            current.state.doc.resolve(from),
            current.schema.marks[name],
          );
          if (range) {
            from = range.from;
            to = range.to;
            break;
          }
        }
      }
      const text = current.state.doc.textBetween(from, to, "\n", "\n");
      const marks = current.state.doc.resolve(from).nodeAfter?.marks ?? [];
      const ruby = marks.find((mark) => mark.type.name === "rubyReading");
      const syllable = marks.find(
        (mark) => mark.type.name === "syllableOverride",
      );
      setSelection({
        from,
        to,
        text,
        reading: ruby?.attrs.reading ?? "",
        syllables: syllable?.attrs.syllables ?? null,
        multiLine: text.includes("\n"),
      });
    },
  });

  useEffect(() => {
    setReading(selection.reading);
    setSyllables(String(selection.syllables ?? 1));
    setReadingMode(selection.syllables !== null ? "english" : "kana");
  }, [selection.from, selection.to, selection.reading, selection.syllables]);

  useEffect(() => {
    if (!editor) return;
    onReady(paneId, { editor, focusRange: (from, to = from) => {
      editor.view.focus(); editor.chain().setTextSelection({from, to}).scrollIntoView().run();
    }, runCommand: command => commandRef.current(command) });
    return () => { onReady(paneId, null); onComposing(paneId, false); };
  }, [editor, paneId, onReady, onComposing]);
  useEffect(() => {
    if (!active && editor && completionKey.getState(editor.state)) editor.view.dispatch(editor.state.tr.setMeta(completionKey, 'close'));
    if (!active) { setSearchSession(null); setBatchSession(null); setLibraryOpen(false); }
  }, [active, editor]);

  useEffect(() => {
    document
      .querySelector(`.completion-${paneId} [aria-selected="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [completion?.selected]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (saveStatus !== "saved" || compositionRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saveStatus]);

  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || compositionRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.shiftKey) {
        event.preventDefault();
        commandRef.current('save');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        commandRef.current('open');
      }
      if (event.key === "Escape") {
        setModal(null);
        setExportOpen(false);
        if (exportOpen) exportWrapper.current?.querySelector('button')?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [active, exportOpen]);

  useEffect(() => {
    if (!exportOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!exportWrapper.current?.contains(event.target as Node)) setExportOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [exportOpen]);

  useLayoutEffect(() => {
    if (!active || !modal) return;
    const trigger = document.activeElement as HTMLElement | null;
    modalElement.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [active, modal]);

  const currentLine =
    analysis.lines.find(
      (line) => selection.from >= line.from && selection.from <= line.to,
    ) ?? analysis.lines[0];
  const currentSection =
    analysis.sections.find(
      (section) => section.id === currentLine?.sectionId,
    ) ?? analysis.sections[0];
  const kanaPreview = countMora(reading);
  const containsTag = analysis.lines.some((line) =>
    line.tags.some((tag) => tag.from < selection.to && tag.to > selection.from),
  );
  const validSelection = Boolean(
    selection.text && !selection.multiLine && !containsTag,
  );
  const validSyllables =
    /^[0-9]+$/.test(syllables) &&
    Number(syllables) >= 1 &&
    Number(syllables) <= 100 &&
    /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(selection.text);
  const canApply =
    validSelection &&
    (readingMode === "kana"
      ? reading.trim().length > 0 &&
        reading.length <= 512 &&
        kanaPreview.complete &&
        kanaPreview.confirmedMora > 0
      : validSyllables);
  const mode = file.settings.viewMode;

  function focusRange(from: number, to = from) {
    editor?.view.focus();
    editor?.chain().setTextSelection({ from, to }).scrollIntoView().run();
  }

  function applyReading() {
    if (!editor || !canApply) return;
    try { assertWholeReadingRanges(editor.state.doc, selection.from, selection.to); }
    catch (cause) { setMessage(String(cause)); return; }
    const remembered = rememberManual && readingMode === 'kana' && selection.text.length <= 64
      ? memoryRecord(selection.text, reading, selection.from, selection.to, { kind: 'manual', sources: [] }) : null;
    editor.view.focus();
    const chain = editor
      .chain()
      .setTextSelection({ from: selection.from, to: selection.to })
      .unsetMark("rubyReading")
      .unsetMark("syllableOverride");
    const applied = readingMode === "kana" ? chain
        .setMark("rubyReading", {
          id: crypto.randomUUID(),
          reading,
          base: selection.text,
          source: "author_ruby",
        })
        .run() : chain
        .setMark("syllableOverride", {
          id: crypto.randomUUID(),
          syllables: Number(syllables),
          base: selection.text,
          source: "author_syllables",
        })
        .run();
    if (!applied) { setMessage('読みを適用できませんでした。選択範囲を確認してください。'); return; }
    setMessage(
      `「${selection.text}」の${readingMode === "kana" ? "読み" : "音節数"}を設定しました。`,
    );
    if (remembered) rememberReading(remembered);
  }

  function memoryRecord(surface: string, kana: string, from: number, to: number, origin: AcceptedReading['origin']): AcceptedReading {
    const line = analysis.lines.find(item => item.from <= from && item.to >= to);
    const before = line?.text.slice(0, from - line.from) ?? '';
    const after = line?.text.slice(to - line.from) ?? '';
    const beforeClip = before.slice(-64).replace(/^[\uDC00-\uDFFF]/, '');
    const afterClip = after.slice(0, 64).replace(/[\uD800-\uDBFF]$/, '');
    return { id: crypto.randomUUID(), surface, reading: kana, acceptedAt: new Date().toISOString(),
      context: { documentId: fileRef.current.documentId, before: beforeClip, after: afterClip }, origin };
  }

  function rememberReading(record: AcceptedReading) {
    void recordAcceptedReading(record).then(() => setMessage('歌詞に読みを適用し、個人辞書へ登録しました。'))
      .catch(cause => setMessage(`歌詞への読みの適用は完了しましたが、個人辞書には保存できませんでした。${String(cause)}`));
  }

  function openReadingSearch() {
    if (!editor || compositionRef.current || editor.view.composing) return;
    try {
      const target = captureReadingTarget(editor.state.doc, analysis, selection.from, selection.to);
      setSearchSession({ target, doc: editor.state.doc, from: selection.from, to: selection.to, stale: false });
    } catch (cause) { setMessage(String(cause)); }
  }

  function adoptCandidate(candidate: ReadingCandidate, remember: boolean) {
    if (!editor || !searchSession) return;
    const { target, from, to, doc, stale } = searchSession;
    try { assertWholeReadingRanges(editor.state.doc, from, to); }
    catch (cause) { setMessage(String(cause)); setSearchSession(previous => previous ? { ...previous, stale: true } : null); return; }
    const kana = countMora(candidate.reading);
    const currentAnalysis = analyzeDocument(editor.getJSON(), fileRef.current.settings.tagOverrides);
    if (!active || stale || editor.state.doc !== doc || compositionRef.current || editor.view.composing
      || editor.state.doc.textBetween(from, to, '\n', '\n') !== target.base
      || currentAnalysis.lines.some(line => line.tags.some(tag => tag.from < to && tag.to > from))
      || !candidate.applicable || !kana.complete || kana.confirmedMora === 0 || candidate.reading.length > 512) {
      setSearchSession(previous => previous ? { ...previous, stale: true } : null);
      setMessage('選択範囲または読みの条件が変わったため適用を中止しました。表記を選び直してください。');
      return;
    }
    const sourceNames = [...new Set(candidate.evidence.map(evidence => `${evidence.source}:${evidence.method}`))].slice(0, 16);
    const provider = candidate.evidence.find(evidence => evidence.provider)?.provider;
    const record = remember ? memoryRecord(target.base, candidate.reading, from, to, {
      kind: 'candidate', candidateId: candidate.id, sources: sourceNames,
      ...(provider ? { dictionaryVersion: provider.version } : {}),
    }) : null;
    editor.view.focus();
    const applied = editor.chain().setTextSelection({ from, to }).unsetMark('rubyReading').unsetMark('syllableOverride')
      .setMark('rubyReading', { id: crypto.randomUUID(), reading: candidate.reading, base: target.base, source: 'author_ruby' }).run();
    if (!applied) { setMessage('読みを適用できませんでした。選択範囲を確認してください。'); return; }
    setSearchSession(null);
    setMessage(`「${target.base}」の読み「${candidate.reading}」を採用しました。`);
    if (record) rememberReading(record);
  }

  function openBatchReading() {
    if (!editor || compositionRef.current || editor.view.composing) return;
    try {
      const { from, to } = editor.state.selection;
      const target = captureBatchReadingTarget(editor.state.doc, analyzeDocument(editor.getJSON(), fileRef.current.settings.tagOverrides), from, to);
      setSearchSession(null);
      setBatchSession({ target, doc: editor.state.doc, stale: false });
    } catch (cause) { setMessage(String(cause)); }
  }

  function adoptBatch(choices: BatchReadingChoice[], remember: boolean) {
    if (!editor || !batchSession) return;
    if (!active || batchSession.stale || compositionRef.current || editor.view.composing) {
      setBatchSession(previous => previous ? { ...previous, stale: true } : null);
      return;
    }
    try {
      const count = applyBatchReadings(editor, { doc: batchSession.doc, from: batchSession.target.from, to: batchSession.target.to },
        choices.map(({ item, reading }) => ({ from: item.from, to: item.to, base: item.base, reading })));
      setBatchSession(null);
      setMessage(`${count} 語の読みを一括設定しました。1回の「元に戻す」でまとめて戻せます。`);
      if (remember) {
        const records = choices.map(({ item, reading, candidate }) => {
          const provider = candidate?.evidence.find(evidence => evidence.provider)?.provider;
          return memoryRecord(item.base, reading, item.from, item.to, candidate ? {
            kind: 'candidate', candidateId: candidate.id,
            sources: [...new Set(candidate.evidence.map(evidence => `${evidence.source}:${evidence.method}`))].slice(0, 16),
            ...(provider ? { dictionaryVersion: provider.version } : {}),
          } : { kind: 'manual', sources: [] });
        });
        void Promise.resolve().then(() => importReadingMemory(serializeReadingMemory({ ...createReadingMemory(), records })))
          .then(() => setMessage(`${count} 語の読みを一括設定し、個人辞書へ登録しました。`))
          .catch(cause => setMessage(`歌詞への一括適用は完了しましたが、個人辞書には保存できませんでした。${String(cause)}`));
      }
    } catch (cause) {
      setBatchSession(previous => previous ? { ...previous, stale: true } : null);
      setMessage(String(cause));
    }
  }

  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    try {
      if (selected.size > 40 * 1024 * 1024)
        throw new Error("40 MB 以下のワークスペースを選んでください。");
      const text = await selected.text();
      const isJson = /\.json$/i.test(selected.name);
      if (isJson && JSON.parse(text)?.format === 'lyrics-studio-workspace') {
        await onOpenWorkspace(text); event.target.value = ''; return;
      }
      if (selected.size > 10 * 1024 * 1024)
        throw new Error("10 MB 以下の歌詞ファイルを選んでください。");
      const next = isJson
        ? parseLyricsFile(text)
        : createLyricsFile(text, selected.name.replace(/\.[^.]+$/, ""));
      await onOpen(next);
    } catch (error) {
      setMessage(
        `開けませんでした。現在の文書は保持しています。${String(error)}`,
      );
    }
    event.target.value = "";
  }

  function updateTag(
    name: string,
    semantic: "section" | "instruction" | "unknown",
  ) {
    const next = {
      ...file,
      updatedAt: new Date().toISOString(),
      settings: {
        ...file.settings,
        tagOverrides: {
          ...Object.fromEntries(
            Object.entries(file.settings.tagOverrides).filter(
              ([key]) => normalizeTagName(key) !== normalizeTagName(name),
            ),
          ),
          [name]: semantic,
        },
      },
    };
    fileRef.current = next;
    setFile(next);
    editor?.view.dispatch(editor.state.tr.setMeta("refreshAnalysis", true));
  }

  function saveNative() {
    try {
      downloadNative(fileRef.current);
      setMessage(
        "編集用ファイルのダウンロードを開始しました。読みも保持されます。",
      );
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    }
  }

  async function newDocument() {
    if (!saveNative()) return;
    try { await onOpen(createLyricsFile()); }
    catch (error) { setMessage(String(error)); }
  }

  function exportText() {
    try {
      downloadText(fileRef.current);
      setMessage("原文テキストのダウンロードを開始しました。ルビを残す場合は編集用ファイルも保存してください。");
    } catch (error) { setMessage(String(error)); }
    setExportOpen(false);
  }

  // The workspace keeps a stable binding. Commands always read this render's
  // state; focus changes are synchronous so they cannot steal a later input.
  commandRef.current = command => {
    if (compositionRef.current || editor?.view.composing) return;
    switch (command) {
      case 'new': void newDocument(); break;
      case 'open': inputFile.current?.click(); break;
      case 'save': saveNative(); break;
      case 'exportText': exportText(); break;
      case 'undo': editor?.view.focus(); editor?.commands.undo(); break;
      case 'redo': editor?.view.focus(); editor?.commands.redo(); break;
      case 'selectAll': editor?.view.focus(); editor?.commands.selectAll(); break;
      case 'reading': readingInput.current?.focus(); break;
      case 'searchReading': openReadingSearch(); break;
      case 'batchReading': openBatchReading(); break;
      case 'readingLibrary': setLibraryOpen(true); break;
      case 'tags': setModal('tags'); break;
      case 'help': setModal('help'); break;
      case 'zoomIn': setZoom(value => Math.min(150, value + 10)); break;
      case 'zoomOut': setZoom(value => Math.max(75, value - 10)); break;
      case 'zoomReset': setZoom(100); break;
    }
  };

  return (
    <div className={`document-pane mode-${mode} ${active ? 'active-pane' : ''}`} data-pane={paneId} role="region" aria-label={`歌詞${paneId.toUpperCase()}`} hidden={hidden} onFocusCapture={() => onActivate(paneId)} onPointerDown={() => onActivate(paneId)}>
      {active && createPortal((
      <div className="document-heading">
        <div className="document-title"><span className="active-pane-badge">{paneId.toUpperCase()}</span>
          <FileText size={16} />
          <input
            aria-label="文書名"
            value={file.title}
            onChange={(event) => {
              const title = event.target.value;
              setFile((current) => ({
                ...current,
                title,
                updatedAt: new Date().toISOString(),
              }));
            }}
          />
        </div>
        <div className={`save-indicator ${saveStatus}`}>
          <span className="status-dot" />
          {saveStatus === "saved"
            ? "この端末に保存済み"
            : saveStatus === "error"
              ? "保存エラー"
              : "保存中…"}
        </div>
      </div>
      ), slots.top)}
      {active && createPortal((
        <div className="file-toolbar-controls">
          <IconButton icon={FilePlus2} onClick={() => void newDocument()} title="操作中の歌詞を保存して新しく開始">新しい歌詞</IconButton>
          <IconButton
            icon={FolderOpen}
            title="ファイルから開く"
            aria-label="ファイルから開く"
            onClick={() => inputFile.current?.click()}
          >開く</IconButton>
          <IconButton icon={Save} onClick={saveNative} title={`歌詞${paneId.toUpperCase()}を保存 (Ctrl+S)`}>
            保存
          </IconButton>
          <IconButton icon={Download} onClick={onSaveWorkspace} aria-label="A/Bをまとめて保存" title="A/Bと比較設定をまとめて保存 (Ctrl+Shift+S)">A/B保存</IconButton>
          <span className="toolbar-divider" aria-hidden="true" />
          <div className="export-wrapper" ref={exportWrapper} onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setExportOpen(false);
          }}>
            <IconButton
              icon={ArrowDownToLine}
              className="primary soft"
              aria-expanded={exportOpen}
              aria-controls={`export-${paneId}`}
              onClick={() => setExportOpen(!exportOpen)}
            >
              書き出し
              <ChevronDown size={13} />
            </IconButton>
            {exportOpen && (
              <div className="menu export-menu" id={`export-${paneId}`} role="group" aria-label="書き出し形式">
                <button
                  onClick={exportText}
                >
                  <FileText size={17} />
                  <span>
                    プレーンテキスト
                    <small>Suno などへ · 読み情報を含まない</small>
                  </span>
                </button>
                <button
                  onClick={() => {
                    saveNative();
                    setExportOpen(false);
                  }}
                >
                  <Save size={17} />
                  <span>
                    編集用 JSON<small>原文・読み・設定を保持</small>
                  </span>
                </button>
              </div>
            )}
          </div>
          <IconButton
            icon={HelpCircle}
            aria-label="使い方"
            title="使い方"
            onClick={() => setModal("help")}
          />
          <span className="toolbar-context">操作中 <strong>歌詞{paneId.toUpperCase()}</strong><span>保存・書き出しの対象</span></span>
        <input
          ref={inputFile}
          type="file"
          accept=".txt,.json,.lyrics.json,text/plain,application/json"
          hidden
          onChange={openFile}
        />
        </div>
      ), slots.toolbar)}
      {active && createPortal((
        <aside className="structure-panel">
          <div className="panel-heading">
            <span>
              <ListMusic size={17} />
              楽曲構成
            </span>
            <span className="quiet-counter">{analysis.sections.length}</span>
          </div>
          <div className="section-list">
            {analysis.sections.map((section, index) => (
              <button
                className={`section-item ${currentSection?.id === section.id ? "active" : ""}`}
                key={section.id}
                onClick={() => focusRange(section.from)}
              >
                <span className={`section-icon color-${index % 4}`}>
                  <Music2 size={17} />
                </span>
                <span className="section-info">
                  <strong>
                    {section.name === "Intro / Untagged"
                      ? file.settings.untaggedSectionName
                      : section.name}
                  </strong>
                  <small>{countLabel(section)}</small>
                </span>
                <span className="line-count">{section.lineCount}行</span>
              </button>
            ))}
          </div>
          <button
            className="add-section"
            onClick={() => {
              if (!editor) return;
              editor.view.focus();
              editor
                .chain()
                .setTextSelection(editor.state.doc.content.size - 1)
                .insertContent([
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "[Verse 2]" }],
                  },
                  { type: "paragraph" },
                ])
                .run();
            }}
          >
            <Plus size={16} />
            セクションを追加
          </button>
          <div className="sidebar-bottom">
            <div className="local-note">
              <ShieldCheck size={18} />
              <span>
                あなたの言葉は、この端末に。
                <small>外部送信なしで編集できます</small>
              </span>
            </div>
          </div>
        </aside>
      ), slots.structure)}
        <main className="editor-panel">
          <div className="editor-toolbar">
            <button className={`pane-identity ${active ? "is-active" : ""}`} onClick={() => onActivate(paneId)} aria-pressed={active}>歌詞{paneId.toUpperCase()}</button><div className="file-tab">
              <FileText size={15} />
              <span>{file.title || "無題の歌詞"}</span>
              <span className="tab-dot" />
            </div>
            <div className="view-switch" aria-label="表示レイヤー">
              {(["plain", "ruby", "analysis"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  className={mode === value ? "selected" : ""}
                  onClick={() =>
                    setFile((current) => ({
                      ...current,
                      settings: { ...current.settings, viewMode: value },
                    }))
                  }
                >
                  {value === "plain" ? (
                    "原文"
                  ) : value === "ruby" ? (
                    "ルビ"
                  ) : (
                    <>
                      <Activity size={13} />
                      解析
                    </>
                  )}
                </button>
              ))}
            </div>
            <div className="history-actions">
              <IconButton
                icon={Undo2}
                aria-label="元に戻す"
                title="元に戻す (Ctrl+Z)"
                disabled={!editor?.can().undo()}
                onClick={() => {
                  editor?.view.focus();
                  editor?.commands.undo();
                }}
              />
              <IconButton
                icon={Redo2}
                aria-label="やり直す"
                title="やり直す (Ctrl+Shift+Z)"
                disabled={!editor?.can().redo()}
                onClick={() => {
                  editor?.view.focus();
                  editor?.commands.redo();
                }}
              />
            </div>
          </div>
          <div className="editor-context">
            <span>LYRIC WORKSPACE</span>
            <span>
              <Keyboard size={13} />
              文字を選択して読みを指定 <kbd>Alt R</kbd>
            </span>
          </div>
          <div
            className="editor-scroll"
            onScroll={() => {
              const current = editor && completionKey.getState(editor.state);
              if (editor && current) {
                const coords = editor.view.coordsAtPos(current.from);
                setCompletionPosition({
                  left: Math.min(coords.left, window.innerWidth - 330),
                  top: Math.min(coords.bottom + 10, window.innerHeight - 350),
                });
              }
            }}
            style={
              {
                "--editor-font-size": `${(21 * zoom) / 100}px`,
              } as React.CSSProperties
            }
          >
            <EditorContent editor={editor} />
            <div className="page-end">
              <span />
              ことばの、その先へ。
              <span />
            </div>
          </div>
          <div className="editor-bottom">
            <span>
              <span className="legend-dot mora" />
              日本語 · mora
            </span>
            <span>
              <span className="legend-dot syllable" />
              英語 · syl
            </span>
            <span>
              <span className="legend-dot unknown" />
              未確定
            </span>
            <span className="editor-bottom-note">
              モーラとシラブルは別々に集計
            </span>
          </div>
        </main>
      {active && createPortal((
        <aside className="inspector">
          <div className="panel-heading">
            <span>
              <PanelRight size={17} />
              読み / 発音
            </span>
            <span className="small-label">INSPECTOR</span>
          </div>
          <section className="reading-panel">
            <div className="eyebrow">選択中の表記</div>
            <div className={`selected-word ${!selection.text ? "empty" : ""}`}>
              {selection.text || "ことばを選択"}
            </div>
            <p className="selection-hint">
              {selection.multiLine
                ? "複数行の読みをまとめて探索・設定できます。"
                : containsTag
                  ? "メタタグは発音の計算から除外されます。"
                  : selection.text
                    ? "表記をそのままに、歌う読みを指定。"
                    : "本文をドラッグ、または未確定の語を選択。"}
            </p>
            <button className="search-entry-button" disabled={!validSelection || selection.text.length > 64 || compositionRef.current}
              onClick={openReadingSearch}><Search size={16} />読み候補を探す</button>
            <button className="search-entry-button" disabled={!editor || editor.state.selection.empty || selection.text.length > MAX_BATCH_SELECTION_LENGTH || compositionRef.current}
              onClick={openBatchReading}><ListMusic size={16} />選択範囲の読みを一括設定</button>
            {selection.text.length > MAX_BATCH_SELECTION_LENGTH && <p className="search-caption">一括探索は8,192文字以内の範囲を選択してください。</p>}
            <div className="reading-mode">
              <button
                className={readingMode === "kana" ? "active" : ""}
                onClick={() => setReadingMode("kana")}
              >
                かな読み
              </button>
              <button
                className={readingMode === "english" ? "active" : ""}
                onClick={() => setReadingMode("english")}
              >
                英語の音節数
              </button>
            </div>
            <label className="input-label" htmlFor="reading">
              {readingMode === "kana"
                ? "読み（ひらがな・カタカナ）"
                : "作者指定のシラブル数"}
            </label>
            <div className="reading-input">
              {readingMode === "kana" ? (
                <input
                  id="reading"
                  ref={readingInput}
                  value={reading}
                  maxLength={512}
                  placeholder="例：あした"
                  autoComplete="off"
                  onChange={(event) => setReading(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing &&
                      event.nativeEvent.keyCode !== 229 &&
                      !compositionRef.current
                    ) {
                      event.preventDefault();
                      applyReading();
                    }
                  }}
                />
              ) : (
                <input
                  id="reading"
                  type="number"
                  min="1"
                  max="100"
                  value={syllables}
                  onChange={(event) => setSyllables(event.target.value)}
                />
              )}
              <span>手動</span>
            </div>
            <div className="reading-result">
              <span>読みのカウント</span>
              <strong>
                {readingMode === "kana"
                  ? reading
                    ? `${kanaPreview.confirmedMora}${kanaPreview.complete ? "" : " + ?"}`
                    : "—"
                  : syllables}
                <small>{readingMode === "kana" ? "mora" : "syl"}</small>
              </strong>
            </div>
            {readingMode === "kana" && reading && !kanaPreview.complete && (
              <p className="field-error">
                読みをかなで指定してください。特殊な小書き文字なども要確認です。
              </p>
            )}
            {readingMode === "english" &&
              selection.text &&
              !/^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(selection.text) && (
                <p className="field-error">英単語を1語選択してください。</p>
              )}
            <div className="reading-buttons">
              <IconButton
                icon={Check}
                className="primary"
                disabled={!canApply}
                onClick={applyReading}
              >
                読みを適用
              </IconButton>
              <button
                className="text-button"
                disabled={!selection.reading && selection.syllables === null}
                onClick={() => {
                  editor?.view.focus();
                  editor
                    ?.chain()
                    .setTextSelection({
                      from: selection.from,
                      to: selection.to,
                    })
                    .unsetMark("rubyReading")
                    .unsetMark("syllableOverride")
                    .run();
                }}
              >
                解除
              </button>
            </div>
            {readingMode === 'kana' && <label className="search-remember manual-reading-memory"><input type="checkbox" checked={rememberManual} onChange={event => setRememberManual(event.target.checked)} disabled={!validSelection || selection.text.length > 64} />手動で適用した読みを個人辞書に登録</label>}
          </section>

          <section className="section-summary">
            <h2>
              <span className="sigma">Σ</span>セクション集計
            </h2>
            <div className="summary-section-name">
              <span />
              {currentSection?.name || "未分類"}
            </div>
            <div className="metric-grid">
              <div>
                <strong>
                  {currentSection?.confirmedMora ?? 0}
                  <small>mora</small>
                </strong>
                <span>日本語モーラ</span>
              </div>
              <div>
                <strong>
                  {currentSection?.confirmedSyllables ?? 0}
                  <small>syl</small>
                </strong>
                <span>英語シラブル</span>
              </div>
            </div>
            <div className="summary-foot">
              <span>{currentSection?.lineCount ?? 0} 行</span>
              <span className={currentSection?.complete ? "" : "warning-text"}>
                {currentSection?.complete
                  ? "すべて確定"
                  : `未確定 ${currentSection?.unresolved.length ?? 0} 箇所`}
                {currentSection?.provisional ? " · 所属は暫定" : ""}
              </span>
            </div>
          </section>

          <section className="unresolved-panel">
            <h2>
              <CircleAlert size={16} />
              未確定
              <span className="warning-count">
                {analysis.unresolved.length}
              </span>
            </h2>
            <p className="subtle">選択して、歌う読みを決めましょう。</p>
            <div className="unresolved-list">
              {analysis.unresolved.map((item, index) => (
                <button
                  key={`${item.from}-${index}`}
                  onClick={() => focusRange(item.from, item.to)}
                >
                  <span>
                    <strong>{item.sourceText}</strong>
                    <small>{REASONS[item.reason] ?? item.reason}</small>
                  </span>
                  <span className="unknown-badge">
                    要確認
                    <ArrowRight size={12} />
                  </span>
                </button>
              ))}
              {!analysis.unresolved.length && (
                <div className="all-clear">
                  <Check size={18} />
                  すべての読みが確定しています
                </div>
              )}
            </div>
          </section>
          <button className="tag-settings" onClick={() => setModal("tags")}>
            <Settings2 size={16} />
            タグの分類
            <ArrowRight size={14} />
          </button>
        </aside>
      ), slots.inspector)}
      {active && createPortal((
      <footer className="statusbar">
        <span>
          <span className="online-dot" />
          ローカル
        </span>
        <span>
          行 {currentLine ? currentLine.index + 1 : 1}、列{" "}
          {currentLine ? selection.from - currentLine.from + 1 : 1}
        </span>
        {selection.text && (
          <span>{Array.from(selection.text).length} 文字を選択</span>
        )}
        <div className="status-spacer" />
        <span className="total-count">
          全体 <strong>{analysis.confirmedMora}</strong> mora{" "}
          <span className="dim">+</span>{" "}
          <strong>{analysis.confirmedSyllables}</strong> syl
        </span>
        <span className={analysis.complete ? "" : "warning-text"}>
          未確定 {analysis.unresolved.length}
        </span>
        <div className="zoom-control">
          <button
            aria-label="縮小"
            onClick={() => setZoom(Math.max(75, zoom - 10))}
          >
            <Minus size={13} />
          </button>
          <span>{zoom}%</span>
          <button
            aria-label="拡大"
            onClick={() => setZoom(Math.min(150, zoom + 10))}
          >
            <Plus size={13} />
          </button>
        </div>
      </footer>
      ), slots.footer)}


      {active && completion && (
        <div
          className={`menu completion-menu completion-${paneId}`}
          role="listbox"
          aria-label="メタタグ候補"
          style={{ left: completionPosition.left, top: completionPosition.top }}
        >
          <div className="completion-heading">
            メタタグ<kbd>↑ ↓ 選択 · Enter 確定</kbd>
          </div>
          {completion.items.map((item, index) => (
            <button
              key={item.name}
              role="option"
              aria-selected={index === completion.selected}
              className={index === completion.selected ? "highlighted" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editor && acceptCompletion(editor.view, index)}
            >
              {item.semantic === "section" ? (
                <FileText size={15} />
              ) : (
                <Music2 size={15} />
              )}
              <span>{item.name}</span>
              <small>
                {item.semantic === "section" ? "セクション" : "演出指示"}
              </small>
            </button>
          ))}
        </div>
      )}
      {active && message && (
        <div className="notification" role="status">
          <CircleAlert size={17} />
          <span>{message}</span>
          <button aria-label="通知を閉じる" onClick={() => setMessage("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {active && searchSession && <ReadingSearchDialog target={searchSession.target}
        stale={searchSession.stale || editor?.state.doc !== searchSession.doc || compositionRef.current}
        onAdopt={adoptCandidate} onClose={() => setSearchSession(null)}
        onManual={() => { setSearchSession(null); readingInput.current?.focus(); }} />}
      {active && batchSession && <BatchReadingDialog target={batchSession.target}
        stale={batchSession.stale || editor?.state.doc !== batchSession.doc || compositionRef.current}
        onAdopt={adoptBatch} onClose={() => setBatchSession(null)} />}
      {active && libraryOpen && <ReadingLibraryDialog onClose={() => setLibraryOpen(false)} />}
      {active && modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setModal(null);
          }}
        >
          <section
            className="modal"
            ref={modalElement}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={modal === "help" ? "使い方" : "タグの分類"}
            onKeyDown={event => {
              if (event.key !== 'Tab') return;
              const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
              const first = targets[0]; const last = targets.at(-1);
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}
          >
            <button
              className="modal-close"
              aria-label="閉じる"
              onClick={() => setModal(null)}
            >
              <X size={19} />
            </button>
            {modal === "help" ? (
              <>
                <span className="modal-icon">
                  <BookOpen size={24} />
                </span>
                <h2>言葉と、歌う読みをつなぐ。</h2>
                <p>
                  歌詞を貼り付け、文字を選択して「読み」を適用します。漢字の読みは、あなたが決めるまで未確定として残します。
                </p>
                <ul>
                  <li><kbd>Alt F10</kbd> 左上のアプリメニューへ</li>
                  <li><kbd>Ctrl O</kbd> ファイルを開く</li>
                  <li>
                    <kbd>Alt R</kbd> 選択した文字の読み欄へ
                  </li>
                  <li>
                    <kbd>[</kbd> セクション・演出タグを補完
                  </li>
                  <li>
                    <kbd>Ctrl Z</kbd> 編集や読みの設定を元に戻す
                  </li>
                  <li>
                    <kbd>Alt 1 / 2</kbd> 歌詞A / Bの編集へ移動
                  </li>
                  <li>
                    <kbd>Ctrl S</kbd> 操作中の歌詞を読み付きで保存
                  </li>
                  <li>
                    <kbd>Ctrl Shift S</kbd> A/B・分割・行対応をまとめて保存
                  </li>
                </ul>
                <p>左上のロゴからすべてのメニューを開けます。「表示 → メニューバーを常時表示」で、常時表示とロゴのみの表示を切り替えられます。</p>
                <p>
                  英語にカナ読みを付けると、その範囲はモーラで集計します。モーラとシラブルは加算しません。読み付きの表記の途中を編集すると、古い読みを解除します。
                </p>
                <div className="help-note">
                  <ShieldCheck size={19} />
                  <span>
                    編集内容はこのブラウザーに自動保存されます。訳詞ではA/B比較を開き、行の対応を調整できます。端末間で移す場合やバックアップには「A/Bをまとめて保存」を使ってください。最初の歌詞は、手動読みを付けたサンプルです。
                  </span>
                </div>
              </>
            ) : (
              <>
                <span className="modal-icon">
                  <Settings2 size={24} />
                </span>
                <h2>タグの分類</h2>
                <p>
                  セクションは新しい集計範囲を開始します。演出指示と未登録タグは音数から除外されます。
                </p>
                <div className="tag-list">
                  {Array.from(
                    new Set([
                      ...TAG_PRESETS.map((t) => t.name),
                      ...analysis.lines.flatMap((line) =>
                        line.tags.map((tag) => tag.name),
                      ),
                    ]),
                  ).map((name) => (
                    <label key={name}>
                      <span>[{name}]</span>
                      <select
                        value={
                          parseTagLine(`[${name}]`, file.settings.tagOverrides)
                            .tags[0]?.semantic ?? "unknown"
                        }
                        onChange={(event) =>
                          updateTag(
                            name,
                            event.target.value as
                              | "section"
                              | "instruction"
                              | "unknown",
                          )
                        }
                      >
                        <option value="section">セクション</option>
                        <option value="instruction">演出指示</option>
                        <option value="unknown">未登録</option>
                      </select>
                    </label>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
