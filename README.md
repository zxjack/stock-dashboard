# stock-dashboard（fork 增强版，当前：v0.5）

> 基于上游 stock-dashboard 的二次开发版本。当前重点是：
> **局域网稳定部署 + 移动端可用 + 自选股跨端同步 + 监控栏目闭环（invest 推送）**。

- 仓库：<https://github.com/zxjack/stock-dashboard>
- 当前版本标签：`v0.5`（可用版）

---

## 1. 我们在 fork 基础上做了哪些改动

### 1) 部署与运行
- 增加局域网访问部署方案（固定内网入口，可按环境配置）
- 通过 macOS `launchd` 常驻服务，保证重启后可恢复
- 前端与本地 API 代理统一收口在同一服务链路

### 2) 导航与栏目
- 侧边栏调整为：
  - 总览
  - 热力图
  - 榜单
  - 自选
  - **监控（新增）**
  - 尾盘选股
  - 设置
- 增加移动端导航组件（`MobileNav`）

### 3) 自选股后端同步（核心改动）
- 新增后端 API：`/api/watchlist/groups`
- 前端 `storage.ts` 改为“本地 + 后端同步”
- 增加旧数据自动迁移：
  - 当后端分组为空时，自动从旧 `watchlist.json` 回填
- 已验证手机端与桌面端同步一致

### 4) 监控策略与推送闭环
- 增加监控配置页（`/monitor`）
- 支持保存规则、绑定自选、启停策略
- 对接 invest 侧监控脚本与 Telegram 推送
- 推送去重与冷却（避免刷屏）

---

## 2. 新增栏目：怎么配置、怎么使用

> 重点是 **监控栏目（/monitor）**。

### 2.1 监控栏目入口
- 页面：`/stock-dashboard/monitor`
- 主要区域：
  1. 总开关（全局启用）
  2. 自选监控开关（仅控制自选策略）
  3. 监控中列表
  4. 策略列表（条件、启停）
  5. 绑定关系（股票 ↔ 策略）

### 2.2 两个“启用”开关区别
- **全局启用（总开关）**：关掉后，监控链路整体停止
- **自选股监控启用**：只控制自选策略分支；行业/概念规则可独立保留

### 2.3 使用步骤（推荐）
1. 打开 `监控` 页面
2. 新建策略（例如：涨幅 > 1.5%）
3. 给自选股绑定策略
4. 点击「保存配置」
5. 等待定时任务轮询，命中后由 invest bot 推送

### 2.4 配置文件位置（脱敏说明）
- 监控规则、推送去重状态、自选分组均存放在**本地私有运行目录**
- 具体绝对路径不在公开文档披露（避免泄露本机目录结构）
- 代码层可通过 API 使用，无需直接访问底层文件

### 2.5 监控相关 API（本地）
- `GET /api/monitor/rules`
- `POST /api/monitor/rules`
- `GET /api/monitor/push-records`
- `GET /api/monitor/watchlist`
- `GET /api/monitor/watchlist/quotes?codes=...`

### 2.6 与 OpenClaw Agent 联动（含 Skill 编写）
> 目标：让“监控配置页 → 监控脚本 → Agent 推送”形成标准闭环。

#### 联动架构（脱敏版）
1. 前端监控页维护规则（启停、策略、绑定）
2. 后端 API 提供规则读取与状态查询
3. OpenClaw 定时任务触发监控脚本
4. 脚本输出统一 JSON（`ok/is_new/message/items/errors`）
5. Agent 根据 JSON 决策是否推送

#### 推送判定规则（建议）
- `ok=true && is_new=true`：发送 `message`
- `is_new=false`：静默
- `ok=false`：仅首条异常上报，避免重复刷屏

#### Skill 编写建议（invest 方向）
- Skill 名称示例：`board-anomaly-push`
- Skill 职责：
  - 读取监控脚本输出
  - 按判定规则决定是否发送
  - 对重复信号做冷却控制
