const CAPTURE_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const ALLOWED_EVENTS = new Set(["$pageview", "$pageleave", "$autocapture"]);

export function sanitizeEvent(event) {
  if (!ALLOWED_EVENTS.has(event.event)) return null;

  const properties = event.properties || {};
  // Server-hash cookieless mode requires the user agent to derive its daily identifier.
  // PostHog strips it during ingestion rather than storing it as an event property.
  if (properties.$current_url) properties.$current_url = safePageUrl(properties.$current_url);
  if (properties.$pathname) properties.$pathname = safePathname(properties.$pathname);

  if (event.event === "$autocapture") {
    const captureElement = properties.$elements?.find((element) => {
      return CAPTURE_ID_PATTERN.test(element["attr__data-capture-id"] || "");
    });
    const captureId = captureElement?.["attr__data-capture-id"] || captureIdFromChain(properties.$elements_chain);
    if (!CAPTURE_ID_PATTERN.test(captureId || "")) return null;
    properties.$elements = [{
      tag_name: "button",
      "attr__data-capture-id": captureId
    }];
    properties.$elements_chain = `button:attr__data-capture-id="${captureId}"nth-child="0"nth-of-type="0"`;
    properties.capture_id = captureId;
    delete properties.$el_text;
    delete properties.$external_click_url;
  }

  event.properties = properties;
  return event;
}

function captureIdFromChain(elementsChain) {
  return String(elementsChain || "").match(/attr__data-capture-id="([a-z][a-z0-9_]{1,63})"/)?.[1];
}

function safePageUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${safePathname(url.pathname)}`;
  } catch {
    return "";
  }
}

function safePathname(pathname) {
  return /^\/room\/[A-Za-z0-9_-]+$/.test(pathname) ? "/room/:room" : pathname;
}
