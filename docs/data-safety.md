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
saved in the `.conflicts` folder inside your data folder. Identical retries
reuse the same conflict copy.
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

The replacement is prepared in the data folder's `.restore-transactions`
folder, retaining existing history, exports, and assets absent from an older
backup. A complete safety
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

## After an update

Let your edits save before you upgrade: a page left open from an older version
cannot save to the new one. After restarting MundusMaker, reload the app. A
page that is out of date gets a clear message asking you to reload, instead of
overwriting newer files.

## For developers

Every entry and world write carries the revision of the file the page read;
the server refuses a missing or stale one. The source repository's
`npm run test:safety` covers the rules above with disposable temporary folders
and a separate local server: interrupted writes and restores, checkpoint
failures, conflicting file edits, unreadable entries, legacy backup data,
pending-save deletion, slow responses and world switching. It never touches a
real data folder, and it is not a full release check.
