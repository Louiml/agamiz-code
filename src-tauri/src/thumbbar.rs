//! Windows taskbar **thumbnail toolbar** — the buttons that appear on the
//! window preview when the user hovers over the app's taskbar icon.
//!
//! Tauri 2 has no API for this, so this module talks to the shell directly:
//!
//! * `ITaskbarList3::ThumbBarAddButtons` puts two buttons ("New Window",
//!   "Open Folder") on the hover preview of the window's taskbar icon.
//! * A comctl32 window subclass receives the clicks (`WM_COMMAND` with
//!   `HIWORD(wParam) == THBN_CLICKED`) and performs the matching action.
//!
//! Only compiled on Windows (`cfg(target_os = "windows")`).
#![cfg(target_os = "windows")]

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    ITaskbarList3, SetWindowSubclass, DefSubclassProc, SHGetStockIconInfo, SHSTOCKICONINFO,
    SHGSI_ICON, SHGSI_SMALLICON, SIID_FOLDEROPEN, TaskbarList, THB_FLAGS, THB_ICON, THB_TOOLTIP,
    THBF_ENABLED, THUMBBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    HICON, IDI_APPLICATION, IMAGE_ICON, LR_DEFAULTSIZE, LR_SHARED, WM_COMMAND, LoadImageW,
};

/// Sent in `HIWORD(wParam)` of `WM_COMMAND` when a thumbnail-toolbar button is
/// clicked. Defined in the Windows SDK (`shobjidl_core.h`) as 0x1800 (6144).
const THBN_CLICKED: u32 = 0x1800;

/// Button command ids, carried in `LOWORD(wParam)` of the click message.
const CMD_NEW_WINDOW: u32 = 1001;
const CMD_OPEN_FOLDER: u32 = 1002;

/// Arbitrary per-process unique id for our window subclass.
const SUBCLASS_ID: usize = 0x00A6_4D43;

/// The `ITaskbarList3` object must stay alive for the process lifetime so the
/// buttons keep working (and so future button updates are possible).
///
/// Creation is memoised as a `Result` rather than panicking on failure — see
/// `install_impl`. A `None` here means "COM refused", and every caller turns
/// that into a logged warning.
///
/// `ITaskbarList3` is a raw COM interface pointer and is not `Send`/`Sync` in
/// the `windows` crate, so it is parked in a newtype with unchecked impls.
/// Safety invariant: the wrapped object is only ever touched on the main/UI
/// thread — `install()` is called from Tauri's `setup`, `on_window_event` and
/// `spawn_editor_window` (all on the main thread), and the click proc hops back
/// via `run_on_main_thread` before doing any work.
struct TaskbarCell(ITaskbarList3);
// SAFETY: guarded by the main-thread-only invariant documented on TaskbarCell.
unsafe impl Send for TaskbarCell {}
// SAFETY: ditto — no cross-thread access ever happens.
unsafe impl Sync for TaskbarCell {}
static TASKBAR: OnceLock<std::result::Result<TaskbarCell, windows::core::Error>> = OnceLock::new();

/// Pointer (as usize) to a leaked `AppHandle` handed to the subclass proc via
/// `SetWindowSubclass`'s `dwRefData`. Leaked on purpose: the subclass lives as
/// long as the process.
static APP_REF: OnceLock<usize> = OnceLock::new();

/// Raw HWND pointer values that already have buttons + subclass installed.
static INSTALLED: Mutex<Option<HashSet<usize>>> = Mutex::new(None);

/// Install thumbnail-toolbar buttons ("New Window", "Open Folder") on the
/// hover preview of `window`'s taskbar icon. Idempotent per window; failed
/// installs can simply be retried (we retry when the window is focused).
pub fn install(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let hwnd_raw = window.hwnd().map_err(|e| format!("hwnd: {e}"))?.0 as usize;
    if hwnd_raw == 0 {
        return Err("null HWND".into());
    }
    if INSTALLED
        .lock()
        .unwrap()
        .get_or_insert_with(HashSet::new)
        .contains(&hwnd_raw)
    {
        return Ok(());
    }
    match unsafe { install_impl(app, hwnd_raw) } {
        Ok(()) => {
            INSTALLED
                .lock()
                .unwrap()
                .get_or_insert_with(HashSet::new)
                .insert(hwnd_raw);
            Ok(())
        }
        Err(e) => Err(e),
    }
}
/// Internal: does the actual Win32 work. Assumes the caller verified the
/// window is not already installed.
unsafe fn install_impl(app: &AppHandle, hwnd_raw: usize) -> Result<(), String> {
    let hwnd = HWND(hwnd_raw as _);

    // Leak one AppHandle for the process lifetime; the subclass proc clones it
    // whenever a button is clicked.
    let app_ptr = *APP_REF.get_or_init(|| Box::into_raw(Box::new(app.clone())) as usize);

    if !SetWindowSubclass(hwnd, Some(thumbbar_proc), SUBCLASS_ID, app_ptr).as_bool() {
        return Err("SetWindowSubclass failed".into());
    }

    let taskbar = &TASKBAR
        .get_or_init(|| {
            // Runs once, on the main thread, where Tauri has already initialized
            // COM (STA), so CoCreateInstance is safe here. A failure is
            // reported, never panicked: this runs inline in `spawn_editor_window`
            // immediately after the window is built, so a panic here would
            // unwind through the New Window command and take the freshly
            // created window down with it. Losing two taskbar buttons is a
            // far better outcome than losing the window.
            let com_taskbar: std::result::Result<ITaskbarList3, windows::core::Error> =
                unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) };
            com_taskbar.map(TaskbarCell)
        })
        .as_ref()
        .map_err(|e| format!("CoCreateInstance(CLSID_TaskbarList) failed: {e}"))?
        .0;
    taskbar
        .HrInit()
        .map_err(|e| format!("ITaskbarList3::HrInit failed: {e}"))?;

    let buttons = [
        make_button(CMD_NEW_WINDOW, "New Window", new_window_icon()),
        make_button(CMD_OPEN_FOLDER, "Open Folder", folder_icon()),
    ];
    taskbar
        .ThumbBarAddButtons(hwnd, &buttons)
        .map_err(|e| format!("ThumbBarAddButtons failed: {e}"))?;
    Ok(())
}

