use crate::{api, deliver::Deliverer, output};
use anyhow::Result;
use futures_util::StreamExt;
use serde::Deserialize;
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

#[derive(Deserialize)]
enum EventKind {
    #[serde(rename = "request")]
    Request,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Event {
    t: EventKind,
    request: Option<api::Summary>,
}

pub async fn run(hook: &api::Hook, deliverer: Option<&Deliverer>, from: Option<u64>) -> Result<()> {
    let mut last = from;
    let mut delay = 1;
    loop {
        match session(hook, deliverer, &mut last).await {
            Ok(()) => delay = 1,
            Err(error) if error.downcast_ref::<api::Refused>().is_some() => return Err(error),
            Err(error) => output::note(&format!("Disconnected: {error}")),
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(30);
    }
}

async fn session(
    hook: &api::Hook,
    deliverer: Option<&Deliverer>,
    last: &mut Option<u64>,
) -> Result<()> {
    let mut request = api::socket_url(&hook.name).into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", hook.credential))?,
    );
    let (mut socket, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            return Err(api::Refused(response.status().as_u16()).into())
        }
        Err(error) => return Err(error.into()),
    };
    match *last {
        Some(seen) => {
            let missed = api::list(hook, seen).await?;
            for request in missed.iter().rev() {
                arrived(hook, deliverer, last, request).await?;
            }
        }
        None => {
            *last = Some(
                api::list(hook, 0)
                    .await?
                    .first()
                    .map_or(0, |latest| latest.id),
            )
        }
    }
    while let Some(message) = socket.next().await {
        let Message::Text(text) = message? else {
            continue;
        };
        let Ok(Event {
            t,
            request: Some(request),
        }) = serde_json::from_str::<Event>(&text)
        else {
            continue;
        };
        if matches!(t, EventKind::Request) {
            arrived(hook, deliverer, last, &request).await?;
        }
    }
    Ok(())
}

async fn arrived(
    hook: &api::Hook,
    deliverer: Option<&Deliverer>,
    last: &mut Option<u64>,
    request: &api::Summary,
) -> Result<()> {
    if last.is_some_and(|seen| request.id <= seen) {
        return Ok(());
    }
    match deliverer {
        Some(deliverer) => {
            deliverer.send(hook, request.id).await?;
        }
        None => output::request(
            &request.method,
            &request.path,
            "",
            &output::size(request.size),
        ),
    }
    *last = Some(request.id);
    Ok(())
}
