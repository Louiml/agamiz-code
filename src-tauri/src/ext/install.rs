//! Installing extensions from a folder, a `.zip`, or a git URL.
//!
//! Every route funnels through the same tail — validate the manifest, then move
//! the payload into `<root>/<id>` — so all three inherit the same manifest
//! validation and the same refusal to install an id that is already present.
//! That last part matters: silently overwriting an installed extension would
//! let a hostile ZIP replace a trusted one.
//!
//! Two extraction hazards are handled explicitly, because both are classic
//! "malicious archive" vectors:
//!
//! * **Zip-slip.** Entry names are never joined onto the destination
//!   unchecked. A name containing `..` or an absolute path is rejected, and
//!   the final path is re-checked against the destination root.
//! * **Absolute paths / drive letters.** Rejected the same way, so an archive
//!   built on Windows cannot write to `C:\` while being unpacked on POSIX.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use crate::ext::host;
use crate::ext::manifest::{load_manifest, ExtensionManifest};

/// Cap on a single archive, to stop a zip bomb from filling the disk before
/// the manifest is ever read. 64 MiB is generous for a Lua extension.
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

/// Result of an install attempt.
#[derive(Debug, Clone)]
pub struct Installed {
    pub id: String,
    pub path: PathBuf,
}

/// Install from a directory that already contains `extension.json`.
pub fn install_from_folder(root: &Path, source: &Path) -> Result<Installed, String> {
    let manifest = load_manifest(source)?;
    let destination = destination_for(root, &manifest.name)?;

    // Copy rather than move: the user picked a folder they may still be
    // editing, and "import" should not be destructive to the original.
    copy_tree(source, &destination)?;
    Ok(Installed {
        id: manifest.name,
        path: destination,
    })
}

/// Install from a `.zip` archive.
pub fn install_from_zip(root: &Path, archive_path: &Path) -> Result<Installed, String> {
    let metadata = std::fs::metadata(archive_path)
        .map_err(|e| format!("could not read {}: {e}", archive_path.display()))?;
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "archive is {} bytes, over the {} MiB install limit",
            metadata.len(),
            MAX_ARCHIVE_BYTES / 1024 / 1024
        ));
    }

    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("could not open {}: {e}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not a readable zip archive: {e}", archive_path.display()))?;

    // Extract to a scratch directory first. It lets us read the manifest
    // before committing to a destination, so an archive with a bad or
    // clashing `extension.json` never half-installs.
    let scratch = scratch_dir(root);
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("could not create {}: {e}", scratch.display()))?;
    let cleanup = ScratchGuard(scratch.clone());

    extract_all(&mut archive, &scratch)?;

    let (manifest, source) = read_manifest_from_extracted(&scratch)?;
    let destination = destination_for(root, &manifest.name)?;

    copy_tree(&source, &destination)?;
    drop(cleanup); // remove the scratch tree
    Ok(Installed {
        id: manifest.name,
        path: destination,
    })
}

/// Clone a git repository and install it.
///
/// Uses the `git` binary rather than linking libgit2: the IDE already shells
/// out to `git` for source control (see `src/app/features/git.ts`), so this
/// reuses the user's existing git configuration, credentials and proxy setup
/// instead of shipping a second, differently-configured HTTP stack.
pub fn install_from_git(root: &Path, url: &str, reference: Option<&str>) -> Result<Installed, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("git URL is empty".to_string());
    }
    // Only the schemes that name a repository. `file://` and plain paths are
    // deliberately excluded: an extension install that silently reads a local
    // directory through a "git URL" is a surprise, and folders have their own
    // install route.
    let allowed = ["https://", "http://", "git://", "ssh://", "git@"];
    if !allowed.iter().any(|scheme| url.starts_with(scheme)) {
        return Err(format!(
            "{url:?} is not a supported git URL (expected one of: {})",
            allowed.join(", ")
        ));
    }

    let scratch = scratch_dir(root);
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("could not create {}: {e}", scratch.display()))?;
    let cleanup = ScratchGuard(scratch.clone());
    let clone_into = scratch.join("repo");

    let mut command = Command::new("git");
    command
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg("--quiet")
        .arg(url)
        .arg(&clone_into);
    if let Some(reference) = reference.filter(|r| !r.is_empty()) {
        command.arg("--branch").arg(reference);
    }
    // A clone must not block on a credential prompt: a GUI app waiting on an
    // invisible stdin read looks like a hang.
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo");

    let output = command
        .output()
        .map_err(|e| format!("could not run git: {e} (is git installed and on PATH?)"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git clone failed: {}",
            if stderr.trim().is_empty() {
                format!("exit code {}", output.status.code().unwrap_or(-1))
            } else {
                stderr.trim().to_string()
            }
        ));
    }

    let manifest = load_manifest(&clone_into)?;
    let destination = destination_for(root, &manifest.name)?;
    copy_tree(&clone_into, &destination)?;
    drop(cleanup);
    Ok(Installed {
        id: manifest.name,
        path: destination,
    })
}