/// Icon for the "New Window" button: the app's own icon embedded by tauri-build
/// (GROUP_ICON resource ids 1..=3 are probed), falling back to the generic
/// system application icon. Loaded with `LR_SHARED`, so never destroyed.
unsafe fn new_window_icon() -> Option<HICON> {
    let hmod = GetModuleHandleW(None).ok()?;
    let hinstance = HINSTANCE(hmod.0);
    for id in [1u16, 2, 3] {
        if let Ok(handle) = LoadImageW(
            Some(hinstance),
            PCWSTR(id as *const u16),
            IMAGE_ICON,
            0,
            0,
            LR_DEFAULTSIZE | LR_SHARED,
        ) {
            return Some(HICON(handle.0));
        }
    }
    let Ok(handle) = LoadImageW(
        // `None` HINSTANCE = the system-wide instance; correct for stock icons.
        None,
        IDI_APPLICATION,
        IMAGE_ICON,
        0,
        0,
        LR_DEFAULTSIZE | LR_SHARED,
    ) else {
        return None;
    };
    Some(HICON(handle.0))
}

/// Icon for the "Open Folder" button: the shell's standard "open folder"
/// stock icon. Freshly created; leaked on purpose (process lifetime).
unsafe fn folder_icon() -> Option<HICON> {
    let mut sii = SHSTOCKICONINFO::default();
    sii.cbSize = std::mem::size_of::<SHSTOCKICONINFO>() as u32;
    SHGetStockIconInfo(SIID_FOLDEROPEN, SHGSI_ICON | SHGSI_SMALLICON, &mut sii).ok()?;
    Some(sii.hIcon)
}
fn make_button(cmd: u32, tip: &str, icon: Option<HICON>) -> THUMBBUTTON {
    let mut tip16 = [0u16; 260];
    for (i, c) in tip.encode_utf16().take(259).enumerate() {
        tip16[i] = c;
    }
    match icon {
        Some(icon) => THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: cmd,
            iBitmap: 0,
            hIcon: icon,
            szTip: tip16,
            dwFlags: THBF_ENABLED,
        },
        // No icon available: still add the button (tooltip-only) rather than
        // dropping the feature entirely.
        None => THUMBBUTTON {
            dwMask: THB_TOOLTIP | THB_FLAGS,
            iId: cmd,
            iBitmap: 0,
            hIcon: HICON(std::ptr::null_mut()),
            szTip: tip16,
            dwFlags: THBF_ENABLED,
        },
    }
}

/// Window subclass proc: intercepts thumbnail-toolbar clicks. Everything else
/// is forwarded to the original window procedure untouched.
unsafe extern "system" fn thumbbar_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    if msg == WM_COMMAND {
        let w = wparam.0 as u32;
        let notification = w >> 16;
        let command = w & 0xFFFF;
        if notification == THBN_CLICKED {
            log::info!(
                "[thumbbar] THBN_CLICKED: hwnd={:#x} button={}",
                hwnd.0 as usize,
                command
            );
            if let Some(app_ptr) = APP_REF.get().copied() {
                let app = (*(app_ptr as *const AppHandle)).clone();
                let target_hwnd = hwnd.0 as usize;
                // Return immediately; the action runs on its own thread so the
                // event loop is never blocked.
                std::thread::spawn(move || handle_click(&app, target_hwnd, command));
            }
            return LRESULT(0);
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn handle_click(app: &AppHandle, target_hwnd: usize, command: u32) {
    log::info!("[thumbbar] click routed: cmd={command} target_hwnd={target_hwnd:#x}");
    match command {
        CMD_NEW_WINDOW => {
            let app = app.clone();
            // Window creation must happen on the main thread.
            // `run_on_main_thread` borrows its receiver, so the closure gets
            // its own clone of the handle instead of moving it.
            let app_for_window = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(e) = crate::spawn_editor_window(&app_for_window) {
                    log::warn!("[thumbbar] new_window failed: {e}");
                }
            });
        }
        CMD_OPEN_FOLDER => {
            // Route to the exact window whose button was clicked so only that
            // window switches workspace; fall back to broadcasting.
            let target = app
                .webview_windows()
                .into_values()
                .find(|w| {
                    w.hwnd()
                        .map(|h| h.0 as usize == target_hwnd)
                        .unwrap_or(false)
                });
            if let Some(w) = target {
                let _ = w.emit("thumbbar://open-folder", ());
            } else {
                let _ = app.emit("thumbbar://open-folder", ());
            }
        }
        _ => {}
    }
}