//! The macOS application menu. Electron 1.2.1 sets none, so it shows
//! Electron's default menu, which T04 recorded as `app-menu.json`. This is
//! that menu, item for item, so Cmd+C, Cmd+V, Cmd+Q and the rest work.

use std::ffi::CStr;
use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

use crate::{PRODUCT_NAME, WINDOW_LABEL, shell};

/// Items AppKit already implements, through Tauri's predefined items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    Fullscreen,
    BringAllToFront,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Native(Native),
    /// Sent down the responder chain, as Electron's role does.
    Selector(&'static CStr),
    /// Through the final fetch, as the tray's Quit.
    Quit,
    Reload,
    ToggleDevtools,
    ResetZoom,
    ZoomIn,
    ZoomOut,
}

#[derive(Debug, Clone, Copy)]
pub enum Node {
    Submenu {
        label: &'static str,
        role: Option<&'static str>,
        items: &'static [Node],
    },
    Item {
        label: &'static str,
        role: &'static str,
        /// As Electron writes it, which the dump compares.
        accelerator: Option<&'static str>,
        action: Action,
    },
    Separator,
}

const fn item(
    label: &'static str,
    role: &'static str,
    accelerator: Option<&'static str>,
    action: Action,
) -> Node {
    Node::Item {
        label,
        role,
        accelerator,
        action,
    }
}

const fn native(
    label: &'static str,
    role: &'static str,
    accelerator: Option<&'static str>,
    native: Native,
) -> Node {
    item(label, role, accelerator, Action::Native(native))
}

const fn selector(label: &'static str, role: &'static str, sel: &'static CStr) -> Node {
    item(label, role, None, Action::Selector(sel))
}

const SEP: Node = Node::Separator;

/// `{app}` is the product name.
pub const MENU: &[Node] = &[
    Node::Submenu {
        label: "{app}",
        role: Some("appmenu"),
        items: &[
            native("About {app}", "about", None, Native::About),
            SEP,
            native("Services", "services", None, Native::Services),
            SEP,
            native("Hide {app}", "hide", Some("Command+H"), Native::Hide),
            native(
                "Hide Others",
                "hideothers",
                Some("Command+Alt+H"),
                Native::HideOthers,
            ),
            native("Show All", "unhide", None, Native::ShowAll),
            SEP,
            item(
                "Quit {app}",
                "quit",
                Some("CommandOrControl+Q"),
                Action::Quit,
            ),
        ],
    },
    Node::Submenu {
        label: "File",
        role: Some("filemenu"),
        items: &[native(
            "Close Window",
            "close",
            Some("CommandOrControl+W"),
            Native::CloseWindow,
        )],
    },
    Node::Submenu {
        label: "Edit",
        role: Some("editmenu"),
        items: &[
            native("Undo", "undo", Some("CommandOrControl+Z"), Native::Undo),
            native(
                "Redo",
                "redo",
                Some("Shift+CommandOrControl+Z"),
                Native::Redo,
            ),
            SEP,
            native("Cut", "cut", Some("CommandOrControl+X"), Native::Cut),
            native("Copy", "copy", Some("CommandOrControl+C"), Native::Copy),
            native("Paste", "paste", Some("CommandOrControl+V"), Native::Paste),
            item(
                "Paste and Match Style",
                "pasteandmatchstyle",
                Some("Cmd+Option+Shift+V"),
                Action::Selector(c"pasteAsPlainText:"),
            ),
            selector("Delete", "delete", c"delete:"),
            native(
                "Select All",
                "selectall",
                Some("CommandOrControl+A"),
                Native::SelectAll,
            ),
            SEP,
            Node::Submenu {
                label: "Substitutions",
                role: None,
                items: &[
                    selector(
                        "Show Substitutions",
                        "showsubstitutions",
                        c"orderFrontSubstitutionsPanel:",
                    ),
                    SEP,
                    selector(
                        "Smart Quotes",
                        "togglesmartquotes",
                        c"toggleAutomaticQuoteSubstitution:",
                    ),
                    selector(
                        "Smart Dashes",
                        "togglesmartdashes",
                        c"toggleAutomaticDashSubstitution:",
                    ),
                    selector(
                        "Text Replacement",
                        "toggletextreplacement",
                        c"toggleAutomaticTextReplacement:",
                    ),
                ],
            },
            Node::Submenu {
                label: "Speech",
                role: None,
                items: &[
                    selector("Start Speaking", "startspeaking", c"startSpeaking:"),
                    selector("Stop Speaking", "stopspeaking", c"stopSpeaking:"),
                ],
            },
        ],
    },
    Node::Submenu {
        label: "View",
        role: Some("viewmenu"),
        items: &[
            item("Reload", "reload", Some("CmdOrCtrl+R"), Action::Reload),
            item(
                "Force Reload",
                "forcereload",
                Some("Shift+CmdOrCtrl+R"),
                Action::Reload,
            ),
            item(
                "Toggle Developer Tools",
                "toggledevtools",
                Some("Alt+Command+I"),
                Action::ToggleDevtools,
            ),
            SEP,
            item(
                "Actual Size",
                "resetzoom",
                Some("CommandOrControl+0"),
                Action::ResetZoom,
            ),
            item(
                "Zoom In",
                "zoomin",
                Some("CommandOrControl+Plus"),
                Action::ZoomIn,
            ),
            item(
                "Zoom Out",
                "zoomout",
                Some("CommandOrControl+-"),
                Action::ZoomOut,
            ),
            SEP,
            native(
                "Toggle Full Screen",
                "togglefullscreen",
                Some("Control+Command+F"),
                Native::Fullscreen,
            ),
        ],
    },
    Node::Submenu {
        label: "Window",
        role: Some("windowmenu"),
        items: &[
            native(
                "Minimize",
                "minimize",
                Some("CommandOrControl+M"),
                Native::Minimize,
            ),
            native("Zoom", "zoom", None, Native::Zoom),
            SEP,
            native("Bring All to Front", "front", None, Native::BringAllToFront),
        ],
    },
];

