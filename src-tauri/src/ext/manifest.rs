//! `extension.json` — the manifest that makes a folder an Agamiz Code extension.
//!
//! Parsing is deliberately strict. An extension is untrusted code that will be
//! handed a Lua VM, so a malformed or over-specified manifest is a bug to catch
//! at *load* time (with a field-level message the UI can display) rather than a
//! runtime surprise later.
//!
//! Three layers of defence, in order:
//!
//! 1. `#[serde(deny_unknown_fields)]` — a typo like `dispayName` is an error,
//!    not a silently ignored field that yields a broken extension.
//! 2. Shape validation — semver, id charset, activation-event grammar.
//! 3. Path validation — [`ExtensionManifest::resolve_within`] proves that
//!    `main` and every entry of `files` stay inside the extension root, which
//!    is what stops `../../../etc/passwd` from being loaded as "Lua source".

use std::path::{Component, Path, PathBuf};

/// Every permission an extension may request.
///
/// Kept as a closed set so an unknown string is a hard error: a manifest that
/// asks for `fs:reed` should fail loudly rather than silently run with fewer
/// rights than its author believes it has.
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "clipboard:read",
    "clipboard:write",
    "fs:read",
    "fs:write",
    "network:http",
    "process:exec",
    "ui:notification",
    "ui:sidebar",
    "ui:statusbar",
    "workspace:read",
];

/// A validated `extension.json`.
///
/// Field names are camelCase to match the documented schema; the struct-level
/// `rename_all` means the wire format is exactly the JSON in the spec.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionManifest {
    /// Stable extension id: lowercase, `[a-z0-9-]`. Also the install
    /// directory name and the prefix for contributed ids.
    pub name: String,
    /// Human-facing name shown in the Extensions panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Semantic version (`1.2.3`, optional `-prerelease` / `+build`).
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Entry-point chunk, relative to the extension root.
    #[serde(default = "default_main")]
    pub main: String,
    /// Files packaged with the extension. Informational for the host, but
    /// validated so a manifest cannot claim paths outside its own folder.
    #[serde(default)]
    pub files: Vec<String>,
    /// Events that trigger `activate()`.
    #[serde(default, rename = "activationEvents")]
    pub activation_events: Vec<String>,
    /// Capability grants, all from [`KNOWN_PERMISSIONS`].
    #[serde(default)]
    pub permissions: Vec<String>,
}

fn default_main() -> String {
    "extension.lua".to_string()
}

