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
    emit: Emit,
    changes: broadcast::Sender<LcuStatus>,
}

/// Enough for listeners that fall a few transitions behind
const CHANGE_BACKLOG: usize = 64;

impl StatusCell {
    pub fn new(emit: Emit) -> Self {
        Self {
            current: Mutex::new(LcuStatus::Disconnected),
            emit,
            changes: broadcast::channel(CHANGE_BACKLOG).0,
        }
    }

    pub fn get(&self) -> LcuStatus {
        *self.current.lock().expect("status lock")
    }

    /// Held across the emit, so the renderer receives values in the order they
    /// were set.
    pub fn set(&self, status: LcuStatus) {
        let mut current = self.current.lock().expect("status lock");
        let changed = *current != status;
        *current = status;
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
