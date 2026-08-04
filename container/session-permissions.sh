#!/bin/bash

# Container/host identity and session-permission helpers. This file is sourced
# by entrypoint.sh and is kept side-effect free so its behavior can be tested in
# an otherwise stock agent image.

HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=0
HAPPYCLAW_MOUNT_PREPARE_MODE=none
HAPPYCLAW_SESSION_PERMISSION_PID=
HAPPYCLAW_SESSION_PERMISSION_PROCESS_GROUP=0

happyclaw_valid_nonroot_id() {
  local value="$1"
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null && [ "$value" -le 2147483647 ] 2>/dev/null
}

happyclaw_warn_identity() {
  printf 'happyclaw: %s\n' "$1" >&2
}

happyclaw_write_runtime_ids() {
  local runtime_user="$1"
  local runtime_uid="$2"
  local runtime_gid="$3"
  local passwd_file="${HAPPYCLAW_PASSWD_FILE:-/etc/passwd}"
  local temporary

  temporary=$(mktemp /etc/happyclaw-passwd.XXXXXX) || return 1
  if ! awk -F: -v OFS=: -v user="$runtime_user" \
    -v uid="$runtime_uid" -v gid="$runtime_gid" '
      $1 == user { $3 = uid; $4 = gid; found = 1 }
      { print }
      END { if (!found) exit 42 }
    ' "$passwd_file" > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  chmod 0644 "$temporary"
  chown root:root "$temporary"
  mv "$temporary" "$passwd_file"
}

happyclaw_configure_node_identity() {
  local runtime_user="${HAPPYCLAW_RUNTIME_USER:-node}"
  local mode="${HAPPYCLAW_HOST_IDENTITY_MODE:-unknown}"
  local requested_uid="${HAPPYCLAW_HOST_UID:-}"
  local requested_gid="${HAPPYCLAW_HOST_GID:-}"
  local current_uid current_gid target_uid target_gid existing_name

  HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=0
  HAPPYCLAW_MOUNT_PREPARE_MODE=none
  case "$mode" in
    direct) ;;
    namespaced | virtualized | unknown)
      # Numeric host ids are not meaningful in a user namespace or Docker
      # Desktop VM. Keep the image's non-root account and share only the mount
      # roots; the event-driven reconciler is scoped to the session mount.
      HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=1
      HAPPYCLAW_MOUNT_PREPARE_MODE=shared
      export HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS HAPPYCLAW_MOUNT_PREPARE_MODE
      return 0
      ;;
    host-root)
      # The host backend can read every uid. Prepare only explicit writable
      # mounts for node and keep the running agent non-root.
      HAPPYCLAW_MOUNT_PREPARE_MODE=recursive
      export HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS HAPPYCLAW_MOUNT_PREPARE_MODE
      return 0
      ;;
    *)
      happyclaw_warn_identity "unknown host identity mode '$mode'; numeric uid/gid remapping disabled"
      HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=1
      HAPPYCLAW_MOUNT_PREPARE_MODE=shared
      export HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS HAPPYCLAW_MOUNT_PREPARE_MODE
      return 0
      ;;
  esac

  current_uid=$(id -u "$runtime_user")
  current_gid=$(id -g "$runtime_user")
  target_uid="$current_uid"
  target_gid="$current_gid"

  # UID and GID are validated and remapped independently. Never turn the
  # runtime account into root, even when HappyClaw itself runs as host root.
  if [ -n "$requested_gid" ]; then
    if ! happyclaw_valid_nonroot_id "$requested_gid"; then
      happyclaw_warn_identity "refusing unsafe host gid '$requested_gid'; keeping gid $current_gid"
    elif [ "$requested_gid" != "$current_gid" ]; then
      # A numeric gid can already have a different group name (for example
      # nogroup=65534). Keep node's named primary group aligned with passwd so
      # setpriv --init-groups and chown node:node remain deterministic.
      if groupmod --non-unique --gid "$requested_gid" "$runtime_user"; then
        target_gid="$requested_gid"
      else
        happyclaw_warn_identity "could not remap $runtime_user to gid $requested_gid"
      fi
    fi
  fi

  if [ -z "$requested_uid" ]; then
    happyclaw_warn_identity 'direct identity mode did not provide a host uid; using permission reconciliation'
    HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=1
  elif ! happyclaw_valid_nonroot_id "$requested_uid"; then
    happyclaw_warn_identity "refusing unsafe host uid '$requested_uid'; keeping uid $current_uid"
    HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=1
  elif [ "$requested_uid" != "$current_uid" ]; then
    existing_name=$(getent passwd "$requested_uid" | cut -d: -f1 || true)
    if [ -n "$existing_name" ]; then
      happyclaw_warn_identity "uid $requested_uid already belongs to $existing_name; using permission reconciliation"
      HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=1
    else
      target_uid="$requested_uid"
    fi
  fi

  # Edit only node's passwd record. usermod recursively changes ownership under
  # the account home when its uid/gid changes, making startup proportional to
  # the complete bind-mounted session history.
  if [ "$target_uid" != "$current_uid" ] || [ "$target_gid" != "$current_gid" ]; then
    if ! happyclaw_write_runtime_ids "$runtime_user" "$target_uid" "$target_gid"; then
      happyclaw_warn_identity "could not update passwd identity for $runtime_user; using permission reconciliation"
      HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS=1
    fi
  fi

  if [ "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS" = 1 ]; then
    HAPPYCLAW_MOUNT_PREPARE_MODE=shared
  else
    HAPPYCLAW_MOUNT_PREPARE_MODE=root
  fi

  # Bind-mounted content already has the direct host uid. Only the image home
  # root needs ownership repair after changing the passwd record.
  chown --no-dereference "$runtime_user:$(id -gn "$runtime_user")" \
    "/home/$runtime_user" 2>/dev/null || true
  export HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS HAPPYCLAW_MOUNT_PREPARE_MODE
}