impl ExtensionManifest {
    /// Label for the UI: `displayName` when present, else the id.
    pub fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.name)
    }

    /// Validate the parsed shape (paths are checked separately against a root).
    ///
    /// Returns a list of *all* problems rather than the first, because the
    /// Extensions panel shows them together and a round-trip per mistake is
    /// miserable for extension authors.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if !is_valid_extension_id(&self.name) {
            errors.push(format!(
                "name {:?} is invalid: use 1-64 lowercase letters, digits or dashes, \
                 starting with a letter or digit (e.g. \"my-extension\")",
                self.name
            ));
        }

        if !is_valid_semver(&self.version) {
            errors.push(format!(
                "version {:?} is not a semantic version (expected MAJOR.MINOR.PATCH, \
                 optional -prerelease and +build)",
                self.version
            ));
        }

        // `main` is the one path that is *required* to be usable, so a problem
        // with it is fatal on its own even if everything else validates.
        match self.check_relative_path("main", &self.main) {
            Ok(()) => {
                if !self.main.to_ascii_lowercase().ends_with(".lua") {
                    errors.push(format!("main {:?} must be a .lua file", self.main));
                }
            }
            Err(e) => errors.push(e),
        }

        for (i, file) in self.files.iter().enumerate() {
            if let Err(e) = self.check_relative_path(&format!("files[{i}]"), file) {
                errors.push(e);
            }
        }

        for (i, event) in self.activation_events.iter().enumerate() {
            if let Err(e) = validate_activation_event(event) {
                errors.push(format!("activationEvents[{i}]: {e}"));
            }
        }

        for (i, permission) in self.permissions.iter().enumerate() {
            if !KNOWN_PERMISSIONS.contains(&permission.as_str()) {
                errors.push(format!(
                    "permissions[{i}]: unknown permission {permission:?} (known: {})",
                    KNOWN_PERMISSIONS.join(", ")
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Reject absolute paths, `..` traversal, and Windows drive/UNC prefixes.
    ///
    /// This is purely lexical — it never touches the filesystem, so it is safe
    /// to run before the directory is known to exist.
    fn check_relative_path(&self, field: &str, value: &str) -> Result<(), String> {
        if value.is_empty() {
            return Err(format!("{field} must not be empty"));
        }
        if value.contains('\0') {
            return Err(format!("{field} contains a NUL byte"));
        }

        // Reject before `Path` parsing so a Windows-style `C:\x` or `\\server`
        // is caught even when the host is POSIX.
        if value.contains('\\') {
            return Err(format!(
                "{field} {value:?} must use '/' separators (backslashes are not portable)"
            ));
        }
        if value.starts_with('/') || has_drive_prefix(value) {
            return Err(format!("{field} {value:?} must be a relative path"));
        }

        let path = Path::new(value);
        for component in path.components() {
            match component {
                Component::Normal(_) | Component::CurDir => {}
                Component::ParentDir => {
                    return Err(format!(
                        "{field} {value:?} must not traverse outside the extension folder"
                    ))
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(format!("{field} {value:?} must be a relative path"))
                }
            }
        }
        Ok(())
    }

    /// Join `relative` onto `root` and prove the result stays inside `root`.
    ///
    /// `check_relative_path` is lexical and therefore bypassable through
    /// symlinks; this second pass resolves the *existing* prefix and compares,
    /// so `main` pointing through a symlinked subdirectory is caught too.
    pub fn resolve_within(&self, root: &Path, relative: &str) -> Result<PathBuf, String> {
        self.check_relative_path("path", relative)?;

        let candidate = root.join(relative);

        // Canonicalize the deepest existing ancestor (the file itself may not
        // exist yet) and re-append the remainder.
        let mut existing = candidate.as_path();
        let mut trailing: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name() else {
                break;
            };
            trailing.push(name.to_os_string());
            let Some(parent) = existing.parent() else {
                break;
            };
            existing = parent;
        }

        let mut resolved = existing
            .canonicalize()
            .map_err(|e| format!("could not resolve {}: {e}", existing.display()))?;
        for name in trailing.into_iter().rev() {
            resolved.push(name);
        }

        let root_real = root
            .canonicalize()
            .map_err(|e| format!("could not resolve extension root {}: {e}", root.display()))?;
        if !resolved.starts_with(&root_real) {
            return Err(format!(
                "{relative:?} escapes the extension folder ({} is outside {})",
                resolved.display(),
                root_real.display()
            ));
        }
        Ok(candidate)
    }
}

fn has_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

/// `[a-z0-9-]`, 1..=64 chars, must not start or end with `-`.
pub fn is_valid_extension_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    if id.starts_with('-') || id.ends_with('-') || id.contains("--") {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A pragmatic semver check. Full semver has enough edge cases (leading-zero
/// rejection, unicode identifiers in prerelease) that a hand-rolled permissive
/// check would be a liability; this one rejects the shapes that actually show
/// up from hand-edited manifests.
pub fn is_valid_semver(version: &str) -> bool {
    let (core, build) = match version.split_once('+') {
        Some((core, build)) => (core, Some(build)),
        None => (version, None),
    };
    if let Some(build) = build {
        if build.is_empty() || !is_dot_separated_identifier(build, true) {
            return false;
        }
    }

    let (core, prerelease) = match core.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (core, None),
    };
    if let Some(pre) = prerelease {
        if pre.is_empty() || !is_dot_separated_identifier(pre, false) {
            return false;
        }
    }

    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts
        .iter()
        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && !has_leading_zero(p))
}

fn has_leading_zero(part: &str) -> bool {
    part.len() > 1 && part.starts_with('0')
}

/// Dot-separated identifiers, as used by prerelease and build metadata.
fn is_dot_separated_identifier(value: &str, allow_leading_zero: bool) -> bool {
    value.split('.').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && (allow_leading_zero || !has_leading_zero(part))
    })
}

/// Activation-event grammar.
///
/// This is a closed grammar on purpose. Evaluating an event string with a
/// general-purpose matcher (VS Code style) means a malformed or adversarial
/// pattern becomes a matching bug; a small explicit vocabulary keeps the
/// activation decision a total function over known inputs.
pub fn validate_activation_event(event: &str) -> Result<(), String> {
    const STATIC_EVENTS: &[&str] = &["*", "onStartup", "never"];

    if STATIC_EVENTS.contains(&event) {
        return Ok(());
    }

    if let Some(rest) = event.strip_prefix("onLanguage:") {
        return require_nonempty("onLanguage", rest);
    }
    if let Some(rest) = event.strip_prefix("onCommand:") {
        // A command id is namespaced, so require the dot to catch a bare word.
        return match require_nonempty("onCommand", rest) {
            Ok(()) if rest.contains('.') => Ok(()),
            _ => Err(format!(
                "{event:?} must name a namespaced command id (e.g. \"onCommand:myext.run\")"
            )),
        };
    }
    if let Some(rest) = event.strip_prefix("onView:") {
        return require_nonempty("onView", rest);
    }
    if let Some(rest) = event.strip_prefix("workspaceContains:") {
        return require_nonempty("workspaceContains", rest);
    }

    Err(format!(
        "{event:?} is not a supported activation event (expected one of: {}, \
         or onLanguage:<id>, onCommand:<id>, onView:<id>, workspaceContains:<glob>)",
        STATIC_EVENTS.join(", ")
    ))
}

