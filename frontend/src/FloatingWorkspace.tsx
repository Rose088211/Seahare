import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import '@xterm/xterm/css/xterm.css';
import { FileText, Globe, Maximize2, Minimize2, TerminalSquare, X } from 'lucide-react';

type PanelMode = 'normal' | 'min' | 'max';
type TabKind = 'terminal' | 'note' | 'browser';

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  openOnMount?: boolean;
}

export interface FloatingWorkspaceHandle {
  addTab(kind: TabKind, opts?: { openOnMount?: boolean }): void;
  minimize(): void;
}

interface FloatingWorkspaceProps {
  open: boolean;
  onClose: () => void;
}

interface DragState {
  startX: number;
  startY: number;
  posX: number;
  posY: number;
}

const TERM_OPTIONS = {
  cursorBlink: true,
  cursorStyle: 'bar' as const,
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  letterSpacing: 0,
  lineHeight: 1.2,
  copyOnSelect: true,
  convertEol: true,
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b7088',
    selectionInactiveBackground: '#45475a44',
    black: '#1e1e2e',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  scrollback: 5000,
};

// Read the preload bridge lazily so the panel is testable in a plain browser.
const getApi = (): Window['floatingTerminal'] => window.floatingTerminal;
const getNoteApi = (): Window['markdownFile'] => window.markdownFile;

let tabSeq = 0;
const labelSeq = { terminal: 0, note: 0, browser: 0 };
const nextTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;
const defaultTitle = (kind: TabKind, n: number) =>
  kind === 'terminal' ? `终端 ${n}` : kind === 'note' ? `笔记 ${n}` : `浏览器 ${n}`;
const tabIcon = (kind: TabKind) =>
  kind === 'terminal' ? <TerminalSquare size={11} /> : kind === 'note' ? <FileText size={11} /> : <Globe size={11} />;

function TerminalTab({ sessionKey }: { sessionKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [shellLabel, setShellLabel] = useState('shell');
  const [status, setStatus] = useState<'ok' | 'exited' | 'fatal'>('ok');
  const [epoch, setEpoch] = useState(0);

  const write = useCallback((text: string) => termRef.current?.write(text), []);

  const handleInput = useCallback((data: string) => {
    // PTY 模式: Shell 负责回显和行编辑，前端只需透传原始按键
    const api = getApi();
    if (api && sessionIdRef.current) {
      api.write(sessionIdRef.current, data);
    }
  }, []);

  // Mount the terminal for this tab (container stays mounted across tab switches).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal(TERM_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    const unsub = term.onData(handleInput);

    // Ctrl+C: 有选中内容则复制，无选中则作为 SIGINT 传给 Shell
    // Ctrl+V: 粘贴剪贴板内容到终端
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey && (event.key === 'C' || event.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        return true; // 无选中时 Ctrl+C 作为 SIGINT 传给 Shell
      }
      if (event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey && (event.key === 'V' || event.key === 'v')) {
        navigator.clipboard.readText().then((text) => {
          if (!text) return;
          const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          termRef.current?.write(normalized);
          if (getApi() && sessionIdRef.current) getApi()!.write(sessionIdRef.current, normalized);
        }).catch(() => {});
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        // 通知后端终端尺寸变化，Shell 才能正确排版
        const api = getApi();
        if (api && sessionIdRef.current) {
          api.resize(sessionIdRef.current, term.cols, term.rows);
        }
      } catch {
        /* hidden */
      }
    });
    observer.observe(el);
    return () => {
      unsub.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [handleInput, sessionKey]);

  // Shell session lifecycle for this tab.
  useEffect(() => {
    const api = getApi();
    if (!api) {
      setStatus('fatal');
      return;
    }
    let alive = true;
    api.create({})
      .then((session) => {
        if (!alive) return;
        sessionIdRef.current = session.id;
        setShellLabel(session.shell);
        setStatus('ok');
        write(`\x1b[38;5;39mSeahare\x1b[0m \x1b[90m浮动终端 ·\x1b[0m \x1b[38;5;45m${session.shell}\x1b[0m\r\n`);
        // 通知后端初始终端尺寸
        const term = termRef.current;
        if (term && api.resize) api.resize(session.id, term.cols, term.rows);
      })
      .catch(() => {
        if (alive) setStatus('fatal');
      });
    const unsubData = api.onData((id, data) => {
      if (id === sessionIdRef.current) write(data);
    });
    const unsubExit = api.onExit((id, code, error) => {
      if (id !== sessionIdRef.current) return;
      if (code === -1) write(`\r\n\x1b[38;5;196m[Shell 启动失败: ${error || '未知错误'}]\x1b[0m\r\n`);
      else write(`\r\n\x1b[90m[Shell 已退出 code=${code}]\x1b[0m\r\n`);
      setStatus(code === -1 ? 'fatal' : 'exited');
    });
    return () => {
      alive = false;
      unsubData();
      unsubExit();
      if (sessionIdRef.current) api.kill(sessionIdRef.current);
      sessionIdRef.current = null;
    };
  }, [sessionKey, epoch, write]);

  return (
    <div className="ft-tab-body terminal">
      <div className="ft-term" ref={containerRef} />
      {status !== 'ok' && (
        <div className="ft-notice">
          <span>{status === 'fatal' ? '桌面终端不可用' : `Shell 已退出 (${shellLabel})`}</span>
          <button type="button" onClick={() => setEpoch((e) => e + 1)}>重新启动</button>
        </div>
      )}
    </div>
  );
}

