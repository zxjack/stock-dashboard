# stock-dashboard（当前：v0.5）

A 股看板项目（React + TypeScript + Vite），当前已完成 **局域网可用部署**、**移动端导航适配**、**自选股后端同步**、**监控策略基础闭环**。

仓库：<https://github.com/zxjack/stock-dashboard>

---

## 当前版本状态（v0.5）

### ✅ 已完成
- 局域网访问入口稳定（本机 launchd 常驻）
- 页面主导航 + 移动端导航
- 总览/榜单/热力图/自选/监控/尾盘选股等基础页面可用
- 自选股改为后端存储接口（跨端同步，手机端已验证）
- 监控策略可保存，invest 推送链路可用
- 兼容旧数据迁移（旧 `watchlist.json` 自动回填到分组存储）

### ⏳ 后续计划（v0.6+）
- 板块相关体验与展示继续打磨
- 监控页交互进一步直观化
- 更多策略模板与可视化解释

---

## 核心能力
- **总览**：指数卡片、自选快照、热点板块
- **榜单**：行业/概念多维排名
- **热力图**：市场热度可视化（支持适配调优）
- **自选**：分组、批量导入导出、拖拽排序
- **监控**：策略配置、绑定股票、异动推送
- **尾盘选股**：选股辅助与观察

---

## 数据层说明

### 1) 行情与板块
- 通过 `stock-sdk` 获取行情与板块数据
- 主要封装：`src/services/sdk.ts`

### 2) 自选后端存储（v0.5 新增）
- 前端接口：`/api/watchlist/groups`
- 插件实现：`boardApiPlugin.ts`
- 存储文件：
  - `agents/invest/portfolio/watchlist_groups.json`
- 兼容迁移：若分组文件为空，会从旧 `watchlist.json` 自动回填

### 3) 监控策略
- 监控规则文件：
  - `agents/invest/portfolio/board_anomaly_rules.json`
- 推送去重状态：
  - `agents/invest/research/pipeline/board_anomaly_state.json`

---

## 隐私与备份
自选与策略数据属于隐私数据，已从 GitHub 同步备份排除（`.gitignore` 已配置）。

---

## 开发与运行

```bash
npm install
npm run dev
```

构建：
```bash
npm run build
```

预览：
```bash
npm run preview
```

---

## 目录结构
- `src/pages`：业务页面
- `src/components`：通用组件与布局
- `src/services/sdk.ts`：行情数据层
- `src/services/storage.ts`：前端存储与后端同步封装
- `boardApiPlugin.ts`：本地 API/代理插件（含 watchlist/monitor 接口）

---

## 备注
本仓库当前按 **“可用优先”** 推进，先保证链路稳定与跨端可用，再持续优化细节体验。