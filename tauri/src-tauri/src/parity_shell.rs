//! Driver ops for the window shell: pictures of the native title bar and the
//! tray icon, the tray's actions, the menus as built and as AppKit holds them,
//! AppKit's `terminate:`, and the window state.
//! AppKit draws each picture in-process from the view itself, the way the
//! webview snapshot is taken, so nothing reads the screen.

use serde_json::{Value, json};
use tauri::menu::{Menu, MenuItemKind};
use tauri::{DynRuntime, Manager, WebviewWindow};

use crate::{app_menu, shell, tray};

/// Stands in for the units that own these until they land: T11's settings
/// table and T20's final fetch, which a lane sets to hang for a while.
pub fn install_stand_ins(app: &tauri::AppHandle<DynRuntime>) {
    let shell = app.state::<shell::Shell>();
    if let Ok(value) = std::env::var("BMT_PARITY_MINIMIZE_TO_TRAY") {
        shell.read_minimize_to_tray(move || Some(value.clone()));
    }
    if let Some(ms) = std::env::var("BMT_PARITY_FINAL_FETCH_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
    {
        shell.final_fetch(move || {
            Some(Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                println!("[parity] stand-in final fetch finished after {ms} ms");
                Ok(())
            }))
        });
    }
}

pub struct Raw {
    pub meta: Value,
    pub bytes: Vec<u8>,
}

pub enum Reply {
    Json(Value),
    Image(Raw),
}

pub fn dispatch(window: &WebviewWindow, op: &str, body: &Value) -> Option<Result<Reply, String>> {
    let app = window.app_handle();
    Some(match op {
        "shell-state" => state(window).map(Reply::Json),
        "shell-tray" => {
            let action = body.get("action").and_then(Value::as_str).unwrap_or("");
            match action {
                "double-click" if tray::DOUBLE_CLICK_SHOWS => {
                    tray::run(app, tray::Action::ShowWindow);
                    Ok(Reply::Json(json!({ "ran": action })))
                }
                "double-click" => Err("this platform reports no tray double-click".into()),
                id => match tray::Action::from_id(id) {
                    Some(action) => {
                        tray::run(app, action);
                        Ok(Reply::Json(json!({ "ran": id })))
                    }
                    None => Err(format!("no tray action {id:?}")),
                },
            }
        }
        "shell-menus" => menus(app).map(Reply::Json),
        "shell-shot" => {
            let target = body
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or("window");
            shot(window, target).map(Reply::Image)
        }
        "shell-native-menu" => platform::native_menu(window).map(Reply::Json),
        "shell-terminate" => {
            platform::terminate(window).map(|()| Reply::Json(json!({ "sent": true })))
        }
        _ => return None,
    })
}

fn state(window: &WebviewWindow) -> Result<Value, String> {
    let e = |error: tauri::Error| error.to_string();
    let app = window.app_handle();
    let tray_rect = app
        .tray_by_id(tray::TRAY_ID)
        .map(|tray| tray.rect())
        .transpose()
        .map_err(e)?
        .flatten();
    Ok(json!({
        "visible": window.is_visible().map_err(e)?,
        "minimized": window.is_minimized().map_err(e)?,
        "maximized": window.is_maximized().map_err(e)?,
        "focused": window.is_focused().map_err(e)?,
        "devtoolsOpen": window.is_devtools_open(),
        "phase": format!("{:?}", app.state::<shell::Shell>().phase()),
        "launchedHidden": app.state::<shell::Shell>().launched_hidden(),
        "tray": tray_rect.map(|rect| json!({ "rect": format!("{rect:?}") })),
        "buttons": platform::buttons(window)?,
    }))
}

fn outline(items: Vec<MenuItemKind<DynRuntime>>) -> tauri::Result<Vec<Value>> {
    items
        .into_iter()
        .map(|item| {
            Ok(match item {
                MenuItemKind::Submenu(sub) => {
                    json!({ "label": sub.text()?, "submenu": outline(sub.items()?)? })
                }
                MenuItemKind::MenuItem(item) => json!({ "label": item.text()? }),
                MenuItemKind::Predefined(item) => json!({ "label": item.text()? }),
                MenuItemKind::Check(item) => json!({ "label": item.text()? }),
                MenuItemKind::Icon(item) => json!({ "label": item.text()? }),
            })
        })
        .collect()
}

