import type { Connect, PluginOption, PreviewServer, ViteDevServer } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

function createHandler(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/boards/')) {
      next();
      return;
    }

    try {
      const url = new URL(req.url, 'http://localhost');
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
