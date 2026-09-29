# Data safety

MundusMaker saves entries and world settings through a single tracked queue.
Each entry stays associated with its original world. Switching worlds and
starting a restore wait for outstanding saves; failed saves keep their drafts
and prevent the operation from continuing. Slow responses preserve text typed
while the request was running.

Existing JSON files are replaced using a flushed temporary file in the same
directory, then a rename. A failed replacement never deletes the old file.
These protections do not replace a separate backup of your data folder.

## Conflicting edits

If another tab or a folder-sync tool changed a file since this page loaded it,
the save is refused. The current disk file is kept and the rejected draft is
saved under `data/.conflicts/`. Identical retries reuse the same conflict copy.
The GM save warning also offers **Download unsaved edits**, including drafts
that could not reach the server at all.

Keep the draft, reload the page, compare it with the current entry, and copy
the changes you want back into the editor. The downloaded draft contains
pending data and may contain secrets; it is not a complete world backup and
does not include image bytes. Do not share it with players.

Only edit on one device at a time, and let your folder-sync tool finish before
opening the other device. Revision checks detect changes already on local disk;
they cannot coordinate two disconnected devices or lock out an external tool
that replaces a file at the exact same moment as a save.

## Restore and recovery

Backup restore validates every entry and asset before changing the world.
Duplicate ids, invalid entries, and unsafe asset names abort the whole restore.
Unknown fields and legacy dates are preserved without clamping.

The replacement is prepared in `data/.restore-transactions/`, retaining existing
history, exports, and assets absent from an older backup. A complete safety
snapshot is required before publication. The original world is also retained
in Trash, including files a JSON backup could not read. Settings provides
copy-only recovery from Trash and snapshots.

If MundusMaker stops between the two directory renames, the next startup puts
the complete original world back before loading anything. If publication had
already finished, startup finishes archiving the previous world. Incomplete
snapshots are not shown as recoverable snapshots.

Unreadable entry files are listed in a GM-only warning and remain untouched.
JSON backup refuses to silently omit them. Copy the entire data folder before
repairing files, or restore a separate world from Settings. A corrupt
`world.json` prevents that world from loading rather than being overwritten.

## Verification

Run `npm run test:safety`. The tests use disposable temporary directories and a
separate local server. They cover interrupted writes/restores, checkpoint
failures, conflicting file edits, unreadable entries, legacy backup data,
pending-save deletion, slow responses and world switching. They never use the
owner's `data/` directory.

Browser checks for this change: normal edit/save; external-edit conflict
warning with recovery download; unreadable-file warning; recovery details
hidden in player preview. Continue using the remaining manual release checks
in AGENTS.md; these focused tests are not a full application release gate.

Existing pages opened against an older server must save their work before
upgrading. After restarting with this version, reload the app. Entity/world
writes now require a revision precondition; stale clients receive a clear
reload error instead of bypassing conflict protection.
