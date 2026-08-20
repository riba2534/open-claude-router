use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod api;
mod db;
mod derive;
mod ingest;
mod pricing;
mod session;

#[tokio::main]
async fn main() {
    let log_filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_owned());
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(log_filter))
        .init();

    let host = std::env::var("LENS_HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
    let port = std::env::var("LENS_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3458);
    let log_dir = std::env::var("OCR_MODEL_LOG_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("logs"));
    let db_path = std::env::var("LENS_DB_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/lens.db"));

    let db = db::Db::open(&db_path)
        .unwrap_or_else(|error| panic!("open lens db {}: {error}", db_path.display()));
    info!(db = %db_path.display(), "lens database ready");

    let ingest_db = db.clone();
    std::thread::spawn(move || ingest::run(ingest_db, log_dir));

    let access_token = std::env::var("LENS_ACCESS_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if access_token.is_some() {
        info!("dashboard access token required (LENS_ACCESS_TOKEN)");
    } else {
        info!("dashboard access token disabled — anyone who can reach the port sees full prompts");
    }
    let app = api::build_app(Arc::new(api::LensState {
        db,
        pricing: pricing::PricingTable::from_env(),
        access_token,
        overview_cache: tokio::sync::Mutex::new(std::collections::HashMap::new()),
    }));
    let listener = TcpListener::bind((host.as_str(), port))
        .await
        .unwrap_or_else(|error| panic!("bind {host}:{port}: {error}"));
    let addr = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("read bound address: {error}"));
    info!(%addr, "ocr-lens dashboard listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap_or_else(|error| panic!("serve: {error}"));
}
