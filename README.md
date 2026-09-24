# TradingSimulator

<img src="./public/trading-simulator-logo.png" alt="TradingSimulator" width="96">

历史 K 线回放与模拟交易学习工具。使用 KLineChart Pro 终端外壳和 `@mathieuc/tradingview` 数据接口，不连接交易所、不执行真实下单。

## 开发

```bash
npm install
npm run dev
```

当前包含：

- TradingView 品种搜索、实时行情和可管理自选表
- 分钟、小时、日、周、月周期及浏览器端周期收藏
- TradingView 风格的 Select bar 回放和逐根揭示
- KLineChart Pro 指标与画线工具
- Live 与 Replay 共用的模拟交易账户
- Market、Limit、Stop、Take Profit、Stop Loss 和图表订单线
- Positions、Orders、Order history 和 Trade history
- SQLite 持久化的账户、订单、成交历史和 Replay 会话

本地 Express 服务负责 TradingView WebSocket、历史数据、品种搜索、SSE 行情推送和模拟交易状态。SQLite 文件位于 `.data/trading-simulator.sqlite`，不会提交到 Git。当前使用公开图表数据，不需要账户凭据；回放数据会丢弃最后一根未收线 K 线。真实交易接口不在本项目范围内。

## 授权

项目自有源码依据 [GNU AGPL-3.0-only](./LICENSE) 授权。源码及构建方式见 [GitHub 仓库](https://github.com/WAY29/TradingSimulator)；部署或分发时须提供与运行版本一致的对应源码。Pine Script 运行时使用 LuxAlgo 的 [PineTS](https://github.com/LuxAlgo/PineTS)，同为 AGPL-3.0-only；其他第三方依赖保留各自许可证。TradingView 的行情数据、商标和远端图标不在本项目授权范围内。
