CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );

CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      channel_context TEXT,
      turn_id TEXT,
      session_id TEXT,
      sdk_message_uuid TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      delivery_mode TEXT,
      delivery_status TEXT,
      delivery_run_id TEXT,
      delivery_priority INTEGER NOT NULL DEFAULT 0,
      delivery_updated_at TEXT,
      history_recovery_allowed INTEGER NOT NULL DEFAULT 1, task_id TEXT, automation_run_id TEXT, cost_usd REAL,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );

CREATE INDEX idx_timestamp ON messages(timestamp);

CREATE INDEX idx_messages_jid_ts ON messages(chat_jid, timestamp);

CREATE TABLE router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '', model TEXT, provider_id TEXT, agent_profile_id TEXT, identity_hash TEXT, agent_profile_version INTEGER, interaction_mode TEXT CHECK (interaction_mode IS NULL OR interaction_mode IN ('assistant', 'proactive')),
      PRIMARY KEY (group_folder, agent_id)
    );

CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    , execution_mode TEXT DEFAULT 'container', custom_cwd TEXT, init_source_path TEXT, init_git_url TEXT, avatar_url TEXT, selected_skills TEXT, target_agent_id TEXT, target_main_jid TEXT, reply_policy TEXT DEFAULT 'source_only', require_mention INTEGER DEFAULT 0, mcp_mode TEXT DEFAULT 'inherit', selected_mcps TEXT, activation_mode TEXT DEFAULT 'auto', audience_mode TEXT NOT NULL DEFAULT 'everyone', owner_im_id TEXT, owner_claim_source TEXT, conversation_source TEXT DEFAULT 'manual', conversation_nav_mode TEXT DEFAULT 'horizontal', binding_mode TEXT DEFAULT 'single_context', native_context_type TEXT DEFAULT 'none', feishu_chat_mode TEXT, feishu_group_message_type TEXT, sender_allowlist TEXT, channel_account_id TEXT);

CREATE TABLE channel_accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ref TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_legacy_default INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT NOT NULL DEFAULT 'credentials',
      auth_status TEXT NOT NULL DEFAULT 'draft',
      transport_status TEXT NOT NULL DEFAULT 'disconnected',
      status TEXT NOT NULL DEFAULT 'disconnected',
      default_agent_profile_id TEXT,
      default_workspace_jid TEXT,
      last_error TEXT,
      connected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, provider, name)
    );

CREATE INDEX idx_channel_accounts_owner_provider
      ON channel_accounts(owner_user_id, provider, updated_at DESC);

CREATE UNIQUE INDEX idx_channel_accounts_one_default
      ON channel_accounts(owner_user_id, provider) WHERE is_default = 1;

CREATE TABLE wechat_context_tokens (
      channel_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      refreshed_at_ms INTEGER NOT NULL,
      source_message_id TEXT,
      source_sequence INTEGER,
      send_count INTEGER NOT NULL DEFAULT 0,
      last_sent_at_ms INTEGER,
      PRIMARY KEY (channel_account_id, user_id),
      FOREIGN KEY (channel_account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE
    );

CREATE INDEX idx_wechat_context_tokens_refreshed
      ON wechat_context_tokens(refreshed_at_ms);

CREATE TABLE im_context_bindings (
      source_jid TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      root_message_id TEXT,
      title TEXT,
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );

CREATE INDEX idx_icb_workspace ON im_context_bindings(workspace_jid);

CREATE INDEX idx_icb_agent ON im_context_bindings(agent_id);

CREATE TABLE channel_mounts (
      channel_jid TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT,
      routing_mode TEXT NOT NULL DEFAULT 'single_session',
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      audience_mode TEXT NOT NULL DEFAULT 'everyone',
      owner_im_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , channel_account_id TEXT, interaction_mode_override TEXT CHECK (interaction_mode_override IS NULL OR interaction_mode_override IN ('assistant', 'proactive')));

CREATE INDEX idx_channel_mounts_workspace ON channel_mounts(workspace_jid);

CREATE INDEX idx_channel_mounts_session ON channel_mounts(session_id);

CREATE INDEX idx_channel_mounts_type ON channel_mounts(channel_type);

CREATE TABLE workspaces (
      jid TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_home INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE INDEX idx_workspaces_folder ON workspaces(folder);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_user_id, status);

CREATE TABLE workspace_runtime_sessions (
      group_folder TEXT NOT NULL,
      runtime_agent_id TEXT NOT NULL DEFAULT '',
      workspace_jid TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT,
      agent_profile_id TEXT,
      agent_profile_version INTEGER,
      identity_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, runtime_agent_id)
    );

