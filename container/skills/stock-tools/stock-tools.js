// container/skills/stock-tools/stock-tools.js
// 股票分析助手 - 主入口
// 纯 JavaScript 版本，无需编译

export async function getStockQuote(symbol) {
  // 使用东方财富 API 获取实时行情
  try {
    let normalizedSymbol = symbol;
    let secid = '';

    // A股代码转换
    if (/^\d{6}$/.test(symbol)) {
      secid = `1.${symbol}`;
    } else if (symbol.includes('.SS')) {
      secid = `1.${symbol.replace('.SS', '')}`;
    } else if (symbol.includes('.SZ')) {
      secid = `0.${symbol.replace('.SZ', '')}`;
    }

    if (secid) {
      // A股 - 东方财富 API
      const url = `https://push2.eastmoney.com/api/qt/stock/get?ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fields=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f148,f152&secid=${secid}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data && data.data) {
        const d = data.data;
        return {
          symbol: symbol,
          name: d.f14 || symbol,
          price: d.f2 || 0,
          change: d.f4 || 0,
          changePercent: d.f3 || 0,
          open: d.f17 || 0,
          high: d.f15 || 0,
          low: d.f16 || 0,
          close: d.f18 || 0,
          volume: d.f5 || 0,
          amount: d.f6 || 0,
          marketCap: d.f20,
          pe: d.f9,
          pb: d.f23,
          timestamp: Date.now()
        };
      }
    }

    // 美股 - Yahoo Finance API
    const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const yahooResponse = await fetch(yahooUrl);
    const yahooData = await yahooResponse.json();

    if (yahooData && yahooData.quoteResponse && yahooData.quoteResponse.result.length > 0) {
      const d = yahooData.quoteResponse.result[0];
      return {
        symbol: symbol,
        name: d.longName || d.shortName || symbol,
        price: d.regularMarketPrice || 0,
        change: d.regularMarketChange || 0,
        changePercent: d.regularMarketChangePercent || 0,
        open: d.regularMarketOpen || 0,
        high: d.regularMarketDayHigh || 0,
        low: d.regularMarketDayLow || 0,
        close: d.regularMarketPreviousClose || 0,
        volume: d.regularMarketVolume || 0,
        amount: d.regularMarketPrice ? d.regularMarketPrice * (d.regularMarketVolume || 1) : 0,
        marketCap: d.marketCap,
        pe: d.trailingPE,
        pb: d.priceToBook,
        timestamp: Date.now()
      };
    }

    // 如果都失败了，返回模拟数据
    return {
      symbol: symbol,
      name: symbol,
      price: 100.00,
      change: 0,
      changePercent: 0,
      open: 100.00,
      high: 101.50,
      low: 98.50,
      close: 100.00,
      volume: 1000000,
      amount: 100000000,
      timestamp: Date.now(),
      note: '模拟数据 - 数据源不可用'
    };
  } catch (error) {
    console.error('获取行情失败:', error);
    return {
      symbol: symbol,
      name: symbol,
      price: 100.00,
      change: 0,
      changePercent: 0,
      open: 100.00,
      high: 101.50,
      low: 98.50,
      close: 100.00,
      volume: 1000000,
      amount: 100000000,
      timestamp: Date.now(),
      error: String(error)
    };
  }
}

// 技术指标计算函数
export function calculateMA(data, period) {
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    result.push({
      date: data[i].date,
      value: sum / period
    });
  }
  return result;
}

// 导出默认
export default {
  getStockQuote,
  calculateMA
};