fn menus(app: &tauri::AppHandle<DynRuntime>) -> Result<Value, String> {
    let e = |error: tauri::Error| error.to_string();
    let live = match app.menu() {
        Some(menu) => Some(outline(Menu::items(&menu).map_err(e)?).map_err(e)?),
        None => None,
    };
    Ok(json!({
        "tray": tray::dump(app).map_err(e)?,
        "appMenu": {
            "platform": crate::electron_platform(),
            "appName": crate::PRODUCT_NAME,
            "menu": if live.is_some() { Value::Array(app_menu::spec_dump()) } else { Value::Null },
            "live": live,
        },
    }))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::runtime::AnyObject;
    use objc2::{MainThreadMarker, msg_send, sel};
    use objc2_app_kit::{
        NSApplication, NSBitmapImageFileType, NSEventModifierFlags, NSMenu, NSView, NSWindowButton,
    };
    use objc2_foundation::NSDictionary;
    use objc2_web_kit::WKWebView;
    use serde_json::{Value, json};
    use tauri::{Manager, WebviewWindow};

    use super::Raw;
    use crate::tray;

    fn on_main<T: Send + 'static>(
        window: &WebviewWindow,
        f: impl FnOnce(&WKWebView, MainThreadMarker) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |platform| {
                let Some(webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() else {
                    return;
                };
                let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
                // SAFETY: wry's live WKWebView, on the main thread
                let web: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };
                let _ = tx.send(f(web, mtm));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "the main thread did not answer".to_string())
    }

    /// Each button's frame in window points from the top left, as T01's
    /// prototype measured them.
    pub fn buttons(window: &WebviewWindow) -> Result<Value, String> {
        on_main(window, |web, _| {
            let Some(ns_window) = web.window() else {
                return Value::Null;
            };
            let height = ns_window.frame().size.height;
            let named = [
                ("close", NSWindowButton::CloseButton),
                ("minimize", NSWindowButton::MiniaturizeButton),
                ("zoom", NSWindowButton::ZoomButton),
            ];
            let frames: Vec<Value> = named
                .into_iter()
                .filter_map(|(name, kind)| {
                    let button = ns_window.standardWindowButton(kind)?;
                    let rect = button.convertRect_toView(button.bounds(), None);
                    Some(json!({
                        "name": name,
                        "x": rect.origin.x,
                        "y": height - rect.origin.y - rect.size.height,
                        "width": rect.size.width,
                        "height": rect.size.height,
                    }))
                })
                .collect();
            json!(frames)
        })
    }

    /// AppKit draws the view into a bitmap here, in this process. Nothing is
    /// read back from the window server, so the picture holds only what the
    /// view itself draws, at the screen's backing scale.
    fn draw(view: &NSView) -> Result<Raw, String> {
        let bounds = view.bounds();
        let rep = view
            .bitmapImageRepForCachingDisplayInRect(bounds)
            .ok_or("the view gave no bitmap")?;
        view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .ok_or("PNG encoding failed")?;
        Ok(Raw {
            meta: json!({
                "width": rep.pixelsWide(),
                "height": rep.pixelsHigh(),
                "points": [bounds.size.width, bounds.size.height],
            }),
            bytes: png.to_vec(),
        })
    }

    fn menu_items(menu: &NSMenu) -> Vec<Value> {
        (0..menu.numberOfItems())
            .filter_map(|index| menu.itemAtIndex(index))
            .map(|item| {
                if item.isSeparatorItem() {
                    return json!({ "separator": true, "hidden": item.isHidden() });
                }
                let mask = item.keyEquivalentModifierMask();
                let modifiers: Vec<&str> = [
                    (NSEventModifierFlags::Function, "Fn"),
                    (NSEventModifierFlags::Control, "Ctrl"),
                    (NSEventModifierFlags::Option, "Alt"),
                    (NSEventModifierFlags::Shift, "Shift"),
                    (NSEventModifierFlags::Command, "Cmd"),
                ]
                .into_iter()
                .filter(|(flag, _)| mask.contains(*flag))
                .map(|(_, name)| name)
                .collect();
                let key = item.keyEquivalent().to_string();
                json!({
                    "title": item.title().to_string(),
                    "key": if key.is_empty() { Value::Null } else { json!(key) },
                    "modifiers": modifiers,
                    "hidden": item.isHidden(),
                    "alternate": item.isAlternate(),
                    "action": item.action().map(|action| action.name().to_string_lossy().into_owned()),
                    "submenu": item.submenu().map(|sub| menu_items(&sub)),
                })
            })
            .collect()
    }

    /// The main menu as AppKit holds it, with the items AppKit adds itself.
    pub fn native_menu(window: &WebviewWindow) -> Result<Value, String> {
        on_main(window, |_, mtm| {
            NSApplication::sharedApplication(mtm)
                .mainMenu()
                .map_or(Value::Null, |menu| json!(menu_items(&menu)))
        })
    }

    /// Sends AppKit's `terminate:`, as the Dock's Quit and logout do. It is
    /// scheduled on the run loop, because `terminate:` sent inside a driver
    /// call would wait on the event handler that is running the call.
    pub fn terminate(window: &WebviewWindow) -> Result<(), String> {
        window
            .run_on_main_thread(|| {
                let mtm =
                    MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
                let app = NSApplication::sharedApplication(mtm);
                // SAFETY: NSObject's performSelector:withObject:afterDelay:, with
                // a selector NSApplication answers and no argument
                let _: () = unsafe {
                    msg_send![
                        &*app,
                        performSelector: sel!(terminate:),
                        withObject: std::ptr::null::<AnyObject>(),
                        afterDelay: 0.0f64
                    ]
                };
            })
            .map_err(|e| e.to_string())
    }

    pub fn shot(window: &WebviewWindow, target: &str) -> Result<Raw, String> {
        match target {
            // The title bar strip that holds the traffic lights, placed by
            // its frame in window points from the top left
            "titlebar" => on_main(window, |web, _| {
                let ns_window = web.window().ok_or("the webview has no window")?;
                let button = ns_window
                    .standardWindowButton(NSWindowButton::CloseButton)
                    .ok_or("the window has no close button")?;
                let bar = unsafe { button.superview() }.ok_or("the button has no title bar")?;
                let rect = bar.convertRect_toView(bar.bounds(), None);
                let height = ns_window.frame().size.height;
                let mut raw = draw(&bar)?;
                raw.meta["origin"] =
                    json!([rect.origin.x, height - rect.origin.y - rect.size.height]);
                Ok(raw)
            })?,
            "tray" => {
                let tray = window
                    .app_handle()
                    .tray_by_id(tray::TRAY_ID)
                    .ok_or("no tray icon")?;
                let (tx, rx) = mpsc::channel();
                tray.with_inner_blocking(move |inner| {
                    let button = inner
                        .ns_status_item()
                        .and_then(|item| item.button(MainThreadMarker::new()?));
                    let _ = tx.send(match button {
                        Some(button) => draw(&button),
                        None => Err("the status item has no button".into()),
                    });
                })
                .map_err(|e| e.to_string())?;
                rx.recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "the main thread did not answer".to_string())?
            }
            other => Err(format!("no picture of {other:?}")),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use serde_json::Value;
    use tauri::WebviewWindow;

    use super::Raw;

    pub fn buttons(_: &WebviewWindow) -> Result<Value, String> {
        Ok(Value::Null)
    }

    pub fn shot(_: &WebviewWindow, target: &str) -> Result<Raw, String> {
        Err(format!(
            "native pictures of {target:?} are macOS only; Windows draws its title bar in the page"
        ))
    }

    pub fn native_menu(_: &WebviewWindow) -> Result<Value, String> {
        Ok(Value::Null)
    }

    pub fn terminate(_: &WebviewWindow) -> Result<(), String> {
        Err("terminate: is AppKit's".into())
    }
}

use platform::shot;