function NoteTab({ openOnMount }: { openOnMount?: boolean }) {
  const [content, setContent] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [name, setName] = useState('未命名笔记');
  const [preview, setPreview] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const openedRef = useRef(false);

  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content) as string), [content]);

  const open = useCallback(async () => {
    const api = getNoteApi();
    if (!api) return;
    const res = await api.open();
    if (res) {
      setContent(res.content);
      setPath(res.path);
      setName(res.name);
      setSavedAt(null);
    }
  }, []);

  const save = useCallback(async () => {
    const api = getNoteApi();
    if (!api) return;
    const res = await api.save(path, content);
    if (res) {
      setPath(res.path);
      setName(res.name);
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    }
  }, [path, content]);

  useEffect(() => {
    if (openOnMount && !openedRef.current) {
      openedRef.current = true;
      open();
    }
  }, [openOnMount, open]);

  return (
    <div className="ft-tab-body note">
      <div className="note-toolbar">
        <span className="note-name"><FileText size={12} />{name}</span>
        <span className="note-actions">
          <button type="button" onClick={open} title="打开 Markdown 笔记">打开</button>
          <button type="button" onClick={save} title="保存 Markdown 笔记">保存{savedAt ? ` ${savedAt}` : ''}</button>
          <button type="button" onClick={() => setPreview((p) => !p)}>{preview ? '编辑' : '预览'}</button>
        </span>
      </div>
      {preview ? (
        <div className="note-preview markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <textarea
          className="note-editor"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="# 在此输入 Markdown 笔记…"
          spellCheck={false}
        />
      )}
    </div>
  );
}

