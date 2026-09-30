//! Running a `package.json` script.
//!
//! Two platform facts drive this file.
//!
//! **npm and friends are `.cmd` shims on Windows.** `npm`, `pnpm`, `yarn` and
//! `bun` are all installed as batch files next to `node.exe`, not as
//! executables. `CreateProcess` searches `PATH` but does not apply `PATHEXT`,
//! so `Command::new("npm")` fails with "program not found" on Windows even
//! though npm is installed and works in a terminal. The documented workaround is
//! to go through `cmd /C`, which is what [`shell_command`] does.
//!
//! **A script name is untrusted input.** It comes out of a `package.json`, which
//! arrives with a clone. It is concatenated into a `cmd /C` command line, where
//! `&`, `|`, `>` and friends are shell metacharacters, so an unvalidated name
//! would turn opening a repository into arbitrary command execution. Names are
//! restricted to what npm itself allows.

/// Package managers that need the Windows shim treatment.
const SHIM_PROGRAMS: &[&str] = &[
    "npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "bun", "bunx",
];

/// Characters npm permits in a script name.
///
/// Deliberately narrow: letters, digits, and the punctuation that actually
/// appears in real script names (`build:watch`, `test.unit`, `post-install`).
/// Everything else - spaces, quotes, `&`, `|`, `;`, `<`, `>`, backticks, `%` -
/// is rejected, which is what makes the `cmd /C` line below safe to build.
fn is_safe_script_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// Reject a script name that would be dangerous on a `cmd /C` line.
///
/// Returns the name unchanged so it can be used in a call expression.
pub fn validate_script_name(name: &str) -> Result<&str, String> {
    if is_safe_script_name(name) {
        Ok(name)
    } else {
        Err(format!(
            "refusing to run script with unsupported name: {name:?}"
        ))
    }
}

/// Resolve a package-manager program to something this platform can start.
///
/// On Windows the shim programs are routed through `cmd /C`; everywhere else
/// the program is used directly. `is_windows` is a parameter rather than a
/// `cfg!` so both branches are testable from any host.
pub fn shell_command(program: &str, args: &[String], is_windows: bool) -> (String, Vec<String>) {
    if is_windows && SHIM_PROGRAMS.contains(&program) {
        let mut all = vec!["/C".to_string(), program.to_string()];
        all.extend(args.iter().cloned());
        return ("cmd".to_string(), all);
    }
    (program.to_string(), args.to_vec())
}

/// The `cmd` that Windows uses, resolved to an absolute path when possible.
///
/// `cmd` is on `PATH` for every interactive session, but a GUI process launched
/// by Explorer can inherit a `PATH` without `System32` on it, which is the usual
/// reason a spawned shell reports "not found".
fn windows_shell() -> String {
    std::env::var("ComSpec").unwrap_or_else(|_| "cmd".to_string())
}

/// Build the argv for running `script` with `manager` in `root`.
///
/// `root` must already be confined by the caller. Returns the display form of
/// the command for the UI, which is built from the *validated* name rather than
/// from whatever was requested.
pub fn package_script_argv(
    manager: &str,
    script: &str,
    is_windows: bool,
) -> Result<(String, Vec<String>, String), String> {
    let script = validate_script_name(script)?;
    // The manager is interpolated into the `cmd /C` line too, so it is held to
    // an allowlist rather than a denylist: only the known package-manager shims
    // are accepted, which rules out `cmd`, `powershell` and anything carrying a
    // metacharacter in a single step.
    if !SHIM_PROGRAMS.contains(&manager) {
        return Err(format!("unsupported package manager: {manager:?}"));
    }
    let (program, args) = shell_command(
        manager,
        &["run".to_string(), script.to_string()],
        is_windows,
    );
    let program = if is_windows && program == "cmd" {
        windows_shell()
    } else {
        program
    };
    let display = format!("{manager} run {script}");
    Ok((program, args, display))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_realistic_script_names() {
        for name in [
            "dev",
            "build",
            "test:watch",
            "test.unit",
            "post-install",
            "_x",
            "a.b",
        ] {
            assert!(is_safe_script_name(name), "expected {name} to be allowed");
        }
    }

    #[test]
    fn rejects_shell_metacharacters() {
        // Each of these would change what `cmd /C` does if it got through.
        for name in [
            "a&b",
            "a|b",
            "a;b",
            "a>b",
            "a<b",
            "a^b",
            "a%PATH%",
            "a b",
            "a\"b",
            "a'b",
            "a`b",
            "a\nb",
            "a\0b",
            "",
            &"a".repeat(129),
        ] {
            assert!(
                !is_safe_script_name(name),
                "expected {name:?} to be rejected"
            );
        }
    }

    #[test]
    fn rejects_non_ascii() {
        // Non-ASCII is legal in an npm script name but not worth the risk of
        // letting through a homoglyph into a shell line.
        assert!(!is_safe_script_name("buildé"));
    }

    #[test]
    fn windows_routes_shims_through_cmd() {
        let (program, args) = shell_command("npm", &["run".to_string(), "build".to_string()], true);
        assert_eq!(program, "cmd");
        assert_eq!(args, vec!["/C", "npm", "run", "build"]);
    }

    #[test]
    fn windows_leaves_real_executables_alone() {
        // `node` is an .exe, so wrapping it would only add a shell layer.
        let (program, args) = shell_command("node", &["--version".to_string()], true);
        assert_eq!(program, "node");
        assert_eq!(args, vec!["--version"]);
    }

    #[test]
    fn posix_uses_the_program_directly() {
        let (program, args) =
            shell_command("npm", &["run".to_string(), "build".to_string()], false);
        assert_eq!(program, "npm");
        assert_eq!(args, vec!["run", "build"]);
    }

    #[test]
    fn builds_the_argv_for_each_manager() {
        for (manager, script) in [("npm", "build"), ("pnpm", "dev"), ("yarn", "start")] {
            let (program, args, display) = package_script_argv(manager, script, false).unwrap();
            assert_eq!(program, manager);
            assert!(args.contains(&"run".to_string()) || args.contains(&script.to_string()));
            assert_eq!(display, format!("{manager} run {script}"));
        }
    }

    #[test]
    fn windows_argv_goes_through_cmd() {
        let (program, args, _) = package_script_argv("npm", "build", true).unwrap();
        // ComSpec resolves to an absolute path on purpose: a GUI process can
        // inherit a PATH without System32 on it, which is the usual reason a
        // spawned shell reports "not found".
        assert!(program.to_lowercase().ends_with("cmd.exe"), "got {program}");
        assert_eq!(args[0], "/C");
        assert_eq!(args[1], "npm");
    }

    #[test]
    fn refuses_a_manager_that_is_not_a_package_manager() {
        // The allowlist does this in one step: shells, an empty string and
        // anything carrying a metacharacter are all simply not in the list.
        for manager in [
            "cmd",
            "cmd.exe",
            "powershell",
            "sh",
            "bash",
            "a&b",
            "",
            "npm2",
        ] {
            assert!(
                package_script_argv(manager, "build", false).is_err(),
                "expected manager {manager:?} to be refused"
            );
        }
    }

    #[test]
    fn refuses_a_dangerous_script_name() {
        assert!(package_script_argv("npm", "a&calc", false).is_err());
        assert!(package_script_argv("npm", "", false).is_err());
    }
}
