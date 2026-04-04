import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'token', 'password', 'secret', 'apiKey', 'api_key',
      'authorization', 'cookie', 'sessionId',
      '*.token', '*.password', '*.secret', '*.apiKey', '*.api_key',
      '*.authorization', '*.cookie', '*.sessionId',
      '*.appSecret', '*.app_secret', '*.appId',
      '*.anthropicApiKey', '*.anthropicAuthToken',
      '*.botToken', '*.bot_token',
    ],
    censor: '[REDACTED]',
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    },
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
  // 不立即退出：unhandled rejection 通常非致命（如 API 超时未 catch），
  // 立即 exit 会导致长期运行服务丢失正在处理的消息和容器管理状态。
  // uncaughtException 仍保持 exit(1)，因为异常会破坏进程状态。
});