- Skill 说明文档建议包含：
  1. 触发条件（何时执行）
  2. 输入输出契约（JSON 字段定义）
  3. 失败兜底（超时/接口异常）
  4. 脱敏要求（禁止回传本机路径、IP、账号标识）

#### 最小联调清单
1. 页面保存策略后，`/api/monitor/rules` 能读到更新
2. 监控脚本可返回标准 JSON
3. Agent 能正确识别 `is_new` 并静默/推送
4. 推送内容不包含隐私字段（路径、内网地址、设备标识）

### 2.7 OpenClaw 可直接部署的 Skill 示例（脱敏）

#### A) Skill 目录结构
```text
agents/invest/skills/board-anomaly-push/
├── SKILL.md
└── scripts/
    └── run_monitor.py
```

#### B) `SKILL.md` 示例
```markdown
---
name: board-anomaly-push
description: 运行板块/自选异动监控脚本，按 ok/is_new 规则决定是否向目标会话推送。
---

# Board Anomaly Push

## 输入
监控脚本输出单行 JSON：
- ok: boolean
- is_new: boolean
- message: string
- items: array
- errors: array

## 判定规则
1. ok=true 且 is_new=true：发送 message
2. is_new=false：静默
3. ok=false：仅首次异常上报（同类异常静默）

## 脱敏要求
- 禁止输出绝对路径
- 禁止输出内网 IP
- 禁止输出账号/设备标识
```

#### C) `scripts/run_monitor.py` 示例
```python
#!/usr/bin/env python3
import json
import os
import subprocess

MONITOR_CMD = os.getenv("MONITOR_CMD", "python3 monitor.py")

p = subprocess.run(MONITOR_CMD, shell=True, capture_output=True, text=True)
raw = (p.stdout or "").strip()

if not raw:
    print(json.dumps({"action": "silent", "reason": "empty_output"}, ensure_ascii=False))
    raise SystemExit(0)

try:
    data = json.loads(raw)
except Exception:
    print(json.dumps({"action": "alert_once", "message": "监控输出非 JSON"}, ensure_ascii=False))
    raise SystemExit(0)

ok = bool(data.get("ok", False))
is_new = bool(data.get("is_new", False))
msg = str(data.get("message", "")).strip()

if ok and is_new and msg:
    print(json.dumps({"action": "send", "message": msg}, ensure_ascii=False))
elif ok and not is_new:
    print(json.dumps({"action": "silent"}, ensure_ascii=False))
else:
    print(json.dumps({"action": "alert_once", "message": msg or "监控异常"}, ensure_ascii=False))
```

#### D) OpenClaw 接入步骤（最小可用）
1. 将 skill 放到 `agents/invest/skills/board-anomaly-push/`
2. 将监控脚本加入定时任务（cron/launchd 任选）
3. 定时任务执行后读取 JSON：
   - `action=send` → 调用消息发送
   - `action=silent` → 不发送
   - `action=alert_once` → 首次异常告警
4. 通过 invest 账号完成消息推送

#### E) 验收标准
- 有新信号时收到推送
- 无新信号时不打扰
- 脚本异常不刷屏
- 推送文本无隐私信息

---

## 3. 项目结构（与本次改动相关）

- `boardApiPlugin.ts`
  - 本地 API/代理核心
  - watchlist 与 monitor 后端接口在此扩展
- `src/services/storage.ts`
  - 自选本地存储 + 后端同步逻辑
- `src/pages/Monitor/*`
  - 监控栏目 UI 与交互
- `src/components/layout/MobileNav.*`
  - 移动端导航

---

## 4. 运行方式

安装与开发：
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

## 5. 隐私与备份说明

自选分组、监控规则、推送状态属于隐私/运行态数据，按当前策略不纳入公开仓库同步。

---

## 6. 当前状态与后续

### ✅ v0.5 已完成
- 局域网部署稳定
- 手机端自选同步问题修复
- 监控栏目可配置、可保存、可推送

### ⏳ 下一步（v0.6+）
- 板块体验继续优化
- 监控交互进一步直观化
- 增加更多策略模板与说明