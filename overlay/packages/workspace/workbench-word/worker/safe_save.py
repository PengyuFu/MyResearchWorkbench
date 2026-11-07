"""Windows file identity and recoverable no-overwrite publication."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import uuid
from contextlib import contextmanager
from ctypes import wintypes
import win32con
import win32file
import win32security

class WordFailure(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.details = code, details or {}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def durable(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def durable_json(path, data):
    durable(path, json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf8"))

@contextmanager
def held(path, access, share, creation=win32con.OPEN_EXISTING, flags=0):
    handle = win32file.CreateFile(str(path), access, share, None, creation, flags, None)
    try:
        yield handle
    finally:
        handle.Close()

def file_identity(handle):
    info = win32file.GetFileInformationByHandle(handle)
    return "%s:%s:%s" % (info[4], info[8], info[9])

def read_handle(handle, limit=64 * 1024 * 1024):
    size = win32file.GetFileSize(handle)
    if size > limit:
        raise WordFailure("too-large", "The document exceeds the supported size.", {"limit": limit})
    win32file.SetFilePointer(handle, 0, 0)
    chunks = []
    remaining = size
    while remaining:
        _, data = win32file.ReadFile(handle, min(remaining, 1024 * 1024))
        if not data:
            raise WordFailure("changed", "The file changed while being read.")
        chunks.append(data)
        remaining -= len(data)
    return b"".join(chunks)

def confined(root, target):
    root, target = Path(root).resolve(), Path(target)
    if not target.is_absolute() or str(target).startswith("\\\\"):
        raise WordFailure("outside-workspace", "Choose a local file in this workspace.")
    if ":" in str(target)[2:] or "\0" in str(target):
        raise WordFailure("outside-workspace", "Alternate streams are not supported.")
    # Refuse all links/junctions between the canonical workspace and destination.
    resolved = target.resolve()
    try:
        relative = target.relative_to(root)
        resolved.relative_to(root)
    except ValueError:
        raise WordFailure("outside-workspace", "The document is outside this workspace.")
    current = root
    for part in relative.parts:
        current = current / part
        if current.exists() and win32file.GetFileAttributes(str(current)) & win32con.FILE_ATTRIBUTE_REPARSE_POINT:
            raise WordFailure("outside-workspace", "Open the actual file instead of a link.")
    if str(resolved).casefold() != str(target).casefold():
        raise WordFailure("changed", "The file location changed.")
    return resolved

def reject_extra_streams(target):
    if any(name != "::$DATA" for size,name in win32file.FindStreams(str(target))):
        raise WordFailure("security-stream","This file has security markers or additional data streams. The workbench leaves them unchanged; open a trusted self-contained document.")

def read_original(root, target):
    target = confined(root, target)
    with held(target, win32con.GENERIC_READ, win32con.FILE_SHARE_READ,
              flags=0x00200000) as handle:
        info = win32file.GetFileInformationByHandle(handle)
        if info[0] & win32con.FILE_ATTRIBUTE_DIRECTORY or info[7] != 1:
            raise WordFailure("unsupported", "Choose a regular file without hard-link aliases.")
        reject_extra_streams(target)
        data = read_handle(handle)
        return data, {"sha256": sha(data), "identity": file_identity(handle)}

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel.SetFileInformationByHandle.restype = wintypes.BOOL

def rename_owned(handle, destination):
    name = str(Path(destination).absolute())
    count = len(name.encode("utf-16-le")) // 2
    class RenameInfo(ctypes.Structure):
        _fields_ = [("ReplaceIfExists", wintypes.BOOL), ("RootDirectory", wintypes.HANDLE),
                    ("FileNameLength", wintypes.DWORD), ("FileName", wintypes.WCHAR * (count + 1))]
    # Win32 resolves this DOS path as a NUL-terminated string; reserve the terminator
    # even though FileNameLength excludes it. Without it, adjacent memory can enter the name.
    info = RenameInfo(False, None, count * 2, name)
    if not kernel.SetFileInformationByHandle(int(handle), 3, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())

def copy_security(source, destination, protected_override=None):
    descriptor = win32security.GetSecurityInfo(source, win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION | win32security.OWNER_SECURITY_INFORMATION | win32security.GROUP_SECURITY_INFORMATION)
    protected = bool(descriptor.GetSecurityDescriptorControl()[0] & win32security.SE_DACL_PROTECTED)
    if protected_override is not None: protected = protected_override
    inheritance = win32security.PROTECTED_DACL_SECURITY_INFORMATION if protected else win32security.UNPROTECTED_DACL_SECURITY_INFORMATION
    win32security.SetSecurityInfo(destination, win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION | win32security.OWNER_SECURITY_INFORMATION | win32security.GROUP_SECURITY_INFORMATION | inheritance,
        descriptor.GetSecurityDescriptorOwner(), descriptor.GetSecurityDescriptorGroup(), descriptor.GetSecurityDescriptorDacl(), None)

WRITE_OWNED = win32con.GENERIC_READ | win32con.GENERIC_WRITE | win32con.DELETE | win32con.WRITE_DAC | win32con.WRITE_OWNER

def transaction_paths(record, directory):
    """Validate journal paths against the service-owned directory, never a caller-supplied backup root."""
    directory = Path(directory).resolve()
    transaction = record.get("transaction", "")
    if record.get("version") != 2 or len(transaction) != 32 or any(c not in "0123456789abcdef" for c in transaction):
        raise WordFailure("recovery-invalid", "The save recovery record is not supported.")
    target = confined(record["root"], record["target"])
    temporary = target.with_name("." + target.name + ".mrw-" + transaction + ".tmp")
    displaced = target.with_name("." + target.name + ".mrw-" + transaction + ".original.tmp")
    backup = directory / "backups" / ("backup-" + transaction + ".docx")
    if any(str(expected) != record.get(key) for key, expected in
           (("temporary", temporary), ("displaced", displaced), ("backup", backup))):
        raise WordFailure("recovery-invalid", "The save recovery paths are invalid.")
    confined(directory, backup)
    return target, temporary, displaced, backup

def commit(root, target, data, baseline, journal_dir, request_id):
    """Copy the checked original to private app data before a no-overwrite publication.

    The short-lived displaced original stays on the target volume. The durable backup
    can be on another volume; neither rename nor recovery assumes matching drives.
    """
    target = confined(root, target)
    if target.suffix.lower() != ".docx":
        raise WordFailure("unsupported", "Save as a .docx file.")
    directory = Path(journal_dir).resolve()
    backups = directory / "backups"
    backups.mkdir(exist_ok=True)
    transaction = uuid.uuid4().hex
    temporary = target.with_name("." + target.name + ".mrw-" + transaction + ".tmp")
    displaced = target.with_name("." + target.name + ".mrw-" + transaction + ".original.tmp")
    backup = backups / ("backup-" + transaction + ".docx")
    confined(directory, backup)
    journal = directory / ("save-" + transaction + ".json")
    record = {"version": 2, "transaction": transaction, "requestId": request_id, "target": str(target), "root": str(root),
              "temporary": str(temporary), "displaced": str(displaced), "backup": str(backup), "old": baseline,
              "newHash": sha(data), "phase": "prepared"}
    moved = published = False
    original = None
    try:
        with held(target.parent, win32con.GENERIC_READ, win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE,
                  flags=win32con.FILE_FLAG_BACKUP_SEMANTICS):
            if baseline is not None:
                original = win32file.CreateFile(str(target), win32con.GENERIC_READ | win32con.DELETE,
                    win32con.FILE_SHARE_READ, None, win32con.OPEN_EXISTING, 0x00200000, None)
                info = win32file.GetFileInformationByHandle(original)
                reject_extra_streams(target)
                if info[0] & (win32con.FILE_ATTRIBUTE_READONLY | win32con.FILE_ATTRIBUTE_REPARSE_POINT) or info[7] != 1:
                    raise WordFailure("read-only", "The original is read-only or no longer a regular file.")
                old_data = read_handle(original)
                if file_identity(original) != baseline["identity"] or sha(old_data) != baseline["sha256"]:
                    raise WordFailure("conflict", "The original changed outside the workbench.")
                with held(backup, WRITE_OWNED, 0, win32con.CREATE_NEW) as retained:
                    original_security = win32security.GetSecurityInfo(original, win32security.SE_FILE_OBJECT,
                        win32security.DACL_SECURITY_INFORMATION)
                    record["originalDaclProtected"] = bool(original_security.GetSecurityDescriptorControl()[0] & win32security.SE_DACL_PROTECTED)
                    copy_security(original, retained, True)
                    win32file.WriteFile(retained, old_data)
                    win32file.FlushFileBuffers(retained)
                    record["backupIdentity"] = file_identity(retained)
            elif target.exists():
                raise WordFailure("conflict", "A file already exists at this destination.")
            with held(temporary, WRITE_OWNED, 0, win32con.CREATE_NEW) as staged:
                if original is not None:
                    copy_security(original, staged)
                win32file.WriteFile(staged, data)
                win32file.FlushFileBuffers(staged)
                durable_json(journal, record)
                if original is not None:
                    rename_owned(original, displaced)
                    moved = True
                    record["phase"] = "original-retained"
                    durable_json(journal, record)
                # ReplaceIfExists is FALSE: an external creator keeps its bytes.
                rename_owned(staged, target)
                published = True
                win32file.FlushFileBuffers(staged)
                result = {"sha256": sha(data), "identity": file_identity(staged)}
                record.update(phase="committed", result=result)
                durable_json(journal, record)
            return {"baseline": result, "recovery": str(journal)}
    except Exception as error:
        if moved and not published and original is not None and not target.exists():
            try:
                rename_owned(original, target)
                record["phase"] = "rolled-back"
            except OSError:
                record["phase"] = "needs-recovery"
        else:
            record["phase"] = "committed-unacknowledged" if published else "needs-recovery" if moved else "not-committed"
        record["diagnostic"] = str(error)
        try:
            durable_json(journal, record)
        except OSError:
            pass  # The flushed prepared journal and both data copies remain recoverable.
        if isinstance(error, WordFailure):
            raise
        raise WordFailure("save-failed", "Saving failed; the original and draft have been retained.",
                          {"phase": record["phase"]}) from error
    finally:
        if original is not None:
            original.Close()
        if published:
            temporary.unlink(missing_ok=True)

def checked_backup(record, directory):
    target, temporary, displaced, backup = transaction_paths(record, directory)
    with held(backup, win32con.GENERIC_READ, win32con.FILE_SHARE_READ) as handle:
        data = read_handle(handle)
        if record.get("old") is None or sha(data) != record["old"]["sha256"] or file_identity(handle) != record.get("backupIdentity"):
            raise WordFailure("recovery-invalid", "The retained original changed.")
    return backup

def recover_commit(record, directory):
    """Restore only a missing target, including from a backup on another volume."""
    target, temporary, displaced, backup = transaction_paths(record, directory)
    if target.exists():
        data, actual = read_original(record["root"], target)
        return "committed" if sha(data) == record["newHash"] else "retained"
    if displaced.exists() and record.get("old") is not None:
        with held(displaced, win32con.GENERIC_READ | win32con.DELETE, win32con.FILE_SHARE_READ) as handle:
            if sha(read_handle(handle)) != record["old"]["sha256"] or file_identity(handle) != record["old"]["identity"]:
                raise WordFailure("recovery-invalid", "The displaced original changed.")
            try:
                rename_owned(handle, target)
            except OSError:
                if target.exists(): return "retained"
                raise
        return "restored-original"
    if backup.exists() and record.get("old") is not None:
        checked_backup(record, directory)
        restoration = target.with_name("." + target.name + ".mrw-" + record["transaction"] + ".restore.tmp")
        confined(record["root"], restoration)
        with held(backup, win32con.GENERIC_READ, win32con.FILE_SHARE_READ) as source:
            data = read_handle(source)
            if sha(data) != record["old"]["sha256"] or file_identity(source) != record["backupIdentity"]:
                raise WordFailure("recovery-invalid", "The retained original changed.")
            # A previous interrupted restore is never overwritten or mistaken for a checkpoint.
            with held(restoration, WRITE_OWNED, 0, win32con.CREATE_NEW) as staged:
                copy_security(source, staged, record["originalDaclProtected"])
                win32file.WriteFile(staged, data)
                win32file.FlushFileBuffers(staged)
                try:
                    rename_owned(staged, target)
                except OSError:
                    if target.exists(): return "retained"
                    raise
        return "restored-original"
    return "retained"

def remove_transaction_file(path, expected_hash, expected_identity=None):
    if not path.exists(): return
    with held(path, win32con.GENERIC_READ | win32con.DELETE, 0) as handle:
        if sha(read_handle(handle)) != expected_hash or expected_identity is not None and file_identity(handle) != expected_identity:
            raise WordFailure("recovery-invalid", "A transaction file changed; it has been retained.")
        # Delete through the verified, exclusive handle, never a path that can be replaced.
        disposition = wintypes.BOOL(True)
        if not kernel.SetFileInformationByHandle(int(handle), 4, ctypes.byref(disposition), ctypes.sizeof(disposition)):
            raise ctypes.WinError(ctypes.get_last_error())

def finish_commit(journal_path, directory):
    """Acknowledge only after the document metadata and checkpoint are durable."""
    journal_path, directory = Path(journal_path), Path(directory).resolve()
    record = json.loads(journal_path.read_text("utf8"))
    target, temporary, displaced, backup = transaction_paths(record, directory)
    if journal_path != directory / ("save-" + record["transaction"] + ".json") or record["phase"] != "committed":
        raise WordFailure("recovery-invalid", "The save has not been confirmed.")
    _, actual = read_original(record["root"], target)
    if actual != record["result"]:
        raise WordFailure("conflict", "The saved file changed before cleanup; its recovery files remain.")
    pointer = directory / "backup.json"
    previous = record.get("previousBackup")
    if "previousBackup" not in record:
        previous = json.loads(pointer.read_text("utf8")) if pointer.exists() else None
        record["previousBackup"] = previous
        durable_json(journal_path, record)
    if previous is not None: transaction_paths(previous, directory)
    # Every unfinished transaction owns its backup. Never rotate it away.
    unresolved = set()
    for other in directory.glob("save-*.json"):
        value = json.loads(other.read_text("utf8"))
        transaction_paths(value, directory)
        if other != journal_path: unresolved.add(value["backup"])
    if record["old"] is not None:
        checked_backup(record, directory)
        durable_json(pointer, {key: value for key, value in record.items() if key != "previousBackup"})
    if displaced.exists():
        remove_transaction_file(displaced, record["old"]["sha256"], record["old"]["identity"])
    if temporary.exists():
        remove_transaction_file(temporary, record["newHash"])
    if record["old"] is not None and previous is not None and previous["backup"] != str(backup) and previous["backup"] not in unresolved:
        prior = checked_backup(previous, directory)
        remove_transaction_file(prior, previous["old"]["sha256"], previous["backupIdentity"])
    journal_path.unlink()

def clean_terminal_journals(directory, saved_requests):
    """Clean confirmed saves or verified rollbacks; uncertain phases stay intact."""
    directory = Path(directory).resolve()
    for journal in directory.glob("save-*.json"):
        record = json.loads(journal.read_text("utf8"))
        target, temporary, displaced, backup = transaction_paths(record, directory)
        phase = record["phase"]
        if phase == "committed" and record["requestId"] in saved_requests:
            finish_commit(journal, directory)
        elif phase in ("rolled-back", "not-committed"):
            if displaced.exists(): continue
            if phase == "rolled-back":
                _, actual = read_original(record["root"], target)
                if actual != record["old"]: continue
            if temporary.exists(): remove_transaction_file(temporary, record["newHash"])
            if backup.exists():
                checked_backup(record, directory)
                remove_transaction_file(backup, record["old"]["sha256"], record["backupIdentity"])
            journal.unlink()
