//! The tray icon and its menu, `createTray` in `src/main/index.ts`.

use serde_json::{Value, json};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::shell;

pub const TRAY_ID: &str = "main";
pub const TOOLTIP: &str = "Better Mayhem Tracker";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    ShowWindow,
    Quit,
}

impl Action {
    pub const ALL: [Action; 2] = [Action::ShowWindow, Action::Quit];

    pub fn id(self) -> &'static str {
        match self {
            Action::ShowWindow => "tray-show-window",
            Action::Quit => "tray-quit",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Action::ShowWindow => "Show Window",
            Action::Quit => "Quit",
        }
    }

    /// What the Electron handler calls, in T04's probe vocabulary.
    pub fn calls(self) -> &'static [&'static str] {
        match self {
            Action::ShowWindow => &["show", "focus"],
            Action::Quit => &["app.quit"],
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.id() == id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    Item(Action),
    Separator,
}

pub const MENU: [Entry; 3] = [
    Entry::Item(Action::ShowWindow),
    Entry::Separator,
    Entry::Item(Action::Quit),
];

/// Windows opens the menu on a right click and shows the window on a
/// double-click. macOS opens the menu on a left click and Tauri reports no
/// double-click there.
pub const DOUBLE_CLICK_SHOWS: bool = cfg!(windows);

pub fn run<R: Runtime>(app: &AppHandle<R>, action: Action) {
    match action {
        Action::ShowWindow => shell::show_main(app, false),
        Action::Quit => shell::request_quit(app),
    }
}

/// Electron's `nativeImage` takes the `@2x` file on a HiDPI display.
fn icon_name(scale: f64) -> &'static str {
    if scale > 1.0 {
        "assets/tray@2x.png"
    } else {
        "assets/tray.png"
    }
}

fn icon_scale<R: Runtime>(app: &AppHandle<R>) -> f64 {
    // macOS always gets the @2x pixels: the status item draws at the screen's
    // scale, and the image is sized back to 16 pt below
    if cfg!(target_os = "macos") {
        return 2.0;
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let menu = Menu::new(app)?;
    for entry in MENU {
        match entry {
            Entry::Item(action) => {
                menu.append(&MenuItem::with_id(
                    app,
                    action.id(),
                    action.label(),
                    true,
                    None::<&str>,
                )?)?;
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    let path = app
        .path()
        .resolve(icon_name(icon_scale(app)), BaseDirectory::Resource)?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_path(path)?)
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| {
            if let Some(action) = Action::from_id(event.id().as_ref()) {
                run(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                run(tray.app_handle(), Action::ShowWindow);
            }
        })
        .build(app)?;
    #[cfg(target_os = "macos")]
    tray.with_inner_blocking(|inner| {
        // tray-icon sizes every image to 18 pt high; Electron draws tray.png at 16 pt
        if let Some(image) = inner
            .ns_status_item()
            .and_then(|item| item.button(objc2::MainThreadMarker::new()?))
            .and_then(|button| button.image())
        {
            image.setSize(objc2_foundation::NSSize::new(16.0, 16.0));
        }
    })?;
    app.manage(TrayMenu(menu));
    Ok(tray)
}

/// The built menu, kept so a parity dump reads what the tray shows.
pub struct TrayMenu<R: Runtime>(pub Menu<R>);

fn item_json(kind: &str, label: &str, enabled: bool) -> Value {
    json!({
        "type": kind,
        "label": label,
        "role": null,
        "enabled": enabled,
        "visible": true,
        "checked": false,
        "accelerator": null,
        "submenu": null,
    })
}

/// The menu in T04's `tray-menu.json` item shape, from the table.
pub fn spec_items() -> Vec<Value> {
    MENU.into_iter()
        .map(|entry| match entry {
            Entry::Item(action) => item_json("normal", action.label(), true),
            Entry::Separator => item_json("separator", "", true),
        })
        .collect()
}

/// The menu as built, in the same shape, read back from the native items.
pub fn built_items<R: Runtime>(menu: &Menu<R>) -> tauri::Result<Vec<Value>> {
    menu.items()?
        .into_iter()
        .map(|item| {
            Ok(match item {
                MenuItemKind::MenuItem(item) => {
                    item_json("normal", &item.text()?, item.is_enabled()?)
                }
                // The only predefined item the tray has
                MenuItemKind::Predefined(_) => item_json("separator", "", true),
                other => json!({ "type": "unexpected", "id": other.id().as_ref() }),
            })
        })
        .collect()
}

/// T04's `tray-menu.json`, with the interaction this build has.
pub fn dump<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Value> {
    let menu = &app.state::<TrayMenu<R>>().0;
    let tooltip = app.tray_by_id(TRAY_ID).map(|_| TOOLTIP).unwrap_or_default();
    Ok(json!({
        "platform": crate::electron_platform(),
        "tooltip": tooltip,
        "items": built_items(menu)?,
        "interaction": {
            "doubleClick": {
                "registered": DOUBLE_CLICK_SHOWS,
                "calls": if DOUBLE_CLICK_SHOWS { Action::ShowWindow.calls() } else { &[] },
            },
            "click": "none",
            "menuItems": Action::ALL
                .iter()
                .map(|action| json!({ "label": action.label(), "calls": action.calls() }))
                .collect::<Vec<_>>(),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `items` from T04's `parity/out/baseline/tray-menu.json`, recorded from
    /// Electron 1.2.1 on macOS.
    const ELECTRON_ITEMS: &str = r#"[
 {"type":"normal","label":"Show Window","role":null,"enabled":true,"visible":true,"checked":false,"accelerator":null,"submenu":null},
 {"type":"separator","label":"","role":null,"enabled":true,"visible":true,"checked":false,"accelerator":null,"submenu":null},
 {"type":"normal","label":"Quit","role":null,"enabled":true,"visible":true,"checked":false,"accelerator":null,"submenu":null}
]"#;

    #[test]
    fn menu_matches_the_electron_dump() {
        let electron: Vec<Value> = serde_json::from_str(ELECTRON_ITEMS).unwrap();
        assert_eq!(spec_items(), electron);
    }

    #[test]
    fn baseline_on_disk_matches_when_present() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../parity/out/baseline/tray-menu.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            eprintln!("no {}, checked against the copy above", path.display());
            return;
        };
        let baseline: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(Value::Array(spec_items()), baseline["items"]);
        assert_eq!(baseline["tooltip"], TOOLTIP);
    }

    #[test]
    fn menu_ids_round_trip() {
        for action in Action::ALL {
            assert_eq!(Action::from_id(action.id()), Some(action));
        }
        assert_eq!(Action::from_id("quit"), None);
    }

    #[test]
    fn hidpi_takes_the_2x_icon() {
        assert_eq!(icon_name(1.0), "assets/tray.png");
        assert_eq!(icon_name(1.5), "assets/tray@2x.png");
        assert_eq!(icon_name(2.0), "assets/tray@2x.png");
    }
}