CREATE INDEX idx_workspace_runtime_sessions_workspace ON workspace_runtime_sessions(workspace_jid);

CREATE INDEX idx_workspace_runtime_sessions_profile ON workspace_runtime_sessions(agent_profile_id);

CREATE TABLE agent_channel_mounts (
      channel_jid TEXT PRIMARY KEY,
      agent_profile_id TEXT,
      owner_user_id TEXT,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT,
      session_id TEXT,
      routing_mode TEXT NOT NULL DEFAULT 'single_session',
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      audience_mode TEXT NOT NULL DEFAULT 'everyone',
      owner_im_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , channel_account_id TEXT, interaction_mode_override TEXT CHECK (interaction_mode_override IS NULL OR interaction_mode_override IN ('assistant', 'proactive')));

CREATE INDEX idx_agent_channel_mounts_profile ON agent_channel_mounts(agent_profile_id);

CREATE INDEX idx_agent_channel_mounts_workspace ON agent_channel_mounts(workspace_jid);

CREATE INDEX idx_agent_channel_mounts_session ON agent_channel_mounts(session_id);

CREATE TABLE workspace_memory_stores (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );

CREATE TABLE workspace_memory_items (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'lesson', 'open_loop')),
      title TEXT,
      content TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'conflicted', 'superseded', 'deleted')),
      importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      create_idempotency_key TEXT,
      create_request_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (store_id) REFERENCES workspace_memory_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      UNIQUE (store_id, create_idempotency_key)
    );

CREATE INDEX idx_workspace_memory_items_store_status_updated
      ON workspace_memory_items(store_id, status, updated_at DESC, id DESC);

CREATE INDEX idx_workspace_memory_items_workspace_kind
      ON workspace_memory_items(workspace_jid, kind, status);

CREATE INDEX idx_workspace_memory_items_validity
      ON workspace_memory_items(store_id, valid_from, valid_until, expires_at);

CREATE TABLE workspace_memory_versions (
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workspace_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'forget')),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, revision),
      FOREIGN KEY (item_id) REFERENCES workspace_memory_items(id) ON DELETE CASCADE
    );

CREATE INDEX idx_workspace_memory_versions_workspace_created
      ON workspace_memory_versions(workspace_jid, created_at DESC);

CREATE TABLE workspace_memory_platform_items (
      item_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES workspace_memory_items(id) ON DELETE CASCADE
    );

CREATE INDEX idx_workspace_memory_platform_namespace
      ON workspace_memory_platform_items(namespace, item_id);

CREATE TABLE workspace_memory_provenance (
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('web_user', 'agent_runtime', 'scheduled_task', 'migration')),
      source_id TEXT,
      session_id TEXT,
      observed_at TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (item_id, revision),
      FOREIGN KEY (item_id, revision)
        REFERENCES workspace_memory_versions(item_id, revision) ON DELETE CASCADE
    );

CREATE TABLE workspace_memory_tombstones (
      item_id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      deleted_revision INTEGER NOT NULL,
      reason TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES workspace_memory_items(id) ON DELETE CASCADE
    );

CREATE TABLE workspace_memory_mutation_requests (
      store_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('update', 'forget')),
      item_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (store_id, idempotency_key),
      FOREIGN KEY (store_id) REFERENCES workspace_memory_stores(id) ON DELETE CASCADE
    );

CREATE TABLE workspace_memory_outbox (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    );

CREATE INDEX idx_workspace_memory_outbox_pending
      ON workspace_memory_outbox(status, available_at, created_at);

