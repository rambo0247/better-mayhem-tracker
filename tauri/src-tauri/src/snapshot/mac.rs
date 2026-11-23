use std::cell::Cell;

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::NSObjectProtocol;
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSColorRenderingIntent, NSColorSpace, NSImage,
};
use objc2_core_foundation::{CFEqual, CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapInfo, CGColorSpace, CGContext, CGDataProvider, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, CGImageComponentInfo, CGImagePixelFormatInfo, kCGColorSpaceSRGB,
};
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

/// The card's pixels, read from WebKit's image. Drawing it through
/// `CGContextDrawImage` gives the same pixels, but CoreGraphics keeps the copy
/// it converts for every image it draws: one 10 MB `create_image_data_handle`
/// block per export, still live in the purgeable zone after the image is gone.
/// So a snapshot in 8-bit sRGB, the only kind measured so far, is copied as
/// it is, and only another format is drawn and converted.
fn card_bitmap(image: &NSImage) -> CardResult {
    // SAFETY: a null rect asks for the image at its own size
    let cg =
        unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }
            .ok_or("the snapshot has no bitmap")?;
    match copy_srgb(&cg) {
        Some(bitmap) => Ok(bitmap),
        None => {
            crate::assets::log_error(format!(
                "card export: drawing a snapshot of bitmap info {:#x}, {} bits a pixel, in {:?}",
                CGImage::bitmap_info(Some(&cg)).0,
                CGImage::bits_per_pixel(Some(&cg)),
                CGImage::color_space(Some(&cg))
                    .and_then(|space| CGColorSpace::name(Some(&space)))
                    .map(|name| name.to_string()),
            ));
            draw_srgb(&cg)
        }
    }
}

/// The image's bytes as RGB, or `None` when they are not 8-bit sRGB in a
/// layout [`rgb_offsets`] reads.
fn copy_srgb(cg: &CGImage) -> Option<CardBitmap> {
    let space = CGImage::color_space(Some(cg))?;
    // SAFETY: the constant is CoreGraphics', valid for the life of the process
    let srgb = unsafe { kCGColorSpaceSRGB };
    if !CGColorSpace::name(Some(&space)).is_some_and(|name| CFEqual(Some(&name), Some(srgb))) {
        return None;
    }
    let offsets = rgb_offsets(
        CGImage::bitmap_info(Some(cg)),
        CGImage::bits_per_component(Some(cg)),
        CGImage::bits_per_pixel(Some(cg)),
    )?;
    let data = CGDataProvider::data(CGImage::data_provider(Some(cg)).as_deref())?;
    // SAFETY: the bytes are CGDataProviderCopyData's own copy, which nothing mutates
    let bytes = unsafe { data.as_bytes_unchecked() };
    let (width, height) = (CGImage::width(Some(cg)), CGImage::height(Some(cg)));
    Some(CardBitmap {
        rgb: rgb_rows(
            bytes,
            width,
            height,
            CGImage::bytes_per_row(Some(cg)),
            offsets,
        )?,
        width: width as u32,
        height: height as u32,
    })
}

/// Where red, green and blue sit in a 4-byte pixel CoreGraphics describes with
/// `info`, for the layouts whose bytes are already the colors drawn on black:
/// 8-bit integer components, with alpha premultiplied or skipped.
fn rgb_offsets(
    info: CGBitmapInfo,
    bits_per_component: usize,
    bits_per_pixel: usize,
) -> Option<[usize; 3]> {
    let part = |mask: CGBitmapInfo| (info & mask).0;
    if bits_per_component != 8
        || bits_per_pixel != 32
        || part(CGBitmapInfo::ComponentInfoMask) != CGImageComponentInfo::Integer.0
        || part(CGBitmapInfo::PixelFormatInfoMask) != CGImagePixelFormatInfo::Packed.0
    {
        return None;
    }
    let first = match CGImageAlphaInfo(part(CGBitmapInfo::AlphaInfoMask)) {
        CGImageAlphaInfo::PremultipliedFirst | CGImageAlphaInfo::NoneSkipFirst => true,
        CGImageAlphaInfo::PremultipliedLast | CGImageAlphaInfo::NoneSkipLast => false,
        _ => return None,
    };
    let little = match CGImageByteOrderInfo(part(CGBitmapInfo::ByteOrderInfoMask)) {
        CGImageByteOrderInfo::Order32Little => true,
        CGImageByteOrderInfo::OrderDefault | CGImageByteOrderInfo::Order32Big => false,
        _ => return None,
    };
    Some(match (first, little) {
        (true, false) => [1, 2, 3],
        (true, true) => [2, 1, 0],
        (false, false) => [0, 1, 2],
        (false, true) => [3, 2, 1],
    })
}

