//! A one-shot census of the open vault, for Vault Settings → Health.
//!
//! Answers "what is actually in this vault, and what is the local store costing
//! me": how many notes/folders/attachments and how many bytes, the biggest
//! files, the heaviest local CRDT history (including orphan docs nothing can
//! reach any more), the index file's own size, and a 12-week strip of how many
//! notes were modified.
//!
//! Shape contract: `src/lib/health/types.ts` `VaultStats`. Every struct here is
//! `camelCase`-renamed so the JSON matches that file field for field; changing a
//! field name here without changing it there breaks the Health page silently.
//!
//! Cost: ONE `walkdir` pass plus four aggregate queries. No file contents are
//! read — only `metadata()` — so this stays cheap on a several-thousand-note
//! vault and can be recomputed on demand.
//!
//! Ignore rules are the tree's (`vault::is_ignored_name`): `.context/`, `.git`,
//! dotfiles/dot-dirs and the heavy `DENIED_DIRS` are never descended into. The
//! extension allowlist (`vault::ALLOWED_EXTS`) deliberately does NOT apply — a
//! `.csv` sitting next to your notes costs disk whether or not the sidebar
//! surfaces it, and `otherFiles` is where the user should see it.

use crate::error::AppResult;
use crate::index::Index;
use crate::vault::{is_ignored_name, rel_from_abs};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::Metadata;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

/// The vault-root directory that holds binary attachments. Mirrors the literal
/// `attachments.rs` confines every binary write to (`ensure_attachment_rel`);
/// a file under it is an attachment, everything else is not.
const ATTACHMENTS_DIR: &str = "attachments";

/// How many rows the "largest"/"heaviest" lists carry (the contract says 10).
const TOP_N: usize = 10;

/// Buckets in the activity strip, newest last (index 11 contains now).
const ACTIVITY_WEEKS: usize = 12;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const WEEK_MS: i64 = 7 * DAY_MS;

/// One file, for the "largest" lists. `bytes` is the on-disk size and `mtime`
/// is **milliseconds** since the epoch (the index's own `notes.mtime` column is
/// seconds — this is the disk value, not that one).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SizedFile {
    pub path: String,
    pub bytes: i64,
    pub mtime: i64,
}

/// One doc's local CRDT footprint: its update log plus its snapshot. `path` is
/// `None` for an orphan — a doc the `notes` table no longer knows, i.e. history
/// for a note that was deleted, rebound or forked. Those are reclaimable.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFootprint {
    pub doc_id: String,
    pub path: Option<String>,
    pub updates: i64,
    pub bytes: i64,
}

/// Files the index treats as notes (rows in `notes`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStats {
    pub count: i64,
    pub bytes: i64,
    /// Notes whose file is 0 bytes — the shape a never-hydrated server note has.
    pub empty: i64,
}

/// A count + byte total for one class of file.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGroup {
    pub count: i64,
    pub bytes: i64,
}

/// `index.sqlite` itself, WAL and shared-memory files included.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub bytes: i64,
}

/// The local CRDT store in aggregate.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub docs: i64,
    pub updates: i64,
    pub bytes: i64,
    pub orphan_docs: i64,
    pub orphan_bytes: i64,
}

/// How much of the vault has been touched lately.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStats {
    pub modified_last7d: i64,
    pub modified_last30d: i64,
    /// Notes modified per 7-day window, OLDEST first; index 11 is the window
    /// ending now. Anything older than 12 windows is dropped.
    pub weeks: Vec<i64>,
}

/// The whole census. See the module doc for the cost and the ignore rules.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStats {
    pub computed_at: i64,
    pub notes: NoteStats,
    pub folders: i64,
    pub attachments: FileGroup,
    pub other_files: FileGroup,
    pub tags: i64,
    pub links: i64,
    pub broken_links: i64,
    pub index: IndexStats,
    pub history: HistoryStats,
    pub largest_notes: Vec<SizedFile>,
    pub largest_files: Vec<SizedFile>,
    pub heaviest_history: Vec<HistoryFootprint>,
    pub activity: ActivityStats,
}