fn require_nonempty(prefix: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{prefix}: is missing a value"))
    } else {
        Ok(())
    }
}

/// Read and validate the manifest sitting at the root of `dir`.
///
/// `dir` is the extension folder, not the manifest path, so callers that
/// already know the layout do not have to join it themselves.
pub fn load_manifest(dir: &Path) -> Result<ExtensionManifest, String> {
    let path = dir.join("extension.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;

    let manifest: ExtensionManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid {}: {e}", path.display()))?;

    manifest
        .validate()
        .map_err(|errors| format!("invalid {}: {}", path.display(), errors.join("; ")))?;

    // `main` must be the last gate: a manifest that parses and validates but
    // points at a missing chunk cannot be loaded.
    let entry = manifest.resolve_within(dir, &manifest.main)?;
    if !entry.is_file() {
        return Err(format!(
            "entry point {} not found in {}",
            manifest.main,
            dir.display()
        ));
    }

    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<ExtensionManifest, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn parses_the_documented_manifest() {
        let m = parse(
            r#"{
              "name": "example-extension",
              "displayName": "Example Custom Extension",
              "version": "1.0.0",
              "description": "Adds custom productivity tools to Agamiz Code.",
              "author": "Developer Name",
              "repository": "https://github.com/example/example-extension",
              "main": "extension.lua",
              "files": ["extension.lua", "src/example.lua"],
              "activationEvents": ["onLanguage:python", "onCommand:example.run", "*"],
              "permissions": ["fs:read", "network:http", "ui:statusbar"]
            }"#,
        )
        .expect("manifest parses");

        assert_eq!(m.name, "example-extension");
        assert_eq!(m.display_name.as_deref(), Some("Example Custom Extension"));
        assert_eq!(m.activation_events.len(), 3);
        m.validate().expect("documented manifest is valid");
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let err = parse(r#"{"name":"a","version":"1.0.0","dispayName":"typo"}"#)
            .expect_err("typo must not be ignored");
        assert!(err.to_string().contains("dispayName"), "{err}");
    }

    #[test]
    fn rejects_traversal_in_main() {
        let m = parse(r#"{"name":"a","version":"1.0.0","main":"../evil.lua"}"#).unwrap();
        let err = m.validate().expect_err("traversal must be rejected");
        assert!(err.join(" ").contains("traverse outside"), "{err:?}");
    }

    #[test]
    fn rejects_absolute_and_windows_paths() {
        for bad in ["/etc/passwd.lua", "C:\\evil.lua", "sub\\evil.lua"] {
            // Built with `json!` so the Windows backslashes stay a *string*
            // rather than becoming an invalid JSON escape in the fixture.
            let value = serde_json::json!({
                "name": "a",
                "version": "1.0.0",
                "main": bad,
            });
            let m: ExtensionManifest = serde_json::from_value(value).unwrap();
            assert!(
                m.validate().is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn semver_gate() {
        assert!(is_valid_semver("1.0.0"));
        assert!(is_valid_semver("0.1.0-beta.1"));
        assert!(is_valid_semver("1.2.3+build.5"));
        assert!(!is_valid_semver("1.0"));
        assert!(!is_valid_semver("1.0.0.0"));
        assert!(!is_valid_semver("01.0.0"));
        assert!(!is_valid_semver("v1.0.0"));
    }

    #[test]
    fn activation_event_gate() {
        assert!(validate_activation_event("onCommand:myext.run").is_ok());
        assert!(validate_activation_event("onCommand:nodot").is_err());
        assert!(validate_activation_event("onLanguage:").is_err());
        assert!(validate_activation_event("onWat:1").is_err());
    }

    #[test]
    fn unknown_permission_is_an_error() {
        let m = parse(r#"{"name":"a","version":"1.0.0","permissions":["fs:reed"]}"#).unwrap();
        let err = m.validate().expect_err("typo permission must be rejected");
        assert!(err.join(" ").contains("unknown permission"), "{err:?}");
    }

    #[test]
    fn id_gate() {
        assert!(is_valid_extension_id("my-extension"));
        assert!(!is_valid_extension_id("My-Extension"));
        assert!(!is_valid_extension_id("-leading"));
        assert!(!is_valid_extension_id("double--dash"));
        assert!(!is_valid_extension_id(""));
    }
}
