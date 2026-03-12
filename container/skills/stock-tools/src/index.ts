// container/skills/stock-tools/src/index.ts
// 股票分析助手 - 主入口文件

import { tool } from '@anthropic-ai/claude-agent-sdk';

// 导入各个模块
import { getStockQuote, isA股, is美股, StockQuote } from './quote';
import { getHistoryData, KLineItem, HistoryDataOptions } from './history';
import { calculateIndicator, IndicatorParams, IndicatorResult } from './indicator';
import { searchNews, analyzeSentiment, NewsArticle } from './news';
import { monitorPortfolio, addPosition, removePosition, updatePosition, PortfolioItem, PortfolioSummary } from './portfolio';
import { setAlert, listAlerts, deleteAlert, updateAlert, checkAlerts, PriceAlert } from './alert';

// 导出所有工具定义

/**
 * 股票分析助手 - 自定义 Skills
 *
 * 这是一组用于股票分析的专业工具集，包括：
 * - 实时行情获取
 * - 历史数据分析
 * - 技术指标计算
 * - 新闻与情绪分析
 * - 投资组合管理
 * - 价格提醒管理
 */

// 获取实时行情
const get_stock_quote = tool<{ symbol: string }, StockQuote>({
  name: "get_stock_quote",
  description: "获取股票的实时行情数据，包括当前价格、涨跌幅、成交量、PE、PB等信息",
  parameters: {
    symbol: "股票代码，如: 600519.SS (上交所), AAPL (美股)"
  },
  handler: async ({ symbol }) => {
    const quote = await getStockQuote(symbol);
    return quote;
  },
});

// 获取历史数据
const get_history_data = tool<{
  symbol: string;
  period?: '1d' | '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | 'max';
  interval?: '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1wk' | '1mo';
}, KLineItem[]>({
  name: "get_history_data",
  description: "获取股票的历史K线数据",
  parameters: {
    symbol: "股票代码",
    period: "数据周期: 1d(1天), 5d(5天), 1mo(1个月), 3mo(3个月), 6mo(6个月), 1y(1年), 2y(2年), 5y(5年), max(最大",
    interval: "K线间隔: 1m(1分钟), 5m(5分钟), 15m(15分钟), 30m(30分钟), 1h(1小时), 1d(1天), 1wk(1周), 1mo(1个月)"
  },
  handler: async ({ symbol, period = '3mo', interval = '1d' }) => {
    return await getHistoryData({ symbol, period, interval });
  },
});

// 计算技术指标
const calculate_indicator = tool<
  {
    symbol: string;
    indicator: 'MA' | 'EMA' | 'MACD' | 'RSI' | 'BOLL' | 'KDJ' | 'VOL';
    params?: Record<string, number>;
    period?: string;
  },
  IndicatorResult
>({
  name: "calculate_indicator",
  description: "计算技术分析指标，如MA(移动平均线)、EMA(指数移动平均)、MACD、RSI(相对强弱指标)、BOLL(布林带)、KDJ(随机指标)、VOL(成交量)",
  parameters: {
    symbol: "股票代码",
    indicator: "技术指标类型: MA, EMA, MACD, RSI, BOLL, KDJ, VOL",
    params: "指标参数，如 { period: 20 }",
    period: "历史数据周期"
  },
  handler: async ({ symbol, indicator, params, period }) => {
    return await calculateIndicator({ symbol, indicator, params, period });
  },
});

// 搜索新闻
const search_news = tool<
  { query: string; symbols?: string[]; days?: number },
  NewsArticle[]
>({
  name: "search_news",
  description: "搜索与股票相关的新闻和资讯",
  parameters: {
    query: "搜索关键词",
    symbols: "相关股票代码列表",
    days: "搜索最近几天的新闻"
  },
  handler: async ({ query, symbols, days }) => {
    return await searchNews(query, symbols, days);
  },
});

// 情绪分析
const analyze_sentiment = tool<
  { text: string },
  { sentiment: 'positive' | 'negative' | 'neutral'; score: number; keywords: string[] }
>({
  name: "analyze_sentiment",
  description: "分析文本的情绪倾向，判断是利好、利空还是中性",
  parameters: {
    text: "需要分析的文本内容"
  },
  handler: async ({ text }) => {
    return await analyzeSentiment(text);
  },
});

// 监控投资组合
const monitor_portfolio = tool<{}, PortfolioSummary>({
  name: "monitor_portfolio",
  description: "获取投资组合的实时监控数据，包括持仓、盈亏、仓位分布等",
  parameters: {},
  handler: async () => {
    return await monitorPortfolio();
  },
});

// 添加持仓
const add_position = tool<Omit<PortfolioItem, 'currentPrice' | 'marketValue' | 'profitLoss' | 'profitLossPercent' | 'weight'>, void>({
  name: "add_position",
  description: "向投资组合添加持仓",
  parameters: {
    symbol: "股票代码",
    name: "股票名称",
    quantity: "持仓数量",
    costPrice: "成本价格",
    buyDate: "买入日期",
    notes: "备注"
  },
  handler: async (position) => {
    await addPosition(position as PortfolioItem);
  },
});

// 删除持仓
const remove_position = tool<{ symbol: string }, void>({
  name: "remove_position",
  description: "从投资组合删除持仓",
  parameters: {
    symbol: "股票代码"
  },
  handler: async ({ symbol }) => {
    await removePosition(symbol);
  },
});

// 设置价格提醒
const set_alert = tool<{
  symbol: string;
  type: 'above' | 'below';
  price: number;
  notes?: string;
}, PriceAlert>({
  name: "set_alert",
  description: "设置股票价格提醒，当价格达到设定值时触发提醒",
  parameters: {
    symbol: "股票代码",
    type: "提醒类型: above(高于), below(低于)",
    price: "触发价格",
    notes: "备注"
  },
  handler: async (params) => {
    return await setAlert(params);
  },
});

// 列出价格提醒
const list_alerts = tool<{ symbol?: string }, PriceAlert[]>({
  name: "list_alerts",
  description: "列出所有价格提醒",
  parameters: {
    symbol: "可选，只列出指定股票的提醒"
  },
  handler: async ({ symbol }) => {
    return await listAlerts(symbol);
  },
});

// 删除价格提醒
const delete_alert = tool<{ alertId: string }, void>({
  name: "delete_alert",
  description: "删除价格提醒",
  parameters: {
    alertId: "提醒ID"
  },
  handler: async ({ alertId }) => {
    await deleteAlert(alertId);
  },
});

// 导出所有工具
export const tools = [
  get_stock_quote,
  get_history_data,
  calculate_indicator,
  search_news,
  analyze_sentiment,
  monitor_portfolio,
  add_position,
  remove_position,
  set_alert,
  list_alerts,
  delete_alert,
];

// 导出类型供其他模块使用
export {
  StockQuote,
  KLineItem,
  HistoryDataOptions,
  IndicatorParams,
  IndicatorResult,
  NewsArticle,
  PortfolioItem,
  PortfolioSummary,
  PriceAlert,
};

// 默认导出
export default tools;