/// `height` rows of `width` 4-byte pixels, `bytes_per_row` apart, as packed RGB.
fn rgb_rows(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    [r, g, b]: [usize; 3],
) -> Option<Vec<u8>> {
    if bytes_per_row < width * 4 || bytes.len() < bytes_per_row * height {
        return None;
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in bytes.chunks(bytes_per_row).take(height) {
        for pixel in row[..width * 4].as_chunks::<4>().0 {
            rgb.extend_from_slice(&[pixel[r], pixel[g], pixel[b]]);
        }
    }
    Some(rgb)
}

/// Draws the image into an sRGB bitmap of ours, converting whatever format
/// and color space it arrived in.
fn draw_srgb(cg: &CGImage) -> CardResult {
    let (width, height) = (CGImage::width(Some(cg)), CGImage::height(Some(cg)));
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
            Some(cg),
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

#[cfg(test)]
mod tests {
    use objc2_core_foundation::{CFData, CFString};
    use objc2_core_graphics::{CGColorRenderingIntent, kCGColorSpaceDisplayP3};

    use super::*;

    /// A 3 by 2 image in `space` whose bytes are `pixel(i)` for pixel `i`, with
    /// `pad` spare bytes at the end of every row.
    fn image(
        info: CGBitmapInfo,
        space: &CFString,
        pad: usize,
        pixel: impl Fn(u8) -> [u8; 4],
    ) -> CFRetained<CGImage> {
        let (width, height) = (3, 2);
        let bytes_per_row = width * 4 + pad;
        let mut bytes = vec![0xee; bytes_per_row * height];
        for y in 0..height {
            for x in 0..width {
                let at = y * bytes_per_row + x * 4;
                bytes[at..at + 4].copy_from_slice(&pixel((y * width + x) as u8));
            }
        }
        let provider = CGDataProvider::with_cf_data(Some(&CFData::from_bytes(&bytes))).unwrap();
        let space = CGColorSpace::with_name(Some(space)).unwrap();
        // SAFETY: the provider holds `height` rows of `bytes_per_row` bytes
        unsafe {
            CGImage::new(
                width,
                height,
                8,
                32,
                bytes_per_row,
                Some(&space),
                info,
                Some(&provider),
                std::ptr::null(),
                false,
                CGColorRenderingIntent::RenderingIntentDefault,
            )
        }
        .unwrap()
    }

    fn info(alpha: CGImageAlphaInfo, order: CGImageByteOrderInfo) -> CGBitmapInfo {
        CGBitmapInfo(alpha.0 | order.0)
    }

    #[test]
    fn copied_pixels_equal_what_coregraphics_draws_for_every_layout_it_reads() {
        let srgb = unsafe { kCGColorSpaceSRGB };
        for alpha in [
            CGImageAlphaInfo::PremultipliedFirst,
            CGImageAlphaInfo::PremultipliedLast,
            CGImageAlphaInfo::NoneSkipFirst,
            CGImageAlphaInfo::NoneSkipLast,
        ] {
            for order in [
                CGImageByteOrderInfo::OrderDefault,
                CGImageByteOrderInfo::Order32Big,
                CGImageByteOrderInfo::Order32Little,
            ] {
                // Opaque and translucent pixels, premultiplied where the alpha is
                let cg = image(info(alpha, order), srgb, 8, |i| {
                    let a = if i % 2 == 0 { 0xff } else { 0x80 };
                    let c = |v: u8| ((u16::from(v) * u16::from(a)) / 0xff) as u8;
                    let (r, g, b) = (c(10 + i * 40), c(200 - i * 30), c(i * 7));
                    let first = matches!(
                        alpha,
                        CGImageAlphaInfo::PremultipliedFirst | CGImageAlphaInfo::NoneSkipFirst
                    );
                    let big = if first { [a, r, g, b] } else { [r, g, b, a] };
                    if order == CGImageByteOrderInfo::Order32Little {
                        [big[3], big[2], big[1], big[0]]
                    } else {
                        big
                    }
                });
                let copied = copy_srgb(&cg).expect("an 8-bit sRGB layout is read as it is");
                assert_eq!(copied, draw_srgb(&cg).unwrap(), "{alpha:?} {order:?}");
                assert_eq!((copied.width, copied.height, copied.rgb.len()), (3, 2, 18));
            }
        }
    }

    #[test]
    fn webkits_layout_reads_blue_green_red_from_each_pixel() {
        // What the card snapshot measured: 0x2002, BGRA in memory
        let cg = image(
            info(
                CGImageAlphaInfo::PremultipliedFirst,
                CGImageByteOrderInfo::Order32Little,
            ),
            unsafe { kCGColorSpaceSRGB },
            0,
            |i| [i, 0x20, 0x30, 0xff],
        );
        assert_eq!(
            copy_srgb(&cg).unwrap().rgb,
            [
                0x30, 0x20, 0, 0x30, 0x20, 1, 0x30, 0x20, 2, 0x30, 0x20, 3, 0x30, 0x20, 4, 0x30,
                0x20, 5
            ]
        );
    }

    #[test]
    fn other_color_spaces_and_layouts_are_left_to_the_drawn_path() {
        let opaque = |i: u8| [i, i, i, 0xff];
        let p3 = image(
            info(
                CGImageAlphaInfo::NoneSkipLast,
                CGImageByteOrderInfo::OrderDefault,
            ),
            unsafe { kCGColorSpaceDisplayP3 },
            0,
            opaque,
        );
        assert_eq!(copy_srgb(&p3), None);
        assert!(draw_srgb(&p3).is_ok());
        let straight = image(
            info(CGImageAlphaInfo::Last, CGImageByteOrderInfo::OrderDefault),
            unsafe { kCGColorSpaceSRGB },
            0,
            opaque,
        );
        assert_eq!(copy_srgb(&straight), None);
        assert_eq!(
            rgb_offsets(CGBitmapInfo(CGImageAlphaInfo::NoneSkipLast.0), 16, 64),
            None
        );
    }

    #[test]
    fn short_or_narrow_rows_are_refused() {
        assert_eq!(rgb_rows(&[0; 23], 3, 2, 12, [0, 1, 2]), None);
        assert_eq!(rgb_rows(&[0; 24], 3, 2, 8, [0, 1, 2]), None);
        assert_eq!(
            rgb_rows(&[1, 2, 3, 4, 9, 9, 5, 6, 7, 8, 9, 9], 1, 2, 6, [0, 1, 2]),
            Some(vec![1, 2, 3, 5, 6, 7])
        );
    }
}
