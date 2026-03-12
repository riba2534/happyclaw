// container/skills/stock-tools/src/portfolio.ts
// 投资组合管理工具

import { getStockQuote, StockQuote } from './quote';

interface PortfolioItem {
  symbol: string;
  name: string;
  quantity: number;
  costPrice: number;        // 成本价
  currentPrice?: number;      // 当前价
  marketValue?: number;       // 市值
  profitLoss?: number;        // 盈亏额
  profitLossPercent?: number; // 盈亏比例
  weight?: number;            // 仓位占比
  buyDate?: string;           // 买入日期
  notes?: string;             // 备注
}

interface PortfolioSummary {
  totalCost: number;         // 总成本
  totalMarketValue: number;  // 总市值
  totalProfitLoss: number;   // 总盈亏
  totalProfitLossPercent: number;  // 总盈亏比例
  dailyProfitLoss: number;   // 今日盈亏
  positions: PortfolioItem[];
  allocation: Record<string, number>;  // 行业/板块分布
  riskMetrics?: {
    beta?: number;
    volatility?: number;
  };
}

async function monitorPortfolio(): Promise<PortfolioSummary> {
  // 读取投资组合数据
  const portfolio = await readPortfolio();

  if (!portfolio || portfolio.positions.length === 0) {
    return {
      totalCost: 0,
      totalMarketValue: 0,
      totalProfitLoss: 0,
      totalProfitLossPercent: 0,
      dailyProfitLoss: 0,
      positions: [],
      allocation: {}
    };
  }

  // 获取所有持仓的实时价格
  const updatedPositions: PortfolioItem[] = [];
  let totalCost = 0;
  let totalMarketValue = 0;
  let dailyProfitLoss = 0;

  for (const position of portfolio.positions) {
    try {
      const quote = await getStockQuote(position.symbol);
      const costAmount = position.costPrice * position.quantity;
      const marketValue = quote.price * position.quantity;
      const profitLoss = marketValue - costAmount;
      const profitLossPercent = ((quote.price - position.costPrice) / position.costPrice) * 100;

      updatedPositions.push({
        ...position,
        currentPrice: quote.price,
        marketValue,
        profitLoss,
        profitLossPercent
      });

      totalCost += costAmount;
      totalMarketValue += marketValue;
      // 计算今日盈亏（简化版）
      dailyProfitLoss += (quote.price - quote.close) * position.quantity;
    } catch (error) {
      console.error(`获取 ${position.symbol} 行情失败:`, error);
      updatedPositions.push(position);
    }
  }

  // 计算仓位占比
  if (totalMarketValue > 0) {
    updatedPositions.forEach(pos => {
      pos.weight = (pos.marketValue || 0) / totalMarketValue * 100;
    });
  }

  const totalProfitLoss = totalMarketValue - totalCost;
  const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;

  // 行业分布（简化实现）
  const allocation: Record<string, number> = {};

  return {
    totalCost,
    totalMarketValue,
    totalProfitLoss,
    totalProfitLossPercent,
    dailyProfitLoss,
    positions: updatedPositions,
    allocation
  };
}

async function addPosition(position: PortfolioItem): Promise<void> {
  const portfolio = await readPortfolio();
  portfolio.positions.push(position);
  await writePortfolio(portfolio);
}

async function removePosition(symbol: string): Promise<void> {
  const portfolio = await readPortfolio();
  portfolio.positions = portfolio.positions.filter(p => p.symbol !== symbol);
  await writePortfolio(portfolio);
}

async function updatePosition(symbol: string, updates: Partial<PortfolioItem>): Promise<void> {
  const portfolio = await readPortfolio();
  const index = portfolio.positions.findIndex(p => p.symbol === symbol);
  if (index >= 0) {
    portfolio.positions[index] = { ...portfolio.positions[index], ...updates };
    await writePortfolio(portfolio);
  }
}

// 读取投资组合
async function readPortfolio(): Promise<{ positions: PortfolioItem[], cash: number, updatedAt: string }> {
  try {
    const fs = await import('fs');
    const path = '/workspace/group/portfolio.json';
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch (error) {
    console.error('读取投资组合失败:', error);
  }
  return { positions: [], cash: 0, updatedAt: new Date().toISOString() };
}

// 写入投资组合
async function writePortfolio(data: { positions: PortfolioItem[], cash: number, updatedAt: string }): Promise<void> {
  try {
    const fs = await import('fs');
    const path = '/workspace/group/portfolio.json';
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('写入投资组合失败:', error);
  }
}

export {
  monitorPortfolio,
  addPosition,
  removePosition,
  updatePosition,
  PortfolioItem,
  PortfolioSummary
};