pub fn label(template: &str) -> String {
    template.replace("{app}", PRODUCT_NAME)
}

/// Electron writes Cmd+= as `Plus`, which the menu's parser has no name for.
pub fn native_accelerator(electron: &str) -> String {
    electron.replace("Plus", "=")
}

/// A custom item's id is its Electron role, which is unique in the menu.
pub fn action_for(id: &str) -> Option<Action> {
    fn find(nodes: &[Node], id: &str) -> Option<Action> {
        nodes.iter().find_map(|node| match *node {
            Node::Item { role, action, .. } if role == id => Some(action),
            Node::Submenu { items, .. } => find(items, id),
            _ => None,
        })
    }
    find(MENU, id).filter(|action| !matches!(action, Action::Native(_)))
}

/// Electron's dump shape: label, role, enabled, visible, checked, accelerator.
pub fn spec_dump() -> Vec<Value> {
    fn dump(nodes: &[Node]) -> Vec<Value> {
        nodes
            .iter()
            .map(|node| {
                let (kind, text, role, accelerator, submenu) = match *node {
                    Node::Separator => ("separator", String::new(), None, None, None),
                    Node::Item {
                        label: text,
                        role,
                        accelerator,
                        ..
                    } => ("normal", label(text), Some(role), accelerator, None),
                    Node::Submenu {
                        label: text,
                        role,
                        items,
                    } => ("submenu", label(text), role, None, Some(dump(items))),
                };
                json!({
                    "type": kind,
                    "label": text,
                    "role": role,
                    "enabled": true,
                    "visible": true,
                    "checked": false,
                    "accelerator": accelerator,
                    "submenu": submenu,
                })
            })
            .collect()
    }
    dump(MENU)
}

/// Electron's zoom level, in half steps of 1.2x.
#[derive(Default)]
pub struct ZoomLevel(Mutex<f64>);

pub fn zoom_factor(level: f64) -> f64 {
    1.2f64.powf(level)
}

