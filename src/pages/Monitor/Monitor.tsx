import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Button, Loading, useToast } from '@/components/common';
import { normalizeStockCode } from '@/utils/format';
import styles from './Monitor.module.css';

type MonitorStrategy = {
  id: string;
  condition: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

type WatchlistMonitorConfig = {
  enabled: boolean;
  strategies: MonitorStrategy[];
  stock_bindings: Record<string, string>; // code -> strategyId
};

type MonitorRules = {
  enabled: boolean;
  watchlist_monitor: WatchlistMonitorConfig;
  [key: string]: unknown;
};

type WatchlistItem = {
  code: string;
  name: string;
};

const defaultRules: MonitorRules = {
  enabled: true,
  watchlist_monitor: {
    enabled: true,
    strategies: [],
    stock_bindings: {},
  },
};

const MONITOR_UI_VERSION = 'monitor-v2-20260312-1848';

async function fetchRules(): Promise<MonitorRules> {
  const resp = await fetch('/api/monitor/rules');
  if (!resp.ok) throw new Error(`读取规则失败: ${resp.status}`);
  const data = (await resp.json()) as MonitorRules;
  return {
    ...defaultRules,
    ...data,
    watchlist_monitor: {
      ...defaultRules.watchlist_monitor,
      ...(data.watchlist_monitor || {}),
      strategies: Array.isArray(data.watchlist_monitor?.strategies)
        ? data.watchlist_monitor.strategies
        : [],
      stock_bindings: data.watchlist_monitor?.stock_bindings || {},
    },
  };
}

async function saveRules(rules: MonitorRules): Promise<void> {
  const resp = await fetch('/api/monitor/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rules),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) {
    throw new Error(json.error || `保存失败: ${resp.status}`);
  }
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function Monitor() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [rules, setRules] = useState<MonitorRules>(defaultRules);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());

  const [conditionInput, setConditionInput] = useState('');
  const [applyStrategyId, setApplyStrategyId] = useState('');
  const [detailCode, setDetailCode] = useState<string | null>(null);
  const savingRef = useRef(false);

  const strategies = rules.watchlist_monitor.strategies;
  const bindings = rules.watchlist_monitor.stock_bindings;

  const strategyMap = useMemo(() => {
    const map = new Map<string, MonitorStrategy>();
    strategies.forEach((s) => map.set(s.id, s));
    return map;
  }, [strategies]);

  const resolvedBindings = useMemo(() => {
    const map: Record<string, string> = {};
    Object.entries(bindings).forEach(([code, sid]) => {
      if (!sid) return;
      const raw = String(code || '');
      const rawUpper = raw.toUpperCase();
      const normalized = normalizeStockCode(raw).toUpperCase();
      map[raw] = sid;
      map[rawUpper] = sid;
      if (normalized) map[normalized] = sid;
    });
    return map;
  }, [bindings]);

  const monitoredItems = useMemo(() => {
    return watchlistItems
      .map((item) => {
        const normalizedCode = normalizeStockCode(item.code).toUpperCase();
        const strategyId =
          resolvedBindings[item.code] ||
          resolvedBindings[item.code.toUpperCase()] ||
          (normalizedCode ? resolvedBindings[normalizedCode] : '') ||
          '';
        if (!strategyId) return null;
        const strategy = strategyMap.get(strategyId);
        if (!strategy) return null;
        return {
          code: item.code,
          name: item.name,
          strategyId,
          strategyCondition: strategy.condition,
          strategyEnabled: strategy.enabled,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [watchlistItems, resolvedBindings, strategyMap]);

  const detailItem = useMemo(() => {
    if (!detailCode) return null;
    return monitoredItems.find((x) => x.code === detailCode) || null;
  }, [detailCode, monitoredItems]);

  const allSelected = useMemo(() => {
    return watchlistItems.length > 0 && selectedCodes.size === watchlistItems.length;
  }, [watchlistItems.length, selectedCodes]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const loadedRules = await fetchRules();
        setRules(loadedRules);

        const watchlistResp = await fetch('/api/monitor/watchlist');
        if (!watchlistResp.ok) throw new Error(`读取后端股票池失败: ${watchlistResp.status}`);
        const watchlistData = (await watchlistResp.json()) as { codes?: string[] };
        const codes = unique(Array.isArray(watchlistData.codes) ? watchlistData.codes : []);
        if (codes.length === 0) {
          setWatchlistItems([]);
          setSelectedCodes(new Set());
          return;
        }

        const quoteResp = await fetch(`/api/monitor/watchlist/quotes?codes=${encodeURIComponent(codes.join(','))}`);
        if (!quoteResp.ok) throw new Error(`读取后端行情失败: ${quoteResp.status}`);
        const quotes = (await quoteResp.json()) as Array<{ code?: string; name?: string }>;

        const nameMap = new Map<string, string>();
        quotes.forEach((q) => {
          const code = String(q?.code || '').toUpperCase();
          const name = String(q?.name || '').trim();
          if (!code) return;
          if (name) nameMap.set(code, name);
          const normalized = normalizeStockCode(code).toUpperCase();
          if (normalized && name) nameMap.set(normalized, name);
        });

        const items = codes.map((code) => ({
          code,
          name: nameMap.get(code.toUpperCase()) || code,
        }));

        setWatchlistItems(items);
        setSelectedCodes(new Set(codes));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '加载监控配置失败');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [toast]);

  const persistRules = async (nextRules: MonitorRules, successText = '监控配置已保存') => {
    if (savingRef.current) {
      throw new Error('正在保存中，请稍后再试');
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await saveRules(nextRules);
      setRules(nextRules);
      toast.success(successText);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败';
      toast.error(message);
      throw error;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSaveAll = async () => {
    try {
      await persistRules(rules);
    } catch {
      // no-op: toast already shown
    }
  };

  const handleCreateStrategy = async () => {
    const condition = conditionInput.trim();
    if (!condition) {
      toast.info('请先输入监控条件');
      return;
    }

    const now = Date.now();
    const strategy: MonitorStrategy = {
      id: `strategy_${now}`,
      condition,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    const nextRules: MonitorRules = {
      ...rules,
      watchlist_monitor: {
        ...rules.watchlist_monitor,
        strategies: [strategy, ...rules.watchlist_monitor.strategies],
      },
    };

    try {
      await persistRules(nextRules, '策略已创建并保存');
      setApplyStrategyId(strategy.id);
      setConditionInput('');
    } catch {
      // no-op: toast already shown
    }
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedCodes(new Set());
      return;
    }
    setSelectedCodes(new Set(watchlistItems.map((x) => x.code)));
  };

  const toggleSelectCode = (code: string) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const applyStrategyToSelected = async () => {
    if (!applyStrategyId) {
      toast.info('请先选择一个策略');
      return;
    }
    if (selectedCodes.size === 0) {
      toast.info('请先勾选至少一只股票');
      return;
    }

    const nextBindings = { ...rules.watchlist_monitor.stock_bindings };
    selectedCodes.forEach((code) => {
      nextBindings[code] = applyStrategyId;
      const normalized = normalizeStockCode(code).toUpperCase();
      if (normalized) nextBindings[normalized] = applyStrategyId;
    });

    const nextRules: MonitorRules = {
      ...rules,
      watchlist_monitor: {
        ...rules.watchlist_monitor,
        stock_bindings: nextBindings,
      },
    };

    try {
      await persistRules(nextRules, `已绑定并保存 ${selectedCodes.size} 只股票`);
    } catch {
      // no-op: toast already shown
    }
  };

  const removeStrategy = async (strategyId: string) => {
    const nextStrategies = rules.watchlist_monitor.strategies.filter((s) => s.id !== strategyId);
    const nextBindings: Record<string, string> = {};
    Object.entries(rules.watchlist_monitor.stock_bindings).forEach(([code, sid]) => {
      if (sid !== strategyId) nextBindings[code] = sid;
    });

    const nextRules: MonitorRules = {
      ...rules,
      watchlist_monitor: {
        ...rules.watchlist_monitor,
        strategies: nextStrategies,
        stock_bindings: nextBindings,
      },
    };

    try {
      await persistRules(nextRules, '策略已删除并保存');
      if (applyStrategyId === strategyId) setApplyStrategyId('');
    } catch {
      // no-op: toast already shown
    }
  };

  const updateStrategyEnabled = async (strategyId: string, enabled: boolean) => {
    const nextRules: MonitorRules = {
      ...rules,
      watchlist_monitor: {
        ...rules.watchlist_monitor,
        strategies: rules.watchlist_monitor.strategies.map((s) =>
          s.id === strategyId ? { ...s, enabled, updatedAt: Date.now() } : s
        ),
      },
    };

    try {
      await persistRules(nextRules, enabled ? '策略已启用并保存' : '策略已停用并保存');
    } catch {
      // no-op: toast already shown
    }
  };

  const bindSingleStock = async (code: string, strategyId: string, closeDetail = false) => {
    const normalized = normalizeStockCode(code).toUpperCase();
    const next = { ...rules.watchlist_monitor.stock_bindings };
    if (strategyId) {
      next[code] = strategyId;
      if (normalized) next[normalized] = strategyId;
    } else {
      delete next[code];
      delete next[code.toUpperCase()];
      if (normalized) delete next[normalized];
    }

    const nextRules: MonitorRules = {
      ...rules,
      watchlist_monitor: {
        ...rules.watchlist_monitor,
        stock_bindings: next,
      },
    };

    try {
      await persistRules(nextRules, strategyId ? `已绑定 ${code}` : `已取消监控 ${code}`);
      if (closeDetail) setDetailCode(null);
    } catch {
      // no-op: toast already shown
    }
  };

  if (loading) {
    return <Loading text="正在加载自选股监控配置..." />;
  }

  return (
    <div className={styles.monitorPage}>
      <Card
        title="自选股监控"
        extra={<Button onClick={handleSaveAll} disabled={saving}>{saving ? '保存中...' : '保存配置'}</Button>}
      >
        <div className={styles.versionTag}>界面版本：{MONITOR_UI_VERSION}</div>
        <div className={styles.inlineRow}>
          <label className={styles.switchField}>
            <span>全局启用（总开关）</span>
            <input
              type="checkbox"
              checked={rules.enabled}
              onChange={(e) => setRules((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
          </label>

          <label className={styles.switchField}>
            <span>自选股监控启用（仅控制自选策略）</span>
            <input
              type="checkbox"
              checked={rules.watchlist_monitor.enabled}
              onChange={(e) =>
                setRules((prev) => ({
                  ...prev,
                  watchlist_monitor: { ...prev.watchlist_monitor, enabled: e.target.checked },
                }))
              }
            />
          </label>
        </div>
      </Card>

      <Card title={`监控中（${monitoredItems.length}）`}>
        {monitoredItems.length === 0 ? (
          <div className={styles.empty}>当前没有已绑定的监控股票</div>
        ) : (
          <div className={styles.activeGrid}>
            {monitoredItems.map((item) => (
              <button
                key={`${item.code}:${item.strategyId}`}
                className={styles.activeItem}
                onClick={() => setDetailCode(item.code)}
                title={`${item.name} (${item.code})`}
              >
                <span className={styles.activeName}>{item.name}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="监控条件（输入框）">
        <div className={styles.conditionRow}>
          <input
            className={styles.conditionInput}
            type="text"
            placeholder="例如：15分钟波动率>3% 或 价格>120 或 价格<88"
            value={conditionInput}
            onChange={(e) => setConditionInput(e.target.value)}
          />
          <Button onClick={handleCreateStrategy}>保存为策略</Button>
        </div>

        <div className={styles.applyRow}>
          <select
            className={styles.select}
            value={applyStrategyId}
            onChange={(e) => setApplyStrategyId(e.target.value)}
          >
            <option value="">选择一个策略应用到已勾选股票</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.condition}
              </option>
            ))}
          </select>
          <Button onClick={applyStrategyToSelected} disabled={strategies.length === 0}>
            应用到已勾选
          </Button>
        </div>
      </Card>

      <Card title={`策略列表（${strategies.length}）`}>
        {strategies.length === 0 ? (
          <div className={styles.empty}>暂无策略，请先输入条件并保存</div>
        ) : (
          <div className={styles.strategyList}>
            {strategies.map((s) => (
              <div className={styles.strategyItem} key={s.id}>
                <label className={styles.strategyToggle}>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => updateStrategyEnabled(s.id, e.target.checked)}
                  />
                  <span>{s.condition}</span>
                </label>
                <Button variant="ghost" size="sm" onClick={() => removeStrategy(s.id)}>
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`自选股列表（${watchlistItems.length}）`}>
        {watchlistItems.length === 0 ? (
          <div className={styles.empty}>暂无自选股，请先在“自选”栏目添加股票</div>
        ) : (
          <>
            <div className={styles.bulkBar}>
              <label className={styles.checkLine}>
                <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                <span>全选 / 取消全选</span>
              </label>
              <span className={styles.subtle}>已勾选 {selectedCodes.size} 只</span>
            </div>

            <div className={styles.table}>
              <div className={styles.rowHeader}>
                <span>勾选</span>
                <span>股票代码</span>
                <span>股票名称</span>
                <span>绑定策略</span>
              </div>
              {watchlistItems.map((item) => {
                const normalizedCode = normalizeStockCode(item.code).toUpperCase();
                const bound =
                  resolvedBindings[item.code] ||
                  resolvedBindings[item.code.toUpperCase()] ||
                  (normalizedCode ? resolvedBindings[normalizedCode] : '') ||
                  '';
                return (
                  <div className={styles.row} key={item.code}>
                    <label className={styles.checkLine}>
                      <input
                        type="checkbox"
                        checked={selectedCodes.has(item.code)}
                        onChange={() => toggleSelectCode(item.code)}
                      />
                    </label>
                    <span>{item.code}</span>
                    <span>{item.name}</span>
                    <select
                      className={styles.select}
                      value={bound}
                      onChange={(e) => bindSingleStock(item.code, e.target.value)}
                    >
                      <option value="">不监控</option>
                      {strategies.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.condition}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      {detailItem && (
        <div className={styles.modalMask} onClick={() => setDetailCode(null)}>
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h4>监控详情</h4>
              <Button variant="ghost" size="sm" onClick={() => setDetailCode(null)}>关闭</Button>
            </div>
            <div className={styles.modalBody}>
              <div><strong>股票：</strong>{detailItem.name}（{detailItem.code}）</div>
              <div><strong>当前策略：</strong>{detailItem.strategyCondition}</div>
              <div><strong>状态：</strong>{detailItem.strategyEnabled ? '生效中' : '已停用'}</div>
              <div className={styles.modalActions}>
                <select
                  className={styles.select}
                  value={detailItem.strategyId}
                  onChange={(e) => bindSingleStock(detailItem.code, e.target.value)}
                >
                  <option value="">不监控</option>
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.condition}
                    </option>
                  ))}
                </select>
                <Button variant="ghost" onClick={() => bindSingleStock(detailItem.code, '', true)}>
                  取消监控
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