/// Take the census. `index` must be the index of `vault` — the caller holds the
/// index mutex for the duration, so this does no locking of its own.
/// `live_docs` is the registry's doc-id map (`docId → relPath`) for the open
/// vault. A note pulled down from the server can carry a registry doc id that
/// differs from its local `notes.id`, so its history is keyed by an id the
/// `notes` table has never heard of. Counting that as an orphan reported "18
/// notes reclaimable" while the sweep — which unions the SAME registry ids into
/// its live set (`crdtGc.ts`) — correctly removed nothing. Orphan here must mean
/// exactly what `prune_yjs_docs` would remove, so the two agree by construction.
pub fn collect(
    vault: &Path,
    index: &Index,
    live_docs: &HashMap<String, String>,
) -> AppResult<VaultStats> {
    let computed_at = now_ms();

    // What the index calls a note. This is the ONLY classifier: a `.md` file the
    // index has not picked up yet counts as an "other file" until it does, which
    // is exactly the discrepancy the Health page exists to surface.
    let mut id_by_path: HashMap<String, String> = HashMap::new();
    let mut path_by_id: HashMap<String, String> = HashMap::new();
    for (id, path) in index.note_paths()? {
        path_by_id.insert(id.clone(), path.clone());
        id_by_path.insert(path, id);
    }

    let mut folders = 0i64;
    let mut notes: Vec<SizedFile> = Vec::with_capacity(id_by_path.len());
    let mut attachments: Vec<SizedFile> = Vec::new();
    let mut others: Vec<SizedFile> = Vec::new();
    let attachments_prefix = format!("{ATTACHMENTS_DIR}/");

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            // Never descend into .context/.git/dotfolders/node_modules — same
            // predicate `Index::rebuild` and the watcher use.
            let name = e.file_name().to_string_lossy();
            !(e.depth() > 0 && is_ignored_name(&name))
        })
        .filter_map(|e| e.ok())
    {
        if entry.depth() == 0 {
            continue; // the vault root is not one of its own folders
        }
        let file_type = entry.file_type();
        if file_type.is_dir() {
            folders += 1;
            continue;
        }
        if !file_type.is_file() {
            continue; // symlinks, sockets, devices: not ours to count
        }
        // A file that vanished between the walk and the stat (a save in flight,
        // a sync materialising) is skipped rather than failing the whole census.
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(rel) = rel_from_abs(vault, entry.path()) else {
            continue;
        };
        let file = SizedFile {
            path: rel.clone(),
            bytes: meta.len() as i64,
            mtime: mtime_ms(&meta),
        };
        if id_by_path.contains_key(&rel) {
            notes.push(file);
        } else if rel.starts_with(&attachments_prefix) {
            attachments.push(file);
        } else {
            others.push(file);
        }
    }

    let note_stats = NoteStats {
        count: notes.len() as i64,
        bytes: notes.iter().map(|f| f.bytes).sum(),
        empty: notes.iter().filter(|f| f.bytes == 0).count() as i64,
    };
    let attachment_group = FileGroup {
        count: attachments.len() as i64,
        bytes: attachments.iter().map(|f| f.bytes).sum(),
    };
    let other_group = FileGroup {
        count: others.len() as i64,
        bytes: others.iter().map(|f| f.bytes).sum(),
    };

    let activity = activity_from(&notes, computed_at);

    let largest_notes = top_files(notes);
    let mut rest = attachments;
    rest.extend(others);
    let largest_files = top_files(rest);

    // ---- Index-side aggregates -------------------------------------------
    let link_counts = index.link_counts()?;
    let mut history = HistoryStats::default();
    let mut footprints: Vec<HistoryFootprint> = Vec::new();
    for doc in index.history_footprints()? {
        let path = path_by_id
            .get(&doc.doc_id)
            .or_else(|| live_docs.get(&doc.doc_id))
            .cloned();
        history.docs += 1;
        history.updates += doc.updates;
        history.bytes += doc.bytes;
        if path.is_none() {
            history.orphan_docs += 1;
            history.orphan_bytes += doc.bytes;
        }
        footprints.push(HistoryFootprint {
            doc_id: doc.doc_id,
            path,
            updates: doc.updates,
            bytes: doc.bytes,
        });
    }
    // Heaviest first; doc_id breaks ties so two calls agree.
    footprints.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.doc_id.cmp(&b.doc_id)));
    footprints.truncate(TOP_N);

    Ok(VaultStats {
        computed_at,
        notes: note_stats,
        folders,
        attachments: attachment_group,
        other_files: other_group,
        tags: index.tag_count()?,
        links: link_counts.resolved,
        broken_links: link_counts.broken,
        index: IndexStats {
            bytes: index_file_bytes(vault),
        },
        history,
        largest_notes,
        largest_files,
        heaviest_history: footprints,
        activity,
    })
}

