use std::cell::Cell;

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::NSObjectProtocol;
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSColorRenderingIntent, NSColorSpace, NSImage,
};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, kCGColorSpaceSRGB};
use objc2_foundation::{NSDictionary, NSError, NSNumber};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use tauri::WebviewWindow;

use super::{
    CardBitmap, CardResult, CardScale, CardShot, Snapshot, SnapshotOptions, SnapshotResult,
};

pub fn snapshot(
    window: &WebviewWindow,
    options: SnapshotOptions,
    done: impl FnOnce(SnapshotResult) + Send + 'static,
) -> tauri::Result<()> {
    with_web(window, done, move |web, mtm, done| {
        let backing = web.window().map_or(1.0, |w| w.backingScaleFactor());
        let bounds = web.bounds();
        let (width, height) = options
            .size
            .unwrap_or((bounds.size.width, bounds.size.height));
        // The width is in points; WebKit multiplies it by the backing scale
        take(
            web,
            mtm,
            (width, height),
            width * options.scale / backing,
            done,
            move |image| encode(image, backing),
        );
    })
}

/// WebKit's private device scale override, the call Electron's page zoom
/// stands for: layout stays at the window's width in CSS px while the bitmap
/// is `scale` times that. It is looked up at run time, so a macOS without it
/// answers `respondsToSelector` with no and the export takes the public path.
pub fn prepare_card_scale(
    window: &WebviewWindow,
    scale: f64,
    done: impl FnOnce(Result<CardScale, String>) + Send + 'static,
) -> tauri::Result<()> {
    with_web(window, done, move |web, _mtm, done| {
        let selector = sel!(_setOverrideDeviceScaleFactor:);
        if web.respondsToSelector(selector) {
            // SAFETY: the selector exists on this WKWebView and takes one CGFloat
            let _: () = unsafe { msg_send![web, _setOverrideDeviceScaleFactor: scale] };
            done(Ok(CardScale::Exact(scale)));
        } else {
            let backing = web.window().map_or(1.0, |w| w.backingScaleFactor());
            done(Ok(CardScale::Backing(backing)));
        }
    })
}

pub fn card_snapshot(
    window: &WebviewWindow,
    shot: CardShot,
    done: impl FnOnce(CardResult) + Send + 'static,
) -> tauri::Result<()> {
    with_web(window, done, move |web, mtm, done| {
        take(
            web,
            mtm,
            (shot.width, shot.height),
            shot.width * shot.scale / shot.rendered.rendered(),
            done,
            card_bitmap,
        );
    })
}

/// Runs `f` with the window's WKWebView on the main thread, or hands `done`
/// the reason it can't.
fn with_web<T: 'static>(
    window: &WebviewWindow,
    done: impl FnOnce(Result<T, String>) + Send + 'static,
    f: impl FnOnce(&WKWebView, MainThreadMarker, Box<dyn FnOnce(Result<T, String>)>) + Send + 'static,
) -> tauri::Result<()> {
    window.with_webview(move |platform| {
        let Some(webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() else {
            done(Err("the webview is not a wry webview".into()));
            return;
        };
        let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
        // SAFETY: wry hands out its live WKWebView, and this closure runs on the main thread
        let web: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };
        f(web, mtm, Box::new(done));
    })
}

/// `rect` in points from the view's top left, `snapshot_width` in points of
/// output; WebKit multiplies it by the scale the page renders at.
fn take<T: 'static>(
    web: &WKWebView,
    mtm: MainThreadMarker,
    (width, height): (f64, f64),
    snapshot_width: f64,
    done: Box<dyn FnOnce(Result<T, String>)>,
    convert: impl Fn(&NSImage) -> Result<T, String> + 'static,
) {
    let config = unsafe { WKSnapshotConfiguration::new(mtm) };
    unsafe {
        config.setRect(CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(width, height),
        ));
        config.setSnapshotWidth(Some(&NSNumber::new_f64(snapshot_width)));
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
            // WebKit calls back outside any autorelease pool, so the TIFF and the
            // bitmap AppKit autoreleases would outlive the export without one
            .and_then(|image| autoreleasepool(|_| convert(image)));
        done(result);
    });
    unsafe { web.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block) };
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

/// The card's pixels, drawn from WebKit's own image into an sRGB bitmap of
/// ours. No TIFF or PNG in between: each of those left another 10 MB in the
/// allocator's cache per export, and CoreGraphics converts the color space on
/// the way, which is a no-op for the sRGB snapshots measured so far.
fn card_bitmap(image: &NSImage) -> CardResult {
    // SAFETY: a null rect asks for the image at its own size
    let cg =
        unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }
            .ok_or("the snapshot has no bitmap")?;
    let (width, height) = (CGImage::width(Some(&cg)), CGImage::height(Some(&cg)));
    let srgb =
        CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB })).ok_or("no sRGB color space")?;
    let mut pixels = vec![0u8; width * height * 4];
    {
        // SAFETY: `pixels` holds `height` rows of `width * 4` bytes and outlives the context
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                width,
                height,
                8,
                width * 4,
                Some(&srgb),
                CGImageAlphaInfo::NoneSkipLast.0,
            )
        }
        .ok_or("could not make a bitmap to draw the snapshot into")?;
        // SAFETY: CGBitmapContextCreate returns a +1 reference
        let context = unsafe { CFRetained::<CGContext>::from_raw(context) };
        CGContext::draw_image(
            Some(&context),
            CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(width as f64, height as f64),
            ),
            Some(&cg),
        );
    }
    // RGBX to RGB in place, so no second buffer
    for i in 0..width * height {
        pixels.copy_within(i * 4..i * 4 + 3, i * 3);
    }
    pixels.truncate(width * height * 3);
    Ok(CardBitmap {
        rgb: pixels,
        width: width as u32,
        height: height as u32,
    })
}

unsafe extern "C-unwind" {
    // Not in objc2-core-graphics 0.3.2's bindings
    fn CGBitmapContextCreate(
        data: *mut std::ffi::c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: Option<&CGColorSpace>,
        bitmap_info: u32,
    ) -> Option<std::ptr::NonNull<CGContext>>;
}
