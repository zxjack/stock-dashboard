import type { Connect, PluginOption, PreviewServer, ViteDevServer } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { StockSDK } from 'stock-sdk';

const execFileAsync = promisify(execFile);

const SINA_BASE = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php';
const SINA_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://vip.stock.finance.sina.com.cn/moneyflow/',
};

const LIST_TTL_MS = 30_000;
const DETAIL_TTL_MS = 15_000;
const KLINE_TTL_MS = 10 * 60_000;

type BoardKind = 'industry' | 'concept';

type BoardItem = {
  rank: number;
  name: string;
  code: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  totalMarketCap: number | null;
  turnoverRate: number | null;
  riseCount: number | null;
  fallCount: number | null;
  leadingStock: string | null;
  leadingStockChangePercent: number | null;
  amount?: number | null;
  netAmount?: number | null;
  thsCode?: string | null;
  thsName?: string | null;
  sourceCategory?: string;
};

type BoardConstituent = {
  rank: number;
  code: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  change: number | null;
  volume: number | null;
  amount: number | null;
  amplitude: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  prevClose: number | null;
  turnoverRate: number | null;
  pe: number | null;
  pb: number | null;
};

type BoardSpot = {
  item: string;
  value: number | null;
};

type BoardKline = {
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  changePercent: number | null;
  change: number | null;
  volume: number | null;
  amount: number | null;
  amplitude: number | null;
  turnoverRate: number | null;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const cache = new Map<string, CacheEntry<unknown>>();
const sdk = new StockSDK();

const MONITOR_RULES_PATH = '/Users/zxjack/.openclaw/workspace/agents/invest/portfolio/board_anomaly_rules.json';
const MONITOR_STATE_PATH = '/Users/zxjack/.openclaw/workspace/agents/invest/research/pipeline/board_anomaly_state.json';
const INVEST_WATCHLIST_PATH = '/Users/zxjack/.openclaw/workspace/agents/invest/portfolio/watchlist.json';
const WATCHLIST_GROUPS_PATH = '/Users/zxjack/.openclaw/workspace/agents/invest/portfolio/watchlist_groups.json';

type MonitorPushRecord = {
  signature: string;
  sentAt: string;
};

type WatchlistGroup = {
  id: string;
  name: string;
  codes: string[];
  createdAt: number;
  updatedAt: number;
};

function getCache<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setCache<T>(key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctFromUnit(value: unknown): number | null {
  const n = parseNumber(value);
  return n === null ? null : n * 100;
}

function toDateString(value: string): string {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function json(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function fetchSinaJson(path: string, params: Record<string, string | number>): Promise<any[]> {
  const url = new URL(`${SINA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const response = await fetch(url, { headers: SINA_HEADERS });
  if (!response.ok) {
    throw new Error(`Sina API ${path} failed: ${response.status}`);
  }
  const text = await response.text();
  return JSON.parse(text);
}

async function fetchAkshareNameMap(kind: BoardKind): Promise<Map<string, { name: string; code: string }>> {
  const cacheKey = `akshare:name-map:${kind}`;
  const cached = getCache<Map<string, { name: string; code: string }>>(cacheKey);
  if (cached) return cached;

  const python = `
import akshare as ak, json, sys
kind = sys.argv[1]
if kind == 'industry':
    df = ak.stock_board_industry_name_ths()
else:
    df = ak.stock_board_concept_name_ths()
rows = df.to_dict(orient='records')
print(json.dumps(rows, ensure_ascii=False))
`.trim();

  const { stdout } = await execFileAsync('python3', ['-c', python, kind], {
    maxBuffer: 1024 * 1024 * 8,
  });
  const rows = JSON.parse(stdout) as Array<{ name: string; code: string }>;
  const map = new Map(rows.map((item) => [item.name, item]));
  return setCache(cacheKey, map, 60 * 60_000);
}

async function fetchBoardList(kind: BoardKind): Promise<BoardItem[]> {
  const cacheKey = `boards:list:${kind}`;
  const cached = getCache<BoardItem[]>(cacheKey);
  if (cached) return cached;

  const fenlei = kind === 'industry' ? 0 : 1;
  const rows = await fetchSinaJson('/MoneyFlow.ssl_bkzj_bk', {
    page: 1,
    num: 120,
    sort: 'avg_changeratio',
    asc: 0,
    fenlei,
  });
  const akMap = await fetchAkshareNameMap(kind);

  const list = rows.map((row, index) => {
    const matched = akMap.get(row.name) ?? null;
    return {
      rank: index + 1,
      name: row.name,
      code: row.category,
      price: parseNumber(row.avg_price),
      change: null,
      changePercent: pctFromUnit(row.avg_changeratio),
      totalMarketCap: parseNumber(row.amount) !== null ? parseNumber(row.amount)! / 10000 : null,
      turnoverRate: parseNumber(row.turnover),
      riseCount: null,
      fallCount: null,
      leadingStock: row.ts_name ?? null,
      leadingStockChangePercent: pctFromUnit(row.ts_changeratio),
      amount: parseNumber(row.amount),
      netAmount: parseNumber(row.netamount),
      thsCode: matched?.code ?? null,
      thsName: matched?.name ?? null,
      sourceCategory: row.category,
    } satisfies BoardItem;
  });

  return setCache(cacheKey, list, LIST_TTL_MS);
}

async function fetchBoardConstituents(kind: BoardKind, code: string): Promise<BoardConstituent[]> {
  const cacheKey = `boards:constituents:${kind}:${code}`;
  const cached = getCache<BoardConstituent[]>(cacheKey);
  if (cached) return cached;

  const rows = await fetchSinaJson('/MoneyFlow.ssl_bkzj_ssggzj', {
    page: 1,
    num: 80,
    sort: 'changeratio',
    asc: 0,
    bankuai: code,
  });

  const list = rows.map((row, index) => ({
    rank: index + 1,
    code: row.symbol,
    name: row.name,
    price: parseNumber(row.trade),
    changePercent: pctFromUnit(row.changeratio),
    change: null,
    volume: null,
    amount: parseNumber(row.amount),
    amplitude: null,
    high: null,
    low: null,
    open: null,
    prevClose: null,
    turnoverRate: parseNumber(row.turnover),
    pe: null,
    pb: null,
  } satisfies BoardConstituent));

  return setCache(cacheKey, list, DETAIL_TTL_MS);
}

async function fetchBoardSpot(kind: BoardKind, code: string): Promise<BoardSpot[]> {
  const cacheKey = `boards:spot:${kind}:${code}`;
  const cached = getCache<BoardSpot[]>(cacheKey);
  if (cached) return cached;

  const list = await fetchBoardList(kind);
  const item = list.find((entry) => entry.code === code);
  if (!item) return [];

  const spot: BoardSpot[] = [
    { item: '板块均价', value: item.price },
    { item: '涨跌幅', value: item.changePercent },
    { item: '换手率', value: item.turnoverRate },
    { item: '成交额', value: item.amount ?? null },
    { item: '净流入', value: item.netAmount ?? null },
  ];

  return setCache(cacheKey, spot, DETAIL_TTL_MS);
}

async function fetchBoardKline(kind: BoardKind, code: string, period: string): Promise<BoardKline[]> {
  const cacheKey = `boards:kline:${kind}:${code}:${period}`;
  const cached = getCache<BoardKline[]>(cacheKey);
  if (cached) return cached;

  const list = await fetchBoardList(kind);
  const item = list.find((entry) => entry.code === code);
  if (!item?.thsName) return [];

  const python = `
import akshare as ak, json, sys
kind, symbol = sys.argv[1], sys.argv[2]
if kind == 'industry':
    df = ak.stock_board_industry_index_ths(symbol=symbol, start_date='20240101', end_date='20300101')
else:
    df = ak.stock_board_concept_index_ths(symbol=symbol, start_date='20240101', end_date='20300101')
df = df.tail(180).copy()
rows = []
for _, row in df.iterrows():
    open_v = row.get('开盘价')
    close_v = row.get('收盘价')
    high_v = row.get('最高价')
    low_v = row.get('最低价')
    rows.append({
        'date': str(row.get('日期')),
        'open': None if open_v is None else float(open_v),
        'close': None if close_v is None else float(close_v),
        'high': None if high_v is None else float(high_v),
        'low': None if low_v is None else float(low_v),
        'changePercent': None,
        'change': None,
        'volume': None,
        'amount': None,
        'amplitude': None,
        'turnoverRate': None,
    })
print(json.dumps(rows, ensure_ascii=False))
`.trim();

  const { stdout } = await execFileAsync('python3', ['-c', python, kind, item.thsName], {
    maxBuffer: 1024 * 1024 * 8,
  });

  const rows = JSON.parse(stdout) as BoardKline[];
  const normalized = rows.map((row, index) => {
    const prev = index > 0 ? rows[index - 1] : null;
    const close = parseNumber(row.close);
    const prevClose = prev ? parseNumber(prev.close) : null;
    const change = close !== null && prevClose !== null ? close - prevClose : null;
    const changePercent = close !== null && prevClose ? ((close - prevClose) / prevClose) * 100 : null;
    return {
      ...row,
      date: toDateString(String(row.date)),
      open: parseNumber(row.open),
      close,
      high: parseNumber(row.high),
      low: parseNumber(row.low),
      change,
      changePercent,
      volume: parseNumber(row.volume),
      amount: parseNumber(row.amount),
      amplitude: parseNumber(row.amplitude),
      turnoverRate: parseNumber(row.turnoverRate),
    } satisfies BoardKline;
  });

  return setCache(cacheKey, normalized, KLINE_TTL_MS);
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(path.substring(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function toPushRecords(sentSignatures: Record<string, string>): MonitorPushRecord[] {
  return Object.entries(sentSignatures)
    .map(([signature, sentAt]) => ({ signature, sentAt }))
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
}

async function getMonitorRules() {
  const rules = await readJsonFile<Record<string, unknown>>(MONITOR_RULES_PATH, {} as Record<string, unknown>);
  return {
    enabled: rules.enabled ?? true,
    api_base: rules.api_base ?? 'http://192.168.0.134:4175/api/boards',
    cooldown_minutes: rules.cooldown_minutes ?? 45,
    fetch_top_n: rules.fetch_top_n ?? 25,
    max_push_items: rules.max_push_items ?? 6,
    kinds: rules.kinds ?? {
      industry: {
        enabled: true,
        change_pct_abs: 2.8,
        turnover_rate_min: 1.2,
        leading_stock_change_pct_abs: 4.5,
        watchlist_hit_bonus: true,
      },
      concept: {
        enabled: true,
        change_pct_abs: 3.3,
        turnover_rate_min: 1.5,
        leading_stock_change_pct_abs: 5,
        watchlist_hit_bonus: true,
      },
    },
    watchlist_monitor: rules.watchlist_monitor ?? {
      enabled: true,
      strategies: [],
      stock_bindings: {},
    },
  };
}

async function getMonitorPushRecords(limit = 50): Promise<MonitorPushRecord[]> {
  const state = await readJsonFile<{ sent_signatures?: Record<string, string> }>(MONITOR_STATE_PATH, {});
  const signatures = state.sent_signatures ?? {};
  return toPushRecords(signatures).slice(0, limit);
}

function normalizePoolCode(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';

  // 已带市场前缀的代码优先处理，避免重复前缀
  if (/^(hk)\.?\d{5}$/i.test(raw)) {
    const n = raw.replace(/^hk\.?/i, '');
    return `hk${n}`;
  }
  if (/^(sh|sz|bj)\.?\d{6}$/i.test(raw)) {
    const m = raw.match(/^(sh|sz|bj)\.?(\d{6})$/i);
    if (m) return `${m[1].toLowerCase()}${m[2]}`;
  }
  if (/^us\.?[A-Za-z][A-Za-z0-9.\-]*$/i.test(raw)) {
    return `us${raw.replace(/^us\.?/i, '').toUpperCase()}`;
  }

  // 港股：09992 -> hk09992
  if (/^\d{5}$/.test(raw)) return `hk${raw}`;

  // A股：301392 -> sz301392; 600000 -> sh600000; 830000 -> bj830000
  if (/^\d{6}$/.test(raw)) {
    if (raw.startsWith('6')) return `sh${raw}`;
    if (raw.startsWith('0') || raw.startsWith('3')) return `sz${raw}`;
    if (raw.startsWith('4') || raw.startsWith('8')) return `bj${raw}`;
  }

  // 美股：NVDA -> usNVDA
  if (/^[A-Za-z][A-Za-z0-9.\-]*$/.test(raw)) {
    return `us${raw.toUpperCase()}`;
  }

  return raw.toLowerCase();
}

function defaultWatchlistGroups(now = Date.now()): WatchlistGroup[] {
  return [
    {
      id: 'default',
      name: '默认分组',
      codes: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function sanitizeWatchlistGroups(input: unknown): WatchlistGroup[] {
  const now = Date.now();
  const arr = Array.isArray(input) ? input : [];
  const groups: WatchlistGroup[] = arr
    .map((item, index) => {
      const obj = (item && typeof item === 'object') ? (item as Record<string, unknown>) : {};
      const idRaw = String(obj.id ?? '').trim();
      const id = idRaw || (index === 0 ? 'default' : `group_${now}_${index}`);
      const name = String(obj.name ?? (id === 'default' ? '默认分组' : `分组${index + 1}`)).trim() || '未命名分组';
      const codes = Array.from(
        new Set(
          (Array.isArray(obj.codes) ? obj.codes : [])
            .map((x) => normalizePoolCode(String(x)))
            .filter(Boolean)
        )
      );
      const createdAt = Number(obj.createdAt) || now;
      const updatedAt = Number(obj.updatedAt) || now;
      return { id, name, codes, createdAt, updatedAt };
    })
    .filter((g) => !!g.id);

  if (!groups.some((g) => g.id === 'default')) {
    groups.unshift({ id: 'default', name: '默认分组', codes: [], createdAt: now, updatedAt: now });
  }

  return groups.length > 0 ? groups : defaultWatchlistGroups(now);
}

async function getWatchlistGroupsFromBackend(): Promise<WatchlistGroup[]> {
  const stored = await readJsonFile<WatchlistGroup[] | { groups?: unknown }>(WATCHLIST_GROUPS_PATH, defaultWatchlistGroups());
  let groups: WatchlistGroup[];
  if (Array.isArray(stored)) {
    groups = sanitizeWatchlistGroups(stored);
  } else if (stored && typeof stored === 'object' && Array.isArray((stored as any).groups)) {
    groups = sanitizeWatchlistGroups((stored as any).groups);
  } else {
    groups = defaultWatchlistGroups();
  }

  const hasAnyCodes = groups.some((g) => Array.isArray(g.codes) && g.codes.length > 0);
  if (hasAnyCodes) return groups;

  // 兼容旧数据：watchlist_groups 为空时，从 invest 旧股票池回填一次
  const legacyPool = await getInvestWatchlistPool();
  if (legacyPool.codes.length > 0) {
    const now = Date.now();
    const migrated = sanitizeWatchlistGroups([
      {
        id: 'default',
        name: '默认分组',
        codes: legacyPool.codes,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await writeJsonFile(WATCHLIST_GROUPS_PATH, migrated);
    return migrated;
  }

  return groups;
}

async function saveWatchlistGroupsToBackend(groups: WatchlistGroup[]): Promise<WatchlistGroup[]> {
  const sanitized = sanitizeWatchlistGroups(groups);
  await writeJsonFile(WATCHLIST_GROUPS_PATH, sanitized);
  return sanitized;
}

async function getInvestWatchlistPool() {
  const data = await readJsonFile<Record<string, unknown>>(INVEST_WATCHLIST_PATH, {} as Record<string, unknown>);
  const result = {
    updatedAt: String(data._updated ?? ''),
    groups: {
      A股: Array.isArray(data['A股']) ? data['A股'] : [],
      港股: Array.isArray(data['港股']) ? data['港股'] : [],
      美股: Array.isArray(data['美股']) ? data['美股'] : [],
    },
    codes: [] as string[],
  };

  const allRaw = [
    ...(result.groups['A股'] as string[]),
    ...(result.groups['港股'] as string[]),
    ...(result.groups['美股'] as string[]),
  ];

  result.codes = Array.from(new Set(allRaw.map((x) => normalizePoolCode(String(x))).filter(Boolean)));
  return result;
}

async function getWatchlistQuotes(codes: string[]) {
  const normalized = Array.from(new Set((codes || []).map((x) => normalizePoolCode(String(x))).filter(Boolean)));
  if (normalized.length === 0) return [];
  const cacheKey = `monitor:quotes:${normalized.join(',')}`;
  const hit = getCache<any[]>(cacheKey);
  if (hit) return hit;

  const mapped = await Promise.all(
    normalized.map(async (reqCode) => {
      try {
        const arr = await sdk.getAllQuotesByCodes([reqCode]);
        const q: any = Array.isArray(arr) ? arr[0] : null;
        const nameRaw = String(q?.name || '').trim();
        return {
          code: reqCode.toUpperCase(),
          name: nameRaw || reqCode.toUpperCase(),
          price: parseNumber(q?.price),
          changePercent: parseNumber(q?.changePercent),
          amount: parseNumber(q?.amount),
          turnoverRate: parseNumber(q?.turnoverRate),
          totalMarketCap: parseNumber(q?.totalMarketCap),
        };
      } catch {
        return {
          code: reqCode.toUpperCase(),
          name: reqCode.toUpperCase(),
          price: null,
          changePercent: null,
          amount: null,
          turnoverRate: null,
          totalMarketCap: null,
        };
      }
    })
  );

  return setCache(cacheKey, mapped, DETAIL_TTL_MS);
}

async function updateMonitorRules(payload: Record<string, unknown>) {
  const prev = await readJsonFile<Record<string, unknown>>(MONITOR_RULES_PATH, {} as Record<string, unknown>);
  const next = {
    enabled: payload.enabled ?? prev.enabled ?? true,
    api_base: payload.api_base ?? prev.api_base ?? 'http://192.168.0.134:4175/api/boards',
    cooldown_minutes: payload.cooldown_minutes ?? prev.cooldown_minutes ?? 45,
    fetch_top_n: payload.fetch_top_n ?? prev.fetch_top_n ?? 25,
    max_push_items: payload.max_push_items ?? prev.max_push_items ?? 6,
    kinds: payload.kinds ?? prev.kinds ?? {},
    watchlist_monitor:
      payload.watchlist_monitor ??
      prev.watchlist_monitor ?? {
        enabled: true,
        strategies: [],
        stock_bindings: {},
      },
  };
  await writeJsonFile(MONITOR_RULES_PATH, next);
  return next;
}

function createHandler(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/')) {
      next();
      return;
    }

    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api/watchlist/groups' && req.method === 'GET') {
        json(res, 200, await getWatchlistGroupsFromBackend());
        return;
      }

      if (url.pathname === '/api/watchlist/groups' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '[]') as unknown;
            const groups = Array.isArray(body)
              ? body
              : (body && typeof body === 'object' && Array.isArray((body as any).groups))
                ? (body as any).groups
                : [];
            const saved = await saveWatchlistGroupsToBackend(groups);
            json(res, 200, { ok: true, groups: saved });
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        });
        return;
      }

      if (url.pathname === '/api/monitor/rules' && req.method === 'GET') {
        json(res, 200, await getMonitorRules());
        return;
      }

      if (url.pathname === '/api/monitor/rules' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') as Record<string, unknown>;
            const saved = await updateMonitorRules(body);
            json(res, 200, { ok: true, rules: saved });
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        });
        return;
      }

      if (url.pathname === '/api/monitor/push-records' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? '50');
        json(res, 200, await getMonitorPushRecords(Number.isFinite(limit) ? limit : 50));
        return;
      }

      if (url.pathname === '/api/monitor/watchlist' && req.method === 'GET') {
        json(res, 200, await getInvestWatchlistPool());
        return;
      }

      if (url.pathname === '/api/monitor/watchlist/quotes' && req.method === 'GET') {
        const codesRaw = (url.searchParams.get('codes') || '').trim();
        const codes = codesRaw ? codesRaw.split(',').map((x) => x.trim()).filter(Boolean) : [];
        json(res, 200, await getWatchlistQuotes(codes));
        return;
      }

      if (!url.pathname.startsWith('/api/boards/')) {
        next();
        return;
      }

      const parts = url.pathname.split('/').filter(Boolean);
      const kind = parts[2] as BoardKind;
      const action = parts[3];

      if (!['industry', 'concept'].includes(kind)) {
        json(res, 400, { error: 'invalid board kind' });
        return;
      }

      if (action === 'list') {
        json(res, 200, await fetchBoardList(kind));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        json(res, 400, { error: 'missing code' });
        return;
      }

      if (action === 'constituents') {
        json(res, 200, await fetchBoardConstituents(kind, code));
        return;
      }

      if (action === 'spot') {
        json(res, 200, await fetchBoardSpot(kind, code));
        return;
      }

      if (action === 'kline') {
        json(res, 200, await fetchBoardKline(kind, code, url.searchParams.get('period') ?? 'daily'));
        return;
      }

      json(res, 404, { error: 'unknown board api action' });
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function attach(server: Pick<ViteDevServer, 'middlewares'> | Pick<PreviewServer, 'middlewares'>) {
  server.middlewares.use(createHandler());
}

export function boardApiPlugin(): PluginOption {
  return {
    name: 'stock-dashboard-board-api',
    configureServer(server) {
      attach(server);
    },
    configurePreviewServer(server) {
      attach(server);
    },
  };
}
