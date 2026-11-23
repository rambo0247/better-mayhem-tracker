//! The disk half of `src/main/game-assets.ts`: copies of League art and game
//! data under `asset-cache/<patch>/<sha1 of the game path><ext>`, the layout
//! Electron 1.2.1 writes, so a player's existing folder is read as it is.
//! Any file here can be deleted at any time and fetched again.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::assets::{log, log_error};

/// Past the first, the least recently used files go until the second is reached
pub const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
pub const TARGET_CACHE_BYTES: u64 = 192 * 1024 * 1024;
/// A read marks its file as used through the mtime, at most this often, so a
/// cache hit is a read and not also a write
pub const TOUCH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// A temp file this old belongs to a write that never finished
pub const STRAY_TEMP: Duration = Duration::from_secs(60 * 60);

/// A patch branch ("16.14") is an archive and never changes. "latest" and
/// "pbe" move with Riot's releases under the same name.
pub fn is_patch_branch(branch: &str) -> bool {
    match branch.split_once('.') {
        Some((major, minor)) => is_digits(major) && is_digits(minor),
        None => false,
    }
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `split(".").map(Number)`, for names [`is_patch_branch`] already passed.
fn patch_number(patch: &str) -> (f64, f64) {
    let mut parts = patch
        .split('.')
        .map(|p| p.parse::<f64>().unwrap_or(f64::NAN));
    (
        parts.next().unwrap_or(f64::NAN),
        parts.next().unwrap_or(f64::NAN),
    )
}

/// Newest first: `bMajor - aMajor || bMinor - aMinor`.
pub fn by_newest_patch(a: &str, b: &str) -> std::cmp::Ordering {
    let (a_major, a_minor) = patch_number(a);
    let (b_major, b_minor) = patch_number(b);
    b_major
        .total_cmp(&a_major)
        .then_with(|| b_minor.total_cmp(&a_minor))
}

/// Node's `path.extname` for a `/`-separated path.
fn extname(game_path: &str) -> &str {
    let base = game_path.rsplit('/').next().unwrap_or(game_path);
    match base.rfind('.') {
        Some(dot) if dot > 0 && base != ".." => &base[dot..],
        _ => "",
    }
}

/// The file name a game path is filed under. Hashed rather than mirrored, so
/// no game path can name a file outside the cache or run past Windows' path
/// limit.
pub fn file_name(game_path: &str) -> String {
    format!(
        "{}{}",
        sha1_smol::Sha1::from(game_path).digest(),
        extname(game_path)
    )
}

/// What a prune removed, for its log line and for tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pruned {
    pub before: u64,
    pub after: u64,
}

pub struct AssetCache {
    root: PathBuf,
    /// Patches with copies on disk, newest first, read once and kept current
    /// by [`AssetCache::store`] until a prune forgets it
    patches: Mutex<Option<Vec<String>>>,
}

impl AssetCache {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            patches: Mutex::new(None),
        }
    }

    /// Where the copy of `game_path` from `key` lives. `key` is always a patch
    /// ([`is_patch_branch`]), and the name is a hash, so the result is always
    /// one level below the root.
    pub fn file(&self, key: &str, game_path: &str) -> PathBuf {
        debug_assert!(is_patch_branch(key), "cache key {key:?} is not a patch");
        self.root.join(key).join(file_name(game_path))
    }

    pub fn patches(&self) -> Vec<String> {
        let mut patches = self.patches.lock().expect("patches lock");
        patches
            .get_or_insert_with(|| {
                let mut found: Vec<String> = std::fs::read_dir(&self.root)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .filter(|name| is_patch_branch(name))
                    .collect();
                found.sort_by(|a, b| by_newest_patch(a, b));
                found
            })
            .clone()
    }

    /// The copy's bytes, or `None` when there is none. A copy not read for a
    /// day gets its mtime bumped, which is what the prune orders by.
    pub async fn read(&self, file: &Path) -> Option<Vec<u8>> {
        let (bytes, meta) = tokio::join!(tokio::fs::read(file), tokio::fs::metadata(file));
        let (bytes, meta) = (bytes.ok()?, meta.ok()?);
        let stale = meta
            .modified()
            .ok()
            .and_then(|mtime| SystemTime::now().duration_since(mtime).ok())
            .is_some_and(|age| age > TOUCH_INTERVAL);
        if stale {
            let file = file.to_path_buf();
            tokio::task::spawn_blocking(move || {
                let now = SystemTime::now();
                let _ = touch(&file, now);
            });
        }
        Some(bytes)
    }

    /// Files a copy under `key`, or nothing when there is no key. Written beside
    /// the copy and moved into place, so a write cut off partway never leaves a
    /// truncated file where a reader would take it for the real one.
    pub async fn store(&self, key: Option<&str>, game_path: &str, bytes: &[u8]) {
        let Some(key) = key else { return };
        let file = self.file(key, game_path);
        let temp = PathBuf::from(format!("{}.{}.tmp", file.display(), random_hex()));
        let written = async {
            if let Some(dir) = file.parent() {
                tokio::fs::create_dir_all(dir).await?;
            }
            tokio::fs::write(&temp, bytes).await?;
            tokio::fs::rename(&temp, &file).await
        }
        .await;
        match written {
            Ok(()) => {
                let mut patches = self.patches();
                if !patches.iter().any(|p| p == key) {
                    patches.push(key.to_string());
                    patches.sort_by(|a, b| by_newest_patch(a, b));
                    *self.patches.lock().expect("patches lock") = Some(patches);
                }
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&temp).await;
                log_error(format!("Failed to cache {key}/{game_path}: {err}"));
            }
        }
    }

    /// Least recently used first, by the mtime [`AssetCache::read`] keeps
    /// current. Stray temp files go whatever the total. Returns what it
    /// removed, or `None` when the cache was under the limit.
    pub async fn prune(&self, now: SystemTime) -> Option<Pruned> {
        let root = self.root.clone();
        let pruned = tokio::task::spawn_blocking(move || prune_dir(&root, now))
            .await
            .ok()
            .flatten()?;
        *self.patches.lock().expect("patches lock") = None;
        log(format!(
            "Pruned the asset cache from {} to {}",
            mb(pruned.before),
            mb(pruned.after)
        ));
        Some(pruned)
    }
}

