import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, Activity, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { api } from '../../api/client';
import type { SettingsNotification, ModelEndpointPublic, FailoverStatePublic, EndpointType, EndpointStatus } from './types';
import { getErrorMessage } from './types';

// ========== Helper Functions ==========

function getStatusIcon(status: EndpointStatus) {
  switch (status) {
    case 'healthy':
      return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
    case 'degraded':
      return <AlertCircle className="w-4 h-4 text-amber-500" />;
    case 'unhealthy':
      return <XCircle className="w-4 h-4 text-red-500" />;
    default:
      return <Activity className="w-4 h-4 text-slate-400" />;
  }
}

function getStatusLabel(status: EndpointStatus): string {
  switch (status) {
    case 'healthy':
      return '健康';
    case 'degraded':
      return '降级';
    case 'unhealthy':
      return '不可用';
    default:
      return '未知';
  }
}

// ========== Endpoint Form ==========

interface EndpointFormProps {
  endpoint?: ModelEndpointPublic;
  onSave: (data: Partial<ModelEndpointPublic>) => void;
  onCancel: () => void;
  saving: boolean;
}

function EndpointForm({ endpoint, onSave, onCancel, saving }: EndpointFormProps) {
  const [name, setName] = useState(endpoint?.name || '');
  const [type, setType] = useState<EndpointType>(endpoint?.type || 'third_party');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl || '');
  const [priority, setPriority] = useState(endpoint?.priority?.toString() || '10');
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? true);
  const [authToken, setAuthToken] = useState('');
  const [apiKey, setApiKey] = useState('');

  const generateId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // 简单的 UUID 模拟
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  const handleSave = () => {
    onSave({
      id: endpoint?.id || generateId(),
      name,
      type,
      baseUrl,
      priority: parseInt(priority, 10) || 10,
      enabled,
      authToken: authToken || undefined,
      apiKey: apiKey || undefined,
    });
  };

  return (
    <div className="space-y-4 p-4 border border-slate-200 rounded-lg bg-slate-50">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-slate-900">
          {endpoint ? '编辑端点' : '添加端点'}
        </h4>
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-slate-600 mb-1">名称</label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：第三方 API #1"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-600 mb-1">类型</label>
          <Select value={type} onValueChange={(v) => setType(v as EndpointType)}>
            <SelectTrigger id="type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="official">官方</SelectItem>
              <SelectItem value="third_party">第三方</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {type === 'third_party' && (
          <>
            <div className="sm:col-span-2">
              <label className="block text-xs text-slate-600 mb-1">Base URL</label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-relay.example.com/v1"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-600 mb-1">
                Auth Token {endpoint?.hasAuthToken && '(已设置)'}
              </label>
              <Input
                id="authToken"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder={endpoint?.hasAuthToken ? '留空保持不变' : '输入 Token'}
              />
            </div>

            <div>
              <label className="block text-xs text-slate-600 mb-1">
                API Key {endpoint?.hasApiKey && '(已设置)'}
              </label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={endpoint?.hasApiKey ? '留空保持不变' : '输入 API Key'}
              />
            </div>
          </>
        )}

        <div>
          <label className="block text-xs text-slate-600 mb-1">优先级 (数字越小优先级越高)</label>
          <Input
            id="priority"
            type="number"
            min="0"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </div>

        <div className="flex items-end gap-2">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                id="enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              <span className="text-sm text-slate-700">启用</span>
            </label>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={saving || !name.trim()}>
          {saving && <RefreshCw className="w-4 h-4 animate-spin mr-2" />}
          {endpoint ? '更新' : '添加'}
        </Button>
      </div>
    </div>
  );
}

// ========== Main Section ==========

interface ModelFailoverSectionProps extends SettingsNotification {}