fn build_nodes<R: Runtime>(
    app: &AppHandle<R>,
    nodes: &[Node],
) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    nodes
        .iter()
        .map(|node| -> tauri::Result<Box<dyn IsMenuItem<R>>> {
            Ok(match *node {
                Node::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Node::Submenu {
                    label: text,
                    role,
                    items,
                } => {
                    let built = build_nodes(app, items)?;
                    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|b| b.as_ref()).collect();
                    let submenu = Submenu::with_items(app, label(text), true, &refs)?;
                    #[cfg(target_os = "macos")]
                    {
                        if role == Some("windowmenu") {
                            submenu.set_as_windows_menu_for_nsapp()?;
                        }
                    }
                    let _ = role;
                    Box::new(submenu)
                }
                Node::Item {
                    label: template,
                    role,
                    accelerator,
                    action,
                } => {
                    let text = label(template);
                    match action {
                        Action::Native(kind) => Box::new(predefined(app, kind, &text)?),
                        _ => Box::new(MenuItem::with_id(
                            app,
                            role,
                            text,
                            true,
                            accelerator.map(native_accelerator),
                        )?),
                    }
                }
            })
        })
        .collect()
}

fn predefined<R: Runtime>(
    app: &AppHandle<R>,
    kind: Native,
    text: &str,
) -> tauri::Result<PredefinedMenuItem<R>> {
    let text = Some(text);
    match kind {
        Native::About => PredefinedMenuItem::about(app, text, None),
        Native::Services => PredefinedMenuItem::services(app, text),
        Native::Hide => PredefinedMenuItem::hide(app, text),
        Native::HideOthers => PredefinedMenuItem::hide_others(app, text),
        Native::ShowAll => PredefinedMenuItem::show_all(app, text),
        Native::CloseWindow => PredefinedMenuItem::close_window(app, text),
        Native::Undo => PredefinedMenuItem::undo(app, text),
        Native::Redo => PredefinedMenuItem::redo(app, text),
        Native::Cut => PredefinedMenuItem::cut(app, text),
        Native::Copy => PredefinedMenuItem::copy(app, text),
        Native::Paste => PredefinedMenuItem::paste(app, text),
        Native::SelectAll => PredefinedMenuItem::select_all(app, text),
        Native::Minimize => PredefinedMenuItem::minimize(app, text),
        Native::Zoom => PredefinedMenuItem::maximize(app, text),
        Native::Fullscreen => PredefinedMenuItem::fullscreen(app, text),
        Native::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, text),
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let built = build_nodes(app, MENU)?;
    let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Sets the menu on macOS. Windows and Linux windows carry no menu, as
/// Electron's frameless window shows none.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if cfg!(target_os = "macos") {
        app.manage(ZoomLevel::default());
        app.set_menu(build(app)?)?;
        app.on_menu_event(on_menu_event);
    }
    Ok(())
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(action) = action_for(event.id().as_ref()) else {
        return;
    };
    let webview = app.get_webview_window(WINDOW_LABEL);
    match action {
        Action::Quit => shell::request_quit(app),
        Action::Selector(sel) => send_action(sel),
        Action::Reload => {
            if let Some(webview) = webview {
                let _ = webview.reload();
            }
        }
        Action::ToggleDevtools => {
            if let Some(webview) = webview {
                if webview.is_devtools_open() {
                    webview.close_devtools();
                } else {
                    webview.open_devtools();
                }
            }
        }
        Action::ResetZoom | Action::ZoomIn | Action::ZoomOut => {
            let Some(webview) = webview else { return };
            let zoom = app.state::<ZoomLevel>();
            let mut level = zoom.0.lock().expect("zoom level");
            *level = match action {
                Action::ZoomIn => *level + 0.5,
                Action::ZoomOut => *level - 0.5,
                _ => 0.0,
            };
            let _ = webview.set_zoom(zoom_factor(*level));
        }
        Action::Native(_) => {}
    }
}

#[cfg(target_os = "macos")]
fn send_action(sel: &'static CStr) {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    // SAFETY: a nil target sends the action down the responder chain, which
    // ignores a selector nothing in it implements
    unsafe { app.sendAction_to_from(objc2::runtime::Sel::register(sel), None, None) };
}