fn prune_dir(root: &Path, now: SystemTime) -> Option<Pruned> {
    let dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .collect();

    struct Entry {
        file: PathBuf,
        size: u64,
        used: SystemTime,
    }
    let mut files = Vec::new();
    let mut total = 0u64;
    for dir in &dirs {
        let Ok(names) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in names.flatten() {
            let file = entry.path();
            // fs.stat follows links, as Node's does
            let Ok(meta) = std::fs::metadata(&file) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if entry.file_name().to_string_lossy().ends_with(".tmp") {
                if now.duration_since(used).is_ok_and(|age| age > STRAY_TEMP) {
                    let _ = std::fs::remove_file(&file);
                }
                continue;
            }
            files.push(Entry {
                file,
                size: meta.len(),
                used,
            });
            total += meta.len();
        }
    }
    if total <= MAX_CACHE_BYTES {
        return None;
    }

    let before = total;
    // Stable, as Array.prototype.sort is, so ties keep directory order
    files.sort_by_key(|entry| entry.used);
    for entry in &files {
        if total <= TARGET_CACHE_BYTES {
            break;
        }
        // In use or already gone; the next prune gets another chance
        if std::fs::remove_file(&entry.file).is_ok() {
            total -= entry.size;
        }
    }
    // remove_dir only removes a directory that is already empty
    for dir in &dirs {
        let _ = std::fs::remove_dir(dir);
    }
    Some(Pruned {
        before,
        after: total,
    })
}

fn touch(file: &Path, at: SystemTime) -> io::Result<()> {
    let times = std::fs::FileTimes::new().set_accessed(at).set_modified(at);
    std::fs::File::options()
        .write(true)
        .open(file)?
        .set_times(times)
}

/// Four random bytes as hex, as `randomBytes(4).toString("hex")`.
fn random_hex() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos() as u64),
    );
    format!("{:08x}", hasher.finish() as u32)
}

