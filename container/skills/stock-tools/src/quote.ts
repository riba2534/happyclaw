// container/skills/stock-tools/src/quote.ts
// 股票行情获取工具

interface StockQuote {
  symbol: string;           // 股票代码 (如: 600519.SS, AAPL)
  name: string;             // 股票名称
  price: number;            // 当前价格
  change: number;           // 涨跌额
  changePercent: number;    // 涨跌幅 (%)
  open: number;             // 开盘价
  high: number;             // 最高价
  low: number;              // 最低价
  close: number;            // 昨收价
  volume: number;           // 成交量
  amount: number;           // 成交额
  marketCap?: number;       // 市值
  pe?: number;              // PE 估值
  pb?: number;              // PB 估值
  timestamp: number;        // 数据时间戳
}

async function getStockQuote(symbol: string): Promise<StockQuote> {
  // 1. 检查缓存 (TTL 5分钟)
  const cacheKey = `cache/quotes/${symbol}.json`;
  const cached = await readCacheIfValid(cacheKey, 5 * 60 * 1000);
  if (cached) return cached;

  // 2. 根据股票代码选择数据源
  let quote: StockQuote;
  if (isA股(symbol)) {
    quote = await fetchFromEastMoney(symbol);
  } else if (is美股(symbol)) {
    quote = await fetchFromYahooFinance(symbol);
  } else {
    throw new Error(`不支持的股票: ${symbol}`);
  }

  // 3. 写入缓存
  await writeCache(cacheKey, quote);

  return quote;
}

// 判断是否是A股
function isA股(symbol: string): boolean {
  return symbol.includes('.SS') || symbol.includes('.SZ') || /^\d{6}$/.test(symbol);
}

// 判断是否是美股
function is美股(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol) && !symbol.includes('.');
}

// 从东方财富获取A股数据
async function fetchFromEastMoney(symbol: string): Promise<StockQuote> {
  const normalizedSymbol = normalizeASymbol(symbol);
  const url = `https://push2.eastmoney.com/api/qt/stock/get?ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fields=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f148,f152&secid=${normalizedSymbol}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.data) {
    const d = data.data;
    return {
      symbol: symbol,
      name: d.f14,
      price: d.f2,
      change: d.f4,
      changePercent: d.f3,
      open: d.f17,
      high: d.f15,
      low: d.f16,
      close: d.f18,
      volume: d.f5,
      amount: d.f6,
      marketCap: d.f20,
      pe: d.f9,
      pb: d.f23,
      timestamp: Date.now()
    };
  } else {
    throw new Error(`无法获取股票数据: ${symbol}`);
  }
}

// 从 Yahoo Finance 获取美股数据
async function fetchFromYahooFinance(symbol: string): Promise<StockQuote> {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.quoteResponse && data.quoteResponse.result.length > 0) {
    const d = data.quoteResponse.result[0];
    return {
      symbol: symbol,
      name: d.longName || d.shortName,
      price: d.regularMarketPrice,
      change: d.regularMarketChange,
      changePercent: d.regularMarketChangePercent,
      open: d.regularMarketOpen,
      high: d.regularMarketDayHigh,
      low: d.regularMarketDayLow,
      close: d.regularMarketPreviousClose,
      volume: d.regularMarketVolume,
      amount: d.regularMarketPrice * d.regularMarketVolume,
      marketCap: d.marketCap,
      pe: d.trailingPE,
      pb: d.priceToBook,
      timestamp: Date.now()
    };
  } else {
    throw new Error(`无法获取股票数据: ${symbol}`);
  }
}

// 归一化A股代码
function normalizeASymbol(symbol: string): string {
  if (symbol.includes('.SS')) {
    return `1.${symbol.replace('.SS', '')}`;
  } else if (symbol.includes('.SZ')) {
    return `0.${symbol.replace('.SZ', '')}`;
  } else if (/^\d{6}$/.test(symbol)) {
    // 默认上海证券交易所
    return `1.${symbol}`;
  }
  return symbol;
}

// 缓存读取函数
async function readCacheIfValid(cacheKey: string, ttl: number): Promise<StockQuote | null> {
  try {
    const cachePath = `/workspace/group/${cacheKey}`;
    const fs = await import('fs');
    if (fs.existsSync(cachePath)) {
      const stats = fs.statSync(cachePath);
      if (Date.now() - stats.mtime.getTime() < ttl) {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return data;
      }
    }
  } catch (error) {
    console.error('Cache read error:', error);
  }
  return null;
}

// 缓存写入函数
async function writeCache(cacheKey: string, data: StockQuote): Promise<void> {
  try {
    const cachePath = `/workspace/group/${cacheKey}`;
    const fs = await import('fs');
    const dir = cachePath.substring(0, cachePath.lastIndexOf('/'));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Cache write error:', error);
  }
}

export { getStockQuote, isA股, is美股, StockQuote };
