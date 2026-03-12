// container/skills/stock-tools/src/alert.ts
// 价格提醒工具

import { getStockQuote } from './quote';

interface PriceAlert {
  id: string;
  symbol: string;
  name: string;
  type: 'above' | 'below' | 'cross-up' | 'cross-down';
  price: number;
  enabled: boolean;
  createdAt: string;
  triggeredAt?: string;
  notes?: string;
}

async function setAlert(params: {
  symbol: string;
  type: 'above' | 'below';
  price: number;
  notes?: string;
}): Promise<PriceAlert> {
  const { symbol, type, price, notes } = params;

  // 获取股票名称
  let name = symbol;
  try {
    const quote = await getStockQuote(symbol);
    name = quote.name;
  } catch (error) {
    console.error('获取股票名称失败:', error);
  }

  const alert: PriceAlert = {
    id: generateId(),
    symbol,
    name,
    type,
    price,
    enabled: true,
    createdAt: new Date().toISOString(),
    notes
  };

  // 保存提醒
  const alerts = await readAlerts();
  alerts.push(alert);
  await writeAlerts(alerts);

  return alert;
}

async function listAlerts(symbol?: string): Promise<PriceAlert[]> {
  const alerts = await readAlerts();
  if (symbol) {
    return alerts.filter(a => a.symbol === symbol);
  }
  return alerts;
}

async function deleteAlert(alertId: string): Promise<void> {
  const alerts = await readAlerts();
  const filtered = alerts.filter(a => a.id !== alertId);
  await writeAlerts(filtered);
}

async function updateAlert(alertId: string, updates: Partial<PriceAlert>): Promise<PriceAlert> {
  const alerts = await readAlerts();
  const index = alerts.findIndex(a => a.id === alertId);
  if (index < 0) {
    throw new Error(`提醒不存在: ${alertId}`);
  }

  alerts[index] = { ...alerts[index], ...updates };
  await writeAlerts(alerts);

  return alerts[index];
}

// 检查提醒是否触发
async function checkAlerts(): Promise<PriceAlert[]> {
  const alerts = await listAlerts();
  const triggeredAlerts: PriceAlert[] = [];

  for (const alert of alerts) {
    if (!alert.enabled || alert.triggeredAt) {
      continue;
    }

    try {
      const quote = await getStockQuote(alert.symbol);
      const currentPrice = quote.price;
      let triggered = false;

      switch (alert.type) {
        case 'above':
          triggered = currentPrice >= alert.price;
          break;
        case 'below':
          triggered = currentPrice <= alert.price;
          break;
      }

      if (triggered) {
        const updatedAlert = await updateAlert(alert.id, {
          triggeredAt: new Date().toISOString()
        });
        triggeredAlerts.push(updatedAlert);
      }
    } catch (error) {
      console.error(`检查提醒 ${alert.id} 失败:`, error);
    }
  }

  return triggeredAlerts;
}

// 读取提醒列表
async function readAlerts(): Promise<PriceAlert[]> {
  try {
    const fs = await import('fs');
    const path = '/workspace/group/alerts.json';
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch (error) {
    console.error('读取提醒失败:', error);
  }
  return [];
}

// 写入提醒列表
async function writeAlerts(alerts: PriceAlert[]): Promise<void> {
  try {
    const fs = await import('fs');
    const path = '/workspace/group/alerts.json';
    fs.writeFileSync(path, JSON.stringify(alerts, null, 2));
  } catch (error) {
    console.error('写入提醒失败:', error);
  }
}

// 生成 ID
function generateId(): string {
  return 'alert_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

export {
  setAlert,
  listAlerts,
  deleteAlert,
  updateAlert,
  checkAlerts,
  PriceAlert
};
