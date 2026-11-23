//! The four-value status the renderer shows. Every `set` reaches the renderer,
//! changed or not, because `setStatus` in `lcu.ts` sends `lcu:status-changed`
//! on every call and the Live Game page resyncs on each one. Listeners in the
//! app hear only changes.

use std::sync::Mutex;

use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LcuStatus {
    Disconnected,
    Connecting,
    Connected,
    Ingame,
}

impl LcuStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Ingame => "ingame",
        }
    }

    /// Both mean the client is there and answering; only the phase differs.
    pub fn is_client_connected(self) -> bool {
        matches!(self, Self::Connected | Self::Ingame)
    }
}

pub type Emit = Box<dyn Fn(LcuStatus) + Send + Sync>;

pub struct StatusCell {
    current: Mutex<LcuStatus>,
    /// Taken for the whole of a `set`, emit included, so the renderer receives
    /// values in the order they were set. `current` is released before the
    /// emit, so reading the status never waits on the renderer.
    order: Mutex<()>,
    emit: Emit,
    changes: broadcast::Sender<LcuStatus>,
}

/// Enough for listeners that fall a few transitions behind
const CHANGE_BACKLOG: usize = 64;

impl StatusCell {
    pub fn new(emit: Emit) -> Self {
        Self {
            current: Mutex::new(LcuStatus::Disconnected),
            order: Mutex::new(()),
            emit,
            changes: broadcast::channel(CHANGE_BACKLOG).0,
        }
    }

    pub fn get(&self) -> LcuStatus {
        *self.current.lock().expect("status lock")
    }

    pub fn set(&self, status: LcuStatus) {
        self.set_if(|_| true, status);
    }

    /// Sets `status` only if the current value passes `when`, checked and set
    /// under one lock, so a `set` from another task cannot land in between.
    pub fn set_if(&self, when: impl FnOnce(LcuStatus) -> bool, status: LcuStatus) {
        let _order = self.order.lock().expect("status order lock");
        let changed = {
            let mut current = self.current.lock().expect("status lock");
            if !when(*current) {
                return;
            }
            let changed = *current != status;
            *current = status;
            changed
        };
        (self.emit)(status);
        if changed {
            // An error only means nobody is subscribed yet
            let _ = self.changes.send(status);
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LcuStatus> {
        self.changes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    fn recorded() -> (StatusCell, Arc<Mutex<Vec<LcuStatus>>>) {
        let sent = Arc::new(Mutex::new(vec![]));
        let sink = sent.clone();
        let cell = StatusCell::new(Box::new(move |status| sink.lock().unwrap().push(status)));
        (cell, sent)
    }

    #[test]
    fn every_set_reaches_the_renderer() {
        let (cell, sent) = recorded();
        cell.set(LcuStatus::Connecting);
        cell.set(LcuStatus::Connected);
        cell.set(LcuStatus::Connected);
        cell.set(LcuStatus::Connected);
        assert_eq!(
            *sent.lock().unwrap(),
            [
                LcuStatus::Connecting,
                LcuStatus::Connected,
                LcuStatus::Connected,
                LcuStatus::Connected
            ]
        );
    }

    #[test]
    fn listeners_hear_only_changes() {
        let (cell, _) = recorded();
        let mut changes = cell.subscribe();
        cell.set(LcuStatus::Disconnected);
        cell.set(LcuStatus::Connected);
        cell.set(LcuStatus::Connected);
        cell.set(LcuStatus::Ingame);
        cell.set(LcuStatus::Ingame);
        cell.set(LcuStatus::Connected);
        let mut heard = vec![];
        while let Ok(status) = changes.try_recv() {
            heard.push(status);
        }
        assert_eq!(
            heard,
            [
                LcuStatus::Connected,
                LcuStatus::Ingame,
                LcuStatus::Connected
            ]
        );
    }

    /// The race a restart and a late phase can run on a multi-thread runtime:
    /// the phase sees the client connected, the restart sets disconnected, and
    /// the phase must not then set the client back up.
    #[test]
    fn a_set_cannot_land_between_the_check_and_the_set() {
        let (cell, sent) = recorded();
        let cell = Arc::new(cell);
        cell.set(LcuStatus::Connected);
        let mut restart = None;
        cell.set_if(
            |current| {
                let (done, finished) = std::sync::mpsc::channel();
                let other = cell.clone();
                restart = Some(std::thread::spawn(move || {
                    other.set(LcuStatus::Disconnected);
                    let _ = done.send(());
                }));
                // Long enough for the restart to finish, had it not been held
                let landed = finished.recv_timeout(Duration::from_millis(300)).is_ok();
                assert!(!landed, "the restart's set landed inside the check");
                current.is_client_connected()
            },
            LcuStatus::Ingame,
        );
        restart.expect("spawned").join().expect("restart thread");
        assert_eq!(cell.get(), LcuStatus::Disconnected);
        assert_eq!(
            *sent.lock().unwrap(),
            [
                LcuStatus::Connected,
                LcuStatus::Ingame,
                LcuStatus::Disconnected
            ]
        );
    }

    #[test]
    fn a_failed_check_sets_and_sends_nothing() {
        let (cell, sent) = recorded();
        let mut changes = cell.subscribe();
        cell.set_if(LcuStatus::is_client_connected, LcuStatus::Ingame);
        assert_eq!(cell.get(), LcuStatus::Disconnected);
        assert!(sent.lock().unwrap().is_empty());
        assert!(changes.try_recv().is_err());
    }

    #[test]
    fn the_emitter_can_read_the_status() {
        let cell: Arc<std::sync::OnceLock<Arc<StatusCell>>> = Arc::default();
        let seen = Arc::new(Mutex::new(vec![]));
        let (inner, sink) = (cell.clone(), seen.clone());
        let status = Arc::new(StatusCell::new(Box::new(move |_| {
            let current = inner.get().expect("cell set").get();
            sink.lock().unwrap().push(current);
        })));
        assert!(cell.set(status.clone()).is_ok(), "set once");
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            status.set(LcuStatus::Connected);
            let _ = done.send(());
        });
        finished
            .recv_timeout(Duration::from_secs(5))
            .expect("the emit did not wait on the status lock");
        assert_eq!(*seen.lock().unwrap(), [LcuStatus::Connected]);
    }

    #[test]
    fn the_renderer_strings_match_lcu_status() {
        let all = [
            LcuStatus::Disconnected,
            LcuStatus::Connecting,
            LcuStatus::Connected,
            LcuStatus::Ingame,
        ];
        assert_eq!(
            all.map(LcuStatus::as_str),
            ["disconnected", "connecting", "connected", "ingame"]
        );
        assert_eq!(
            all.map(LcuStatus::is_client_connected),
            [false, false, true, true]
        );
    }
}