CREATE TABLE workspace_memory_audit_events (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_revision INTEGER NOT NULL,
      store_revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source_id TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_workspace_memory_audit_workspace_created
      ON workspace_memory_audit_events(workspace_jid, created_at DESC);

CREATE INDEX idx_workspace_memory_audit_store_revision
      ON workspace_memory_audit_events(store_id, store_revision);

CREATE VIRTUAL TABLE workspace_memory_fts USING fts5(
      item_id UNINDEXED,
      workspace_jid UNINDEXED,
      title,
      content,
      canonical_key,
      tokenize='trigram'
    );

CREATE VIRTUAL TABLE workspace_memory_recall_fts USING fts5(
      item_id UNINDEXED,
      workspace_jid UNINDEXED,
      scope,
      title,
      content,
      canonical_key,
      tokenize='porter unicode61 remove_diacritics 2'
    );

CREATE TRIGGER trg_workspace_memory_store_after_workspace_insert
    AFTER INSERT ON workspaces
    BEGIN
      INSERT OR IGNORE INTO workspace_memory_stores (
        id, workspace_jid, revision, created_at, updated_at
      ) VALUES (
        'wms_' || lower(hex(randomblob(16))),
        NEW.jid,
        0,
        NEW.created_at,
        NEW.updated_at
      );
    END;

CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      ai_name TEXT,
      ai_avatar_emoji TEXT,
      ai_avatar_color TEXT,
      ai_avatar_url TEXT,
      default_require_mention INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    , guest_owner_id TEXT, avatar_url TEXT, subscription_plan_id TEXT);

CREATE TABLE invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permission_template TEXT,
      permissions TEXT NOT NULL DEFAULT '[]',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

CREATE TABLE user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

CREATE TABLE auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      username TEXT NOT NULL,
      actor_username TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_auth_audit_created ON auth_audit_log(created_at);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

CREATE INDEX idx_users_status_role ON users(status, role);

CREATE INDEX idx_users_created_at ON users(created_at);

CREATE INDEX idx_invites_created_at ON invite_codes(created_at);

CREATE TABLE user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );

CREATE TABLE user_pinned_sessions (
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );

CREATE INDEX idx_user_pinned_sessions_agent
      ON user_pinned_sessions(agent_id);

CREATE TABLE session_worktrees (
      agent_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      cwd_subpath TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'broken')),
      broken_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE INDEX idx_session_worktrees_folder
      ON session_worktrees(group_folder);

CREATE TABLE workspace_onboarding_states (
      workspace_jid TEXT NOT NULL,
      flow_key TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'claimed', 'completed', 'skipped')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
      lease_expires_at TEXT,
      first_wake_at TEXT,
      completed_at TEXT,
      skipped_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_jid, flow_key),
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );

CREATE INDEX idx_workspace_onboarding_claims
      ON workspace_onboarding_states(state, lease_expires_at);

CREATE TRIGGER trg_owner_onboarding_after_home_insert
    AFTER INSERT ON workspaces
    WHEN NEW.is_home = 1
    BEGIN
      INSERT OR IGNORE INTO workspace_onboarding_states (
        workspace_jid, flow_key, state, revision, lease_owner, lease_token,
        lease_expires_at, completed_at, skipped_at, created_at, updated_at
      ) VALUES (
        NEW.jid, 'happyclaw.owner-introduction', 'pending', 0, NULL, 0,
        NULL, NULL, NULL, NEW.created_at, NEW.updated_at
      );
    END;

CREATE UNIQUE INDEX idx_workspace_memory_owner_address_unique
      ON workspace_memory_items(store_id, canonical_key)
      WHERE canonical_key = 'happyclaw.owner.preferred_address';

CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      last_im_jid TEXT,
      spawned_from_jid TEXT,
      source_kind TEXT,
      thread_id TEXT,
      root_message_id TEXT,
      title_source TEXT,
      last_active_at TEXT
    , kind TEXT NOT NULL DEFAULT 'task', automation_id TEXT);

CREATE INDEX idx_agents_group ON agents(group_folder);

CREATE INDEX idx_agents_jid ON agents(chat_jid);

CREATE INDEX idx_agents_status ON agents(status);

CREATE TABLE subagent_checkpoints (
      task_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      input_message_id TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT,
      result_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- Tenant-scoped key: a colliding or forged task_id from another
      -- workspace/chat can never touch this conversation's checkpoint.
      PRIMARY KEY (group_folder, chat_jid, task_id)
    );

