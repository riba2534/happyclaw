#!/usr/bin/env python3
"""Descriptor-relative workspace mutations for the HappyClaw host.

All path components are opened relative to an already-open directory with
O_NOFOLLOW. This keeps the final write/delete/mkdir inside the workspace even
when another process concurrently replaces an ancestor with a symlink.
"""

import base64
import errno
import json
import os
import secrets
import stat
import sys


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(1)


def relative_parts(value: object) -> list[str]:
    if not isinstance(value, str) or "\0" in value or os.path.isabs(value):
        fail("Invalid workspace-relative path")
    normalized = value.replace("\\", "/")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        fail("Invalid workspace-relative path")
    return parts


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_parent(root_fd: int, parts: list[str], create: bool) -> tuple[int, str]:
    current_fd = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            try:
                next_fd = os.open(component, DIRECTORY_FLAGS, dir_fd=current_fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o700, dir_fd=current_fd)
                next_fd = os.open(component, DIRECTORY_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd, parts[-1]
    except Exception:
        os.close(current_fd)
        raise


def existing_safe_leaf_mode(
    parent_fd: int, leaf: str, must_exist: bool
) -> int | None:
    try:
        info = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        if must_exist:
            fail("File not found")
        return None
    if stat.S_ISLNK(info.st_mode):
        fail("Refusing to overwrite symbolic link")
    if not stat.S_ISREG(info.st_mode):
        fail("Target is not a regular file")
    return stat.S_IMODE(info.st_mode)


def write_file(root_fd: int, request: dict[str, object]) -> None:
    parts = relative_parts(request.get("path"))
    parent_fd, leaf = open_parent(
        root_fd, parts, bool(request.get("createParents", False))
    )
    temporary = f".{leaf}.happyclaw-{secrets.token_hex(12)}.tmp"
    temporary_created = False
    try:
        existing_mode = existing_safe_leaf_mode(
            parent_fd, leaf, bool(request.get("mustExist", False))
        )
        encoded = request.get("dataBase64")
        if not isinstance(encoded, str):
            fail("File data is required")
        data = base64.b64decode(encoded, validate=True)
        file_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=parent_fd,
        )
        temporary_created = True
        try:
            # Atomic replacement must not silently turn an executable into a
            # data file or broaden a private file from 0600 to 0644. Direct
            # writes preserve an existing inode's mode, so mirror that contract
            # on the temporary inode before replacing the leaf.
            if existing_mode is not None:
                os.fchmod(file_fd, existing_mode)
            view = memoryview(data)
            while view:
                written = os.write(file_fd, view)
                if written <= 0:
                    raise OSError("Short workspace file write")
                view = view[written:]
            os.fsync(file_fd)
        finally:
            os.close(file_fd)
        os.replace(
            temporary,
            leaf,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
        )
        temporary_created = False
        os.fsync(parent_fd)
    finally:
        if temporary_created:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)


def make_directory(root_fd: int, request: dict[str, object]) -> None:
    parts = relative_parts(request.get("path"))
    parent_fd, leaf = open_parent(root_fd, parts, True)
    try:
        try:
            os.mkdir(leaf, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            fail("Directory already exists")
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def delete_directory_contents(directory_fd: int) -> None:
    for name in os.listdir(directory_fd):
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=directory_fd)
            try:
                delete_directory_contents(child_fd)
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)