/// Largest first, ties broken by path so repeated censuses agree.
fn top_files(mut files: Vec<SizedFile>) -> Vec<SizedFile> {
    files.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    files.truncate(TOP_N);
    files
}

/// The 7/30-day tallies and the 12-week strip, from note mtimes only.
///
/// Buckets are rolling 7-day windows ending *now*, not ISO weeks: the strip is
/// read as "how much did I write recently", and a calendar-aligned first bucket
/// would be a partial week that looks like a slump. A file dated in the future
/// (clock skew, a restored backup) lands in the newest bucket rather than
/// underflowing out of the strip.
fn activity_from(notes: &[SizedFile], now_ms: i64) -> ActivityStats {
    let mut weeks = vec![0i64; ACTIVITY_WEEKS];
    let mut last7 = 0i64;
    let mut last30 = 0i64;
    for note in notes {
        let age = now_ms - note.mtime;
        if age < 7 * DAY_MS {
            last7 += 1;
        }
        if age < 30 * DAY_MS {
            last30 += 1;
        }
        let bucket = if age < 0 { 0 } else { age / WEEK_MS };
        if bucket < ACTIVITY_WEEKS as i64 {
            weeks[ACTIVITY_WEEKS - 1 - bucket as usize] += 1;
        }
    }
    ActivityStats {
        modified_last7d: last7,
        modified_last30d: last30,
        weeks,
    }
}