function BrowserTab() {
  const webviewRef = useRef<HTMLElement | null>(null);
  const [url, setUrl] = useState('');
  const [src, setSrc] = useState('about:blank');
  const canWebview = useMemo(() => {
    if (typeof document === 'undefined') return false;
    try {
      const el = document.createElement('webview');
      return typeof (el as unknown as { getURL?: unknown }).getURL === 'function';
    } catch {
      return false;
    }
  }, []);

  const go = useCallback(() => {
    const value = url.trim();
    if (!value) return;
    const target = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    setUrl(target);
    setSrc(target);
  }, [url]);

  // Keep the address bar in sync with the embedded browser's location.
  useEffect(() => {
    if (!canWebview || !webviewRef.current) return;
    const wv = webviewRef.current as unknown as {
      addEventListener(type: string, listener: (event: { url?: string }) => void): void;
      removeEventListener(type: string, listener: (event: { url?: string }) => void): void;
    };
    const onNavigate = (event: { url?: string }) => {
      if (event.url && event.url !== 'about:blank') setUrl(event.url);
    };
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, [canWebview]);

  return (
    <div className="ft-tab-body browser">
      <div className="browser-bar">
        <input
          className="browser-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go();
          }}
          placeholder="输入网址，Enter 前往"
          spellCheck={false}
        />
        <button type="button" onClick={go}>前往</button>
        {!canWebview && (
          <button type="button" className="browser-open" onClick={() => window.open(src)} disabled={src === 'about:blank'}>新窗口</button>
        )}
      </div>
      {!canWebview && (
        <div className="browser-preview-note">网页预览模式：受 X-Frame-Options 限制的站点（如 Bing/Google）无法内嵌；完整浏览器请在桌面应用中体验，或点「新窗口」打开。</div>
      )}
      {canWebview ? (
        <webview ref={webviewRef as React.Ref<HTMLElement>} className="browser-frame" src={src} partition="persist:seahare-floating-browser" />
      ) : (
        <iframe className="browser-frame" src={src} title="浮动浏览器" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
      )}
    </div>
  );
}