def delete_entry(root_fd: int, request: dict[str, object]) -> None:
    parts = relative_parts(request.get("path"))
    parent_fd, leaf = open_parent(root_fd, parts, False)
    try:
        info = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            target_fd = os.open(leaf, DIRECTORY_FLAGS, dir_fd=parent_fd)
            try:
                delete_directory_contents(target_fd)
            finally:
                os.close(target_fd)
            os.rmdir(leaf, dir_fd=parent_fd)
        else:
            os.unlink(leaf, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def parse_range_header(range_header: str, file_size: int) -> tuple[int, int] | None:
    if file_size <= 0:
        return None
    import re
    m = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
    if not m:
        return None
    raw_start, raw_end = m.group(1), m.group(2)
    if not raw_start and not raw_end:
        return None
    if not raw_start:
        try:
            suffix_length = int(raw_end)
        except ValueError:
            return None
        if suffix_length <= 0:
            return None
        if suffix_length >= file_size:
            return 0, file_size - 1
        return file_size - suffix_length, file_size - 1
    try:
        start = int(raw_start)
    except ValueError:
        return None
    if start < 0 or start >= file_size:
        return None
    if raw_end:
        try:
            parsed_end = int(raw_end)
        except ValueError:
            return None
        if parsed_end < start:
            return None
        return start, min(parsed_end, file_size - 1)
    else:
        return start, file_size - 1


def stream_bytes(file_fd: int, total_bytes: int) -> None:
    remaining = total_bytes
    chunk_size = 64 * 1024
    try:
        while remaining > 0:
            to_read = min(chunk_size, remaining)
            chunk = os.read(file_fd, to_read)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass


def read_file(root_fd: int, request: dict[str, object]) -> None:
    parts = relative_parts(request.get("path"))
    parent_fd, leaf = open_parent(root_fd, parts, False)
    file_fd = -1
    try:
        try:
            file_fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        except (FileNotFoundError, IsADirectoryError):
            fail("File not found")
        except NotADirectoryError:
            fail("Symlink traversal detected")
        except OSError as e:
            if e.errno == errno.ELOOP:
                fail("Symlink traversal detected")
            raise
    finally:
        os.close(parent_fd)

    try:
        info = os.fstat(file_fd)
        if stat.S_ISLNK(info.st_mode):
            fail("Symlink traversal detected")
        if not stat.S_ISREG(info.st_mode):
            fail("Target is not a regular file")

        file_size = info.st_size
        mtime_ms = int(info.st_mtime * 1000)

        max_bytes = request.get("maxBytes")
        if isinstance(max_bytes, (int, float)) and file_size > max_bytes:
            fail(f"File too large to read (max {int(max_bytes)} bytes)")

        range_header = request.get("rangeHeader")
        is_range_request = isinstance(range_header, str) and range_header.strip() != ""

        if is_range_request:
            normalized_range = str(range_header).strip()
            if normalized_range.lower().startswith("bytes=") and "," not in normalized_range:
                parsed = parse_range_header(normalized_range, file_size)
                if parsed is None:
                    header = {
                        "ok": True,
                        "size": file_size,
                        "mtimeMs": mtime_ms,
                        "isRangeRequest": True,
                        "rangeSatisfiable": False,
                        "contentLength": 0,
                    }
                    sys.stdout.buffer.write(json.dumps(header).encode("utf-8") + b"\n")
                    sys.stdout.buffer.flush()
                    return

                start, end = parsed
                content_length = end - start + 1
                header = {
                    "ok": True,
                    "size": file_size,
                    "mtimeMs": mtime_ms,
                    "isRangeRequest": True,
                    "rangeSatisfiable": True,
                    "start": start,
                    "end": end,
                    "contentLength": content_length,
                }
                sys.stdout.buffer.write(json.dumps(header).encode("utf-8") + b"\n")
                sys.stdout.buffer.flush()

                os.lseek(file_fd, start, os.SEEK_SET)
                stream_bytes(file_fd, content_length)
                return

        header = {
            "ok": True,
            "size": file_size,
            "mtimeMs": mtime_ms,
            "isRangeRequest": False,
            "rangeSatisfiable": True,
            "start": 0,
            "end": max(0, file_size - 1),
            "contentLength": file_size,
        }
        sys.stdout.buffer.write(json.dumps(header).encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()

        stream_bytes(file_fd, file_size)
    finally:
        if file_fd >= 0:
            os.close(file_fd)


def main() -> None:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            fail("Invalid request")
        root = request.get("root")
        if not isinstance(root, str) or not os.path.isabs(root):
            fail("Invalid workspace root")
        root_fd = os.open(root, DIRECTORY_FLAGS)
        try:
            operation = request.get("operation")
            if operation == "write_file":
                write_file(root_fd, request)
                print(json.dumps({"ok": True}))
            elif operation == "mkdir":
                make_directory(root_fd, request)
                print(json.dumps({"ok": True}))
            elif operation == "delete":
                delete_entry(root_fd, request)
                print(json.dumps({"ok": True}))
            elif operation == "read_file":
                read_file(root_fd, request)
            else:
                fail("Unsupported workspace mutation")
        finally:
            os.close(root_fd)
    except SystemExit:
        raise
    except FileNotFoundError:
        fail("File or directory not found")
    except NotADirectoryError:
        fail("Symlink traversal detected")
    except OSError as error:
        if error.errno == errno.ELOOP:
            fail("Symlink traversal detected")
        fail(f"Safe workspace mutation failed: {error}")
    except Exception as error:
        fail(f"Safe workspace mutation failed: {error}")


if __name__ == "__main__":
    main()