/// `index.sqlite` plus its `-wal`/`-shm` siblings. The WAL is the half that
/// surprises people: it can be larger than the database after a heavy sync, and
/// a user looking at "why is `.context` 900 MB" needs it counted.
fn index_file_bytes(vault: &Path) -> i64 {
    let base = vault.join(".context").join("index.sqlite");
    let mut total = 0i64;
    for suffix in ["", "-wal", "-shm"] {
        let path = if suffix.is_empty() {
            base.clone()
        } else {
            let mut name = base.as_os_str().to_os_string();
            name.push(suffix);
            std::path::PathBuf::from(name)
        };
        if let Ok(meta) = std::fs::metadata(&path) {
            total += meta.len() as i64;
        }
    }
    total
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Modification time in MILLISECONDS since the epoch. 0 when the platform has
/// no mtime for the file, which sorts it to the oldest bucket.
fn mtime_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A vault with one of everything the census has to tell apart.
    fn fixture() -> (tempfile::TempDir, Index) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        fs::write(root.join("Alpha.md"), "# Alpha\n\nlinks to [[Beta]] and [[Ghost]]\n#work\n")
            .unwrap();
        fs::write(root.join("Empty.md"), "").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/Beta.md"), "# Beta\n").unwrap();

        // An attachment (under the vault-root attachments/ store).
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("attachments/pic.png"), [1u8, 2, 3, 4, 5]).unwrap();

        // Not a note, not an attachment → otherFiles.
        fs::write(root.join("data.csv"), "a,b\n1,2\n").unwrap();

        // Everything below must be invisible to the census.
        fs::write(root.join(".hidden.md"), "secret").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x".repeat(4096)).unwrap();

        let index = Index::open(root).unwrap();
        // `.context/` exists now; drop a stray file in it to prove it is skipped.
        fs::write(root.join(".context/junk"), "x".repeat(1024)).unwrap();
        index.rebuild(root).unwrap();
        (tmp, index)
    }

    fn doc_id_of(index: &Index, rel: &str) -> String {
        index
            .note_paths()
            .unwrap()
            .into_iter()
            .find(|(_, path)| path == rel)
            .map(|(id, _)| id)
            .expect("note should be indexed")
    }

    #[test]
    fn counts_notes_folders_attachments_and_other_files() {
        let (tmp, index) = fixture();
        let stats = collect(tmp.path(), &index, &HashMap::new()).unwrap();

        assert_eq!(stats.notes.count, 3, "Alpha, Empty, sub/Beta");
        assert_eq!(stats.notes.empty, 1, "Empty.md is 0 bytes");
        let expected_note_bytes = fs::metadata(tmp.path().join("Alpha.md")).unwrap().len()
            + fs::metadata(tmp.path().join("sub/Beta.md")).unwrap().len();
        assert_eq!(stats.notes.bytes, expected_note_bytes as i64);

        // `sub` and `attachments` only: node_modules and .context are not walked.
        assert_eq!(stats.folders, 2);

        assert_eq!(stats.attachments.count, 1);
        assert_eq!(stats.attachments.bytes, 5);

        assert_eq!(stats.other_files.count, 1, "data.csv only");
        assert_eq!(stats.other_files.bytes, 8);

        assert!(stats.computed_at > 0);
    }

    #[test]
    fn index_aggregates_follow_the_sqlite_tables() {
        let (tmp, index) = fixture();
        let stats = collect(tmp.path(), &index, &HashMap::new()).unwrap();

        assert_eq!(stats.tags, 1, "#work");
        assert_eq!(stats.links, 1, "[[Beta]] resolves");
        assert_eq!(stats.broken_links, 1, "[[Ghost]] does not");
        assert!(stats.index.bytes > 0, "index.sqlite exists on disk");
    }

    #[test]
    fn a_registry_live_doc_is_not_an_orphan_and_borrows_its_path() {
        // A note pulled from the server keeps a registry doc id the local `notes`
        // table never assigned. Its history must count as live — the sweep's live
        // set includes registry ids — or the page claims space Reclaim cannot free.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.md"), b"# a").unwrap();
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        index.append_yjs_update("registry-id", &[0u8; 64]).unwrap();
        index.append_yjs_update("truly-orphan", &[0u8; 32]).unwrap();
        let mut live = HashMap::new();
        live.insert("registry-id".to_string(), "a.md".to_string());
        let stats = collect(tmp.path(), &index, &live).unwrap();
        assert_eq!(stats.history.orphan_docs, 1);
        assert_eq!(stats.history.orphan_bytes, 32);
        let reg = stats
            .heaviest_history
            .iter()
            .find(|h| h.doc_id == "registry-id")
            .unwrap();
        assert_eq!(reg.path.as_deref(), Some("a.md"));
    }

    #[test]
    fn history_separates_orphans_and_ranks_by_bytes() {
        let (tmp, index) = fixture();
        let alpha = doc_id_of(&index, "Alpha.md");
        let beta = doc_id_of(&index, "sub/Beta.md");

        index.append_yjs_update(&alpha, &[0u8; 64]).unwrap();
        index.append_yjs_update(&alpha, &[0u8; 32]).unwrap();
        index.append_yjs_update(&beta, &[0u8; 8]).unwrap();
        // A doc the notes table has never heard of — deleted, rebound or forked.
        index.append_yjs_update("orphan-doc", &[0u8; 128]).unwrap();

        let stats = collect(tmp.path(), &index, &HashMap::new()).unwrap();
        assert_eq!(stats.history.docs, 3);
        assert_eq!(stats.history.updates, 4);
        assert_eq!(stats.history.bytes, 64 + 32 + 8 + 128);
        assert_eq!(stats.history.orphan_docs, 1);
        assert_eq!(stats.history.orphan_bytes, 128);

        let heaviest = &stats.heaviest_history;
        assert_eq!(heaviest.len(), 3);
        assert_eq!(heaviest[0].doc_id, "orphan-doc");
        assert_eq!(heaviest[0].bytes, 128);
        assert_eq!(heaviest[0].path, None, "an orphan has no path");
        assert_eq!(heaviest[1].doc_id, alpha);
        assert_eq!(heaviest[1].updates, 2);
        assert_eq!(heaviest[1].path.as_deref(), Some("Alpha.md"));
        assert_eq!(heaviest[2].doc_id, beta);
    }

    #[test]
    fn snapshot_bytes_count_toward_a_docs_footprint() {
        let (tmp, index) = fixture();
        let alpha = doc_id_of(&index, "Alpha.md");
        index.append_yjs_update(&alpha, &[0u8; 10]).unwrap();
        index.save_yjs_snapshot(&alpha, &[0u8; 100], &[0u8; 4]).unwrap();
        // A manifest-only row (snapshot NULL) is not history and must not count.
        index
            .save_yjs_state_vectors(&[("sv-only".to_string(), vec![0u8; 16])])
            .unwrap();

        let stats = collect(tmp.path(), &index, &HashMap::new()).unwrap();
        assert_eq!(stats.history.docs, 1, "the state-vector-only doc is skipped");
        let alpha_row = stats
            .heaviest_history
            .iter()
            .find(|f| f.doc_id == alpha)
            .unwrap();
        // The snapshot replaces the compacted log, so only its bytes remain.
        assert_eq!(alpha_row.bytes, 100);
        assert_eq!(stats.history.bytes, 100);
    }

    #[test]
    fn largest_lists_are_biggest_first_and_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for i in 0..15 {
            fs::write(root.join(format!("n{i:02}.md")), "x".repeat(100 + i)).unwrap();
            fs::create_dir_all(root.join("attachments")).unwrap();
            fs::write(
                root.join(format!("attachments/a{i:02}.bin")),
                vec![0u8; 10 + i],
            )
            .unwrap();
        }
        let index = Index::open(root).unwrap();
        index.rebuild(root).unwrap();
        let stats = collect(root, &index, &HashMap::new()).unwrap();

        assert_eq!(stats.largest_notes.len(), TOP_N);
        assert_eq!(stats.largest_notes[0].path, "n14.md");
        assert!(stats
            .largest_notes
            .windows(2)
            .all(|w| w[0].bytes >= w[1].bytes));

        assert_eq!(stats.largest_files.len(), TOP_N);
        assert_eq!(stats.largest_files[0].path, "attachments/a14.bin");
        assert!(stats
            .largest_files
            .windows(2)
            .all(|w| w[0].bytes >= w[1].bytes));
        // Notes never appear in largestFiles, even though they are bigger.
        assert!(stats.largest_files.iter().all(|f| !f.path.ends_with(".md")));
    }

    #[test]
    fn activity_buckets_are_oldest_first_with_now_last() {
        let now = 100 * WEEK_MS; // a round "now" so the arithmetic is readable
        let at = |days: i64| SizedFile {
            path: format!("n{days}.md"),
            bytes: 1,
            mtime: now - days * DAY_MS,
        };
        let notes = vec![
            at(0),   // today
            at(3),   // this week
            at(9),   // one week back
            at(40),  // five weeks back
            at(200), // older than the strip → dropped
            SizedFile {
                path: "future.md".into(),
                bytes: 1,
                mtime: now + DAY_MS, // clock skew clamps into the newest bucket
            },
        ];
        let activity = activity_from(&notes, now);

        assert_eq!(activity.weeks.len(), ACTIVITY_WEEKS);
        assert_eq!(activity.modified_last7d, 3, "0d, 3d and the future file");
        assert_eq!(activity.modified_last30d, 4, "+ the 9-day-old one");
        assert_eq!(activity.weeks[11], 3, "current window");
        assert_eq!(activity.weeks[10], 1, "9 days ago");
        assert_eq!(activity.weeks[6], 1, "40 days ago = 5 windows back");
        assert_eq!(activity.weeks.iter().sum::<i64>(), 5, "200d is dropped");
    }

    /// The wire shape is the contract with `src/lib/health/types.ts`. A renamed
    /// field here is a silently-undefined field there, so pin every key.
    #[test]
    fn serialises_to_the_camel_case_typescript_contract() {
        let (tmp, index) = fixture();
        let alpha = doc_id_of(&index, "Alpha.md");
        index.append_yjs_update(&alpha, &[0u8; 8]).unwrap();
        let json = serde_json::to_value(collect(tmp.path(), &index, &HashMap::new()).unwrap()).unwrap();

        for key in [
            "computedAt",
            "notes",
            "folders",
            "attachments",
            "otherFiles",
            "tags",
            "links",
            "brokenLinks",
            "index",
            "history",
            "largestNotes",
            "largestFiles",
            "heaviestHistory",
            "activity",
        ] {
            assert!(json.get(key).is_some(), "VaultStats is missing {key}");
        }
        assert_eq!(json.as_object().unwrap().len(), 14, "no extra fields");

        for key in ["count", "bytes", "empty"] {
            assert!(json["notes"].get(key).is_some(), "notes is missing {key}");
        }
        for key in ["docs", "updates", "bytes", "orphanDocs", "orphanBytes"] {
            assert!(json["history"].get(key).is_some(), "history is missing {key}");
        }
        for key in ["modifiedLast7d", "modifiedLast30d", "weeks"] {
            assert!(json["activity"].get(key).is_some(), "activity is missing {key}");
        }
        for key in ["path", "bytes", "mtime"] {
            assert!(json["largestNotes"][0].get(key).is_some(), "SizedFile is missing {key}");
        }
        for key in ["docId", "path", "updates", "bytes"] {
            assert!(
                json["heaviestHistory"][0].get(key).is_some(),
                "HistoryFootprint is missing {key}"
            );
        }
        assert!(json["attachments"].get("count").is_some());
        assert!(json["otherFiles"].get("bytes").is_some());
        assert!(json["index"].get("bytes").is_some());
    }

    #[test]
    fn an_empty_vault_censuses_to_zeroes() {
        let tmp = tempfile::tempdir().unwrap();
        let index = Index::open(tmp.path()).unwrap();
        index.rebuild(tmp.path()).unwrap();
        let stats = collect(tmp.path(), &index, &HashMap::new()).unwrap();

        assert_eq!(stats.notes.count, 0);
        assert_eq!(stats.folders, 0);
        assert_eq!(stats.attachments.count, 0);
        assert_eq!(stats.other_files.count, 0);
        assert_eq!(stats.history.docs, 0);
        assert!(stats.largest_notes.is_empty());
        assert!(stats.heaviest_history.is_empty());
        assert_eq!(stats.activity.weeks, vec![0; ACTIVITY_WEEKS]);
    }

    #[test]
    fn the_context_dir_is_never_counted() {
        let (tmp, index) = fixture();
        let stats = collect(tmp.path(), &index, &HashMap::new()).unwrap();
        let every_path: Vec<&str> = stats
            .largest_notes
            .iter()
            .chain(stats.largest_files.iter())
            .map(|f| f.path.as_str())
            .collect();
        assert!(every_path.iter().all(|p| !p.starts_with(".context")));
        assert!(every_path.iter().all(|p| !p.starts_with("node_modules")));
        assert!(every_path.iter().all(|p| !p.starts_with('.')));
        // The 1 KiB of .context junk and 4 KiB of node_modules are not in any total.
        assert_eq!(
            stats.notes.bytes + stats.attachments.bytes + stats.other_files.bytes,
            PathBuf::from(tmp.path())
                .join("Alpha.md")
                .metadata()
                .unwrap()
                .len() as i64
                + fs::metadata(tmp.path().join("sub/Beta.md")).unwrap().len() as i64
                + 5
                + 8
        );
    }
}
