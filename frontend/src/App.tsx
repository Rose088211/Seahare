import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookMarked,
  BookOpen,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  History,
  Info,
  Loader2,
  Pause,
  Play,
  Plus,
  Moon,
  RefreshCw,
  RotateCcw,
  Search,
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

interface Scan {
  id: string;
  target: string;
  dictionary: string;
  threads: number;
  timeout: number;
  preset: string;
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

interface ScanResult {
  id: number;
  scan_id: string;
  path: string;
  url: string;
  status: number;
  severity: Exclude<Severity, 'all'>;
  category: string;
  redirect_location: string;
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
};

const rangeFill = (value: number, min: number, max: number) =>
  `${Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))}%`;

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
  const [newPreset, setNewPreset] = useState('balanced');
  const [newDictionary, setNewDictionary] = useState('common.txt');
  const [newThreads, setNewThreads] = useState(8);
  const [newTimeout, setNewTimeout] = useState(10);
  const [scanMode, setScanMode] = useState<'dictionary' | 'enum'>('dictionary');
  const [enumCharset, setEnumCharset] = useState(ENUM_DEFAULT_CHARSET);
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

  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryName, setDictionaryName] = useState('');
  const [dictionaryContent, setDictionaryContent] = useState('');
  const [dictionaryError, setDictionaryError] = useState<string | null>(null);
  const [dictionarySaving, setDictionarySaving] = useState(false);
  const [dictionaryDrag, setDictionaryDrag] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const workspaceRef = useRef<FloatingWorkspaceHandle>(null);

  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('seahare-theme') as 'dark' | 'light') || 'dark');

  useEffect(() => {
    document.documentElement.classList.toggle('light-theme', theme === 'light');
    localStorage.setItem('seahare-theme', theme);
  }, [theme]);

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

  const enumCountHint = enumCount > 0
    ? (enumCount > ENUM_MAX_WORDS
      ? `${enumPlaceholders} 个占位符 · 将生成 ${enumCount.toLocaleString()} 个请求，超过上限 ${ENUM_MAX_WORDS.toLocaleString()}，请缩小字符集或长度`
      : `${enumPlaceholders} 个占位符 · 将生成 ${enumCount.toLocaleString()} 个请求`)
    : (enumPlaceholders < 1 ? '目标 URL 中需要包含 {fuzz} 占位符' : '请输入非空字符集');

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
        enum: { charset: [...new Set(charset)].join(''), min_len: enumMinLen, max_len: enumMaxLen },
      };
    } else {
      if (!newDictionary) return setFormError('请选择字典文件');
      body = {
        target, preset: newPreset, dictionary: newDictionary,
        threads: newThreads, timeout: newTimeout,
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
      setScans((current) => [scan, ...current]);
      setSelectedScanId(scan.id);
      closeCreateModal();
      setNewTarget('');
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
      || (result.category || '').toLowerCase().includes(query);
  });

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
            <button className="header-tool theme-toggle" onClick={() => setTheme((t) => t === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? '切换为白天模式' : '切换为夜晚模式'}>
              {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            </button>
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
                <span className="sidebar-title">任务历史 ({scans.length})</span>
                <button
                  ref={newScanButtonRef}
                  className={`btn-new-task ${viewMode === 'create' ? 'active' : ''}`}
                  onClick={handleNewScanClick}
                  title="新建扫描"
                  aria-pressed={viewMode === 'create'}
                >
                  <Plus size={12} /><span>新建扫描</span>
                </button>
              </div>
              <div className="history-list-wrapper">
                {scans.length === 0 ? (
                  <div className="history-empty"><History size={20} /><span>暂无任务记录</span></div>
                ) : scans.map((scan) => (
                  <button
                    type="button"
                    key={scan.id}
                    className={`history-item ${selectedScanId === scan.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedScanId(scan.id);
                      setViewMode('detail');
                    }}
                    aria-current={selectedScanId === scan.id ? 'true' : undefined}
                  >
                    <div className="history-item-header">
                      <span className="history-item-target" title={scan.target}>{scan.target.replace(/^https?:\/\//, '')}</span>
                      <span className={`history-item-badge badge-${scan.status}`}>{getStatusText(scan.status)}</span>
                    </div>
                    <div className="history-item-meta"><span>发现 {scan.found}</span><span>{formatTime(scan.created_at)}</span></div>
                  </button>
                ))}
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
                        <thead><tr><th>路径</th><th>状态</th><th>风险</th><th>分类</th><th>重定向位置</th><th>大小</th><th>内容类型</th><th>延迟</th><th>发现时间</th></tr></thead>
                        <tbody>
                          {filteredResults.map((result) => (
                            <tr key={result.id}>
                              <td className="cell-path" title={result.path}>
                                <a className="cell-path-link" href={result.url} target="_blank" rel="noopener noreferrer" title="打开接口响应（JSON）" aria-label={`打开接口响应 ${result.path}`}>
                                  <span>{result.path}</span><ExternalLink size={10} />
                                </a>
                              </td>
                              <td><span className={`status-code-badge ${statusCodeClass(result.status)}`}>{result.status}</span></td>
                              <td><span className={`severity-badge severity-${result.severity || 'low'}`}>{severityText[result.severity || 'low']}</span></td>
                              <td className="cell-category">{categoryText[result.category] || result.category || '可访问'}</td>
                              <td className="cell-redirect" title={result.redirect_location || undefined}>{result.redirect_location || '-'}</td>
                              <td className="cell-size">{result.length.toLocaleString()} B</td>
                              <td className="cell-content-type">{result.content_type || '-'}</td>
                              <td className="cell-time">{result.response_time} ms</td>
                              <td className="cell-url">{formatTime(result.discovered_at)}</td>
                            </tr>
                          ))}
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
              <aside className="pane-right" aria-label="扫描任务详情">
                <>
                  <div className="pane-right-header"><Info size={12} /><span>扫描任务详情</span></div>
                  <div className="pane-right-content">
                    <div>
                      <div className="section-title">任务配置</div>
                      <div className="detail-section"><div className="meta-grid">
                        <span className="meta-label">目标</span><span className="meta-value" title={currentScan.target}>{currentScan.target}</span>
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
                  <div className="form-label" id="scan-mode-label"><Search size={11} />扫描方式</div>
                  <div className="preset-control" role="radiogroup" aria-labelledby="scan-mode-label">
                    <button type="button" role="radio" aria-checked={scanMode === 'dictionary'} className={scanMode === 'dictionary' ? 'active' : ''} onClick={() => setScanMode('dictionary')} title="使用词表文件中的路径">字典扫描</button>
                    <button type="button" role="radio" aria-checked={scanMode === 'enum'} className={scanMode === 'enum' ? 'active' : ''} onClick={() => setScanMode('enum')} title="按字符集与长度自动生成路径组合">自定义枚举</button>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="scan-target"><Globe size={11} />目标 URL</label>
                  <input
                    id="scan-target"
                    ref={targetInputRef}
                    className="form-input"
                    placeholder={scanMode === 'enum' ? `example.com/${ENUM_PLACEHOLDER} 或 http://127.0.0.1/${ENUM_PLACEHOLDER}` : 'example.com 或 http://127.0.0.1'}
                    value={newTarget}
                    onChange={(event) => setNewTarget(event.target.value)}
                    disabled={submitting}
                  />
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

                {scanMode === 'dictionary' ? (
                  <div className="form-group">
                    <label className="form-label" htmlFor="scan-dictionary"><BookOpen size={11} />扫描字典 <span className="form-label-hint">建议选择自定义字典</span></label>
                    <div className="input-with-action">
                      <select id="scan-dictionary" className="form-input" value={newDictionary} onChange={(event) => { setNewDictionary(event.target.value); setNewPreset('custom'); }} disabled={submitting}>
                        {dictionaryItems.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.entries})</option>)}
                      </select>
                      <button type="button" onClick={() => setDictionaryOpen(true)} title="管理字典"><BookMarked size={13} /></button>
                    </div>
                  </div>
                ) : (
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