happyclaw_prepare_mounted_path() {
  local path="$1"
  local runtime_user="${HAPPYCLAW_RUNTIME_USER:-node}"
  [ -e "$path" ] || return 0

  case "$HAPPYCLAW_MOUNT_PREPARE_MODE" in
    recursive)
      chown -R --no-dereference "$runtime_user:$(id -gn "$runtime_user")" \
        "$path" 2>/dev/null || true
      ;;
    root)
      chown --no-dereference "$runtime_user:$(id -gn "$runtime_user")" \
        "$path" 2>/dev/null || true
      ;;
    shared)
      # Namespace/VM mappings are intentionally not translated numerically.
      # The host creates writable mount roots; repair only that root here.
      if [ -d "$path" ]; then
        chmod a+rwx "$path" 2>/dev/null || true
      else
        chmod a+rw "$path" 2>/dev/null || true
      fi
      ;;
  esac
}

happyclaw_relax_session_permissions() {
  local session_root="${HAPPYCLAW_SESSION_ROOT:-/home/node/.claude}"
  [ -d "$session_root" ] || return 0

  # One startup/cleanup traversal repairs restrictive files left by an older
  # container. Both predicates share one find walk; nested mounts and symlink
  # targets are never traversed.
  find "$session_root" -xdev \
    \( -type d ! -perm -0007 -exec chmod a+rwx {} + \) -o \
    \( -type f ! -perm -0006 -exec chmod a+rw {} + \) \
    2>/dev/null || true
}

