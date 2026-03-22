import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Bug,
  ImagePlus,
  X,
  Loader2,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { showToast } from '@/utils/toast';

interface BugReportDialogProps {
  open: boolean;
  onClose: () => void;
}

interface Capabilities {
  ghAvailable: boolean;
  ghUsername: string | null;
  claudeAvailable: boolean;
}

interface GenerateResult {
  title: string;
  body: string;
  systemInfo: Record<string, string>;
}

interface SubmitResult {
  method: 'created' | 'manual';
  url: string;
}

const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB

export function BugReportDialog({ open, onClose }: BugReportDialogProps) {
  // Capabilities (pre-fetched on open)
  const [caps, setCaps] = useState<Capabilities | null>(null);

  // Step 1: Input
  const [description, setDescription] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);

  // Step 2: Preview/Edit (only shown when no gh)
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [systemInfo, setSystemInfo] = useState<Record<string, string>>({});

  // Confirmation dialog (when gh available)
  const [showConfirm, setShowConfirm] = useState(false);

  // State
  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pre-fetch capabilities when dialog opens
  useEffect(() => {
    if (open) {
      api.get<Capabilities>('/api/bug-report/capabilities').then(setCaps).catch(() => {
        setCaps({ ghAvailable: false, ghUsername: null, claudeAvailable: false });
      });
    }
  }, [open]);

  const reset = useCallback(() => {
    setDescription('');
    setScreenshots([]);
    setTitle('');
    setBody('');
    setSystemInfo({});
    setShowConfirm(false);
    setStep(1);
    setLoading(false);
    setCopied(false);
    setCaps(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // --- Screenshot handling ---

  const addScreenshot = useCallback(
    (base64: string) => {
      if (screenshots.length >= MAX_SCREENSHOTS) {
        toast.error(`最多上传 ${MAX_SCREENSHOTS} 张截图`);
        return;
      }
      setScreenshots((prev) => [...prev, base64]);
    },
    [screenshots.length],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_SCREENSHOT_SIZE) {
        toast.error('单张截图不能超过 5MB');
        return;
      }
      if (!file.type.startsWith('image/')) {
        toast.error('请选择图片文件');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        addScreenshot(base64);
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    },
    [addScreenshot],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          if (file.size > MAX_SCREENSHOT_SIZE) {
            toast.error('粘贴的截图不能超过 5MB');
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            addScreenshot(base64);
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    },
    [addScreenshot],
  );

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // --- Generate report (Claude analysis) ---

  const generateReport = useCallback(async (): Promise<GenerateResult | null> => {
    try {
      return await api.post<GenerateResult>(
        '/api/bug-report/generate',
        {
          description: description.trim(),
          screenshots: screenshots.length > 0 ? screenshots : undefined,
        },
        90000,
      );
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? (err as { message: string }).message
          : '生成报告失败';
      throw new Error(msg);
    }
  }, [description, screenshots]);

  // --- Submit flow ---

  // No gh: generate report then show preview
  const handleGenerateForPreview = useCallback(async () => {
    if (!description.trim()) {
      toast.error('请输入问题描述');
      return;
    }
    setLoading(true);

    try {
      const result = await generateReport();
      if (!result) throw new Error('生成报告失败');
      setTitle(result.title);
      setBody(result.body);
      setSystemInfo(result.systemInfo);
      setStep(2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '生成报告失败，请重试';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [description, generateReport]);

  const handleSubmitClick = useCallback(() => {
    if (!description.trim()) {
      toast.error('请输入问题描述');
      return;
    }

    if (caps?.ghAvailable) {
      // Show confirmation dialog
      setShowConfirm(true);
    } else {
      // No gh — generate and go to preview/edit
      handleGenerateForPreview();
    }
  }, [description, caps, handleGenerateForPreview]);

  // gh available: user confirmed → close dialog, async generate+submit, toast result
  const handleConfirmSubmit = useCallback(async () => {
    setShowConfirm(false);
    handleClose();

    showToast('正在分析并提交...', '后台处理中，完成后会通知你', 10000);

    try {
      const report = await generateReport();
      if (!report) throw new Error('生成报告失败');

      const result = await api.post<SubmitResult>('/api/bug-report/submit', {
        title: report.title,
        body: report.body,
      });

      if (result.method === 'created') {
        showToast('Issue 提交成功', undefined, 8000, {
          text: '查看 Issue →',
          url: result.url,
        });
      } else {
        window.open(result.url, '_blank');
        showToast('已打开 GitHub', '请在新标签页中登录并提交 Issue', 6000);
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : '提交失败，请重试';
      showToast('提交失败', msg, 6000);
    }
  }, [generateReport, handleClose]);

  // Preview step: manual submit (opens pre-filled URL)
  const handleManualSubmit = useCallback(async () => {
    if (!title.trim() || !body.trim()) {
      toast.error('标题和内容不能为空');
      return;
    }
    setLoading(true);

    try {
      const result = await api.post<SubmitResult>('/api/bug-report/submit', {
        title: title.trim(),
        body: body.trim(),
      });

      if (result.method === 'created') {
        showToast('Issue 创建成功', undefined, 8000, {
          text: '查看 Issue →',
          url: result.url,
        });
        handleClose();
      } else {
        window.open(result.url, '_blank');
        showToast('已打开 GitHub', '请在新标签页中登录并提交 Issue', 6000);
        handleClose();
      }
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? (err as { message: string }).message
          : '提交失败，请重试';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [title, body, handleClose]);

  const handleCopy = useCallback(async () => {
    const text = `# ${title}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      showToast('已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('复制失败', '请手动选择文本复制');
    }
  }, [title, body]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="w-5 h-5" />
            {step === 1 && '报告问题'}
            {step === 2 && '预览 & 编辑'}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1: Input */}
        {step === 1 && !showConfirm && (
          <div className="space-y-4" onPaste={handlePaste}>
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                问题描述 <span className="text-error">*</span>
              </label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="请描述你遇到的问题..."
                rows={4}
                maxLength={5000}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {description.length}/5000
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                截图（可选，最多 {MAX_SCREENSHOTS} 张）
              </label>
              <div className="flex flex-wrap gap-2">
                {screenshots.map((_, i) => (
                  <div
                    key={i}
                    className="relative w-16 h-16 rounded-md bg-muted border border-border flex items-center justify-center text-xs text-muted-foreground"
                  >
                    截图 {i + 1}
                    <button
                      type="button"
                      onClick={() => removeScreenshot(i)}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {screenshots.length < MAX_SCREENSHOTS && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-16 h-16 rounded-md border-2 border-dashed border-border flex flex-col items-center justify-center text-muted-foreground hover:border-brand-400 hover:text-brand-500 transition-colors"
                  >
                    <ImagePlus className="w-5 h-5" />
                    <span className="text-[10px] mt-0.5">添加</span>
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                支持粘贴截图或点击添加，单张不超过 5MB
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          </div>
        )}

        {/* Confirmation when gh available */}
        {step === 1 && showConfirm && (
          <div className="text-center py-4 space-y-3">
            <p className="text-sm text-foreground">
              将以 <span className="font-semibold text-foreground">{caps?.ghUsername || 'GitHub'}</span> 的身份提交 Issue 到
            </p>
            <p className="text-sm text-muted-foreground">riba2534/happyclaw</p>
          </div>
        )}

        {/* Step 2: Preview/Edit (no gh) */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                Issue 标题
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={256}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                Issue 内容（Markdown）
              </label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                className="font-mono text-xs"
              />
            </div>

            {Object.keys(systemInfo).length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  系统信息
                </p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(systemInfo).map(([k, v]) => (
                    <span
                      key={k}
                      className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded"
                    >
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <DialogFooter>
          {step === 1 && !showConfirm && (
            <>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              <Button onClick={handleSubmitClick} disabled={loading}>
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {loading ? '分析中...' : '提交'}
              </Button>
            </>
          )}
          {step === 1 && showConfirm && (
            <>
              <Button variant="outline" onClick={() => setShowConfirm(false)}>
                取消
              </Button>
              <Button variant="outline" onClick={() => { setShowConfirm(false); handleGenerateForPreview(); }}>
                手动编辑
              </Button>
              <Button onClick={handleConfirmSubmit}>
                确认提交
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setStep(1);
                }}
              >
                返回
              </Button>
              <Button variant="outline" onClick={handleCopy}>
                <Copy className="w-4 h-4" />
                {copied ? '已复制' : '复制内容'}
              </Button>
              <Button onClick={handleManualSubmit} disabled={loading}>
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {loading ? '提交中...' : '提交 Issue'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
