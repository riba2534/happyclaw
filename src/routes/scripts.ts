import { Hono } from 'hono';
import { execSync } from 'child_process';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { getAllScripts, getScriptById, deleteScript as deleteScriptFromDb, type Script } from '../db.js';

/** Only admin can manage host-level scripts */
function requireAdmin(c: any): Response | null {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }
  return null;
}

const router = new Hono<{ Variables: Variables }>();

interface PM2Process {
  name: string;
  pid: number;
  pm2_env: {
    status: string;
    pm_uptime: number;
    restart_time: number;
    pm_exec_path: string;
  };
  monit: {
    cpu: number;
    memory: number;
  };
}

function pm2List(): PM2Process[] {
  try {
    const output = execSync('pm2 jlist', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return JSON.parse(output);
  } catch (err) {
    logger.warn({ err }, 'Failed to run pm2 jlist');
    return [];
  }
}

function pm2Action(action: string, name: string): boolean {
  try {
    execSync(`pm2 ${action} ${JSON.stringify(name)}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return true;
  } catch (err) {
    logger.warn({ err, action, name }, 'PM2 action failed');
    return false;
  }
}

function runShellCommand(command: string): boolean {
  try {
    execSync(command, { encoding: 'utf-8', timeout: 10000 });
    return true;
  } catch (err) {
    logger.warn({ err, command }, 'Shell command failed');
    return false;
  }
}

function checkCommandStatus(command: string): 'online' | 'stopped' {
  try {
    execSync(command, { timeout: 5000 });
    return 'online';
  } catch {
    return 'stopped';
  }
}

function buildScriptResponse(script: Script, pm2Processes: PM2Process[]) {
  let status: string = 'registered';
  let pid: number | null = null;
  let cpu: number | null = null;
  let memory: number | null = null;
  let uptime: number | null = null;
  let restarts: number | null = null;

  if (script.process_manager === 'pm2' && script.pm2_name) {
    const proc = pm2Processes.find((p) => p.name === script.pm2_name);
    if (proc) {
      status = proc.pm2_env.status;
      pid = proc.pid;
      cpu = proc.monit.cpu;
      memory = proc.monit.memory;
      uptime = proc.pm2_env.pm_uptime;
      restarts = proc.pm2_env.restart_time;
    } else {
      status = 'stopped';
    }
  } else if (script.check_command) {
    status = checkCommandStatus(script.check_command);
  }

  return {
    id: script.id,
    name: script.name,
    description: script.description,
    scriptPath: script.script_path,
    processManager: script.process_manager,
    pm2Name: script.pm2_name,
    startCommand: script.start_command,
    stopCommand: script.stop_command,
    checkCommand: script.check_command,
    groupFolder: script.group_folder,
    createdAt: script.created_at,
    status,
    pid,
    cpu,
    memory,
    uptime,
    restarts,
  };
}

// GET /api/scripts — list registered scripts (admin only)
router.get('/', authMiddleware, async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const dbScripts = getAllScripts();
  const pm2Processes = pm2List();

  const scripts = dbScripts.map((s) => buildScriptResponse(s, pm2Processes));
  return c.json({ scripts });
});

// POST /api/scripts/:id/start (admin only)
router.post('/:id/start', authMiddleware, async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const script = getScriptById(c.req.param('id'));
  if (!script) return c.json({ error: 'Script not found' }, 404);

  let ok = false;
  if (script.process_manager === 'pm2' && script.pm2_name) {
    ok = pm2Action('start', script.pm2_name);
  } else if (script.start_command) {
    ok = runShellCommand(script.start_command);
  }
  return c.json({ success: ok });
});

// POST /api/scripts/:id/stop (admin only)
router.post('/:id/stop', authMiddleware, async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const script = getScriptById(c.req.param('id'));
  if (!script) return c.json({ error: 'Script not found' }, 404);

  let ok = false;
  if (script.process_manager === 'pm2' && script.pm2_name) {
    ok = pm2Action('stop', script.pm2_name);
  } else if (script.stop_command) {
    ok = runShellCommand(script.stop_command);
  }
  return c.json({ success: ok });
});

// POST /api/scripts/:id/restart (admin only)
router.post('/:id/restart', authMiddleware, async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const script = getScriptById(c.req.param('id'));
  if (!script) return c.json({ error: 'Script not found' }, 404);

  let ok = false;
  if (script.process_manager === 'pm2' && script.pm2_name) {
    ok = pm2Action('restart', script.pm2_name);
  } else {
    // stop + start
    if (script.stop_command) runShellCommand(script.stop_command);
    if (script.start_command) {
      ok = runShellCommand(script.start_command);
    }
  }
  return c.json({ success: ok });
});

// DELETE /api/scripts/:id (admin only)
router.delete('/:id', authMiddleware, async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const script = getScriptById(c.req.param('id'));
  if (!script) return c.json({ error: 'Script not found' }, 404);

  // Stop process first
  try {
    if (script.process_manager === 'pm2' && script.pm2_name) {
      pm2Action('stop', script.pm2_name);
      pm2Action('delete', script.pm2_name);
    } else if (script.stop_command) {
      runShellCommand(script.stop_command);
    }
  } catch (err) {
    logger.warn({ err, id: script.id }, 'Failed to stop script during delete');
  }

  deleteScriptFromDb(script.id);
  return c.json({ success: true });
});

export default router;
