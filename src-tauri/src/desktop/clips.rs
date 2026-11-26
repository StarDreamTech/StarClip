use super::{
    changed, lock, product_share_png, reward_creation, run_blocking, write_guard, AppContext,
    AppState,
};
use crate::clip_stats::ClipStats;
use crate::privacy::{PrivacyRescan, PrivacyRules};
use crate::store::{Clip, Group, HistoryQuery, Result};
use crate::{images, share};
use tauri::AppHandle;

#[tauri::command]
pub(super) async fn get_state(
    query: Option<HistoryQuery>,
    context: AppContext<'_>,
) -> Result<AppState> {
    let context = context.inner().clone();
    run_blocking(move || {
        let store = lock(&context.store)?;
        let page = store.history_page(&query.unwrap_or_default())?;
        Ok(AppState {
            clips: page.clips,
            history: page.history,
            groups: store.groups()?,
            settings: store.settings()?,
            onboarding_completed: store.onboarding_completed()?,
            clipboard_error: lock(&context.clipboard_error)?.clone(),
            shortcut_error: lock(&context.shortcut_error)?.clone(),
            window_error: lock(&context.window_error)?.clone(),
        })
    })
    .await
}

#[tauri::command]
pub(super) async fn get_clips(ids: Vec<i64>, context: AppContext<'_>) -> Result<Vec<Clip>> {
    let context = context.inner().clone();
    run_blocking(move || lock(&context.store)?.clip_details(&ids)).await
}

#[tauri::command]
pub(super) async fn complete_onboarding(app: AppHandle, context: AppContext<'_>) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.complete_onboarding()?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn add_clip(
    app: AppHandle,
    context: AppContext<'_>,
    content: String,
    title: String,
    group_id: Option<i64>,
    keep_forever: Option<bool>,
) -> Result<Clip> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let clip = lock(&context.store)?.add_protected(
            &content,
            &title,
            group_id,
            keep_forever.unwrap_or(false),
        )?;
        changed(&app);
        Ok(clip)
    })
    .await
}

#[tauri::command]
pub(super) async fn update_clip(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    title: String,
    group_id: Option<i64>,
    pinned: bool,
) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.update(id, &title, group_id, pinned)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn set_favorite_top(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    on_top: bool,
) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.set_favorite_top(id, on_top)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn move_favorite(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    target: Option<i64>,
    before: bool,
) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.move_favorite(id, target, before)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn save_code(
    app: AppHandle,
    context: AppContext<'_>,
    id: Option<i64>,
    title: String,
    content: String,
    language: String,
    group_id: Option<i64>,
) -> Result<Clip> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let clip = lock(&context.store)?.save_code(id, &title, &content, &language, group_id)?;
        reward_creation(&app, &context);
        changed(&app);
        Ok(clip)
    })
    .await
}

#[tauri::command]
pub(super) async fn delete_clip(app: AppHandle, context: AppContext<'_>, id: i64) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.delete(id)?;
        *lock(&context.cleanup)? = None;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn create_clip_bundle(
    app: AppHandle,
    context: AppContext<'_>,
    ids: Vec<i64>,
    text: String,
    title: String,
    allow_private: bool,
) -> Result<Clip> {
    let context = context.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _write = write_guard(&context)?;
        let clip = lock(&context.store)?.bundle_from_clips(&ids, &text, &title, allow_private)?;
        changed(&app);
        Ok(clip)
    })
    .await
    .map_err(|_| "图文组合保存失败，请重试。".to_string())?
}