#[cfg(not(target_os = "macos"))]
fn send_action(_: &'static CStr) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// `menu` from T04's `parity/out/baseline/app-menu.json`, recorded from
    /// Electron 1.2.1's default menu on macOS, one line per item: label, role,
    /// accelerator. The dev run's name `better-mayhem-tracker` reads as the
    /// product name, which a packaged Electron shows.
    const ELECTRON: &str = "
{app}|appmenu|
 About {app}|about|
 -
 Services|services|
 -
 Hide {app}|hide|Command+H
 Hide Others|hideothers|Command+Alt+H
 Show All|unhide|
 -
 Quit {app}|quit|CommandOrControl+Q
File|filemenu|
 Close Window|close|CommandOrControl+W
Edit|editmenu|
 Undo|undo|CommandOrControl+Z
 Redo|redo|Shift+CommandOrControl+Z
 -
 Cut|cut|CommandOrControl+X
 Copy|copy|CommandOrControl+C
 Paste|paste|CommandOrControl+V
 Paste and Match Style|pasteandmatchstyle|Cmd+Option+Shift+V
 Delete|delete|
 Select All|selectall|CommandOrControl+A
 -
 Substitutions||
  Show Substitutions|showsubstitutions|
  -
  Smart Quotes|togglesmartquotes|
  Smart Dashes|togglesmartdashes|
  Text Replacement|toggletextreplacement|
 Speech||
  Start Speaking|startspeaking|
  Stop Speaking|stopspeaking|
View|viewmenu|
 Reload|reload|CmdOrCtrl+R
 Force Reload|forcereload|Shift+CmdOrCtrl+R
 Toggle Developer Tools|toggledevtools|Alt+Command+I
 -
 Actual Size|resetzoom|CommandOrControl+0
 Zoom In|zoomin|CommandOrControl+Plus
 Zoom Out|zoomout|CommandOrControl+-
 -
 Toggle Full Screen|togglefullscreen|Control+Command+F
Window|windowmenu|
 Minimize|minimize|CommandOrControl+M
 Zoom|zoom|
 -
 Bring All to Front|front|
";

    fn outline(items: &[Value], depth: usize, out: &mut Vec<String>) {
        for item in items {
            let pad = " ".repeat(depth);
            if item["type"] == "separator" {
                out.push(format!("{pad}-"));
                continue;
            }
            out.push(format!(
                "{pad}{}|{}|{}",
                item["label"].as_str().unwrap(),
                item["role"].as_str().unwrap_or(""),
                item["accelerator"].as_str().unwrap_or("")
            ));
            if let Some(sub) = item["submenu"].as_array() {
                outline(sub, depth + 1, out);
            }
        }
    }

    #[test]
    fn menu_matches_the_electron_default_menu() {
        let mut got = Vec::new();
        outline(&spec_dump(), 0, &mut got);
        let want: Vec<String> = ELECTRON.trim_matches('\n').lines().map(label).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn every_custom_item_has_an_action_and_parses() {
        fn walk(nodes: &[Node]) {
            for node in nodes {
                match *node {
                    Node::Item {
                        role,
                        accelerator,
                        action,
                        ..
                    } => {
                        if !matches!(action, Action::Native(_)) {
                            assert_eq!(action_for(role), Some(action), "{role}");
                        }
                        if let Some(accelerator) = accelerator {
                            let parsed = native_accelerator(accelerator)
                                .parse::<muda::accelerator::Accelerator>();
                            assert!(parsed.is_ok(), "{accelerator}: {parsed:?}");
                        }
                    }
                    Node::Submenu { items, .. } => walk(items),
                    Node::Separator => {}
                }
            }
        }
        walk(MENU);
        assert_eq!(action_for("quit"), Some(Action::Quit));
        assert_eq!(action_for("copy"), None, "copy is AppKit's");
    }

    #[test]
    fn zoom_steps_match_chromium_levels() {
        assert_eq!(zoom_factor(0.0), 1.0);
        assert!((zoom_factor(0.5) - 1.0954).abs() < 1e-4);
        assert!((zoom_factor(-1.0) - 1.0 / 1.2).abs() < 1e-9);
    }
}