CREATE INDEX idx_subagent_checkpoints_input
      ON subagent_checkpoints(group_folder, chat_jid, input_message_id);

CREATE INDEX idx_subagent_checkpoints_updated
      ON subagent_checkpoints(updated_at);

CREATE TABLE session_model_selections (
      group_folder TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      model_config_id TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL, model TEXT, reasoning_effort TEXT,
      PRIMARY KEY (group_folder, agent_id)
    );

CREATE INDEX idx_session_model_selections_model
      ON session_model_selections(model_config_id);

CREATE TABLE turn_traces (
      chat_jid TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      thinking TEXT NOT NULL DEFAULT '',
      thinking_duration_ms INTEGER,
      trace_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, steps_json TEXT NOT NULL DEFAULT '[]', steps_dropped INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_jid, turn_id)
    );

CREATE INDEX idx_turn_traces_created
      ON turn_traces(created_at);

CREATE TABLE guest_workspace_grants (
      guest_user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guest_user_id, workspace_jid)
    );

CREATE INDEX idx_guest_workspace_grants_workspace
      ON guest_workspace_grants(workspace_jid);

CREATE INDEX idx_guest_workspace_grants_owner
      ON guest_workspace_grants(owner_user_id);

CREATE INDEX idx_users_guest_owner
      ON users(guest_owner_id);

CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      include_claude_preset INTEGER NOT NULL DEFAULT 1,
      avatar_emoji TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      model_config_id TEXT,
      model TEXT,
      runtime_policy TEXT NOT NULL DEFAULT '{}',
      identity_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE UNIQUE INDEX idx_agent_profiles_default
      ON agent_profiles(owner_user_id)
      WHERE is_default = 1 AND status = 'active';

CREATE INDEX idx_agent_profiles_owner
      ON agent_profiles(owner_user_id, status);

CREATE TABLE agent_builder_drafts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      source_group TEXT NOT NULL,
      source_chat_jid TEXT NOT NULL,
      target_agent_profile_id TEXT,
      base_agent_version INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'ready',
      definition_json TEXT NOT NULL,
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      prepared_turn_id TEXT,
      confirmation_phrase TEXT NOT NULL DEFAULT '',
      published_agent_profile_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE INDEX idx_agent_builder_drafts_owner
      ON agent_builder_drafts(owner_user_id, updated_at DESC);

CREATE TABLE billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier INTEGER NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      daily_cost_quota REAL,
      weekly_cost_quota REAL,
      daily_token_quota INTEGER,
      weekly_token_quota INTEGER,
      rate_multiplier REAL NOT NULL DEFAULT 1.0,
      trial_days INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_price TEXT,
      highlight INTEGER NOT NULL DEFAULT 0,
      max_groups INTEGER,
      max_concurrent_containers INTEGER,
      max_im_channels INTEGER,
      max_mcp_servers INTEGER,
      max_storage_mb INTEGER,
      allow_overage INTEGER NOT NULL DEFAULT 0,
      features TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      expires_at TEXT,
      cancelled_at TEXT,
      trial_ends_at TEXT,
      notes TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
    );

CREATE INDEX idx_user_sub_user ON user_subscriptions(user_id);

CREATE INDEX idx_user_sub_status ON user_subscriptions(status);

CREATE TABLE user_balances (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      total_deposited_usd REAL NOT NULL DEFAULT 0,
      total_consumed_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

CREATE TABLE balance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference_type TEXT,
      reference_id TEXT,
      actor_id TEXT,
      source TEXT NOT NULL DEFAULT 'system_adjustment',
      operator_type TEXT NOT NULL DEFAULT 'system',
      notes TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_bal_tx_user ON balance_transactions(user_id);

CREATE INDEX idx_bal_tx_created ON balance_transactions(created_at);

CREATE TABLE monthly_usage (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month)
    );

CREATE TABLE redeem_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value_usd REAL,
      plan_id TEXT,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      notes TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE redeem_code_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redeemed_at TEXT NOT NULL
    );

CREATE INDEX idx_redeem_usage_user ON redeem_code_usage(user_id);

CREATE TABLE billing_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_bill_audit_user ON billing_audit_log(user_id);