#[tauri::command]
pub(super) async fn update_clip_bundle(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    text: String,
    title: String,
    group_id: Option<i64>,
    pinned: bool,
) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.update_bundle(id, &text, &title, group_id, pinned)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn favorite_product_share_images(
    app: AppHandle,
    context: AppContext<'_>,
    locale: String,
) -> Result<Clip> {
    let context = context.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _write = write_guard(&context)?;
        let images = share::images_for_locale(&locale)?
            .iter()
            .map(|image| {
                let png = product_share_png(&app, image)?;
                share::decode_image(image, &png)?;
                images::prepare_png(&png)
            })
            .collect::<Result<Vec<_>>>()?;
        let title = if locale == "en-US" {
            "Starclip · Product images"
        } else {
            "星笺 · 产品分享图"
        };
        let clip = lock(&context.store)?.add_bundle("", &images, title, true, false, None)?;
        changed(&app);
        Ok(clip)
    })
    .await
    .map_err(|_| "分享图片收藏失败，请重试。".to_string())?
}

#[tauri::command]
pub(super) async fn favorite_product_share_text(
    app: AppHandle,
    context: AppContext<'_>,
    id: String,
) -> Result<Clip> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let text = share::text(&id)?;
        let store = lock(&context.store)?;
        let title = if id.ends_with("-en") {
            "Starclip · Share text"
        } else {
            "星笺 · 分享文案"
        };
        let clip = store.add(&text, title, None)?;
        store.update(clip.id, title, clip.group_id, true)?;
        let clip = store.clip(clip.id)?;
        changed(&app);
        Ok(clip)
    })
    .await
}

#[tauri::command]
pub(super) async fn create_group(
    app: AppHandle,
    context: AppContext<'_>,
    name: String,
    color: String,
) -> Result<Group> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let group = lock(&context.store)?.create_group(&name, &color)?;
        changed(&app);
        Ok(group)
    })
    .await
}

#[tauri::command]
pub(super) async fn delete_group(app: AppHandle, context: AppContext<'_>, id: i64) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.delete_group(id)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn get_privacy_rules(context: AppContext<'_>) -> Result<PrivacyRules> {
    let context = context.inner().clone();
    run_blocking(move || lock(&context.store)?.privacy_rules()).await
}

#[tauri::command]
pub(super) async fn save_privacy_rules(
    app: AppHandle,
    context: AppContext<'_>,
    rules: PrivacyRules,
) -> Result<PrivacyRules> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let result = lock(&context.store)?.save_privacy_rules(&rules)?;
        changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(super) async fn set_clip_privacy(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    is_private: bool,
    reviewed: bool,
) -> Result<Clip> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let result = lock(&context.store)?.set_clip_privacy(id, is_private, reviewed)?;
        changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(super) async fn set_clip_tags(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    tags: Vec<String>,
) -> Result<Clip> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let result = lock(&context.store)?.set_clip_tags(id, &tags)?;
        changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(super) async fn preview_privacy_rescan(context: AppContext<'_>) -> Result<PrivacyRescan> {
    let context = context.inner().clone();
    run_blocking(move || lock(&context.store)?.privacy_rescan_preview()).await
}

#[tauri::command]
pub(super) async fn apply_privacy_rescan(
    app: AppHandle,
    context: AppContext<'_>,
    token: String,
) -> Result<PrivacyRescan> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        let result = lock(&context.store)?.privacy_rescan_apply(&token)?;
        changed(&app);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(super) async fn get_clip_stats(
    context: AppContext<'_>,
    days: u32,
    utc_offset_minutes: i32,
) -> Result<ClipStats> {
    let context = context.inner().clone();
    run_blocking(move || lock(&context.store)?.clip_stats(days, utc_offset_minutes)).await
}

#[tauri::command]
pub(super) async fn clear_clip_stats(context: AppContext<'_>) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.clear_clip_stats()
    })
    .await
}

#[tauri::command]
pub(super) async fn clear_history(app: AppHandle, context: AppContext<'_>) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.clear_history()?;
        *lock(&context.cleanup)? = None;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(super) async fn set_keep_forever(
    app: AppHandle,
    context: AppContext<'_>,
    id: i64,
    keep_forever: bool,
) -> Result<()> {
    let context = context.inner().clone();
    run_blocking(move || {
        let _write = write_guard(&context)?;
        lock(&context.store)?.set_keep_forever(id, keep_forever)?;
        changed(&app);
        Ok(())
    })
    .await
}
