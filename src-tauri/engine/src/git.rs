use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use git2::{Repository, Status};
use tauri::{AppHandle, Emitter};

/// A logical change shown in the Source Control panel.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

/// Summary + staged/unstaged/untracked buckets for a status scan.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub current_branch: String,
    pub staged: Vec<GitEntry>,
    pub unstaged: Vec<GitEntry>,
    pub untracked: Vec<GitEntry>,
    pub dirty_count: usize,
}

/// A per-line working-tree change used for editor gutter indicators.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLineChange {
    /// 1-based line in the working tree.
    pub line: usize,
    /// "added", "modified", or "deleted".
    pub kind: String,
    pub status: String,
}

/// Line diffs for one file (used for gutter) plus the raw patch for the diff view.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub lines: Vec<GitLineChange>,
    /// Unified patch text.
    pub patch: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub success: bool,
    pub message: String,
    pub commit_oid: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

/// Thin wrapper around a discovered repository with debounced status polling.
pub struct GitManager {
    workdir: Mutex<Option<PathBuf>>,
    /// Last emitted status snapshot (cache for requests between watcher ticks).
    last_status: Mutex<Option<GitStatus>>,
}

impl GitManager {
    pub fn new() -> Self {
        Self {
            workdir: Mutex::new(None),
            last_status: Mutex::new(None),
        }
    }

    /// Point the manager at a repo root; discovers the repository on demand.
    pub fn bind(&self, root: PathBuf) {
        let discovered = Repository::discover(&root).ok();
        let workdir = discovered
            .as_ref()
            .and_then(|r| r.workdir().map(|w| w.to_path_buf()));
        *self.workdir.lock().unwrap() = workdir;
    }

    pub fn root(&self) -> Option<PathBuf> {
        self.workdir.lock().unwrap().clone()
    }

fn open(&self) -> Result<Repository, String> {
        let root = self
            .workdir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no git repository bound".to_string())?;
        Repository::discover(&root).map_err(|e| e.to_string())
    }

    /// Public accessor for IPC commands.
    pub fn open_for_ipc(&self) -> Result<Repository, String> {
        self.open()
    }

    /// Perform a status scan; returns a cached snapshot if the repo is unavailable.
    pub fn status(&self) -> Result<GitStatus, String> {
        let repo = self.open()?;
        let st = collect_status(&repo)?;
        *self.last_status.lock().unwrap() = Some(st.clone());
        Ok(st)
    }

    pub fn last_status(&self) -> Option<GitStatus> {
        self.last_status.lock().unwrap().clone()
    }
}

impl Default for GitManager {
    fn default() -> Self {
        Self::new()
    }
}

pub static GIT: std::sync::LazyLock<Arc<GitManager>> =
    std::sync::LazyLock::new(|| Arc::new(GitManager::new()));

/// Discover + cache the repository in the global manager.
pub fn bind_root(root: &Path) {
    GIT.bind(root.to_path_buf());
}

pub fn collect_status(repo: &Repository) -> Result<GitStatus, String> {
    let statuses = repo.statuses(None).map_err(|e| e.to_string())?;
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "(detached)".to_string());

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry
            .path()
            .map(|p| p.to_string())
            .unwrap_or_else(|| "?".to_string());

        if status.contains(Status::INDEX_NEW) {
            staged.push(GitEntry { path: path.clone(), status: "A".into(), staged: true });
        }
        if status.contains(Status::INDEX_MODIFIED) {
            staged.push(GitEntry { path: path.clone(), status: "M".into(), staged: true });
        }
        if status.contains(Status::INDEX_DELETED) {
            staged.push(GitEntry { path: path.clone(), status: "D".into(), staged: true });
        }
        if status.contains(Status::INDEX_RENAMED) {
            staged.push(GitEntry { path: path.clone(), status: "R".into(), staged: true });
        }
        if status.contains(Status::WT_MODIFIED) {
            unstaged.push(GitEntry { path: path.clone(), status: "M".into(), staged: false });
        }
        if status.contains(Status::WT_DELETED) {
            unstaged.push(GitEntry { path: path.clone(), status: "D".into(), staged: false });
        }
        if status.contains(Status::WT_NEW) && !status.contains(Status::INDEX_NEW) {
            untracked.push(GitEntry { path: path.clone(), status: "UT".into(), staged: false });
        }
    }

    staged.sort_by(|a, b| a.path.cmp(&b.path));
    unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    untracked.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(GitStatus {
        current_branch,
        staged,
        unstaged,
        untracked,
        dirty_count: statuses.len(),
    })
}