/// `(bytes / 1024 / 1024).toFixed(1)` MB. The division is exact in binary, and
/// toFixed rounds a tie up, so integer rounding gives the same digit.
fn mb(bytes: u64) -> String {
    let tenths = (u128::from(bytes) * 10 + (1 << 19)) >> 20;
    format!("{}.{} MB", tenths / 10, tenths % 10)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bmt-{name}-{}-{}",
            std::process::id(),
            random_hex()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn set_mtime(file: &Path, at: SystemTime) {
        touch(file, at).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn files_a_game_path_as_electron_does() {
        let cache = AssetCache::new(PathBuf::from("/c"));
        // sha1("v1/champion-icons/1.png"), a file in the T02 fixture's cache
        assert_eq!(
            cache.file("16.23", "v1/champion-icons/1.png"),
            Path::new("/c/16.23/32a4b57252acdc0625734c11bb5e3fd83e161ea5.png")
        );
        assert_eq!(
            file_name("v1/items.json"),
            "f52d30f5295e89e30ed4f25c9871f00d0e841332.json"
        );
        assert_eq!(extname("splash/1.jpg"), ".jpg");
        assert_eq!(extname("a/.png"), "");
        assert_eq!(extname("a/.."), "");
        assert_eq!(extname("a/b"), "");
        assert_eq!(extname("a.b/c.d.webp"), ".webp");
    }

    #[test]
    fn patches_are_numeric_and_newest_first() {
        assert!(is_patch_branch("16.4"));
        for name in ["latest", "pbe", "16", "16.", ".4", "16.4.1", "a.b", "16.4 "] {
            assert!(!is_patch_branch(name), "{name}");
        }
        let root = temp_dir("patches");
        for name in ["16.4", "16.23", "15.24", "latest", "16.10"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        let cache = AssetCache::new(root.clone());
        assert_eq!(cache.patches(), ["16.23", "16.10", "16.4", "15.24"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stores_through_a_temp_file_and_learns_the_patch() {
        let root = temp_dir("store");
        let cache = AssetCache::new(root.clone());
        assert!(cache.patches().is_empty());
        cache.store(Some("16.22"), "v1/a.png", b"png").await;
        cache.store(None, "v1/b.png", b"png").await;
        assert_eq!(cache.patches(), ["16.22"]);
        assert_eq!(names(&root.join("16.22")), [file_name("v1/a.png")]);
        assert_eq!(names(&root), ["16.22"]);
        let copy = cache.file("16.22", "v1/a.png");
        assert_eq!(cache.read(&copy).await.as_deref(), Some(&b"png"[..]));
        assert_eq!(cache.read(&root.join("16.22/none.png")).await, None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_read_touches_a_copy_older_than_a_day() {
        let root = temp_dir("touch");
        let cache = AssetCache::new(root.clone());
        cache.store(Some("16.1"), "v1/a.png", b"x").await;
        let copy = cache.file("16.1", "v1/a.png");
        let old = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        let recent = SystemTime::now() - Duration::from_secs(60 * 60);
        set_mtime(&copy, recent);
        cache.read(&copy).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            std::fs::metadata(&copy).unwrap().modified().unwrap(),
            recent
        );
        set_mtime(&copy, old);
        cache.read(&copy).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mtime = std::fs::metadata(&copy).unwrap().modified().unwrap();
        assert!(SystemTime::now().duration_since(mtime).unwrap() < Duration::from_secs(60));
        // utimes with a Date sets whole milliseconds
        let since = mtime.duration_since(SystemTime::UNIX_EPOCH).unwrap();
        assert_eq!(since.subsec_nanos() % 1_000_000, 0, "{since:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Builds a cache past the limit: 20 MiB files in three patches, oldest
    /// first by mtime, as `pruneGameAssetCache` would see them.
    fn oversized_cache(root: &Path, now: SystemTime) -> Vec<(String, String)> {
        let mb20 = vec![0u8; 20 * 1024 * 1024];
        let mut files = Vec::new();
        for i in 0..14u64 {
            let patch = ["16.21", "16.22", "16.23"][(i % 3) as usize];
            let name = format!("{i:02}.png");
            std::fs::create_dir_all(root.join(patch)).unwrap();
            let file = root.join(patch).join(&name);
            std::fs::write(&file, &mb20).unwrap();
            set_mtime(&file, now - Duration::from_secs((100 - i) * 60));
            files.push((patch.to_string(), name));
        }
        files
    }

    #[tokio::test]
    async fn prune_keeps_the_folders_electron_keeps() {
        let root = temp_dir("prune");
        let now = SystemTime::now();
        // 14 x 20 MiB = 280 MiB, over 256. Down to 192 drops the 5 oldest:
        // 00 to 04, which empties no patch, so all three folders stay.
        oversized_cache(&root, now);
        // An only-old folder empties and goes, as Electron's rmdir does
        std::fs::create_dir(root.join("16.1")).unwrap();
        let old = root.join("16.1/old.png");
        std::fs::write(&old, vec![0u8; 1024]).unwrap();
        set_mtime(&old, now - Duration::from_secs(10 * 24 * 60 * 60));
        // A stray temp goes, a fresh one stays, and neither counts
        let stray = root.join("16.23/x.png.deadbeef.tmp");
        let fresh = root.join("16.23/y.png.cafef00d.tmp");
        std::fs::write(&stray, b"t").unwrap();
        std::fs::write(&fresh, b"t").unwrap();
        set_mtime(&stray, now - Duration::from_secs(2 * 60 * 60));
        // Files at the root are no patch's and are left alone
        std::fs::write(root.join("note.txt"), b"n").unwrap();

        let cache = AssetCache::new(root.clone());
        assert_eq!(cache.patches(), ["16.23", "16.22", "16.21", "16.1"]);
        let pruned = cache.prune(now).await.unwrap();
        assert_eq!(pruned.before, 280 * 1024 * 1024 + 1024);
        assert_eq!(pruned.after, 180 * 1024 * 1024);
        assert_eq!(names(&root), ["16.21", "16.22", "16.23", "note.txt"]);
        assert_eq!(names(&root.join("16.21")), ["06.png", "09.png", "12.png"]);
        assert_eq!(names(&root.join("16.22")), ["07.png", "10.png", "13.png"]);
        assert_eq!(
            names(&root.join("16.23")),
            ["05.png", "08.png", "11.png", "y.png.cafef00d.tmp"]
        );
        assert_eq!(cache.patches(), ["16.23", "16.22", "16.21"]);
        assert_eq!(mb(pruned.before), "280.0 MB");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn prune_under_the_limit_removes_only_stray_temps() {
        let root = temp_dir("prune-small");
        let now = SystemTime::now();
        std::fs::create_dir(root.join("16.23")).unwrap();
        std::fs::write(root.join("16.23/a.png"), b"a").unwrap();
        let stray = root.join("16.23/a.png.01234567.tmp");
        std::fs::write(&stray, b"t").unwrap();
        set_mtime(&stray, now - STRAY_TEMP - Duration::from_secs(1));
        let cache = AssetCache::new(root.clone());
        assert_eq!(cache.prune(now).await, None);
        assert_eq!(names(&root.join("16.23")), ["a.png"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A file of `size` bytes that takes no disk: the prune reads only sizes.
    fn sparse(file: &Path, size: u64, mtime: SystemTime) {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::File::create(file).unwrap().set_len(size).unwrap();
        set_mtime(file, mtime);
    }

    const MIB_20: u64 = 20 * 1024 * 1024;

    /// Fifteen files on one millisecond, as `utimes(new Date())` writes them.
    /// Node's readdir lists names in strcmp order (libuv's scandir), and the
    /// stable sort keeps that order among ties, so the first six by folder and
    /// name go. electron-prune.mjs removes the same six from the same folder.
    #[tokio::test]
    async fn prune_ties_go_in_name_order() {
        let root = temp_dir("prune-ties");
        let tie = SystemTime::UNIX_EPOCH + Duration::from_millis(1_763_500_000_123);
        let mut all = Vec::new();
        for dir in ["16.23", "16.21", "16.22"] {
            for i in [3, 0, 4, 1, 2] {
                let name = file_name(&format!("{dir}/{i}.png"));
                sparse(&root.join(dir).join(&name), MIB_20, tie);
                all.push((dir, name));
            }
        }
        all.sort();
        let pruned = AssetCache::new(root.clone()).prune(SystemTime::now()).await;
        assert_eq!(pruned.map(|p| p.after), Some(180 * 1024 * 1024));
        let kept: Vec<(&str, String)> = all
            .iter()
            .filter(|(dir, name)| root.join(dir).join(name).exists())
            .cloned()
            .collect();
        assert_eq!(kept, all[6..]);
        assert_eq!(names(&root), ["16.22", "16.23"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Node's mtimeMs is `sec * 1e3 + nsec / 1e6` in doubles, so two files 100
    /// ns apart in 2023 read as one time, and the earlier name goes first.
    #[tokio::test]
    async fn prune_orders_by_node_mtime_ms() {
        let root = temp_dir("prune-ms");
        let second = |s: u64, ns: u32| SystemTime::UNIX_EPOCH + Duration::new(s, ns);
        let dir = root.join("16.23");
        for i in 0..4 {
            sparse(
                &dir.join(format!("o{i}.png")),
                MIB_20,
                second(1_699_999_990 + i, 0),
            );
        }
        sparse(&dir.join("a.png"), MIB_20, second(1_700_000_000, 100));
        sparse(&dir.join("b.png"), MIB_20, second(1_700_000_000, 0));
        for i in 0..8 {
            sparse(
                &dir.join(format!("n{i}.png")),
                MIB_20,
                second(1_700_000_001 + i, 0),
            );
        }
        AssetCache::new(root.clone())
            .prune(SystemTime::now())
            .await
            .unwrap();
        let mut kept = names(&dir);
        kept.retain(|name| !name.starts_with('n'));
        assert_eq!(kept, ["b.png"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn megabytes_round_like_to_fixed() {
        assert_eq!(mb(0), "0.0 MB");
        assert_eq!(mb(262_144), "0.3 MB");
        assert_eq!(mb(201_326_592), "192.0 MB");
        assert_eq!(mb(1_048_575), "1.0 MB");
    }
}
