import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookMarked,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  Globe,
  History,
  Info,
  ListFilter,
  Loader2,
  Moon,
  Pause,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Pencil,
  RefreshCw,
  Route,
  RotateCcw,
  Search,
  ListChecks,
  Sparkles,
  ShieldAlert,
  ShieldCheck,
  Square,
  Sun,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import FloatingWorkspace, { type FloatingWorkspaceHandle } from './FloatingWorkspace';

const API_BASE = 'http://127.0.0.1:8765';
const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed', 'interrupted'];
const ENUM_PLACEHOLDER = '{fuzz}';
const ENUM_MAX_WORDS = 500000;
const ENUM_MAX_LEN = 6;
const ENUM_DEFAULT_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

type Severity = 'all' | 'high' | 'medium' | 'low' | 'info';
type ResultFilter = 'all' | 'interesting' | 'redirect';
type Theme = 'dark' | 'light' | 'glass' | 'mist';
type TargetType = 'web' | 'api' | 'h5';

const themeOptions: Array<{ value: Theme; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'glass', label: '深色玻璃' },
  { value: 'mist', label: '淡色玻璃' },
];
type RequestMethod = 'AUTO' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

// Keep in sync with backend TARGET_TYPES / REQUEST_METHODS (server.py).
const TARGET_TYPES: TargetType[] = ['web', 'api', 'h5'];
const REQUEST_METHODS: RequestMethod[] = ['AUTO', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHODS_WITH_BODY: RequestMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

const targetTypeText: Record<TargetType, string> = {
  web: 'Web目录',
  api: 'API',
  h5: 'H5',
};

const targetTypeDescription: Record<TargetType, string> = {
  web: '按字典拼接 Web 路径，关注可访问目录、敏感路径和重定向。',
  api: '按接口路径探测，并展示 JSON 业务码、业务消息和响应证据。',
  h5: '按页面路径探测，并比较 SPA 基线，标记统一回退页。',
};

interface HeaderRow {
  key: string;
  value: string;
}

interface Scan {
  id: string;
  target: string;
  dictionary: string;
  threads: number;
  timeout: number;
  preset: string;
  target_type: TargetType;
  request_method: RequestMethod;
  request_headers: Record<string, string>;
  request_body: string;
  mode: string;
  charset: string;
  min_len: number;
  max_len: number;
  placeholder: string;
  status: string;
  progress: number;
  requests: number;
  found: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface HistoryTargetGroup {
  key: string;
  path: string;
  scans: Scan[];
}

interface HistoryHostGroup {
  key: string;
  label: string;
  targets: HistoryTargetGroup[];
}

interface HistoryFolder {
  id: string;
  name: string;
  scanIds: string[];
  children: HistoryFolder[];
  origin: 'custom' | 'auto';
}

function parseHistoryFolder(value: unknown): HistoryFolder | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (!item.id || !item.name) return null;
  const children = Array.isArray(item.children)
    ? item.children.map(parseHistoryFolder).filter((child): child is HistoryFolder => Boolean(child))
    : [];
  return {
    id: String(item.id),
    name: String(item.name),
    scanIds: Array.isArray(item.scanIds) ? item.scanIds.map(String) : [],
    children,
    origin: item.origin === 'auto' ? 'auto' : 'custom',
  };
}

interface HistoryDragPayload {
  scanIds: string[];
  folder?: HistoryFolder;
}

const collectHistoryFolderScanIds = (folder: HistoryFolder): string[] => [
  ...folder.scanIds,
  ...folder.children.flatMap(collectHistoryFolderScanIds),
];

const removeHistoryScanIds = (folders: HistoryFolder[], scanIds: Set<string>): HistoryFolder[] => folders.map((folder) => ({
  ...folder,
  scanIds: folder.scanIds.filter((scanId) => !scanIds.has(scanId)),
  children: removeHistoryScanIds(folder.children, scanIds),
}));

const containsHistoryFolder = (folder: HistoryFolder, folderId: string): boolean => folder.id === folderId
  || folder.children.some((child) => containsHistoryFolder(child, folderId));

const removeHistoryFolder = (folders: HistoryFolder[], folderId: string): { folders: HistoryFolder[]; removed: HistoryFolder | null } => {
  const index = folders.findIndex((folder) => folder.id === folderId);
  if (index >= 0) {
    const removed = folders[index];
    return { folders: folders.filter((_, currentIndex) => currentIndex !== index), removed };
  }
  for (let index = 0; index < folders.length; index += 1) {
    const result = removeHistoryFolder(folders[index].children, folderId);
    if (result.removed) {
      const next = [...folders];
      next[index] = { ...next[index], children: result.folders };
      return { folders: next, removed: result.removed };
    }
  }
  return { folders, removed: null };
};

const appendHistoryFolderChild = (folders: HistoryFolder[], parentId: string, child: HistoryFolder): HistoryFolder[] => folders.map((folder) => {
  if (folder.id === parentId) return { ...folder, children: [...folder.children, child] };
  return { ...folder, children: appendHistoryFolderChild(folder.children, parentId, child) };
});

const hasHistoryFolder = (folders: HistoryFolder[], folderId: string): boolean => folders.some((folder) => folder.id === folderId
  || hasHistoryFolder(folder.children, folderId));

const appendHistoryScanToFolder = (folders: HistoryFolder[], folderId: string, scanId: string): HistoryFolder[] => folders.map((folder) => {
  if (folder.id === folderId) return { ...folder, scanIds: [...new Set([...folder.scanIds, scanId])] };
  return { ...folder, children: appendHistoryScanToFolder(folder.children, folderId, scanId) };
});

const createAutoTargetFolder = (target: HistoryTargetGroup): HistoryFolder => ({
  id: `auto-target-${target.key}`,
  name: target.path === '/' ? '根路径' : target.path,
  scanIds: target.scans.map((scan) => scan.id),
  children: [],
  origin: 'auto',
});

const createAutoHostFolder = (group: HistoryHostGroup): HistoryFolder => ({
  id: `auto-host-${group.key}`,
  name: group.label,
  scanIds: [],
  children: group.targets.map(createAutoTargetFolder),
  origin: 'auto',
});

interface ScanResult {
  id: number;
  scan_id: string;
  path: string;
  url: string;
  request_method: RequestMethod;
  status: number;
  severity: Exclude<Severity, 'all'>;
  category: string;
  redirect_location: string;
  business_code: number | null;
  business_message: string;
  response_preview: string;
  body_hash: string;
  spa_fallback: boolean;
  length: number;
  content_type: string;
  response_time: number;
  discovered_at: string;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  dictionary: string;
  threads: number;
  timeout: number;
}

interface DictionaryItem {
  name: string;
  entries: number;
  size: number;
  builtin: boolean;
}

interface ResultSummary {
  total: number;
  max_id: number;
  severity: Record<Exclude<Severity, 'all'>, number>;
  categories: Record<string, number>;
}

interface ResultPage {
  results: ScanResult[];
  returned: number;
  next_cursor: number;
  has_more: boolean;
  summary: ResultSummary;
}

const EMPTY_SUMMARY: ResultSummary = {
  total: 0,
  max_id: 0,
  severity: { high: 0, medium: 0, low: 0, info: 0 },
  categories: {},
};

const severityText: Record<Exclude<Severity, 'all'>, string> = {
  high: '高风险',
  medium: '需关注',
  low: '低风险',
  info: '信息',
};

const categoryText: Record<string, string> = {
  sensitive: '敏感路径',
  authentication: '认证入口',
  server_error: '服务异常',
  protected: '受保护',
  redirect: '重定向',
  accessible: '可访问',
  business_error: '业务错误',
  spa_fallback: 'SPA 回退',
};

const rangeFill = (value: number, min: number, max: number) =>
  `${Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))}%`;

const createDefaultScanName = (target: string, existingScans: Scan[]) => {
  let targetLabel = target.trim() || 'target';
  try {
    const parsed = new URL(targetLabel.startsWith('http://') || targetLabel.startsWith('https://') ? targetLabel : `http://${targetLabel}`);
    targetLabel = `${parsed.hostname}${parsed.port ? `-${parsed.port}` : ''}${parsed.pathname !== '/' ? `-${parsed.pathname}` : ''}`;
  } catch {
    // Keep the raw target when it is not yet a complete URL.
  }
  targetLabel = targetLabel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'target';
  const attempt = target.trim() ? existingScans.filter((scan) => scan.target === target).length + 1 : 1;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${targetLabel}-${timestamp}-scan-${attempt}`;
};

export default function App() {
  const [backendOnline, setBackendOnline] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [dictionaryItems, setDictionaryItems] = useState<DictionaryItem[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'create' | 'detail'>('detail');
  const [currentScan, setCurrentScan] = useState<Scan | null>(null);
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [resultSummary, setResultSummary] = useState<ResultSummary>(EMPTY_SUMMARY);
  const [resultHasMore, setResultHasMore] = useState(false);

  const [newTarget, setNewTarget] = useState('');
  const [newScanName, setNewScanName] = useState('');
  const [newPreset, setNewPreset] = useState('balanced');
  const [newDictionary, setNewDictionary] = useState('common.txt');
  const [newThreads, setNewThreads] = useState(8);
  const [newTimeout, setNewTimeout] = useState(10);
  const [scanMode, setScanMode] = useState<'dictionary' | 'enum'>('dictionary');
  const [enumCharset, setEnumCharset] = useState(ENUM_DEFAULT_CHARSET);
  const [newTargetType, setNewTargetType] = useState<TargetType>('web');
  const [newMethod, setNewMethod] = useState<RequestMethod>('AUTO');
  const [newHeaders, setNewHeaders] = useState<HeaderRow[]>([]);
  const [newBody, setNewBody] = useState('');
  // Length fields use string state so the user can type freely (clearing the
  // field stays empty instead of snapping to 0, no auto leading zero). The
  // numeric values below are the clamped interpretations used for counting.
  const [enumMinLenStr, setEnumMinLenStr] = useState('1');
  const [enumMaxLenStr, setEnumMaxLenStr] = useState('3');
  const enumMinLen = Math.max(1, Math.min(ENUM_MAX_LEN, Number.parseInt(enumMinLenStr, 10) || 1));
  const enumMaxLen = Math.max(1, Math.min(ENUM_MAX_LEN, Number.parseInt(enumMaxLenStr, 10) || 1));
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [filter, setFilter] = useState<ResultFilter>('all');
  const [severityFilter, setSeverityFilter] = useState<Severity>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedResultIds, setExpandedResultIds] = useState<Set<number>>(new Set());
  const [expandedHistoryHosts, setExpandedHistoryHosts] = useState<Set<string>>(new Set());
  const [expandedHistoryTargets, setExpandedHistoryTargets] = useState<Set<string>>(new Set());
  const [expandedHistoryFolders, setExpandedHistoryFolders] = useState<Set<string>>(new Set());
  const [dragOverHistoryFolderId, setDragOverHistoryFolderId] = useState<string | null>(null);
  const [dragOverHistoryAutoKey, setDragOverHistoryAutoKey] = useState<string | null>(null);
  const [dragOverHistoryUnfiled, setDragOverHistoryUnfiled] = useState(false);
  const [editingHistoryFolderId, setEditingHistoryFolderId] = useState<string | null>(null);
  const [historyFolderEditName, setHistoryFolderEditName] = useState('');
  const [editingHistoryScanId, setEditingHistoryScanId] = useState<string | null>(null);
  const [historyScanEditName, setHistoryScanEditName] = useState('');
  const [historyScanNames, setHistoryScanNames] = useState<Record<string, string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('seahare-history-scan-names') || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch {
      return {};
    }
  });
  const [historyHostNames, setHistoryHostNames] = useState<Record<string, string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('seahare-history-host-names') || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch {
      return {};
    }
  });
  const [editingHistoryHostKey, setEditingHistoryHostKey] = useState<string | null>(null);
  const [historyHostEditName, setHistoryHostEditName] = useState('');
  const knownHistoryHostsRef = useRef<Set<string>>(new Set());
  const knownHistoryTargetsRef = useRef<Set<string>>(new Set());
  const [historyProjectFilter, setHistoryProjectFilter] = useState('all');
  const [historyFilterOpen, setHistoryFilterOpen] = useState(false);
  const [historyFolders, setHistoryFolders] = useState<HistoryFolder[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('seahare-history-folders') || '[]');
      return Array.isArray(stored)
        ? stored.map(parseHistoryFolder).filter((item): item is HistoryFolder => Boolean(item))
        : [];
    } catch {
      return [];
    }
  });
  const [historyFolderDraftOpen, setHistoryFolderDraftOpen] = useState(false);
  const [historyFolderName, setHistoryFolderName] = useState('');

  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryName, setDictionaryName] = useState('');
  const [dictionaryContent, setDictionaryContent] = useState('');
  const [dictionaryError, setDictionaryError] = useState<string | null>(null);
  const [dictionarySaving, setDictionarySaving] = useState(false);
  const [dictionaryDrag, setDictionaryDrag] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [detailsPaneOpen, setDetailsPaneOpen] = useState(true);
  const workspaceRef = useRef<FloatingWorkspaceHandle>(null);

  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('seahare-theme');
    return stored === 'light' || stored === 'glass' || stored === 'mist' ? stored : 'dark';
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  const historyGroups = useMemo<HistoryHostGroup[]>(() => {
    const hostGroups = new Map<string, HistoryHostGroup>();
    scans.forEach((scan) => {
      let origin = '';
      let hostLabel = '';
      let path = '/';
      try {
        const parsed = new URL(scan.target);
        origin = parsed.origin;
        hostLabel = parsed.host;
        path = `${parsed.pathname || '/'}${parsed.search}`;
      } catch {
        origin = scan.target;
        hostLabel = scan.target.replace(/^https?:\/\//, '').split('/')[0];
        path = `/${scan.target.split('/').slice(3).join('/')}` || '/';
      }

      const hostGroup = hostGroups.get(origin) || { key: origin, label: hostLabel || origin, targets: [] };
      let targetGroup = hostGroup.targets.find((target) => target.key === scan.target);
      if (!targetGroup) {
        targetGroup = { key: scan.target, path, scans: [] };
        hostGroup.targets.push(targetGroup);
      }
      targetGroup.scans.push(scan);
      hostGroups.set(origin, hostGroup);
    });
    return [...hostGroups.values()];
  }, [scans]);

  const filteredHistoryGroups = useMemo(
    () => {
      const assignedScanIds = new Set(historyFolders.flatMap((folder) => collectHistoryFolderScanIds(folder)));
      const visibleGroups = historyGroups
        .map((group) => ({
          ...group,
          targets: group.targets
            .map((target) => ({ ...target, scans: target.scans.filter((scan) => !assignedScanIds.has(scan.id)) })),
        }))
        .filter((group) => group.targets.some((target) => target.scans.length > 0));
      return historyProjectFilter === 'all' ? visibleGroups : visibleGroups.filter((group) => group.key === historyProjectFilter);
    },
    [historyGroups, historyFolders, historyProjectFilter],
  );

  useEffect(() => {
    document.documentElement.classList.toggle('light-theme', theme === 'light');
    document.documentElement.classList.toggle('glass-theme', theme === 'glass');
    document.documentElement.classList.toggle('mist-theme', theme === 'mist');
    localStorage.setItem('seahare-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!themeMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!themeMenuRef.current?.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThemeMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    setExpandedHistoryHosts((previous) => {
      const next = new Set(previous);
      let changed = false;
      historyGroups.forEach((group) => {
        if (!knownHistoryHostsRef.current.has(group.key)) {
          knownHistoryHostsRef.current.add(group.key);
          next.add(group.key);
          changed = true;
        }
      });
      return changed ? next : previous;
    });
    setExpandedHistoryTargets((previous) => {
      const next = new Set(previous);
      let changed = false;
      historyGroups.forEach((group) => group.targets.forEach((target) => {
        if (!knownHistoryTargetsRef.current.has(target.key)) {
          knownHistoryTargetsRef.current.add(target.key);
          next.add(target.key);
          changed = true;
        }
      }));
      return changed ? next : previous;
    });
  }, [historyGroups]);

  useEffect(() => {
    localStorage.setItem('seahare-history-folders', JSON.stringify(historyFolders));
  }, [historyFolders]);

  useEffect(() => {
    localStorage.setItem('seahare-history-scan-names', JSON.stringify(historyScanNames));
  }, [historyScanNames]);

  useEffect(() => {
    localStorage.setItem('seahare-history-host-names', JSON.stringify(historyHostNames));
  }, [historyHostNames]);

  const [createModalState, setCreateModalState] = useState<'closed' | 'open' | 'closing'>('closed');
  const [createModalActive, setCreateModalActive] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createDialogRef = useRef<HTMLElement | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newScanButtonRef = useRef<HTMLButtonElement | null>(null);
  const dictionaryOpenRef = useRef(dictionaryOpen);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const activeScanRef = useRef<string | null>(null);
  const statusRef = useRef<string | null>(null);
  const resultCursorRef = useRef(0);
  const dictionaryDialogRef = useRef<HTMLElement | null>(null);
  const dictionaryTriggerRef = useRef<HTMLElement | null>(null);
  const dictionaryFileInputRef = useRef<HTMLInputElement>(null);

  const closeCreateModal = useCallback(() => {
    setViewMode('detail');
  }, []);

  const handleNewScanClick = () => {
    createTriggerRef.current = newScanButtonRef.current;
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    if (viewMode === 'create' && createModalState === 'open') {
      targetInputRef.current?.focus();
      return;
    }
    setViewMode('create');
  };

  const handleAddHistoryFolder = () => {
    setHistoryFolderName('');
    setHistoryFolderDraftOpen(true);
  };

  const handleSaveHistoryFolder = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = historyFolderName.trim();
    if (!name) return;
    setHistoryFolders((current) => [
      ...current,
      { id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, scanIds: [], children: [], origin: 'custom' },
    ]);
    setHistoryFolderName('');
    setHistoryFolderDraftOpen(false);
  };

  const toggleHistoryFolder = (folderId: string) => {
    setExpandedHistoryFolders((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  };

  const handleHistoryDragStart = (event: React.DragEvent, scanIds: string[], folder?: HistoryFolder) => {
    event.dataTransfer.effectAllowed = 'move';
    const payload: HistoryDragPayload = { scanIds, folder };
    event.dataTransfer.setData('application/x-seahare-history', JSON.stringify(payload));
  };

  const handleHistoryAutoDragOver = (event: React.DragEvent, autoKey: string) => {
    if (event.dataTransfer.types.includes('application/x-seahare-history')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDragOverHistoryAutoKey(autoKey);
    }
  };

  const handleHistoryUnfiledDragOver = (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes('application/x-seahare-history')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDragOverHistoryUnfiled(true);
    }
  };

  const handleHistoryBlankAreaDragOver = (event: React.DragEvent) => {
    if (event.target === event.currentTarget) handleHistoryUnfiledDragOver(event);
  };

  const handleHistoryDropToBlankArea = (event: React.DragEvent) => {
    if (event.target === event.currentTarget) handleHistoryDropToUnfiled(event);
  };

  const handleHistoryDrop = (event: React.DragEvent, folderId: string) => {
    event.preventDefault();
    setDragOverHistoryFolderId(null);
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-seahare-history')) as HistoryDragPayload;
      if (!Array.isArray(payload.scanIds) || payload.scanIds.length === 0) return;
      const ids = new Set(payload.scanIds.map(String));
      setHistoryFolders((current) => {
        if (payload.folder) {
          if (payload.folder.id === folderId || containsHistoryFolder(payload.folder, folderId)) return current;
          const removed = removeHistoryFolder(current, payload.folder.id);
          const movedFolder = removed.removed || payload.folder;
          return appendHistoryFolderChild(removeHistoryScanIds(removed.folders, ids), folderId, movedFolder);
        }
        return current.map((folder) => folder.id === folderId
          ? { ...folder, scanIds: [...new Set([...folder.scanIds, ...ids])] }
          : { ...folder, scanIds: folder.scanIds.filter((id) => !ids.has(id)), children: removeHistoryScanIds(folder.children, ids) });
      });
      setExpandedHistoryFolders((previous) => new Set(previous).add(folderId));
    } catch {
      // Ignore drops that did not originate from a Seahare history item.
    }
  };

  const handleHistoryDropToAuto = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOverHistoryAutoKey(null);
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-seahare-history')) as HistoryDragPayload;
      if (!Array.isArray(payload.scanIds) || payload.scanIds.length === 0) return;
      const ids = new Set(payload.scanIds.map(String));
      setHistoryFolders((current) => {
        const removed = payload.folder ? removeHistoryFolder(current, payload.folder.id) : { folders: current, removed: null };
        return removeHistoryScanIds(removed.folders, ids);
      });
      expandHistoryScanLocations(ids);
    } catch {
      // Ignore drops that did not originate from a Seahare history item.
    }
  };

  const expandHistoryScanLocations = (scanIds: Set<string>) => {
    const hostKeys = new Set<string>();
    const targetKeys = new Set<string>();
    historyGroups.forEach((group) => group.targets.forEach((target) => {
      if (target.scans.some((scan) => scanIds.has(scan.id))) {
        hostKeys.add(group.key);
        targetKeys.add(target.key);
      }
    }));
    if (hostKeys.size > 0) setExpandedHistoryHosts((previous) => new Set([...previous, ...hostKeys]));
    if (targetKeys.size > 0) setExpandedHistoryTargets((previous) => new Set([...previous, ...targetKeys]));
  };

  const handleHistoryDropToUnfiled = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOverHistoryUnfiled(false);
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-seahare-history')) as HistoryDragPayload;
      if (!Array.isArray(payload.scanIds) || payload.scanIds.length === 0) return;
      const ids = new Set(payload.scanIds.map(String));
      setHistoryFolders((current) => {
        const removed = payload.folder ? removeHistoryFolder(current, payload.folder.id) : { folders: current, removed: null };
        return removeHistoryScanIds(removed.folders, ids);
      });
      expandHistoryScanLocations(ids);
    } catch {
      // Ignore drops that did not originate from a Seahare history item.
    }
  };

  const inheritHistoryFolderForScan = (scan: Scan) => {
    const targetFolderId = `auto-target-${scan.target}`;
    setHistoryFolders((current) => hasHistoryFolder(current, targetFolderId)
      ? appendHistoryScanToFolder(current, targetFolderId, scan.id)
      : current);
  };

  const startHistoryFolderRename = (folder: HistoryFolder) => {
    setEditingHistoryFolderId(folder.id);
    setHistoryFolderEditName(folder.name);
  };

  const cancelHistoryFolderRename = () => {
    setEditingHistoryFolderId(null);
    setHistoryFolderEditName('');
  };

  const saveHistoryFolderRename = (event: React.FormEvent<HTMLFormElement>, folderId: string) => {
    event.preventDefault();
    const name = historyFolderEditName.trim();
    if (!name) return;
    setHistoryFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, name } : folder));
    cancelHistoryFolderRename();
  };

  const deleteHistoryFolder = (folder: HistoryFolder) => {
    if (!window.confirm(`删除文件夹“${folder.name}”？其中的扫描任务不会被删除。`)) return;
    setHistoryFolders((current) => removeHistoryFolder(current, folder.id).folders);
    setExpandedHistoryFolders((current) => {
      const next = new Set(current);
      next.delete(folder.id);
      return next;
    });
    if (editingHistoryFolderId === folder.id) cancelHistoryFolderRename();
  };

  // Sync viewMode to createModalState and handle animations
  useEffect(() => {
    dictionaryOpenRef.current = dictionaryOpen;
  }, [dictionaryOpen]);

  useEffect(() => () => {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (viewMode === 'create') {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setCreateModalState('open');
    } else {
      if (createModalState === 'open') {
        setCreateModalActive(false);
        setCreateModalState('closing');
        closeTimeoutRef.current = setTimeout(() => {
          setCreateModalState('closed');
          closeTimeoutRef.current = null;
        }, 260);
      }
    }
  }, [viewMode, createModalState]);

  // Handle active class tick on open
  useEffect(() => {
    if (createModalState === 'open') {
      const frame = requestAnimationFrame(() => {
        setCreateModalActive(true);
      });
      return () => cancelAnimationFrame(frame);
    } else if (createModalState === 'closed') {
      setCreateModalActive(false);
    }
  }, [createModalState]);

  // Handle keydown (Esc, Tab focus trap) and focus restore
  useEffect(() => {
    if (createModalState !== 'open') return;

    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const focusFrame = requestAnimationFrame(() => {
      targetInputRef.current?.focus();
    });

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (dictionaryOpenRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCreateModal();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(createDialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleDialogKeyDown);
    };
  }, [createModalState, closeCreateModal]);

  useEffect(() => {
    if (createModalState !== 'closed' || !createTriggerRef.current) return;
    createTriggerRef.current.focus();
    createTriggerRef.current = null;
  }, [createModalState]);

  // Floating workspace shortcuts (capture phase beats xterm and editors).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.altKey && key === 'a') {
        event.preventDefault();
        setWorkspaceOpen((current) => !current);
        return;
      }
      if (event.ctrlKey && event.altKey) return;
      if (event.ctrlKey && key === 't' && !event.shiftKey) {
        event.preventDefault();
        setWorkspaceOpen(true);
        workspaceRef.current?.addTab('terminal');
      } else if (event.ctrlKey && event.shiftKey && key === 'm') {
        event.preventDefault();
        setWorkspaceOpen(true);
        workspaceRef.current?.addTab('note');
      } else if (event.ctrlKey && event.shiftKey && key === 'o') {
        event.preventDefault();
        setWorkspaceOpen(true);
        workspaceRef.current?.addTab('note', { openOnMount: true });
      } else if (event.ctrlKey && event.shiftKey && key === 'b') {
        event.preventDefault();
        setWorkspaceOpen(true);
        workspaceRef.current?.addTab('browser');
      } else if (event.ctrlKey && key === 'w' && !event.shiftKey) {
        event.preventDefault();
        workspaceRef.current?.minimize();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const getStatusText = (status: string) => {
    switch (status) {
      case 'queued': return '队列中';
      case 'running': return '扫描中';
      case 'paused': return '已暂停';
      case 'cancelling': return '正在取消';
      case 'cancelled': return '已取消';
      case 'completed': return '已完成';
      case 'failed': return '已失败';
      case 'interrupted': return '已中断';
      default: return status;
    }
  };

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/health`);
      if (response.ok) {
        const data = await response.json();
        const online = data.ok === true && data.service === 'seahare';
        setBackendOnline(online);
        return online;
      }
    } catch {
      setBackendOnline(false);
    }
    return false;
  }, []);

  const fetchPresets = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/presets`);
      if (response.ok) setPresets((await response.json()).presets || []);
    } catch (error) {
      console.error('Failed to fetch presets', error);
    }
  }, []);

  const fetchDictionaries = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/dictionaries`);
      if (!response.ok) return;
      const data = await response.json();
      const items: DictionaryItem[] = data.items || (data.dictionaries || []).map((name: string) => ({
        name, entries: 0, size: 0, builtin: true,
      }));
      setDictionaryItems(items);
      setNewDictionary((current) => items.some((item) => item.name === current) ? current : items[0]?.name || '');
    } catch (error) {
      console.error('Failed to fetch dictionaries', error);
    }
  }, []);

  const fetchScans = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/scans`);
      if (response.ok) setScans((await response.json()).scans || []);
    } catch (error) {
      console.error('Failed to fetch scans', error);
    }
  }, []);

  const mergeResults = useCallback((incoming: ScanResult[], reset = false) => {
    setScanResults((current) => {
      const rows = reset ? [] : current;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const row of incoming) byId.set(row.id, row);
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
  }, []);

  const fetchResultPage = useCallback(async (scanId: string, reset = false) => {
    const afterId = reset ? 0 : resultCursorRef.current;
    const response = await fetch(`${API_BASE}/api/scans/${scanId}/results?status=all&after_id=${afterId}&limit=500`);
    if (!response.ok) return;
    const data: ResultPage = await response.json();
    if (activeScanRef.current !== scanId) return;
    mergeResults(data.results || [], reset);
    resultCursorRef.current = data.next_cursor || afterId;
    setResultHasMore(Boolean(data.has_more));
    setResultSummary(data.summary || EMPTY_SUMMARY);
  }, [mergeResults]);

  const fetchScanSnapshot = useCallback(async (scanId: string, resetResults = false) => {
    try {
      const response = await fetch(`${API_BASE}/api/scans/${scanId}`);
      if (!response.ok) return null;
      const scan: Scan = await response.json();
      if (activeScanRef.current !== scanId) return null;
      setCurrentScan(scan);
      statusRef.current = scan.status;
      await fetchResultPage(scanId, resetResults);
      return scan;
    } catch (error) {
      console.error(`Failed to fetch scan ${scanId}`, error);
      return null;
    }
  }, [fetchResultPage]);

  useEffect(() => {
    const initialize = async () => {
      if (await checkHealth()) {
        await Promise.all([fetchPresets(), fetchDictionaries(), fetchScans()]);
      }
    };
    initialize();
    const interval = setInterval(async () => {
      if (await checkHealth()) fetchScans();
    }, 3000);
    return () => clearInterval(interval);
  }, [checkHealth, fetchDictionaries, fetchPresets, fetchScans]);

  useEffect(() => {
    if (!dictionaryOpen) return;

    dictionaryTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusFrame = requestAnimationFrame(() => {
      dictionaryDialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDictionaryOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(dictionaryDialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleDialogKeyDown);
      dictionaryTriggerRef.current?.focus();
      dictionaryTriggerRef.current = null;
    };
  }, [dictionaryOpen]);

  useEffect(() => {
    activeScanRef.current = selectedScanId;
    resultCursorRef.current = 0;
    setCurrentScan(null);
    setScanResults([]);
    setResultSummary(EMPTY_SUMMARY);
    setResultHasMore(false);
    if (!selectedScanId) {
      statusRef.current = null;
      return;
    }

    let disposed = false;
    let source: EventSource | null = null;
    let pollingTimer: ReturnType<typeof setInterval> | null = null;
    let sseFailures = 0;

    const startPolling = () => {
      if (pollingTimer || disposed) return;
      pollingTimer = setInterval(() => {
        if (activeScanRef.current !== selectedScanId || (statusRef.current && TERMINAL_STATUSES.includes(statusRef.current))) {
          if (pollingTimer) clearInterval(pollingTimer);
          pollingTimer = null;
          return;
        }
        fetchScanSnapshot(selectedScanId);
      }, 800);
    };

    const startLiveUpdates = () => {
      if (disposed || activeScanRef.current !== selectedScanId) return;

      let receivedData = false;
      const url = `${API_BASE}/api/scans/${selectedScanId}/events?after_id=${resultCursorRef.current}`;
      source = new EventSource(url);

      source.addEventListener('snapshot', (event) => {
        if (disposed || activeScanRef.current !== selectedScanId) return;
        receivedData = true;
        sseFailures = 0;

        try {
          const data = JSON.parse((event as MessageEvent).data);
          const scan: Scan = data.scan;
          setCurrentScan(scan);
          statusRef.current = scan.status;
          mergeResults(data.results || []);
          resultCursorRef.current = data.cursor || resultCursorRef.current;
          setResultHasMore(Boolean(data.has_more));
          setResultSummary(data.summary || EMPTY_SUMMARY);
          fetchScans();
          if (TERMINAL_STATUSES.includes(scan.status)) source?.close();
        } catch (e) {
          console.error('Failed to parse SSE snapshot', e);
        }
      });

      source.onerror = () => {
        source?.close();
        source = null;
        if (disposed || activeScanRef.current !== selectedScanId) return;

        if (statusRef.current && TERMINAL_STATUSES.includes(statusRef.current)) {
          return;
        }

        if (receivedData) {
          setTimeout(() => {
            if (activeScanRef.current === selectedScanId && !disposed) {
              startLiveUpdates();
            }
          }, 1000);
        } else {
          sseFailures++;
          if (sseFailures >= 2) {
            console.warn('EventSource failed. Falling back to polling.');
            startPolling();
          } else {
            setTimeout(() => {
              if (activeScanRef.current === selectedScanId && !disposed) {
                startLiveUpdates();
              }
            }, 1000);
          }
        }
      };
    };

    fetchScanSnapshot(selectedScanId, true).then((scan) => {
      if (!disposed && scan && !TERMINAL_STATUSES.includes(scan.status)) startLiveUpdates();
    });

    return () => {
      disposed = true;
      source?.close();
      if (pollingTimer) clearInterval(pollingTimer);
    };
  }, [fetchScanSnapshot, fetchScans, mergeResults, selectedScanId, backendOnline]);

  const applyPreset = (presetId: string) => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    setNewPreset(preset.id);
    setNewDictionary(preset.dictionary);
    setNewThreads(preset.threads);
    setNewTimeout(preset.timeout);
  };

  const handleAction = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!selectedScanId) return;
    try {
      const response = await fetch(`${API_BASE}/api/scans/${selectedScanId}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error || '未知错误');
      const scan = await response.json();
      setCurrentScan(scan);
      statusRef.current = scan.status;
      fetchScans();
    } catch (error) {
      alert(`操作失败: ${error instanceof Error ? error.message : '网络异常'}`);
    }
  };

  const handleRetry = async () => {
    if (!selectedScanId) return;
    try {
      const response = await fetch(`${API_BASE}/api/scans/${selectedScanId}/retry`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error || '重试失败');
      const scan: Scan = await response.json();
      setScans((current) => [scan, ...current.filter((item) => item.id !== scan.id)]);
      inheritHistoryFolderForScan(scan);
      setSelectedScanId(scan.id);
      setViewMode('detail');
    } catch (error) {
      alert(error instanceof Error ? error.message : '重试失败');
    }
  };

  const handleExport = async () => {
    if (!selectedScanId) return;
    try {
      const response = await fetch(`${API_BASE}/api/scans/${selectedScanId}/export.csv`);
      if (!response.ok) throw new Error('服务端返回错误');
      const text = await response.text();
      const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `seahare-scan-${selectedScanId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert(`导出 CSV 失败: ${error instanceof Error ? error.message : '网络异常'}`);
    }
  };

  // Count of {fuzz} placeholders in the target — every placeholder expands the
  // request count independently, so it must be part of the live estimate.
  const enumPlaceholders = useMemo(() => {
    let count = 0;
    let index = newTarget.indexOf(ENUM_PLACEHOLDER);
    while (index !== -1) {
      count += 1;
      index = newTarget.indexOf(ENUM_PLACEHOLDER, index + ENUM_PLACEHOLDER.length);
    }
    return count;
  }, [newTarget]);

  const enumCount = useMemo(() => {
    const cs = [...new Set(enumCharset.trim())].length;
    if (!cs || enumPlaceholders < 1) return 0;
    let total = 0;
    for (let n = Math.max(1, enumMinLen); n <= Math.min(enumMaxLen, ENUM_MAX_LEN); n++) {
      total += Math.pow(cs, n * enumPlaceholders);
    }
    return total;
  }, [enumCharset, enumMinLen, enumMaxLen, enumPlaceholders]);

  const clampEnumLen = (value: number) => Math.max(1, Math.min(ENUM_MAX_LEN, Number.isFinite(value) ? Math.trunc(value) : 1));

  const insertFuzzPlaceholder = () => {
    const input = targetInputRef.current;
    const start = input?.selectionStart ?? newTarget.length;
    const end = input?.selectionEnd ?? start;
    const nextTarget = `${newTarget.slice(0, start)}${ENUM_PLACEHOLDER}${newTarget.slice(end)}`;

    setNewTarget(nextTarget);
    requestAnimationFrame(() => {
      targetInputRef.current?.focus();
      const cursor = start + ENUM_PLACEHOLDER.length;
      targetInputRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const historyScanDisplayName = (scan: Scan) => historyScanNames[scan.id]
    || `${targetTypeText[scan.target_type] || scan.target_type}扫描`;

  const startHistoryScanRename = (scan: Scan) => {
    setEditingHistoryScanId(scan.id);
    setHistoryScanEditName(historyScanDisplayName(scan));
  };

  const cancelHistoryScanRename = () => {
    setEditingHistoryScanId(null);
    setHistoryScanEditName('');
  };

  const saveHistoryScanRename = (event: React.FormEvent<HTMLFormElement>, scanId: string) => {
    event.preventDefault();
    const name = historyScanEditName.trim();
    if (!name) return;
    setHistoryScanNames((current) => ({ ...current, [scanId]: name }));
    cancelHistoryScanRename();
  };

  const deleteHistoryScan = async (scan: Scan) => {
    if (!window.confirm(`删除扫描任务“${historyScanDisplayName(scan)}”？扫描结果也会被删除。`)) return;
    try {
      const response = await fetch(`${API_BASE}/api/scans/${scan.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || '删除扫描任务失败');
      setScans((current) => current.filter((item) => item.id !== scan.id));
      setHistoryFolders((current) => removeHistoryScanIds(current, new Set([scan.id])));
      setHistoryScanNames((current) => {
        const next = { ...current };
        delete next[scan.id];
        return next;
      });
      if (selectedScanId === scan.id) {
        setSelectedScanId(null);
        setCurrentScan(null);
        setViewMode('detail');
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '删除扫描任务失败');
    }
  };

  const historyHostDisplayName = (group: HistoryHostGroup) => historyHostNames[group.key] || group.label;

  const startHistoryHostRename = (group: HistoryHostGroup) => {
    setEditingHistoryHostKey(group.key);
    setHistoryHostEditName(historyHostDisplayName(group));
  };

  const cancelHistoryHostRename = () => {
    setEditingHistoryHostKey(null);
    setHistoryHostEditName('');
  };

  const saveHistoryHostRename = (event: React.FormEvent<HTMLFormElement>, hostKey: string) => {
    event.preventDefault();
    const name = historyHostEditName.trim();
    if (!name) return;
    setHistoryHostNames((current) => ({ ...current, [hostKey]: name }));
    cancelHistoryHostRename();
  };

  const deleteHistoryHostGroup = async (group: HistoryHostGroup) => {
    const groupScans = group.targets.flatMap((target) => target.scans);
    if (groupScans.some((scan) => !TERMINAL_STATUSES.includes(scan.status))) {
      alert('该主机下存在进行中的扫描，请先取消扫描后再删除。');
      return;
    }
    if (!window.confirm(`删除主机分组“${historyHostDisplayName(group)}”下的 ${groupScans.length} 个扫描任务？扫描结果也会被删除。`)) return;

    const deletedIds: string[] = [];
    const applyDeletedScans = (scanIds: string[]) => {
      const ids = new Set(scanIds);
      setScans((current) => current.filter((scan) => !ids.has(scan.id)));
      setHistoryFolders((current) => removeHistoryScanIds(current, ids));
      setHistoryScanNames((current) => {
        const next = { ...current };
        ids.forEach((id) => delete next[id]);
        return next;
      });
      if (selectedScanId && ids.has(selectedScanId)) {
        setSelectedScanId(null);
        setCurrentScan(null);
        setViewMode('detail');
      }
    };

    try {
      for (const scan of groupScans) {
        const response = await fetch(`${API_BASE}/api/scans/${scan.id}`, { method: 'DELETE' });
        if (!response.ok) {
          let message = '删除主机分组失败';
          try {
            const payload = await response.json() as { error?: string };
            message = payload.error || message;
          } catch {
            // Use the fallback message when the server response is not JSON.
          }
          throw new Error(message);
        }
        deletedIds.push(scan.id);
      }
      applyDeletedScans(deletedIds);
      setHistoryHostNames((current) => {
        const next = { ...current };
        delete next[group.key];
        return next;
      });
    } catch (error) {
      applyDeletedScans(deletedIds);
      alert(error instanceof Error ? error.message : '删除主机分组失败');
    }
  };

  const enumCountHint = enumCount > 0
    ? (enumCount > ENUM_MAX_WORDS
      ? `${enumPlaceholders} 个占位符 · 将生成 ${enumCount.toLocaleString()} 个请求，超过上限 ${ENUM_MAX_WORDS.toLocaleString()}，请缩小字符集或长度`
      : `${enumPlaceholders} 个占位符 · 将生成 ${enumCount.toLocaleString()} 个请求`)
    : (enumPlaceholders < 1 ? '目标 URL 中需要包含 {fuzz} 占位符' : '请输入非空字符集');

  const headerErrorMessage = useMemo(() => {
    const seen = new Set<string>();
    for (const row of newHeaders) {
      const name = row.key.trim();
      if (!name && !row.value.trim()) continue;
      if (!name) return '请求头名称不能为空';
      if (/[\r\n]/.test(name) || /[\r\n]/.test(row.value)) return '请求头不能包含换行符';
      const lower = name.toLowerCase();
      if (seen.has(lower)) return `请求头 ${name} 重复`;
      seen.add(lower);
    }
    return null;
  }, [newHeaders]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    let target = newTarget.trim();
    if (!target) return setFormError('请输入目标 URL');
    if (scanMode === 'enum' && !target.includes(ENUM_PLACEHOLDER)) {
      return setFormError(`目标 URL 中需要包含占位符 ${ENUM_PLACEHOLDER}`);
    }
    if (!target.startsWith('http://') && !target.startsWith('https://')) target = `http://${target}`;
    try {
      new URL(target);
    } catch {
      return setFormError('请输入合法的 HTTP 或 HTTPS URL');
    }
    if (newBody.trim() && newMethod !== 'AUTO' && !METHODS_WITH_BODY.includes(newMethod)) {
      return setFormError(`${newMethod} 请求不支持携带请求体，请改用 POST/PUT/PATCH/DELETE`);
    }
    if (headerErrorMessage) return setFormError(headerErrorMessage);

    const requestHeaders = Object.fromEntries(
      newHeaders
        .map((row) => [row.key.trim(), row.value] as const)
        .filter(([name]) => name),
    );

    let body: Record<string, unknown>;
    if (scanMode === 'enum') {
      const charset = enumCharset.trim();
      if (!charset) return setFormError('请输入字符集');
      if (enumMinLen < 1 || enumMaxLen < enumMinLen || enumMaxLen > ENUM_MAX_LEN) {
        return setFormError(`长度需满足 1 ≤ 最小长度 ≤ 最大长度 ≤ ${ENUM_MAX_LEN}`);
      }
      if (enumCount > ENUM_MAX_WORDS) {
        return setFormError(`组合数 ${enumCount.toLocaleString()} 超过上限 ${ENUM_MAX_WORDS.toLocaleString()}`);
      }
      body = {
        target, preset: newPreset, threads: newThreads, timeout: newTimeout,
        target_type: newTargetType, request_method: newMethod,
        request_headers: requestHeaders, request_body: newBody,
        enum: { charset: [...new Set(charset)].join(''), min_len: enumMinLen, max_len: enumMaxLen },
      };
    } else {
      if (!newDictionary) return setFormError('请选择字典文件');
      body = {
        target, preset: newPreset, dictionary: newDictionary,
        threads: newThreads, timeout: newTimeout,
        target_type: newTargetType, request_method: newMethod,
        request_headers: requestHeaders, request_body: newBody,
      };
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.json()).error || '创建扫描任务失败');
      const scan: Scan = await response.json();
      const customName = newScanName.trim() || createDefaultScanName(target, scans);
      setHistoryScanNames((current) => ({ ...current, [scan.id]: customName }));
      setScans((current) => [scan, ...current]);
      inheritHistoryFolderForScan(scan);
      setSelectedScanId(scan.id);
      closeCreateModal();
      setNewScanName('');
      setNewTarget('');
      setNewHeaders([]);
      setNewBody('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '无法连接到后端服务');
    } finally {
      setSubmitting(false);
    }
  };

  const loadDictionaryFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.txt')) {
      setDictionaryError('请选择 .txt 字典文件');
      return;
    }
    try {
      const content = await file.text();
      setDictionaryName(file.name);
      setDictionaryContent(content);
      setDictionaryError(null);
    } catch {
      setDictionaryError('读取文件失败，请重试');
    }
  };

  const handleDictionaryDrop = (event: React.DragEvent) => {
    const file = event.dataTransfer.files?.[0];
    if (file) loadDictionaryFile(file);
  };

  const handleFilePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) loadDictionaryFile(file);
    event.target.value = '';
  };

  const handleDictionaryCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setDictionaryError(null);
    setDictionarySaving(true);
    try {
      const response = await fetch(`${API_BASE}/api/dictionaries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dictionaryName.trim(), content: dictionaryContent }),
      });
      if (!response.ok) throw new Error((await response.json()).error || '字典保存失败');
      await fetchDictionaries();
      setNewDictionary(dictionaryName.trim());
      setNewPreset('custom');
      setDictionaryName('');
      setDictionaryContent('');
    } catch (error) {
      setDictionaryError(error instanceof Error ? error.message : '字典保存失败');
    } finally {
      setDictionarySaving(false);
    }
  };

  const handleDictionaryDelete = async (item: DictionaryItem) => {
    if (item.builtin || !window.confirm(`删除自定义字典 ${item.name}？`)) return;
    try {
      const response = await fetch(`${API_BASE}/api/dictionaries/${encodeURIComponent(item.name)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error || '删除失败');
      await fetchDictionaries();
    } catch (error) {
      setDictionaryError(error instanceof Error ? error.message : '删除失败');
    }
  };

  const filteredResults = scanResults.filter((result) => {
    if (filter === 'interesting' && !(result.status < 300 || [401, 403, 500].includes(result.status))) return false;
    if (filter === 'redirect' && !(result.status >= 300 && result.status < 400)) return false;
    if (severityFilter !== 'all' && result.severity !== severityFilter) return false;
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return result.path.toLowerCase().includes(query)
      || result.url.toLowerCase().includes(query)
      || result.status.toString().includes(query)
      || (result.content_type || '').toLowerCase().includes(query)
      || (result.redirect_location || '').toLowerCase().includes(query)
      || (result.category || '').toLowerCase().includes(query)
      || (result.business_message || '').toLowerCase().includes(query)
      || (result.response_preview || '').toLowerCase().includes(query);
  });

  const toggleResultExpanded = (id: number) => {
    setExpandedResultIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const hasResultEvidence = (result: ScanResult) =>
    Boolean(result.spa_fallback || result.business_code !== null && result.business_code !== undefined
      || result.business_message || result.response_preview || result.body_hash);

  const formatTime = (isoString: string | null) => {
    if (!isoString) return '-';
    try {
      const date = new Date(isoString);
      return `${date.toLocaleTimeString('zh-CN', { hour12: false })} ${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}`;
    } catch {
      return isoString;
    }
  };

  const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  const statusCodeClass = (code: number) => code < 300 ? 'status-2xx' : code < 400 ? 'status-3xx' : code < 500 ? 'status-4xx' : 'status-5xx';

  const renderHistoryScan = (scan: Scan) => (
    <div className="history-scan-row" key={scan.id}>
      {editingHistoryScanId === scan.id ? (
        <form className="history-scan-rename-form" onSubmit={(event) => saveHistoryScanRename(event, scan.id)}>
          <input
            autoFocus
            className="history-scan-rename-input"
            aria-label="扫描任务名称"
            value={historyScanEditName}
            onChange={(event) => setHistoryScanEditName(event.target.value)}
          />
          <button type="submit" className="history-scan-action" title="保存重命名" aria-label="保存重命名"><Check size={12} /></button>
          <button type="button" className="history-scan-action" title="取消重命名" aria-label="取消重命名" onClick={cancelHistoryScanRename}><X size={12} /></button>
        </form>
      ) : (
        <>
      <button
      type="button"
      className={`history-item history-scan-item ${selectedScanId === scan.id ? 'active' : ''}`}
      draggable
      onDragStart={(event) => handleHistoryDragStart(event, [scan.id])}
      onClick={() => {
        setSelectedScanId(scan.id);
        setViewMode('detail');
      }}
      aria-current={selectedScanId === scan.id ? 'true' : undefined}
      role="treeitem"
    >
      <FileText className="history-leaf-icon" size={12} />
      <span className="history-scan-info">
        <span className="history-item-header">
          <span className="history-item-target" title={`${historyScanDisplayName(scan)} ${scan.target}`}>
            {historyScanDisplayName(scan)}
          </span>
          <span className={`history-item-badge badge-${scan.status}`}>{getStatusText(scan.status)}</span>
        </span>
        <span className="history-item-meta"><span>发现 {scan.found}</span><span>{formatTime(scan.created_at)}</span></span>
      </span>
      </button>
      <div className="history-scan-actions">
        <button type="button" className="history-scan-action" title={`重命名扫描任务 ${historyScanDisplayName(scan)}`} aria-label={`重命名扫描任务 ${historyScanDisplayName(scan)}`} onClick={() => startHistoryScanRename(scan)}><Pencil size={12} /></button>
        <button type="button" className="history-scan-action danger" title={`删除扫描任务 ${historyScanDisplayName(scan)}`} aria-label={`删除扫描任务 ${historyScanDisplayName(scan)}`} onClick={() => deleteHistoryScan(scan)}><Trash2 size={12} /></button>
      </div>
        </>
      )}
    </div>
  );

  const renderNestedHistoryFolder = (folder: HistoryFolder): React.ReactNode => {
    const folderExpanded = expandedHistoryFolders.has(folder.id);
    const isAutoHostFolder = folder.id.startsWith('auto-host-');
    const isAutoTargetFolder = folder.id.startsWith('auto-target-');
    const folderScans = folder.scanIds
      .map((scanId) => scans.find((scan) => scan.id === scanId))
      .filter((scan): scan is Scan => Boolean(scan));
    const itemCount = folder.children.length + folderScans.length;
    return (
      <div
        className={`history-folder-group history-nested-folder ${dragOverHistoryFolderId === folder.id ? 'drag-over' : ''}`}
        key={folder.id}
        role="treeitem"
        aria-expanded={folderExpanded}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-seahare-history')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDragOverHistoryFolderId(folder.id);
          }
        }}
        onDragLeave={() => setDragOverHistoryFolderId(null)}
        onDrop={(event) => handleHistoryDrop(event, folder.id)}
      >
        <div className="history-tree-row history-custom-folder" title="拖动文件夹以移动全部扫描任务" draggable={editingHistoryFolderId !== folder.id} onDragStart={(event) => handleHistoryDragStart(event, collectHistoryFolderScanIds(folder), folder)}>
          {editingHistoryFolderId === folder.id ? (
            <form className="history-folder-rename-form" onSubmit={(event) => saveHistoryFolderRename(event, folder.id)} onClick={(event) => event.stopPropagation()}>
              <input autoFocus className="history-folder-rename-input" aria-label="文件夹名称" value={historyFolderEditName} onChange={(event) => setHistoryFolderEditName(event.target.value)} />
              <button type="submit" className="history-folder-action" title="保存重命名" aria-label="保存重命名"><Check size={12} /></button>
              <button type="button" className="history-folder-action" title="取消重命名" aria-label="取消重命名" onClick={cancelHistoryFolderRename}><X size={12} /></button>
            </form>
          ) : (
            <>
                <button type="button" className="history-folder-toggle" onClick={() => toggleHistoryFolder(folder.id)} aria-expanded={folderExpanded} aria-label={`${folderExpanded ? '收起' : '展开'}文件夹 ${folder.name}`}>
                  {folderExpanded ? <ChevronDown className="history-tree-chevron" size={12} /> : <ChevronRight className="history-tree-chevron" size={12} />}
                {isAutoHostFolder ? (
                  <Globe className="history-node-icon history-host-icon" size={14} aria-label="目标主机" />
                ) : isAutoTargetFolder ? (
                  <Route className="history-node-icon history-target-icon" size={14} aria-label="目标路径" />
                ) : folderExpanded ? (
                  <FolderOpen className={`history-node-icon ${isAutoTargetFolder ? 'history-target-icon' : ''}`} size={14} />
                ) : (
                  <Folder className={`history-node-icon ${isAutoTargetFolder ? 'history-target-icon' : ''}`} size={14} />
                )}
                <span className="history-host-label">{folder.name}</span>
                <span className="history-group-count">{itemCount}</span>
              </button>
              <div className="history-folder-actions">
                <button type="button" className="history-folder-action" title={`重命名文件夹 ${folder.name}`} aria-label={`重命名文件夹 ${folder.name}`} onClick={() => startHistoryFolderRename(folder)}><Pencil size={12} /></button>
                <button type="button" className="history-folder-action danger" title={`删除文件夹 ${folder.name}`} aria-label={`删除文件夹 ${folder.name}`} onClick={() => deleteHistoryFolder(folder)}><Trash2 size={12} /></button>
              </div>
            </>
          )}
        </div>
        {folderExpanded && itemCount > 0 && (
          <div className="history-folder-children" role="group">
            {folder.children.map(renderNestedHistoryFolder)}
            {folderScans.length > 0 && <div className="history-tree-leaves history-folder-leaves" role="group">{folderScans.map(renderHistoryScan)}</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="app-container">
        <header className="app-header">
          <div className="logo-section">
            <span className="logo-icon"><ShieldCheck size={14} /></span>
            <span className="logo-text">Seahare 海兔</span>
            <span className="logo-badge">V2.0</span>
          </div>
          <div className="header-actions">
            <button className="header-tool" onClick={() => setDictionaryOpen(true)} title="管理扫描字典">
              <BookMarked size={13} /><span>字典库</span>
            </button>
            <div ref={themeMenuRef} className="theme-picker">
              <button
                type="button"
                className="header-tool theme-toggle theme-picker-trigger"
                onClick={() => setThemeMenuOpen((current) => !current)}
                title="选择界面主题"
                aria-label="选择界面主题"
                aria-haspopup="listbox"
                aria-expanded={themeMenuOpen}
              >
                {theme === 'dark' ? <Moon size={13} /> : theme === 'light' ? <Sun size={13} /> : theme === 'glass' ? <Sparkles size={13} /> : <Palette size={13} />}
                <span>{themeOptions.find((option) => option.value === theme)?.label}</span>
                <ChevronDown size={11} className={`theme-picker-chevron ${themeMenuOpen ? 'open' : ''}`} />
              </button>
              {themeMenuOpen && (
                <div className="theme-picker-menu" role="listbox" aria-label="界面主题选项">
                  {themeOptions.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={`theme-picker-option ${theme === option.value ? 'selected' : ''}`}
                      role="option"
                      aria-selected={theme === option.value}
                      onClick={() => {
                        setTheme(option.value);
                        setThemeMenuOpen(false);
                      }}
                    >
                      <span className={`theme-option-icon theme-option-${option.value}`}>
                        {option.value === 'dark' ? <Moon size={13} /> : option.value === 'light' ? <Sun size={13} /> : option.value === 'glass' ? <Sparkles size={13} /> : <Palette size={13} />}
                      </span>
                      <span>{option.label}</span>
                      {theme === option.value && <Check size={13} className="theme-option-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className={`header-tool ${workspaceOpen ? 'active' : ''}`} onClick={() => setWorkspaceOpen((current) => !current)} title="浮动工作区 (Ctrl+Alt+A)" aria-pressed={workspaceOpen}>
              <TerminalSquare size={13} /><span>工作区</span>
            </button>
            <div className="status-indicator" role="status" aria-live="polite">
              <ShieldCheck size={11} className={`indicator-shield ${backendOnline ? 'online' : ''}`} />
              <span>{backendOnline ? '引擎已连接' : '引擎已断开'}</span>
            </div>
          </div>
        </header>

        {!backendOnline ? (
          <div className="offline-panel">
            <AlertCircle size={40} color="var(--color-danger)" />
            <h2 className="offline-title">无法连接至 Seahare 后端引擎</h2>
            <p className="offline-desc">请确认本机 8765 端口上的 Seahare 扫描服务已经启动。</p>
            <button className="btn-retry" onClick={checkHealth}><RefreshCw size={12} /><span>重新连接</span></button>
          </div>
        ) : (
          <div className="workspace">
            <aside className="pane-left" aria-label="任务历史">
              <div className="pane-left-header">
                <span className="sidebar-title project-title">Projects <span className="project-count">{scans.length}</span></span>
                <div className="project-header-actions">
                  <button
                    type="button"
                    className={`history-toolbar-button ${historyFilterOpen ? 'active' : ''}`}
                    onClick={() => setHistoryFilterOpen((current) => !current)}
                    title="项目过滤筛选"
                    aria-label="项目过滤筛选"
                    aria-expanded={historyFilterOpen}
                  >
                    <ListFilter size={14} />
                    {historyProjectFilter !== 'all' && <span className="history-filter-badge">1</span>}
                  </button>
                  <button
                    type="button"
                    className="history-toolbar-button"
                    onClick={handleAddHistoryFolder}
                    title="添加文件夹"
                    aria-label="添加文件夹"
                  >
                    <FolderPlus size={14} />
                  </button>
                  <button
                    ref={newScanButtonRef}
                    type="button"
                    className={`history-toolbar-button history-toolbar-primary ${viewMode === 'create' ? 'active' : ''}`}
                    onClick={handleNewScanClick}
                    title="添加任务"
                    aria-label="添加任务"
                    aria-pressed={viewMode === 'create'}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              {historyFilterOpen && (
                <div className="history-filter-panel" role="group" aria-label="项目过滤筛选">
                  <label className="history-project-select">
                    <ListFilter size={12} aria-hidden="true" />
                    <span className="sr-only">项目过滤筛选</span>
                    <select
                      aria-label="项目过滤筛选"
                      value={historyProjectFilter}
                      onChange={(event) => setHistoryProjectFilter(event.target.value)}
                    >
                      <option value="all">所有项目</option>
                      {historyGroups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
              {historyFolderDraftOpen && (
                <div className="history-toolbar" role="toolbar" aria-label="新建文件夹">
                  <form className="history-folder-form" onSubmit={handleSaveHistoryFolder}>
                    <input
                      autoFocus
                      className="history-folder-input"
                      aria-label="文件夹名称"
                      placeholder="文件夹名称"
                      value={historyFolderName}
                      onChange={(event) => setHistoryFolderName(event.target.value)}
                    />
                    <button type="submit" className="history-toolbar-button history-toolbar-primary" title="保存文件夹" aria-label="保存文件夹"><Check size={13} /></button>
                    <button type="button" className="history-toolbar-button" title="取消添加文件夹" aria-label="取消添加文件夹" onClick={() => setHistoryFolderDraftOpen(false)}><X size={13} /></button>
                  </form>
                </div>
              )}
              <div
                className="history-list-wrapper"
                onDragOver={handleHistoryBlankAreaDragOver}
                onDragLeave={(event) => {
                  if (event.target === event.currentTarget) setDragOverHistoryUnfiled(false);
                }}
                onDrop={handleHistoryDropToBlankArea}
              >
                {scans.length === 0 && historyFolders.length === 0 ? (
                  <div className="history-empty"><History size={20} /><span>暂无任务记录</span></div>
                ) : (
                  <div className="history-tree" role="tree" aria-label="按目标整理的任务历史">
                    <div
                      className={`history-unfiled-dropzone ${dragOverHistoryUnfiled ? 'drag-over' : ''}`}
                      role="treeitem"
                      title="拖到这里移出文件夹"
                      onDragOver={handleHistoryUnfiledDragOver}
                      onDragLeave={() => setDragOverHistoryUnfiled(false)}
                      onDrop={handleHistoryDropToUnfiled}
                    >
                      <ListChecks size={13} />
                      <span>全部任务</span>
                    </div>
                    {historyFolders.length > 0 && historyProjectFilter === 'all' && (
                      <div className="history-local-folders" role="group" aria-label="本地文件夹">
                        {historyFolders.map((folder) => {
                          const folderExpanded = expandedHistoryFolders.has(folder.id);
                          const folderScans = folder.scanIds
                            .map((scanId) => scans.find((scan) => scan.id === scanId))
                            .filter((scan): scan is Scan => Boolean(scan));
                          const folderItemCount = folder.children.length + folderScans.length;
                          return (
                            <div
                              className={`history-folder-group ${dragOverHistoryFolderId === folder.id ? 'drag-over' : ''}`}
                              key={folder.id}
                              role="treeitem"
                              aria-expanded={folderExpanded}
                              onDragOver={(event) => {
                                if (event.dataTransfer.types.includes('application/x-seahare-history')) {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = 'move';
                                  setDragOverHistoryFolderId(folder.id);
                                }
                              }}
                              onDragLeave={() => setDragOverHistoryFolderId(null)}
                              onDrop={(event) => handleHistoryDrop(event, folder.id)}
                            >
                              <div
                                className="history-tree-row history-custom-folder"
                                title="拖动文件夹以移动全部扫描任务"
                                draggable
                                onDragStart={(event) => handleHistoryDragStart(event, collectHistoryFolderScanIds(folder), folder)}
                              >
                                {editingHistoryFolderId === folder.id ? (
                                  <form className="history-folder-rename-form" onSubmit={(event) => saveHistoryFolderRename(event, folder.id)} onClick={(event) => event.stopPropagation()}>
                                    <input
                                      autoFocus
                                      className="history-folder-rename-input"
                                      aria-label="文件夹名称"
                                      value={historyFolderEditName}
                                      onChange={(event) => setHistoryFolderEditName(event.target.value)}
                                    />
                                    <button type="submit" className="history-folder-action" title="保存重命名" aria-label="保存重命名"><Check size={12} /></button>
                                    <button type="button" className="history-folder-action" title="取消重命名" aria-label="取消重命名" onClick={cancelHistoryFolderRename}><X size={12} /></button>
                                  </form>
                                ) : (
                                  <>
                                    <button type="button" className="history-folder-toggle" onClick={() => toggleHistoryFolder(folder.id)} aria-expanded={folderExpanded} aria-label={`${folderExpanded ? '收起' : '展开'}文件夹 ${folder.name}`}>
                                      {folderExpanded ? <ChevronDown className="history-tree-chevron" size={12} /> : <ChevronRight className="history-tree-chevron" size={12} />}
                                      {folderExpanded ? <FolderOpen className="history-node-icon" size={14} /> : <Folder className="history-node-icon" size={14} />}
                                      <span className="history-host-label">{folder.name}</span>
                                      <span className="history-group-count">{folderItemCount}</span>
                                    </button>
                                    <div className="history-folder-actions">
                                      <button type="button" className="history-folder-action" title={`重命名文件夹 ${folder.name}`} aria-label={`重命名文件夹 ${folder.name}`} onClick={() => startHistoryFolderRename(folder)}><Pencil size={12} /></button>
                                      <button type="button" className="history-folder-action danger" title={`删除文件夹 ${folder.name}`} aria-label={`删除文件夹 ${folder.name}`} onClick={() => deleteHistoryFolder(folder)}><Trash2 size={12} /></button>
                                    </div>
                                  </>
                                )}
                              </div>
                              {folderExpanded && folderItemCount > 0 && (
                                <div className="history-folder-children" role="group">
                                  {folder.children.map(renderNestedHistoryFolder)}
                                  {folderScans.length > 0 && <div className="history-tree-leaves history-folder-leaves" role="group">{folderScans.map(renderHistoryScan)}</div>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {filteredHistoryGroups.map((hostGroup) => {
                      const hostExpanded = expandedHistoryHosts.has(hostGroup.key);
                      const hostTaskCount = hostGroup.targets.reduce((total, target) => total + target.scans.length, 0);
                      return (
                        <div className="history-group" key={hostGroup.key} role="treeitem" aria-expanded={hostExpanded}>
                          <div
                            className={`history-tree-row history-host-row ${dragOverHistoryAutoKey === hostGroup.key ? 'drag-over' : ''}`}
                            draggable={editingHistoryHostKey !== hostGroup.key}
                            onDragStart={(event) => handleHistoryDragStart(event, hostGroup.targets.flatMap((target) => target.scans).map((scan) => scan.id), createAutoHostFolder(hostGroup))}
                            onDragOver={(event) => handleHistoryAutoDragOver(event, hostGroup.key)}
                            onDragLeave={() => setDragOverHistoryAutoKey(null)}
                            onDrop={(event) => handleHistoryDropToAuto(event)}
                          >
                            {editingHistoryHostKey === hostGroup.key ? (
                              <form className="history-folder-rename-form" onSubmit={(event) => saveHistoryHostRename(event, hostGroup.key)} onClick={(event) => event.stopPropagation()}>
                                <input autoFocus className="history-folder-rename-input" aria-label="主机分组名称" value={historyHostEditName} onChange={(event) => setHistoryHostEditName(event.target.value)} />
                                <button type="submit" className="history-folder-action" title="保存重命名" aria-label="保存重命名"><Check size={12} /></button>
                                <button type="button" className="history-folder-action" title="取消重命名" aria-label="取消重命名" onClick={cancelHistoryHostRename}><X size={12} /></button>
                              </form>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="history-folder-toggle"
                                  onClick={() => setExpandedHistoryHosts((previous) => {
                                    const next = new Set(previous);
                                    if (next.has(hostGroup.key)) next.delete(hostGroup.key); else next.add(hostGroup.key);
                                    return next;
                                  })}
                                  aria-expanded={hostExpanded}
                                  aria-label={`${hostExpanded ? '收起' : '展开'}扫描任务 ${historyHostDisplayName(hostGroup)}`}
                                  title={hostGroup.key}
                                >
                                  {hostExpanded ? <ChevronDown className="history-tree-chevron" size={12} /> : <ChevronRight className="history-tree-chevron" size={12} />}
                                  <Globe className="history-node-icon history-host-icon" size={14} aria-label="目标主机" />
                                  <span className="history-host-label">{historyHostDisplayName(hostGroup)}</span>
                                  <span className="history-group-count">{hostTaskCount}</span>
                                </button>
                                <div className="history-folder-actions">
                                  <button type="button" className="history-folder-action" title={`重命名主机分组 ${historyHostDisplayName(hostGroup)}`} aria-label={`重命名主机分组 ${historyHostDisplayName(hostGroup)}`} onClick={() => startHistoryHostRename(hostGroup)}><Pencil size={12} /></button>
                                  <button type="button" className="history-folder-action danger" title={`删除主机分组 ${historyHostDisplayName(hostGroup)}`} aria-label={`删除主机分组 ${historyHostDisplayName(hostGroup)}`} onClick={() => deleteHistoryHostGroup(hostGroup)}><Trash2 size={12} /></button>
                                </div>
                              </>
                            )}
                          </div>
                          {hostExpanded && (
                            <div className="history-tree-children" role="group">
                              {hostGroup.targets.map((targetGroup) => {
                                const targetExpanded = expandedHistoryTargets.has(targetGroup.key);
                                const targetLabel = targetGroup.path === '/' ? '根路径' : targetGroup.path;
                                return (
                                  <div className="history-target-group" key={targetGroup.key} role="treeitem" aria-expanded={targetExpanded}>
                                    <button
                                      type="button"
                                      className={`history-tree-row history-target-row ${dragOverHistoryAutoKey === targetGroup.key ? 'drag-over' : ''}`}
                                      draggable
                                      onDragStart={(event) => handleHistoryDragStart(event, targetGroup.scans.map((scan) => scan.id), createAutoTargetFolder(targetGroup))}
                                      onDragOver={(event) => handleHistoryAutoDragOver(event, targetGroup.key)}
                                      onDragLeave={() => setDragOverHistoryAutoKey(null)}
                                      onDrop={(event) => handleHistoryDropToAuto(event)}
                                      onClick={() => setExpandedHistoryTargets((previous) => {
                                        const next = new Set(previous);
                                        if (next.has(targetGroup.key)) next.delete(targetGroup.key); else next.add(targetGroup.key);
                                        return next;
                                      })}
                                      aria-expanded={targetExpanded}
                                      title={targetGroup.key}
                                    >
                                      {targetExpanded ? <ChevronDown className="history-tree-chevron" size={11} /> : <ChevronRight className="history-tree-chevron" size={11} />}
                                      <Route className="history-node-icon history-target-icon" size={13} aria-label="目标路径" />
                                      <span className="history-target-path">{targetLabel}</span>
                                      <span className="history-group-count">{targetGroup.scans.length}</span>
                                    </button>
                                    {targetExpanded && (
                                      <div className="history-tree-leaves" role="group">
                                        {targetGroup.scans.map(renderHistoryScan)}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            <main className="pane-middle" aria-label="扫描结果">
              {!selectedScanId ? (
                <div className="results-welcome-screen">
                  <ShieldCheck size={48} className="welcome-logo" />
                  <h3>Seahare 扫描工作台</h3>
                  <p>点击『新建扫描』配置并启动扫描，或从左侧选择历史任务。</p>
                </div>
              ) : (
                <>
                  <div className="results-toolbar">
                    <div className="filter-group" role="group" aria-label="结果类型筛选">
                      <button className={`btn-filter ${filter === 'all' ? 'active' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
                      <button className={`btn-filter ${filter === 'interesting' ? 'active' : ''}`} aria-pressed={filter === 'interesting'} onClick={() => setFilter('interesting')}>有效响应</button>
                      <button className={`btn-filter ${filter === 'redirect' ? 'active' : ''}`} aria-pressed={filter === 'redirect'} onClick={() => setFilter('redirect')}>重定向</button>
                    </div>
                    <div className="toolbar-actions">
                      <div className="search-container">
                        <span className="search-icon"><Search size={12} /></span>
                        <input className="search-input" aria-label="搜索扫描结果" placeholder="搜索路径、状态或类型" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
                      </div>
                      {!detailsPaneOpen && (
                        <button className="btn-pane-toggle" type="button" onClick={() => setDetailsPaneOpen(true)} title="展开扫描任务详情" aria-label="展开扫描任务详情">
                          <PanelRightOpen size={14} />
                        </button>
                      )}
                      <button className="btn-csv-export" onClick={handleExport} disabled={resultSummary.total === 0} title="导出 CSV">
                        <Download size={12} /><span>导出</span>
                      </button>
                    </div>
                  </div>

                  <div className="risk-strip" role="group" aria-label="风险级别筛选">
                    <button className={`risk-chip risk-all ${severityFilter === 'all' ? 'active' : ''}`} aria-pressed={severityFilter === 'all'} onClick={() => setSeverityFilter('all')}>
                      <span>全部</span><strong>{resultSummary.total}</strong>
                    </button>
                    {(['high', 'medium', 'low', 'info'] as const).map((severity) => (
                      <button key={severity} className={`risk-chip severity-${severity} ${severityFilter === severity ? 'active' : ''}`} aria-pressed={severityFilter === severity} onClick={() => setSeverityFilter(severity)}>
                        <span>{severityText[severity]}</span><strong>{resultSummary.severity[severity]}</strong>
                      </button>
                    ))}
                  </div>

                  <div className="table-wrapper">
                    {filteredResults.length === 0 ? (
                      <div className="results-empty">
                        {currentScan?.status === 'running' ? <Loader2 size={24} className="spinning" /> : <Info size={20} />}
                        <span>{currentScan?.status === 'running' ? '扫描进行中，等待新结果' : '当前筛选条件下没有结果'}</span>
                      </div>
                    ) : (
                      <table className="results-table">
                        <colgroup>
                          <col style={{ width: '180px' }} />
                          <col style={{ width: '72px' }} />
                          <col style={{ width: '70px' }} />
                          <col style={{ width: '70px' }} />
                          <col style={{ width: '90px' }} />
                          <col style={{ width: '170px' }} />
                          <col style={{ width: '170px' }} />
                          <col style={{ width: '75px' }} />
                          <col style={{ width: '125px' }} />
                          <col style={{ width: '80px' }} />
                          <col style={{ width: '130px' }} />
                        </colgroup>
                        <thead><tr><th>路径</th><th>方法</th><th>状态</th><th>风险</th><th>分类</th><th>业务/证据</th><th>重定向位置</th><th>大小</th><th>内容类型</th><th>延迟</th><th>发现时间</th></tr></thead>
                        <tbody>
                          {filteredResults.map((result, index) => {
                            const expanded = expandedResultIds.has(result.id);
                            const hasEvidence = hasResultEvidence(result);
                            return (
                              <Fragment key={result.id}>
                                <tr className={`result-row ${index % 2 === 1 ? 'row-striped' : ''} ${expanded ? 'row-expanded' : ''}`}>
                                  <td className="cell-path" title={result.path}>
                                    {hasEvidence && (
                                      <button
                                        type="button"
                                        className={`cell-expand ${expanded ? 'active' : ''}`}
                                        onClick={() => toggleResultExpanded(result.id)}
                                        title={expanded ? '收起证据详情' : '展开业务错误与响应证据'}
                                        aria-expanded={expanded}
                                        aria-label={`展开或收起 ${result.path} 的证据详情`}
                                      >
                                        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                      </button>
                                    )}
                                    <a className="cell-path-link" href={result.url} target="_blank" rel="noopener noreferrer" title="打开接口响应（JSON）" aria-label={`打开接口响应 ${result.path}`}>
                                      <span>{result.path}</span><ExternalLink size={10} />
                                    </a>
                                  </td>
                                  <td className="cell-method"><span className="method-badge">{result.request_method}</span></td>
                                  <td><span className={`status-code-badge ${statusCodeClass(result.status)}`}>{result.status}</span></td>
                                  <td><span className={`severity-badge severity-${result.severity || 'low'}`}>{severityText[result.severity || 'low']}</span></td>
                                  <td className="cell-category">
                                    <span>{categoryText[result.category] || result.category || '可访问'}</span>
                                    {result.spa_fallback && <span className="tag-badge tag-spa" title="响应与基线指纹一致，可能是 SPA 回退页而非真实目录">SPA</span>}
                                  </td>
                                  <td className="cell-business">
                                    {result.business_code !== null && result.business_code !== undefined && (
                                      <span className={`tag-badge tag-biz ${result.business_code !== 0 ? 'tag-biz-error' : ''}`} title="业务返回码">
                                        业务码 {result.business_code}
                                      </span>
                                    )}
                                    {result.business_message && (
                                      <span className="cell-business-message" title={result.business_message}>{result.business_message}</span>
                                    )}
                                    {!hasEvidence && <span className="cell-muted">-</span>}
                                  </td>
                                  <td className="cell-redirect" title={result.redirect_location || undefined}>{result.redirect_location || '-'}</td>
                                  <td className="cell-size">{result.length.toLocaleString()} B</td>
                                  <td className="cell-content-type">{result.content_type || '-'}</td>
                                  <td className="cell-time">{result.response_time} ms</td>
                                  <td className="cell-url">{formatTime(result.discovered_at)}</td>
                                </tr>
                                {expanded && (
                                  <tr className="evidence-row">
                                    <td colSpan={11}>
                                      <div className="evidence-grid">
                                        <div className="evidence-block">
                                          <div className="evidence-title">响应预览 <span className="evidence-hash">{result.body_hash ? `sha256:${result.body_hash}` : ''}</span></div>
                                          <pre className="evidence-preview">{result.response_preview || '（无响应体）'}</pre>
                                        </div>
                                        <div className="evidence-block">
                                          <div className="evidence-title">业务信息</div>
                                          <div className="evidence-facts">
                                            <span className="meta-label">业务码</span>
                                            <span className="meta-value">{result.business_code ?? '—'}</span>
                                            <span className="meta-label">业务消息</span>
                                            <span className="meta-value">{result.business_message || '—'}</span>
                                            <span className="meta-label">SPA 回退</span>
                                            <span className="meta-value">{result.spa_fallback ? '是（与基线指纹一致）' : '否'}</span>
                                          </div>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {resultHasMore && (
                      <button className="load-more" onClick={() => selectedScanId && fetchResultPage(selectedScanId)}>加载下一批结果</button>
                    )}
                  </div>
                </>
              )}
            </main>

            {viewMode === 'detail' && currentScan && (
              detailsPaneOpen && (
                <aside className="pane-right" aria-label="扫描任务详情">
                  <>
                  <div className="pane-right-header">
                    <div className="pane-right-title"><Info size={12} /><span>扫描任务详情</span></div>
                    <button className="pane-right-toggle" type="button" onClick={() => setDetailsPaneOpen(false)} title="收起扫描任务详情" aria-label="收起扫描任务详情">
                      <PanelRightClose size={14} />
                    </button>
                  </div>
                  <div className="pane-right-content">
                    <div>
                      <div className="section-title">任务配置</div>
                      <div className="detail-section"><div className="meta-grid">
                        <span className="meta-label">任务名称</span><span className="meta-value" title={historyScanDisplayName(currentScan)}>{historyScanDisplayName(currentScan)}</span>
                        <span className="meta-label">目标</span><span className="meta-value" title={currentScan.target}>{currentScan.target}</span>
                        <span className="meta-label">目标类型</span><span className="meta-value">{targetTypeText[currentScan.target_type] || currentScan.target_type}</span>
                        <span className="meta-label">请求方法</span><span className="meta-value">{currentScan.request_method}</span>
                        <span className="meta-label">策略</span><span className="meta-value">{presets.find((item) => item.id === currentScan.preset)?.name || '自定义'}</span>
                        <span className="meta-label">方式</span><span className="meta-value">{currentScan.mode === 'enum' ? '自定义枚举' : '字典扫描'}</span>
                        {currentScan.mode === 'enum' ? (
                          <>
                            <span className="meta-label">字符集</span><span className="meta-value" title={currentScan.charset}>{currentScan.charset}</span>
                            <span className="meta-label">长度</span><span className="meta-value">{currentScan.min_len} – {currentScan.max_len}</span>
                          </>
                        ) : (
                          <><span className="meta-label">字典</span><span className="meta-value">{currentScan.dictionary}</span></>
                        )}
                        <span className="meta-label">线程 / 超时</span><span className="meta-value">{currentScan.threads} / {currentScan.timeout}s</span>
                        <span className="meta-label">状态</span><span className={`meta-value status-${currentScan.status}`}>{getStatusText(currentScan.status)}</span>
                      </div></div>
                      {(Object.keys(currentScan.request_headers || {}).length > 0 || currentScan.request_body) && (
                        <div className="detail-section request-config-detail">
                          <div className="meta-grid">
                            {Object.keys(currentScan.request_headers || {}).length > 0 && (
                              <>
                                <span className="meta-label">请求头</span>
                                <span className="meta-value">
                                  {Object.entries(currentScan.request_headers).map(([name, value]) => (
                                    <span key={name} className="header-chip" title={`${name}: ${value}`}>{name}</span>
                                  ))}
                                </span>
                              </>
                            )}
                            {currentScan.request_body && (
                              <>
                                <span className="meta-label">请求体</span>
                                <span className="meta-value"><code className="body-snippet" title={currentScan.request_body}>{currentScan.request_body}</code></span>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="section-title">任务控制</div>
                      <div className="task-controls">
                        {currentScan.status === 'running' && <button className="btn-ctrl btn-pause" onClick={() => handleAction('pause')}><Pause size={11} /><span>暂停</span></button>}
                        {currentScan.status === 'paused' && <button className="btn-ctrl btn-resume" onClick={() => handleAction('resume')}><Play size={11} /><span>恢复</span></button>}
                        {['queued', 'running', 'paused'].includes(currentScan.status) && <button className="btn-ctrl btn-cancel" onClick={() => handleAction('cancel')}><Square size={11} /><span>停止</span></button>}
                        {TERMINAL_STATUSES.includes(currentScan.status) && <button className="btn-ctrl btn-retry-scan" onClick={handleRetry}><RotateCcw size={11} /><span>复制并重试</span></button>}
                      </div>
                    </div>

                    <div>
                      <div className="section-title">进度与统计</div>
                      <div className="detail-section">
                        <div className="progress-container">
                          <div className="progress-info"><span>完成度</span><span>{(currentScan.progress * 100).toFixed(1)}%</span></div>
                          <div className="progress-track" role="progressbar" aria-label="扫描完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(currentScan.progress * 100)}><div className={`progress-bar ${currentScan.status === 'running' ? 'pulsing' : ''}`} style={{ width: `${currentScan.progress * 100}%` }} /></div>
                        </div>
                        <div className="meta-grid stats-meta"><span className="meta-label">请求数</span><span className="meta-value">{currentScan.requests}</span><span className="meta-label">结果数</span><span className="meta-value result-count">{currentScan.found}</span></div>
                      </div>
                    </div>

                    {currentScan.error && <div className="results-error-banner" role="alert"><AlertCircle size={14} /><span>{currentScan.error}</span></div>}

                    <div>
                      <div className="section-title">时间线</div>
                      <div className="detail-section"><div className="meta-grid">
                        <span className="meta-label">创建</span><span className="meta-value">{formatTime(currentScan.created_at)}</span>
                        <span className="meta-label">开始</span><span className="meta-value">{formatTime(currentScan.started_at)}</span>
                        <span className="meta-label">结束</span><span className="meta-value">{formatTime(currentScan.finished_at)}</span>
                      </div></div>
                    </div>
                  </div>
                  </>
                </aside>
              )
            )}
          </div>
        )}
      </div>

      {createModalState !== 'closed' && createPortal(
        <div
          className={`create-scan-backdrop ${createModalActive ? 'active' : ''}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !submitting) closeCreateModal();
          }}
        >
          <section
            ref={createDialogRef}
            className={`create-scan-dialog ${createModalActive ? 'active' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-scan-title"
          >
            <header className="create-scan-header">
              <div><Plus size={15} /><strong id="create-scan-title">新建扫描任务</strong></div>
              <button type="button" onClick={closeCreateModal} disabled={submitting} title="关闭" aria-label="关闭新建扫描窗口"><X size={16} /></button>
            </header>
            <div className="create-scan-content">
              {formError && <div className="results-error-banner" role="alert"><AlertCircle size={14} /><span>{formError}</span></div>}
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label className="form-label" htmlFor="scan-name"><Pencil size={11} />任务名称</label>
                  <input
                    id="scan-name"
                    className="form-input"
                    placeholder={createDefaultScanName(newTarget, scans)}
                    value={newScanName}
                    onChange={(event) => setNewScanName(event.target.value)}
                    maxLength={80}
                    disabled={submitting}
                  />
                </div>
                <div className="form-group">
                  <div className="form-label" id="scan-mode-label"><Search size={11} />扫描方式</div>
                  <div className="preset-control" role="radiogroup" aria-labelledby="scan-mode-label">
                    <button type="button" role="radio" aria-checked={scanMode === 'dictionary'} className={scanMode === 'dictionary' ? 'active' : ''} onClick={() => setScanMode('dictionary')} title="使用词表文件中的路径">字典扫描</button>
                    <button type="button" role="radio" aria-checked={scanMode === 'enum'} className={scanMode === 'enum' ? 'active' : ''} onClick={() => setScanMode('enum')} title="按字符集与长度自动生成路径组合">自定义枚举</button>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-target"><Globe size={11} />目标 URL</label>
                  <div className={scanMode === 'enum' ? 'input-with-action target-input-row' : 'target-input-row'}>
                    <input
                      id="scan-target"
                      ref={targetInputRef}
                      className="form-input"
                      placeholder={scanMode === 'enum' ? `example.com/${ENUM_PLACEHOLDER} 或 http://172.22.90.186:8080/${ENUM_PLACEHOLDER}` : 'example.com 或 http://172.22.90.186:8080'}
                      value={newTarget}
                      onChange={(event) => setNewTarget(event.target.value)}
                      disabled={submitting}
                    />
                    {scanMode === 'enum' && (
                      <button
                        type="button"
                        aria-label="在光标处插入 {fuzz} 占位符"
                        title="在光标处插入 {fuzz} 占位符"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={insertFuzzPlaceholder}
                        disabled={submitting}
                      >
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {scanMode === 'enum' && (
                  <div className="form-group">
                    <div className="form-label" id="scan-enum-charset-label"><BookOpen size={11} />字符集</div>
                    <input
                      id="scan-enum-charset"
                      className="form-input"
                      aria-label="字符集"
                      placeholder="如 abcdefghijklmnopqrstuvwxyz0123456789"
                      value={enumCharset}
                      onChange={(event) => setEnumCharset(event.target.value)}
                      disabled={submitting}
                    />
                    <div className="enum-lengths">
                      <label className="enum-len-label" htmlFor="scan-enum-min">最小长度<input id="scan-enum-min" type="number" className="form-input enum-len" min="1" max={ENUM_MAX_LEN} value={enumMinLenStr} onChange={(event) => setEnumMinLenStr(event.target.value)} onBlur={(event) => setEnumMinLenStr(String(clampEnumLen(Number.parseInt(event.target.value, 10))))} disabled={submitting} /></label>
                      <span className="enum-range-sep">–</span>
                      <label className="enum-len-label" htmlFor="scan-enum-max">最大长度<input id="scan-enum-max" type="number" className="form-input enum-len" min="1" max={ENUM_MAX_LEN} value={enumMaxLenStr} onChange={(event) => setEnumMaxLenStr(event.target.value)} onBlur={(event) => setEnumMaxLenStr(String(clampEnumLen(Number.parseInt(event.target.value, 10))))} disabled={submitting} /></label>
                    </div>
                    <p className={`enum-count-hint ${enumCount > ENUM_MAX_WORDS ? 'over' : ''}`}>{enumCountHint}</p>
                  </div>
                )}

                <div className="form-group">
                  <div className="form-label" id="target-type-label"><Globe size={11} />目标类型</div>
                  <div className="preset-control" role="radiogroup" aria-labelledby="target-type-label" aria-describedby="target-type-description">
                    {TARGET_TYPES.map((type) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={newTargetType === type}
                        key={type}
                        className={newTargetType === type ? 'active' : ''}
                        onClick={() => setNewTargetType(type)}
                        title={{ web: '常规网站目录探测', api: 'JSON API 接口，识别业务错误码', h5: '单页应用 / H5，识别 SPA 回退' }[type]}
                      >
                        {targetTypeText[type]}
                      </button>
                    ))}
                  </div>
                  <div className="target-type-description" id="target-type-description" role="status">
                    <Info size={12} />
                    <span>{targetTypeDescription[newTargetType]}</span>
                  </div>
                  <div className="target-type-note">三种类型共用字典和请求方法；此选项主要用于结果解释，不会自动获取小程序包。</div>
                </div>

                <div className="form-group">
                  <div className="form-label" id="request-method-label"><ShieldAlert size={11} />请求方法</div>
                  <div className="preset-control method-control" role="radiogroup" aria-labelledby="request-method-label">
                    {REQUEST_METHODS.map((method) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={newMethod === method}
                        key={method}
                        className={newMethod === method ? 'active' : ''}
                        onClick={() => setNewMethod(method)}
                        title={method === 'AUTO' ? '自动尝试所有请求方法，并为带请求体的方法生成 JSON 参数' : undefined}
                      >
                        {method}
                      </button>
                    ))}
                  </div>
                  <div className="preset-description method-description">
                    {newMethod === 'AUTO' ? '自动尝试 7 种请求方法；带请求体的方法生成 JSON 参数，支持用模板覆盖' : `${newMethod} 请求`}
                  </div>
                </div>

                <div className="form-group">
                  <div className="form-label" id="request-headers-label"><TerminalSquare size={11} />请求头
                    <button type="button" className="form-inline-btn" onClick={() => setNewHeaders((rows) => [...rows, { key: '', value: '' }])} disabled={submitting}>
                      <Plus size={10} /><span>添加</span>
                    </button>
                  </div>
                  {newHeaders.length === 0 ? (
                    <p className="form-hint">可选。例如 Authorization、Cookie 或自定义业务头。</p>
                  ) : (
                    <div className="header-rows">
                      {newHeaders.map((row, index) => (
                        <div className="header-row" key={index}>
                          <input
                            className="form-input header-key"
                            aria-label={`请求头 ${index + 1} 名称`}
                            placeholder="Header 名称"
                            value={row.key}
                            onChange={(event) => setNewHeaders((rows) => rows.map((item, i) => i === index ? { ...item, key: event.target.value } : item))}
                            disabled={submitting}
                          />
                          <input
                            className="form-input header-value"
                            aria-label={`请求头 ${index + 1} 值`}
                            placeholder="值"
                            value={row.value}
                            onChange={(event) => setNewHeaders((rows) => rows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                            disabled={submitting}
                          />
                          <button
                            type="button"
                            className="header-remove"
                            onClick={() => setNewHeaders((rows) => rows.filter((_, i) => i !== index))}
                            title="删除该请求头"
                            aria-label={`删除请求头 ${row.key || index + 1}`}
                            disabled={submitting}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-body"><TerminalSquare size={11} />请求体</label>
                  <textarea
                    id="scan-body"
                    className="form-input body-textarea"
                    placeholder={newMethod === 'GET' ? 'GET 请求通常无需请求体；如需测试 POST 请选择对应方法' : `JSON 请求体，支持 ${ENUM_PLACEHOLDER} 占位符，如 {"username":"${ENUM_PLACEHOLDER}"}`}
                    value={newBody}
                    onChange={(event) => setNewBody(event.target.value)}
                    rows={3}
                    disabled={submitting}
                  />
                  <p className="form-hint">未指定 Content-Type 时请求体默认按 application/json 发送；{ENUM_PLACEHOLDER} 会被替换为当前字典或枚举值。</p>
                </div>

                <div className="form-group">
                  <div className="form-label" id="scan-preset-label"><Gauge size={11} />扫描策略</div>
                  <div className="preset-control" role="radiogroup" aria-labelledby="scan-preset-label">
                    {presets.map((preset) => (
                      <button type="button" role="radio" aria-checked={newPreset === preset.id} key={preset.id} className={newPreset === preset.id ? 'active' : ''} onClick={() => applyPreset(preset.id)} title={preset.description}>
                        {preset.name.replace('扫描', '').replace('探测', '')}
                      </button>
                    ))}
                  </div>
                  <div className="preset-description">{newPreset === 'custom' ? '自定义参数' : presets.find((item) => item.id === newPreset)?.description}</div>
                </div>

                {scanMode === 'dictionary' && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="scan-dictionary"><BookOpen size={11} />扫描字典 <span className="form-label-hint">建议选择自定义字典</span></label>
                    <div className="input-with-action">
                      <select id="scan-dictionary" className="form-input" value={newDictionary} onChange={(event) => { setNewDictionary(event.target.value); setNewPreset('custom'); }} disabled={submitting}>
                        {dictionaryItems.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.entries})</option>)}
                      </select>
                      <button type="button" onClick={() => setDictionaryOpen(true)} title="管理字典"><BookMarked size={13} /></button>
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-threads"><Cpu size={11} />线程数 <strong>{newThreads}</strong></label>
                  <div className="range-container"><input id="scan-threads" type="range" className="range-slider" min="1" max="128" value={newThreads} style={{ '--fill': rangeFill(newThreads, 1, 128) } as React.CSSProperties} aria-valuetext={`${newThreads} 个线程`} onChange={(event) => { setNewThreads(Number(event.target.value)); setNewPreset('custom'); }} disabled={submitting} /></div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-timeout"><Clock size={11} />超时 <strong>{newTimeout}s</strong></label>
                  <div className="range-container"><input id="scan-timeout" type="range" className="range-slider" min="1" max="60" value={newTimeout} style={{ '--fill': rangeFill(newTimeout, 1, 60) } as React.CSSProperties} aria-valuetext={`${newTimeout} 秒`} onChange={(event) => { setNewTimeout(Number(event.target.value)); setNewPreset('custom'); }} disabled={submitting} /></div>
                </div>

                <button type="submit" className="btn-submit" disabled={submitting}>
                  {submitting ? <><Loader2 size={12} className="spinning" /><span>启动中</span></> : <><Play size={12} fill="currentColor" /><span>启动扫描</span></>}
                </button>
                <p className="scope-note"><ShieldAlert size={12} />仅扫描已获得明确授权的目标。</p>
              </form>
            </div>
          </section>
        </div>,
        document.body,
      )}

      <FloatingWorkspace ref={workspaceRef} open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />

      {dictionaryOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDictionaryOpen(false); }}>
          <section ref={dictionaryDialogRef} className="dictionary-dialog" role="dialog" aria-modal="true" aria-labelledby="dictionary-dialog-title">
            <header className="dialog-header"><div><BookMarked size={16} /><strong id="dictionary-dialog-title">扫描字典库</strong><span>{dictionaryItems.length} 个字典</span></div><button onClick={() => setDictionaryOpen(false)} title="关闭" aria-label="关闭字典库"><X size={16} /></button></header>
            <div className="dictionary-layout">
              <div className="dictionary-list" aria-label="可用扫描字典">
                {dictionaryItems.map((item) => (
                  <div className="dictionary-row" key={item.name}>
                    <BookOpen size={15} />
                    <div><strong>{item.name}</strong><span>{item.entries} 条路径 · {formatBytes(item.size)}</span></div>
                    <span className={`dictionary-kind ${item.builtin ? 'builtin' : ''}`}>{item.builtin ? '内置' : '自定义'}</span>
                    <button disabled={item.builtin} onClick={() => handleDictionaryDelete(item)} title={item.builtin ? '内置字典不可删除' : '删除字典'} aria-label={item.builtin ? `${item.name} 是内置字典，不可删除` : `删除字典 ${item.name}`}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <form
                className="dictionary-form"
                onSubmit={handleDictionaryCreate}
                onDragOver={(event) => { event.preventDefault(); setDictionaryDrag(true); }}
                onDragLeave={(event) => { if (event.currentTarget === event.target) setDictionaryDrag(false); }}
                onDrop={(event) => { event.preventDefault(); setDictionaryDrag(false); handleDictionaryDrop(event); }}
              >
                <h3>新建自定义字典</h3>
                <div
                  className={`dictionary-pick ${dictionaryDrag ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => dictionaryFileInputRef.current?.click()}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dictionaryFileInputRef.current?.click(); } }}
                  title="拖入或点击选择 .txt 文件"
                >
                  {dictionaryDrag ? '松开以导入 .txt 文件' : '拖入 .txt 文件，或点击选择文件'}
                </div>
                <input ref={dictionaryFileInputRef} type="file" accept=".txt" style={{ display: 'none' }} onChange={handleFilePick} />
                <label>文件名<input className="form-input" placeholder="my-paths.txt" value={dictionaryName} onChange={(event) => setDictionaryName(event.target.value)} /></label>
                <label>路径内容<textarea className="form-input" placeholder={'admin\napi/health\nbackup.zip'} value={dictionaryContent} onChange={(event) => setDictionaryContent(event.target.value)} /></label>
                {dictionaryError && <div className="results-error-banner" role="alert"><AlertCircle size={13} /><span>{dictionaryError}</span></div>}
                <button className="btn-submit" disabled={dictionarySaving}>{dictionarySaving ? <Loader2 size={13} className="spinning" /> : <Plus size={13} />}<span>保存字典</span></button>
              </form>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
