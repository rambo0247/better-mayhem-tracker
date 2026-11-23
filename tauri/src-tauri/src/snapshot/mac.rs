use std::cell::Cell;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSColorRenderingIntent, NSColorSpace, NSImage,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSDictionary, NSError, NSNumber};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use tauri::WebviewWindow;

use super::{Snapshot, SnapshotOptions, SnapshotResult};

pub fn snapshot(
    window: &WebviewWindow,
    options: SnapshotOptions,
    done: impl FnOnce(SnapshotResult) + Send + 'static,
) -> tauri::Result<()> {
    window.with_webview(move |platform| {
        let Some(webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() else {
            done(Err("the webview is not a wry webview".into()));
            return;
        };
        let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
        // SAFETY: wry hands out its live WKWebView, and this closure runs on the main thread
        let web: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };
        let backing = web.window().map_or(1.0, |w| w.backingScaleFactor());
        let bounds = web.bounds();
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe {
            config.setRect(CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(bounds.size.width, bounds.size.height),
            ));
            // The width is in points; WebKit multiplies it by the backing scale
            config.setSnapshotWidth(Some(&NSNumber::new_f64(
                bounds.size.width * options.scale / backing,
            )));
            config.setAfterScreenUpdates(true);
        }
        let done = Cell::new(Some(done));
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let Some(done) = done.take() else { return };
            // SAFETY: WebKit passes either an image or an error, both valid for the call
            let result = unsafe { image.as_ref() }
                .ok_or_else(|| match unsafe { error.as_ref() } {
                    Some(error) => error.localizedDescription().to_string(),
                    None => "WebKit returned no image".to_string(),
                })
                .and_then(|image| encode(image, backing));
            done(result);
        });
        unsafe { web.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block) };
    })
}

/// PNG in sRGB. The snapshot arrives in the display's color space, and the
/// Electron baseline is forced to sRGB, so leaving it would count every pixel.
fn encode(image: &NSImage, backing_scale: f64) -> SnapshotResult {
    let tiff = image
        .TIFFRepresentation()
        .ok_or("the snapshot has no bitmap")?;
    let rep =
        NSBitmapImageRep::imageRepWithData(&tiff).ok_or("the snapshot bitmap is unreadable")?;
    let source_color_space = rep
        .colorSpace()
        .localizedName()
        .map_or_else(|| rep.colorSpaceName().to_string(), |name| name.to_string());
    let srgb = rep
        .bitmapImageRepByConvertingToColorSpace_renderingIntent(
            &NSColorSpace::sRGBColorSpace(),
            NSColorRenderingIntent::Default,
        )
        .ok_or("conversion to sRGB failed")?;
    let png = unsafe {
        srgb.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("PNG encoding failed")?;
    Ok(Snapshot {
        png: png.to_vec(),
        width: srgb.pixelsWide() as usize,
        height: srgb.pixelsHigh() as usize,
        source_color_space,
        backing_scale,
    })
}