const FloatingWorkspace = forwardRef<FloatingWorkspaceHandle, FloatingWorkspaceProps>(function FloatingWorkspace({ open, onClose }, ref) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>('min');
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ left: number; top: number } | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragMovedRef = useRef(false);

  const toggleMenu = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = addBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(4, Math.min(rect.left, window.innerWidth - 250));
      setMenuRect({ left, top: rect.bottom + 4 });
    }
    setMenuOpen(true);
  }, [menuOpen]);

  const addTab = useCallback((kind: TabKind, opts?: { openOnMount?: boolean }) => {
    labelSeq[kind] += 1;
    const tab: Tab = { id: nextTabId(), kind, title: defaultTitle(kind, labelSeq[kind]), openOnMount: opts?.openOnMount };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setMode((m) => (m === 'min' ? 'normal' : m));
    setMenuOpen(false);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id);
      if (index === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveId((current) => {
        if (current !== id) return current;
        const fallback = next[index] ?? next[index - 1] ?? null;
        return fallback ? fallback.id : null;
      });
      return next;
    });
  }, []);

  const minimize = useCallback(() => setMode((current) => (current === 'min' ? 'normal' : 'min')), []);

  useImperativeHandle(ref, () => ({ addTab, minimize }), [addTab, minimize]);

  const startPanelDrag = useCallback((event: React.PointerEvent) => {
    // Dragging only from the background, not tabs or buttons.
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('.ft-tab')) return;
    dragMovedRef.current = false;
    dragRef.current = { startX: event.clientX, startY: event.clientY, posX: pos.x, posY: pos.y };
    const move = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (Math.abs(ev.clientX - drag.startX) + Math.abs(ev.clientY - drag.startY) > 3) dragMovedRef.current = true;
      setPos({ x: drag.posX + (ev.clientX - drag.startX), y: drag.posY + (ev.clientY - drag.startY) });
    };
    const up = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setTimeout(() => {
        dragMovedRef.current = false;
      }, 0);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, [pos.x, pos.y]);

  const onTabBarPointerDown = useCallback((event: React.PointerEvent) => {
    if (mode !== 'normal') return;
    startPanelDrag(event);
  }, [mode, startPanelDrag]);

  const style: React.CSSProperties = {};
  if (mode === 'max') style.inset = '12px';
  else style.transform = `translate(${pos.x}px, ${pos.y}px)`;

  if (mode === 'min') {
    const activeTabTitle = tabs.find((t) => t.id === activeId)?.title;
    return (
      <div
        className={`floating-terminal minimized ${open ? '' : 'hidden'}`}
        style={style}
        role="region"
        aria-label="浮动工作区（已最小化）"
        onClick={() => {
          if (dragMovedRef.current) return;
          setMode('normal');
        }}
        onPointerDown={startPanelDrag}
      >
        <span className="ft-mini-icon"><TerminalSquare size={13} /></span>
        <span className="ft-mini-label">浮动工作区</span>
        {activeTabTitle && <span className="ft-mini-tab">{activeTabTitle}</span>}
      </div>
    );
  }

  return (
    <>
      <div className={`floating-terminal ${open ? '' : 'hidden'} mode-${mode}`} style={style} role="region" aria-label="浮动工作区">
      <div className="ft-tabs" onPointerDown={onTabBarPointerDown}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`ft-tab ${tab.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(tab.id)}
            title={tab.title}
          >
            <span className="ft-tab-icon">{tabIcon(tab.kind)}</span>
            <span className="ft-tab-title">{tab.title}</span>
            <button className="ft-tab-close" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} title="关闭标签" aria-label={`关闭 ${tab.title}`}><X size={10} /></button>
          </div>
        ))}
        <div className="ft-add-wrap">
          <button ref={addBtnRef} className="ft-add" onClick={toggleMenu} title="新建面板" aria-label="新建面板">+</button>
        </div>
        <span className="ft-panel-actions">
          <button type="button" onClick={() => setMode('min')} title="最小化 (Ctrl+W)" aria-label="最小化"><Minimize2 size={12} /></button>
          <button type="button" onClick={() => setMode((current) => (current === 'max' ? 'normal' : 'max'))} title={mode === 'max' ? '还原' : '最大化'} aria-label={mode === 'max' ? '还原' : '最大化'}>{mode === 'max' ? <Minimize2 size={12} /> : <Maximize2 size={12} />}</button>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭浮动工作区"><X size={12} /></button>
        </span>
      </div>

      <div className="ft-bodies">
          {tabs.length === 0 ? (
            <div className="ft-empty">
              <div className="ft-empty-title">浮动工作区为空 — 点击下方按钮新建面板：</div>
              <div className="ft-empty-actions">
                <button type="button" onClick={() => addTab('terminal')}><TerminalSquare size={13} />新终端 <kbd>Ctrl+T</kbd></button>
                <button type="button" onClick={() => addTab('note')}><FileText size={13} />新的 Markdown 笔记 <kbd>Ctrl+Shift+M</kbd></button>
                <button type="button" onClick={() => addTab('note', { openOnMount: true })}><FileText size={13} />打开 Markdown 笔记 <kbd>Ctrl+Shift+O</kbd></button>
                <button type="button" onClick={() => addTab('browser')}><Globe size={13} />新浏览器 <kbd>Ctrl+Shift+B</kbd></button>
                <button type="button" onClick={minimize}><Minimize2 size={13} />最小化 <kbd>Ctrl+W</kbd></button>
              </div>
            </div>
          ) : (
            tabs.map((tab) => (
              <div key={tab.id} className={`ft-body ${tab.id === activeId ? 'active' : ''}`}>
                {tab.kind === 'terminal' && <TerminalTab sessionKey={tab.id} />}
                {tab.kind === 'note' && <NoteTab openOnMount={tab.openOnMount} />}
                {tab.kind === 'browser' && <BrowserTab />}
              </div>
            ))
          )}
      </div>
      </div>
      {menuOpen && menuRect && createPortal(
        <>
          <div className="ft-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="ft-menu" role="menu" style={{ left: menuRect.left, top: menuRect.top }}>
            <button role="menuitem" onClick={() => addTab('terminal')}>新终端 <kbd>Ctrl+T</kbd></button>
            <button role="menuitem" onClick={() => addTab('note')}>新的 Markdown 笔记 <kbd>Ctrl+Shift+M</kbd></button>
            <button role="menuitem" onClick={() => addTab('note', { openOnMount: true })}>打开 Markdown 笔记 <kbd>Ctrl+Shift+O</kbd></button>
            <button role="menuitem" onClick={() => addTab('browser')}>新浏览器 <kbd>Ctrl+Shift+B</kbd></button>
            <div className="ft-menu-sep" />
            <button role="menuitem" onClick={() => { setMenuOpen(false); minimize(); }}>最小化 <kbd>Ctrl+W</kbd></button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
});

export default FloatingWorkspace;
