use notify::{Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use tokio::sync::mpsc;

pub fn start_watcher(
    root: PathBuf,
    tx: mpsc::UnboundedSender<PathBuf>,
) -> Result<notify::RecommendedWatcher, notify::Error> {
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })?;

    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}