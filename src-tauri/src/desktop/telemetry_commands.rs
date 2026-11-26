use super::{lock, AppContext, Context};
use crate::store::Result;
use crate::telemetry::{self, TelemetryState};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(super) fn telemetry_changed(app: &AppHandle, state: &TelemetryState) {
    let _ = app.emit_to("main", "starclip-telemetry-state", state);
}

pub(super) fn record_telemetry(app: &AppHandle, context: &Context, name: &str) {
    if let Ok(mut telemetry) = lock(&context.telemetry) {
        let before = telemetry.state().revision;
        if telemetry.record(name).is_ok() {
            let state = telemetry.state();
            if state.revision != before {
                telemetry_changed(app, &state);
            }
        }
    }
}

#[tauri::command]
pub(super) fn get_telemetry_state(context: AppContext<'_>) -> Result<TelemetryState> {
    Ok(lock(&context.telemetry)?.state())
}

#[tauri::command]
pub(super) fn set_telemetry_enabled(
    app: AppHandle,
    context: AppContext<'_>,
    enabled: bool,
) -> Result<TelemetryState> {
    set_telemetry_mode(app, context, if enabled { "session" } else { "off" }.into())
}

#[tauri::command]
pub(super) fn set_telemetry_mode(
    app: AppHandle,
    context: AppContext<'_>,
    mode: String,
) -> Result<TelemetryState> {
    let mode = telemetry::TelemetryMode::parse(&mode).ok_or("不支持的统计模式。")?;
    let storage = lock(&context.storage)?;
    let store = lock(&context.store)?;
    let mut telemetry = lock(&context.telemetry)?;
    if mode != telemetry::TelemetryMode::Off {
        telemetry.validate_mode(mode)?;
    }
    // Revocation takes effect before persistence; a failed write never resumes sending.
    if mode == telemetry::TelemetryMode::Off {
        telemetry.set_mode(mode);
        telemetry_changed(&app, &telemetry.state());
    }
    if let Err(error) = storage
        .writable()
        .and_then(|()| store.set_telemetry_mode(mode))
    {
        return Err(if mode == telemetry::TelemetryMode::Off {
            "本次运行已停止统计，但关闭偏好未保存；请重试，重启后可能恢复原设置。".into()
        } else {
            error
        });
    }
    // Do not apply Off twice: the second call used to hide identity deletion failures.
    if mode != telemetry::TelemetryMode::Off {
        telemetry.set_mode(mode);
    }
    let state = telemetry.state();
    telemetry_changed(&app, &state);
    Ok(state)
}

#[tauri::command]
pub(super) fn record_usage_event(
    app: AppHandle,
    context: AppContext<'_>,
    name: String,
) -> Result<TelemetryState> {
    let mut telemetry = lock(&context.telemetry)?;
    telemetry.record_frontend(&name)?;
    let state = telemetry.state();
    telemetry_changed(&app, &state);
    Ok(state)
}

#[tauri::command]
pub(super) fn reset_telemetry_install(
    app: AppHandle,
    context: AppContext<'_>,
) -> Result<TelemetryState> {
    let mut telemetry = lock(&context.telemetry)?;
    let result = telemetry.reset_install();
    let state = telemetry.state();
    telemetry_changed(&app, &state);
    result?;
    Ok(state)
}

#[tauri::command]
pub(super) fn reset_telemetry_identity(
    app: AppHandle,
    context: AppContext<'_>,
) -> Result<TelemetryState> {
    let mut telemetry = lock(&context.telemetry)?;
    let result = if telemetry.state().mode == "installation" {
        telemetry.reset_install()
    } else {
        telemetry.retry_identity()
    };
    let state = telemetry.state();
    telemetry_changed(&app, &state);
    result?;
    Ok(state)
}

#[tauri::command]
pub(super) fn clear_telemetry_queue(
    app: AppHandle,
    context: AppContext<'_>,
) -> Result<TelemetryState> {
    let mut telemetry = lock(&context.telemetry)?;
    let cleared = telemetry.clear_queue();
    let state = telemetry.state();
    telemetry_changed(&app, &state);
    cleared?;
    Ok(state)
}

pub(super) fn flush_telemetry_with_context(
    app: &AppHandle,
    context: &Context,
) -> Result<TelemetryState> {
    let batch = {
        let mut telemetry = lock(&context.telemetry)?;
        let batch = telemetry.take_batch();
        telemetry_changed(app, &telemetry.state());
        batch
    };
    if let Some(batch) = batch {
        let success = telemetry::send(&batch);
        let mut telemetry = lock(&context.telemetry)?;
        telemetry.finish(&batch, success);
        telemetry_changed(app, &telemetry.state());
    }
    Ok(lock(&context.telemetry)?.state())
}

pub(super) fn schedule_telemetry_flush(app: &AppHandle, context: &Arc<Context>) {
    if lock(&context.telemetry).is_ok_and(|mut telemetry| {
        let before = telemetry.state().revision;
        telemetry.tick();
        let state = telemetry.state();
        if state.revision != before {
            telemetry_changed(app, &state);
        }
        telemetry.ready()
    }) {
        let app = app.clone();
        let context = context.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = flush_telemetry_with_context(&app, &context);
        });
    }
}

#[tauri::command]
pub(super) async fn flush_telemetry(
    app: AppHandle,
    context: AppContext<'_>,
) -> Result<TelemetryState> {
    let context = context.inner().clone();
    tauri::async_runtime::spawn_blocking(move || flush_telemetry_with_context(&app, &context))
        .await
        .map_err(|_| "统计后台任务暂不可用。".to_string())?
}
