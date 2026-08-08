use std::{net::SocketAddr, sync::Arc, time::Duration};

use open_claude_router::{AppState, build_app};
use reqwest::redirect::Policy;
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    let log_filter = std::env::var("RUST_LOG")
        .or_else(|_| std::env::var("LOG_LEVEL"))
        .unwrap_or_else(|_| "info".to_owned());
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::new(log_filter))
        .with_current_span(false)
        .init();

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
    let port = std::env::var("PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3457);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .unwrap_or_else(|error| panic!("invalid HOST/PORT: {error}"));

    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(1024)
        .tcp_keepalive(Duration::from_secs(60))
        .http2_adaptive_window(true)
        .timeout(Duration::from_secs(60 * 60))
        .build()
        .expect("build upstream HTTP client");
    let state = Arc::new(AppState::from_env(client));
    state.model_logger.start().await;
    let model_logger = state.model_logger.clone();
    let app = build_app(state);
    let listener = TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| panic!("bind {addr}: {error}"));
    info!(%addr, "open-claude-router Rust server listening");

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    model_logger.flush().await;
    if let Err(error) = result {
        error!(%error, "server stopped with error");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
    info!("shutting down");
}