export function ModelFailoverSection({ setNotice, setError }: ModelFailoverSectionProps) {
  const [state, setState] = useState<FailoverStatePublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<ModelEndpointPublic | undefined>();

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<FailoverStatePublic>('/api/config/claude/failover');
      setState(data);
    } catch (err) {
      setError(getErrorMessage(err, '加载故障转移配置失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { loadState(); }, [loadState]);

  const handleAddEndpoint = async (data: Partial<ModelEndpointPublic>) => {
    setSaving(true);
    setError(null);
    try {
      const newState = await api.post<FailoverStatePublic>(
        '/api/config/claude/failover/endpoints',
        data,
      );
      setState(newState);
      setShowForm(false);
      setEditingEndpoint(undefined);
      setNotice('端点已添加');
    } catch (err) {
      setError(getErrorMessage(err, '添加端点失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateEndpoint = async (data: Partial<ModelEndpointPublic>) => {
    setSaving(true);
    setError(null);
    try {
      const newState = await api.post<FailoverStatePublic>(
        '/api/config/claude/failover/endpoints',
        data,
      );
      setState(newState);
      setShowForm(false);
      setEditingEndpoint(undefined);
      setNotice('端点已更新');
    } catch (err) {
      setError(getErrorMessage(err, '更新端点失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEndpoint = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      const newState = await api.delete<FailoverStatePublic>(
        `/api/config/claude/failover/endpoints/${encodeURIComponent(id)}`,
      );
      setState(newState);
      setNotice('端点已删除');
    } catch (err) {
      setError(getErrorMessage(err, '删除端点失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSwitchEndpoint = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      const newState = await api.post<FailoverStatePublic>(
        `/api/config/claude/failover/switch/${encodeURIComponent(id)}`,
      );
      setState(newState);
      setNotice('已切换端点，正在重启活动工作区...');
    } catch (err) {
      setError(getErrorMessage(err, '切换端点失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleResetHealth = async () => {
    setSaving(true);
    setError(null);
    try {
      const newState = await api.post<FailoverStatePublic>(
        '/api/config/claude/failover/reset',
      );
      setState(newState);
      setNotice('已重置所有端点健康状态');
    } catch (err) {
      setError(getErrorMessage(err, '重置健康状态失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <RefreshCw className="w-4 h-4 animate-spin" />
        加载中...
      </div>
    );
  }

  if (!state) return null;

  const sortedEndpoints = [...state.endpoints].sort((a, b) => a.priority - b.priority);

  return (
    <div className="space-y-6">
      {/* 当前状态 */}
      <div className="border border-slate-200 rounded-lg">
        <div className="p-4 border-b border-slate-200">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-5 h-5" />
            <h3 className="text-lg font-semibold text-slate-900">模型端点状态</h3>
          </div>
          <p className="text-sm text-slate-500">
            当前使用：
            {state.currentEndpointId
              ? state.endpoints.find((e) => e.id === state.currentEndpointId)?.name || state.currentEndpointId
              : '未选择'}
          </p>
        </div>
        <div className="p-4 space-y-4">
          {/* 端点列表 */}
          <div className="space-y-3">
            {sortedEndpoints.map((endpoint) => (
              <div
                key={endpoint.id}
                className={`flex items-center justify-between p-3 rounded-lg border ${
                  state.currentEndpointId === endpoint.id
                    ? 'border-teal-300 bg-teal-50/50'
                    : 'border-slate-200 bg-slate-50/30'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {state.currentEndpointId === endpoint.id && (
                    <Badge variant="default" className="shrink-0">当前</Badge>
                  )}
                  <div className="flex items-center gap-2 min-w-0">
                    {getStatusIcon(endpoint.status)}
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {endpoint.name}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                        <span>{endpoint.type === 'official' ? '官方' : '第三方'}</span>
                        <span>·</span>
                        <span>优先级: {endpoint.priority}</span>
                        <span>·</span>
                        <span className={
                          endpoint.status === 'healthy' ? 'text-emerald-600' :
                          endpoint.status === 'degraded' ? 'text-amber-600' :
                          endpoint.status === 'unhealthy' ? 'text-red-600' : ''
                        }>
                          {getStatusLabel(endpoint.status)}
                        </span>
                        {endpoint.failureCount > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-red-600">失败: {endpoint.failureCount}</span>
                          </>
                        )}
                        {endpoint.successCount > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-emerald-600">成功: {endpoint.successCount}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {state.currentEndpointId !== endpoint.id && endpoint.enabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSwitchEndpoint(endpoint.id)}
                      disabled={saving}
                    >
                      切换
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingEndpoint(endpoint);
                      setShowForm(true);
                    }}
                    disabled={saving}
                  >
                    编辑
                  </Button>
                  {endpoint.id !== 'official' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeleteEndpoint(endpoint.id)}
                      disabled={saving}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 操作按钮 */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
            <Button
              variant="outline"
              onClick={() => {
                setEditingEndpoint(undefined);
                setShowForm(true);
              }}
              disabled={saving}
            >
              <Plus className="w-4 h-4 mr-2" />
              添加端点
            </Button>
            <Button
              variant="outline"
              onClick={handleResetHealth}
              disabled={saving}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              重置健康状态
            </Button>
            <Button
              variant="outline"
              onClick={loadState}
              disabled={saving}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>
        </div>
      </div>

      {/* 切换历史 */}
      {state.switchHistory.length > 0 && (
        <div className="border border-slate-200 rounded-lg">
          <div className="p-4 border-b border-slate-200">
            <h3 className="text-sm font-medium text-slate-900">切换历史</h3>
          </div>
          <div className="p-4">
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {state.switchHistory.slice(0, 10).map((item, idx) => (
                <div key={idx} className="text-xs text-slate-600 flex items-start gap-2">
                  <span className="shrink-0 text-slate-400">
                    {new Date(item.timestamp).toLocaleString('zh-CN')}
                  </span>
                  <span>
                    {item.from ? (
                      <>
                        从 <span className="font-medium">{item.from}</span> 切换到
                      </>
                    ) : (
                      '切换到'
                    )}{' '}
                    <span className="font-medium">{item.to}</span>
                    {item.reason && ` (${item.reason})`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 添加/编辑表单 */}
      {showForm && (
        <EndpointForm
          endpoint={editingEndpoint}
          onSave={editingEndpoint ? handleUpdateEndpoint : handleAddEndpoint}
          onCancel={() => {
            setShowForm(false);
            setEditingEndpoint(undefined);
          }}
          saving={saving}
        />
      )}
    </div>
  );
}