/// Remove an installed extension's folder.
pub fn uninstall(root: &Path, id: &str) -> Result<(), String> {
    if !crate::ext::manifest::is_valid_extension_id(id) {
        return Err(format!("{id:?} is not a valid extension id"));
    }

    // Prefer the dev copy, mirroring `host::locate`, so uninstalling a dev
    // extension does not silently remove a differently-versioned installed one.
    let dev = root.join(host::DEV_DIR).join(id);
    let installed = root.join(id);
    let dir = if dev.join("extension.json").is_file() {
        dev
    } else if installed.join("extension.json").is_file() {
        installed
    } else {
        return Err(format!("extension {id:?} is not installed"));
    };

    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {}: {e}", dir.display()))
}

// ---------------------------------------------------------------------------
// Archive extraction
// ---------------------------------------------------------------------------

/// Extract every entry, rejecting unsafe names.
fn extract_all<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    destination: &Path,
) -> Result<(), String> {
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("could not read archive entry {index}: {e}"))?;
        let name = entry.name().to_string();

        // A single `..` component, an absolute path, or a Windows drive
        // letter all mean "escape the destination". Reject before touching
        // the filesystem.
        let relative = safe_relative_path(&name)
            .ok_or_else(|| format!("archive entry {name:?} has an unsafe path"))?;

        let target = destination.join(&relative);

        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("could not create {}: {e}", target.display()))?;
            continue;
        }

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }

        // Defence in depth: even with a clean relative path, confirm the
        // resolved target is still under the destination (catches a symlink
        // planted by an earlier entry in the same archive).
        let destination_real = destination
            .canonicalize()
            .map_err(|e| format!("could not resolve {}: {e}", destination.display()))?;
        let mut probe = target.as_path();
        while !probe.exists() {
            let Some(parent) = probe.parent() else {
                break;
            };
            probe = parent;
        }
        let resolved = probe
            .canonicalize()
            .map_err(|e| format!("could not resolve {}: {e}", probe.display()))?;
        if !resolved.starts_with(&destination_real) {
            return Err(format!("archive entry {name:?} escapes the destination"));
        }

        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("could not read {}: {e}", target.display()))?;
        std::fs::write(&target, &buffer)
            .map_err(|e| format!("could not write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// Validate an archive entry name and return it as a safe relative path.
fn safe_relative_path(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('\0') {
        return None;
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return None;
    }
    // Windows drive letter, e.g. "C:/evil".
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return None;
    }
    // Normalise separators so a "..\\" entry is caught on POSIX too.
    let normalized = name.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            // The whole point: refuse traversal rather than sanitising it.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Locate `extension.json` in an extracted tree.
///
/// Archives produced by `git archive` and most CI zip steps wrap everything in
/// a single top-level folder, so the manifest is searched one and two levels
/// down rather than only at the root.
fn read_manifest_from_extracted(scratch: &Path) -> Result<(ExtensionManifest, PathBuf), String> {
    if scratch.join("extension.json").is_file() {
        let manifest = load_manifest(scratch)?;
        return Ok((manifest, scratch.to_path_buf()));
    }

    let entries = std::fs::read_dir(scratch)
        .map_err(|e| format!("could not read {}: {e}", scratch.display()))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if dir.join("extension.json").is_file() {
            let manifest = load_manifest(&dir)?;
            return Ok((manifest, dir));
        }
        if let Ok(children) = std::fs::read_dir(&dir) {
            for child in children.flatten() {
                let nested = child.path();
                if nested.is_dir() && nested.join("extension.json").is_file() {
                    let manifest = load_manifest(&nested)?;
                    return Ok((manifest, nested));
                }
            }
        }
    }

    Err("archive does not contain an extension.json".to_string())
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/// Compute the install destination, refusing to clobber an existing install.
fn destination_for(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !crate::ext::manifest::is_valid_extension_id(id) {
        return Err(format!("{id:?} is not a valid extension id"));
    }
    let destination = root.join(id);
    if destination.exists() {
        return Err(format!(
            "extension {id:?} is already installed — disable or uninstall it first"
        ));
    }
    Ok(destination)
}

/// Recursively copy `source` into `destination`, skipping build noise.
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("could not create {}: {e}", destination.display()))?;

    let entries = std::fs::read_dir(source)
        .map_err(|e| format!("could not read {}: {e}", source.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_text = name.to_string_lossy().to_string();
        if matches!(name_text.as_str(), ".git" | "node_modules" | "target" | ".venv") {
            continue;
        }
        let from = entry.path();
        let to = destination.join(&name);
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| {
                format!("could not copy {} to {}: {e}", from.display(), to.display())
            })?;
        }
    }
    Ok(())
}

fn scratch_dir(root: &Path) -> PathBuf {
    root.join(format!(".install-{}", std::process::id()))
}

/// Removes its directory on drop, so a failed install leaves nothing behind.
struct ScratchGuard(PathBuf);

