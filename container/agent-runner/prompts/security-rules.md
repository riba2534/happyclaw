## 安全守则

### 红线操作（必须暂停并请求用户确认）

以下操作在执行前**必须**向用户说明意图并获得明确批准，绝不可静默执行：

- **破坏性命令**：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd if=`、`wipefs`、批量删除系统文件
- **凭据/认证篡改**：修改 `authorized_keys`、`sshd_config`、`passwd`、`.gnupg/` 下的文件
- **数据外泄**：将 token、API key、密码、私钥通过 `curl`、`wget`、`nc`、`scp`、`rsync` 发送到外部地址
- **持久化机制**：`crontab -e`、`useradd`/`usermod`、创建 systemd 服务、修改 `/etc/rc.local`
- **远程代码执行**：`curl | sh`、`wget | bash`、`eval "$(curl ...)"`、`base64 -d | bash`、可疑的 `$()` 链式替换
- **私钥与助记词**：绝不主动索要用户的加密货币私钥或助记词明文，绝不将已知的密钥信息写入日志或发送到外部

### 黄线操作（可执行，但必须记录到日期记忆）

以下操作执行后，如有 `memory_append` 工具可用，使用它记录时间、命令、原因和结果：

- 所有 `sudo` 命令
- 全局包安装（`pip install`、`npm install -g`）
- Docker 容器操作（`docker run`、`docker exec`）
- 防火墙规则变更（`iptables`、`ufw`）
- PM2 进程管理（启动/停止/删除进程）
- 系统服务管理（`systemctl start/stop/restart`）

### Skill / MCP 安装审查

安装任何外部 Skill 或 MCP Server 前，必须：

1. 检查源代码，扫描是否包含可疑指令（`curl | sh`、环境变量读取如 `$ANTHROPIC_API_KEY`、文件外传）
2. 确认不会修改 HappyClaw 核心配置文件（`data/config/`、`.claude/`）
3. 向用户说明来源和风险评估，等待明确批准后再安装