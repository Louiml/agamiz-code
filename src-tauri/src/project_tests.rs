//! Tests for the project-scaffolding commands.
//!
//! The subject is `resolve_template_path`, which is the only thing standing
//! between a third-party extension template and the rest of the filesystem. The
//! traversal cases are the reason this function exists at all, so they are
//! pinned here rather than left to review.

use super::*;
use std::path::PathBuf;

#[test]
fn ordinary_paths_resolve_under_the_root() {
    let root = PathBuf::from("/projects/demo");
    for (input, expected) in [
        ("README.md", "/projects/demo/README.md"),
        ("src/main.rs", "/projects/demo/src/main.rs"),
        (".gitignore", "/projects/demo/.gitignore"),
        (".vscode/launch.json", "/projects/demo/.vscode/launch.json"),
    ] {
        let got = resolve_template_path(&root, input).expect(input);
        assert_eq!(got, PathBuf::from(expected), "{input}");
    }
}

#[test]
fn traversal_out_of_the_root_is_rejected() {
    let root = PathBuf::from("/projects/demo");
    // Each of these would write outside the folder the user chose. They must
    // fail even though the joined path is a perfectly valid filesystem path —
    // that is exactly the point: the check is about intent, not syntax.
    for evil in [
        "../escaped.txt",
        "../../escaped.txt",
        "src/../../escaped.txt",
        "a/b/../../../escaped.txt",
        "..",
    ] {
        let err = resolve_template_path(&root, evil).unwrap_err();
        assert!(
            err.contains("escapes the project root"),
            "{evil:?} should have been refused as an escape, got {err:?}"
        );
    }
}

#[test]
fn absolute_and_drive_paths_are_rejected() {
    let root = PathBuf::from("/projects/demo");
    // Checked with explicit prefix/separator tests rather than
    // `Path::is_absolute`, which is platform-dependent: `/etc/passwd` is not
    // absolute on Windows, and this guard has to hold on every platform.
    for evil in ["/etc/passwd", "\\windows\\system32", "C:\\Windows\\evil", "d:/evil"] {
        assert!(
            resolve_template_path(&root, evil).is_err(),
            "{evil:?} must not be accepted as a relative template path"
        );
    }
}

#[test]
fn empty_paths_are_rejected() {
    let root = PathBuf::from("/projects/demo");
    assert!(resolve_template_path(&root, "").is_err());
    assert!(resolve_template_path(&root, "   ").is_err());
}

#[test]
fn inner_dot_dot_is_collapsed_not_treated_as_an_escape() {
    // `a/../b` never leaves the root, so it is legitimate and should resolve to
    // `root/b` rather than being refused. The rejection above is specifically
    // about popping *past* the root, and over-eager normalisation would break
    // templates that legitimately write through a placeholder directory.
    let root = PathBuf::from("/projects/demo");
    let got = resolve_template_path(&root, "a/../b.txt").expect("stays inside");
    assert_eq!(got, PathBuf::from("/projects/demo/b.txt"));
}