impl Drop for ScratchGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_relative_path_rejects_escapes() {
        assert!(safe_relative_path("../evil.lua").is_none());
        assert!(safe_relative_path("a/../../evil.lua").is_none());
        assert!(safe_relative_path("/etc/passwd").is_none());
        assert!(safe_relative_path("C:/evil.lua").is_none());
        assert!(safe_relative_path("..\\evil.lua").is_none());
        assert!(safe_relative_path("").is_none());
    }

    #[test]
    fn safe_relative_path_normalises() {
        assert_eq!(
            safe_relative_path("./a/b.lua").unwrap(),
            PathBuf::from("a/b.lua")
        );
        assert_eq!(
            safe_relative_path("a\\b.lua").unwrap(),
            PathBuf::from("a/b.lua")
        );
    }

    #[test]
    fn destination_refuses_to_clobber() {
        let temp = std::env::temp_dir().join(format!("agamiz-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("dup")).unwrap();

        assert!(destination_for(&temp, "dup").is_err());
        assert!(destination_for(&temp, "Dup").is_err());
        assert!(destination_for(&temp, "fresh").is_ok());

        let _ = std::fs::remove_dir_all(&temp);
    }

    // -- zip round-trips ----------------------------------------------------

    /// Build a zip from `(name, contents)` pairs.
    fn build_zip(target: &Path, entries: &[(&str, &str)]) -> PathBuf {
        let file = std::fs::File::create(target).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, contents) in entries {
            writer.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut writer, contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        target.to_path_buf()
    }

    const GOOD_MANIFEST: &str = r#"{
        "name": "zipped",
        "version": "1.2.3",
        "main": "extension.lua",
        "activationEvents": ["*"],
        "permissions": ["ui:notification"]
    }"#;

    #[test]
    fn zip_install_extracts_and_validates() {
        let temp = std::env::temp_dir().join(format!("agamiz-zip-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let archive = build_zip(
            &temp.join("ext.zip"),
            &[
                ("extension.json", GOOD_MANIFEST),
                ("extension.lua", "function activate() end"),
                ("src/utils.lua", "return {}"),
            ],
        );

        let root = temp.join("root");
        let installed = install_from_zip(&root, &archive).expect("zip install succeeds");
        assert_eq!(installed.id, "zipped");
        assert!(installed.path.join("extension.json").is_file());
        assert!(installed.path.join("src").join("utils.lua").is_file());

        // The scratch directory must not survive a successful install.
        assert!(
            !root.join(format!(".install-{}", std::process::id())).exists(),
            "the scratch tree should be cleaned up"
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn zip_install_finds_a_wrapped_top_level_folder() {
        // `git archive` and most CI zip steps nest everything one level down.
        let temp = std::env::temp_dir().join(format!("agamiz-zip-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let archive = build_zip(
            &temp.join("ext.zip"),
            &[
                ("zipped-main/extension.json", GOOD_MANIFEST),
                ("zipped-main/extension.lua", "function activate() end"),
            ],
        );

        let installed = install_from_zip(&temp.join("root"), &archive).expect("wrapped zip installs");
        assert_eq!(installed.id, "zipped");

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn zip_install_rejects_a_traversing_entry() {
        let temp = std::env::temp_dir().join(format!("agamiz-zip-evil-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let archive = build_zip(
            &temp.join("evil.zip"),
            &[
                ("extension.json", GOOD_MANIFEST),
                ("extension.lua", "function activate() end"),
                ("../../../../pwned.lua", "return os.execute('whoami')"),
            ],
        );

        let err = install_from_zip(&temp.join("root"), &archive)
            .expect_err("a traversing entry must abort the install");
        assert!(err.contains("unsafe path") || err.contains("escapes"), "{err}");

        // Nothing may have been installed.
        assert!(!temp.join("root").join("zipped").exists());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn zip_install_rejects_a_bad_manifest_without_installing() {
        let temp = std::env::temp_dir().join(format!("agamiz-zip-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let archive = build_zip(
            &temp.join("bad.zip"),
            &[
                // Traversal in `main` must be refused by manifest validation.
                ("extension.json", r#"{"name":"bad","version":"1.0.0","main":"../../x.lua"}"#),
                ("extension.lua", "function activate() end"),
            ],
        );

        assert!(install_from_zip(&temp.join("root"), &archive).is_err());
        assert!(!temp.join("root").join("bad").exists());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn folder_install_copies_rather_than_moves() {
        let temp = std::env::temp_dir().join(format!("agamiz-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let source = temp.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("extension.json"), GOOD_MANIFEST).unwrap();
        std::fs::write(source.join("extension.lua"), "function activate() end").unwrap();

        let root = temp.join("root");
        let installed = install_from_folder(&root, &source).expect("folder install succeeds");
        assert!(installed.path.join("extension.json").is_file());
        assert!(
            source.join("extension.json").is_file(),
            "the original folder must be left intact"
        );

        // Installing the same id twice must be refused, not silently clobbered.
        assert!(install_from_folder(&root, &source).is_err());

        let _ = std::fs::remove_dir_all(&temp);
    }
}
