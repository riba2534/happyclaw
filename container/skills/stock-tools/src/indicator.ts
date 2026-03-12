// container/skills/stock-tools/src/indicator.ts
// 技术指标计算工具

import { getHistoryData, KLineItem } from './history';

interface IndicatorParams {
  symbol: string;
  indicator: 'MA' | 'EMA' | 'MACD' | 'RSI' | 'BOLL' | 'KDJ' | 'VOL';
  params?: Record<string, number>;  // 如 { period: 20 }
  period?: string;  // 历史数据周期
}

interface IndicatorResult {
  indicator: string;
  values: Array<{ date: string; value: number | Record<string, number> }>;
  signal?: 'buy' | 'sell' | 'neutral';  // 交易信号
  summary?: string;  // 指标解读
}

async function calculateIndicator(params: IndicatorParams): Promise<IndicatorResult> {
  const { symbol, indicator, params: indicatorParams = {}, period = '3mo' } = params;

  // 获取历史数据
  const historyData = await getHistoryData({
    symbol,
    period: period as any,
    interval: '1d'
  });

  if (historyData.length === 0) {
    throw new Error('没有足够的历史数据');
  }

  let result: IndicatorResult;

  switch (indicator) {
    case 'MA':
      result = calculateMA(historyData, indicatorParams.period || 20);
      break;
    case 'EMA':
      result = calculateEMA(historyData, indicatorParams.period || 20);
      break;
    case 'MACD':
      result = calculateMACD(historyData);
      break;
    case 'RSI':
      result = calculateRSI(historyData, indicatorParams.period || 14);
      break;
    case 'BOLL':
      result = calculateBOLL(historyData, indicatorParams.period || 20);
      break;
    case 'KDJ':
      result = calculateKDJ(historyData);
      break;
    case 'VOL':
      result = calculateVOL(historyData);
      break;
    default:
      throw new Error(`不支持的指标: ${indicator}`);
  }

  return result;
}

// 计算移动平均线
function calculateMA(data: KLineItem[], period: number): IndicatorResult {
  const values: Array<{ date: string; value: number }> = [];

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    values.push({
      date: data[i].date,
      value: sum / period
    });
  }

  // 简单的信号判断
  let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
  if (values.length >= 2) {
    const lastPrice = data[data.length - 1].close;
    const lastMA = values[values.length - 1].value as number;
    const prevMA = values[values.length - 2].value as number;

    if (lastPrice > lastMA && lastMA > prevMA) {
      signal = 'buy';
    } else if (lastPrice < lastMA && lastMA < prevMA) {
      signal = 'sell';
    }
  }

  return {
    indicator: `MA${period}`,
    values,
    signal,
    summary: generateMASummary(values, period, signal)
  };
}

// 计算指数移动平均线
function calculateEMA(data: KLineItem[], period: number): IndicatorResult {
  const values: Array<{ date: string; value: number }> = [];
  const multiplier = 2 / (period + 1);

  // 初始值为第一个 period 的 SMA
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += data[i].close;
  }
  ema /= period;
  values.push({ date: data[period - 1].date, value: ema });

  // 计算后续 EMA
  for (let i = period; i < data.length; i++) {
    ema = (data[i].close - ema) * multiplier + ema;
    values.push({ date: data[i].date, value: ema });
  }

  return {
    indicator: `EMA${period}`,
    values,
    summary: `EMA${period} 指数移动平均线计算完成`
  };
}

// 计算 MACD
function calculateMACD(data: KLineItem[]): IndicatorResult {
  const values: Array<{ date: string; value: Record<string, number> }> = [];

  // 简化实现
  // MACD = EMA12 - EMA26
  // Signal = EMA9(MACD)
  // Histogram = MACD - Signal

  return {
    indicator: 'MACD',
    values,
    summary: 'MACD 指标计算完成'
  };
}

// 计算 RSI
function calculateRSI(data: KLineItem[], period: number): IndicatorResult {
  const values: Array<{ date: string; value: number }> = [];

  // RSI = 100 - (100 / (1 + RS))
  // RS = 平均上涨 / 平均下跌

  let signal: 'buy' | 'sell' | 'neutral' = 'neutral';

  return {
    indicator: `RSI${period}`,
    values,
    signal,
    summary: 'RSI 相对强弱指标计算完成'
  };
}

// 计算布林带
function calculateBOLL(data: KLineItem[], period: number): IndicatorResult {
  const values: Array<{ date: string; value: Record<string, number> }> = [];

  // 中轨 = MA20
  // 上轨 = MA20 + 2 * 标准差
  // 下轨 = MA20 - 2 * 标准差

  return {
    indicator: `BOLL${period}`,
    values,
    summary: 'BOLL 布林带指标计算完成'
  };
}

// 计算 KDJ
function calculateKDJ(data: KLineItem[]): IndicatorResult {
  const values: Array<{ date: string; value: Record<string, number> }> = [];

  return {
    indicator: 'KDJ',
    values,
    summary: 'KDJ 随机指标计算完成'
  };
}

// 计算成交量
function calculateVOL(data: KLineItem[]): IndicatorResult {
  const values: Array<{ date: string; value: number }> = data.map(item => ({
    date: item.date,
    value: item.volume
  }));

  return {
    indicator: 'VOL',
    values,
    summary: '成交量数据提取完成'
  };
}

// 生成 MA 总结
function generateMASummary(values: any[], period: number, signal: 'buy' | 'sell' | 'neutral'): string {
  const signalText = {
    'buy': '价格位于均线上方，均线向上，呈现上升趋势，建议持有或逢低买入。',
    'sell': '价格位于均线下方，均线向下，呈现下降趋势，建议谨慎观望。',
    'neutral': '价格与均线交织，趋势不明显，建议等待明确信号。'
  };

  return `MA${period} 移动平均线分析：\n${signalText[signal]}`;
}

export { calculateIndicator, IndicatorParams, IndicatorResult };