/// Derive per-line working-tree changes for one file against HEAD.
pub fn file_diff(repo: &Repository, path: &str) -> Result<GitFileDiff, String> {
    let workdir = repo.workdir().ok_or("bare repository has no workdir")?;
    let normalize = |p: &Path| {
        let rel = p.strip_prefix(workdir).unwrap_or(p);
        rel.to_string_lossy().replace('\\', "/")
    };

    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0);
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.to_string())?;

    let mut lines: Vec<GitLineChange> = Vec::new();
    let patch_cell = std::cell::RefCell::new(String::new());

    let target = normalize(&workdir.join(path));
    let mut last_old: Option<usize> = None;

    diff.foreach(
        &mut |_delta, _| true,
        None,
        Some(&mut |_delta, hunk| {
            if !hunk.header().is_empty() {
                patch_cell
                    .borrow_mut()
                    .push_str(std::str::from_utf8(hunk.header()).unwrap_or_default());
            }
            true
        }),
        Some(&mut |delta, _hunk, line| {
            let file = delta.new_file().path().map(|p| normalize(p));
            if file.as_deref() != Some(target.as_str()) {
                return true;
            }
            {
                let mut patch = patch_cell.borrow_mut();
                patch.push_str(line.origin().to_string().as_str());
                let content = std::str::from_utf8(line.content()).unwrap_or_default();
                if !content.ends_with('\n') {
                    patch.push('\n');
                }
            }
            match line.origin() {
                '+' => {
                    if let Some(n) = line.new_lineno() {
                        lines.push(GitLineChange {
                            line: n as usize,
                            kind: "added".into(),
                            status: "A".into(),
                        });
                    }
                    last_old = None;
                }
                '-' => {
                    if let Some(n) = line.old_lineno() {
                        // A deletion: mark the line after the removed region as the
                        // marker target so the gutter shows a red block.
                        last_old = Some(n as usize);
                    }
                }
                ' ' => {
                    last_old = None;
                }
                _ => {}
            }
            true
        }),
    )
    .map_err(|e| e.to_string())?;

    if let Some(old) = last_old {
        lines.push(GitLineChange {
            line: old,
            kind: "deleted".into(),
            status: "D".into(),
        });
    }

    Ok(GitFileDiff {
        path: path.to_string(),
        lines,
        patch: patch_cell.into_inner(),
    })
}

/// Stage (or unstage) a single path.
pub fn stage_path(repo: &Repository, path: &str, stage: bool) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if stage {
        index.add_path(Path::new(path)).map_err(|e| e.to_string())?;
    } else {
        index.remove_path(Path::new(path)).map_err(|e| e.to_string())?;
    }
    index.write().map_err(|e| e.to_string())
}

/// Stage all changes.
pub fn stage_all(repo: &Repository) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())
}

pub fn commit(repo: &Repository, message: &str) -> Result<GitCommitResult, String> {
    let sig = repo.signature().map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let parents: Vec<git2::Commit> = match repo.head().ok().and_then(|h| h.target()) {
        Some(oid) => repo
            .find_commit(oid)
            .map(|c| vec![c])
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
        .map_err(|e| e.to_string())?;
    Ok(GitCommitResult {
        success: true,
        message: message.to_string(),
        commit_oid: Some(oid.to_string()),
    })
}

pub fn branches(repo: &Repository) -> Result<GitBranches, String> {
    let current = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "(detached)".to_string());
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let _ = repo
        .branches(None)
        .map_err(|e| e.to_string())?
        .for_each(|b| {
            if let Ok((branch, bt)) = b {
                let name = branch.name().unwrap_or(Some("")).unwrap_or("").to_string();
                match bt {
                    git2::BranchType::Local => local.push(name),
                    git2::BranchType::Remote => remote.push(name),
                }
            }
        });
    local.sort();
    remote.sort();
    Ok(GitBranches { current, local, remote })
}

pub fn checkout(repo: &Repository, branch: &str) -> Result<(), String> {
    let obj = repo
        .revparse_single(branch)
        .map_err(|e| format!("branch '{branch}': {e}"))?;
    repo.checkout_tree(&obj, None).map_err(|e| e.to_string())?;
    let _ = repo.set_head(branch).map_err(|e| e.to_string());
    Ok(())
}

// --- Debounced background watcher ------------------------------------------

/// Start a recursive file watcher that re-scans status after a debounce window.
/// Returns `()` handle; the thread runs until the process exits.
pub fn start_status_watcher(root: PathBuf, app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

        let repo = match Repository::discover(&root) {
            Ok(r) => r,
            Err(_) => return,
        };
        let workdir = match repo.workdir() {
            Some(w) => w.to_path_buf(),
            None => return,
        };

        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher: Box<dyn Watcher> = match RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        ) {
            Ok(w) => Box::new(w),
            Err(_) => return,
        };
        if watcher.watch(&workdir, RecursiveMode::Recursive).is_err() {
            return;
        }

        let mut last = Instant::now() - Duration::from_secs(2);
        while let Ok(_event) = rx.recv() {
            let now = Instant::now();
            if now.duration_since(last) < Duration::from_millis(600) {
                continue;
            }
            last = now;
            // Skip noisy .git writes.
            let snapshot = match collect_status(&repo) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let _ = app.emit("git:status", snapshot);
        }
    });
}