CREATE INDEX idx_bill_audit_created ON billing_audit_log(created_at);

CREATE TABLE daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );

CREATE INDEX idx_daily_usage_date ON daily_usage(date);

CREATE INDEX idx_daily_usage_user_date ON daily_usage(user_id, date);

CREATE TABLE usage_records (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      usage_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE INDEX idx_usage_user_date ON usage_records(user_id, created_at);

CREATE INDEX idx_usage_group_date ON usage_records(group_folder, created_at);

CREATE INDEX idx_usage_model_date ON usage_records(model, created_at);

CREATE TABLE usage_events (
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE INDEX idx_usage_events_user_date
      ON usage_events(user_id, created_at);

CREATE INDEX idx_usage_events_group_date
      ON usage_events(group_folder, created_at);

CREATE INDEX idx_usage_events_agent_date
      ON usage_events(agent_id, created_at);

CREATE TABLE usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, model, date)
    );

CREATE INDEX idx_daily_user_date ON usage_daily_summary(user_id, date);

CREATE TABLE user_quotas (
      user_id TEXT PRIMARY KEY,
      monthly_cost_limit_usd REAL NOT NULL DEFAULT -1,
      monthly_token_limit INTEGER NOT NULL DEFAULT -1,
      daily_cost_limit_usd REAL NOT NULL DEFAULT -1,
      daily_request_limit INTEGER NOT NULL DEFAULT -1,
      billing_cycle_start TEXT,
      subscription_tier TEXT,
      subscription_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE UNIQUE INDEX idx_usage_event_model
      ON usage_records(event_id, model) WHERE event_id IS NOT NULL;

CREATE INDEX idx_usage_date ON usage_records(usage_date);

CREATE INDEX idx_usage_user_usage_date
      ON usage_records(user_id, usage_date);

CREATE INDEX idx_usage_date_created
      ON usage_records(usage_date, created_at, id);

CREATE TABLE message_ingest_sequences (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        UNIQUE (chat_jid, message_id)
      );

CREATE INDEX idx_message_ingest_sequences_chat_sequence
        ON message_ingest_sequences(chat_jid, sequence);

CREATE TRIGGER messages_assign_ingest_sequence
      AFTER INSERT ON messages
      BEGIN
        INSERT INTO message_ingest_sequences (chat_jid, message_id)
        VALUES (NEW.chat_jid, NEW.id)
        ON CONFLICT(chat_jid, message_id) DO NOTHING;
      END;

CREATE INDEX idx_messages_follow_up_queue
      ON messages(chat_jid, delivery_status, delivery_priority, timestamp, id);

CREATE INDEX idx_messages_history_recovery
      ON messages(chat_jid, history_recovery_allowed, timestamp);

CREATE INDEX idx_messages_chat_turn_ts
      ON messages(chat_jid, turn_id, timestamp);

CREATE INDEX idx_messages_status_chat
      ON messages(delivery_status, chat_jid);

CREATE INDEX idx_agents_automation ON agents(automation_id);

CREATE INDEX idx_rg_target_agent ON registered_groups(target_agent_id);

CREATE INDEX idx_rg_target_main ON registered_groups(target_main_jid);

CREATE UNIQUE INDEX idx_bal_tx_idempotency ON balance_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_agent_profiles_model_config
      ON agent_profiles(model_config_id)
      WHERE model_config_id IS NOT NULL;

CREATE INDEX idx_rg_folder ON registered_groups(folder);

CREATE INDEX idx_rg_channel_account
      ON registered_groups(channel_account_id);

CREATE INDEX idx_channel_mounts_account
      ON channel_mounts(channel_account_id);

CREATE INDEX idx_agent_channel_mounts_account
      ON agent_channel_mounts(channel_account_id);

CREATE TABLE "workspace_agent_profiles" (
          group_folder TEXT PRIMARY KEY,
          agent_profile_id TEXT NOT NULL,
          interaction_mode TEXT NOT NULL DEFAULT 'assistant'
            CHECK (interaction_mode IN ('assistant', 'proactive')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , process_visibility TEXT NOT NULL DEFAULT 'hidden' CHECK (process_visibility IN ('hidden', 'activity', 'full')), work_mode TEXT NOT NULL DEFAULT 'single' CHECK (work_mode IN ('single', 'multi')));

CREATE INDEX idx_workspace_agent_profiles_profile
          ON workspace_agent_profiles(agent_profile_id);

CREATE TABLE channel_inbox (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      raw_payload TEXT,
      normalized_payload TEXT,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(provider, account_id, external_message_id)
    );

CREATE INDEX idx_channel_inbox_nonterminal
      ON channel_inbox(status, available_at, lease_expires_at, created_at);

CREATE INDEX idx_channel_inbox_route
      ON channel_inbox(provider, account_id, source_jid, created_at DESC);

CREATE TABLE channel_cursors (
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      cursor TEXT NOT NULL,
      position INTEGER NOT NULL,
      tie_breaker TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, account_id, scope, chat_id)
    );

CREATE INDEX idx_channel_cursors_account
      ON channel_cursors(provider, account_id, updated_at DESC);

CREATE TABLE turn_runs (
      id TEXT PRIMARY KEY,
      inbox_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      agent_id TEXT,
      session_id TEXT,
      correlation_id TEXT,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (inbox_id) REFERENCES channel_inbox(id) ON DELETE SET NULL
    );

CREATE UNIQUE INDEX idx_turn_runs_inbox
      ON turn_runs(inbox_id) WHERE inbox_id IS NOT NULL;

CREATE INDEX idx_turn_runs_nonterminal
      ON turn_runs(status, available_at, lease_expires_at, created_at);

CREATE INDEX idx_turn_runs_session
      ON turn_runs(session_id, status, created_at);

CREATE INDEX idx_turn_runs_route
      ON turn_runs(provider, account_id, source_jid, created_at DESC);

CREATE TABLE channel_outbox (
      id TEXT PRIMARY KEY,
      turn_run_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      payload TEXT,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      provider_upload_key TEXT,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(turn_run_id, ordinal),
      FOREIGN KEY (turn_run_id) REFERENCES turn_runs(id) ON DELETE CASCADE
    );

CREATE INDEX idx_channel_outbox_nonterminal
      ON channel_outbox(status, available_at, lease_expires_at, created_at);

CREATE INDEX idx_channel_outbox_run
      ON channel_outbox(turn_run_id, ordinal);

CREATE INDEX idx_channel_outbox_route
      ON channel_outbox(provider, account_id, source_jid, created_at DESC);

CREATE TABLE streaming_cards (
      id TEXT PRIMARY KEY,
      turn_run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_jid TEXT NOT NULL,
      chat_id TEXT,
      root_id TEXT,
      thread_id TEXT,
      message_id TEXT,
      card_id TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      snapshot TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (turn_run_id) REFERENCES turn_runs(id) ON DELETE CASCADE
    );

CREATE INDEX idx_streaming_cards_run
      ON streaming_cards(turn_run_id);

CREATE INDEX idx_streaming_cards_nonterminal
      ON streaming_cards(status, updated_at, created_at);

CREATE INDEX idx_streaming_cards_message
      ON streaming_cards(provider, account_id, message_id);

CREATE TABLE usage_limit_waits (
      scope_key TEXT PRIMARY KEY,
      input_key TEXT NOT NULL,
      wait_count INTEGER NOT NULL,
      reset_at TEXT NOT NULL,
      resume_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE session_history_reinjections (
      group_folder TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_id)
    );

CREATE TABLE usage_event_connections (
      event_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

CREATE TABLE web_message_dedup (
      user_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, chat_jid, client_message_id)
    );

CREATE INDEX idx_web_message_dedup_created
      ON web_message_dedup(created_at);

CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      created_by TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      stop_when TEXT,
      schedule_kind TEXT NOT NULL,
      cron_expr TEXT,
      timezone TEXT,
      interval_ms INTEGER,
      run_at TEXT,
      end_at TEXT,
      session_mode TEXT NOT NULL,
      target_session_jid TEXT,
      delivery_route_jid TEXT,
      silent_when_idle INTEGER NOT NULL DEFAULT 0,
      pre_run_check_command TEXT,
      pre_run_check_timeout_ms INTEGER,
      execution TEXT NOT NULL DEFAULT 'agent',
      script_command TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      next_fire_at TEXT,
      last_fired_at TEXT,
      last_finished_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE INDEX idx_automations_due
      ON automations(status, next_fire_at);

CREATE INDEX idx_automations_workspace
      ON automations(workspace_jid);

CREATE INDEX idx_automations_target_session
      ON automations(target_session_jid);

CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL
        REFERENCES automations(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      session_jid TEXT,
      input_message_id TEXT,
      scheduled_for TEXT NOT NULL,
      fired_at TEXT,
      finished_at TEXT,
      result_text TEXT,
      error TEXT,
      pre_check_json TEXT,
      silenced INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_automation_runs_automation_created
      ON automation_runs(automation_id, created_at);

CREATE INDEX idx_automation_runs_session
      ON automation_runs(session_jid);

CREATE UNIQUE INDEX idx_automation_runs_one_live
      ON automation_runs(automation_id)
      WHERE status IN ('queued', 'running');

CREATE TABLE automation_failure_streaks (
      automation_id TEXT PRIMARY KEY,
      error_key TEXT NOT NULL,
      error_text TEXT NOT NULL,
      failure_count INTEGER NOT NULL,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL
    );

CREATE TABLE team_mounts (
      channel_jid TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      router_agent_id TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );

CREATE INDEX idx_team_mounts_workspace
      ON team_mounts(workspace_jid);

CREATE INDEX idx_team_mounts_router
      ON team_mounts(router_agent_id);

CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      seq INTEGER NOT NULL,
      channel_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_route_jid TEXT NOT NULL,
      mandate_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      outcome TEXT,
      last_report TEXT,
      last_summary TEXT,
      attention TEXT,
      attention_message_id TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      origin TEXT NOT NULL DEFAULT 'team' CHECK (origin IN ('team', 'delegated')),
      origin_agent_id TEXT,
      origin_input_id TEXT,
      UNIQUE (workspace_jid, seq),
      UNIQUE (channel_jid, source_message_id)
    );

CREATE INDEX idx_work_items_workspace
      ON work_items(workspace_jid, status, updated_at);

CREATE INDEX idx_work_items_agent
      ON work_items(agent_id);

CREATE TABLE work_item_subscriptions (
      work_item_id TEXT NOT NULL,
      channel_jid TEXT NOT NULL,
      sub_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (work_item_id, channel_jid, sub_key)
    );

CREATE INDEX idx_work_item_subscriptions_key
      ON work_item_subscriptions(channel_jid, sub_key);

CREATE TABLE work_item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT,
      text TEXT NOT NULL DEFAULT '',
      trigger_message_id TEXT,
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_work_item_events_item
      ON work_item_events(work_item_id, id);

CREATE UNIQUE INDEX idx_work_item_events_ack
      ON work_item_events(trigger_message_id)
      WHERE kind = 'ack' AND trigger_message_id IS NOT NULL;

CREATE INDEX idx_work_item_events_trigger
      ON work_item_events(work_item_id, kind, trigger_message_id);

CREATE TABLE work_decisions (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      channel_jid TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      strength TEXT NOT NULL,
      kind TEXT NOT NULL,
      work_item_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      matched_rule_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_work_decisions_workspace
      ON work_decisions(workspace_jid, created_at);

CREATE INDEX idx_work_decisions_trigger
      ON work_decisions(channel_jid, trigger_message_id);

CREATE TABLE work_item_replies (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      work_item_id TEXT,
      channel_jid TEXT NOT NULL,
      quote_message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      purpose TEXT NOT NULL,
      lane_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      provider_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE INDEX idx_work_item_replies_status
      ON work_item_replies(status, created_at);

CREATE INDEX idx_work_item_replies_posted
      ON work_item_replies(channel_jid, provider_message_id);

CREATE INDEX idx_work_items_channel
      ON work_items(channel_jid, status, updated_at);

CREATE INDEX idx_work_items_origin_agent
      ON work_items(origin_agent_id, status);

CREATE TABLE router_cursors (
      kind TEXT NOT NULL CHECK (kind IN ('next_pull', 'committed')),
      chat_jid TEXT NOT NULL,
      cursor TEXT NOT NULL,
      PRIMARY KEY (kind, chat_jid)
    ) WITHOUT ROWID;
