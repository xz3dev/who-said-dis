import posthog from "/vendor/posthog-1.417.1.js";
import { sanitizeEvent } from "./analytics-privacy.js";

export function initializeAnalytics(publicKey) {
  if (!publicKey) return;

  posthog.init(publicKey, {
    api_host: "https://eu.i.posthog.com",
    ui_host: "https://eu.posthog.com",
    defaults: "2026-05-30",
    cookieless_mode: "always",
    person_profiles: "never",
    advanced_disable_flags: true,
    request_batching: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    capture_exceptions: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_pageview: true,
    capture_pageleave: true,
    rageclick: false,
    save_campaign_params: false,
    save_referrer: false,
    mask_all_text: true,
    mask_all_element_attributes: false,
    mask_personal_data_properties: true,
    autocapture: {
      dom_event_allowlist: ["click"],
      element_allowlist: ["button"],
      css_selector_allowlist: ["[data-capture-id]"],
      css_selector_ignorelist: [".ph-no-capture", "[data-ph-no-autocapture]"]
    },
    property_denylist: [
      "$referrer",
      "$referring_domain",
      "$initial_referrer",
      "$initial_referring_domain"
    ],
    before_send: sanitizeEvent
  });
}