happyclaw_relax_session_path() {
  local changed_path="$1"
  local session_root="${HAPPYCLAW_SESSION_ROOT:-/home/node/.claude}"
  [ -e "$changed_path" ] || return 0

  # inotify supplies paths below session_root. Defend in depth against a
  # malformed event and avoid following a symlink moved into the session.
  case "$changed_path" in
    "$session_root" | "$session_root"/*) ;;
    *) return 0 ;;
  esac
  find "$changed_path" -xdev \
    \( -type d ! -perm -0007 -exec chmod a+rwx {} + \) -o \
    \( -type f ! -perm -0006 -exec chmod a+rw {} + \) \
    2>/dev/null || true
}

happyclaw_start_session_permission_polling() {
  (
    while sleep 30; do
      happyclaw_relax_session_permissions
    done
  ) &
  HAPPYCLAW_SESSION_PERMISSION_PID=$!
  HAPPYCLAW_SESSION_PERMISSION_PROCESS_GROUP=0
}

happyclaw_start_session_permission_reconciler() {
  local session_root="${HAPPYCLAW_SESSION_ROOT:-/home/node/.claude}"
  local status_dir attempt watch_ready=0

  [ "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS" = 1 ] || return 0
  [ -d "$session_root" ] || return 0

  if command -v inotifywait >/dev/null 2>&1 && command -v setsid >/dev/null 2>&1; then
    status_dir=$(mktemp -d /tmp/happyclaw-session-watcher.XXXXXX)
    export HAPPYCLAW_SESSION_ROOT="$session_root"
    export HAPPYCLAW_SESSION_PERMISSION_HELPER="${BASH_SOURCE[0]}"
    export HAPPYCLAW_SESSION_PERMISSION_STATUS_DIR="$status_dir"

    # A dedicated process group lets cleanup terminate inotifywait, the path
    # consumer, and a degraded polling loop together. NUL-delimited paths are
    # safe for whitespace/newlines; chmod is event-scoped after the one startup
    # scan instead of repeatedly traversing the complete session tree.
    setsid bash -c '
      set -o pipefail
      source "$HAPPYCLAW_SESSION_PERMISSION_HELPER"
      LC_ALL=C inotifywait --monitor --recursive --no-dereference \
        --event create,moved_to,attrib,close_write \
        --format "%w%f%0" --no-newline "$HAPPYCLAW_SESSION_ROOT" \
        2> >(
          while IFS= read -r line; do
            if [ "$line" = "Watches established." ]; then
              : > "$HAPPYCLAW_SESSION_PERMISSION_STATUS_DIR/ready"
            fi
          done
        ) |
        while IFS= read -r -d "" changed_path; do
          happyclaw_relax_session_path "$changed_path"
        done

      : > "$HAPPYCLAW_SESSION_PERMISSION_STATUS_DIR/fallback"
      while true; do
        happyclaw_relax_session_permissions
        sleep 30
      done
    ' &
    HAPPYCLAW_SESSION_PERMISSION_PID=$!
    HAPPYCLAW_SESSION_PERMISSION_PROCESS_GROUP=1

    # Do not start the unprivileged agent until recursive watches are active;
    # this closes the startup-scan/watch-registration race. Bound the wait so a
    # pathological tree degrades to low-frequency polling instead of hanging.
    for ((attempt = 0; attempt < 500; attempt++)); do
      if [ -e "$status_dir/ready" ] || [ -e "$status_dir/fallback" ]; then
        watch_ready=1
        break
      fi
      if ! kill -0 "$HAPPYCLAW_SESSION_PERMISSION_PID" 2>/dev/null; then
        break
      fi
      sleep 0.02
    done

    if [ "$watch_ready" != 1 ]; then
      happyclaw_warn_identity 'session permission watcher did not become ready; using 30s polling fallback'
      kill -- "-$HAPPYCLAW_SESSION_PERMISSION_PID" 2>/dev/null || true
      wait "$HAPPYCLAW_SESSION_PERMISSION_PID" 2>/dev/null || true
      HAPPYCLAW_SESSION_PERMISSION_PID=
      HAPPYCLAW_SESSION_PERMISSION_PROCESS_GROUP=0
      happyclaw_start_session_permission_polling
    fi
    happyclaw_relax_session_permissions
    rm -rf -- "$status_dir"
  else
    happyclaw_warn_identity 'inotifywait unavailable; using 30s session permission polling fallback'
    happyclaw_start_session_permission_polling
    happyclaw_relax_session_permissions
  fi
}

happyclaw_stop_session_permission_reconciler() {
  if [ -n "$HAPPYCLAW_SESSION_PERMISSION_PID" ]; then
    if [ "$HAPPYCLAW_SESSION_PERMISSION_PROCESS_GROUP" = 1 ]; then
      kill -- "-$HAPPYCLAW_SESSION_PERMISSION_PID" 2>/dev/null || true
    else
      kill "$HAPPYCLAW_SESSION_PERMISSION_PID" 2>/dev/null || true
    fi
    wait "$HAPPYCLAW_SESSION_PERMISSION_PID" 2>/dev/null || true
    HAPPYCLAW_SESSION_PERMISSION_PID=
    HAPPYCLAW_SESSION_PERMISSION_PROCESS_GROUP=0
  fi
  if [ "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS" = 1 ]; then
    happyclaw_relax_session_permissions
  fi
}
